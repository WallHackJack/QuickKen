// Seeded RNG so a seed (e.g. "daily-2026-10-19") reproduces the same puzzle everywhere.

export type Rng = () => number;

export function hashSeed(seed: string | number): number {
  const s = String(seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 */
export function makeRng(seed: string | number): Rng {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randInt = (rng: Rng, n: number): number => Math.floor(rng() * n);

export function shuffle<T>(rng: Rng, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function pickWeighted<T>(rng: Rng, items: { item: T; weight: number }[]): T | undefined {
  const total = items.reduce((s, x) => s + x.weight, 0);
  if (total <= 0) return undefined;
  let r = rng() * total;
  for (const x of items) {
    r -= x.weight;
    if (r < 0) return x.item;
  }
  return items[items.length - 1].item;
}
