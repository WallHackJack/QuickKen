// DOM controls: number pad, tools, messages and the new-puzzle dialog.

import { DIGIT_PRESETS, makeDigitSet, type DigitSet } from '../engine/digits';
import type { GenOptions } from '../engine/generator';
import type { Rating } from '../engine/logic';
import { DEFAULT_OPTIONS, type Options } from '../game/options';
import { LAYER_COLORS, noteColumns } from '../render/BoardView';
import { digitLetters } from './keys';

export interface HudHandlers {
  digit(d: number): void;
  erase(): void;
  undo(): void;
  redo(): void;
  /** Start a guess (nested if one is already running). */
  guess(): void;
  keep(): void;
  drop(): void;
  hint(): void;
  check(): void;
  newGame(o: GenOptions): void;
  toggleNotes(): void;
  /** A finger is sweeping the digit pad: these digits (so far) become maybes in the selected cell now. */
  sweepStep(digits: number[]): void;
  /** The sweep was released. */
  sweepEnd(): void;
  optionsChanged(o: Options): void;
}

/** The operators a new puzzle can use: the four basics show just their symbol, the rest name + symbol. */
const OPS = [
  { id: 'add', label: '+', weight: 4 },
  { id: 'sub', label: '−', weight: 2 },
  { id: 'mul', label: '×', weight: 3 },
  { id: 'div', label: '÷', weight: 2 },
  { id: 'max', label: 'Max ↑', weight: 1.5 },
  { id: 'min', label: 'Min ↓', weight: 1.5 },
  { id: 'range', label: 'Range Δ', weight: 1 },
  { id: 'mod', label: 'Mod %', weight: 1 },
];

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

export class Hud {
  readonly el: HTMLElement;
  private message: HTMLElement;
  private pad: HTMLElement;
  private padButtons: HTMLButtonElement[] = [];
  private btn: Record<string, HTMLButtonElement> = {};
  private dialog: HTMLDialogElement;
  private optionsDialog: HTMLDialogElement;
  private guessMenu: HTMLElement;
  private layer = 0;
  private meta: HTMLElement;
  private timerEl: HTMLElement;
  readonly fpsEl: HTMLElement;

  constructor(root: HTMLElement, stage: HTMLElement, private h: HudHandlers) {
    this.el = root;
    const top = document.createElement('div');
    top.className = 'topbar';
    top.innerHTML = `<button class="title" data-k="options" aria-label="Options">QUICKKEN</button><span class="meta"></span><span class="spacer"></span><span class="link" hidden title="Claude can see this board and make moves">● Claude</span><span class="fps"></span><span class="timer">0:00</span><button data-k="new">New</button>`;
    stage.appendChild(top);
    this.meta = top.querySelector('.meta')!;
    this.timerEl = top.querySelector('.timer')!;
    this.fpsEl = top.querySelector('.fps')!;
    top.querySelector<HTMLButtonElement>('[data-k=new]')!.onclick = () => this.dialog.showModal();
    top.querySelector<HTMLButtonElement>('[data-k=options]')!.onclick = () => this.optionsDialog.showModal();

    this.message = document.createElement('div');
    this.message.id = 'message';
    this.pad = document.createElement('div');
    this.pad.className = 'pad';
    const tools = document.createElement('div');
    tools.className = 'tools';
    // Maybe mode is toggled by tapping the selected cell again (see BoardView.onCellReselect).
    const defs: [string, string, () => void][] = [
      ['erase', 'Clear', h.erase],
      // Tap = undo, hold = redo (wired in holdToRedo; click only handles keyboard activation).
      ['undo', 'Undo', () => {}],
      // No guess running: start one. Otherwise open the menu (confirm / undo / start next guess).
      ['guess', 'Guess', () => (this.layer === 0 ? h.guess() : this.toggleGuessMenu())],
      ['check', 'Check', h.check],
    ];
    for (const [k, label, fn] of defs) {
      const b = document.createElement('button');
      b.textContent = label;
      b.dataset.k = k;
      b.onclick = fn;
      this.btn[k] = b;
      // Undo and Clear are big buttons beside the digit pad (placed in setDigits).
      if (k === 'undo' || k === 'erase') b.classList.add('act');
      else tools.appendChild(b);
    }
    this.holdToRedo(this.btn.undo);
    this.padSweep();
    this.guessMenu = this.buildGuessMenu();
    // Lives in the tools row so it can pop up just above it.
    tools.appendChild(this.guessMenu);
    root.append(this.message, this.pad, tools);
    this.dialog = this.buildDialog();
    this.optionsDialog = this.buildOptions();
    document.body.appendChild(this.optionsDialog);
    document.body.appendChild(this.dialog);
    // Key hints show while a keyboard or mouse is in use and hide again on touch.
    const desk = (on: boolean) => document.body.classList.toggle('desk-input', on);
    document.addEventListener('keydown', () => desk(true));
    document.addEventListener('pointermove', (e) => e.pointerType === 'mouse' && desk(true));
    document.addEventListener('pointerdown', (e) => desk(e.pointerType === 'mouse'));
    // Tapping anywhere else closes the guess menu.
    document.addEventListener('pointerdown', (e) => {
      if (!this.guessMenu.hidden && !this.guessMenu.contains(e.target as Node) && e.target !== this.btn.guess) this.guessMenu.hidden = true;
    });
  }

  /** Tap undoes. Holding for HOLD_MS starts redoing, repeating every REPEAT_MS while held. */
  private holdToRedo(b: HTMLButtonElement): void {
    const HOLD_MS = 500;
    const REPEAT_MS = 250;
    let timer = 0;
    let repeat = 0;
    let pressed = false;
    let redoing = false;
    const stop = () => {
      clearTimeout(timer);
      clearInterval(repeat);
      pressed = false;
      b.classList.remove('holding', 'redoing');
      b.textContent = 'Undo';
    };
    b.title = 'Tap to undo, hold to redo';
    b.addEventListener('pointerdown', (e) => {
      if (b.disabled) return;
      pressed = true;
      redoing = false;
      b.classList.add('holding');
      try {
        // Keeps the hold alive if the finger drifts off the button.
        b.setPointerCapture(e.pointerId);
      } catch {
        // Not every pointer can be captured; the hold still works without it.
      }
      timer = window.setTimeout(() => {
        redoing = true;
        b.classList.replace('holding', 'redoing');
        b.textContent = 'Redo';
        this.h.redo();
        repeat = window.setInterval(() => this.h.redo(), REPEAT_MS);
      }, HOLD_MS);
    });
    b.addEventListener('pointerup', () => {
      const tap = pressed && !redoing;
      stop();
      if (tap) this.h.undo();
    });
    b.addEventListener('pointercancel', stop);
    // Stop Android's long-press menu from interrupting the hold.
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    // Keyboard activation (Enter/Space) has no pointer events: treat it as a tap.
    b.onclick = (e) => {
      if (e.detail === 0) this.h.undo();
    };
  }

  private buildGuessMenu(): HTMLElement {
    const m = document.createElement('div');
    m.className = 'guess-menu';
    m.hidden = true;
    // Titles are filled in with the guess number when the menu opens.
    m.innerHTML = `
      <p class="lead"></p>
      <button data-a="keep"><b></b><span>Make these entries normal ones</span></button>
      <button data-a="drop"><b></b><span>Erase everything since this guess started</span></button>
      <button data-a="again"><b></b><span>Guess inside this one, in a new colour</span></button>`;
    const act: Record<string, () => void> = { keep: this.h.keep, drop: this.h.drop, again: this.h.guess };
    m.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.onclick = () => {
        m.hidden = true;
        act[b.dataset.a!]();
      };
    });
    return m;
  }

  private toggleGuessMenu(): void {
    const color = hex(LAYER_COLORS[Math.min(this.layer, LAYER_COLORS.length - 1)]);
    const lead = this.guessMenu.querySelector('.lead')!;
    lead.innerHTML = `Guess ${this.layer}: new entries show in <span class="swatch" style="color:${color}">this colour</span>.`;
    const title = (a: string, text: string) => (this.guessMenu.querySelector(`[data-a=${a}] b`)!.textContent = text);
    title('keep', `Confirm guess ${this.layer}`);
    title('drop', `Undo guess ${this.layer}`);
    title('again', `Start guess ${this.layer + 1}`);
    this.guessMenu.style.setProperty('--layer', color);
    this.guessMenu.hidden = !this.guessMenu.hidden;
  }

  private buildOptions(): HTMLDialogElement {
    const d = document.createElement('dialog');
    d.className = 'options';
    d.innerHTML = `
      <h2>Options</h2>
      <section class="group">
        <h3>Chain reactions</h3>
        <label class="toggle">
          <input type="checkbox" id="opt-chains" name="chains" />
          <span><b>Chain reactions</b><small>A cell down to one maybe fills itself in, and each fill can set off the next. Turn off to fill every cell yourself.</small></span>
        </label>
        <div class="sub">
          <label class="toggle">
            <input type="checkbox" id="opt-fill-last-gap" name="fillLastGap" />
            <span><b>Fill the last cell</b><small>When a row or column has one empty cell left, its missing digit fills in and joins the chain.</small></span>
          </label>
          <label class="toggle">
            <input type="checkbox" id="opt-fill-cage-last" name="fillCageLast" />
            <span><b>Finish cages</b><small>When a cage has one empty cell left and its math allows only one digit there, that digit fills in and joins the chain.</small></span>
          </label>
        </div>
      </section>
      <section class="group">
        <h3>Display</h3>
        <label class="toggle">
          <input type="checkbox" id="opt-mark-bad" name="markBadMaybes" />
          <span><b>Mark impossible maybes</b><small>Maybes turn red when a number already in their row or column rules them out.</small></span>
        </label>
        <fieldset class="speed">
          <legend><b>Chain pace</b><small>How quickly each step of a chain reaction follows the last. 4× is the quickest.</small></legend>
          <div class="segmented">
            <label><input type="radio" id="opt-speed-1" name="animSpeed" value="1" /><span>1×</span></label>
            <label><input type="radio" id="opt-speed-2" name="animSpeed" value="2" /><span>2×</span></label>
            <label><input type="radio" id="opt-speed-4" name="animSpeed" value="4" /><span>4×</span></label>
          </div>
        </fieldset>
        <fieldset class="speed">
          <legend><b>Animation speed</b><small>Slow motion for every effect: pulses, lights, particles and chains.</small></legend>
          <div class="segmented">
            <label><input type="radio" name="timeScale" value="0.25" /><span>0.25×</span></label>
            <label><input type="radio" name="timeScale" value="0.5" /><span>0.5×</span></label>
            <label><input type="radio" name="timeScale" value="1" /><span>1×</span></label>
          </div>
        </fieldset>
      </section>
      <div class="row"><button data-k="done" class="on">Done</button></div>`;
    d.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((box) => {
      box.onchange = () => this.h.optionsChanged({ ...this.options, [box.name]: box.checked });
    });
    d.querySelectorAll<HTMLInputElement>('input[type=radio]').forEach((radio) => {
      radio.onchange = () => this.h.optionsChanged({ ...this.options, [radio.name]: Number(radio.value) });
    });
    d.querySelector<HTMLButtonElement>('[data-k=done]')!.onclick = () => d.close();
    return d;
  }

  private options: Options = { ...DEFAULT_OPTIONS };

  /** Show the current options in the options page. */
  setOptions(o: Options): void {
    this.options = o;
    this.optionsDialog.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((box) => {
      box.checked = Boolean(o[box.name as keyof Options]);
    });
    this.optionsDialog.querySelectorAll<HTMLInputElement>('input[type=radio]').forEach((radio) => {
      radio.checked = Number(radio.value) === o[radio.name as 'animSpeed' | 'timeScale'];
    });
    // The chain sub-options only mean something while chains are on.
    const sub = this.optionsDialog.querySelector<HTMLElement>('.sub')!;
    sub.classList.toggle('off', !o.chains);
    sub.querySelectorAll<HTMLInputElement>('input').forEach((box) => (box.disabled = !o.chains));
  }

  private buildDialog(): HTMLDialogElement {
    const d = document.createElement('dialog');
    d.className = 'newgame';
    // A row of buttons (radio or checkbox inputs styled as a segmented control).
    const choices = (name: string, items: [string, string, string?][], picked: string[], cls = '', type = 'radio') =>
      `<div class="segmented ${cls}">${items.map(([v, label, extra]) => `<label class="${extra ?? ''}"><input type="${type}" name="${name}" value="${v}" ${picked.includes(v) ? 'checked' : ''} /><span>${label}</span></label>`).join('')}</div>`;
    const presetNames: Record<string, string> = { standard: '1 – n', zeroBased: '0 – n', evens: 'Evens', odds: 'Odds', centered: 'Centered', primes: 'Primes', tens: 'Tens' };
    d.innerHTML = `
      <div class="body">
        <h2>New puzzle</h2>
        <h3>Size</h3>
        ${choices('size', [4, 5, 6, 7, 8, 9].map((n) => [String(n), n === 6 ? `${n}×${n} ★` : `${n}×${n}`]), ['6'], 'sizes')}
        <h3>Difficulty</h3>
        ${choices('rating', ['Easy', 'Medium', 'Hard', 'Expert', 'Fiendish'].map((r) => [r, r, r === 'Fiendish' ? 'fiendish' : '']), ['Medium'], 'five')}
        <fieldset class="more">
          <legend>More options</legend>
          <h3>Digits</h3>
          ${choices('preset', [...Object.keys(DIGIT_PRESETS).map((k): [string, string] => [k, presetNames[k] ?? k]), ['custom', 'Custom']], ['standard'], 'four')}
          <label class="custom-digits" hidden>Your digits (any count, sets the size) <input name="custom" placeholder="e.g. 2, 3, 5, 8, 13" /></label>
          <h3>Operators</h3>
          ${choices('ops', OPS.map((o) => [o.id, o.label]), ['add', 'sub', 'mul', 'div'], 'four', 'checkbox')}
          <label>Seed <input name="seed" placeholder="blank = random" /></label>
          <p class="note">The same seed always makes the same puzzle.</p>
        </fieldset>
      </div>
      <div class="row foot"><button data-k="cancel">Cancel</button><button data-k="go" class="on">Generate</button></div>`;
    const val = (name: string) => ((d.querySelector(`[name=${name}]:checked`) ?? d.querySelector(`[name=${name}]`)) as HTMLInputElement).value.trim();
    // "Custom" in Digits opens the box for your own digits right under the row.
    const customBox = d.querySelector<HTMLElement>('.custom-digits')!;
    d.querySelectorAll<HTMLInputElement>('[name=preset]').forEach((r) => {
      r.onchange = () => {
        customBox.hidden = val('preset') !== 'custom';
        if (!customBox.hidden) customBox.querySelector('input')!.focus();
      };
    });
    const submit = () => {
      let digits: DigitSet;
      let size = Number(val('size'));
      try {
        if (val('preset') === 'custom') {
          const values = val('custom').split(/[\s,]+/).filter(Boolean).map(Number);
          digits = makeDigitSet(values);
          size = values.length;
        } else digits = DIGIT_PRESETS[val('preset')](size);
      } catch (e) {
        d.close();
        this.say(`Couldn't use those digits: ${e instanceof Error ? e.message : e}`, 'error');
        return;
      }
      const picked = [...d.querySelectorAll<HTMLInputElement>('[name=ops]:checked')].map((b) => b.value);
      const operators = OPS.filter((o) => picked.includes(o.id)).map(({ id, weight }) => ({ id, weight }));
      if (!operators.length) {
        this.say('Pick at least one operator.', 'error');
        return;
      }
      this.h.newGame({
        size, digits, operators,
        seed: val('seed') || Math.random().toString(36).slice(2),
        ratings: [val('rating') as Rating],
      });
      d.close();
    };
    d.querySelector<HTMLButtonElement>('[data-k=go]')!.onclick = () => submit();
    d.querySelector<HTMLButtonElement>('[data-k=cancel]')!.onclick = () => d.close();
    return d;
  }

  setDigits(labels: string[]): void {
    this.pad.innerHTML = '';
    // Same rows and columns as the maybes inside a cell: [1 2 3] / [4 5 6].
    const letters = digitLetters(labels.length);
    this.padButtons = labels.map((label, d) => {
      const b = document.createElement('button');
      b.textContent = label;
      // Faint keyboard hint in the corner; CSS shows it only once a keyboard or mouse is in use.
      if (letters[d]) {
        const hint = document.createElement('span');
        hint.className = 'key';
        hint.textContent = letters[d]!.toUpperCase();
        hint.setAttribute('aria-hidden', 'true');
        b.appendChild(hint);
        b.setAttribute('aria-keyshortcuts', letters[d]!.toUpperCase());
      }
      b.dataset.d = String(d);
      // A tap enters the digit; a sweep across several digits is handled by padSweep instead.
      b.onclick = () => (this.swept ? (this.swept = false) : this.h.digit(d));
      this.pad.appendChild(b);
      return b;
    });
    // An extra column on the right: Undo beside the first row of digits, Clear beside the second.
    const cols = noteColumns(labels.length);
    this.pad.style.gridTemplateColumns = `repeat(${cols}, 1fr) 1.1fr`;
    this.btn.undo.style.gridColumn = this.btn.erase.style.gridColumn = String(cols + 1);
    this.btn.undo.style.gridRow = '1';
    this.btn.erase.style.gridRow = '2';
    this.pad.append(this.btn.undo, this.btn.erase);
  }

  /** Set while a pad sweep's trailing click must be ignored. */
  private swept = false;

  /**
   * Sliding a finger from one digit onto others sweeps them: maybe mode turns on and each digit is
   * added as a maybe the moment it's reached. A press and release on one digit is a normal tap.
   */
  private padSweep(): void {
    let sweep: { digits: number[]; active: boolean } | null = null;
    const digitAt = (e: PointerEvent): number => {
      const b = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('button[data-d]');
      return b && this.pad.contains(b) ? Number(b.dataset.d) : -1;
    };
    this.pad.addEventListener('pointerdown', (e) => {
      const d = digitAt(e);
      if (d < 0) return;
      sweep = { digits: [d], active: false };
      this.swept = false;
      this.padButtons[d]?.classList.add('pressed');
    });
    // On the document, so the sweep follows the finger anywhere (no pointer capture: it would steal
    // the click a plain tap needs).
    document.addEventListener('pointermove', (e) => {
      const d = sweep ? digitAt(e) : -1;
      if (!sweep || d < 0 || sweep.digits.includes(d)) return;
      sweep.active = true;
      sweep.digits.push(d);
      for (const k of sweep.digits) this.padButtons[k]?.classList.add('swept', 'pressed');
      this.h.sweepStep(sweep.digits);
    });
    const end = () => {
      if (!sweep) return;
      const s = sweep;
      sweep = null;
      for (const b of this.padButtons) b.classList.remove('swept', 'pressed');
      if (!s.active) return;
      // The click that follows this release must not also enter the first digit.
      this.swept = true;
      setTimeout(() => (this.swept = false), 0);
      this.h.sweepEnd();
    };
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
  }

  /** Show the "● Claude" badge while the live link is up. */
  setLinked(on: boolean): void {
    this.el.ownerDocument.querySelector<HTMLElement>('.topbar .link')!.hidden = !on;
  }

  setMeta(text: string): void {
    this.meta.textContent = text;
  }

  setTime(seconds: number): void {
    const m = Math.floor(seconds / 60);
    this.timerEl.textContent = `${m}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  }

  say(text: string, kind: '' | 'hint' | 'error' | 'win' | 'math' = ''): void {
    // A bug report stays up until it has been copied.
    if (this.message.classList.contains('bug') && !this.message.classList.contains('copied')) return;
    this.message.textContent = text;
    this.message.className = kind;
  }

  /** A maths result, centred: a big leading number and the rest after it (e.g. "24" "= 2³ × 3"). */
  sayMath(lead: string, rest: string, o: { negative?: boolean; note?: string } = {}): void {
    if (this.message.classList.contains('bug') && !this.message.classList.contains('copied')) return;
    this.message.className = 'math';
    const line = Object.assign(document.createElement('div'), { className: 'line' });
    line.append(
      Object.assign(document.createElement('span'), { className: o.negative ? 'lead negative' : 'lead', textContent: lead }),
      Object.assign(document.createElement('span'), { className: 'rest', textContent: rest }),
    );
    this.message.replaceChildren(line);
    if (o.note) this.message.append(Object.assign(document.createElement('div'), { className: 'note', textContent: o.note }));
  }

  /** Show a code error in the message pane, glowing red. Tapping it selects all of it and copies it. */
  reportBug(text: string): void {
    this.message.textContent = text;
    this.message.className = 'bug';
    this.message.title = 'Tap to copy';
    this.message.onclick = () => {
      const range = document.createRange();
      range.selectNodeContents(this.message);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      navigator.clipboard?.writeText(text).catch(() => {
        // Clipboard can be blocked; the text is selected, so the system copy still works.
      });
      this.message.classList.add('copied');
    };
  }

  sync(s: { notesMode: boolean; layer: number; cellNotes: number; canUndo: boolean; canRedo: boolean }): void {
    this.pad.classList.toggle('notes', s.notesMode);
    this.padButtons.forEach((b, d) => b.classList.toggle('has', s.notesMode && (s.cellNotes & (1 << d)) !== 0));
    // Stays enabled while there is something to redo (hold), even with nothing left to undo.
    this.btn.undo.disabled = !s.canUndo && !s.canRedo;
    if (s.layer === 0) this.guessMenu.hidden = true;
    this.layer = s.layer;
    // Idle: shows the colour a new guess will use. Guessing: shows the current guess colour, filled.
    const color = hex(LAYER_COLORS[Math.min(Math.max(1, s.layer), LAYER_COLORS.length - 1)]);
    this.btn.guess.textContent = s.layer ? `Guess ${s.layer} ▾` : 'Guess';
    this.btn.guess.classList.toggle('guessing', s.layer > 0);
    this.btn.guess.style.setProperty('--layer', color);
  }
}
