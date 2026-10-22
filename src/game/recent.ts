// The last few puzzles played (New → Recent), newest first. Each keeps its board as it was left (not
// its undo history, which would make the list heavy).

import type { PuzzleDef } from '../engine/puzzle';
import type { GameSnapshot } from './Link';

export const RECENT_MAX = 10;

export interface RecentEntry {
  key: string;
  snap: GameSnapshot;
}

/** Same puzzle, same key: cheap string hash of its definition. */
export function puzzleKey(p: PuzzleDef): string {
  const s = JSON.stringify([p.size, p.digits.labels, p.cages]);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** Put `snap` at the front (replacing its earlier entry), keeping at most RECENT_MAX. */
export function remember(list: RecentEntry[], snap: GameSnapshot): RecentEntry[] {
  const key = puzzleKey(snap.puzzle);
  const slim: GameSnapshot = { ...snap, history: undefined, view: '' };
  return [{ key, snap: slim }, ...list.filter((e) => e.key !== key)].slice(0, RECENT_MAX);
}
