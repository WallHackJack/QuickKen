// Candidate sets are bitmasks over digit indices (bit i = digit index i). Supports up to 31 digits.

export const bit = (i: number): number => 1 << i;

export const fullMask = (n: number): number => (1 << n) - 1;

export function popcount(m: number): number {
  m = m - ((m >>> 1) & 0x55555555);
  m = (m & 0x33333333) + ((m >>> 2) & 0x33333333);
  return (((m + (m >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Index of the lowest set bit (-1 for 0). */
export function lowestIndex(m: number): number {
  return m === 0 ? -1 : 31 - Math.clz32(m & -m);
}

export function maskIndices(m: number): number[] {
  const out: number[] = [];
  while (m) {
    const low = m & -m;
    out.push(31 - Math.clz32(low));
    m ^= low;
  }
  return out;
}

export const has = (m: number, i: number): boolean => (m & (1 << i)) !== 0;
