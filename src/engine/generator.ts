// Seeded generator: Latin square → random cages → operators → uniqueness → logical difficulty grading.

import { countSolutions } from './backtrack';
import type { DigitSet } from './digits';
import { logicSolve, type Rating } from './logic';
import { getOperator } from './operators';
import { makeContext } from './propagate';
import type { Cage, PuzzleDef } from './puzzle';
import { makeRng, pickWeighted, randInt, shuffle, type Rng } from './rng';

export interface GenOptions {
  size: number;
  digits: DigitSet;
  seed: string;
  /** Operator ids with relative weights. 'given' is used automatically for 1-cell cages. */
  operators?: { id: string; weight: number }[];
  /** Weights for cage sizes 1, 2, 3, ... */
  cageSizeWeights?: number[];
  allowFractionalTargets?: boolean;
  /** Accept only these ratings (default: any). */
  ratings?: Rating[];
  maxAttempts?: number;
}

const DEFAULT_OPS = [
  { id: 'add', weight: 4 },
  { id: 'mul', weight: 3 },
  { id: 'sub', weight: 3 },
  { id: 'div', weight: 3 },
];

export function randomLatinSquare(rng: Rng, n: number): number[] {
  const grid = new Array<number>(n * n).fill(-1);
  const rowUsed = new Array<number>(n).fill(0);
  const colUsed = new Array<number>(n).fill(0);
  const rec = (i: number): boolean => {
    if (i === n * n) return true;
    const r = Math.floor(i / n), c = i % n;
    for (const d of shuffle(rng, [...Array(n).keys()])) {
      const b = 1 << d;
      if (rowUsed[r] & b || colUsed[c] & b) continue;
      grid[i] = d;
      rowUsed[r] |= b;
      colUsed[c] |= b;
      if (rec(i + 1)) return true;
      rowUsed[r] &= ~b;
      colUsed[c] &= ~b;
    }
    return false;
  };
  rec(0);
  return grid;
}

export function randomCages(rng: Rng, n: number, sizeWeights: number[]): number[][] {
  const owner = new Array<number>(n * n).fill(-1);
  const cages: number[][] = [];
  const neighbors = (c: number): number[] => {
    const r = Math.floor(c / n), col = c % n;
    const out: number[] = [];
    if (r > 0) out.push(c - n);
    if (r < n - 1) out.push(c + n);
    if (col > 0) out.push(c - 1);
    if (col < n - 1) out.push(c + 1);
    return out;
  };
  for (const start of shuffle(rng, [...Array(n * n).keys()])) {
    if (owner[start] !== -1) continue;
    const want = 1 + (pickWeighted(rng, sizeWeights.map((weight, i) => ({ item: i, weight }))) ?? 1);
    const cells = [start];
    owner[start] = cages.length;
    while (cells.length < want) {
      const frontier = [...new Set(cells.flatMap(neighbors))].filter((c) => owner[c] === -1);
      if (!frontier.length) break;
      const next = frontier[randInt(rng, frontier.length)];
      owner[next] = cages.length;
      cells.push(next);
    }
    cages.push(cells);
  }
  // Merge stray singletons into a neighbouring small cage most of the time (keeps givens rare).
  const singleWeight = sizeWeights[0] ?? 0;
  for (const cage of cages) {
    if (cage.length !== 1 || rng() < singleWeight / (sizeWeights.reduce((a, b) => a + b, 0) || 1)) continue;
    const options = neighbors(cage[0]).map((c) => cages[owner[c]]).filter((g) => g !== cage && g.length > 0 && g.length < 3);
    if (!options.length) continue;
    const target = options[randInt(rng, options.length)];
    target.push(cage.pop()!);
    owner[target[target.length - 1]] = cages.indexOf(target);
  }
  return cages.filter((c) => c.length > 0).map((c) => c.sort((a, b) => a - b));
}

function assignOperator(rng: Rng, cells: number[], solution: number[], digits: DigitSet, ops: { id: string; weight: number }[], allowFractional: boolean): Cage | null {
  const values = cells.map((c) => digits.values[solution[c]]);
  if (cells.length === 1) return { cells, op: 'given', target: values[0] };
  const options = ops
    .map(({ id, weight }) => {
      const op = getOperator(id);
      if (cells.length < op.minCells || cells.length > op.maxCells) return null;
      const target = op.evaluate(values);
      if (target === null || !Number.isFinite(target)) return null;
      if (!allowFractional && !Number.isInteger(target)) return null;
      return { item: { cells, op: id, target }, weight };
    })
    .filter((x): x is { item: Cage; weight: number } => x !== null);
  return pickWeighted(rng, options) ?? null;
}

export interface GenResult {
  puzzle: PuzzleDef;
  attempts: number;
}

export function generatePuzzle(o: GenOptions): GenResult {
  const rng = makeRng(o.seed);
  const n = o.size;
  const ops = o.operators ?? DEFAULT_OPS;
  const sizeWeights = o.cageSizeWeights ?? (n <= 4 ? [1, 6, 3] : [1, 7, 5, 2]);
  const maxAttempts = o.maxAttempts ?? 400;
  let best: PuzzleDef | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const solution = randomLatinSquare(rng, n);
    const groups = randomCages(rng, n, sizeWeights);
    const cages: Cage[] = [];
    for (const g of groups) {
      const cage = assignOperator(rng, g, solution, o.digits, ops, !!o.allowFractionalTargets);
      // A group no operator fits (e.g. 3 cells with only ÷ allowed) → split into givens.
      if (cage) cages.push(cage);
      else for (const c of g) cages.push({ cells: [c], op: 'given', target: o.digits.values[solution[c]] });
    }

    const puzzle: PuzzleDef = { size: n, digits: o.digits, cages, solution };
    const ctx = makeContext(puzzle);
    const count = countSolutions(ctx, 2);
    if (count.count !== 1 || count.aborted) continue;

    const trace = logicSolve(ctx);
    puzzle.meta = { seed: o.seed, difficulty: trace.difficulty, rating: trace.rating };
    if (!o.ratings || o.ratings.includes(trace.rating)) return { puzzle, attempts: attempt };
    best ??= puzzle;
  }
  if (best) return { puzzle: best, attempts: maxAttempts };
  throw new Error('Could not generate a unique puzzle with these settings');
}
