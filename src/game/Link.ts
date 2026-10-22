// Live link with Claude through the published Artifact's database (the `db` capability):
// - the page saves the current puzzle and board to `live/game` (Claude reads it; reloads resume it);
// - Claude writes `live/claude` ({seq, say, moves}); the page applies each new seq once.
// Outside the claude.ai viewer (local dev, a saved copy) there is no db and the page works alone.

import type { PuzzleDef } from '../engine/puzzle';

/** A move Claude can make. Cells are indices (row * size + col); digits are digit indices. */
export type RemoteMove =
  | { op: 'value'; cell: number; digit: number }
  | { op: 'maybes'; cell: number; digits: number[] }
  | { op: 'erase'; cell: number }
  | { op: 'select'; cell: number }
  | { op: 'highlight'; cells: number[] };

export interface RemoteMessage {
  seq: number;
  say?: string;
  moves?: RemoteMove[];
  /** A revised definition of the current puzzle (same size), e.g. a cage changed to another operator. */
  puzzle?: PuzzleDef;
}

export interface GameSnapshot {
  v: 1;
  puzzle: PuzzleDef;
  values: number[];
  notes: number[];
  layers: number[];
  layer: number;
  selected: number;
  notesMode: boolean;
  elapsedMs: number;
  solved: boolean;
  /** Last Claude message applied, so a reload never replays it. */
  claudeSeq: number;
  /** Undo/redo history (JSON text, newest moves only), so undo survives a reload. */
  history?: string;
  /** Plain-text board for reading at a glance: digits, [maybes], or '.' per cell. */
  view: string;
  updatedAt: string;
}

interface DocSnap {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}
interface DocRef {
  get(): Promise<DocSnap>;
  set(data: Record<string, unknown>): Promise<void>;
  onSnapshot(next: (s: DocSnap) => void, error?: (e: { code: string }) => void): () => void;
}
interface Db {
  doc(path: string): DocRef;
}
declare global {
  interface Window {
    claude?: { use(name: string): Promise<unknown> };
  }
}

const SAVE_DELAY_MS = 700;

export class Link {
  claudeSeq = 0;
  private writing = false;
  private dirty = false;
  private timer = 0;

  private constructor(private db: Db, private snapshot: () => GameSnapshot | null) {}

  /** Resolves null when this view has no database (e.g. local dev) or it doesn't answer in time. */
  static async connect(snapshot: () => GameSnapshot | null, timeoutMs = 4000): Promise<Link | null> {
    const use = window.claude?.use;
    if (!use) return null;
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
    try {
      const db = (await Promise.race([window.claude!.use('db'), timeout])) as Db | null;
      return db ? new Link(db, snapshot) : null;
    } catch {
      return null;
    }
  }

  async loadSaved(): Promise<GameSnapshot | null> {
    try {
      const snap = await this.db.doc('live/game').get();
      const data = snap.exists ? (snap.data() as unknown as GameSnapshot) : null;
      if (data?.v !== 1 || !data.puzzle) return null;
      this.claudeSeq = data.claudeSeq ?? 0;
      return data;
    } catch {
      return null;
    }
  }

  /** The board changed: save soon (bursts of moves coalesce into one write). */
  changed(immediate = false): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.save(), immediate ? 0 : SAVE_DELAY_MS);
  }

  private async save(): Promise<void> {
    if (this.writing) {
      this.dirty = true;
      return;
    }
    const snap = this.snapshot();
    if (!snap) return;
    this.writing = true;
    try {
      await this.db.doc('live/game').set({ ...snap, claudeSeq: this.claudeSeq } as unknown as Record<string, unknown>);
    } catch {
      // Saving is best effort: the game keeps working locally.
    } finally {
      this.writing = false;
      if (this.dirty) {
        this.dirty = false;
        this.changed();
      }
    }
  }

  /** The Recent list (stored beside the game). */
  async loadRecent(): Promise<unknown> {
    try {
      const snap = await this.db.doc('live/recent').get();
      return snap.exists ? snap.data()?.list : null;
    } catch {
      return null;
    }
  }

  saveRecent(list: unknown): void {
    void this.db.doc('live/recent').set({ list }).catch(() => {
      // Best effort, like the game save.
    });
  }

  /** Call `apply` once for every new message Claude writes. */
  listen(apply: (msg: RemoteMessage) => void): void {
    this.db.doc('live/claude').onSnapshot(
      (snap) => {
        const msg = snap.exists ? (snap.data() as unknown as RemoteMessage) : null;
        if (!msg || typeof msg.seq !== 'number' || msg.seq <= this.claudeSeq) return;
        this.claudeSeq = msg.seq;
        apply(msg);
        this.changed(true);
      },
      () => {
        // Listener died (access changed or the bridge stopped): the page carries on without Claude.
      },
    );
  }
}

/** Plain-text board: one line per row, cells separated by spaces. */
export function boardText(size: number, labels: string[], values: ArrayLike<number>, notes: ArrayLike<number>): string {
  const rows: string[] = [];
  for (let r = 0; r < size; r++) {
    const cells: string[] = [];
    for (let c = 0; c < size; c++) {
      const i = r * size + c;
      if (values[i] >= 0) cells.push(labels[values[i]]);
      else if (notes[i]) cells.push('[' + labels.filter((_, d) => notes[i] & (1 << d)).join('') + ']');
      else cells.push('.');
    }
    rows.push(cells.join(' '));
  }
  return rows.join('\n');
}
