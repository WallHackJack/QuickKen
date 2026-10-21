import './ui/style.css';
import { cageFactors } from './game/factor';
import { cageLabel } from './engine/puzzle';
import { Application, Container } from 'pixi.js';
import { maskIndices } from './engine/bits';
import { DIGIT_PRESETS } from './engine/digits';
import type { GenOptions, GenResult } from './engine/generator';
import { EMPTY, Game, type ActionResult } from './game/Game';
import { boardText, Link, type GameSnapshot, type RemoteMessage } from './game/Link';
import { loadOptions, saveOptions } from './game/options';
import { Background } from './render/Background';
import { BoardView, LAYER_COLORS, type DragResult } from './render/BoardView';
import { Lighting } from './render/Lighting';
import { Particles } from './render/Particles';
import { Tweens } from './render/Tweens';
import { Hud, type HudHandlers } from './ui/Hud';
import { digitLetters } from './ui/keys';

const stageEl = document.getElementById('stage')!;
const hudEl = document.getElementById('hud')!;

const app = new Application();
await app.init({
  resizeTo: stageEl,
  antialias: true,
  preference: 'webgl',
  resolution: Math.min(window.devicePixelRatio || 1, 2),
  autoDensity: true,
  backgroundColor: 0x05060f,
});
stageEl.appendChild(app.canvas);

const tweens = new Tweens();
const particles = new Particles();
const bg = new Background();
const board = new BoardView(tweens, particles, bg);
// Background and board are one scene: the lighting/ripple pass runs over both at once.
const scene = new Container();
scene.filterArea = app.screen;
scene.addChild(bg.mesh, board);
app.stage.addChild(scene);
board.lighting = new Lighting(scene, board, app.canvas, hudEl, bg.ripples);

let game: Game | null = null;
let notesMode = false;
/** The previous input put this digit in as the cell's first maybe (pressing it again makes it the number). */
let firstMaybe: { cell: number; digit: number } | null = null;
/** The cell a digit-pad sweep is filling, its maybes before the sweep, and whether a step is applied. */
let sweepBase: { cell: number; notes: number; applied: boolean } | null = null;
let startTime = performance.now();
let solvedAt: number | null = null;

const worker = new Worker(new URL('./engine/gen.worker.ts', import.meta.url), { type: 'module' });

let options = loadOptions();

/** Push the player's options into the current game's rules. */
function applyOptions(): void {
  // Speed only spaces out chain waves: 4× keeps today's gaps, 1× makes them 4 times longer.
  board.wavePace = 4 / options.animSpeed;
  board.markBadNotes = options.markBadMaybes;
  board.refresh();
  if (!game) return;
  game.settings.fillLastGap = options.fillLastGap;
  game.settings.fillCageLast = options.fillCageLast;
  // With chains off nothing fills itself (the last-cell and cage fills are part of the chain too).
  game.settings.autoFill = options.chains;
}

const handlers: HudHandlers = {
  digit: (d) => digitAction(board.selected, d, notesMode),
  erase: () => clearCell(board.selected),
  undo: () => {
    if (!game) return;
    // Undo while a chain is still playing stops it and rewinds what had been shown; otherwise the
    // move plays backwards. A crossed-out guess digit (left by undoing a guess) goes in the same step,
    // rewinding out with the move before it.
    const stopped = board.interruptChain();
    const cells = game.peekUndo();
    const before = stopped ? null : board.snapshotCells([...cells, ...[...board.disproven.keys()].filter((c) => !cells.includes(c))]);
    board.disproven.clear();
    after(game.undo());
    if (before) board.rewindMove(before);
    if (stopped) hud.say('Chain stopped and undone.');
  },
  redo: () => {
    if (!game?.canRedo) return;
    game.redo();
    // Replay the move the way it played the first time (its chain included), not a snap.
    const fx = game.lastPlayed();
    board.hintCells.clear();
    board.errorCells.clear();
    if (fx) board.play(fx);
    else board.refresh();
    sync();
    hud.say(game.canRedo ? 'Redo. Keep holding to redo more.' : 'Redo. Nothing left to redo.');
  },
  guess: () => {
    if (!game) return;
    game.startGuess();
    hud.say(`Guess ${game.layer} started: what you enter now is coloured. Tap the Guess button to confirm or undo it.`, 'hint');
    after([]);
  },
  keep: () => {
    if (!game) return;
    const n = game.layer;
    after(game.keepGuess());
    hud.say(game.layer ? `Confirmed guess ${n}. You're back in guess ${game.layer}.` : `Confirmed guess ${n}. Those entries are normal now.`);
  },
  drop: () => {
    if (!game) return;
    const n = game.layer;
    board.interruptChain();
    // Remember where the guess started: undoing it means that first move didn't work out.
    const origin = game.guessOrigin();
    const before = board.snapshotCells(game.guessCells());
    const cells = game.dropGuess();
    after(cells);
    board.rewindMove(before);
    const back = game.layer ? ` You're back in guess ${game.layer}.` : ' The board is back to before the guess.';
    if (origin) {
      const cage = game.puzzle.cages[game.topo.cageOf[origin.cell]];
      const label = origin.digit >= 0 ? game.puzzle.digits.labels[origin.digit] : '';
      const where = `row ${Math.floor(origin.cell / game.n) + 1}, column ${(origin.cell % game.n) + 1} (${cageLabel(cage)})`;
      hud.say(`Undid guess ${n}: it began with ${label ? label + ' in ' : ''}${where}.${back}`, 'hint');
      // After the rewind reaches the guess's first move (it rewinds last), plus its spin-out.
      board.markDisproven(origin.cell, label, origin.digit, before.length * 28 + 220);
    } else hud.say(`Undid guess ${n}.${back}`);
  },
  check: () => {
    if (!game) return;
    const r = game.check();
    if (!r) return hud.say('This puzzle has no answer key to check against.');
    board.checkFx(r.wrong, r.checked);
    if (!r.checked.length) hud.say('No numbers to check yet.');
    else if (!r.wrong.length) hud.say(`All good: ${plural(r.checked.length, 'number')} checked.`, 'win');
    else hud.say(`${plural(r.wrong.length, 'number')} ${r.wrong.length === 1 ? 'is' : 'are'} wrong. Marked in red.`, 'error');
  },
  hint: () => {
    if (!game) return;
    const h = game.hint();
    board.hintCells = new Set(h.kind === 'step' ? h.step.focusCells : h.kind === 'error' ? h.cells : []);
    if (h.kind === 'step') {
      hud.say(`${h.step.name}: ${h.step.explain}`, 'hint');
      for (const ci of h.step.cages) board.pulseCage(board.cageViews[ci], 0.08, 500);
    } else hud.say(h.message, h.kind === 'error' ? 'error' : '');
    board.refresh();
  },
  newGame: (o) => requestPuzzle(o),
  optionsChanged: (o) => {
    options = o;
    saveOptions(o);
    hud.setOptions(o);
    applyOptions();
  },
  toggleNotes: () => {
    notesMode = !notesMode;
    sync();
  },
  sweepStep: (digits) => {
    const c = board.selected;
    if (!game || solvedAt || c < 0 || game.givens[c]) return;
    board.disproven.delete(c);
    if (!sweepBase) {
      notesMode = true;
      // A filled cell is cleared first; the swept maybes are added to any it had.
      if (game.values[c] !== EMPTY) apply(game.erase(c));
      sweepBase = { cell: c, notes: game.notes[c], applied: false };
    } else if (sweepBase.applied) {
      // Each step replaces the last, so the whole sweep stays one undo step.
      game.undo();
    }
    const mask = digits.reduce((m, d) => m | (1 << d), sweepBase.notes);
    const r = game.copyNotes([sweepBase.cell], mask);
    apply(r);
    // Only a step that changed something is in the history (and safe to undo next time).
    sweepBase.applied = r.changed.length > 0;
    buzz(8);
    sync();
  },
  sweepEnd: () => {
    sweepBase = null;
  },
};
const hud = new Hud(hudEl, stageEl, handlers);
hud.setOptions(options);

function sync(): void {
  if (!game) return;
  // Undo (or a stale save) can take a finished puzzle back to unfinished: unlock input and resume the
  // clock from where it stopped.
  if (solvedAt && !game.isSolved()) {
    startTime += performance.now() - solvedAt;
    solvedAt = null;
  }
  const origin = game.guessOrigin();
  const ring = origin ? { cell: origin.cell, color: LAYER_COLORS[Math.min(game.layer, LAYER_COLORS.length - 1)] } : null;
  if (ring?.cell !== board.guessOrigin?.cell || ring?.color !== board.guessOrigin?.color) {
    board.guessOrigin = ring;
    board.refresh();
  }
  hud.sync({ notesMode, layer: game.layer, cellNotes: game.notes[board.selected], canUndo: game.history.length > 0 || board.disproven.size > 0, canRedo: game.canRedo });
  board.setMaybeMode(notesMode);
  persist();
}

/**
 * A digit press on cell c. Pressing the digit a cell already shows swaps it between the value and
 * the lone maybe, in either mode: 2 → maybe [2], maybe [2] → 2. The input mode follows the swap.
 */
function digitAction(c: number, d: number, asMaybe: boolean): void {
  if (!game || solvedAt) return;
  // Entering anything replaces a crossed-out (disproven) guess digit.
  board.disproven.delete(c);
  const justAdded = firstMaybe?.cell === c && firstMaybe.digit === d;
  firstMaybe = null;
  // Pressing a digit never switches modes (only tapping the selected cell does).
  if (game.values[c] === d && !asMaybe) return;
  if (game.values[c] === EMPTY && game.notes[c] === 1 << d && (justAdded || !asMaybe)) {
    // A cell's only maybe becomes the number when typed as a number, or when it was the maybe just
    // put in as the cell's first. Otherwise (maybe mode) pressing it again just removes it.
    apply(game.setValue(c, d));
  } else if (asMaybe) noteAction(c, d);
  else apply(game.setValue(c, d));
}

/** Toggle a maybe; on a filled cell this turns the value back into maybes (with its own effect). */
function noteAction(c: number, d: number): void {
  if (!game) return;
  const was = game.values[c];
  const ink = LAYER_COLORS[Math.min(game.layers[c], LAYER_COLORS.length - 1)];
  const had = was === EMPTY && game.notes[c] & (1 << d);
  const first = was === EMPTY && game.notes[c] === 0;
  const r = game.toggleNote(c, d);
  apply(r);
  if (first && game.notes[c] === 1 << d) firstMaybe = { cell: c, digit: d };
  if (had && !(game.notes[c] & (1 << d))) board.dustNote(c, d);
  if (was !== EMPTY) {
    board.valueToMaybes(c, game.puzzle.digits.labels[was], ink);
    // Peers that got back the maybe this value had cleared (it was placed by the previous move).
    board.restoreFx(r.changed.filter((k) => k !== c && game!.values[k] === EMPTY && game!.notes[k]));
  }
}

/** Clear a cell; maybes it had turn to dust. */
function clearCell(c: number): void {
  if (!game) return;
  // Clear first just removes a crossed-out guess digit, revealing whatever the cell had under it.
  if (board.disproven.delete(c)) {
    board.refresh();
    return;
  }
  const notes = game.values[c] === EMPTY ? game.notes[c] : 0;
  apply(game.erase(c));
  for (let d = 0; d < game.n; d++) if (notes & (1 << d) && !(game.notes[c] & (1 << d))) board.dustNote(c, d);
}

function apply(r: ActionResult): void {
  if (!game) return;
  firstMaybe = null;
  board.hintCells.clear();
  board.errorCells.clear();
  board.play(r);
  const chain = r.waves.length - 1;
  if (game.isSolved()) {
    solvedAt = performance.now();
    // A solved board is right, so any running guesses are locked in: every number in one colour.
    while (game.layer > 0) game.keepGuess();
    board.refresh();
    hud.say(`Solved in ${Math.round((solvedAt - startTime) / 1000)}s!`, 'win');
  } else if (r.broken && r.broken.wave > 0) hud.say(`Chain broken at step ${r.broken.wave}: something doesn't fit. See the red cells.`, 'error');
  else if (r.broken) hud.say("That doesn't fit, so nothing else fills. See the red cells.", 'error');
  else if (chain >= 2) hud.say(`Chain reaction ×${chain}!`);
  else hud.say('');
  sync();
}

function after(_changed: number[]): void {
  firstMaybe = null;
  board.hintCells.clear();
  board.errorCells.clear();
  board.refresh();
  sync();
}

function layout(): void {
  if (!game) return;
  const w = app.screen.width, h = app.screen.height;
  const top = 56; // room for the top bar and combo text
  const size = Math.max(120, Math.min(w - 40, h - top - 24));
  board.build(game, size, (w - size) / 2, top + (h - top - size) / 2);
  bg.resize(w, h);
}

function startGame(res: GenResult, saved?: GameSnapshot): void {
  game = new Game(res.puzzle);
  applyOptions();
  board.selected = 0;
  solvedAt = null;
  startTime = performance.now();
  if (saved) {
    game.restore(saved.values, saved.notes, saved.layers, saved.layer);
    game.importHistory(saved.history);
    board.selected = saved.selected;
    notesMode = saved.notesMode;
    startTime = performance.now() - saved.elapsedMs;
    if (saved.solved) solvedAt = performance.now();
  }
  hud.setDigits(res.puzzle.digits.labels);
  const m = res.puzzle.meta;
  hud.setMeta(m?.rating ?? '');
  hud.say(saved ? 'Picked up where you left off.' : 'Tap a cell, then a digit. Tap the selected cell again to switch to maybes.');
  layout();
  sync();
  persist(true);
}

// ---------- saving ----------
// On claude.ai the game saves through the live link (shared with Claude). Anywhere else (GitHub Pages,
// local dev) it saves to this browser's storage, so a reload picks up where you left off.
const LOCAL_SAVE = 'quickken.save';
let localTimer = 0;
function persist(immediate = false): void {
  if (link) return link.changed(immediate);
  clearTimeout(localTimer);
  localTimer = window.setTimeout(() => {
    try {
      const s = snapshot();
      if (s) localStorage.setItem(LOCAL_SAVE, JSON.stringify(s));
    } catch {
      // Storage full or blocked: this visit just isn't remembered.
    }
  }, immediate ? 0 : 700);
}
function loadLocal(): GameSnapshot | null {
  try {
    const s = JSON.parse(localStorage.getItem(LOCAL_SAVE) ?? 'null') as GameSnapshot | null;
    return s?.v === 1 && s.puzzle ? s : null;
  } catch {
    return null;
  }
}

// ---------- live link with Claude (published Artifact only) ----------

let link: Link | null = null;

function snapshot(): GameSnapshot | null {
  if (!game) return null;
  return {
    v: 1,
    puzzle: game.puzzle,
    values: Array.from(game.values),
    notes: Array.from(game.notes),
    layers: Array.from(game.layers),
    layer: game.layer,
    selected: board.selected,
    notesMode,
    elapsedMs: Math.round((solvedAt ?? performance.now()) - startTime),
    solved: !!solvedAt,
    claudeSeq: link?.claudeSeq ?? 0,
    history: game.exportHistory(),
    view: boardText(game.n, game.puzzle.digits.labels, game.values, game.notes),
    updatedAt: new Date().toISOString(),
  };
}

/** Apply a message Claude wrote: moves first (with an orange flash so you can see them), then its note. */
/**
 * Swap in a revised definition of the puzzle being played (same size), keeping every digit, maybe,
 * guess and the undo history: the board is rebuilt around the same progress.
 */
function revisePuzzle(p: RemoteMessage['puzzle']): void {
  if (!game || !p || p.size !== game.n || !Array.isArray(p.cages)) return;
  const old = game;
  game = new Game(p);
  game.restore(old.values, old.notes, old.layers, old.layer);
  game.importHistory(old.exportHistory());
  applyOptions();
  hud.setMeta(p.meta?.rating ?? '');
  layout();
}

function applyRemote(msg: RemoteMessage): void {
  if (!game) return;
  if (msg.puzzle) revisePuzzle(msg.puzzle);
  const n = game.n;
  const okCell = (c: unknown): c is number => Number.isInteger(c) && (c as number) >= 0 && (c as number) < n * n;
  const okDigit = (d: unknown): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) < n;
  for (const m of msg.moves ?? []) {
    if (m.op === 'highlight') {
      board.hintCells = new Set(m.cells.filter(okCell));
      board.refresh();
      continue;
    }
    if (!okCell(m.cell)) continue;
    if (m.op === 'value' && okDigit(m.digit)) apply(game.setValue(m.cell, m.digit));
    else if (m.op === 'maybes') apply(game.copyNotes([m.cell], m.digits.filter(okDigit).reduce((s, d) => s | (1 << d), 0)));
    else if (m.op === 'erase') clearCell(m.cell);
    else if (m.op === 'select') {
      board.selected = m.cell;
      board.refresh();
      continue;
    } else continue;
    board.claudeFx(m.cell);
  }
  if (msg.say) hud.say(`Claude: ${msg.say}`, 'hint');
  sync();
}

function requestPuzzle(o: GenOptions): void {
  hud.say('Generating…');
  worker.onmessage = (e: MessageEvent<{ ok: true } & GenResult | { ok: false; error: string }>) => {
    if (e.data.ok) startGame(e.data);
    else hud.say(e.data.error, 'error');
  };
  worker.postMessage(o);
}

board.onCellTap = (c) => {
  board.selected = c;
  board.hintCells.clear();
  board.refresh();
  sync();
};
board.onCellReselect = () => handlers.toggleNotes();
// Long-press a × cage: its target's prime factorisation.
board.onCageHold = (ci) => {
  if (!game) return;
  const cage = game.puzzle.cages[ci];
  const t = cage.target;
  // A negative target: factor its size, keep the real (red) number in front, and say why.
  const f = cageFactors(t, game.puzzle.digits.values, cage.cells.length);
  hud.sayMath(String(t), f ? `= ${f}` : 'is prime', t < 0 ? { negative: true, note: "Can't accurately factor a negative number" } : {});
};

board.onConfirmCell = (c, d) => {
  if (!game || solvedAt) return;
  board.selected = c;
  board.disproven.delete(c);
  hud.say(`The rest of those lines can only be ${game.puzzle.digits.labels[d]}: filled it in.`);
  apply(game.setValue(c, d));
  sync();
};

// Drag from a cell: on release, copies its maybes into the dragged cells, or, when the drag covers
// a whole row/column, fills maybes in that line. Either way it's one undo step.
const buzz = (ms: number) => {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // Vibration is optional (blocked in some frames and browsers).
  }
};
const plural = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`;
board.onDragStart = (c) => {
  if (!game || solvedAt) return null;
  buzz(12);
  return { blueprint: game.values[c] === EMPTY && game.notes[c] !== 0 };
};
board.onDragDrop = ({ source, path, mode, lines, pair }) => {
  const none = { painted: [], skipped: [] };
  if (!game || mode === 'none') return none;
  let painted: number[];
  let skipped: number[] = [];
  if (mode === 'pair' && pair) {
    // Naked pair/triple: these k digits must sit in these k cells, so nothing else in the line has them.
    const r = game.eliminateNotes(pair.targets, pair.mask);
    painted = r.changed.filter((c) => pair.targets.includes(c));
    const digits = maskIndices(pair.mask).map((d) => game!.puzzle.digits.labels[d]).join(', ');
    const where = `${pair.line.kind} ${pair.line.index + 1}`;
    const group = ['', '', 'Pair', 'Triple', 'Quad'][path.length] ?? `Group of ${path.length}`;
    const chain = r.waves.length - 1;
    hud.say(
      painted.length
        ? `${group} {${digits}} in ${where}: removed from ${plural(painted.length, 'cell')}.${chain > 1 ? ` That set off a chain ×${chain}!` : chain ? ' That filled in a cell!' : ''}`
        : `${group} {${digits}}: nothing else in ${where} has those maybes.`,
    );
    if (painted.length) buzz(18);
    sync();
    return { painted, skipped, action: r };
  }
  if (mode === 'line') {
    // Fill the empty cells (maybes already entered are kept), then apply any pairs/triples in the line.
    const { first, result, filled, groups } = game.fillLines(lines.map((l) => l.cells));
    const names = lines.map((l) => `${l.kind} ${l.index + 1}`).join(' and ');
    const label = (m: number) => '{' + maskIndices(m).map((d) => game!.puzzle.digits.labels[d]).join(', ') + '}';
    const found = groups.map((gr) => `${['', '', 'pair', 'triple', 'quad'][gr.cells.length]} ${label(gr.mask)}`);
    const chain = first.waves.length - 1 + result.waves.length - 1;
    hud.say(
      (filled.length ? `Filled maybes in ${names}.` : `${names[0].toUpperCase()}${names.slice(1)} already had maybes.`) +
        (found.length ? ` Found ${found.join(', ')} and cleared ${found.length > 1 ? 'their' : 'its'} digits from the rest of the line.` : '') +
        (chain > 1 ? ` Chain ×${chain}!` : chain ? ' That filled in a cell!' : ''),
    );
    if (filled.length || groups.length) buzz(18);
    sync();
    return { painted: filled, skipped: [], groups, first, action: result };
  } else {
    // Paste adds the copied maybes to each cell; a cell that already has them all is overwritten with
    // exactly the copied set. Numbers are left alone.
    const targets = path.slice(1);
    // The cursor follows the paste to the last cell dragged into.
    board.selected = path[path.length - 1];
    painted = game.pasteNotes(targets, game.notes[source]).changed;
    skipped = targets.filter((c) => game!.values[c] !== EMPTY);
    hud.say(painted.length ? `Copied maybes to ${plural(painted.length, 'cell')}. Undo reverts the whole drag.` : 'Those cells already have exactly these maybes (or numbers).');
    // If the paste made a naked group (k cells in one row or column holding the same k maybes, like
    // {1,2} copied across a 3+), apply it to the rest of that line as well.
    const pairAfter = painted.length ? pasteGroup(source, painted) : undefined;
    if (painted.length) buzz(18);
    sync();
    return { painted, skipped, pairAfter };
  }
  if (painted.length) buzz(18);
  sync();
  return { painted, skipped };
};

function pasteGroup(source: number, painted: number[]): DragResult['pairAfter'] {
  if (!game) return undefined;
  const g = game;
  const n = g.n;
  const group = [source, ...painted];
  const mask = g.notes[source];
  // A naked group needs every cell holding exactly the same k maybes.
  if (maskIndices(mask).length !== group.length || group.some((c) => g.notes[c] !== mask)) return undefined;
  const row = group.every((c) => Math.floor(c / n) === Math.floor(source / n));
  const col = group.every((c) => c % n === source % n);
  if (!row && !col) return undefined;
  const line = Array.from({ length: n }, (_, i) => (row ? Math.floor(source / n) * n + i : i * n + (source % n)));
  const others = line.filter((c) => !group.includes(c) && g.values[c] === EMPTY && g.notes[c] & mask);
  // The pair effect plays even when there's nothing to clear.
  const action: ActionResult = others.length ? g.eliminateNotes(others, mask) : { waves: [[]], eliminated: [], changed: [] };
  const digits = maskIndices(mask).map((d) => g.puzzle.digits.labels[d]).join(', ');
  const where = `${row ? 'row' : 'column'} ${(row ? Math.floor(source / n) : source % n) + 1}`;
  const kind = ['', '', 'pair', 'triple', 'quad'][group.length] ?? 'group';
  hud.say(others.length ? `Copied, and that makes {${digits}} a ${kind} in ${where}: removed from ${plural(others.length, 'other cell')}.` : `Copied, and that makes {${digits}} a ${kind} in ${where}.`);
  return { cells: group, action, painted: action.changed.filter((c) => others.includes(c)) };
}

window.addEventListener('keydown', (e) => {
  if (!game || document.querySelector('dialog[open]')) return;
  const n = game.n;
  const s = board.selected;
  const move = (dr: number, dc: number) => board.onCellTap!(((Math.floor(s / n) + dr + n) % n) * n + ((s % n) + dc + n) % n);
  // Letters compare lower-cased so Caps Lock (and Shift) don't break shortcuts.
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // Plain letter shortcuts never fire with Ctrl/Cmd/Alt held (so Ctrl+C still copies).
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
  const letterDigit = plain ? digitLetters(n).indexOf(key) : -1;
  if (key === 'ArrowUp') move(-1, 0);
  else if (key === 'ArrowDown') move(1, 0);
  else if (key === 'ArrowLeft') move(0, -1);
  else if (key === 'ArrowRight') move(0, 1);
  else if (key === 'Backspace' || key === 'Delete' || key === 'Escape' || (plain && key === 'c')) clearCell(s);
  else if ((key === 'y' && (e.ctrlKey || e.metaKey)) || (key === 'z' && (e.ctrlKey || e.metaKey) && e.shiftKey)) handlers.redo();
  else if ((key === 'z' && (e.ctrlKey || e.metaKey)) || (plain && key === 'u')) handlers.undo();
  else if (plain && key === 'n') {
    notesMode = !notesMode;
    sync();
  } else if (plain && key === 'g') handlers.guess();
  else if (plain && key === 'h') handlers.hint();
  // Q W E / A S D enter digits like the pad's layout; Shift makes it a maybe, as with number keys.
  else if (letterDigit >= 0) digitAction(s, letterDigit, notesMode !== e.shiftKey);
  else if (/^[0-9]$/.test(e.code.replace('Digit', '').replace('Numpad', '')) || e.code === 'Backquote') {
    // When every digit is a single numeral (1–6, 0–5, …) a key means that number, and ` (~) is also 0,
    // so a 0-based set doesn't put 0 on the 1 key. Other sets (primes, tens, …) go by position: 1 is
    // the first digit, 0 the tenth.
    const k = e.code === 'Backquote' ? 0 : Number(e.code.replace('Digit', '').replace('Numpad', ''));
    const labels = game.puzzle.digits.labels;
    const d = labels.every((l) => /^[0-9]$/.test(l)) ? labels.indexOf(String(k)) : e.code === 'Backquote' ? -1 : k === 0 ? 9 : k - 1;
    if (d < 0 || d >= n) return;
    digitAction(s, d, notesMode !== e.shiftKey);
  } else return;
  e.preventDefault();
});

app.renderer.on('resize', layout);
// The HUD changes the stage's height after init (and on rotation), so watch the element itself.
new ResizeObserver(() => app.resize()).observe(stageEl);

// Mouse side buttons (4 = back, 5 = forward) do nothing here: they don't tap the board or pad, and
// don't navigate away from the game. Caught first (capture on window) so nothing else sees them.
for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick'] as const) {
  window.addEventListener(type, (e) => {
    if (e.button === 3 || e.button === 4) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, { capture: true });
}

// ---------- error reporting ----------
// Errors show in the message pane (tap to copy) so they can be pasted back to Claude. Each distinct
// message is reported once.
const reported = new Set<string>();
function report(what: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (reported.has(what + msg)) return;
  reported.add(what + msg);
  const gl = (app.renderer as { gl?: WebGL2RenderingContext }).gl;
  const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
  const gpu = gl && dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown GPU';
  const text = [
    `${what}: ${msg}`,
    err instanceof Error && err.stack ? err.stack.split('\n').slice(0, 8).join('\n') : '',
    `GPU: ${gpu}; frag uniforms: ${gl?.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) ?? '?'}`,
    navigator.userAgent,
  ].filter(Boolean).join('\n');
  console.error(text);
  hud.reportBug(text);
}
// While the page is going away (reload, a new version), lost contexts and aborted requests are expected.
let unloading = false;
window.addEventListener('pagehide', () => (unloading = true));
window.addEventListener('beforeunload', () => (unloading = true));
window.addEventListener('error', (e) => !unloading && report('Error', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => !unloading && report('Unhandled promise', e.reason));
// Pixi stops scheduling frames after any throw in a frame, which freezes the board on a stale image.
// Report it and keep going instead.
const tickerUpdate = app.ticker.update.bind(app.ticker);
app.ticker.update = (time?: number) => {
  try {
    tickerUpdate(time);
  } catch (e) {
    report('Frame error', e);
  }
};
// A phone GPU can drop the WebGL context (e.g. a shader ran too long). Nothing draws after that, so
// note why and reload; the game itself is saved.
app.canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  if (unloading) return;
  try {
    sessionStorage.setItem('kenken.lastError', 'Graphics context lost (the GPU reset), so the page reloaded.');
  } catch {
    // Not remembered; the reload still recovers the board.
  }
  setTimeout(() => location.reload(), 300);
});
try {
  const last = sessionStorage.getItem('kenken.lastError');
  if (last) {
    sessionStorage.removeItem('kenken.lastError');
    // Just a note (not a bug report): the board recovered.
    setTimeout(() => hud.say(last, 'hint'), 1500);
  }
} catch {
  // Storage blocked: nothing to show.
}

app.ticker.add((tk) => {
  // Slow motion scales effect time only; the puzzle timer below keeps real time.
  const ms = tk.deltaMS * options.timeScale;
  const dt = Math.min(0.05, ms / 1000);
  tweens.tick(ms);
  particles.update(dt);
  bg.update(dt);
  board.update(dt);
  if (game && !solvedAt) hud.setTime((performance.now() - startTime) / 1000);
});

let fpsTimer = 0;
app.ticker.add((tk) => {
  fpsTimer += tk.deltaMS;
  if (fpsTimer > 500) {
    fpsTimer = 0;
    hud.fpsEl.textContent = `${Math.round(app.ticker.FPS)} fps · ${particles.count} particles`;
  }
});

bg.resize(app.screen.width, app.screen.height);
// Boot: resume the saved game when the published page has a database, else start a fresh puzzle.
hud.say('Loading…');
void (async () => {
  link = await Link.connect(snapshot);
  const saved = link ? await link.loadSaved() : loadLocal();
  // Saving in this browser: ask it to keep the site's storage even when space runs low (it may say no;
  // the save still works, it just isn't protected from cleanup).
  if (!link) void navigator.storage?.persist?.().catch(() => false);
  if (saved) startGame({ puzzle: saved.puzzle, attempts: 0 }, saved);
  else requestPuzzle({ size: 6, digits: DIGIT_PRESETS.standard(6), seed: Math.random().toString(36).slice(2) });
  hud.setLinked(!!link);
  link?.listen(applyRemote);
})();

// Console debugging handle.
Object.assign(window, { kenken: { get game() { return game; }, app, board, particles, applyRemote, snapshot } });
