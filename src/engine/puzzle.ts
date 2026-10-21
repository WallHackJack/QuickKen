import type { DigitSet } from './digits';
import { getOperator } from './operators';

export interface Cage {
  cells: number[];
  op: string;
  target: number;
}

export interface PuzzleDef {
  size: number;
  digits: DigitSet;
  cages: Cage[];
  /** Extra all-different regions beyond rows/columns (e.g. diagonals). */
  extraHouses?: number[][];
  /** Digit index per cell. */
  solution?: number[];
  /** Cells that aren't part of the board (odd shapes): in no cage, row or column. */
  holes?: number[];
  meta?: { seed?: string; difficulty?: number; rating?: string };
}

export interface House {
  cells: number[];
  /** True when the house holds every digit exactly once (enables hidden singles/subsets). */
  complete: boolean;
  name: string;
}

export interface Topology {
  n: number;
  cellCount: number;
  houses: House[];
  cellHouses: number[][];
  peers: number[][];
  cageOf: number[];
  /** For each cage, pairs of cage-cell positions [i, j] that share a house and must differ. */
  cageConflicts: [number, number][][];
}

export const rowOf = (cell: number, n: number): number => Math.floor(cell / n);
export const colOf = (cell: number, n: number): number => cell % n;

export function buildTopology(p: PuzzleDef): Topology {
  const n = p.size;
  if (p.digits.values.length !== n) throw new Error(`Need ${n} digits, got ${p.digits.values.length}`);
  const cellCount = n * n;
  const houses: House[] = [];
  // Holes leave rows and columns short; a short line only needs its digits to differ.
  const holes = new Set(p.holes ?? []);
  const line = (cells: number[], name: string) => {
    const kept = cells.filter((c) => !holes.has(c));
    if (kept.length) houses.push({ cells: kept, complete: kept.length === n, name });
  };
  for (let r = 0; r < n; r++) line(Array.from({ length: n }, (_, c) => r * n + c), `row ${r + 1}`);
  for (let c = 0; c < n; c++) line(Array.from({ length: n }, (_, r) => r * n + c), `column ${c + 1}`);
  for (const [i, h] of (p.extraHouses ?? []).entries()) houses.push({ cells: h, complete: h.length === n, name: `region ${i + 1}` });

  const cellHouses: number[][] = Array.from({ length: cellCount }, () => []);
  houses.forEach((h, hi) => h.cells.forEach((c) => cellHouses[c].push(hi)));

  const peers: number[][] = Array.from({ length: cellCount }, (_, cell) => {
    const s = new Set<number>();
    for (const hi of cellHouses[cell]) for (const c of houses[hi].cells) if (c !== cell) s.add(c);
    return [...s];
  });

  const cageOf = new Array<number>(cellCount).fill(-1);
  p.cages.forEach((cage, ci) => {
    const op = getOperator(cage.op);
    if (cage.cells.length < op.minCells || cage.cells.length > op.maxCells) {
      throw new Error(`Cage ${ci}: operator ${op.id} cannot take ${cage.cells.length} cells`);
    }
    for (const c of cage.cells) {
      if (cageOf[c] !== -1) throw new Error(`Cell ${c} is in two cages`);
      cageOf[c] = ci;
    }
  });
  if (cageOf.some((ci, c) => (ci === -1) !== holes.has(c))) throw new Error('Every cell must be in a cage (or a hole)');

  const peerSets = peers.map((ps) => new Set(ps));
  const cageConflicts = p.cages.map((cage) => {
    const pairs: [number, number][] = [];
    for (let i = 0; i < cage.cells.length; i++)
      for (let j = i + 1; j < cage.cells.length; j++) if (peerSets[cage.cells[i]].has(cage.cells[j])) pairs.push([i, j]);
    return pairs;
  });

  return { n, cellCount, houses, cellHouses, peers, cageOf, cageConflicts };
}

export function cageLabel(cage: Cage): string {
  const op = getOperator(cage.op);
  const t = Number.isInteger(cage.target) ? String(cage.target) : String(+cage.target.toFixed(3));
  return t + op.symbol;
}
