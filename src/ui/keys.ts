// Keyboard layout for digits: the letter block under the left hand mirrors the digit pad's grid
// (which mirrors the maybe grid): Q W E / A S D for [1 2 3] / [4 5 6]. Only two letter rows are used
// because C (bottom row) clears; digits beyond them still have their number keys.

import { noteColumns } from '../render/BoardView';

const ROWS = ['qwer', 'asdf'];

/** The letter for each digit index, or null when that digit only has its number key. */
export function digitLetters(digits: number): (string | null)[] {
  const cols = noteColumns(digits);
  return Array.from({ length: digits }, (_, d) => ROWS[Math.floor(d / cols)]?.[d % cols] ?? null);
}
