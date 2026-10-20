// Tiny ticker-driven tween manager (no dependency).

export type Ease = (t: number) => number;

export const ease = {
  linear: (t: number) => t,
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  inOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: (t: number) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
  outElastic: (t: number) => (t === 0 || t === 1 ? t : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  /** 0 → 1 → 0 */
  pulse: (t: number) => Math.sin(Math.PI * t),
};

interface Tween {
  elapsed: number;
  delay: number;
  duration: number;
  ease: Ease;
  update: (v: number) => void;
  done?: () => void;
  started: boolean;
  start?: () => void;
}

export class Tweens {
  private list: Tween[] = [];

  add(o: { duration: number; delay?: number; ease?: Ease; update: (v: number) => void; start?: () => void; done?: () => void }): void {
    this.list.push({ elapsed: 0, delay: o.delay ?? 0, duration: o.duration, ease: o.ease ?? ease.outCubic, update: o.update, done: o.done, start: o.start, started: false });
  }

  /** Run fn after delay ms. */
  after(delay: number, fn: () => void): void {
    this.add({ duration: 0, delay, update: () => {}, done: fn });
  }

  tick(dtMs: number): void {
    const keep: Tween[] = [];
    // Callbacks may add tweens (they land in the fresh list) or clear everything.
    const list = this.list;
    this.list = [];
    this.cleared = false;
    for (const t of list) {
      try {
        t.elapsed += dtMs;
        const local = t.elapsed - t.delay;
        if (local < 0) {
          keep.push(t);
          continue;
        }
        if (!t.started) {
          t.started = true;
          t.start?.();
        }
        const p = t.duration <= 0 ? 1 : Math.min(1, local / t.duration);
        t.update(t.ease(p));
        if (p < 1) keep.push(t);
        else t.done?.();
      } catch (e) {
        // A broken tween is dropped instead of re-running (and re-throwing) every frame.
        console.error(e);
      }
      if (this.cleared) return;
    }
    this.list = keep.concat(this.list);
  }

  private cleared = false;

  clear(): void {
    this.list = [];
    this.cleared = true;
  }
}
