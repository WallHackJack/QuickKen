import { describe, expect, it } from 'vitest';
import { DIGIT_PRESETS } from '../src/engine/digits';
import { generatePuzzle } from '../src/engine/generator';
import { EMPTY, Game } from '../src/game/Game';

// Most tests poke at arbitrary cells, so use a puzzle without single-cell cages (those start filled and locked).
const puzzle = (() => {
  for (let i = 0; ; i++) {
    const p = generatePuzzle({ size: 5, digits: DIGIT_PRESETS.standard(5), seed: `game-test-${i}`, cageSizeWeights: [0, 7, 5, 2] }).puzzle;
    if (p.cages.every((c) => c.cells.length > 1)) return p;
  }
})();
const withGivens = generatePuzzle({ size: 5, digits: DIGIT_PRESETS.standard(5), seed: 'game-test' }).puzzle;
const sol = puzzle.solution!;

describe('Game', () => {
  it('test puzzle has no single-cell cages', () => {
    expect(puzzle.cages.every((c) => c.cells.length > 1)).toBe(true);
  });

  it('chains auto-fills from full maybes', () => {
    const g = new Game(puzzle);
    g.fillAllNotes();
    // Place correct values until some placement triggers a chain.
    let longest = 0;
    for (let c = 0; c < 25 && !g.isSolved(); c++) {
      if (g.values[c] !== EMPTY) continue;
      const r = g.setValue(c, sol[c]);
      longest = Math.max(longest, r.waves.length);
    }
    expect(g.isSolved()).toBe(true);
    expect(longest).toBeGreaterThan(1);
  });

  it('tags each chain elimination with the wave whose placement caused it', () => {
    const g = new Game(puzzle);
    g.fillAllNotes();
    let checked = 0;
    for (let c = 0; c < 25 && !g.isSolved(); c++) {
      if (g.values[c] !== EMPTY) continue;
      const r = g.setValue(c, sol[c]);
      for (const e of r.eliminated) {
        const causes = r.waves[e.wave].filter((p) => g.topo.peers[p].includes(e.cell) && g.values[p] === e.digit);
        expect(causes.length).toBeGreaterThan(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('a whole chain undoes in one step', () => {
    const g = new Game(puzzle);
    g.fillAllNotes();
    const before = Array.from(g.values);
    for (let c = 0; c < 25; c++) {
      const snapshot = Array.from(g.values);
      const notes = Array.from(g.notes);
      const r = g.setValue(c, sol[c]);
      if (r.waves.length > 1) {
        g.undo();
        expect(Array.from(g.values)).toEqual(snapshot);
        expect(Array.from(g.notes)).toEqual(notes);
        return;
      }
    }
    expect(before).toBeDefined();
  });

  it('does not auto-fill when adding a first maybe', () => {
    const g = new Game(puzzle);
    g.toggleNote(0, 2);
    expect(g.values[0]).toBe(EMPTY);
  });

  it('removing a maybe by hand down to one does not fill the cell', () => {
    const g = new Game(puzzle);
    g.toggleNote(0, 1);
    g.toggleNote(0, 2);
    const r = g.toggleNote(0, 1);
    expect(g.values[0]).toBe(EMPTY);
    expect(g.notes[0]).toBe(1 << 2);
    expect(r.waves).toHaveLength(1);
  });

  it('a placement that leaves a peer with one maybe still fills it', () => {
    const g = new Game(puzzle);
    // Cell 1 (same row as cell 0) holds {sol[0], sol[1]}; placing sol[0] in cell 0 leaves it one maybe.
    g.copyNotes([1], (1 << sol[0]) | (1 << sol[1]));
    g.setValue(0, sol[0]);
    expect(g.values[1]).toBe(sol[1]);
  });

  it('guess layers colour entries and drop all at once', () => {
    const g = new Game(puzzle);
    g.setValue(0, sol[0]);
    g.startGuess();
    g.setValue(1, sol[1]);
    g.setValue(2, sol[2]);
    expect(g.layers[1]).toBe(1);
    expect(g.layers[0]).toBe(0);
    g.startGuess();
    g.setValue(3, sol[3]);
    expect(g.layers[3]).toBe(2);
    g.dropGuess();
    expect(g.values[3]).toBe(EMPTY);
    expect(g.values[2]).toBe(sol[2]);
    g.dropGuess();
    expect(g.values[1]).toBe(EMPTY);
    expect(g.values[0]).toBe(sol[0]);
    expect(g.layer).toBe(0);
  });

  it('keeping a guess merges it into the parent layer', () => {
    const g = new Game(puzzle);
    g.startGuess();
    g.setValue(1, sol[1]);
    g.keepGuess();
    expect(g.layer).toBe(0);
    expect(g.layers[1]).toBe(0);
    g.undo(); // un-confirms the guess
    g.undo(); // then undoes the entry
    expect(g.values[1]).toBe(EMPTY);
  });

  it('a maybe on a filled cell turns its value into maybes', () => {
    const g = new Game(puzzle);
    g.setValue(0, 0);
    g.toggleNote(0, 0);
    expect(g.values[0]).toBe(EMPTY);
    expect(g.notes[0]).toBe(0b1);
    g.setValue(1, 0);
    g.toggleNote(1, 2);
    expect(g.values[1]).toBe(EMPTY);
    expect(g.notes[1]).toBe(0b101);
    // The placement was the move right before, so it was taken back: undo returns to the empty cell.
    g.undo();
    expect(g.values[1]).toBe(EMPTY);
    expect(g.notes[1]).toBe(0);
  });

  it('drag-copying maybes is one undo step and skips filled cells', () => {
    const g = new Game(puzzle);
    g.toggleNote(0, 1);
    g.toggleNote(0, 3);
    g.setValue(2, sol[2]);
    const before = g.history.length;
    expect(g.copyNotes([1, 2, 6], g.notes[0]).changed).toEqual([1, 6]);
    expect(g.history.length).toBe(before + 1);
    expect(g.notes[1]).toBe(g.notes[0]);
    expect(g.notes[6]).toBe(g.notes[0]);
    g.undo();
    expect(g.notes[1]).toBe(0);
    expect(g.notes[6]).toBe(0);
    expect(g.values[2]).toBe(sol[2]);
  });

  it('starts with single-cell cages filled in and locked', () => {
    const singles = withGivens.cages.filter((c) => c.cells.length === 1).map((c) => c.cells[0]);
    expect(singles.length).toBeGreaterThan(0);
    const sol = withGivens.solution!;
    const g = new Game(withGivens);
    for (const c of singles) {
      expect(g.values[c]).toBe(sol[c]);
      expect(g.givens[c]).toBe(1);
      g.erase(c);
      g.setValue(c, (sol[c] + 1) % 5);
      g.toggleNote(c, 0);
      expect(g.values[c]).toBe(sol[c]);
    }
    expect(g.history).toHaveLength(0);
  });

  it('fills maybes for just the given cells', () => {
    const g = new Game(puzzle);
    g.setValue(0, sol[0]);
    const row = [0, 1, 2, 3, 4];
    const r = g.fillNotes(row);
    expect(r.changed).toEqual([1, 2, 3, 4]);
    for (const c of [1, 2, 3, 4]) expect(g.notes[c] & (1 << sol[0])).toBe(0);
    expect(g.notes[5]).toBe(0);
  });

  it('redo re-applies undone moves, including guess starts, until a new move', () => {
    const g = new Game(puzzle);
    g.setValue(0, sol[0]);
    g.startGuess();
    g.setValue(1, sol[1]);
    g.undo();
    g.undo();
    expect(g.layer).toBe(0);
    expect(g.values[1]).toBe(EMPTY);
    expect(g.canRedo).toBe(true);
    g.redo();
    expect(g.layer).toBe(1);
    g.redo();
    expect(g.values[1]).toBe(sol[1]);
    expect(g.layers[1]).toBe(1);
    expect(g.canRedo).toBe(false);
    g.undo();
    g.setValue(2, sol[2]);
    expect(g.canRedo).toBe(false);
  });

  it('turning a just-placed value back into a maybe restores the maybes it cleared', () => {
    const g = new Game(puzzle);
    g.fillAllNotes();
    const c = 0;
    const d = sol[c];
    const peersWithD = g.topo.peers[c].filter((q) => g.notes[q] & (1 << d));
    const notesBefore = Array.from(g.notes);
    const valuesBefore = Array.from(g.values);
    const hist = g.history.length;
    g.setValue(c, d);
    expect(peersWithD.some((q) => g.notes[q] & (1 << d))).toBe(false);
    const r = g.toggleNote(c, d);
    // Peers have their maybe back; any chain cells are empty again; the cell is maybe [d].
    for (const q of peersWithD) expect(g.notes[q] & (1 << d)).toBeTruthy();
    expect(g.values[c]).toBe(EMPTY);
    expect(g.notes[c]).toBe(1 << d);
    for (let k = 0; k < 25; k++) if (k !== c) expect(g.values[k]).toBe(valuesBefore[k]);
    expect(r.changed).toEqual(expect.arrayContaining(peersWithD));
    // The slip is gone from history: one undo returns to before the placement.
    expect(g.history.length).toBe(hist + 1);
    g.undo();
    expect(Array.from(g.notes)).toEqual(notesBefore);
    expect(Array.from(g.values)).toEqual(valuesBefore);
  });

  it('an older placement turned into maybes keeps its eliminations', () => {
    const g = new Game(puzzle);
    g.fillAllNotes();
    const d = sol[0];
    const peer = g.topo.peers[0].find((q) => g.notes[q] & (1 << d))!;
    g.setValue(0, d);
    g.toggleNote(24, sol[24]); // some other move in between
    g.toggleNote(0, d);
    expect(g.notes[peer] & (1 << d)).toBe(0);
  });

  it('eliminating a pair from its row can start a chain, as one undo step', () => {
    const g = new Game(puzzle);
    // Row 0 as maybes: cells 0,1 hold the pair {A,B}; cell 2 holds {A,C}, which drops to {C} and fills.
    const [a, b, cc] = [sol[0], sol[1], sol[2]];
    const mask = (1 << a) | (1 << b);
    g.copyNotes([0, 1], mask);
    g.copyNotes([2], (1 << a) | (1 << cc));
    const hist = g.history.length;
    const r = g.eliminateNotes([2, 3, 4], mask);
    expect(g.values[2]).toBe(cc);
    expect(r.waves[1]).toEqual([2]);
    expect(g.history.length).toBe(hist + 1);
    g.undo();
    expect(g.values[2]).toBe(EMPTY);
    expect(g.notes[2]).toBe((1 << a) | (1 << cc));
  });

  it('a pair that leaves one maybe places it even with chains off', () => {
    const g = new Game(puzzle);
    g.settings.autoFill = false;
    const [a, b, cc] = [sol[0], sol[1], sol[2]];
    const mask = (1 << a) | (1 << b);
    g.copyNotes([0, 1], mask);
    g.copyNotes([2], (1 << a) | (1 << cc));
    const r = g.eliminateNotes([2, 3, 4], mask);
    expect(g.values[2]).toBe(cc);
    expect(r.waves).toHaveLength(2);
  });

  it('a line sweep places a cell it fills with a single maybe', () => {
    const g = new Game(puzzle);
    g.settings.fillLastGap = false;
    g.settings.fillCageLast = false;
    for (const c of [0, 1, 2, 3]) g.setValue(c, sol[c]);
    // It's placed in the first chain, before any pair search (`result` is the groups' chain).
    const { first } = g.fillLines([[4]]);
    expect(g.values[4]).toBe(sol[4]);
    expect(first.waves[1]).toEqual([4]);
  });

  it('a 2-cell cage holding the same 2 maybes in both cells has a known sum', () => {
    const g = new Game(puzzle);
    const ci = puzzle.cages.findIndex((c) => c.cells.length === 2);
    const [p, q] = puzzle.cages[ci].cells;
    const vals = puzzle.digits.values;
    g.copyNotes([p, q], (1 << sol[p]) | (1 << sol[q]));
    expect(g.regionSum([p, q])).toBe(vals[sol[p]] + vals[sol[q]]);
  });

  it('a maybe that fits no valid filling keeps the sum hidden (no deducing for the player)', () => {
    const g = new Game(puzzle);
    const ops: Record<string, (a: number, b: number) => number> = { mul: (a, b) => a * b, add: (a, b) => a + b, sub: (a, b) => Math.abs(a - b), div: (a, b) => Math.max(a, b) / Math.min(a, b) };
    const vals = puzzle.digits.values;
    const ci = puzzle.cages.findIndex((c) => c.cells.length === 2 && c.op !== 'add' && ops[c.op]);
    if (ci < 0) return;
    const cage = puzzle.cages[ci];
    const [p, q] = cage.cells;
    const pair = (1 << sol[p]) | (1 << sol[q]);
    g.copyNotes([p, q], pair);
    expect(g.partSum(ci, cage.cells)).not.toBeNull();
    // A digit for p that works with neither of q's maybes: the player hasn't ruled it out yet.
    const x = [...Array(puzzle.size).keys()].find((d) => !(pair & (1 << d)) && [sol[p], sol[q]].every((e) => ops[cage.op](vals[d], vals[e]) !== cage.target));
    if (x === undefined) return;
    g.copyNotes([p], pair | (1 << x));
    expect(g.partSum(ci, cage.cells)).toBeNull();
  });

  it('a settled sum is always the true sum (each cage holding its solution digits as maybes)', () => {
    const g = new Game(puzzle);
    const vals = puzzle.digits.values;
    let settled = 0;
    puzzle.cages.forEach((cage, ci) => {
      const mask = cage.cells.reduce((m, c) => m | (1 << sol[c]), 0);
      g.copyNotes(cage.cells, mask);
      const s = g.partSum(ci, cage.cells);
      if (s !== null) {
        settled++;
        expect(s).toBe(cage.cells.reduce((t, c) => t + vals[sol[c]], 0));
      }
    });
    expect(settled).toBeGreaterThan(0);
  });

  it('part of a + cage sums to its target minus the cells already known', () => {
    const g = new Game(puzzle);
    g.settings.autoFill = false;
    const cage = puzzle.cages.find((c) => c.op === 'add' && c.cells.length >= 2)!;
    const [first, ...rest] = cage.cells;
    expect(g.regionSum(rest)).toBeNull();
    g.setValue(first, sol[first]);
    expect(g.regionSum(rest)).toBe(cage.target - puzzle.digits.values[sol[first]]);
  });

  it('undo history survives a save and reload, and lastChanged names the last move', () => {
    const g = new Game(puzzle);
    g.settings.autoFill = false;
    g.setValue(0, sol[0]);
    g.setValue(1, sol[1]);
    expect(g.lastChanged()).toContain(1);
    const saved = { values: Array.from(g.values), notes: Array.from(g.notes), layers: Array.from(g.layers), history: g.exportHistory() };
    const h = new Game(puzzle);
    h.restore(saved.values, saved.notes, saved.layers, 0);
    h.importHistory(saved.history);
    h.undo();
    expect(h.values[1]).toBe(EMPTY);
    expect(h.values[0]).toBe(sol[0]);
    h.importHistory('not json');
    expect(h.lastChanged()).toContain(0);
  });

  it('paste adds the copied maybes, or overwrites a cell that already has them all', () => {
    const g = new Game(puzzle);
    g.copyNotes([1], 0b0100);
    g.copyNotes([2], 0b1011);
    g.pasteNotes([1, 2, 3], 0b0011);
    expect(g.notes[1]).toBe(0b0111); // added
    expect(g.notes[2]).toBe(0b0011); // had both: overwritten, extra dropped
    expect(g.notes[3]).toBe(0b0011); // blank: filled
  });

  it('redo can replay a move the way it first played', () => {
    const g = new Game(puzzle);
    const r = g.setValue(0, sol[0]);
    g.undo();
    g.redo();
    expect(g.lastPlayed()?.waves).toEqual(r.waves);
  });

  it('confirming a guess can be undone and redone', () => {
    const g = new Game(puzzle);
    g.settings.autoFill = false;
    g.startGuess();
    g.setValue(7, sol[7]);
    g.keepGuess();
    expect(g.layer).toBe(0);
    expect(g.layers[7]).toBe(0);
    g.undo(); // the guess is back, with its entry still in it
    expect(g.layer).toBe(1);
    expect(g.layers[7]).toBe(1);
    expect(g.guessOrigin()).toEqual({ cell: 7, digit: sol[7] });
    g.undo(); // and its entry undoes inside the guess
    expect(g.values[7]).toBe(EMPTY);
    g.redo();
    g.redo(); // confirmed again
    expect(g.layer).toBe(0);
    expect(g.layers[7]).toBe(0);
    expect(g.values[7]).toBe(sol[7]);
  });

  it('a guess remembers the move it started from', () => {
    const g = new Game(puzzle);
    g.settings.autoFill = false;
    g.setValue(0, sol[0]);
    expect(g.guessOrigin()).toBeNull();
    g.startGuess();
    g.setValue(7, sol[7]);
    g.setValue(8, sol[8]);
    expect(g.guessOrigin()).toEqual({ cell: 7, digit: sol[7] });
    expect(g.guessCells()).toEqual([8, 7]);
    expect(g.peekUndo()).toEqual([8]);
    g.dropGuess();
    expect(g.guessOrigin()).toBeNull();
    expect(g.values[0]).toBe(sol[0]);
  });

  it('fills the last gap in a row as the next chain wave', () => {
    const g = new Game(puzzle);
    for (const c of [0, 1, 2]) g.setValue(c, sol[c]);
    const r = g.setValue(3, sol[3]);
    expect(g.values[4]).toBe(sol[4]);
    expect(r.waves[1]).toContain(4);
    g.undo();
    expect(g.values[4]).toBe(EMPTY);
  });

  it('a gap closing a row can close a column too (combo continues)', () => {
    const g = new Game(puzzle);
    // Column 4 filled except rows 0 and 1; row 0 filled except cells 3 and 4.
    for (const r of [2, 3, 4]) g.setValue(r * 5 + 4, sol[r * 5 + 4]);
    for (const c of [0, 1, 2]) g.setValue(c, sol[c]);
    // Placing cell 3 leaves row 0 one gap (cell 4) → wave 1; that leaves column 4 one gap (cell 9) → wave 2.
    const r = g.setValue(3, sol[3]);
    expect(g.values[4]).toBe(sol[4]);
    expect(g.values[9]).toBe(sol[9]);
    expect(r.waves[1]).toContain(4);
    expect(r.waves[2]).toContain(9);
  });

  it('fills the last cell of a cage from its math when only one digit fits', () => {
    let filled = 0;
    for (const cage of puzzle.cages) {
      const g = new Game(puzzle);
      g.settings.fillLastGap = false;
      const [last, ...rest] = [...cage.cells].reverse();
      let r = null;
      for (const c of rest.reverse()) r = g.setValue(c, sol[c]);
      if (g.values[last] === EMPTY) continue; // math allowed more than one digit here
      filled++;
      expect(g.values[last]).toBe(sol[last]);
      expect(r!.waves.flat()).toContain(last);
    }
    expect(filled).toBeGreaterThan(0);
  });

  it('finishes a cage from its math even when the digit clashes, and reports impossible gaps', () => {
    // 3×3, digits 1–3; cage 0 is cells 0+1 = 3.
    const tiny = {
      size: 3,
      digits: DIGIT_PRESETS.standard(3),
      cages: [
        { cells: [0, 1], op: 'add', target: 3 },
        { cells: [2, 5], op: 'add', target: 4 },
        { cells: [3, 6], op: 'mul', target: 6 },
        { cells: [4, 7, 8], op: 'add', target: 6 },
      ],
    };
    // Cell 2 holds a 1 (wrong, but placed); then 2 in cell 0 means cell 1 must be 1 by the math.
    // That clashes with cell 2 in the row, and it fills anyway.
    const g = new Game(tiny);
    g.settings.fillLastGap = false;
    g.setValue(2, 0);
    g.setValue(0, 1);
    expect(g.values[1]).toBe(0);
    expect(g.conflicts().has(1)).toBe(true);
    // A 3 in cell 0 leaves no partner (3 + 0): nothing fills and the gap reports no fits.
    const g2 = new Game(tiny);
    g2.setValue(0, 2);
    expect(g2.values[1]).toBe(EMPTY);
    expect(g2.cageGap(0)).toEqual({ cell: 1, fits: [] });
  });

  it('a placement that clashes breaks the chain at once and clears no maybes', () => {
    const g = new Game(puzzle);
    g.fillAllNotes();
    g.setValue(0, sol[0]);
    const before = Array.from(g.notes);
    // Same digit again in the same row: an error on the player's own move.
    const r = g.setValue(1, sol[0]);
    expect(r.broken).toEqual({ wave: 0, cells: expect.arrayContaining([0, 1]) });
    expect(r.waves).toHaveLength(1);
    expect(Array.from(g.notes)).toEqual(before);
  });

  it('a chain stops at the wave that creates an error', () => {
    // Cell 1 has one wrong maybe left once cell 0 is placed: it fills with a clash and the chain ends.
    const g = new Game(puzzle);
    g.settings.fillCageLast = false;
    g.settings.fillLastGap = false;
    const wrong = sol[2];
    g.setValue(2, wrong);
    g.copyNotes([1], (1 << sol[0]) | (1 << wrong));
    const r = g.setValue(0, sol[0]);
    expect(g.values[1]).toBe(wrong);
    expect(r.broken?.wave).toBe(1);
    expect(r.broken?.cells).toEqual(expect.arrayContaining([1, 2]));
    expect(r.waves).toHaveLength(2);
  });

  it('cage-last fill can be turned off', () => {
    const cage = puzzle.cages.find((c) => c.cells.length >= 2)!;
    const g = new Game(puzzle);
    g.settings.fillLastGap = false;
    g.settings.fillCageLast = false;
    for (const c of cage.cells.slice(0, -1)) g.setValue(c, sol[c]);
    expect(g.values[cage.cells[cage.cells.length - 1]]).toBe(EMPTY);
  });

  it('with chains off nothing fills itself, but placements still clear maybes', () => {
    const g = new Game(puzzle);
    g.settings.autoFill = false;
    g.fillAllNotes();
    const filledBefore = g.values.filter((v) => v !== EMPTY).length;
    for (const c of [0, 1, 2, 3]) {
      const r = g.setValue(c, sol[c]);
      expect(r.waves).toHaveLength(1);
      for (const q of g.topo.peers[c]) if (g.values[q] === EMPTY) expect(g.notes[q] & (1 << sol[c])).toBe(0);
    }
    // Only the four placed cells changed: no last-gap, cage or single-maybe fills.
    expect(g.values.filter((v) => v !== EMPTY).length).toBe(filledBefore + 4);
  });

  it('last-gap fill can be turned off', () => {
    const g = new Game(puzzle);
    g.settings.fillLastGap = false;
    for (const c of [0, 1, 2, 3]) g.setValue(c, sol[c]);
    expect(g.values[4]).toBe(EMPTY);
  });

  it('does not fill a last gap when the line has a duplicate', () => {
    const g = new Game(puzzle);
    g.setValue(0, sol[1]);
    g.setValue(1, sol[1]);
    g.setValue(2, sol[2]);
    g.setValue(3, sol[3]);
    expect(g.values[4]).toBe(EMPTY);
  });

  it('a line sweep finds pairs in the line and clears their digits, as one undo step', () => {
    const g = new Game(puzzle);
    const row = [0, 1, 2, 3, 4];
    const [a, b] = [sol[0], sol[1]];
    // Cells 0 and 1 already hold the pair {a, b}; the sweep fills 2..4 with everything, then the pair
    // removes a and b from them.
    g.copyNotes([0, 1], (1 << a) | (1 << b));
    const hist = g.history.length;
    const { filled, groups } = g.fillLines([row]);
    expect(filled).toEqual([2, 3, 4]);
    expect(groups[0].cells).toEqual([0, 1]);
    for (const c of [2, 3, 4]) expect(g.notes[c] & ((1 << a) | (1 << b))).toBe(0);
    expect(g.history.length).toBe(hist + 1);
    g.undo();
    for (const c of [2, 3, 4]) expect(g.notes[c]).toBe(0);
  });

  it('cells down to one maybe never form a pair', () => {
    const g = new Game(puzzle);
    g.settings.autoFill = false;
    g.copyNotes([0], 0b01);
    g.copyNotes([1], 0b10);
    const { groups } = g.fillLines([[0, 1, 2, 3, 4]]);
    expect(groups.some((gr) => gr.cells.includes(0) || gr.cells.includes(1))).toBe(false);
  });

  it('a line sweep with no groups just fills', () => {
    const g = new Game(puzzle);
    const { filled, groups } = g.fillLines([[0, 1, 2, 3, 4]]);
    expect(filled).toHaveLength(5);
    expect(groups).toHaveLength(0);
  });

  it('line fill can keep maybes the player already entered', () => {
    const g = new Game(puzzle);
    g.toggleNote(1, 0);
    const r = g.fillNotes([0, 1, 2, 3, 4], true);
    expect(r.changed).toEqual([0, 2, 3, 4]);
    expect(g.notes[1]).toBe(0b1);
  });

  it('check flags wrong numbers only, never maybes', () => {
    const g = new Game(puzzle);
    g.setValue(0, sol[0]);
    g.setValue(1, (sol[1] + 1) % 5);
    g.copyNotes([5], 1 << ((sol[5] + 1) % 5)); // maybe without the right digit: not checked
    const r = g.check()!;
    expect(r.wrong).toEqual([1]);
    expect(r.checked).toEqual([0, 1]);
  });

  it('hints point out wrong values first', () => {
    const g = new Game(puzzle);
    g.setValue(0, (sol[0] + 1) % 5);
    expect(g.hint().kind).toBe('error');
    g.undo();
    expect(g.hint().kind).toBe('step');
  });
});
