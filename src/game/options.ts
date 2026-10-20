// Player options, remembered per browser (localStorage). Storage can be blocked or empty, so every
// read falls back to the defaults and every write is best effort.

export interface Options {
  /** Master switch for chain reactions: cells down to one maybe fill themselves, and each fill can trigger more. */
  chains: boolean;
  /** When a row/column has one empty cell left, fill in its missing digit as part of the chain. */
  fillLastGap: boolean;
  /** When a cage has one empty cell left and its math allows only one digit, fill it in as part of the chain. */
  fillCageLast: boolean;
  /** Animation speed multiplier. 4 is the original pace; 2 and 1 are slower. */
  animSpeed: 1 | 2 | 4;
  /** Slow motion: every effect plays at this fraction of normal speed (1 = normal). */
  timeScale: 0.25 | 0.5 | 1;
}

export const DEFAULT_OPTIONS: Options = { chains: true, fillLastGap: true, fillCageLast: true, animSpeed: 4, timeScale: 1 };

const KEY = 'kenken.options';

export function loadOptions(): Options {
  try {
    const raw = localStorage.getItem(KEY);
    return { ...DEFAULT_OPTIONS, ...(raw ? (JSON.parse(raw) as Partial<Options>) : {}) };
  } catch {
    return { ...DEFAULT_OPTIONS };
  }
}

export function saveOptions(o: Options): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch {
    // Not remembered this time; the option still applies for this visit.
  }
}
