// A digit set is the N distinct values a puzzle uses (instead of always 1..N).
// Cells store digit *indices*; operators see the real values; the UI shows labels.

export interface DigitSet {
  values: number[];
  labels: string[];
}

export function makeDigitSet(values: number[], labels?: string[]): DigitSet {
  if (new Set(values).size !== values.length) throw new Error('Digit values must be distinct');
  if (values.some((v) => !Number.isFinite(v))) throw new Error('Digit values must be finite numbers');
  if (labels && labels.length !== values.length) throw new Error('Need one label per digit');
  return { values: [...values], labels: labels ? [...labels] : values.map(String) };
}

export const range = (start: number, count: number, step = 1): number[] =>
  Array.from({ length: count }, (_, i) => start + i * step);

/** Named presets; every one takes the grid size n. */
export const DIGIT_PRESETS: Record<string, (n: number) => DigitSet> = {
  standard: (n) => makeDigitSet(range(1, n)),
  zeroBased: (n) => makeDigitSet(range(0, n)),
  evens: (n) => makeDigitSet(range(2, n, 2)),
  odds: (n) => makeDigitSet(range(1, n, 2)),
  centered: (n) => makeDigitSet(range(-Math.floor(n / 2), n).map((v) => (n % 2 === 0 && v >= 0 ? v + 1 : v))),
  primes: (n) => makeDigitSet([2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37].slice(0, n)),
  tens: (n) => makeDigitSet(range(10, n, 10)),
};
