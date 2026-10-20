// Pooled GPU-batched particles: one ParticleContainer, additive blending, one shared glow texture.

import { Particle, ParticleContainer, Texture } from 'pixi.js';

interface Live {
  p: Particle;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  spin: number;
  drag: number;
  gravity: number;
  streak: number;
}

export interface BurstOptions {
  count: number;
  colors: number[];
  speed: [number, number];
  life: [number, number];
  size: [number, number];
  gravity?: number;
  drag?: number;
  /** Spawn radius around the point. */
  radius?: number;
  /** Spawn on the rim (at `radius`) and fly toward the point instead of away from it. */
  inward?: boolean;
  /** Stretch each particle along its velocity into a short trail (0 = round). */
  streak?: number;
}

function glowTexture(): Texture {
  const s = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const g = canvas.getContext('2d')!;
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  return Texture.from(canvas);
}

const lerp = (r: [number, number]): number => r[0] + Math.random() * (r[1] - r[0]);

export class Particles {
  readonly container: ParticleContainer;
  private texture = glowTexture();
  private live: Live[] = [];
  private pool: Particle[] = [];
  /** Hard cap keeps mobile frame times predictable. */
  maxParticles = 4000;

  constructor() {
    this.container = new ParticleContainer({
      dynamicProperties: { position: true, vertex: true, rotation: true, color: true, uvs: false },
    });
    this.container.blendMode = 'add';
  }

  burst(x: number, y: number, o: BurstOptions): void {
    for (let i = 0; i < o.count && this.live.length < this.maxParticles; i++) {
      const p = this.pool.pop() ?? new Particle({ texture: this.texture, anchorX: 0.5, anchorY: 0.5 });
      const a = Math.random() * Math.PI * 2;
      const sp = lerp(o.speed);
      const r = (o.radius ?? 0) * (o.inward ? 0.85 + 0.15 * Math.random() : Math.random());
      const dir = o.inward ? -1 : 1;
      p.x = x + Math.cos(a) * r;
      p.y = y + Math.sin(a) * r;
      p.tint = o.colors[(Math.random() * o.colors.length) | 0];
      p.alpha = 1;
      const size = lerp(o.size) / 64;
      p.scaleX = p.scaleY = size;
      const life = lerp(o.life);
      this.live.push({ p, vx: dir * Math.cos(a) * sp, vy: dir * Math.sin(a) * sp, life, maxLife: life, size, spin: 0, drag: o.drag ?? 2.2, gravity: o.gravity ?? 0, streak: o.streak ?? 0 });
      p.rotation = 0;
      this.container.addParticle(p);
    }
  }

  update(dt: number): void {
    let w = 0;
    for (let i = 0; i < this.live.length; i++) {
      const l = this.live[i];
      l.life -= dt;
      if (l.life <= 0) {
        this.pool.push(l.p);
        continue;
      }
      const damp = Math.exp(-l.drag * dt);
      l.vx *= damp;
      l.vy = l.vy * damp + l.gravity * dt;
      l.p.x += l.vx * dt;
      l.p.y += l.vy * dt;
      const k = l.life / l.maxLife;
      l.p.alpha = k;
      const s = l.size * (0.4 + 0.6 * k);
      l.p.scaleY = s;
      if (l.streak) {
        // Long while fast, round once air drag has slowed it: reads as a trail behind the speck.
        l.p.rotation = Math.atan2(l.vy, l.vx);
        l.p.scaleX = s * (1 + l.streak * Math.hypot(l.vx, l.vy));
      } else l.p.scaleX = s;
      this.live[w++] = l;
    }
    if (w !== this.live.length) {
      this.live.length = w;
      // Rebuild the child list from live particles (cheaper than many removeParticle calls).
      this.container.particleChildren.length = 0;
      for (const l of this.live) this.container.particleChildren.push(l.p);
      this.container.update();
    }
  }

  get count(): number {
    return this.live.length;
  }
}
