// Player-facing game state: values, maybes (notes), guess layers, undo history and auto-fill chains.
// Every player action is one history command, including the whole chain reaction it triggers.

import { bit, fullMask, lowestIndex, popcount } from '../engine/bits';
import { findNextStep } from '../engine/logic';
import { approxEq, getOperator } from '../engine/operators';
import { makeContext, type SolveContext } from '../engine/propagate';
import type { PuzzleDef } from '../engine/puzzle';
import { createLogicState, type Step } from '../engine/techniques';

export const EMPTY = -1;

interface Snap {
  value: number;
  notes: number;
  layer: number;
}

interface Change {
  cell: number;
  before: Snap;
  after: Snap;
}

interface Command {
  kind: 'edit' | 'guess-start' | 'guess-keep';
  layer: number;
  changes: Change[];
  /** How the move played (its chain waves), so redo can play it again. */
  fx?: Pick<ActionResult, 'waves' | 'eliminated' | 'broken'>;
  /** guess-keep: the guess as it was before confirming (its part of the history and the cell layers). */
  keep?: { at: number; tail: Command[]; layers: number[]; layer: number };
}

export interface ActionResult {
  /** waves[0] = cells the player filled directly; waves[i] = cells auto-filled by wave i-1. */
  waves: number[][];
  /** Maybes removed automatically, with the wave whose placements removed them (0 = the move itself). */
  eliminated: { cell: number; digit: number; wave: number }[];
  changed: number[];
  /** Set when an error stopped the chain: the wave that made it, and the cells involved. */
  broken?: { wave: number; cells: number[] };
}

/** A pair/triple/quad found in a line: these cells hold exactly these digits between them. */
export interface LineGroup {
  cells: number[];
  mask: number;
  /** Maybes removed from the line's other cells because of it. */
  eliminated: { cell: number; digit: number }[];
}

export type Hint = { kind: 'step'; step: Step } | { kind: 'error'; cells: number[]; message: string } | { kind: 'none'; message: string };

export interface GameSettings {
  autoEliminate: boolean;
  autoFill: boolean;
  /** Fill the last empty cell of a row/column with its one missing digit (part of the chain). */
  fillLastGap: boolean;
  /** Fill the last empty cell of a cage when its math allows exactly one digit (part of the chain). */
  fillCageLast: boolean;
}

export class Game {
  readonly ctx: SolveContext;
  readonly n: number;
  values: Int8Array;
  notes: Int32Array;
  layers: Uint8Array;
  /** Cells filled from single-cell cages at the start; they can't be changed. */
  readonly givens: Uint8Array;
  /** Current guess depth (0 = no guess). */
  layer = 0;
  history: Command[] = [];
  /** Commands taken back by undo, newest last. */
  private redoStack: Command[] = [];
  settings: GameSettings = { autoEliminate: true, autoFill: true, fillLastGap: true, fillCageLast: true };

  private tx: Map<number, Snap> | null = null;

  constructor(readonly puzzle: PuzzleDef) {
    this.ctx = makeContext(puzzle);
    this.n = puzzle.size;
    const count = this.ctx.topo.cellCount;
    this.values = new Int8Array(count).fill(EMPTY);
    this.notes = new Int32Array(count);
    this.layers = new Uint8Array(count);
    this.givens = new Uint8Array(count);
    // Single-cell cages are free information: start with them filled in (not part of undo history).
    for (const cage of puzzle.cages) {
      if (cage.cells.length !== 1) continue;
      const d = puzzle.digits.values.findIndex((v) => approxEq(v, cage.target));
      if (d < 0) continue;
      this.values[cage.cells[0]] = d;
      this.givens[cage.cells[0]] = 1;
    }
  }

  get topo() {
    return this.ctx.topo;
  }

  /** Put the board back to a saved state (e.g. resuming after a reload). Starts a fresh undo history. */
  restore(values: ArrayLike<number>, notes: ArrayLike<number>, layers: ArrayLike<number>, layer: number): void {
    this.values.set(values);
    this.notes.set(notes);
    this.layers.set(layers);
    this.layer = layer;
    this.history = [];
    this.redoStack = [];
  }

  /** Cells the next undo would change: everything the last move touched. */
  lastChanged(): number[] {
    return this.history.at(-1)?.changes.map((ch) => ch.cell) ?? [];
  }

  /** Cells the next undo would change, newest change first (the order a rewind plays them in). */
  peekUndo(): number[] {
    return (this.history.at(-1)?.changes ?? []).map((ch) => ch.cell).reverse();
  }

  /** Cells the running guess changed, newest first (what undoing the guess rewinds). */
  guessCells(): number[] {
    const out: number[] = [];
    for (let i = this.history.length - 1; i >= 0; i--) {
      const cmd = this.history[i];
      if (cmd.kind === 'guess-start') break;
      for (const ch of [...cmd.changes].reverse()) if (!out.includes(ch.cell)) out.push(ch.cell);
    }
    return out;
  }

  /**
   * The move a guess started from (the running one by default): its cell, and the digit it placed or
   * the maybe it added (-1 if neither).
   */
  guessOrigin(layer = this.layer): { cell: number; digit: number } | null {
    if (layer < 1) return null;
    const start = this.history.findLastIndex((c) => c.kind === 'guess-start' && c.layer === layer);
    if (start < 0) return null;
    const first = this.history.slice(start + 1).find((c) => c.layer === layer && c.changes.length);
    const ch = first?.changes[0];
    if (!ch) return null;
    const added = ch.after.notes & ~ch.before.notes;
    return { cell: ch.cell, digit: ch.after.value !== EMPTY ? ch.after.value : added ? lowestIndex(added) : -1 };
  }

  /** The last move's changes, per cell: its value and maybes before and after. */
  lastChanges(): Map<number, { before: { value: number; notes: number }; after: { value: number; notes: number } }> {
    return new Map((this.history.at(-1)?.changes ?? []).map((ch) => [ch.cell, { before: ch.before, after: ch.after }]));
  }

  /** The undo/redo history as text, for saving. Only the newest `limit` moves are kept. */
  exportHistory(limit = 300): string {
    return JSON.stringify({ history: this.history.slice(-limit), redo: this.redoStack.slice(-limit) });
  }

  /** Bring back a saved history (after restore). Anything that doesn't fit this board is dropped. */
  importHistory(text: string | undefined): void {
    if (!text) return;
    try {
      const { history, redo } = JSON.parse(text) as { history: Command[]; redo: Command[] };
      const n = this.values.length;
      const ok = (cmds: unknown): cmds is Command[] =>
        Array.isArray(cmds) &&
        cmds.every((c: Command) => (c.kind === 'edit' || c.kind === 'guess-start' || c.kind === 'guess-keep') && Array.isArray(c.changes) && c.changes.every((ch) => Number.isInteger(ch.cell) && ch.cell >= 0 && ch.cell < n && ch.before && ch.after));
      if (ok(history) && ok(redo)) {
        this.history = history;
        this.redoStack = redo;
      }
    } catch {
      // A damaged history just means starting with an empty one.
    }
  }

  // ---------- transactions ----------

  private snap(c: number): Snap {
    return { value: this.values[c], notes: this.notes[c], layer: this.layers[c] };
  }

  private write(c: number, value: number, notes: number): void {
    if (!this.tx) throw new Error('write outside transaction');
    if (!this.tx.has(c)) this.tx.set(c, this.snap(c));
    this.values[c] = value;
    this.notes[c] = notes;
    this.layers[c] = this.layer;
  }

  private diff(before: Map<number, Snap>): Change[] {
    const changes: Change[] = [];
    for (const [cell, b] of before) {
      const after = this.snap(cell);
      if (b.value !== after.value || b.notes !== after.notes || b.layer !== after.layer) changes.push({ cell, before: b, after });
    }
    return changes;
  }

  private transact(fn: () => ActionResult): ActionResult {
    this.tx = new Map();
    const result = fn();
    const changes = this.diff(this.tx);
    this.tx = null;
    if (changes.length) {
      this.history.push({ kind: 'edit', layer: this.layer, changes, fx: { waves: result.waves, eliminated: result.eliminated, broken: result.broken } });
      this.redoStack = [];
    }
    result.changed = changes.map((ch) => ch.cell);
    return result;
  }

  // ---------- actions ----------

  setValue(cell: number, d: number): ActionResult {
    return this.transact(() => {
      if (this.values[cell] === d || this.givens[cell]) return { waves: [[]], eliminated: [], changed: [] };
      this.write(cell, d, this.notes[cell]);
      return this.resolveChain([cell], []);
    });
  }

  toggleNote(cell: number, d: number): ActionResult {
    if (this.givens[cell]) return { waves: [[]], eliminated: [], changed: [] };
    const v = this.values[cell];
    // Turning a value that was *just* placed back into maybes means the placement was a slip:
    // take it back first, so the maybes it cleared from its row/column (and any chain) return.
    const restored = v !== EMPTY ? this.takeBackPlacement(cell) : [];
    const result = this.transact(() => {
      if (v !== EMPTY) {
        // A maybe on a filled cell turns the value back into maybes: the value plus the new digit
        // (or just the value, if it's the same digit). Never triggers auto-fill.
        this.write(cell, EMPTY, bit(v) | bit(d));
        return { waves: [[]], eliminated: [], changed: [] };
      }
      // Toggling a maybe never fills the cell, even when it leaves one maybe: the player is still
      // deciding. (Chains only fill cells whose maybes were removed by a placement or a group.)
      this.write(cell, EMPTY, this.notes[cell] ^ bit(d));
      return { waves: [[]], eliminated: [], changed: [] };
    });
    if (restored.length) result.changed = [...new Set([...restored, ...result.changed])];
    return result;
  }

  /**
   * If the most recent move placed this cell's current value, remove that move from history and
   * revert everything it did (peer maybes it cleared, cells its chain filled). Returns those cells.
   */
  private takeBackPlacement(cell: number): number[] {
    const last = this.history.at(-1);
    if (last?.kind !== 'edit') return [];
    const ch = last.changes.find((x) => x.cell === cell);
    if (!ch || ch.after.value !== this.values[cell] || ch.before.value === ch.after.value) return [];
    this.history.pop();
    return this.revert(last);
  }

  /**
   * Paste a maybe set into the empty cells among `cells` (drag-copy), as one undo step.
   * Doesn't trigger auto-fill: pasting is entering maybes, not eliminating them.
   */
  /**
   * Paste maybes into `cells` (empty, unlocked ones): add `mask`'s digits to what each has, or, if a cell
   * already has all of them, overwrite it with exactly `mask` (dropping its extras). One undo step.
   */
  pasteNotes(cells: number[], mask: number): ActionResult {
    return this.transact(() => {
      for (const c of cells) {
        if (this.values[c] !== EMPTY || this.givens[c]) continue;
        const cur = this.notes[c];
        const next = cur && (cur & mask) === mask ? mask : cur | mask;
        if (next !== cur) this.write(c, EMPTY, next);
      }
      return { waves: [[]], eliminated: [], changed: [] };
    });
  }

  copyNotes(cells: number[], mask: number): ActionResult {
    return this.transact(() => {
      for (const c of cells) if (this.values[c] === EMPTY && this.notes[c] !== mask) this.write(c, EMPTY, mask);
      return { waves: [[]], eliminated: [], changed: [] };
    });
  }

  /**
   * Remove the digits in `mask` from the maybes of the empty cells among `cells` (e.g. a pair's
   * digits from the rest of its row). Cells left with one maybe auto-fill and can chain.
   */
  eliminateNotes(cells: number[], mask: number): ActionResult {
    return this.transact(() => {
      const reduced: number[] = [];
      const eliminated: { cell: number; digit: number; wave: number }[] = [];
      for (const c of cells) {
        const before = this.notes[c];
        if (this.values[c] !== EMPTY || this.givens[c] || !(before & mask)) continue;
        const after = before & ~mask;
        this.write(c, EMPTY, after);
        for (let d = 0; d < this.n; d++) if (before & mask & bit(d)) eliminated.push({ cell: c, digit: d, wave: 0 });
        if (popcount(before) >= 2 && popcount(after) === 1) reduced.push(c);
      }
      const r = this.resolveChain([], reduced);
      r.eliminated.unshift(...eliminated);
      return r;
    });
  }

  erase(cell: number): ActionResult {
    return this.transact(() => {
      if (this.givens[cell]) return { waves: [[]], eliminated: [], changed: [] };
      if (this.values[cell] !== EMPTY) this.write(cell, EMPTY, this.notes[cell]);
      else if (this.notes[cell]) this.write(cell, EMPTY, 0);
      return { waves: [[]], eliminated: [], changed: [] };
    });
  }

  /** Fill every empty cell's maybes with all digits not already used by its peers. */
  fillAllNotes(): ActionResult {
    return this.fillNotes([...this.values.keys()]);
  }

  /**
   * Same as fillAllNotes, limited to `cells` (e.g. a row swept by a drag).
   * With keepExisting, cells that already have maybes are left as they are.
   */
  fillNotes(cells: number[], keepExisting = false): ActionResult {
    return this.transact(() => {
      for (const c of cells) {
        if (this.values[c] !== EMPTY || (keepExisting && this.notes[c])) continue;
        let m = fullMask(this.n);
        for (const q of this.topo.peers[c]) if (this.values[q] !== EMPTY) m &= ~bit(this.values[q]);
        if (m !== this.notes[c]) this.write(c, EMPTY, m);
      }
      return { waves: [[]], eliminated: [], changed: [] };
    });
  }

  /**
   * Line sweep: fill maybes in each line's empty cells (keeping maybes already there), then find
   * pairs/triples/quads inside each line and remove their digits from the line's other cells, repeating
   * while new groups turn up. Cells that end with one maybe start a chain. All one undo step.
   */
  fillLines(lines: number[][]): { first: ActionResult; result: ActionResult; filled: number[]; groups: LineGroup[] } {
    const filled: number[] = [];
    const groups: LineGroup[] = [];
    let first: ActionResult = { waves: [[]], eliminated: [], changed: [] };
    const result = this.transact(() => {
      for (const c of new Set(lines.flat())) {
        if (this.values[c] !== EMPTY || this.notes[c]) continue;
        let m = fullMask(this.n);
        for (const q of this.topo.peers[c]) if (this.values[q] !== EMPTY) m &= ~bit(this.values[q]);
        this.write(c, EMPTY, m);
        filled.push(c);
      }
      // Order: fill, then place cells the fill left with one maybe (their chain clears their peers),
      // and only then look for pairs/triples in what's left. `first` is that chain; the returned result
      // is the chain the groups start.
      first = this.resolveChain([], filled.filter((c) => popcount(this.notes[c]) === 1));
      if (first.broken) return { waves: [[]], eliminated: [], changed: [] };
      const reduced = new Set<number>();
      for (let guard = 0; guard < 32; guard++) {
        const found = lines.map((line) => ({ line, group: this.findGroup(line) })).find((x) => x.group);
        if (!found) break;
        const { cells, mask } = found.group!;
        const eliminated: { cell: number; digit: number }[] = [];
        for (const c of found.line) {
          const before = this.notes[c];
          if (cells.includes(c) || this.values[c] !== EMPTY || !(before & mask)) continue;
          const after = before & ~mask;
          this.write(c, EMPTY, after);
          for (let d = 0; d < this.n; d++) if (before & mask & bit(d)) eliminated.push({ cell: c, digit: d });
          if (popcount(before) >= 2 && popcount(after) === 1) reduced.add(c);
        }
        groups.push({ cells, mask, eliminated });
      }
      return this.resolveChain([], [...reduced]);
    });
    return { first, result, filled, groups };
  }

  /**
   * The smallest k empty cells in `line` (2 ≤ k ≤ 4) whose maybes together use exactly k digits, when
   * some other cell in the line still has one of those digits (otherwise there's nothing to remove).
   */
  private findGroup(line: number[]): { cells: number[]; mask: number } | null {
    const open = line.filter((c) => this.values[c] === EMPTY && this.notes[c]);
    for (let k = 2; k <= Math.min(4, open.length - 1); k++) {
      // A cell down to one maybe is decided, not part of a group.
      const pool = open.filter((c) => popcount(this.notes[c]) >= 2 && popcount(this.notes[c]) <= k);
      const pick: number[] = [];
      const search = (from: number): { cells: number[]; mask: number } | null => {
        if (pick.length === k) {
          const mask = pick.reduce((m, c) => m | this.notes[c], 0);
          if (popcount(mask) !== k) return null;
          const useful = open.some((c) => !pick.includes(c) && this.notes[c] & mask);
          return useful ? { cells: [...pick], mask } : null;
        }
        for (let i = from; i < pool.length; i++) {
          pick.push(pool[i]);
          const hit = search(i + 1);
          pick.pop();
          if (hit) return hit;
        }
        return null;
      };
      const hit = search(0);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Breadth-first chain: a placed digit leaves its peers' maybes; any cell whose maybes drop to one
   * gets filled in the next wave, and so does the last empty cell of a row/column a placement
   * leaves with one gap (it can only be the missing digit). Each wave can trigger the next.
   */
  private resolveChain(placed: number[], reduced: number[]): ActionResult {
    const waves: number[][] = [placed];
    const eliminated: { cell: number; digit: number; wave: number }[] = [];
    let frontier = placed;
    let pending = new Set(reduced);
    let broken: ActionResult['broken'];
    while (frontier.length || pending.size) {
      // A wave that creates an error (a clash, a wrong cage, an impossible cage) ends the chain right
      // there: its placements stay, but they clear no maybes and nothing more fills.
      const bad = this.waveErrors(frontier);
      if (bad.length) {
        broken = { wave: waves.length - 1, cells: bad };
        break;
      }
      if (this.settings.autoEliminate) {
        for (const c of frontier) {
          const b = bit(this.values[c]);
          for (const q of this.topo.peers[c]) {
            if (this.values[q] !== EMPTY || !(this.notes[q] & b)) continue;
            const before = this.notes[q];
            this.write(q, EMPTY, before & ~b);
            eliminated.push({ cell: q, digit: this.values[c], wave: waves.length - 1 });
            if (popcount(before) >= 2 && popcount(before & ~b) === 1) pending.add(q);
          }
        }
      }
      // Cells the player's own elimination (a pair, a line sweep) cut to one maybe are always placed;
      // only what follows from them is the chain, which needs chains on.
      if (!this.settings.autoFill && (placed.length || waves.length > 1)) break;
      // Digit for each cell filled in the next wave.
      const fills = new Map<number, number>();
      for (const c of pending) if (this.values[c] === EMPTY && popcount(this.notes[c]) === 1) fills.set(c, lowestIndex(this.notes[c]));
      if (this.settings.fillLastGap) for (const [c, d] of this.lastGaps(frontier)) if (!fills.has(c)) fills.set(c, d);
      if (this.settings.fillCageLast) for (const [c, d] of this.lastCageGaps(frontier)) if (!fills.has(c)) fills.set(c, d);
      pending = new Set();
      const next = [...fills.keys()];
      for (const [c, d] of fills) this.write(c, d, this.notes[c]);
      if (next.length) waves.push(next);
      frontier = next;
    }
    return { waves, eliminated, changed: [], broken };
  }

  /**
   * Errors created by placing `cells`: a digit repeated in its row/column (both cells), a cage that is
   * now full but wrong (the whole cage), or, with Finish cages on, a cage whose last empty cell no
   * digit can complete (that cell).
   */
  private waveErrors(cells: number[]): number[] {
    const bad = new Set<number>();
    for (const c of cells) {
      const v = this.values[c];
      if (v === EMPTY) continue;
      for (const q of this.topo.peers[c]) {
        if (this.values[q] === v) {
          bad.add(c);
          bad.add(q);
        }
      }
      const ci = this.topo.cageOf[c];
      if (this.cageStatus(ci) === 'wrong') for (const q of this.puzzle.cages[ci].cells) bad.add(q);
      if (this.settings.fillCageLast) {
        const gap = this.cageGap(ci);
        if (gap && !gap.fits.length) bad.add(gap.cell);
      }
    }
    return [...bad];
  }

  /**
   * For a cage with exactly one empty cell: that cell and every digit that makes the cage's math come
   * out right there (ignoring rows/columns). Empty `fits` means no digit can complete the cage. Null
   * when the cage doesn't have exactly one empty cell.
   */
  /**
   * The total of `part` (some or all cells of cage `ci`) when the player's own marks settle it, without
   * deducing anything for them:
   * - plain arithmetic: filled cells, or part of a + cage whose other cells are all filled;
   * - otherwise every empty cell must have maybes, every way to fill the cage from them that satisfies
   *   its math (no digit repeated in a row or column) must give `part` the same total, AND every maybe
   *   left must fit at least one of those ways. A maybe that can't fit (a 6 left in a 30× whose only
   *   answer is 2·3·5) means the player hasn't worked the cage out yet, so the total stays hidden.
   * E.g. a 3-cell 10× holding 1/2/5 maybes in each cell must be one each of 1, 2 and 5: always 8.
   */
  partSum(ci: number, part: number[]): number | null {
    return this.partTotal(ci, part, 'sum');
  }

  /** As partSum, but the total is a sum or (for × drags) a product of the part's digits. */
  partTotal(ci: number, part: number[], mode: 'sum' | 'product'): number | null {
    const cage = this.puzzle.cages[ci];
    const vals = this.puzzle.digits.values;
    const combine = mode === 'sum' ? (a: number, b: number) => a + b : (a: number, b: number) => a * b;
    const unit = mode === 'sum' ? 0 : 1;
    const filled = (cells: number[]) => cells.every((c) => this.values[c] !== EMPTY);
    const totalOf = (cells: number[]) => cells.reduce((t, c) => combine(t, vals[this.values[c]]), unit);
    if (filled(part)) return totalOf(part);
    const rest = cage.cells.filter((c) => !part.includes(c));
    // Plain arithmetic: the part of a cage whose operator matches the drag, with the rest filled.
    if (mode === 'sum' && cage.op === 'add' && filled(rest)) return cage.target - totalOf(rest);
    if (mode === 'product' && cage.op === 'mul' && filled(rest) && totalOf(rest) !== 0) return cage.target / totalOf(rest);
    if (cage.cells.some((c) => this.values[c] === EMPTY && !this.notes[c])) return null;
    const op = getOperator(cage.op);
    const options = cage.cells.map((c) => {
      if (this.values[c] !== EMPTY) return [this.values[c]];
      const out: number[] = [];
      for (let d = 0; d < this.n; d++) if (this.notes[c] & bit(d)) out.push(d);
      return out;
    });
    // Digits each cell actually takes in some valid filling.
    const used = cage.cells.map(() => 0);
    // ponytail: brute force; cages are small. Too many combinations reads as "can't tell".
    if (options.reduce((k, o) => k * o.length, 1) > 200_000) return null;
    const inPart = cage.cells.map((c) => part.includes(c));
    const clash = this.topo.cageConflicts[ci];
    const pick: number[] = [];
    let total: number | null = null;
    let settled = true;
    const walk = (i: number): void => {
      if (!settled) return;
      if (i === cage.cells.length) {
        const r = op.evaluate(pick.map((d) => vals[d]));
        if (r === null || !approxEq(r, cage.target)) return;
        const sum = pick.reduce((t, d, k) => (inPart[k] ? combine(t, vals[d]) : t), unit);
        if (total === null) total = sum;
        else if (!approxEq(total, sum)) settled = false;
        pick.forEach((d, k) => (used[k] |= bit(d)));
        return;
      }
      for (const d of options[i]) {
        if (clash.some(([a, b]) => (a === i && b < i && pick[b] === d) || (b === i && a < i && pick[a] === d))) continue;
        pick[i] = d;
        walk(i + 1);
      }
    };
    walk(0);
    if (!settled) return null;
    // Every maybe the player left must still be possible; otherwise they haven't worked it out yet.
    const tight = cage.cells.every((c, k) => this.values[c] !== EMPTY || (this.notes[c] & ~used[k]) === 0);
    return tight ? total : null;
  }

  /**
   * Total of a selection, cage by cage, when every part is settled (see partSum). A whole + cage is
   * simply its target.
   */
  regionSum(region: number[]): number | null {
    return this.regionTotal(region, 'sum');
  }

  /**
   * Total of a selection, cage by cage, as a sum or a product (see partTotal). A whole cage whose
   * operator matches (+ for sums, × for products) is simply its target.
   */
  regionTotal(region: number[], mode: 'sum' | 'product'): number | null {
    const { cages } = this.puzzle;
    const inRegion = new Set(region);
    let total = mode === 'sum' ? 0 : 1;
    for (const ci of new Set(region.map((c) => this.topo.cageOf[c]))) {
      const cage = cages[ci];
      const part = cage.cells.filter((c) => inRegion.has(c));
      const whole = part.length === cage.cells.length;
      const own = cage.op === 'given' || cage.op === (mode === 'sum' ? 'add' : 'mul');
      const s = whole && own ? cage.target : this.partTotal(ci, part, mode);
      if (s === null) return null;
      total = mode === 'sum' ? total + s : total * s;
    }
    return total;
  }

  cageGap(ci: number): { cell: number; fits: number[] } | null {
    const cage = this.puzzle.cages[ci];
    const empty = cage.cells.filter((q) => this.values[q] === EMPTY);
    if (empty.length !== 1) return null;
    const gap = empty[0];
    const values = this.puzzle.digits.values;
    const op = getOperator(cage.op);
    const vals = cage.cells.map((q) => (q === gap ? 0 : values[this.values[q]]));
    const at = cage.cells.indexOf(gap);
    const fits: number[] = [];
    for (let d = 0; d < this.n; d++) {
      vals[at] = values[d];
      const r = op.evaluate(vals);
      if (r !== null && approxEq(r, cage.target)) fits.push(d);
    }
    return { cell: gap, fits };
  }

  /**
   * Cages touched by `cells` that now have one empty cell, mapped to the digit that completes their
   * math. The math decides, even if the digit clashes with its row/column (that shows up as a
   * conflict). When the math allows several digits (1− next to a 3: 2 or 4), the row/column picks
   * if it leaves exactly one; otherwise the cell waits. No fitting digit at all: left empty (the
   * board marks it with an X).
   */
  private lastCageGaps(cells: number[]): Map<number, number> {
    const out = new Map<number, number>();
    for (const ci of new Set(cells.map((c) => this.topo.cageOf[c]))) {
      const gap = this.cageGap(ci);
      if (!gap?.fits.length) continue;
      if (gap.fits.length === 1) {
        out.set(gap.cell, gap.fits[0]);
        continue;
      }
      let used = 0;
      for (const q of this.topo.peers[gap.cell]) if (this.values[q] !== EMPTY) used |= bit(this.values[q]);
      const open = gap.fits.filter((d) => !(used & bit(d)));
      if (open.length === 1) out.set(gap.cell, open[0]);
    }
    return out;
  }

  /** Rows/columns touched by `cells` that now have exactly one empty cell and one missing digit. */
  private lastGaps(cells: number[]): Map<number, number> {
    const out = new Map<number, number>();
    const seen = new Set<number>();
    for (const c of cells) {
      for (const hi of this.topo.cellHouses[c]) {
        const house = this.topo.houses[hi];
        if (!house.complete || seen.has(hi)) continue;
        seen.add(hi);
        const empty = house.cells.filter((q) => this.values[q] === EMPTY);
        if (empty.length !== 1) continue;
        const used = house.cells.reduce((m, q) => (this.values[q] === EMPTY ? m : m | bit(this.values[q])), 0);
        const missing = fullMask(this.n) & ~used;
        // Duplicates elsewhere (a mistake) leave more than one digit missing: don't guess.
        if (popcount(missing) === 1) out.set(empty[0], lowestIndex(missing));
      }
    }
    return out;
  }

  // ---------- history & guesses ----------

  private revert(cmd: Command): number[] {
    for (const ch of cmd.changes) {
      this.values[ch.cell] = ch.before.value;
      this.notes[ch.cell] = ch.before.notes;
      this.layers[ch.cell] = ch.before.layer;
    }
    return cmd.changes.map((ch) => ch.cell);
  }

  undo(): number[] {
    const cmd = this.history.pop();
    if (!cmd) return [];
    this.redoStack.push(cmd);
    if (cmd.kind === 'guess-start') {
      this.layer--;
      return [];
    }
    if (cmd.kind === 'guess-keep' && cmd.keep) {
      // Un-confirm: the guess comes back as it was (its moves, its colour, its start).
      const k = cmd.keep;
      this.history = this.history.slice(0, k.at).concat(structuredClone(k.tail));
      const changed = k.layers.flatMap((l, c) => (this.layers[c] !== l ? [c] : []));
      this.layers.set(k.layers);
      this.layer = k.layer;
      return changed;
    }
    return this.revert(cmd);
  }

  /** Re-apply the last undone command. Any new move clears what can be redone. */
  /** How the move redo just re-applied played the first time (null for a guess start or old saves). */
  lastPlayed(): ActionResult | null {
    const cmd = this.history.at(-1);
    return cmd?.fx ? { ...cmd.fx, changed: cmd.changes.map((ch) => ch.cell) } : null;
  }

  redo(): number[] {
    const cmd = this.redoStack.pop();
    if (!cmd) return [];
    if (cmd.kind === 'guess-keep') {
      const changed = this.confirmGuess();
      this.history.push(cmd);
      return changed;
    }
    this.history.push(cmd);
    if (cmd.kind === 'guess-start') {
      this.layer++;
      return [];
    }
    for (const ch of cmd.changes) {
      this.values[ch.cell] = ch.after.value;
      this.notes[ch.cell] = ch.after.notes;
      this.layers[ch.cell] = ch.after.layer;
    }
    return cmd.changes.map((ch) => ch.cell);
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  startGuess(): void {
    this.layer++;
    this.history.push({ kind: 'guess-start', layer: this.layer, changes: [] });
    this.redoStack = [];
  }

  /** Revert everything since the current guess began. */
  dropGuess(): number[] {
    if (this.layer === 0) return [];
    this.redoStack = [];
    const changed = new Set<number>();
    while (this.history.length) {
      const cmd = this.history.pop()!;
      if (cmd.kind === 'guess-start') break;
      this.revert(cmd).forEach((c) => changed.add(c));
    }
    this.layer--;
    return [...changed];
  }

  /** Accept the current guess: its entries join the parent layer. */
  /** Confirm the running guess: its entries become normal ones. One undo step (undo brings the guess back). */
  keepGuess(): number[] {
    if (this.layer === 0) return [];
    this.redoStack = [];
    const idx = this.history.findLastIndex((c) => c.kind === 'guess-start' && c.layer === this.layer);
    const keep = { at: Math.max(0, idx), tail: structuredClone(this.history.slice(Math.max(0, idx))), layers: Array.from(this.layers), layer: this.layer };
    const changed = this.confirmGuess();
    this.history.push({ kind: 'guess-keep', layer: this.layer, changes: [], keep });
    return changed;
  }

  /** The work of confirming: drop the guess's start, retag its moves and cells to the layer below. */
  private confirmGuess(): number[] {
    const from = this.layer;
    const idx = this.history.findLastIndex((c) => c.kind === 'guess-start' && c.layer === from);
    if (idx >= 0) this.history.splice(idx, 1);
    for (const cmd of this.history) {
      if (cmd.layer !== from) continue;
      cmd.layer = from - 1;
      for (const ch of cmd.changes) if (ch.after.layer === from) ch.after.layer = from - 1;
    }
    const changed: number[] = [];
    this.layers.forEach((l, c) => {
      if (l === from) {
        this.layers[c] = from - 1;
        changed.push(c);
      }
    });
    this.layer--;
    return changed;
  }

  // ---------- queries ----------

  /** Cells whose value clashes with a peer, or that complete a cage incorrectly. */
  /** Cells whose digit repeats in their row or column. */
  clashes(): Set<number> {
    const out = new Set<number>();
    for (let c = 0; c < this.values.length; c++) {
      if (this.values[c] === EMPTY) continue;
      for (const q of this.topo.peers[c]) if (this.values[q] === this.values[c]) out.add(c);
    }
    return out;
  }

  /** What a full cage's digits actually come to under its operator (null while open or undefined). */
  cageResult(ci: number): number | null {
    const cage = this.puzzle.cages[ci];
    if (cage.cells.some((c) => this.values[c] === EMPTY)) return null;
    return getOperator(cage.op).evaluate(cage.cells.map((c) => this.puzzle.digits.values[this.values[c]]));
  }

  /** Clashes plus every cell of a full cage whose math is wrong. */
  conflicts(): Set<number> {
    const out = this.clashes();
    this.puzzle.cages.forEach((_, ci) => {
      if (this.cageStatus(ci) === 'wrong') this.puzzle.cages[ci].cells.forEach((c) => out.add(c));
    });
    return out;
  }

  cageStatus(ci: number): 'open' | 'ok' | 'wrong' {
    const cage = this.puzzle.cages[ci];
    if (cage.cells.some((c) => this.values[c] === EMPTY)) return 'open';
    const r = getOperator(cage.op).evaluate(cage.cells.map((c) => this.puzzle.digits.values[this.values[c]]));
    return r !== null && approxEq(r, cage.target) ? 'ok' : 'wrong';
  }

  isSolved(): boolean {
    if (this.values.includes(EMPTY)) return false;
    if (this.puzzle.solution) return this.puzzle.solution.every((d, c) => this.values[c] === d);
    return this.conflicts().size === 0;
  }

  /** Placed numbers that differ from the solution (maybes and givens are ignored). Null without a solution. */
  check(): { wrong: number[]; checked: number[] } | null {
    const sol = this.puzzle.solution;
    if (!sol) return null;
    const checked = [...this.values.keys()].filter((c) => !this.givens[c] && this.values[c] !== EMPTY);
    return { wrong: checked.filter((c) => this.values[c] !== sol[c]), checked };
  }

  hint(): Hint {
    const sol = this.puzzle.solution;
    if (sol) {
      const wrong = [...this.values.keys()].filter((c) => this.values[c] !== EMPTY && this.values[c] !== sol[c]);
      if (wrong.length) {
        const r = Math.floor(wrong[0] / this.n);
        return { kind: 'error', cells: wrong, message: `Something in row ${r + 1} isn't right. Try undoing back or dropping your guess.` };
      }
    }
    if (this.isSolved()) return { kind: 'none', message: 'Solved!' };
    const step = findNextStep(createLogicState(this.ctx, this.values));
    if (!step) return { kind: 'none', message: 'No logical step found.' };
    return { kind: 'step', step };
  }
}
