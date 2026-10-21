import { describe, expect, it } from 'vitest';
import { LEVELS } from '../src/game/campaign';
import { Game } from '../src/game/Game';

describe('campaign', () => {
  it('the L level loads with holes and any valid fill solves it', () => {
    const g = new Game(structuredClone(LEVELS[0].puzzle));
    g.fillAllNotes();
    expect(g.notes[6]).toBe(0);
    // 1 3 | 2 4 | 6 5, and 3 under the 5: 6 + 5 + 3 = 14.
    const fill: [number, number][] = [[0, 1], [1, 3], [2, 2], [3, 4], [4, 6], [5, 5], [11, 3]];
    for (const [c, v] of fill) g.setValue(c, v - 1);
    expect(g.isSolved()).toBe(true);
  });
});
