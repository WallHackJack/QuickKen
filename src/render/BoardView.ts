// The board. Each cage is one Container (pivot at its centroid) that owns its background, outline,
// label and its cells' digits/maybes — so a whole cage can scale, glow or take a filter as a unit
// while its children stay on grid coordinates.

import { BitmapText, Container, Graphics, Rectangle, Sprite, Text, Texture, type FederatedPointerEvent } from 'pixi.js';
import { has, popcount } from '../engine/bits';
import { cageLabel } from '../engine/puzzle';
import { EMPTY, type ActionResult, type Game, type LineGroup } from '../game/Game';
import type { Background } from './Background';
import { cageLoops, insetLoop } from './cageShape';
import type { Lighting } from './Lighting';
import type { Particles } from './Particles';
import { ease, type Tweens } from './Tweens';

/** Ink for normal entries, then for guesses: one guess colour (violet), whatever the guess depth. */
export const GUESS_COLOR = 0xffd23f;
export const LAYER_COLORS = [0xeaf2ff, GUESS_COLOR];
const layerColor = (l: number) => LAYER_COLORS[Math.min(l, LAYER_COLORS.length - 1)];
const WAVE_COLORS = [[0xffffff, 0x9fe8ff], [0x4fd8ff, 0x9fffe0], [0x8cff6b, 0xfff36b], [0xffc94f, 0xff8a3d], [0xff5cc8, 0xff3d6e], [0xb18cff, 0xffffff]];
const FONT = 'Segoe UI, Roboto, Helvetica Neue, system-ui, sans-serif';
// How long a ruled-out maybe takes to shrink away during a chain (it may overlap the next wave).
const NOTE_FADE_MS = 120;
// Chain pacing: the first auto-fill lands almost right after the player's move, later waves follow
// WAVE_GAP_MS apart (times the speed setting).
const FIRST_WAVE_MS = 40;
/** A pair's inward rings land on its outline at this point; that's when its maybe removals hit. */
const PAIR_IMPACT_MS = 190;
const WAVE_GAP_MS = 170;
// Undo mid-chain: gap between rewinding digits, newest first.
const REWIND_STEP_MS = 40;
const REWIND = 0x9fb0ff;
/** Undo's rewind: red, quicker and less triumphant than the forward chain. */
const UNDO_RED = 0xff5a6e;
const UNDO_STEP_MS = 28;

/** A chain animation in progress, so undo can stop it. */
interface PlayingChain {
  r: ActionResult;
  /** Index of the last wave already shown (-1 before the first). */
  played: number;
  cancelled: boolean;
}
// Mode colours: maybe mode is orange (matches --maybe in style.css), normal entry is ice white.
// Red stays for mistakes, green for right, yellow for guesses, cyan for drag selections.
const MAYBE = 0xff9f3d;
const MAYBE_LIGHT = 0xffd9b0;

/** Columns in the maybe grid inside a cell; the digit pad uses the same layout. */
export const noteColumns = (digits: number): number => (digits <= 4 ? 2 : digits <= 9 ? 3 : 4);

// Line-fill mint (a drag that covers a whole row or column).
const LINE = 0x7dffcf;
// Drag selections (outline, glow, pill): cyan.
const NEUTRAL = 0x5fe3ff;
/** Width of a drag selection's outline. */
const SEL_W = (cs: number) => Math.max(2, cs * 0.045);
// Pair gold (k cells in one line sharing the same k maybes).
const PAIR = 0xffd36b;
// Moves Claude makes over the live link.
const CLAUDE = 0xff9f5a;
const CLAUDE_LIGHT = 0xffd9b8;
// Hidden cages: leftover cells of a band whose sum follows from the + cages selected in it (magenta).
const HIDDEN = 0xff6fd8;
/** A leftover that pins a single cell's digit (released, it's entered). */
const CONFIRM = 0x8cff6b;
/** The selected cell's cage ring: ice white in normal mode (it turns maybe-orange in maybe mode). */
const SELECT_RING = 0xeaf2ff;
// Errors: clashes, wrong cages, chains broken by a mistake.
const ERROR = 0xff4d6d;
/** Chain labels on the board at once; more retire the oldest. */
const COMBO_POOL = 5;

/** Cells that must add up to `target`, found from a selection of whole + cages. */
export interface HiddenCage {
  cells: number[];
  target: number;
  /** How the cells combine to the target: added (+) or multiplied (×). */
  op?: '+' | '×';
}

/**
 * What a released drag does:
 * - 'line': it covered a whole row/column → fill maybes in that line's empty cells.
 * - 'pair': k cells in one row/column whose maybes use exactly k digits → remove those digits from the
 *   rest of that line (a naked pair/triple).
 * - 'copy': the start cell has maybes → paste them into every dragged cell.
 * - 'none': nothing to do.
 */
export type DragMode = 'copy' | 'line' | 'pair' | 'none';
export interface DragLine {
  kind: 'row' | 'column';
  index: number;
  cells: number[];
}
export interface DragPair {
  mask: number;
  line: DragLine;
  /** The line's other cells. */
  targets: number[];
}
export interface DragDrop {
  source: number;
  /** Cells in the order they were entered, starting with the source. */
  path: number[];
  mode: DragMode;
  lines: DragLine[];
  pair?: DragPair;
}
export interface DragResult {
  painted: number[];
  /** Filled cells the drag passed over and left alone. */
  skipped: number[];
  /** Set when the drop changed the board in a way that can chain (pair eliminations). */
  action?: ActionResult;
  /** Line sweeps: the pairs/triples found in the line afterwards, in the order they were applied. */
  groups?: LineGroup[];
  /** Line sweeps: the chain from cells the fill left with one maybe (plays before any group). */
  first?: ActionResult;
  /** Copy-paste that formed a naked group: its cells, the elimination it caused, the cells it hit. */
  pairAfter?: { cells: number[]; action: ActionResult; painted: number[] };
}

interface DragState {
  source: number;
  /** The press started on the cell that was already selected. */
  reselect: boolean;
  lastCell: number;
  lastPos: { x: number; y: number };
  path: number[];
  active: boolean;
  /** The source cell has maybes to copy. */
  blueprint: boolean;
  /** The drag would copy right now (blueprint, and still inside one row, column or cage). */
  copying: boolean;
  /** Seconds since the drag started (drives the source cell's breathing outline). */
  time: number;
  /** A long-press finished on this press: release does nothing else. */
  held?: boolean;
  /** Growing a locked selection: how many cells it had when this drag started. */
  growFrom?: number;
  /** Where the finger last settled, and how long (ms) it has stayed there. */
  anchor?: { x: number; y: number };
  stillMs?: number;
  /** The selection stays on screen after release (no drop action). */
  locked?: boolean;
  /** Locked by holding still (its flash has played). */
  heldLock?: boolean;
}


// One cage palette for now; `glow` lerps towards the bright pair during completion flashes,
// and maybe mode shifts fill/edge towards violet.
// Cage walls are map styling: the same in both modes (only the selected cage's ring shows the mode).
const CAGE = { fill: 0x141a3c, fillGlow: 0x2d3f8f, edge: 0xa98cff, edgeGlow: 0xe6ecff, inner: 0xffffff };
/** Label ink of a completed cage (its digits get a lighter green lean). */
const COMPLETE_INK = 0xc8ffb8;

/**
 * Dashes around a square (top-left at `at`, `side` long), about 80% dash. Each side starts and ends
 * on a dash running into the corner (stretched by half the line width), so corners are solid. Caller
 * strokes it with flat caps.
 */
function dashedSquare(g: Graphics, at: number, side: number, unit: number, width: number): void {
  const count = Math.max(1, Math.round(side / unit));
  // count dashes and count-1 gaps, gap = a quarter dash.
  const dash = side / (count + (count - 1) / 4), gap = dash / 4;
  const corners: [number, number, number, number][] = [[at, at, 1, 0], [at + side, at, 0, 1], [at + side, at + side, -1, 0], [at, at + side, 0, -1]];
  for (const [x, y, dx, dy] of corners) {
    for (let i = 0; i < count; i++) {
      const t0 = i * (dash + gap) - (i === 0 ? width / 2 : 0);
      const t1 = i * (dash + gap) + dash + (i === count - 1 ? width / 2 : 0);
      g.moveTo(x + dx * t0, y + dy * t0).lineTo(x + dx * t1, y + dy * t1);
    }
  }
}

function mix(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t) << s;
  return ch(16) | ch(8) | ch(0);
}

/**
 * A soft white glow in the shape of `label` (a blurred copy of the digit, no solid glyph), drawn once
 * per label/size/weight and shared. Sprites using it sit under the real text.
 */
const glowCache = new Map<string, Texture>();

/** A slight dark bevel under a digit: a soft shadow just below and to the right, scaled to its size. */
function digitBevel(size: number) {
  return { color: 0x000000, alpha: 0.55, blur: Math.max(1, size * 0.04), distance: Math.max(1, size * 0.045), angle: Math.PI / 3 };
}
/** The last move's glows are a pale cyan, so a white digit still stands out from its own halo. */
const GLOW_TINT = 0x8fd8ff;
function glowTexture(label: string, size: number, weight: string): Texture {
  const key = `${label}|${Math.round(size)}|${weight}`;
  const hit = glowCache.get(key);
  if (hit) return hit;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const blur = size * 0.28;
  const pad = Math.ceil(blur * 2.5);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = `${weight} ${size}px ${FONT}`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(label).width) + pad * 2, h = Math.ceil(size * 1.3) + pad * 2;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.font = font;
  ctx.textAlign = 'center';
  // Centre the line box (ascent + descent) the way Pixi centres a Text, so the glow sits exactly under it.
  const m = ctx.measureText(label);
  const asc = m.fontBoundingBoxAscent || size * 0.8, desc = m.fontBoundingBoxDescent || size * 0.25;
  const baseline = h / 2 - (asc + desc) / 2 + asc;
  // Draw the glyph far off-canvas and keep only its shadow: a pure blur of the digit's shape.
  ctx.shadowColor = 'rgba(255, 255, 255, 0.95)';
  ctx.shadowBlur = blur * dpr;
  ctx.shadowOffsetX = 10000 * dpr;
  ctx.fillStyle = '#fff';
  for (let k = 0; k < 2; k++) ctx.fillText(label, w / 2 - 10000, baseline);
  const tex = Texture.from(canvas);
  glowCache.set(key, tex);
  return tex;
}

class CellView extends Container {
  highlight = new Graphics();
  /** Blurred copies of the digit and each maybe under them: part of the last move (what undo would change). */
  valueGlow = new Sprite();
  noteGlows: Sprite[] = [];
  private valueSize = 0;
  /** Transient effect layer (drag-paste flashes); refresh() never touches it. */
  flash = new Graphics();
  value: Text;
  notes: BitmapText[] = [];
  cross: Text;
  /** A small red X over one maybe (the digit an undone guess tried, when the cell went back to maybes). */
  noteCross: Text;

  constructor(readonly cell: number, cs: number, labels: string[]) {
    super();
    this.addChild(this.highlight, this.flash);
    const cols = noteColumns(labels.length);
    const rows = Math.ceil(labels.length / cols);
    const longest = Math.max(...labels.map((l) => l.length));
    // Maybes sit below the cage label's band (top ~30% of the cell).
    const area = { x: 0.04, y: 0.29, w: 0.92, h: 0.69 };
    const noteSize = Math.min(area.w / cols, area.h / rows) * cs * (longest > 2 ? 0.62 : longest > 1 ? 0.74 : 0.9);
    labels.forEach((label, d) => {
      const t = new BitmapText({ text: label, style: { fontFamily: FONT, fontSize: Math.max(8, noteSize), fill: 0xffffff, fontWeight: '600', dropShadow: digitBevel(noteSize) } });
      t.anchor.set(0.5);
      const gx = d % cols, gy = Math.floor(d / cols);
      t.position.set(cs * (area.x + (area.w * (gx + 0.5)) / cols), cs * (area.y + (area.h * (gy + 0.5)) / rows));
      t.visible = false;
      const glow = new Sprite(glowTexture(label, Math.max(8, noteSize), '600'));
      glow.anchor.set(0.5);
      glow.tint = GLOW_TINT;
      glow.scale.set(1 / Math.min(window.devicePixelRatio || 1, 2));
      glow.position.copyFrom(t.position);
      glow.visible = false;
      this.noteGlows.push(glow);
      this.notes.push(t);
      this.addChild(glow, t);
    });
    const valueSize = cs * (longest > 2 ? 0.36 : longest > 1 ? 0.46 : 0.56);
    this.value = new Text({ text: '', style: { fontFamily: FONT, fontSize: valueSize, fill: 0xffffff, fontWeight: '700', dropShadow: digitBevel(valueSize) } });
    this.value.anchor.set(0.5);
    this.value.position.set(cs / 2, cs * 0.6);
    this.valueSize = valueSize;
    this.valueGlow.anchor.set(0.5);
    this.valueGlow.tint = GLOW_TINT;
    this.valueGlow.scale.set(1 / Math.min(window.devicePixelRatio || 1, 2));
    this.valueGlow.position.copyFrom(this.value.position);
    this.valueGlow.visible = false;
    this.addChild(this.valueGlow, this.value);
    // Shown when the cage around this cell can no longer be completed (see BoardView.refresh).
    this.cross = new Text({ text: '✕', style: { fontFamily: FONT, fontSize: cs * 0.5, fill: 0xff4d6d, fontWeight: '700' } });
    this.cross.anchor.set(0.5);
    this.cross.position.set(cs / 2, cs * 0.58);
    this.cross.alpha = 0.9;
    this.cross.visible = false;
    this.addChild(this.cross);
    this.noteCross = new Text({ text: '✕', style: { fontFamily: FONT, fontSize: Math.max(9, cs * 0.24), fill: 0xff4d6d, fontWeight: '800' } });
    this.noteCross.anchor.set(0.5);
    this.noteCross.visible = false;
    this.addChild(this.noteCross);
  }

  /** Glow the digit (if `on`) under its text. */
  glowValue(label: string, on: boolean): void {
    this.valueGlow.visible = on && !!label;
    this.valueGlow.alpha = 0.6;
    if (this.valueGlow.visible) this.valueGlow.texture = glowTexture(label, this.valueSize, '700');
  }
}

export class CageView extends Container {
  fill = new Graphics();
  outline = new Graphics();
  /** Thin lines between this cage's own cells. */
  inner = new Graphics();
  labelText: Text;
  /** What the cage's digits actually come to, top-right of its bottom-right cell while it is wrong. */
  resultText: Text;
  /** Full and wrong (red outline, darker fill, red label) or full and right (subtle green border). */
  /** 'guessed': complete and right, but some digit in it is from an open guess (yellow, not green). */
  state: 'open' | 'ok' | 'guessed' | 'wrong' = 'open';
  /** Resting colours: × and ÷ cages sit cooler than + and − ones so they read apart, in maybe mode too. */
  private readonly base: { fill: number; edge: number };
  readonly center: { x: number; y: number };
  readonly loops: [number, number][][];
  private readonly stroke: number;

  constructor(readonly index: number, readonly game: Game, readonly cs: number) {
    super();
    const cage = game.puzzle.cages[index];
    const n = game.n;
    this.loops = cageLoops(cage.cells, n);
    this.stroke = Math.max(1.5, cs * 0.03);
    this.base = cage.op === 'mul' || cage.op === 'div'
      ? { fill: 0x18163e, edge: 0xdc8ce0 }
      : { fill: CAGE.fill, edge: CAGE.edge };
    const cx = cage.cells.reduce((s, c) => s + (c % n) + 0.5, 0) / cage.cells.length;
    const cy = cage.cells.reduce((s, c) => s + Math.floor(c / n) + 0.5, 0) / cage.cells.length;
    this.center = { x: cx * cs, y: cy * cs };
    // Pivot at the centroid so transforms happen around the cage itself; children use board coordinates.
    this.pivot.set(this.center.x, this.center.y);
    this.position.set(this.center.x, this.center.y);

    const set = new Set(cage.cells);
    for (const c of cage.cells) {
      const x = (c % n) * cs, y = Math.floor(c / n) * cs;
      if (c % n < n - 1 && set.has(c + 1)) this.inner.moveTo(x + cs, y).lineTo(x + cs, y + cs);
      if (set.has(c + n)) this.inner.moveTo(x, y + cs).lineTo(x + cs, y + cs);
    }
    this.inner.stroke({ width: 1, color: CAGE.inner, alpha: 0.1 });

    this.addChild(this.fill, this.inner, this.outline);
    this.drawShape(0);
    const first = cage.cells[0];
    this.labelText = new Text({ text: cageLabel(cage), style: { fontFamily: FONT, fontSize: Math.max(12, cs * 0.27), fill: 0xffffff, fontWeight: '700', dropShadow: digitBevel(cs * 0.27) } });
    this.labelText.position.set((first % n) * cs + cs * 0.07, Math.floor(first / n) * cs + cs * 0.02);
    // Top-right corner of the cage's bottom-most, then right-most cell, level with how the label sits.
    const last = cage.cells.reduce((a, b) => (Math.floor(b / n) > Math.floor(a / n) || (Math.floor(b / n) === Math.floor(a / n) && b % n > a % n) ? b : a));
    this.resultText = new Text({ text: '', style: { fontFamily: FONT, fontSize: Math.max(12, cs * 0.27), fill: 0xffffff, fontWeight: '700' } });
    this.resultText.tint = ERROR;
    this.resultText.anchor.set(1, 0);
    this.resultText.position.set((last % n + 1) * cs - cs * 0.07, Math.floor(last / n) * cs + cs * 0.02);
    this.resultText.visible = false;
  }

  /** Show the cage as open, complete, or wrong (with what it actually came to). */
  setState(state: 'open' | 'ok' | 'guessed' | 'wrong', result: number | null): void {
    const wrong = state === 'wrong';
    this.resultText.visible = wrong;
    if (wrong) this.resultText.text = result === null || Number.isNaN(result) ? '?' : `${+result.toFixed(3)}`;
    if (state === this.state) return;
    this.state = state;
    this.labelText.tint = wrong ? ERROR : state === 'ok' ? COMPLETE_INK : state === 'guessed' ? 0xfff0b0 : 0xffffff;
    this.drawShape(0);
  }

  /** glow 0..1 brightens the cage (used for completion flashes). */
  drawShape(glow: number): void {
    const cs = this.cs;
    this.fill.clear();
    this.outline.clear();
    const w = this.stroke;
    for (const loop of this.loops) {
      // Inset by half the stroke so neighbouring cages' outlines meet flush, with no gap.
      const pts = insetLoop(loop, w / 2 / cs).flatMap(([x, y]) => [x * cs, y * cs]);
      let fill = mix(this.base.fill, CAGE.fillGlow, glow);
      let edge = mix(this.base.edge, CAGE.edgeGlow, glow);
      if (this.state === 'wrong') {
        fill = mix(fill, 0x12040a, 0.6);
        edge = mix(ERROR, edge, glow);
      } else if (this.state === 'ok') {
        edge = mix(mix(edge, 0x8cff6b, 0.75), CAGE.edgeGlow, glow);
      } else if (this.state === 'guessed') {
        edge = mix(mix(edge, GUESS_COLOR, 0.8), CAGE.edgeGlow, glow);
      }
      this.fill.poly(pts, true).fill({ color: fill, alpha: 0.55 });
      this.outline.poly(pts, true).stroke({ width: w, color: edge, alpha: 0.95, join: 'miter' });
    }
  }
}

export class BoardView extends Container {
  cs = 0;
  cageViews: CageView[] = [];
  cellViews: CellView[] = [];
  selected = 0;
  hintCells = new Set<number>();
  /** Cells the Check button found wrong; cleared by the next move. */
  errorCells = new Set<number>();
  /** Multiplier on the pause between chain waves: 1 at 4× speed, 2 at 2×, 4 at 1×. */
  wavePace = 1;
  onCellTap?: (cell: number) => void;
  /** A tap (no drag) on the cell that was already selected. */
  onCellReselect?: (cell: number) => void;
  /** A press on `cell` is being dragged out of it. Return null to ignore the drag. */
  onDragStart?: (cell: number) => { blueprint: boolean } | null;
  /** The drag was released: apply it. Nothing changes on the board before this. */
  onDragDrop?: (drop: DragDrop) => DragResult;
  /** A locked selection was made, grown or cleared (sel null = cleared); prev is what it replaced. */
  onSelectionChange?: (sel: number[] | null, prev: number[] | null) => void;
  /** A long-press on a × cage finished (its cage popped). */
  onCageHold?: (cage: number) => void;
  /** A selection's leftover was one empty cell with a known digit: enter it (on release). */
  onConfirmCell?: (cell: number, digit: number) => void;
  private drag: DragState | null = null;
  /** Shared outline + tint over every cell the drag will affect. */
  private dragLayer = new Graphics();
  private sumPill: Container | null = null;
  /** The hidden cage the current drag implies (outlined, with total pills, while selected). */
  private ghost: HiddenCage | null = null;
  private ghostLabels: Container | null = null;
  /** Identity of the hidden cage whose pills are showing (so they only pop when it changes). */
  private ghostKey = '';
  /** Maybe-mode palette blend, eased towards maybeTarget each frame. */
  private maybeMix = 0;
  private maybeTarget = 0;
  private frame = new Graphics();
  /** Set by the app; effects add light sources to it. */
  lighting: Lighting | null = null;
  /** The running guess's first move (ringed in the guess colour). */
  guessOrigin: { cell: number; color: number } | null = null;
  /** First digits of earlier guesses still open (under the current one): a small inset square each. */
  olderGuessOrigins: number[] = [];
  /**
   * Cells where an undone guess started, with the digit it tried: shown in place, light red with a red
   * X (display only; the cell is empty). Clear or any entry in the cell removes it.
   */
  disproven = new Map<number, { label: string; digit: number }>();
  /** Tint maybes red that a number in their row or column already rules out (an option). */
  markBadNotes = true;
  /** Live chain labels on the board (at most COMBO_POOL): which cell each sits on, which chain it's from, and a fade-out factor. */
  private combos: { t: Text; cell: number; r: ActionResult; k: number }[] = [];
  private chain: PlayingChain | null = null;
  /** The hidden values / ghost maybes the playing chain last drew (see refresh). */
  private playView: { hidden: Set<number>; ghost?: Map<number, number> } | null = null;
  private shakeAmount = 0;
  /** A long-press filling a × cage: a circle (clipped to the cage) growing from the finger. */
  private hold: { ci: number; layer: Container; circle: Graphics; x: number; y: number; reach: number; ms: number } | null = null;
  /** The selected cell's cage ring: one fading in, older ones fading out. Drawn over the cages. */
  private selLayer = new Graphics();
  private selRings: { ci: number; t: number; out: boolean }[] = [];
  private selCage = -1;
  /** The pill's operation when the player tapped it to switch (else it follows the start cell's cage). */
  private sumOp: '+' | '×' | null = null;
  /** The pill shows a real total (not ?). */
  private sumKnown = false;
  /** A pill being dragged (or tapped) in a locked selection. */
  private pillDrag: { pill: Container; main: boolean; dx: number; dy: number; start: { x: number; y: number }; at: { x: number; y: number }; moved: boolean } | null = null;
  /** Where the player put pills (by label key); otherwise they sit beside their cells. */
  private pillSpots = new Map<string, { x: number; y: number }>();
  /** A drag selection kept after release (it had a total or leftover): stays drawn until the next tap on the board. */
  private lockedSel: { path: number[] } | null = null;
  /** The shrinking hold-to-lock ring around the finger, and the pill's dashed reach line. */
  private dragHold = new Graphics();
  /** Glow along the drag outline: 0..1 base level, plus a flash when the selection locks. */
  private dragGlow = { level: 0, flash: 0 };
  /** Selected-cage effects fade out while a drag is being made (or a locked selection shows). */
  private selFade = 1;
  /** The selected cage's light: flashes, then stays on faintly until the selection moves on. */
  private selLight: { born: number; gone: number } | null = null;
  /** Whole-board scale for the finish bump (around the board's centre). */
  private bump = 1;
  private home = { x: 0, y: 0 };
  /** Pinch zoom (1 = fitted) and the pan that keeps the pinched spot under the fingers. */
  private zoom = 1;
  private pan = { x: 0, y: 0 };
  /** A two-finger pinch in progress: where it started. Board input is off meanwhile. */
  private pinch: { d0: number; zoom0: number; local: { x: number; y: number } } | null = null;
  private game!: Game;

  constructor(private tweens: Tweens, private particles: Particles, private bg: Background) {
    super();
    this.eventMode = 'static';
    this.on('pointerdown', (e: FederatedPointerEvent) => {
      if (this.pinch) return;
      const p = e.getLocalPosition(this);
      const cell = this.cellAt(p.x, p.y);
      if (this.lockedSel) {
        // From inside the selection: drag to grow it. Anywhere else: the tap clears it.
        if (cell >= 0 && this.lockedSel.path.includes(cell)) {
          const path = [...this.lockedSel.path];
          this.drag = { source: path[0], reselect: false, lastCell: cell, lastPos: p, path, active: true, blueprint: false, copying: false, time: 0, locked: true, growFrom: path.length };
          return;
        }
        this.clearLocked(true);
        return;
      }
      if (cell < 0) return;
      const reselect = cell === this.selected;
      this.onCellTap?.(cell);
      this.startHold(cell, p.x, p.y);
      this.drag = { source: cell, reselect, lastCell: cell, lastPos: p, path: [cell], active: false, blueprint: false, copying: false, time: 0 };
    });
    this.on('globalpointermove', (e: FederatedPointerEvent) => {
      const pd = this.pillDrag;
      if (pd) {
        const q = e.getLocalPosition(this);
        if (Math.hypot(q.x - pd.start.x, q.y - pd.start.y) > this.cs * 0.1) pd.moved = true;
        // Leftover pills follow the finger; from the main pill a dashed line reaches for a cell to add.
        pd.at = { x: q.x, y: q.y };
        if (!pd.main) pd.pill.position.set(q.x + pd.dx, q.y + pd.dy);
        else this.drawReach(pd);
        return;
      }
      const d = this.drag;
      if (!d) return;
      const p = e.getLocalPosition(this);
      // Walk the segment in quarter-cell steps so a fast swipe can't skip cells.
      const steps = Math.max(1, Math.ceil(Math.hypot(p.x - d.lastPos.x, p.y - d.lastPos.y) / (this.cs / 4)));
      for (let i = 1; i <= steps && this.drag; i++) {
        this.dragOver(d.lastPos.x + ((p.x - d.lastPos.x) * i) / steps, d.lastPos.y + ((p.y - d.lastPos.y) * i) / steps);
      }
      d.lastPos = p;
      // Moving (more than a nudge) restarts the hold-to-lock.
      if (d.anchor && Math.hypot(p.x - d.anchor.x, p.y - d.anchor.y) > this.cs * 0.12) {
        d.anchor = { x: p.x, y: p.y };
        d.stillMs = 0;
      }
    });
    const end = () => (this.pillDrag ? this.endPillDrag() : this.endDrag());
    this.on('pointerup', end);
    this.on('pointerupoutside', end);
    this.on('pointercancel', end);
  }

  private cellAt(x: number, y: number): number {
    const n = this.game?.n ?? 0;
    const c = Math.floor(x / this.cs), r = Math.floor(y / this.cs);
    // Holes (cells that aren't part of the board) can't be touched.
    return r < 0 || c < 0 || r >= n || c >= n || this.game.topo.cageOf[r * n + c] < 0 ? -1 : r * n + c;
  }

  // ---------- maybe drag (copy / line fill) ----------

  private dragOver(x: number, y: number): void {
    const d = this.drag!;
    const cell = this.cellAt(x, y);
    if (cell < 0 || cell === d.lastCell) return;
    d.lastCell = cell;
    if (!d.active) {
      const start = this.onDragStart?.(d.source) ?? null;
      if (!start) {
        this.drag = null;
        return;
      }
      d.active = true;
      // Dragging away is not a long-press.
      this.cancelHold();
      this.startDragGlow();
      d.anchor = { ...d.lastPos };
      d.stillMs = 0;
      this.sumOp = null;
      this.pillSpots.clear();
      d.blueprint = start.blueprint;
      if (d.blueprint) this.blueprintStart(d.source);
      this.refresh();
    }
    if (!d.path.includes(cell)) {
      d.path.push(cell);
      this.drawDragPreview();
    }
  }

  /** Rows and columns the drag has fully covered. */
  private fullLines(path: number[]): DragLine[] {
    const n = this.game.n;
    const set = new Set(path);
    const lines: DragLine[] = [];
    for (let i = 0; i < n; i++) {
      const row = Array.from({ length: n }, (_, j) => i * n + j);
      const col = Array.from({ length: n }, (_, j) => j * n + i);
      if (row.every((c) => set.has(c))) lines.push({ kind: 'row', index: i, cells: row });
      if (col.every((c) => set.has(c))) lines.push({ kind: 'column', index: i, cells: col });
    }
    return lines;
  }

  /**
   * k dragged cells in one row/column whose maybes together use exactly k digits (e.g. [12] [124]
   * [124]): those digits must fill these cells, so the rest of the line can't have them.
   */
  private findPair(path: number[]): DragPair | undefined {
    const g = this.game;
    const n = g.n;
    if (path.length < 2) return;
    // Every cell of a group needs 2+ maybes: a cell down to one is already decided, not part of a pair.
    if (!path.every((c) => g.values[c] === EMPTY && popcount(g.notes[c]) >= 2)) return;
    const mask = path.reduce((m, c) => m | g.notes[c], 0);
    if (popcount(mask) !== path.length) return;
    const r0 = Math.floor(path[0] / n), c0 = path[0] % n;
    const sameRow = path.every((c) => Math.floor(c / n) === r0);
    const sameCol = path.every((c) => c % n === c0);
    if (!sameRow && !sameCol) return;
    const cells = Array.from({ length: n }, (_, j) => (sameRow ? r0 * n + j : j * n + c0));
    const line: DragLine = { kind: sameRow ? 'row' : 'column', index: sameRow ? r0 : c0, cells };
    return { mask, line, targets: cells.filter((c) => !path.includes(c)) };
  }

  private dragPlan(d: DragState): DragDrop {
    // Line fill only when the selection is exactly one row or column, nothing more.
    const lines = d.path.length === this.game.n ? this.fullLines(d.path) : [];
    const pair = lines.length ? undefined : this.findPair(d.path);
    // Copying maybes only makes sense inside one row, column or cage; a wider drag copies nothing.
    const n = this.game.n, cageOf = this.game.topo.cageOf, p0 = d.path[0];
    const oneUnit =
      d.path.every((c) => Math.floor(c / n) === Math.floor(p0 / n)) ||
      d.path.every((c) => c % n === p0 % n) ||
      d.path.every((c) => cageOf[c] === cageOf[p0]);
    const mode: DragMode = lines.length ? 'line' : pair ? 'pair' : d.blueprint && oneUnit ? 'copy' : 'none';
    return { source: d.source, path: d.path, mode, lines, pair };
  }

  /** One shared outline (and a light tint) around every cell the release will affect. */
  private drawDragPreview(): void {
    const g = this.dragLayer;
    g.clear();
    const d = this.drag;
    if (!d?.active || g.destroyed) return;
    if (d.growFrom !== undefined) return this.drawLocked(d.path);
    const plan = this.dragPlan(d);
    const region = d.path;
    // The sum pill and leftover first: a leftover that pins a cell's digit wins over a copy-paste.
    this.ghost = this.showRegionSum(region);
    const confirm = this.confirmDigit(this.ghost) >= 0;
    if (confirm && plan.mode === 'copy') plan.mode = 'none';
    // Only a live copy keeps the start cell breathing (it stops once the drag leaves the row/column/cage).
    if (d.copying !== (plan.mode === 'copy')) {
      d.copying = plan.mode === 'copy';
      if (!d.copying) this.cellViews[d.source]?.flash.clear();
      this.refresh();
    }
    const cs = this.cs;
    const color = plan.mode === 'line' ? LINE : plan.mode === 'pair' ? PAIR : plan.mode === 'copy' ? MAYBE : NEUTRAL;
    // The outline follows exactly the cells dragged over (free selection); the colour shows the mode.
    const n = this.game.n;
    if (plan.pair) {
      // Mark the cells in the line that will lose maybes.
      for (const c of plan.pair.targets) {
        if (this.game.values[c] === EMPTY && this.game.notes[c] & plan.pair.mask) g.rect((c % n) * cs, Math.floor(c / n) * cs, cs, cs).fill({ color, alpha: 0.1 });
      }
    }
    for (const c of region) g.rect((c % n) * cs, Math.floor(c / n) * cs, cs, cs).fill({ color, alpha: 0.13 });
    const w = SEL_W(cs);
    for (const loop of cageLoops(region, n)) {
      g.poly(insetLoop(loop, w / 2 / cs).flatMap(([x, y]) => [x * cs, y * cs]), true).stroke({ width: w, color, alpha: 0.95, join: 'miter' });
    }
    // The hidden cage those sums imply, outlined as boldly as the selection.
    // A leftover that pins one cell's digit is green: releasing enters it.
    if (this.ghost) this.drawHidden(g, this.ghost.cells, confirm ? CONFIRM : HIDDEN);
    this.setGhostLabels(this.ghost);
    this.refresh();
  }

  /**
   * The selection's addable cages, if it is two or more whole cages that all add up (+ cages and
   * single-cell clues), and the hidden cage they imply: the rows (or columns) the selection spans
   * have a known total, so the cells of those lines left out of the selection must add up to the
   * rest. The band with the fewest leftover cells wins; it must leave between 1 and n cells.
   */
  private sumSelection(region: number[]): { total: number; showTotal: boolean; hidden: HiddenCage | null; lines: number; lineSum: number; op: '+' | '×' } | null {
    const { cages } = this.game.puzzle;
    const { cageOf } = this.game.topo;
    const set = new Set(region);
    const ids = [...new Set(region.map((c) => cageOf[c]))];
    if (region.length < 2) return null;
    // A single whole cage's total would just repeat its own label, but the rest of its line is news.
    const showTotal = !(ids.length < 2 && cages[ids[0]].cells.every((c) => set.has(c)));
    // A drag that starts in a × cage multiplies everything; any other drag adds (tapping the pill switches).
    const product = this.sumSelectionOp(region) === '×';
    const op: '+' | '×' = product ? '×' : '+';
    const total = this.game.regionTotal(region, product ? 'product' : 'sum');
    if (total === null) return null;
    const n = this.game.n;
    const values = this.game.puzzle.digits.values;
    const lineSum = product ? values.reduce((a, b) => a * b, 1) : values.reduce((a, b) => a + b, 0);
    // The leftover follows the selection's shape: a wide selection completes its rows, a tall one its
    // columns; a square one takes whichever leaves fewer cells.
    const rows = new Set(region.map((c) => Math.floor(c / n))).size, cols = new Set(region.map((c) => c % n)).size;
    const options = cols > rows ? [true] : rows > cols ? [false] : [true, false];
    let hidden: HiddenCage | null = null;
    let lineCount = 0;
    for (const byRow of options) {
      const lines = [...new Set(region.map((c) => (byRow ? Math.floor(c / n) : c % n)))];
      const band = lines.flatMap((i) => Array.from({ length: n }, (_, j) => (byRow ? i * n + j : j * n + i)));
      // A line with holes doesn't hold every digit, so its total isn't known.
      if (band.some((c) => cageOf[c] < 0)) continue;
      const cells = band.filter((c) => !set.has(c));
      if (cells.length < 1 || (hidden && hidden.cells.length <= cells.length)) continue;
      // Products: what the whole lines multiply to, divided by the selection (only when that's exact).
      const target = product ? (total !== 0 ? lineSum ** lines.length / total : NaN) : lines.length * lineSum - total;
      if (!Number.isFinite(target) || (product && Math.abs(target - Math.round(target)) > 1e-6)) continue;
      hidden = { cells: cells.sort((a, b) => a - b), target: +target.toFixed(3), op };
      lineCount = lines.length;
    }
    if (!showTotal && !hidden) return null;
    return { total, showTotal, hidden, lines: lineCount, lineSum, op };
  }

  /**
   * While the selection is a set of whole + cages, show their combined total ("39+") in a pill at
   * its centre, and return the hidden cage it implies (if any). Hides the pill otherwise.
   */
  private showRegionSum(region: number[]): HiddenCage | null {
    const pill = this.sumPill;
    const info = this.sumSelection(region);
    this.sumKnown = !!info?.showTotal;
    // A single whole cage: its total would just repeat its own label.
    if (!pill || pill.destroyed || (info && !info.showTotal)) {
      if (pill && !pill.destroyed) pill.visible = false;
      return info?.hidden ?? null;
    }
    const label = pill.getChildAt(1) as Text;
    // Neither adding nor multiplying gives a total yet: the pill stays as "?" while the selection grows.
    label.text = info ? `${+info.total.toFixed(3)}${info.op}` : '?';
    // With a leftover, the total of the whole rows/columns it comes from (e.g. 63 for three rows of 21).
    const sub = pill.getChildAt(2) as Text;
    sub.visible = !!info?.hidden;
    if (info?.hidden) sub.text = `${+(info.op === '×' ? info.lineSum ** info.lines : info.lineSum * info.lines).toFixed(3)}`;
    const bg = pill.getChildAt(0) as Graphics;
    const cs = this.cs;
    const subH = sub.visible ? sub.height * 0.85 : 0;
    label.y = -subH / 2;
    sub.y = label.height / 2 - subH / 2 + sub.height * 0.38;
    const w = Math.max(label.width, sub.visible ? sub.width : 0) + cs * 0.4, h = label.height + subH + cs * 0.14;
    bg.clear().roundRect(-w / 2, -h / 2, w, h, Math.min(h, w) / 2).fill({ color: 0x0b0d22, alpha: 0.9 }).stroke({ width: 2, color: NEUTRAL, alpha: 0.85 });
    // The selection's own pill sits in its middle.
    const n = this.game.n;
    pill.position.set(
      region.reduce((s, c) => s + (c % n) + 0.5, 0) / region.length * cs,
      region.reduce((s, c) => s + Math.floor(c / n) + 0.5, 0) / region.length * cs,
    );
    if (!pill.visible) {
      pill.visible = true;
      pill.scale.set(0.6);
      this.tweens.add({ duration: 220, ease: ease.outBack, update: (t) => !pill.destroyed && pill.scale.set(0.6 + 0.4 * t) });
    }
    return info?.hidden ?? null;
  }

  // ---------- hidden cages (shown only while selected) ----------

  /** Amber outline (a touch lighter than the selection's) + light tint around a hidden cage. */
  private drawHidden(g: Graphics, cells: number[], color = HIDDEN): void {
    const cs = this.cs;
    const n = this.game.n;
    const w = Math.max(2, cs * 0.045);
    for (const c of cells) g.rect((c % n) * cs, Math.floor(c / n) * cs, cs, cs).fill({ color, alpha: 0.12 });
    for (const loop of cageLoops(cells, n)) {
      g.poly(insetLoop(loop, w / 2 / cs).flatMap(([x, y]) => [x * cs, y * cs]), true).stroke({ width: w, color, alpha: 0.7, join: 'miter' });
    }
  }

  /**
   * The digit a leftover pins down: when it's a single empty (unlocked) cell whose total is one of the
   * puzzle's digits, that's the cell's answer. -1 otherwise.
   */
  private confirmDigit(h: HiddenCage | null): number {
    if (!h || h.cells.length !== 1) return -1;
    const c = h.cells[0];
    if (this.game.values[c] !== EMPTY || this.game.givens[c]) return -1;
    return this.game.puzzle.digits.values.findIndex((v) => Math.abs(v - h.target) < 1e-9);
  }

  /** Groups of edge-connected cells (a hidden cage can be in several separate pieces). */
  private pieces(cells: number[]): number[][] {
    const n = this.game.n;
    const left = new Set(cells);
    const out: number[][] = [];
    for (const start of cells) {
      if (!left.has(start)) continue;
      left.delete(start);
      const piece: number[] = [];
      const stack = [start];
      while (stack.length) {
        const c = stack.pop()!;
        piece.push(c);
        const near = [c - n, c + n, c % n > 0 ? c - 1 : -1, c % n < n - 1 ? c + 1 : -1];
        for (const q of near) if (left.delete(q)) stack.push(q);
      }
      out.push(piece.sort((a, b) => a - b));
    }
    return out;
  }

  /**
   * Small "3+" pills, one centred on each separate piece of the hidden cage, sized to fit inside a
   * single cell. They pop in when the hidden cage first appears or changes shape.
   */
  private setGhostLabels(h: HiddenCage | null): void {
    const box = this.ghostLabels;
    if (!box || box.destroyed) return;
    const key = h ? `${h.target}:${h.cells.join()}` : '';
    if (key === this.ghostKey) return;
    this.ghostKey = key;
    box.removeChildren().forEach((c) => c.destroy({ children: true }));
    if (!h) return;
    const cs = this.cs;
    // One cell: its digit, plainly (no "+"), green if it can be entered.
    const single = h.cells.length === 1;
    const edge = this.confirmDigit(h) >= 0 ? CONFIRM : HIDDEN;
    const region = this.drag?.path ?? this.lockedSel?.path ?? [];
    const taken = new Set([...region, ...h.cells]);
    this.pieces(h.cells).forEach((piece, i) => {
      const pill = new Container();
      pill.label = `ghost${i}`;
      pill.eventMode = 'static';
      pill.on('pointerdown', (e: FederatedPointerEvent) => this.grabPill(pill, false, e));
      const text = new Text({ text: single ? `${h.target}` : `${h.target}${h.op ?? '+'}`, style: { fontFamily: FONT, fontSize: Math.max(11, cs * 0.24), fill: 0xffffff, fontWeight: '800' } });
      text.anchor.set(0.5);
      const w = Math.min(cs * 0.9, text.width + cs * 0.22), hgt = text.height + cs * 0.08;
      const bg = new Graphics().roundRect(-w / 2, -hgt / 2, w, hgt, hgt / 2).fill({ color: 0x0b0d22, alpha: 0.9 }).stroke({ width: 2, color: edge, alpha: 0.95 });
      pill.addChild(bg, text);
      const spot = this.pillSpots.get(pill.label) ?? this.pillSpot(piece, taken);
      pill.position.set(spot.x, spot.y);
      taken.add(this.cellAt(spot.x, spot.y));
      pill.scale.set(0.5);
      this.tweens.add({ duration: 220, ease: ease.outBack, update: (t) => !pill.destroyed && pill.scale.set(0.5 + 0.5 * t) });
      box.addChild(pill);
    });
  }

  private endDrag(): void {
    const d = this.drag;
    if (d?.active && !d.locked && !d.held && this.dragPlan(d).mode === 'none' && this.confirmDigit(this.ghost) < 0 && (this.ghost || this.sumKnown)) d.locked = true;
    if (d?.locked) {
      this.drag = null;
      this.cellViews[d.source]?.flash.clear();
      const prev = this.lockedSel?.path ?? null;
      if (d.growFrom !== undefined && d.path.length === d.growFrom) {
        // A drag from the selection that added nothing ends it.
        this.clearLocked(true);
        return;
      }
      // Locked in (or grown): keep the outline, pills and leftover until the next tap on the board.
      this.lockedSel = { path: [...d.path] };
      // The big flash, with sparks where the finger let go (unless holding still already locked it).
      if (!d.heldLock) this.lockFlash(d.lastPos);
      this.drawLocked();
      this.refresh();
      this.onSelectionChange?.([...d.path], prev);
      return;
    }
    if (this.sumPill && !this.sumPill.destroyed) this.sumPill.visible = false;
    this.setGhostLabels(null);
    const ghost = this.ghost;
    this.ghost = null;
    this.drag = null;
    this.refresh();
    this.cancelHold();
    // A finished long-press is the whole action.
    if (d?.held) return;
    // Decided on release, so starting a drag from the selected cell doesn't count as a tap.
    if (d && !d.active && d.reselect) this.onCellReselect?.(d.source);
    if (!d?.active) return;
    this.cellViews[d.source]?.flash.clear();
    if (!this.dragLayer.destroyed) this.dragLayer.clear();
    const plan = this.dragPlan(d);
    // A selection whose leftover pins one empty cell: releasing enters that digit, taking priority
    // over a copy-paste (line sweeps and pairs keep their own action).
    const sure = plan.mode === 'none' || plan.mode === 'copy' ? this.confirmDigit(ghost) : -1;
    if (sure >= 0 && ghost) {
      this.onConfirmCell?.(ghost.cells[0], sure);
      return;
    }
    const result = this.onDragDrop?.(plan) ?? { painted: [], skipped: [] };
    // The line's mint border grows and fades rather than vanishing.
    if (plan.mode === 'line') this.outlinePulse(d.path, LINE);
    if (plan.mode === 'line' && (result.groups?.length || (result.first && result.first.waves.length > 1))) return this.lineSequence(plan, result);
    if (plan.pair && result.action) return this.pairSequence(plan, result, result.action);
    if (result.pairAfter) {
      // The paste plays first; then the group it formed closes in like a pair drag.
      const pa = result.pairAfter;
      this.pairSequence({ ...plan, path: pa.cells }, { painted: pa.painted, skipped: [] }, pa.action, result.painted.length * 45 + 260);
      this.dropFx(plan, result);
      return;
    }
    // play() refreshes too, keeping chain-filled values hidden until their wave.
    if (result.action) this.play(result.action);
    else this.refresh();
    this.dropFx(plan, result);
  }

  /**
   * Line sweep with groups, as one sequence: the fill ripples across the line, then each pair/triple
   * found in it flashes gold in turn and its digits shrink out of the line's other cells, then any
   * chain those removals started plays. Until each step's turn the board shows the earlier state.
   * Undo stops the sequence like it stops a chain.
   */
  private lineSequence(plan: DragDrop, result: DragResult): void {
    const groups = result.groups ?? [];
    const chain = result.action;
    const first = result.first && result.first.waves.length > 1 ? result.first : null;
    const empty: ActionResult = { waves: [[]], eliminated: [], changed: [] };
    const token: PlayingChain = { r: chain ?? empty, played: -1, cancelled: false };
    if (this.chain) this.chain.cancelled = true;
    this.chain = token;
    // What the groups and their chain change stays as it was until their step; chain-filled cells
    // keep their maybes.
    const ghost = new Map<number, number>();
    const addGhost = (m: Map<number, number>, cell: number, digit: number) => m.set(cell, (m.get(cell) ?? 0) | (1 << digit));
    for (const gr of groups) for (const e of gr.eliminated) addGhost(ghost, e.cell, e.digit);
    for (const e of chain?.eliminated ?? []) addGhost(ghost, e.cell, e.digit);
    const hidden = new Set(chain ? chain.waves.slice(1).flat() : []);
    // Before anything plays, the singles chain is held back too.
    const startGhost = new Map(ghost);
    for (const e of first?.eliminated ?? []) addGhost(startGhost, e.cell, e.digit);
    this.refresh(new Set([...hidden, ...(first?.waves.flat() ?? [])]), startGhost);
    this.dropFx(plan, result);
    const rippleMs = result.painted.length * 45 + 380;
    // 1. The fill ripples; 2. cells it left with one maybe fill in and chain; 3. groups; 4. their chain.
    let firstChain: PlayingChain | null = null;
    const alive = () => !token.cancelled && !firstChain?.cancelled;
    if (first) {
      this.tweens.after(rippleMs, () => {
        if (token.cancelled) return;
        if (this.chain === token) this.chain = null;
        firstChain = this.play(first, { hidden, ghost });
      });
    }
    const groupsAt = rippleMs + (first ? FIRST_WAVE_MS + (first.waves.length - 2) * WAVE_GAP_MS * this.wavePace + NOTE_FADE_MS + 220 : 0);
    const GROUP_GAP_MS = 520 * this.wavePace;
    groups.forEach((gr, k) => {
      this.tweens.after(groupsAt + k * GROUP_GAP_MS, () => {
        if (!alive()) return;
        // From here, undo stops the rest of the sequence.
        if (k === 0) this.chain = token;
        this.outlinePulse(gr.cells, PAIR, true);
        this.pulsePairCages(gr.cells);
        this.tweens.after(PAIR_IMPACT_MS, () => {
          if (!alive()) return;
          for (const e of gr.eliminated) ghost.set(e.cell, (ghost.get(e.cell) ?? 0) & ~(1 << e.digit));
          this.flashNearestFirst(gr.cells, gr.eliminated.map((e) => e.cell));
          this.shrinkNotes(gr.eliminated);
          this.tweens.after(NOTE_FADE_MS, () => alive() && this.refresh(hidden, ghost));
        });
      });
    });
    this.tweens.after(groupsAt + (groups.length ? PAIR_IMPACT_MS : 0) + groups.length * GROUP_GAP_MS, () => {
      if (!alive()) return;
      if (this.chain === token) this.chain = null;
      if (chain && chain.waves.length > 1) this.play(chain);
      else if (!this.chain) this.refresh();
    });
  }

  /**
   * Pair/triple drop: the gold rings close in on the pair, and as they land every cell losing maybes
   * flashes and loses them together (nearest a beat first), then any chain that started plays. Until
   * then the board still shows the maybes. Undo during the wait cancels it like a chain.
   */
  private pairSequence(plan: DragDrop, result: DragResult, action: ActionResult, lead = 0): void {
    const token: PlayingChain = { r: action, played: -1, cancelled: false };
    if (this.chain) this.chain.cancelled = true;
    this.chain = token;
    const ghost = new Map<number, number>();
    for (const e of action.eliminated) ghost.set(e.cell, (ghost.get(e.cell) ?? 0) | (1 << e.digit));
    this.refresh(new Set(action.waves.slice(1).flat()), ghost);
    this.tweens.after(lead, () => {
      if (token.cancelled) return;
      this.outlinePulse(plan.path, PAIR, true);
      this.pulsePairCages(plan.path);
    });
    this.tweens.after(lead + PAIR_IMPACT_MS, () => {
      if (token.cancelled) return;
      if (this.chain === token) this.chain = null;
      this.play(action);
      this.flashNearestFirst(plan.path, result.painted);
    });
  }

  /** The pair's cages swell while the rings close in, at their biggest as the rings land. */
  private pulsePairCages(cells: number[]): void {
    for (const ci of new Set(cells.map((c) => this.game.topo.cageOf[c]))) {
      this.pulseCage(this.cageViews[ci], 0.06, PAIR_IMPACT_MS * 2);
    }
  }

  /** The cells losing maybes flash gold all at once, nearest the group a few frames earlier. Their remaining maybes stay still. */
  private flashNearestFirst(group: number[], cells: number[]): void {
    const hit = [...new Set(cells)].sort((a, b) => this.nearest(group, a)[1] - this.nearest(group, b)[1]);
    hit.forEach((c, i) => (i ? this.tweens.after(i * 18, () => this.cellFlash(c, PAIR, false)) : this.cellFlash(c, PAIR, false)));
  }

  /**
   * Release pulse for a region outlined like the drag selection (line sweeps, pairs/triples): the
   * outline brightens and swells (eased, to under 2× its weight) then fades, two thin rings of light
   * travel a short way outward (offset evenly on every side, not scaled), and the outline itself is a
   * light (see Lighting): nearby digits and grid lines bevel and shine, and the buttons below catch it.
   */
  private outlinePulse(cells: number[], color: number, inward = false): void {
    const cs = this.cs, n = this.game.n;
    const loops = cageLoops(cells, n);
    const w = Math.max(2.5, cs * 0.06);
    const lines = new Graphics();
    this.addChildAt(lines, this.getChildIndex(this.dragLayer) + 1);
    // `d` in pixels: positive moves the path inward, negative outward.
    const path = (g: Graphics, d: number) => {
      for (const loop of loops) g.poly(insetLoop(loop, d / cs).flatMap(([x, y]) => [x * cs, y * cs]), true);
    };
    const DURATION = 560, RING_GAP = 150, IN_GAP = 90, RING_TRAVEL = cs * 0.2;
    // Brightness envelope shared by the line and its light: rises over the first 30%, then fades.
    const level = (t: number) => (t < 0.3 ? ease.outCubic(t / 0.3) : 1 - ease.inOutSine((t - 0.3) / 0.7));
    this.tweens.add({
      duration: DURATION, ease: ease.linear,
      start: () => {
        // The light sits in the outer half of the swollen outline, so it glows outward from it.
        const segments = this.loopSegments(loops, -0.4 * w);
        this.ripple(loops, 1, undefined, color);
        this.lighting?.add({ segments, color, level, radius: cs * 0.42 }, DURATION);
      },
      update: (t) => {
        if (lines.destroyed) return;
        lines.clear();
        // Two rings of light, the second a beat behind the first: leaving the outline, or (inward)
        // closing in from outside and landing on it, brightening as they arrive.
        for (let k = 0; k < 2; k++) {
          const local = inward
            ? Math.min(1, Math.max(0, (t * DURATION - k * IN_GAP) / PAIR_IMPACT_MS))
            : Math.min(1, Math.max(0, (t * DURATION - k * RING_GAP) / (DURATION - RING_GAP)));
          if (local <= 0 || local >= 1) continue;
          const reach = inward ? RING_TRAVEL * 1.6 * (1 - local * local) : RING_TRAVEL * ease.outCubic(local);
          path(lines, w / 2 - reach);
          lines.stroke({ width: Math.max(1, w * 0.5), color, alpha: inward ? 0.25 + 0.6 * local : 0.7 * (1 - local), join: 'miter' });
        }
        // The outline: swells smoothly to ~1.8× (outward, so it never covers the cells), flashes
        // toward white at its brightest, then fades.
        const grow = ease.outCubic(Math.min(1, t / 0.4));
        const thick = w * (1 + 0.8 * grow);
        const tint = mix(color, 0xffffff, 0.55 * level(t) * (t < 0.3 ? 1 : 1 - (t - 0.3) / 0.7));
        path(lines, w / 2 - (thick - w) / 2);
        lines.stroke({ width: thick, color: tint, alpha: t < 0.3 ? 1 : level(t), join: 'miter' });
      },
      done: () => !lines.destroyed && lines.destroy(),
    });
  }

  /** Light segments (board px) along outline loops (cell units), `d` px inward (negative: outward). */
  private loopSegments(loops: [number, number][][], d: number): number[][] {
    const cs = this.cs;
    return loops.flatMap((loop) => {
      const pts = insetLoop(loop, d / cs).map(([x, y]) => [x * cs, y * cs]);
      return pts.map((a, i) => [...a, ...pts[(i + 1) % pts.length]]);
    });
  }

  /** A short burst of light: rises fast, then fades smoothly. A point light is one zero-length segment. */
  private flashLight(segments: number[][], color: number, duration: number, radius: number, peak = 1): void {
    this.lighting?.add({ segments, color, radius, level: (t) => peak * (t < 0.15 ? ease.outCubic(t / 0.15) : 1 - ease.inOutSine((t - 0.15) / 0.85)) }, duration);
  }

  private pointLight(c: number, color: number, duration: number, radius: number, peak = 1): void {
    const { x, y } = this.cellCenter(c);
    this.flashLight([[x, y, x, y]], color, duration, radius, peak);
  }

  /** A placed digit swells briefly and flashes `color`, then settles back (refresh restores its ink). */
  private bumpDigit(c: number, color: number, delay: number): void {
    const view = this.cellViews[c];
    if (!view) return;
    let ink = 0xffffff;
    this.tweens.add({
      duration: 360, delay, ease: ease.linear,
      start: () => (ink = view.value.tint as number),
      update: (t) => {
        if (view.destroyed) return;
        const k = ease.pulse(t);
        view.value.scale.set(1 + 0.3 * k);
        view.value.tint = mix(ink, color, Math.min(1, k * 1.6));
      },
      done: () => {
        if (view.destroyed) return;
        view.value.scale.set(1);
        view.value.tint = ink;
      },
    });
  }

  /** A quick tint of one cell's background (no sparkles); optionally its maybes pop in; its cage pulses. */
  private cellFlash(c: number, color: number, pop: boolean): void {
    const view = this.cellViews[c];
    if (!view) return;
    const cs = this.cs;
    this.tweens.add({
      duration: 320, ease: ease.outCubic,
      update: (t) => !view.destroyed && view.flash.clear().rect(0, 0, cs, cs).fill({ color, alpha: 0.32 * (1 - t) }),
      done: () => !view.destroyed && view.flash.clear(),
    });
    if (pop) this.popNotes(view);
    this.pulseCage(this.cageViews[this.game.topo.cageOf[c]], 0.025, 260);
  }

  get dragSource(): number {
    return this.drag?.active && this.drag.copying ? this.drag.source : -1;
  }

  /** The source cell becomes the "blueprint": a burst, its maybes bob once, then it breathes (see update). */
  private blueprintStart(source: number): void {
    const cs = this.cs;
    const { x, y } = this.cellCenter(source);
    this.particles.burst(x, y, { count: 18, colors: [MAYBE, MAYBE_LIGHT], speed: [cs * 0.6, cs * 2], life: [0.25, 0.5], size: [cs * 0.05, cs * 0.12], radius: cs * 0.3, drag: 4 });
    for (const t of this.cellViews[source].notes) {
      if (!t.visible) continue;
      this.tweens.add({ duration: 300, ease: ease.linear, update: (v) => !t.destroyed && t.scale.set(1 + 0.35 * ease.pulse(v)) });
    }
  }

  /**
   * On release the new maybes ripple out cell by cell: in drag order for a copy,
   * outward from the start cell for a line fill. Skipped filled cells shake.
   */
  private dropFx(plan: DragDrop, result: DragResult): void {
    if (plan.pair) return;
    const painted = new Set(result.painted);
    // Hide the new maybes until each cell's turn.
    for (const c of painted) for (const t of this.cellViews[c].notes) if (t.visible) t.scale.set(0);
    const order =
      plan.mode === 'line'
        ? [...painted].sort((a, b) => this.cellDistance(plan.source, a) - this.cellDistance(plan.source, b))
        : plan.path.filter((c) => painted.has(c));
    let prev = plan.source;
    order.forEach((c, i) => {
      const from = prev;
      // Line fill: each cell's background flashes mint in turn (no sparkles). Copy keeps its trail.
      this.tweens.after(i * 45, () => (plan.mode === 'line' ? this.cellFlash(c, LINE, true) : this.pasteFx(from, c, i)));
      prev = c;
    });
    result.skipped.forEach((c, i) => this.tweens.after(i * 45, () => this.blockedFx(c)));
  }

  /**
   * Check result. Wrong cells flash red and shake, then keep a red tint until the next move; with
   * nothing wrong, a green shimmer sweeps across every checked cell.
   */
  checkFx(wrong: number[], checked: number[]): void {
    const cs = this.cs;
    this.errorCells = new Set(wrong);
    this.refresh();
    const flash = (c: number, color: number, delay: number) => {
      const view = this.cellViews[c];
      if (!view) return;
      this.tweens.add({
        duration: 600, delay, ease: ease.outCubic,
        update: (t) => !view.destroyed && view.flash.clear().rect(cs * 0.06, cs * 0.06, cs * 0.88, cs * 0.88).stroke({ width: Math.max(2, cs * 0.06), color, alpha: 1 - t }),
        done: () => !view.destroyed && view.flash.clear(),
      });
    };
    if (wrong.length) {
      for (const c of wrong) {
        flash(c, 0xff4d6d, 0);
        this.blockedFx(c);
        const { x, y } = this.cellCenter(c);
        this.particles.burst(x, y, { count: 8, colors: [0xff4d6d, 0xff9aa9], speed: [cs * 0.4, cs * 1.3], life: [0.2, 0.4], size: [cs * 0.04, cs * 0.1], drag: 4 });
      }
      return;
    }
    // All good: sweep from the top-left corner.
    const n = this.game.n;
    // One continuous band of light: a diagonal line across the whole board gliding from the top-left
    // corner to the bottom-right in step with the cell sweep.
    const size = n * cs;
    const sweepMs = 2 * (n - 1) * 12 + 320;
    this.lighting?.add({
      segments: [],
      segmentsAt: (t) => {
        const at = t * 2 * size; // the line x + y = at, extended past the board edges
        return [[at + cs, -cs, at - size - cs, size + cs]];
      },
      color: 0x8cff6b, radius: cs * 0.4,
      level: (t) => 0.75 * Math.sin(Math.PI * Math.min(1, t)),
    }, sweepMs);
    for (const c of checked) {
      const delay = ((c % n) + Math.floor(c / n)) * 12;
      flash(c, 0x8cff6b, delay);
      this.bumpDigit(c, 0x8cff6b, delay);
      const { x, y } = this.cellCenter(c);
      this.tweens.after(delay, () => this.particles.burst(x, y, { count: 4, colors: [0x8cff6b, 0xd8ffcc], speed: [cs * 0.3, cs], life: [0.25, 0.45], size: [cs * 0.04, cs * 0.09], drag: 4 }));
    }
  }

  /** A move Claude made over the live link: an orange flash and burst on the cell. */
  claudeFx(cell: number): void {
    const view = this.cellViews[cell];
    if (!view) return;
    const cs = this.cs;
    this.tweens.add({
      duration: 900, ease: ease.outCubic,
      update: (t) => !view.destroyed && view.flash.clear().roundRect(cs * 0.06, cs * 0.06, cs * 0.88, cs * 0.88, cs * 0.12).stroke({ width: Math.max(2, cs * 0.06), color: CLAUDE, alpha: 1 - t }),
      done: () => !view.destroyed && view.flash.clear(),
    });
    const { x, y } = this.cellCenter(cell);
    this.particles.burst(x, y, { count: 16, colors: [CLAUDE, CLAUDE_LIGHT, 0xffffff], speed: [cs * 0.6, cs * 2], life: [0.3, 0.6], size: [cs * 0.05, cs * 0.13], radius: cs * 0.25, drag: 4 });
  }


  /** The cell in `from` closest to `to`, and its distance. */
  private nearest(from: number[], to: number): [number, number] {
    let best = from[0];
    for (const c of from) if (this.cellDistance(c, to) < this.cellDistance(best, to)) best = c;
    return [best, this.cellDistance(best, to)];
  }

  private cellDistance(a: number, b: number): number {
    const n = this.game.n;
    return Math.abs((a % n) - (b % n)) + Math.abs(Math.floor(a / n) - Math.floor(b / n));
  }

  /** Trail from the previous cell, a burst on arrival, maybes popping in one by one, a cage nudge. */
  private pasteFx(from: number, to: number, index: number, color = MAYBE, light = MAYBE_LIGHT): void {
    const cs = this.cs;
    const a = this.cellCenter(from), b = this.cellCenter(to);
    const colors = [color, light, 0xffffff];
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      this.particles.burst(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, { count: 2, colors, speed: [cs * 0.1, cs * 0.6], life: [0.25, 0.5], size: [cs * 0.05, cs * 0.11], drag: 4 });
    }
    // Bursts grow a little with each cell in the same stroke.
    const power = Math.min(2, 1 + index * 0.12);
    this.particles.burst(b.x, b.y, { count: Math.round(14 * power), colors, speed: [cs * 0.8, cs * 2.4 * power], life: [0.3, 0.6], size: [cs * 0.06, cs * 0.15], radius: cs * 0.3, drag: 3.5 });

    const view = this.cellViews[to];
    this.popNotes(view);
    this.tweens.add({
      duration: 480, ease: ease.outCubic,
      update: (t) => {
        if (view.destroyed) return;
        view.flash.clear().roundRect(cs * 0.06, cs * 0.06, cs * 0.88, cs * 0.88, cs * 0.12).stroke({ width: Math.max(2, cs * 0.05) * (1 - t * 0.5), color, alpha: 1 - t });
      },
      done: () => !view.destroyed && view.flash.clear(),
    });
    this.pulseCage(this.cageViews[this.game.topo.cageOf[to]], 0.025, 260);
  }

  /** Visible maybes in a cell grow in one after another. */
  private popNotes(view: CellView, delay = 0): void {
    let k = 0;
    for (const t of view.notes) {
      if (!t.visible) continue;
      t.scale.set(0);
      this.tweens.add({ duration: 280, delay: delay + k++ * 24, ease: ease.outBack, update: (v) => !t.destroyed && t.scale.set(v) });
    }
  }

  /** Maybes given back to cells (e.g. after taking back a slip) pop in with a faint sparkle. */
  restoreFx(cells: number[], delay = 100): void {
    const cs = this.cs;
    for (const c of cells) {
      const view = this.cellViews[c];
      if (!view) continue;
      this.popNotes(view, delay);
      const { x, y } = this.cellCenter(c);
      this.tweens.after(delay, () => this.particles.burst(x, y, { count: 5, colors: [MAYBE, MAYBE_LIGHT], speed: [cs * 0.3, cs], life: [0.2, 0.4], size: [cs * 0.04, cs * 0.09], drag: 4 }));
    }
  }

  /** A placed value dissolves (grows and fades in its ink colour) and the cell's maybes pop in. */
  valueToMaybes(cell: number, label: string, ink: number): void {
    const view = this.cellViews[cell];
    const cs = this.cs;
    const old = new Text({ text: label, style: { fontFamily: FONT, fontSize: view.value.style.fontSize, fill: 0xffffff, fontWeight: '700' } });
    old.anchor.copyFrom(view.value.anchor);
    old.position.copyFrom(view.value.position);
    old.tint = ink;
    view.addChild(old);
    this.tweens.add({
      duration: 320, ease: ease.outCubic,
      update: (t) => {
        if (old.destroyed) return;
        old.scale.set(1 + 0.6 * t);
        old.alpha = 1 - t;
      },
      done: () => !old.destroyed && old.destroy(),
    });
    const { x, y } = this.cellCenter(cell);
    this.particles.burst(x, y, { count: 16, colors: [ink, MAYBE, MAYBE_LIGHT], speed: [cs * 0.6, cs * 2], life: [0.25, 0.5], size: [cs * 0.05, cs * 0.12], radius: cs * 0.2, drag: 4 });
    this.popNotes(view, 120);
  }

  /** Dragged over a filled cell: a small grey puff and a shake. */
  private blockedFx(cell: number): void {
    const view = this.cellViews[cell];
    const { x, y } = this.cellCenter(cell);
    const baseX = view.x;
    this.particles.burst(x, y, { count: 6, colors: [0x8d97c2, 0x5a6390], speed: [this.cs * 0.3, this.cs], life: [0.2, 0.35], size: [this.cs * 0.04, this.cs * 0.09], drag: 5 });
    this.tweens.add({
      duration: 260, ease: ease.linear,
      update: (t) => !view.destroyed && (view.x = baseX + Math.sin(t * Math.PI * 6) * this.cs * 0.04 * (1 - t)),
      done: () => !view.destroyed && (view.x = baseX),
    });
  }

  build(game: Game, size: number, x: number, y: number): void {
    // A different puzzle (or a revised one): marks from the old one don't carry over.
    if (this.game !== game) {
      this.disproven.clear();
      this.guessOrigin = null;
      this.olderGuessOrigins = [];
    }
    this.game = game;
    // Pending animations reference the old views.
    this.tweens.clear();
    this.lighting?.clear();
    this.cancelHold();
    // Their texts go with removeChildren below.
    this.combos = [];
    this.chain = null;
    this.drag = null;
    this.removeChildren().forEach((c) => {
      if (c !== this.particles.container) c.destroy({ children: true });
    });
    this.cs = size / game.n;
    const cs = this.cs;
    this.home = { x, y };
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.pinch = null;
    this.position.set(x, y);
    this.hitArea = new Rectangle(0, 0, size, size);

    if (game.puzzle.holes?.length) {
      // An odd-shaped board: the frame follows its cells.
      this.frame = new Graphics();
      const cells = game.topo.cageOf.flatMap((ci, c) => (ci >= 0 ? [c] : []));
      for (const loop of cageLoops(cells, game.n)) this.frame.poly(insetLoop(loop, -0.12).flatMap(([x, y]) => [x * cs, y * cs]), true);
      this.frame.fill({ color: 0x070814, alpha: 0.38 }).stroke({ width: 2, color: 0x6f7cff, alpha: 0.35, join: 'round' });
    } else this.frame = new Graphics().roundRect(-cs * 0.12, -cs * 0.12, size + cs * 0.24, size + cs * 0.24, cs * 0.18).fill({ color: 0x070814, alpha: 0.38 }).stroke({ width: 2, color: 0x6f7cff, alpha: 0.35 });
    this.frame.tint = 0xffffff;
    this.addChild(this.frame);

    this.cageViews = game.puzzle.cages.map((_, ci) => {
      const cv = new CageView(ci, game, cs);
      cv.drawShape(0);
      return cv;
    });
    this.cellViews = [];
    for (const cv of this.cageViews) this.addChild(cv);
    this.cageViews.forEach((cv) => {
      for (const cell of game.puzzle.cages[cv.index].cells) {
        const view = new CellView(cell, cs, game.puzzle.digits.labels);
        view.position.set((cell % game.n) * cs, Math.floor(cell / game.n) * cs);
        this.cellViews[cell] = view;
        cv.addChild(view);
      }
      cv.addChild(cv.labelText, cv.resultText);
    });
    this.lighting?.build(cs);
    this.bg.ripples.scale = cs / 56;
    this.dragLayer = new Graphics();
    // The "39+" total pill for drags that cover whole + cages (see showRegionSum).
    this.sumPill = new Container();
    // Children: background, the sum, and (smaller, underneath) the whole lines' total it's taken from.
    this.sumPill.addChild(
      new Graphics(),
      new Text({ text: '', style: { fontFamily: FONT, fontSize: Math.max(15, this.cs * 0.36), fill: 0xffffff, fontWeight: '800' } }),
      new Text({ text: '', style: { fontFamily: FONT, fontSize: Math.max(10, this.cs * 0.2), fill: 0xffffff, fontWeight: '700' } }),
    );
    (this.sumPill.getChildAt(1) as Text).anchor.set(0.5);
    (this.sumPill.getChildAt(2) as Text).anchor.set(0.5);
    this.sumPill.eventMode = 'static';
    const mainPill = this.sumPill;
    this.sumPill.on('pointerdown', (e: FederatedPointerEvent) => this.grabPill(mainPill, true, e));
    (this.sumPill.getChildAt(2) as Text).alpha = 0.6;
    this.sumPill.visible = false;
    this.ghostLabels = new Container();
    this.ghostKey = '';
    this.selLayer = new Graphics();
    this.selRings = [];
    this.selCage = -1;
    this.selLight = null;
    this.lockedSel = null;
    this.sumOp = null;
    this.pillDrag = null;
    this.pillSpots.clear();
    this.dragGlow = { level: 0, flash: 0 };
    this.dragHold = new Graphics();
    this.addChild(this.selLayer, this.dragLayer, this.dragHold, this.ghostLabels, this.particles.container, this.sumPill);

    this.refresh();
  }

  /**
   * Redraw every cell. During a chain, cells in `hidden` still show their maybes instead of the value
   * they're about to get, and `ghost` (cell → digit mask) keeps maybes on screen that the game has
   * already removed but whose wave hasn't played yet.
   */
  refresh(hiddenArg?: Set<number>, ghostArg?: Map<number, number>): void {
    if (!this.game) return;
    // While a chain is playing, a plain redraw (selecting a cell, a highlight) keeps the animation's
    // in-progress view instead of jumping to the final board.
    if (hiddenArg) this.playView = { hidden: hiddenArg, ghost: ghostArg };
    const live = this.chain && !this.chain.cancelled ? this.playView : null;
    const hidden = hiddenArg ?? live?.hidden ?? new Set<number>();
    const ghost = hiddenArg ? ghostArg : live?.ghost;
    const g = this.game;
    const cs = this.cs;
    // Repeats in a row/column, counting only digits on screen: one a chain hasn't revealed yet doesn't
    // turn its twin red early.
    const conflicts = new Set([...g.clashes()].filter((c) => !hidden.has(c) && g.topo.peers[c].some((q) => !hidden.has(q) && g.values[q] === g.values[c])));
    for (const cv of this.cageViews) {
      if (cv.destroyed) continue;
      const shown = g.puzzle.cages[cv.index].cells.every((c) => !hidden.has(c));
      if (cv.index === g.topo.cageOf[this.selected]) this.selectCage(cv.index);
      const status = shown ? g.cageStatus(cv.index) : 'open';
      // Complete, but resting on a guess: its own yellow style until the guess is confirmed.
      const guessed = status === 'ok' && g.puzzle.cages[cv.index].cells.some((c) => g.layers[c] > 0);
      cv.setState(guessed ? 'guessed' : status, status === 'wrong' ? g.cageResult(cv.index) : null);
    }
    // Cages down to one empty cell whose math no digit can complete: that cell gets a red X.
    const impossible = new Set<number>();
    if (g.settings.autoFill && g.settings.fillCageLast) {
      g.puzzle.cages.forEach((_, ci) => {
        const gap = g.cageGap(ci);
        if (gap && !gap.fits.length) impossible.add(gap.cell);
      });
    }
    const sel = this.selected;
    const selCells = new Set(this.drag?.active ? this.drag.path : (this.lockedSel?.path ?? []));
    const leftCells = new Set(this.ghost && selCells.size ? this.ghost.cells : []);
    // Digits a chain hasn't revealed yet don't count for the same-digit highlight (it would give them away).
    const selVal = hidden.has(sel) ? EMPTY : g.values[sel];
    // The last move glows: every digit and maybe it put in, and (fainter) the maybes left in cells it
    // only took maybes from. Not cells a chain animation hasn't revealed yet.
    const recent = g.lastChanges();
    for (let c = 0; c < this.cellViews.length; c++) {
      const v = this.cellViews[c];
      if (!v) continue;
      const ch = hidden.has(c) ? undefined : recent.get(c);
      const val = g.values[c];
      // Givens (single-cell cages, locked) look like any completed cage.
      // Only the running guess is coloured; earlier (still open) guesses read as normal entries.
      const color = layerColor(g.layers[c] === g.layer ? g.layers[c] : 0);
      const show = val !== EMPTY && !hidden.has(c);
      v.value.text = show ? g.puzzle.digits.labels[val] : '';
      // Digits of a completed cage lean green.
      const done = this.cageViews[g.topo.cageOf[c]]?.state === 'ok';
      // A running guess's digits keep the plain guess colour (no completed-cage green mixed in).
      const inGuess = g.layers[c] > 0 && g.layers[c] === g.layer;
      v.value.tint = conflicts.has(c) ? 0xff4d6d : done && !inGuess ? mix(color, 0x8cff6b, 0.35) : color;
      v.cross.visible = impossible.has(c) && !show;
      if (this.disproven.has(c) && val !== EMPTY) this.disproven.delete(c);
      // An undone guess's digit: crossed out over its maybe if the cell went back to maybes holding it,
      // otherwise shown full size, light red, with a red X.
      const mark = val === EMPTY && !hidden.has(c) ? this.disproven.get(c) : undefined;
      const onNote = !!mark && mark.digit >= 0 && has(g.notes[c], mark.digit);
      const bigMark = !!mark && !onNote;
      if (bigMark) {
        v.value.text = mark.label;
        v.value.tint = 0xff9aa8;
        v.cross.visible = true;
      }
      v.noteCross.visible = onNote;
      if (onNote) v.noteCross.position.copyFrom(v.notes[mark.digit].position);
      v.glowValue(v.value.text, !!ch && show && ch.after.value !== ch.before.value);
      const shownNotes = g.notes[c] | (ghost?.get(c) ?? 0);
      const added = ch ? ch.after.notes & ~(ch.before.value === ch.after.value ? ch.before.notes : 0) : 0;
      const onlyRemoved = !!ch && !added && ch.before.value === ch.after.value && (ch.before.notes & ~ch.after.notes) !== 0;
      v.notes.forEach((t, d) => {
        t.visible = (val === EMPTY || hidden.has(c)) && !bigMark && has(shownNotes, d);
        // Impossible: a number already shown in the same row or column is this digit.
        const bad = this.markBadNotes && t.visible && g.topo.peers[c].some((q) => g.values[q] === d && !hidden.has(q));
        t.tint = (onNote && d === mark.digit) || bad ? 0xff8a9a : c === this.dragSource ? MAYBE_LIGHT : g.layers[c] > 0 && g.layers[c] === g.layer ? (this.maybeTarget ? color : mix(color, 0x9aa3c0, 0.4)) : this.maybeTarget ? 0xffb870 : 0xb9c3e6;
        const glow = v.noteGlows[d];
        glow.visible = t.visible && (has(added, d) || onlyRemoved);
        glow.alpha = onlyRemoved ? 0.3 : 0.6;
        // The halo follows the maybe colour: warm behind orange maybes, pale cyan otherwise.
        glow.tint = this.maybeTarget ? MAYBE_LIGHT : GLOW_TINT;
      });
      // The selected cell's cage gets the soft highlight (not its row and column).
      const sameCage = g.topo.cageOf[c] === g.topo.cageOf[sel];
      v.highlight.clear();
      if (selCells.has(c) || leftCells.has(c)) {
        // Under a drag selection (white) or its leftover (amber): less see-through, lightly tinted.
        v.highlight.rect(0, 0, cs, cs).fill({ color: 0x0b0d22, alpha: 0.5 });
        v.highlight.rect(0, 0, cs, cs).fill({ color: selCells.has(c) ? NEUTRAL : HIDDEN, alpha: 0.1 });
      }
      if (c === this.dragSource) v.highlight.rect(0, 0, cs, cs).fill({ color: MAYBE, alpha: 0.3 });
      // Selecting a cell Check marked wrong: pink, so it still reads as the red cell.
      else if (c === sel && (this.drag?.active || this.lockedSel)) { /* the drag selection shows instead */ }
      else if (c === sel && this.errorCells.has(c)) v.highlight.rect(0, 0, cs, cs).fill({ color: 0xff6fcf, alpha: 0.38 });
      else if (c === sel) v.highlight.rect(0, 0, cs, cs).fill(this.maybeTarget ? { color: MAYBE, alpha: 0.3 } : { color: 0xffffff, alpha: 0.22 });
      else if (this.errorCells.has(c)) v.highlight.rect(0, 0, cs, cs).fill({ color: 0xff4d6d, alpha: 0.26 });
      else if (this.hintCells.has(c)) v.highlight.rect(0, 0, cs, cs).fill({ color: 0xffc94f, alpha: 0.28 });
      else if (selVal !== EMPTY && val === selVal && !hidden.has(c)) v.highlight.rect(0, 0, cs, cs).fill({ color: 0x4fd8ff, alpha: 0.16 });
      else if (sameCage && !this.drag?.active && !this.lockedSel) {
        // A firmer backing so the numbers stand out, then the mode tint (a deeper red in normal mode).
        v.highlight.rect(0, 0, cs, cs).fill({ color: 0x0b0d22, alpha: 0.45 });
        v.highlight.rect(0, 0, cs, cs).fill(this.maybeTarget ? { color: MAYBE, alpha: 0.1 } : { color: 0x3a4a80, alpha: 0.22 });
      }
      if (g.puzzle.rules?.goal?.cell === c) {
        // A campaign level's cell to solve: a gold ring.
        const w = Math.max(2, cs * 0.06);
        v.highlight.rect(w / 2 + cs * 0.04, w / 2 + cs * 0.04, cs - w - cs * 0.08, cs - w - cs * 0.08).stroke({ width: w, color: GUESS_COLOR, alpha: 0.9 });
      }
      if (this.guessOrigin?.cell === c) {
        // The running guess's first digit: a dashed square just inside the cell edge (80% dash, solid corners).
        const w = Math.max(1.5, cs * 0.032), inset = w / 2 + cs * 0.025, side = cs - inset * 2;
        dashedSquare(v.highlight, inset, side, Math.max(4, side / 6), w);
        v.highlight.stroke({ width: w, color: this.guessOrigin.color, alpha: 0.9, cap: 'butt' });
      }
      if (this.olderGuessOrigins.includes(c)) {
        // An earlier guess started here: a small, dimmer inset square.
        const w = Math.max(1.5, cs * 0.03);
        v.highlight.rect(cs * 0.16, cs * 0.16, cs * 0.68, cs * 0.68).stroke({ width: w, color: GUESS_COLOR, alpha: 0.6 });
      }
    }
  }

  cellCenter(c: number): { x: number; y: number } {
    const n = this.game.n;
    return { x: ((c % n) + 0.5) * this.cs, y: (Math.floor(c / n) + 0.5) * this.cs };
  }

  /**
   * Animate an action: direct entries pop immediately, each auto-fill wave follows with escalating
   * VFX. Maybes stay on screen until the wave that removes them plays: a cell keeps its maybes until
   * its digit pops in, and a peer's maybe shrinks away as the placement that rules it out lands.
   */
  play(r: ActionResult, base?: { hidden: Set<number>; ghost: Map<number, number> }): PlayingChain {
    // `base`: what a later step of a sequence changes, kept as it was while this chain plays.
    const hiddenAfter = (i: number) => new Set([...r.waves.slice(i + 1).flat(), ...(base?.hidden ?? [])]);
    const ghostFrom = (k: number) => {
      const m = new Map<number, number>(base?.ghost ?? []);
      for (const e of r.eliminated) if (e.wave >= k) m.set(e.cell, (m.get(e.cell) ?? 0) | (1 << e.digit));
      return m;
    };
    this.refresh(hiddenAfter(0), ghostFrom(0));
    // A chain with later waves can be interrupted (undo) until its last wave has played.
    const chain: PlayingChain = { r, played: -1, cancelled: false };
    if (this.chain) this.chain.cancelled = true;
    this.chain = r.waves.length > 1 ? chain : null;
    const last = r.waves.length - 1;
    const touchedCages = new Set<number>();
    // Waves can now overlap a still-shrinking maybe, so track what's actually done: ruled-out maybes
    // stay drawn until their own shrink finishes (fadedUpTo), values until their wave plays.
    let fadedUpTo = -1;
    r.waves.forEach((wave, i) => {
      const elims = r.eliminated.filter((e) => e.wave === i);
      if (!wave.length && !elims.length) return;
      // The first reaction follows the move almost at once; later waves are spaced out, and only that
      // spacing stretches with the chain pace setting (wavePace). Slow motion scales all of it (main.ts).
      const delay = i === 0 ? 0 : FIRST_WAVE_MS + (i - 1) * WAVE_GAP_MS * this.wavePace;
      this.tweens.after(delay, () => {
        if (chain.cancelled) return;
        chain.played = i;
        for (const c of wave) {
          this.revealCell(c, i);
          touchedCages.add(this.game.topo.cageOf[c]);
        }
        // This wave's eliminations are still drawn; shrink them, then drop them from the screen.
        this.refresh(hiddenAfter(i), ghostFrom(fadedUpTo + 1));
        this.shrinkNotes(elims);
        this.tweens.after(NOTE_FADE_MS, () => {
          if (chain.cancelled) return;
          fadedUpTo = Math.max(fadedUpTo, i);
          this.refresh(hiddenAfter(chain.played), ghostFrom(fadedUpTo + 1));
          if (i === last && this.chain === chain) this.chain = null;
        });
        if (r.broken?.wave === i) this.brokenFx(r.broken.cells, i, r);
        else if (i >= 2) this.comboLabel(`CHAIN ×${i}`, [wave[0] ?? elims[0].cell], r.waves.slice(0, i + 2).flat(), r, CONFIRM);
        // The finish has its own single ripple, so the last cages don't add theirs.
        const finished = this.game.isSolved();
        for (const ci of touchedCages) if (this.game.cageStatus(ci) === 'ok') this.cageComplete(ci, i * 40, !finished);
        touchedCages.clear();
        if (i === last && this.game.isSolved()) this.celebrate(wave[0]);
      });
    });
    return chain;
  }

  /**
   * Stop a chain that is still playing (call BEFORE the game state is undone). The waves not yet shown
   * never play, and the digits already shown rewind: newest first, each spins down and is sucked back
   * in, while the maybes they had cleared pop back. Returns false when no chain was playing.
   */
  interruptChain(): boolean {
    const ch = this.chain;
    if (!ch) return false;
    ch.cancelled = true;
    this.chain = null;
    const shown = ch.r.waves.slice(0, ch.played + 1).flat().reverse();
    // Capture what's on screen now; the game state is about to change underneath.
    const ghosts = shown.map((c) => ({ c, text: this.cellViews[c].value.text, tint: this.cellViews[c].value.tint as number }));
    // Each digit stays (as its rewinding copy) until its turn, rather than vanishing with the undo.
    ghosts.forEach((g, i) => this.rewindCell(g.c, g.text, g.tint, REWIND, i * REWIND_STEP_MS));
    const restored = [...new Set(ch.r.eliminated.filter((e) => e.wave <= ch.played).map((e) => e.cell))];
    this.tweens.after(ghosts.length * REWIND_STEP_MS, () => this.restoreFx(restored.filter((c) => this.game.values[c] === EMPTY), 0));
    // Its chain labels and shake collapse with it.
    for (const e of this.combos.filter((e) => e.r === ch.r)) this.retireCombo(e);
    this.shakeAmount = 0;
    return true;
  }

  /** What `cells` show right now, captured before an undo changes them (for rewindMove). */
  snapshotCells(cells: number[]): { c: number; text: string; tint: number; notes: number }[] {
    return cells.map((c) => {
      const v = this.cellViews[c];
      const notes = v ? v.notes.reduce((m, t, d) => (t.visible ? m | (1 << d) : m), 0) : 0;
      return { c, text: v?.value.text ?? '', tint: (v?.value.tint as number) ?? 0xffffff, notes };
    });
  }

  /**
   * Play an undo backwards: newest change first, quickly, in red. Digits that went away spin down
   * and get sucked in; maybes that came back pop in. Call after the undo, with snapshotCells from
   * before it.
   */
  rewindMove(before: { c: number; text: string; tint: number; notes: number }[]): void {
    const cs = this.cs;
    before.forEach((b, i) => {
      const view = this.cellViews[b.c];
      if (!view) return;
      const delay = i * UNDO_STEP_MS;
      const nowNotes = view.notes.reduce((m, t, d) => (t.visible ? m | (1 << d) : m), 0);
      const back = nowNotes & ~b.notes;
      // Maybes the undo takes away (ones the move had added); only while the cell is still empty.
      const gone = view.value.text ? 0 : b.notes & ~nowNotes;
      // Maybes coming back wait (hidden) for their step; maybes going away stay until theirs.
      view.notes.forEach((t, d) => {
        if (back & (1 << d)) t.scale.set(0);
        if (gone & (1 << d)) t.visible = true;
      });
      // A digit going away stays on screen (as its rewinding copy) until its step.
      if (b.text && !view.value.text) this.rewindCell(b.c, b.text, b.tint, UNDO_RED, delay);
      this.tweens.after(delay, () => {
        if (view.destroyed) return;
        view.notes.forEach((t, d) => {
          if (back & (1 << d)) this.tweens.add({ duration: 200, ease: ease.outBack, update: (v) => !t.destroyed && t.scale.set(v) });
          if (gone & (1 << d)) {
            // Destroyed like any removed maybe: dust from where it sat as it shrinks away.
            this.dustNote(b.c, d);
            this.tweens.add({
              duration: NOTE_FADE_MS, ease: ease.outCubic,
              update: (v) => !t.destroyed && t.scale.set(1 - v),
              done: () => {
                if (t.destroyed) return;
                t.scale.set(1);
                t.visible = has(this.game.notes[b.c], d) && this.game.values[b.c] === EMPTY;
              },
            });
          }
        });
        if (i < 8) {
          if (back | gone) {
            // A small light at each maybe coming back or going away (one light, a point each; up to 6).
            const n = this.game.n, ox = (b.c % n) * cs, oy = Math.floor(b.c / n) * cs;
            const pts = view.notes.filter((_, d) => (back | gone) & (1 << d)).slice(0, 6).map((t) => [ox + t.x, oy + t.y, ox + t.x, oy + t.y]);
            this.flashLight(pts, UNDO_RED, 260, cs * 0.14, 0.6);
          } else this.pointLight(b.c, UNDO_RED, 260, cs * 0.35, 0.55);
        }
        const { x, y } = this.cellCenter(b.c);
        if (back) this.particles.burst(x, y, { count: 4, colors: [UNDO_RED, 0xffb3bd], speed: [cs * 0.3, cs * 0.9], life: [0.15, 0.3], size: [cs * 0.03, cs * 0.07], drag: 5 });
      });
    });
  }

  /** A guess was undone: its starting cell pulses red and keeps the tried digit, crossed out in red. */
  markDisproven(cell: number, label: string, digit = -1, delay = 0): void {
    if (delay) {
      this.tweens.after(delay, () => this.markDisproven(cell, label, digit));
      return;
    }
    if (label) this.disproven.set(cell, { label, digit });
    this.refresh();
    const view = this.cellViews[cell];
    if (!view) return;
    const cs = this.cs;
    this.tweens.add({
      duration: 1400, ease: ease.linear,
      update: (t) => !view.destroyed && view.flash.clear().rect(cs * 0.03, cs * 0.03, cs * 0.94, cs * 0.94).stroke({ width: Math.max(2, cs * 0.06), color: UNDO_RED, alpha: 0.9 * Math.abs(Math.sin(t * Math.PI * 3)) * (1 - t * 0.6) }),
      done: () => !view.destroyed && view.flash.clear(),
    });
    this.pointLight(cell, UNDO_RED, 900, cs * 0.5, 1);
  }

  /**
   * One digit rewinding: a copy of it spins and shrinks to nothing while sparks fall inward. The copy
   * shows from now on, so with a `delay` the digit stays in place until its turn instead of vanishing.
   */
  private rewindCell(c: number, text: string, tint: number, spark = REWIND, delay = 0): void {
    const view = this.cellViews[c];
    if (!view || view.destroyed || !text) return;
    const cs = this.cs;
    const ghost = new Text({ text, style: { fontFamily: FONT, fontSize: view.value.style.fontSize, fill: 0xffffff, fontWeight: '700', dropShadow: digitBevel(Number(view.value.style.fontSize)) } });
    ghost.anchor.copyFrom(view.value.anchor);
    ghost.position.copyFrom(view.value.position);
    ghost.tint = tint;
    view.addChild(ghost);
    const { x, y } = this.cellCenter(c);
    this.tweens.add({
      duration: 260, delay, ease: ease.inOutSine,
      start: () => this.particles.burst(x, y, { count: 12, colors: [spark, 0xffffff], speed: [cs * 1.2, cs * 2.2], life: [0.2, 0.32], size: [cs * 0.04, cs * 0.1], radius: cs * 0.55, inward: true, drag: 1 }),
      update: (t) => {
        if (ghost.destroyed) return;
        ghost.scale.set(1 - t);
        ghost.rotation = -t * Math.PI;
        ghost.alpha = 1 - t * 0.6;
      },
      done: () => !ghost.destroyed && ghost.destroy(),
    });
  }

  /** Maybes ruled out by a placement shrink to nothing (refresh hides them right after). */
  private shrinkNotes(elims: { cell: number; digit: number }[]): void {
    for (const { cell, digit } of elims) {
      const t = this.cellViews[cell]?.notes[digit];
      if (!t?.visible) continue;
      this.dustNote(cell, digit);
      this.tweens.add({
        duration: NOTE_FADE_MS, ease: ease.outCubic,
        update: (v) => !t.destroyed && t.scale.set(1 - v),
        done: () => !t.destroyed && t.scale.set(1),
      });
    }
  }

  /**
   * A maybe destroyed: a puff of fine dust from where it sat, shot out fast and stopped quickly by air
   * drag (no gravity), each speck trailing a short streak.
   */
  dustNote(cell: number, digit: number): void {
    const t = this.cellViews[cell]?.notes[digit];
    if (!t) return;
    const cs = this.cs, n = this.game.n;
    const x = (cell % n) * cs + t.x, y = Math.floor(cell / n) * cs + t.y;
    this.particles.burst(x, y, { count: 16, colors: [0xffffff, MAYBE_LIGHT, MAYBE], speed: [cs * 0.3, cs * 5.2], life: [0.28, 0.55], size: [cs * 0.035, cs * 0.075], radius: cs * 0.08, drag: 7, streak: 1 / cs });
  }

  private revealCell(c: number, wave: number): void {
    const view = this.cellViews[c];
    const { x, y } = this.cellCenter(c);
    const cs = this.cs;
    view.value.scale.set(0);
    this.tweens.add({ duration: 380, ease: ease.outBack, update: (t) => view.value.scale.set(t) });
    const colors = WAVE_COLORS[Math.min(wave, WAVE_COLORS.length - 1)];
    const power = 1 + wave * 0.6;
    this.pointLight(c, colors[0], 420 + wave * 40, cs * (0.35 + 0.07 * Math.min(wave, 5)), Math.min(1.4, 0.35 + 0.22 * wave));
    this.particles.burst(x, y, { count: Math.round(10 + wave * 10), colors, speed: [cs * 1.5, cs * 4 * power], life: [0.35, 0.7 + wave * 0.1], size: [cs * 0.08, cs * 0.22], radius: cs * 0.2, drag: 3 });
    const cv = this.cageViews[this.game.topo.cageOf[c]];
    this.pulseCage(cv, 0.04 + wave * 0.02);
    this.cageRipple(cv, 0.6 + wave * 0.3);
    if (wave >= 1) {
      this.bg.energy += 0.15 * wave;
      if (wave >= 3) this.shakeAmount = Math.min(cs * 0.12, this.shakeAmount + cs * 0.02 * wave);
    }
  }

  /**
   * A ripple in the cage's shape. Everything that lands on one cage in quick succession (its digits, a
   * chain fill, its completion) merges into that one ripple, a little stronger, instead of adding more.
   */
  private cageRipple(cv: CageView, strength: number): void {
    this.ripple(cv.loops, strength, `cage${cv.index}`);
  }

  /** A ripple from outline loops (cell units), optionally in a colour (0 = default blue). */
  private ripple(loops: [number, number][][], strength: number, key?: string, color = 0): void {
    const segs = this.loopSegments(loops, 0).map(([x1, y1, x2, y2]) => {
      const a = this.toGlobal({ x: x1, y: y1 }), b = this.toGlobal({ x: x2, y: y2 });
      return [a.x, a.y, b.x, b.y];
    });
    this.bg.ripples.add(segs, Math.min(1.2, strength), key, color);
  }

  pulseCage(cv: CageView, amount: number, duration = 320): void {
    this.tweens.add({ duration, ease: ease.linear, update: (t) => cv.scale.set(1 + amount * ease.pulse(t)) });
  }

  private cageComplete(ci: number, delay: number, ripple = true): void {
    const cv = this.cageViews[ci];
    this.tweens.add({
      duration: 650, delay, ease: ease.linear,
      start: () => {
        this.flashLight(this.loopSegments(cv.loops, 0), 0x9fe8ff, 650, this.cs * 0.38, 0.9);
        if (ripple) this.cageRipple(cv, 1);
        // Sparkles along the cage outline.
        for (const loop of cv.loops) {
          for (let i = 0; i < loop.length; i++) {
            const [ax, ay] = loop[i], [bx, by] = loop[(i + 1) % loop.length];
            const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) * 4));
            for (let s = 0; s < steps; s++) {
              const t = s / steps;
              this.particles.burst((ax + (bx - ax) * t) * this.cs, (ay + (by - ay) * t) * this.cs, { count: 2, colors: [0xffffff, 0x9fe8ff, 0xfff36b], speed: [this.cs * 0.2, this.cs * 1.2], life: [0.4, 0.8], size: [this.cs * 0.05, this.cs * 0.12], drag: 2 });
            }
          }
        }
      },
      update: (t) => {
        cv.drawShape(1 - t);
        cv.scale.set(1 + 0.07 * ease.pulse(Math.min(1, t * 2)));
      },
      done: () => cv.drawShape(0),
    });
  }

  /**
   * An error stopped the chain: the cells involved flash red and spit red sparks, the board jolts and
   * its frame flushes red, the chain's labels turn red, and (if it had got going) a "CHAIN BROKEN" label pops up.
   */
  private brokenFx(cells: number[], wave: number, r: ActionResult): void {
    const cs = this.cs;
    for (const c of cells) {
      const view = this.cellViews[c];
      if (!view) continue;
      this.tweens.add({
        duration: 700, ease: ease.outCubic,
        update: (t) => !view.destroyed && view.flash.clear().roundRect(cs * 0.04, cs * 0.04, cs * 0.92, cs * 0.92, cs * 0.12).fill({ color: ERROR, alpha: 0.35 * (1 - t) }).stroke({ width: Math.max(2, cs * 0.07), color: ERROR, alpha: 1 - t }),
        done: () => !view.destroyed && view.flash.clear(),
      });
      this.pointLight(c, ERROR, 650, cs * 0.55, 1.3);
      const { x, y } = this.cellCenter(c);
      this.particles.burst(x, y, { count: 18, colors: [ERROR, 0xff9aa9, 0xffffff], speed: [cs * 0.8, cs * 2.6], life: [0.3, 0.6], size: [cs * 0.05, cs * 0.13], radius: cs * 0.2, drag: 3 });
    }
    this.shakeAmount = Math.min(cs * 0.18, this.shakeAmount + cs * 0.1);
    const frame = this.frame;
    const rest = frame.tint;
    this.tweens.add({ duration: 600, ease: ease.outCubic, update: (t) => !frame.destroyed && (frame.tint = mix(0xff5a6e, rest as number, t)) });
    // The chain's labels go red and stay red as they fade (their glow is white ink, so the tint carries it).
    for (const e of this.combos) if (e.r === r) e.t.tint = ERROR;
    if (wave >= 1 && cells.length) this.comboLabel('CHAIN BROKEN', cells, r.waves.flat(), r, ERROR);
  }

  /**
   * A small glowing chain label on the board, beside `near` but off the chain's own cells (`busy`), holes
   * and other labels. Up to COMBO_POOL live at once; a new one retires the oldest. Pops in, drifts, fades.
   */
  private comboLabel(text: string, near: number[], busy: number[], r: ActionResult, tint: number): void {
    const cs = this.cs, n = this.game.n;
    if (this.combos.length >= COMBO_POOL) this.retireCombo(this.combos[0]);
    const avoid = new Set([...busy, ...this.combos.map((e) => e.cell)]);
    this.game.topo.cageOf.forEach((ci, c) => ci < 0 && avoid.add(c));
    const spot = this.pillSpot(near, avoid);
    // White ink and a white glow, so the tint colours both (and can turn them red later).
    const t = new Text({ text, style: { fontFamily: FONT, fontSize: Math.max(11, cs * 0.34), fill: 0xffffff, fontWeight: '900', letterSpacing: cs * 0.05, dropShadow: { color: 0xffffff, blur: cs * 0.12, distance: 0, alpha: 0.8 } } });
    t.anchor.set(0.5);
    t.position.set(spot.x, spot.y);
    t.tint = tint;
    this.addChild(t);
    const e = { t, cell: Math.floor(spot.y / cs) * n + Math.floor(spot.x / cs), r, k: 1 };
    this.combos.push(e);
    this.flashLight([[spot.x, spot.y, spot.x, spot.y]], tint, 450, cs * 0.4, 0.5);
    this.tweens.add({
      duration: 1100, ease: ease.linear,
      update: (p) => {
        if (t.destroyed) return;
        t.scale.set(e.k * ease.outBack(Math.min(1, p * 4)));
        t.alpha = 0.8 * e.k * (p < 0.65 ? 1 : 1 - (p - 0.65) / 0.35);
        t.y = spot.y - cs * 0.25 * p;
      },
      done: () => {
        this.combos = this.combos.filter((x) => x !== e);
        if (!t.destroyed) t.destroy();
      },
    });
  }

  /** A chain label leaves early (pool full, or its chain was undone): it shrinks and fades out quickly. */
  private retireCombo(e: BoardView['combos'][number]): void {
    this.combos = this.combos.filter((x) => x !== e);
    this.tweens.add({ duration: 200, ease: ease.outCubic, update: (v) => (e.k = Math.min(e.k, 1 - v)) });
  }

  celebrate(from: number): void {
    const origin = this.cellCenter(from ?? 0);
    const n = this.game.n;
    // Around the board as it is: an odd-shaped one by its outline.
    const edge: [number, number][][] = this.game.puzzle.holes?.length ? cageLoops(this.game.topo.cageOf.flatMap((ci, c) => (ci >= 0 ? [c] : [])), n) : [[[0, 0], [n, 0], [n, n], [0, n]]];
    this.flashLight(this.loopSegments(edge, 0), 0xffd36b, 1400, this.cs * 0.9, 1.2);
    // One ripple for the finish, around the whole puzzle (the last move's own ripples are dropped).
    this.bg.ripples.dropNew();
    this.ripple(edge, 1.4, undefined, 0xffd36b);
    // The whole board bumps: a quick swell and settle around its centre.
    this.tweens.add({ duration: 460, ease: ease.linear, update: (t) => (this.bump = 1 + 0.07 * ease.pulse(t)), done: () => (this.bump = 1) });
    this.cageViews.forEach((cv) => {
      const dist = Math.hypot(cv.center.x - origin.x, cv.center.y - origin.y) / this.cs;
      this.tweens.after(dist * 90, () => {
        this.cageComplete(cv.index, 0, false);
        this.particles.burst(cv.center.x, cv.center.y, { count: 40, colors: WAVE_COLORS.flat(), speed: [this.cs * 2, this.cs * 7], life: [0.6, 1.3], size: [this.cs * 0.08, this.cs * 0.25], gravity: this.cs * 6, drag: 1.5 });
      });
    });
    this.bg.energy += 1.2;
  }

  /** Shift cages, board frame and background towards orange while maybe mode is on (maybes turn white). */
  setMaybeMode(on: boolean): void {
    const target = on ? 1 : 0;
    if (target === this.maybeTarget) return;
    this.maybeTarget = target;
    this.refresh();
  }

  /**
   * A second finger came down: whatever the first was doing is dropped, and the two pinch the board.
   * Points are in the board's parent space (canvas pixels).
   */
  pinchStart(a: { x: number; y: number }, b: { x: number; y: number }): void {
    this.cancelHold();
    if (this.drag) {
      this.drag = null;
      if (!this.dragLayer.destroyed) this.dragLayer.clear();
      if (this.sumPill && !this.sumPill.destroyed) this.sumPill.visible = false;
      this.setGhostLabels(null);
      this.ghost = null;
      if (this.lockedSel) this.drawLocked();
      this.refresh();
    }
    this.pillDrag = null;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.pinch = {
      d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      zoom0: this.zoom,
      // The board point under the fingers' midpoint, which stays under it as they move.
      local: { x: (mid.x - this.home.x - this.pan.x) / this.zoom, y: (mid.y - this.home.y - this.pan.y) / this.zoom },
    };
  }

  pinchMove(a: { x: number; y: number }, b: { x: number; y: number }): void {
    const pin = this.pinch;
    if (!pin) return;
    this.zoom = Math.min(4, Math.max(1, (pin.zoom0 * Math.hypot(a.x - b.x, a.y - b.y)) / pin.d0));
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    // Fitted again: back in place.
    if (this.zoom <= 1.01) this.pan = { x: 0, y: 0 };
    else this.pan = { x: mid.x - this.home.x - pin.local.x * this.zoom, y: mid.y - this.home.y - pin.local.y * this.zoom };
  }

  pinchEnd(): void {
    this.pinch = null;
  }

  /** Start a long-press on a × cage's cell: the fill circle grows from (x, y) inside the cage. */
  private startHold(cell: number, x: number, y: number): void {
    this.cancelHold();
    const ci = this.game.topo.cageOf[cell];
    const cage = this.game.puzzle.cages[ci];
    if (cage.op !== 'mul') return;
    const cs = this.cs, n = this.game.n;
    const mask = new Graphics();
    for (const c of cage.cells) mask.rect((c % n) * cs, Math.floor(c / n) * cs, cs, cs);
    mask.fill({ color: 0xffffff });
    const circle = new Graphics();
    circle.mask = mask;
    const layer = new Container();
    layer.addChild(mask, circle);
    this.addChildAt(layer, this.getChildIndex(this.dragLayer));
    // Far enough to cover the whole cage from where the finger is.
    const reach = Math.max(...cage.cells.flatMap((c) => [0, 1].flatMap((dx) => [0, 1].map((dy) => Math.hypot(((c % n) + dx) * cs - x, (Math.floor(c / n) + dy) * cs - y)))));
    this.hold = { ci, layer, circle, x, y, reach, ms: 0 };
  }

  private cancelHold(): void {
    const h = this.hold;
    this.hold = null;
    if (h && !h.layer.destroyed) h.layer.destroy({ children: true });
  }

  /** Grow the long-press circle; when it fills the cage, the cage pops and the action runs. */
  private tickHold(dtMs: number): void {
    const h = this.hold;
    if (!h || h.layer.destroyed) return;
    const HOLD_MS = 650;
    h.ms += dtMs;
    const k = Math.min(1, h.ms / HOLD_MS);
    // Starts slow and grows exponentially quicker, so it reads as "keep holding".
    const r = (h.reach * (Math.pow(2, 5 * k) - 1)) / 31;
    h.circle.clear().circle(h.x, h.y, Math.max(1, r)).fill({ color: 0x4fc8f0, alpha: 0.18 + 0.22 * k }).stroke({ width: 2, color: 0x9fe8ff, alpha: 0.8 });
    if (k < 1) return;
    this.cancelHold();
    if (this.drag) this.drag.held = true;
    const cv = this.cageViews[h.ci];
    this.pulseCage(cv, 0.09, 280);
    this.cageRipple(cv, 0.9);
    this.flashLight(this.loopSegments(cv.loops, 0), 0x4fc8f0, 450, this.cs * 0.4, 0.9);
    this.particles.burst(cv.center.x, cv.center.y, { count: 26, colors: [0x4fc8f0, 0x9fe8ff, 0xffffff], speed: [this.cs * 1.5, this.cs * 4], life: [0.3, 0.6], size: [this.cs * 0.04, this.cs * 0.1], radius: this.cs * 0.3, drag: 4 });
    this.onCageHold?.(h.ci);
  }

  /** The selection moved into cage `ci`: its ring fades in (with a small light and droplet), the old one out. */
  private selectCage(ci: number): void {
    if (ci === this.selCage) return;
    this.selCage = ci;
    for (const r of this.selRings) r.out = true;
    this.selRings.push({ ci, t: 0, out: false });
    const cv = this.cageViews[ci];
    if (!cv) return;
    // A small light and droplet: gentler than any other effect.
    // Flash, then settle to a faint glow that stays while selected; the old one fades out quickly.
    const now = performance.now();
    if (this.selLight) this.selLight.gone = now;
    const life = { born: now, gone: 0 };
    this.selLight = life;
    const color = mix(SELECT_RING, MAYBE, this.maybeTarget);
    this.lighting?.add({
      // Just inside the wall: the dark interior stops at the cage edge instead of spilling past it.
      segments: this.loopSegments(cv.loops, this.cs * 0.02), color, radius: this.cs * 0.8,
      // Shines outward only: none of it lands inside the selected cage.
      mask: true,
      // Follows maybe mode on and off while the cage stays selected.
      colorAt: () => mix(SELECT_RING, MAYBE, this.maybeMix),
      level: () => {
        const t = performance.now();
        const on = Math.min(1, (t - life.born) / 60);
        // A gentle flash over a firmer resting glow (a big flash blew out nearby digits; the rest was too faint).
        const base = 0.26 + 0.1 * Math.exp(-(t - life.born) / 160);
        const off = life.gone ? Math.max(0, 1 - (t - life.gone) / 180) : 1;
        return on * base * off * this.selFade;
      },
      alive: () => !life.gone || performance.now() - life.gone < 180,
    }, Infinity);
    this.ripple(cv.loops, 0.28, `select${ci}`, color);
  }

  /** Animate and draw the selection rings: thickness and opacity ease in (or out) together. */
  private drawSelection(dtMs: number): void {
    const g = this.selLayer;
    if (g.destroyed) return;
    const RING_MS = 180;
    for (const r of this.selRings) r.t = Math.min(1, r.t + dtMs / RING_MS);
    this.selRings = this.selRings.filter((r) => !(r.out && r.t >= 1));
    g.clear();
    const cs = this.cs;
    const w = Math.max(2, cs * 0.05);
    for (const r of this.selRings) {
      const cv = this.cageViews[r.ci];
      if (!cv) continue;
      const k = (r.out ? 1 - ease.outCubic(r.t) : ease.outCubic(r.t)) * this.selFade;
      if (k <= 0.01) continue;
      // Covers the cage's own wall (which sits just inside the edge) and reaches a little past the edge,
      // with a thin dark rim outside it.
      const wall = Math.max(1.5, cs * 0.03);
      const inner = wall * k, outer = w * 0.45 * k;
      for (const loop of cv.loops) {
        const at = (d: number) => insetLoop(loop, -d / cs).flatMap(([x, y]) => [x * cs, y * cs]);
        g.poly(at((outer - inner) / 2), true).stroke({ width: inner + outer, color: mix(SELECT_RING, MAYBE, this.maybeMix), alpha: k, join: 'miter' });
        g.poly(at(outer + w * 0.2), true).stroke({ width: Math.max(1, w * 0.4), color: 0x05060f, alpha: 0.7 * k, join: 'miter' });
      }
    }
  }

  /** A soft light along the drag outline while selecting (and while a locked selection shows). */
  /** The cells of a drag selection and its leftover, as row runs: the lighting keeps all light off them. */
  selectionMask(): number[][] {
    const path = this.drag?.active ? this.drag.path : (this.lockedSel?.path ?? []);
    if (!path.length || !this.game) return [];
    const n = this.game.n, cs = this.cs;
    const cells = [...new Set([...path, ...(this.ghost?.cells ?? [])])].sort((a, b) => a - b);
    const runs: number[][] = [];
    for (const c of cells) {
      const last = runs.at(-1);
      // Extends the run when this cell is the next one along the same row.
      if (last && c === last[1] + 1 && Math.floor(c / n) === Math.floor(last[0] / n)) last[1] = c;
      else runs.push([c, c]);
    }
    return runs.map(([a, b]) => [(a % n) * cs, Math.floor(a / n) * cs, ((b % n) + 1) * cs, (Math.floor(a / n) + 1) * cs]);
  }

  private startDragGlow(): void {
    const n = this.game.n;
    this.dragGlow = { level: 0, flash: 0 };
    const glow = this.dragGlow;
    const path = () => this.drag?.path ?? this.lockedSel?.path ?? [];
    this.lighting?.add({
      segments: [],
      segmentsAt: () => this.loopSegments(cageLoops(path(), n), 0),
      color: NEUTRAL, radius: this.cs * 0.3, mask: true,
      level: () => glow.level * 0.22 + glow.flash,
      alive: () => this.dragGlow === glow && path().length > 0,
    }, Infinity);
    // The leftover cells glow amber (green when they pin a digit).
    this.lighting?.add({
      segments: [],
      segmentsAt: () => (this.ghost ? this.loopSegments(cageLoops(this.ghost.cells, n), 0) : []),
      color: HIDDEN, radius: this.cs * 0.26, mask: true,
      level: () => (this.ghost ? glow.level * 0.25 : 0),
      alive: () => this.dragGlow === glow && path().length > 0,
    }, Infinity);
  }

  /** Clear a locked selection (the tap after it); `record` adds it to the undo chain. */
  private clearLocked(record = false): void {
    const prev = this.lockedSel?.path ?? null;
    this.lockedSel = null;
    this.sumOp = null;
    this.pillSpots.clear();
    if (record && prev) this.onSelectionChange?.(null, prev);
    if (!this.dragLayer.destroyed) this.dragLayer.clear();
    if (this.sumPill && !this.sumPill.destroyed) this.sumPill.visible = false;
    this.setGhostLabels(null);
    this.ghost = null;
    this.refresh();
  }

  /** Show a locked selection (undo/redo bring one back), or none. Not recorded. */
  setLocked(path: number[] | null): void {
    if (!path) return this.clearLocked();
    this.lockedSel = { path: [...path] };
    this.startDragGlow();
    this.drawLocked();
    this.refresh();
  }

  /** Draw a locked (or growing) selection: neutral outline, its pills and leftover. */
  private drawLocked(path = this.lockedSel?.path ?? []): void {
    const g = this.dragLayer;
    if (g.destroyed) return;
    g.clear();
    if (!path.length) return;
    const cs = this.cs, n = this.game.n;
    for (const c of path) g.rect((c % n) * cs, Math.floor(c / n) * cs, cs, cs).fill({ color: NEUTRAL, alpha: 0.13 });
    const w = SEL_W(cs);
    for (const loop of cageLoops(path, n)) g.poly(insetLoop(loop, w / 2 / cs).flatMap(([x, y]) => [x * cs, y * cs]), true).stroke({ width: w, color: NEUTRAL, alpha: 0.95, join: 'miter' });
    this.ghost = this.showRegionSum(path);
    if (this.ghost) this.drawHidden(g, this.ghost.cells, this.confirmDigit(this.ghost) >= 0 ? CONFIRM : HIDDEN);
    this.setGhostLabels(this.ghost);
    this.refresh();
  }

  /** A pill was pressed (locked selection only): drag it, or tap the main one to switch + and ×. */
  private grabPill(pill: Container, main: boolean, e: FederatedPointerEvent): void {
    if (!this.lockedSel) return;
    e.stopPropagation();
    const q = e.getLocalPosition(this);
    this.pillDrag = { pill, main, dx: pill.x - q.x, dy: pill.y - q.y, start: { x: q.x, y: q.y }, at: { x: q.x, y: q.y }, moved: false };
  }

  private endPillDrag(): void {
    const pd = this.pillDrag;
    this.pillDrag = null;
    if (!pd) return;
    if (!this.dragHold.destroyed) this.dragHold.clear();
    if (pd.main && pd.moved && this.lockedSel) {
      // Let go over a cell outside the selection: it joins (an undo step).
      const cell = this.cellAt(pd.at.x, pd.at.y);
      if (cell < 0 || this.lockedSel.path.includes(cell)) return;
      const prev = [...this.lockedSel.path];
      this.lockedSel = { path: [...prev, cell] };
      this.ghostKey = '';
      this.drawLocked();
      this.dragGlow.flash = Math.max(this.dragGlow.flash, 0.5);
      this.ripple([[[cell % this.game.n, Math.floor(cell / this.game.n)], [cell % this.game.n + 1, Math.floor(cell / this.game.n)], [cell % this.game.n + 1, Math.floor(cell / this.game.n) + 1], [cell % this.game.n, Math.floor(cell / this.game.n) + 1]]], 0.25, undefined, NEUTRAL);
      this.onSelectionChange?.([...this.lockedSel.path], prev);
      return;
    }
    if (!pd.moved || pd.main) {
      if (!pd.main || !this.lockedSel) return;
      // Tap on the main pill: switch between adding and multiplying.
      // Only when the other way works out (gives a total or a leftover); otherwise a little shake.
      const now = this.sumSelectionOp(this.lockedSel.path);
      this.sumOp = now === '×' ? '+' : '×';
      if (!this.sumSelection(this.lockedSel.path)?.showTotal) {
        this.sumOp = now;
        const pill = pd.pill, x0 = pill.x;
        this.tweens.add({ duration: 260, update: (t) => !pill.destroyed && (pill.x = x0 + Math.sin(t * Math.PI * 6) * (1 - t) * this.cs * 0.08) });
        return;
      }
      this.ghostKey = '';
      this.drawLocked();
      return;
    }
    // Dropped: it stays there, with a small ripple.
    this.pillSpots.set(pd.main ? 'main' : (pd.pill.label ?? ''), { x: pd.pill.x, y: pd.pill.y });
    const gp = this.toGlobal(pd.pill.position);
    this.bg.ripples.add([[gp.x, gp.y, gp.x, gp.y]], 0.3);
  }

  /** The dashed line from the main pill to the finger, and the cell it would add. */
  private drawReach(pd: NonNullable<BoardView['pillDrag']>): void {
    const g = this.dragHold;
    if (g.destroyed || !this.lockedSel) return;
    g.clear();
    if (!pd.moved) return;
    const cs = this.cs, n = this.game.n;
    const from = pd.pill.position, to = pd.at;
    const len = Math.hypot(to.x - from.x, to.y - from.y), dash = cs * 0.12;
    for (let s = 0; s < len; s += dash * 2) {
      const a = s / len, b = Math.min(len, s + dash) / len;
      g.moveTo(from.x + (to.x - from.x) * a, from.y + (to.y - from.y) * a).lineTo(from.x + (to.x - from.x) * b, from.y + (to.y - from.y) * b);
    }
    g.stroke({ width: Math.max(2, cs * 0.045), color: NEUTRAL, alpha: 0.9, cap: 'round' });
    const cell = this.cellAt(to.x, to.y);
    if (cell >= 0 && !this.lockedSel.path.includes(cell)) {
      const w = Math.max(2, cs * 0.05);
      g.rect((cell % n) * cs + w / 2, Math.floor(cell / n) * cs + w / 2, cs - w, cs - w).stroke({ width: w, color: NEUTRAL, alpha: 0.8 });
    }
  }

  /**
   * Which way a selection's pill combines: the player's switch, else whichever of adding and
   * multiplying gives a total (both do: the start cell's cage operator decides).
   */
  private sumSelectionOp(region: number[]): '+' | '×' {
    if (this.sumOp) return this.sumOp;
    const mul = this.game.puzzle.cages[this.game.topo.cageOf[region[0]]].op === 'mul';
    const first: '+' | '×' = mul ? '×' : '+', other: '+' | '×' = mul ? '+' : '×';
    const works = (op: '+' | '×') => this.game.regionTotal(region, op === '×' ? 'product' : 'sum') !== null;
    return works(first) || !works(other) ? first : other;
  }

  /** A spot beside `cells` but off them: the nearest cell centre not in `avoid` (pills sit over less useful cells). */
  private pillSpot(cells: number[], avoid: Set<number>): { x: number; y: number } {
    const n = this.game.n, cs = this.cs;
    const cx = cells.reduce((s, c) => s + (c % n) + 0.5, 0) / cells.length;
    const cy = cells.reduce((s, c) => s + Math.floor(c / n) + 0.5, 0) / cells.length;
    let best = -1, bestD = Infinity;
    for (let c = 0; c < n * n; c++) {
      if (avoid.has(c)) continue;
      const d = Math.hypot((c % n) + 0.5 - cx, Math.floor(c / n) + 0.5 - cy);
      if (d < bestD) [best, bestD] = [c, d];
    }
    return best < 0 ? { x: cx * cs, y: cy * cs } : { x: ((best % n) + 0.5) * cs, y: (Math.floor(best / n) + 0.5) * cs };
  }

  /** Selected-cage effects fade out during a drag; the selection glow eases between drawing, kept and off. */
  private tickDragGlow(dtMs: number): void {
    const d = this.drag;
    const busy = !!d?.active || !!this.lockedSel;
    const target = busy ? 0 : 1;
    this.selFade += Math.sign(target - this.selFade) * Math.min(Math.abs(target - this.selFade), dtMs / 160);
    const glow = this.dragGlow;
    // Full while drawing a selection, dimmer once kept, off otherwise.
    const want = d?.active && !d.locked ? 1 : this.lockedSel || d?.locked ? 0.7 : 0;
    glow.level += Math.sign(want - glow.level) * Math.min(Math.abs(want - glow.level), dtMs / 200);
    glow.flash *= Math.exp(-dtMs / 260);
    // Holding still on a first selection: a ring shrinks onto the finger, then the selection locks.
    const g = this.dragHold;
    if (g.destroyed || this.pillDrag) return;
    g.clear();
    if (!d?.active || d.locked || d.growFrom !== undefined || d.stillMs === undefined || !d.anchor) return;
    d.stillMs += dtMs;
    const LOCK_MS = 800, SHOW_MS = 250;
    if (d.stillMs < SHOW_MS) return;
    const k = Math.min(1, (d.stillMs - SHOW_MS) / (LOCK_MS - SHOW_MS));
    const cs = this.cs;
    g.circle(d.anchor.x, d.anchor.y, cs * (1.1 - 0.85 * ease.outCubic(k))).stroke({ width: Math.max(2, cs * 0.05), color: NEUTRAL, alpha: 0.85 * k });
    if (k < 1) return;
    d.locked = d.heldLock = true;
    g.clear();
    this.lockFlash(d.anchor);
  }

  /** The lock-in flash: the selection's outline flares and sparks burst at `at`. */
  private lockFlash(at: { x: number; y: number }): void {
    const cs = this.cs;
    this.dragGlow.flash = 1.1;
    this.particles.burst(at.x, at.y, { count: 16, colors: [NEUTRAL, 0xffffff], speed: [cs * 0.8, cs * 2.2], life: [0.2, 0.4], size: [cs * 0.03, cs * 0.08], drag: 5 });
  }

  update(dt: number): void {
    this.tickHold(dt * 1000);
    this.tickDragGlow(dt * 1000);
    this.drawSelection(dt * 1000);
    this.lighting?.update(dt * 1000);
    if (this.maybeMix !== this.maybeTarget) {
      const step = dt * 6;
      // Eases the selection ring between blue and orange; cage walls don't follow the mode.
      this.maybeMix = Math.abs(this.maybeTarget - this.maybeMix) <= step ? this.maybeTarget : this.maybeMix + Math.sign(this.maybeTarget - this.maybeMix) * step;
    }
    const d = this.drag;
    if (d?.active && d.copying) {
      // Blueprint cell: a breathing violet frame while its maybes are being copied.
      d.time += dt;
      const cs = this.cs;
      const breath = 0.5 + 0.5 * Math.sin(d.time * 7);
      const view = this.cellViews[d.source];
      if (view && !view.destroyed) {
        view.flash
          .clear()
          .roundRect(cs * 0.05, cs * 0.05, cs * 0.9, cs * 0.9, cs * 0.12)
          .stroke({ width: Math.max(2, cs * (0.045 + 0.03 * breath)), color: MAYBE, alpha: 0.65 + 0.35 * breath })
          .roundRect(cs * 0.14, cs * 0.14, cs * 0.72, cs * 0.72, cs * 0.08)
          .stroke({ width: 1, color: MAYBE_LIGHT, alpha: 0.25 + 0.35 * breath });
      }
    }
    // Scale around the board's centre: shift by half the growth.
    // (No game yet on a fresh load: the board is empty until the first puzzle arrives.)
    const grow = this.game ? (this.cs * this.game.n * this.zoom * (this.bump - 1)) / 2 : 0;
    this.scale.set(this.bump * this.zoom);
    const x = this.home.x + this.pan.x - grow, y = this.home.y + this.pan.y - grow;
    if (this.shakeAmount > 0.1) {
      this.position.set(x + (Math.random() - 0.5) * this.shakeAmount, y + (Math.random() - 0.5) * this.shakeAmount);
      this.shakeAmount *= Math.exp(-dt * 10);
    } else this.position.set(x, y);
  }
}
