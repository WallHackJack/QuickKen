// Hand-made levels, picked from New → Campaign.

import { DIGIT_PRESETS } from '../engine/digits';
import type { PuzzleDef } from '../engine/puzzle';

export interface Level {
  name: string;
  puzzle: PuzzleDef;
}

/** Every cell of an n×n grid not in `used` (cells that aren't part of the board). */
const holesOutside = (n: number, used: number[]): number[] => Array.from({ length: n * n }, (_, c) => c).filter((c) => !used.includes(c));

export const LEVELS: Level[] = [
  {
    // One row of six and a single cell hanging under its end: an L.
    // Only the hanging cell is asked for: whatever order the top row takes, it must be 3.
    name: 'The L',
    puzzle: {
      size: 6,
      digits: DIGIT_PRESETS.standard(6),
      cages: [
        { cells: [0, 1], op: 'sub', target: 2 },
        { cells: [2, 3], op: 'sub', target: 2 },
        { cells: [4, 5, 11], op: 'add', target: 14 },
      ],
      holes: holesOutside(6, [0, 1, 2, 3, 4, 5, 11]),
      rules: { goal: { cell: 11, digit: 2 }, lockCursor: true, noMaybes: true, digitsOnly: true },
      meta: { rating: 'Campaign 1' },
    },
  },
];
