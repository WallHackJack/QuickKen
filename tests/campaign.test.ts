import { describe, expect, it } from 'vitest';
import { LEVELS } from '../src/game/campaign';
import { Game } from '../src/game/Game';

describe('campaign', () => {
  it('the L: entering 3 in the hanging cell wins', () => {
    const g = new Game(structuredClone(LEVELS[0].puzzle));
    g.fillAllNotes();
    expect(g.notes[6]).toBe(0);
    g.setValue(11, 2);
    expect(g.isSolved()).toBe(true);
  });

  it('the L: 3 is the only digit the hanging cell can take', () => {
    // Every order of 1-6 along the top row, with the 2- cages and 14+ (top two plus the hanging cell).
    const found = new Set<number>();
    const perm = (rest: number[], row: number[]): void => {
      if (!rest.length) {
        const z = 14 - row[4] - row[5];
        if (Math.abs(row[0] - row[1]) === 2 && Math.abs(row[2] - row[3]) === 2 && z >= 1 && z <= 6 && z !== row[5]) found.add(z);
        return;
      }
      rest.forEach((d, i) => perm(rest.filter((_, j) => j !== i), [...row, d]));
    };
    perm([1, 2, 3, 4, 5, 6], []);
    expect([...found]).toEqual([3]);
  });
});
