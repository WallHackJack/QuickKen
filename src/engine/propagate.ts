// Fast constraint propagation used by the backtracker and by the "trial" technique.

import { fullMask, lowestIndex, popcount } from './bits';
import { buildTopology, type PuzzleDef, type Topology } from './puzzle';
import { enumerateTuples, filterTuples, positionUnion, type CageTuples } from './tuples';

export interface SolveContext {
  p: PuzzleDef;
  topo: Topology;
  /** Cage tuples against full candidates (computed once). */
  baseTuples: CageTuples[];
}

export function makeContext(p: PuzzleDef): SolveContext {
  const topo = buildTopology(p);
  const full = new Int32Array(topo.cellCount).fill(fullMask(p.size));
  const baseTuples = p.cages.map((cage, ci) => enumerateTuples(cage, topo.cageConflicts[ci], full, p.digits.values));
  return { p, topo, baseTuples };
}

export const initialMasks = (ctx: SolveContext): Int32Array => new Int32Array(ctx.topo.cellCount).fill(fullMask(ctx.p.size));

/** Mutates masks and tuples to a fixed point. Returns false on contradiction. */
export function propagate(ctx: SolveContext, masks: Int32Array, tuples: CageTuples[]): boolean {
  const { topo, p } = ctx;
  const n = p.size;
  let changed = true;
  while (changed) {
    changed = false;

    for (let ci = 0; ci < p.cages.length; ci++) {
      const cells = p.cages[ci].cells;
      const t = filterTuples(tuples[ci], cells, masks);
      if (t.count === 0) return false;
      tuples[ci] = t;
      const u = positionUnion(t);
      for (let i = 0; i < cells.length; i++) {
        const nm = masks[cells[i]] & u[i];
        if (nm !== masks[cells[i]]) {
          masks[cells[i]] = nm;
          changed = true;
        }
      }
    }

    for (let c = 0; c < topo.cellCount; c++) {
      const m = masks[c];
      if (m === 0) return false;
      if (popcount(m) !== 1) continue;
      for (const q of topo.peers[c]) {
        if (masks[q] & m) {
          masks[q] &= ~m;
          if (masks[q] === 0) return false;
          changed = true;
        }
      }
    }

    for (const h of topo.houses) {
      if (!h.complete) continue;
      for (let d = 0; d < n; d++) {
        const b = 1 << d;
        let where = -1;
        let cnt = 0;
        for (const c of h.cells) {
          if (masks[c] & b) {
            cnt++;
            where = c;
          }
        }
        if (cnt === 0) return false;
        if (cnt === 1 && masks[where] !== b) {
          masks[where] = b;
          changed = true;
        }
      }
    }
  }
  return true;
}

export const isSolved = (masks: Int32Array): boolean => masks.every((m) => popcount(m) === 1);

export const masksToDigits = (masks: Int32Array): number[] => Array.from(masks, lowestIndex);
