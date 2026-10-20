// Solution counter: proves uniqueness. Not human-like; see logic.ts for that.

import { popcount } from './bits';
import { initialMasks, masksToDigits, propagate, type SolveContext } from './propagate';
import type { CageTuples } from './tuples';

export interface CountResult {
  count: number;
  solution?: number[];
  /** True if the node budget ran out before the search finished. */
  aborted: boolean;
}

export function countSolutions(ctx: SolveContext, limit = 2, start?: Int32Array, nodeBudget = 200_000): CountResult {
  let count = 0;
  let solution: number[] | undefined;
  let nodes = 0;
  let aborted = false;

  const rec = (masks: Int32Array, tuples: CageTuples[]): void => {
    if (count >= limit || aborted) return;
    if (++nodes > nodeBudget) {
      aborted = true;
      return;
    }
    if (!propagate(ctx, masks, tuples)) return;
    let best = -1;
    let bestCount = 99;
    for (let c = 0; c < masks.length; c++) {
      const pc = popcount(masks[c]);
      if (pc > 1 && pc < bestCount) {
        best = c;
        bestCount = pc;
      }
    }
    if (best === -1) {
      count++;
      solution ??= masksToDigits(masks);
      return;
    }
    let m = masks[best];
    while (m) {
      const low = m & -m;
      m ^= low;
      const next = masks.slice();
      next[best] = low;
      rec(next, tuples.slice());
    }
  };

  rec(start ? start.slice() : initialMasks(ctx), ctx.baseTuples.slice());
  return { count, solution, aborted };
}
