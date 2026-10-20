// Human-style deduction techniques. Each finds its cheapest applicable instance and returns a Step:
// what it removes/places, which cells/cages/houses justify it, and a plain-language explanation.
// The logic solver always applies the cheapest step available, so the trace mirrors a strong human solver.

import { bit, lowestIndex, maskIndices, popcount } from './bits';
import { approxEq, getOperator } from './operators';
import { cageLabel, colOf, rowOf } from './puzzle';
import { initialMasks, propagate, type SolveContext } from './propagate';
import { filterTuples, positionUnion, type CageTuples } from './tuples';

export interface CellDigit {
  cell: number;
  digit: number;
}

export interface Step {
  technique: string;
  name: string;
  cost: number;
  placements: CellDigit[];
  eliminations: CellDigit[];
  focusCells: number[];
  cages: number[];
  houses: number[];
  explain: string;
}

export interface LogicState {
  ctx: SolveContext;
  masks: Int32Array;
  /** Cells whose value is committed (by the player or a placement step). */
  placed: Uint8Array;
  /** Live cage tuples, kept consistent with masks. */
  tuples: CageTuples[];
}

export interface Technique {
  id: string;
  name: string;
  /** Lower bound on the cost of any step this technique returns. */
  baseCost: number;
  find(s: LogicState): Step | null;
}

// ---------- state helpers ----------

export function createLogicState(ctx: SolveContext, digits?: ArrayLike<number>): LogicState {
  const s: LogicState = {
    ctx,
    masks: initialMasks(ctx),
    placed: new Uint8Array(ctx.topo.cellCount),
    tuples: ctx.baseTuples.slice(),
  };
  if (digits) {
    for (let c = 0; c < digits.length; c++) {
      if (digits[c] >= 0) {
        s.masks[c] = bit(digits[c]);
        s.placed[c] = 1;
      }
    }
    for (let c = 0; c < digits.length; c++) {
      if (digits[c] >= 0) for (const q of ctx.topo.peers[c]) if (!s.placed[q]) s.masks[q] &= ~s.masks[c];
    }
  }
  refreshTuples(s);
  return s;
}

export function cloneState(s: LogicState): LogicState {
  return { ctx: s.ctx, masks: s.masks.slice(), placed: s.placed.slice(), tuples: s.tuples.slice() };
}

export function refreshTuples(s: LogicState): void {
  s.ctx.p.cages.forEach((cage, ci) => (s.tuples[ci] = filterTuples(s.tuples[ci], cage.cells, s.masks)));
}

export function applyStep(s: LogicState, step: Step): void {
  for (const { cell, digit } of step.placements) {
    s.masks[cell] = bit(digit);
    s.placed[cell] = 1;
  }
  for (const { cell, digit } of step.eliminations) s.masks[cell] &= ~bit(digit);
  refreshTuples(s);
}

/** A contradiction exists if any cell or cage has no options left. */
export function isContradiction(s: LogicState): boolean {
  return s.masks.some((m) => m === 0) || s.tuples.some((t) => t.count === 0);
}

// ---------- naming ----------

export const cellName = (s: LogicState, c: number): string => `R${rowOf(c, s.ctx.p.size) + 1}C${colOf(c, s.ctx.p.size) + 1}`;
const dn = (s: LogicState, d: number): string => s.ctx.p.digits.labels[d];
const listDigits = (s: LogicState, m: number): string => maskIndices(m).map((d) => dn(s, d)).join(', ');
const cageName = (s: LogicState, ci: number): string => `${cageLabel(s.ctx.p.cages[ci])} cage at ${cellName(s, s.ctx.p.cages[ci].cells[0])}`;

function describeElims(s: LogicState, elims: CellDigit[]): string {
  const byCell = new Map<number, number>();
  for (const e of elims) byCell.set(e.cell, (byCell.get(e.cell) ?? 0) | bit(e.digit));
  return [...byCell].map(([c, m]) => `${cellName(s, c)} can't be ${listDigits(s, m)}`).join('; ');
}

function elimsFromMask(s: LogicState, cells: number[], remove: number): CellDigit[] {
  const out: CellDigit[] = [];
  for (const c of cells) for (const d of maskIndices(s.masks[c] & remove)) out.push({ cell: c, digit: d });
  return out;
}

function* combinations<T>(items: T[], k: number, start = 0, acc: T[] = []): Generator<T[]> {
  if (acc.length === k) {
    yield acc.slice();
    return;
  }
  for (let i = start; i <= items.length - (k - acc.length); i++) {
    acc.push(items[i]);
    yield* combinations(items, k, i + 1, acc);
    acc.pop();
  }
}

function placementStep(s: LogicState, technique: string, name: string, cost: number, cell: number, d: number, why: string, houses: number[] = []): Step {
  const eliminations = elimsFromMask(s, s.ctx.topo.peers[cell].filter((q) => !s.placed[q]), bit(d));
  return { technique, name, cost, placements: [{ cell, digit: d }], eliminations, focusCells: [cell], cages: [], houses, explain: why };
}

/** Eliminations implied by restricting a cage to a subset of its tuples. */
function cageElims(s: LogicState, ci: number, t: CageTuples): CellDigit[] {
  const cells = s.ctx.p.cages[ci].cells;
  const u = positionUnion(t);
  const out: CellDigit[] = [];
  cells.forEach((c, i) => {
    for (const d of maskIndices(s.masks[c] & ~u[i])) out.push({ cell: c, digit: d });
  });
  return out;
}

function keepTuples(t: CageTuples, pred: (tuple: Uint8Array) => boolean): CageTuples {
  const out: number[] = [];
  let count = 0;
  for (let i = 0; i < t.count; i++) {
    const tup = t.data.subarray(i * t.k, i * t.k + t.k);
    if (pred(tup)) {
      out.push(...tup);
      count++;
    }
  }
  return { k: t.k, count, data: Uint8Array.from(out) };
}

function describeCombos(s: LogicState, t: CageTuples): string {
  const values = s.ctx.p.digits.values;
  const seen = new Set<string>();
  for (let i = 0; i < t.count && seen.size < 6; i++) {
    const vals = Array.from(t.data.subarray(i * t.k, i * t.k + t.k), (d) => d);
    vals.sort((a, b) => values[a] - values[b]);
    seen.add('{' + vals.map((d) => dn(s, d)).join(',') + '}');
  }
  const list = [...seen];
  return list.length >= 6 ? `${list.slice(0, 5).join(' or ')} or others` : list.join(' or ');
}

// ---------- techniques ----------

const nakedSingle: Technique = {
  id: 'naked-single', name: 'Naked single', baseCost: 0.5,
  find(s) {
    for (let c = 0; c < s.masks.length; c++) {
      if (!s.placed[c] && popcount(s.masks[c]) === 1) {
        const d = lowestIndex(s.masks[c]);
        return placementStep(s, this.id, this.name, this.baseCost, c, d, `${cellName(s, c)} has only one possibility left: ${dn(s, d)}.`);
      }
    }
    return null;
  },
};

const hiddenSingle: Technique = {
  id: 'hidden-single', name: 'Hidden single', baseCost: 1,
  find(s) {
    const { houses } = s.ctx.topo;
    for (let hi = 0; hi < houses.length; hi++) {
      const h = houses[hi];
      if (!h.complete) continue;
      for (let d = 0; d < s.ctx.p.size; d++) {
        let where = -1;
        let cnt = 0;
        for (const c of h.cells) if (s.masks[c] & bit(d)) (cnt++, (where = c));
        if (cnt === 1 && !s.placed[where]) {
          return placementStep(s, this.id, this.name, this.baseCost, where, d, `${dn(s, d)} can only go in one place in ${h.name}: ${cellName(s, where)}.`, [hi]);
        }
      }
    }
    return null;
  },
};

const cageCombos: Technique = {
  id: 'cage-combos', name: 'Cage combinations', baseCost: 0.6,
  find(s) {
    let best: Step | null = null;
    s.ctx.p.cages.forEach((cage, ci) => {
      const t = s.tuples[ci];
      const elims = cageElims(s, ci, t);
      if (!elims.length) return;
      const op = getOperator(cage.op);
      const cost = 0.6 + op.effort * (cage.cells.length - 1) * 0.8 + 0.25 * Math.log2(Math.max(1, t.count));
      if (best && best.cost <= cost) return;
      best = {
        technique: this.id, name: this.name, cost, placements: [], eliminations: elims,
        focusCells: cage.cells, cages: [ci], houses: [],
        explain: cage.cells.length === 1
          ? `${cellName(s, cage.cells[0])} is given: it's ${describeCombos(s, t).replace(/[{}]/g, '')}.`
          : `The ${cageName(s, ci)} only works as ${describeCombos(s, t)}, so ${describeElims(s, elims)}.`,
      };
    });
    return best;
  },
};

function nakedSubset(k: number, cost: number): Technique {
  const names = ['', '', 'Naked pair', 'Naked triple', 'Naked quad'];
  return {
    id: `naked-subset-${k}`, name: names[k], baseCost: cost,
    find(s) {
      const { houses } = s.ctx.topo;
      for (let hi = 0; hi < houses.length; hi++) {
        const open = houses[hi].cells.filter((c) => !s.placed[c]);
        const pool = open.filter((c) => popcount(s.masks[c]) <= k);
        if (open.length <= k || pool.length < k) continue;
        for (const combo of combinations(pool, k)) {
          const union = combo.reduce((m, c) => m | s.masks[c], 0);
          if (popcount(union) !== k) continue;
          const elims = elimsFromMask(s, open.filter((c) => !combo.includes(c)), union);
          if (elims.length) {
            return {
              technique: this.id, name: this.name, cost, placements: [], eliminations: elims,
              focusCells: combo, cages: [], houses: [hi],
              explain: `${combo.map((c) => cellName(s, c)).join(', ')} must hold ${listDigits(s, union)} between them in ${houses[hi].name}, so ${describeElims(s, elims)}.`,
            };
          }
        }
      }
      return null;
    },
  };
}

function hiddenSubset(k: number, cost: number): Technique {
  const names = ['', '', 'Hidden pair', 'Hidden triple'];
  return {
    id: `hidden-subset-${k}`, name: names[k], baseCost: cost,
    find(s) {
      const { houses } = s.ctx.topo;
      for (let hi = 0; hi < houses.length; hi++) {
        const h = houses[hi];
        if (!h.complete) continue;
        const open = h.cells.filter((c) => !s.placed[c]);
        const placedDigits = h.cells.filter((c) => s.placed[c]).reduce((m, c) => m | s.masks[c], 0);
        const digits = [...Array(s.ctx.p.size).keys()].filter((d) => !(placedDigits & bit(d)));
        if (digits.length <= k) continue;
        for (const combo of combinations(digits, k)) {
          const dm = combo.reduce((m, d) => m | bit(d), 0);
          const where = open.filter((c) => s.masks[c] & dm);
          if (where.length !== k) continue;
          const elims = elimsFromMask(s, where, ~dm);
          if (elims.length) {
            return {
              technique: this.id, name: this.name, cost, placements: [], eliminations: elims,
              focusCells: where, cages: [], houses: [hi],
              explain: `In ${h.name}, ${listDigits(s, dm)} can only go in ${where.map((c) => cellName(s, c)).join(', ')}, so those cells can't hold anything else.`,
            };
          }
        }
      }
      return null;
    },
  };
}

/** A cage must place digit d inside one house → d can't appear elsewhere in that house. */
const cagePointing: Technique = {
  id: 'cage-pointing', name: 'Cage forces digit into line', baseCost: 2.5,
  find(s) {
    const { p, topo } = s.ctx;
    for (let ci = 0; ci < p.cages.length; ci++) {
      const cage = p.cages[ci];
      const t = s.tuples[ci];
      if (t.count === 0) continue;
      const houseIds = new Set(cage.cells.flatMap((c) => topo.cellHouses[c]));
      for (const hi of houseIds) {
        const positions = cage.cells.map((c, i) => (topo.houses[hi].cells.includes(c) ? i : -1)).filter((i) => i >= 0);
        let required = -1;
        for (let i = 0; i < t.count && required; i++) {
          let m = 0;
          for (const pos of positions) m |= bit(t.data[i * t.k + pos]);
          required &= m;
        }
        if (!required) continue;
        const outside = topo.houses[hi].cells.filter((c) => !cage.cells.includes(c) && !s.placed[c]);
        const elims = elimsFromMask(s, outside, required);
        if (elims.length) {
          return {
            technique: this.id, name: this.name, cost: this.baseCost, placements: [], eliminations: elims,
            focusCells: positions.map((i) => cage.cells[i]), cages: [ci], houses: [hi],
            explain: `Every way to fill the ${cageName(s, ci)} puts ${listDigits(s, required)} in ${topo.houses[hi].name}, so ${describeElims(s, elims)}.`,
          };
        }
      }
    }
    return null;
  },
};

/** All spots for digit d in a house lie in one cage → that cage must put d there. */
const houseClaim: Technique = {
  id: 'house-claim', name: 'Line claims digit from cage', baseCost: 3,
  find(s) {
    const { p, topo } = s.ctx;
    for (let hi = 0; hi < topo.houses.length; hi++) {
      const h = topo.houses[hi];
      if (!h.complete) continue;
      for (let d = 0; d < p.size; d++) {
        const spots = h.cells.filter((c) => s.masks[c] & bit(d));
        if (spots.length < 2 || spots.some((c) => s.placed[c])) continue;
        const ci = topo.cageOf[spots[0]];
        if (!spots.every((c) => topo.cageOf[c] === ci)) continue;
        const cells = p.cages[ci].cells;
        const inHouse = cells.map((c, i) => (h.cells.includes(c) ? i : -1)).filter((i) => i >= 0);
        const t = keepTuples(s.tuples[ci], (tup) => inHouse.some((i) => tup[i] === d));
        const elims = cageElims(s, ci, t);
        if (elims.length) {
          return {
            technique: this.id, name: this.name, cost: this.baseCost, placements: [], eliminations: elims,
            focusCells: spots, cages: [ci], houses: [hi],
            explain: `${dn(s, d)} must go somewhere in ${h.name}, and every spot is inside the ${cageName(s, ci)}. That rules out combinations without it there, so ${describeElims(s, elims)}.`,
          };
        }
      }
    }
    return null;
  },
};

/** Lines have a known total sum/product; subtract the fully-known cages to constrain the leftover cage. */
function houseArithmetic(kind: 'add' | 'mul', cost: number): Technique {
  return {
    id: `house-${kind}`, name: kind === 'add' ? 'Line sum rule' : 'Line product rule', baseCost: cost,
    find(s) {
      const { p, topo } = s.ctx;
      const values = p.digits.values;
      const n = p.size;
      if (kind === 'mul' && values.includes(0)) return null;
      const lineTotal = kind === 'add' ? values.reduce((a, b) => a + b, 0) : values.reduce((a, b) => a * b, 1);
      const groups: { cells: number[]; label: string; houses: number[] }[] = [];
      for (let width = 1; width <= 2; width++) {
        for (let start = 0; start + width <= n; start++) {
          const rows: number[] = [], cols: number[] = [];
          for (let i = start; i < start + width; i++) {
            for (let j = 0; j < n; j++) (rows.push(i * n + j), cols.push(j * n + i));
          }
          const span = width === 1 ? `${start + 1}` : `${start + 1}–${start + width}`;
          groups.push({ cells: rows, label: `row${width > 1 ? 's' : ''} ${span}`, houses: [...Array(width).keys()].map((i) => start + i) });
          groups.push({ cells: cols, label: `column${width > 1 ? 's' : ''} ${span}`, houses: [...Array(width).keys()].map((i) => n + start + i) });
        }
      }
      for (const g of groups) {
        const set = new Set(g.cells);
        const total = kind === 'add' ? lineTotal * (g.houses.length) : lineTotal ** g.houses.length;
        let known = kind === 'add' ? 0 : 1;
        const done = new Set<number>();
        for (let ci = 0; ci < p.cages.length; ci++) {
          const cage = p.cages[ci];
          if (cage.op === kind && cage.cells.every((c) => set.has(c))) {
            known = kind === 'add' ? known + cage.target : known * cage.target;
            cage.cells.forEach((c) => done.add(c));
          }
        }
        const unknown: number[] = [];
        for (const c of g.cells) {
          if (done.has(c)) continue;
          if (popcount(s.masks[c]) === 1) {
            const v = values[lowestIndex(s.masks[c])];
            known = kind === 'add' ? known + v : known * v;
          } else unknown.push(c);
        }
        if (!unknown.length) continue;
        const ci = topo.cageOf[unknown[0]];
        if (!unknown.every((c) => topo.cageOf[c] === ci)) continue;
        const need = kind === 'add' ? total - known : total / known;
        const cells = p.cages[ci].cells;
        const pos = unknown.map((c) => cells.indexOf(c));
        const t = keepTuples(s.tuples[ci], (tup) => {
          let acc = kind === 'add' ? 0 : 1;
          for (const i of pos) acc = kind === 'add' ? acc + values[tup[i]] : acc * values[tup[i]];
          return approxEq(acc, need);
        });
        const elims = cageElims(s, ci, t);
        if (elims.length) {
          const opWord = kind === 'add' ? 'add up to' : 'multiply to';
          return {
            technique: this.id, name: this.name, cost, placements: [], eliminations: elims,
            focusCells: unknown, cages: [ci], houses: g.houses,
            explain: `Everything else in ${g.label} is accounted for, so ${unknown.map((c) => cellName(s, c)).join(', ')} must ${opWord} ${+need.toFixed(3)}. So ${describeElims(s, elims)}.`,
          };
        }
      }
      return null;
    },
  };
}

/** Bifurcation: assume a value, propagate, find a contradiction. This is the "needs a guess" tier. */
const trial: Technique = {
  id: 'trial', name: 'Trial and error', baseCost: 10,
  find(s) {
    const order = [...s.masks.keys()].filter((c) => !s.placed[c] && popcount(s.masks[c]) > 1).sort((a, b) => popcount(s.masks[a]) - popcount(s.masks[b]));
    for (const c of order) {
      for (const d of maskIndices(s.masks[c])) {
        const masks = s.masks.slice();
        masks[c] = bit(d);
        if (!propagate(s.ctx, masks, s.tuples.slice())) {
          return {
            technique: this.id, name: this.name, cost: this.baseCost + popcount(s.masks[c]) - 2, placements: [],
            eliminations: [{ cell: c, digit: d }], focusCells: [c], cages: [], houses: [],
            explain: `If ${cellName(s, c)} were ${dn(s, d)}, the puzzle breaks down a few moves later, so it can't be ${dn(s, d)}.`,
          };
        }
      }
    }
    return null;
  },
};

export const TECHNIQUES: Technique[] = [
  nakedSingle,
  cageCombos,
  hiddenSingle,
  nakedSubset(2, 2),
  cagePointing,
  hiddenSubset(2, 3),
  houseClaim,
  nakedSubset(3, 3.5),
  houseArithmetic('add', 4),
  hiddenSubset(3, 4.5),
  houseArithmetic('mul', 4.5),
  nakedSubset(4, 5),
  trial,
].sort((a, b) => a.baseCost - b.baseCost);
