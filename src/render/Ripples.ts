// Water ripples, shared by the background shader and the board's lighting pass so a wave crosses both
// seamlessly. A ripple starts from a shape (a point for a drop, a cage's outline for a cage pulse) and
// travels outward from it as a short packet of signed waves: crests and troughs, so ripples that meet
// interfere. It slows its fade as it spreads and refracts whatever is under it.

import { UniformGroup } from 'pixi.js';

// ponytail: the shaders loop over every slot for every pixel (the background is full screen), and the
// board pass holds these plus the lights (~240 vec4 uniforms; many phones allow 256). Raise only with
// a phone check, or move segments to a data texture. Cages with more outline segments ripple from a point.
export const RIP_MAX = 20, RIP_SEGS = 6;
// Sizes are for a 56px cell; everything scales with the board (Ripples.scale) so ripples look the
// same at any page size.
const SPEED = 300; // px per second
const LIFE = 1.8; // seconds

/**
 * GLSL: ripples(p, tint) at global pixel p returns xy = slope of the water surface, z = its height; tint
 * is the colour its crests catch there (the default blue, or the ripples' own colours blended).
 */
export const RIPPLE_GLSL = `
uniform vec4 uRSeg[${RIP_MAX * RIP_SEGS}];
uniform vec4 uRip[${RIP_MAX}];
uniform float uRipCount;
uniform float uRipScale;
vec3 ripples(vec2 p, out vec3 tint) {
  float W = 13.0 * uRipScale;            // packet half-width
  float K = 6.2831853 / (24.0 * uRipScale); // wavelength 24px
  vec3 acc = vec3(0.0);
  vec3 tintSum = vec3(0.0);
  float tintW = 0.0;
  float best = 1e12;
  vec2 q = p;
  bool inside = false;
  for (int s = 0; s < ${RIP_MAX}; s++) {
    if (float(s) >= uRipCount) break;
    // segment count (negative: continues the previous slot's shape), colour (0xRRGGBB as a float,
    // 0 = default), front distance, amplitude
    vec4 rp = uRip[s];
    for (int i = 0; i < ${RIP_SEGS}; i++) {
      if (float(i) >= abs(rp.x)) break;
      vec4 sg = uRSeg[s * ${RIP_SEGS} + i];
      vec2 ab = sg.zw - sg.xy;
      float t = clamp(dot(p - sg.xy, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
      vec2 c = sg.xy + ab * t;
      float d2 = dot(p - c, p - c);
      if (d2 < best) { best = d2; q = c; }
      if ((sg.y > p.y) != (sg.w > p.y) && p.x < sg.x + (p.y - sg.y) * ab.x / ab.y) inside = !inside;
    }
    // The shape goes on in the next slot: shade it once, after all of its segments.
    if (s + 1 < ${RIP_MAX} && float(s + 1) < uRipCount && uRip[s + 1].x < 0.0) continue;
    float d = sqrt(best);
    vec2 qn = q;
    bool wasInside = inside;
    best = 1e12;
    q = p;
    inside = false;
    float x = d - rp.z;
    // Waves only travel outward from a shape.
    if (wasInside || abs(x) > W * 3.5) continue;
    float env = exp(-x * x / (2.0 * W * W));
    float ph = x * K;
    float h = rp.w * env * cos(ph);
    float dh = rp.w * env * (-K * sin(ph) - x / (W * W) * cos(ph));
    vec2 dir = d > 0.001 ? (p - qn) / d : vec2(0.0);
    acc += vec3(dir * dh * uRipScale, h);
    vec3 col = rp.y > 0.0
      ? vec3(floor(rp.y / 65536.0), mod(floor(rp.y / 256.0), 256.0), mod(rp.y, 256.0)) / 255.0
      : vec3(0.4, 0.78, 1.0);
    float w = abs(h) + 1e-4;
    tintSum += col * w;
    tintW += w;
  }
  tint = tintW > 0.0 ? tintSum / tintW : vec3(0.4, 0.78, 1.0);
  return acc;
}`;

interface Ripple {
  segs: number[][];
  age: number;
  strength: number;
  key?: string;
  /** 0xRRGGBB its crests catch, 0 for the default blue. */
  color: number;
}

export class Ripples {
  readonly group = new UniformGroup({
    uRSeg: { value: new Float32Array(RIP_MAX * RIP_SEGS * 4), type: 'vec4<f32>', size: RIP_MAX * RIP_SEGS },
    uRip: { value: new Float32Array(RIP_MAX * 4), type: 'vec4<f32>', size: RIP_MAX },
    uRipCount: { value: 0, type: 'f32' },
    uRipScale: { value: 1, type: 'f32' },
  });
  /** Board cell size / 56: ripple size, speed and refraction scale with it. */
  scale = 1;
  private list: Ripple[] = [];

  /**
   * Start a ripple from `segs` (global px [x1, y1, x2, y2]; one zero-length segment is a drop). A
   * ripple with the same `key` that only just started is strengthened instead of doubled.
   */
  add(segs: number[][], strength: number, key?: string, color = 0): void {
    const twin = key && this.list.find((r) => r.key === key && r.age < 0.35);
    if (twin) {
      twin.strength = Math.min(1.6, Math.max(twin.strength, strength) + strength * 0.25);
      return;
    }
    // ponytail: past 4 slots' worth of edges, a shape ripples from its centre as a drop.
    if (segs.length > RIP_SEGS * 4) {
      const xs = segs.map((s) => s[0]), ys = segs.map((s) => s[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      segs = [[cx, cy, cx, cy]];
    }
    this.list.push({ segs, age: 0, strength, key, color });
    if (this.list.length > RIP_MAX) this.list.shift();
  }

  /** Drop ripples that only just started (e.g. so a bigger one can replace them). */
  dropNew(): void {
    this.list = this.list.filter((r) => r.age > 0.1);
  }

  get active(): boolean {
    return this.list.length > 0;
  }

  update(dt: number): void {
    this.list = this.list.filter((r) => (r.age += dt) < LIFE);
    const u = this.group.uniforms as { uRSeg: Float32Array; uRip: Float32Array; uRipCount: number; uRipScale: number };
    u.uRipScale = this.scale;
    // RIP_SEGS edges per slot; a longer outline continues in the following slots (newest ripples
    // win when slots run out).
    let s = 0;
    for (const r of [...this.list].reverse()) {
      const slots = Math.ceil(r.segs.length / RIP_SEGS);
      if (s + slots > RIP_MAX) continue;
      const front = r.age * SPEED * this.scale;
      // Fades over its life and as it spreads out.
      const amp = r.strength * (1 - r.age / LIFE) ** 2 / (1 + front / (160 * this.scale));
      for (let k = 0; k < slots; k++, s++) {
        const part = r.segs.slice(k * RIP_SEGS, (k + 1) * RIP_SEGS);
        part.forEach((seg, i) => u.uRSeg.set(seg, (s * RIP_SEGS + i) * 4));
        u.uRip.set([k > 0 ? -part.length : part.length, r.color, front, amp], s * 4);
      }
    }
    u.uRipCount = s;
    this.group.update();
  }
}
