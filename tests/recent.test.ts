import { describe, expect, it } from 'vitest';
import { LEVELS } from '../src/game/campaign';
import type { GameSnapshot } from '../src/game/Link';
import { RECENT_MAX, remember } from '../src/game/recent';

const snapOf = (target: number): GameSnapshot => {
  const puzzle = structuredClone(LEVELS[0].puzzle);
  puzzle.cages[0].target = target;
  return { v: 1, puzzle, values: [], notes: [], layers: [], layer: 0, selected: 0, notesMode: false, elapsedMs: 0, solved: false, claudeSeq: 0, history: 'x', view: 'v', updatedAt: '' };
};

describe('recent', () => {
  it('keeps the newest first, one entry per puzzle, at most RECENT_MAX, with its undo history', () => {
    let list = remember([], snapOf(1));
    list = remember(list, snapOf(2));
    list = remember(list, snapOf(1));
    expect(list.map((e) => e.snap.puzzle.cages[0].target)).toEqual([1, 2]);
    expect(list[0].snap.history).toBe('x');
    for (let t = 3; t < 20; t++) list = remember(list, snapOf(t));
    expect(list.length).toBe(RECENT_MAX);
  });
});
