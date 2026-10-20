// Cage tuple enumeration: every assignment of digit indices to a cage's cells that respects
// the candidates, the Latin rule inside the cage, and the operator's target.
// Tuples are stored flat: tuple t occupies data[t*k .. t*k+k-1].

import { approxEq, getOperator } from './operators';
import type { Cage } from './puzzle';

export interface CageTuples {
  k: number;
  count: number;
  data: Uint8Array;
}

export function enumerateTuples(
  cage: Cage,
  conflicts: [number, number][],
  masks: ArrayLike<number>,
  values: number[],
  limit = 2_000_000,
): CageTuples {
  const op = getOperator(cage.op);
  const k = cage.cells.length;
  const earlier: number[][] = Array.from({ length: k }, () => []);
  for (const [i, j] of conflicts) earlier[Math.max(i, j)].push(Math.min(i, j));

  const out: number[] = [];
  const cur = new Array<number>(k).fill(0);
  const vals = new Array<number>(k).fill(0);
  let count = 0;

  const rec = (pos: number): void => {
    if (count >= limit) return;
    if (pos === k) {
      const r = op.evaluate(vals);
      if (r !== null && approxEq(r, cage.target)) {
        for (let i = 0; i < k; i++) out.push(cur[i]);
        count++;
      }
      return;
    }
    let m = masks[cage.cells[pos]];
    for (const j of earlier[pos]) m &= ~(1 << cur[j]);
    while (m) {
      const low = m & -m;
      const d = 31 - Math.clz32(low);
      m ^= low;
      cur[pos] = d;
      vals[pos] = values[d];
      rec(pos + 1);
    }
  };
  rec(0);
  return { k, count, data: Uint8Array.from(out) };
}

/** Keep only tuples consistent with the current candidate masks. Returns the same object if nothing changed. */
export function filterTuples(t: CageTuples, cells: number[], masks: ArrayLike<number>): CageTuples {
  const { k, data } = t;
  let keep = 0;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < t.count; i++) {
    const base = i * k;
    let ok = true;
    for (let p = 0; p < k; p++) {
      if (!(masks[cells[p]] & (1 << data[base + p]))) {
        ok = false;
        break;
      }
    }
    if (ok) {
      out.set(data.subarray(base, base + k), keep * k);
      keep++;
    }
  }
  if (keep === t.count) return t;
  return { k, count: keep, data: out.subarray(0, keep * k) };
}

/** For each position, the union of digits appearing there across all tuples. */
export function positionUnion(t: CageTuples): number[] {
  const u = new Array<number>(t.k).fill(0);
  for (let i = 0; i < t.count; i++) for (let p = 0; p < t.k; p++) u[p] |= 1 << t.data[i * t.k + p];
  return u;
}

export function tupleAt(t: CageTuples, i: number): number[] {
  return Array.from(t.data.subarray(i * t.k, i * t.k + t.k));
}
