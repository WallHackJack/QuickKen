import { describe, expect, it } from 'vitest';
import { LEVELS } from '../src/game/campaign';
import { Game } from '../src/game/Game';

describe('campaign', () => {
  it('Two Rows: 3 is the only digit the "?" cell can take', () => {
    const perms = (a: number[]): number[][] => (a.length < 2 ? [a] : a.flatMap((x, i) => perms(a.filter((_, j) => j !== i)).map((r) => [x, ...r])));
    const rows = perms([1, 2, 3, 4, 5, 6]);
    const found = new Set<number>();
    for (const a of rows) {
      if (Math.abs(a[0] - a[1]) !== 3 || a[3] * a[4] !== 12) continue;
      for (const b of rows) {
        if (b[0] + b[1] !== 8 || Math.max(b[4], b[5]) !== 2 * Math.min(b[4], b[5]) || a[2] + b[2] + b[3] !== 12 || a.some((v, i) => v === b[i])) continue;
        found.add(a[5]);
      }
    }
    expect([...found]).toEqual([3]);
  });

  it('Two Rows: loads, and entering 3 in the "?" cell wins', () => {
    const g = new Game(structuredClone(LEVELS[1].puzzle));
    expect(g.cageStatus(3)).toBe('open');
    g.setValue(29, 2);
    expect(g.cageStatus(3)).toBe('open');
    expect(g.isSolved()).toBe(true);
  });

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
