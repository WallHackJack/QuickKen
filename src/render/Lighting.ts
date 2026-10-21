// Board lighting: one shader pass over the whole board while any light is alive.
//
// A light is a glowing outline (a list of segments), so its shape is exact and its falloff is computed
// per pixel: no blurred textures, nothing boxy. The board itself is the surface it lights. Its
// brightness is read as height, so digits, maybes, cage borders and cell lines stand up from the dark
// board, and each pixel is shaded from the light's direction (diffuse + a specular glint on the edges
// facing it). Raised strokes near a light catch it and bevel; flat dark board barely does. Bright
// surfaces also reflect the light's own colour, the way glossy grid lines would.
//
// The same lights reach the HUD buttons below the board through CSS (--lx/--ly/--lr/--li/--lc on each
// button; style.css draws a sheen and a brighter rim on the side facing the light).

import { Filter, GlProgram, type Container } from 'pixi.js';
import { RIPPLE_GLSL, type Ripples } from './Ripples';

// ponytail: lights beyond these caps are skipped for that frame; raise with care, the shader loops over both.
// Each light has LIGHT_SEGS fixed segment slots, so a pixel loops over at most MAX_SRC × LIGHT_SEGS
// segments (phones drop the GPU context when a full-screen pass runs too long). Shapes with more
// segments light from their bounding box.
const MAX_SRC = 10, LIGHT_SEGS = 6, MAX_SEG = MAX_SRC * LIGHT_SEGS;

export interface LightSpec {
  /** Board-local segments [x1, y1, x2, y2]. */
  segments: number[][];
  color: number;
  /** Brightness at progress t (0..1). */
  level(t: number): number;
  /** Distance (px) at which the light has fallen to half. */
  radius: number;
  /** For a light that lasts until something ends it (duration Infinity): false removes it. */
  alive?: () => boolean;
}

interface Source extends LightSpec {
  duration: number;
  elapsed: number;
}

const vertex = `in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
void main(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  gl_Position = vec4(position, 0.0, 1.0);
  vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
}`;

// highp: positions are in pixels, and it must match the vertex shader's uInputSize or the program won't link.
const fragment = `precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uSeg[${MAX_SEG}];
uniform vec4 uSrc[${MAX_SRC}];
uniform vec4 uRange[${MAX_SRC}];
uniform float uCount;
uniform float uCell;
${RIPPLE_GLSL}

float lum(vec2 uv) { return dot(texture(uTexture, uv).rgb, vec3(0.3, 0.59, 0.11)); }

void main(void) {
  // Global position in logical pixels: the light and ripple shapes are given in the same space.
  vec2 p = vTextureCoord * uInputSize.xy + uOutputFrame.xy;
  // Ripples refract the whole scene: the grid, digits and nebula under a wave bend with it.
  vec3 ripTint;
  vec3 rip = ripples(p, ripTint);
  vec2 uv = vTextureCoord - rip.xy * 12.0 * uRipScale * uInputSize.zw;
  vec4 base = texture(uTexture, uv);

  // Height = brightness. Its slope gives a surface normal, so strokes have bevelled edges.
  vec2 o = uInputSize.zw * max(1.0, uCell * 0.022);
  vec2 grad = vec2(lum(uv + vec2(o.x, 0.0)) - lum(uv - vec2(o.x, 0.0)), lum(uv + vec2(0.0, o.y)) - lum(uv - vec2(0.0, o.y)));
  vec3 N = normalize(vec3(-grad * 2.4, 1.0));
  float h = dot(base.rgb, vec3(0.3, 0.59, 0.11));
  // Only pixels of a stroke (digits, text, lines) are a lit surface. The slope also exists on the dark
  // pixels just outside a stroke; lighting those drew a rim a pixel or two off every glyph.
  float stroke = smoothstep(0.12, 0.45, h);

  vec3 diff = vec3(0.0), spec = vec3(0.0), halo = vec3(0.0);
  for (int s = 0; s < ${MAX_SRC}; s++) {
    if (float(s) >= uCount) break;
    vec4 src = uSrc[s];   // rgb * level, radius
    vec4 rg = uRange[s];  // segment count, unused, light height, halo width
    float best = 1e12;
    vec2 q = p;
    bool inside = false;
    // (WebGL only allows loop counters as array indices, so walk from 0 and skip earlier lights' segments.)
    for (int i = 0; i < ${LIGHT_SEGS}; i++) {
      if (float(i) >= rg.x) break;
      vec4 sg = uSeg[s * ${LIGHT_SEGS} + i];
      vec2 ab = sg.zw - sg.xy;
      float t = clamp(dot(p - sg.xy, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
      vec2 c = sg.xy + ab * t;
      float d2 = dot(p - c, p - c);
      if (d2 < best) { best = d2; q = c; }
      // Crossing test: segments form closed loops, so this tells whether p is inside the outline.
      if ((sg.y > p.y) != (sg.w > p.y) && p.x < sg.x + (p.y - sg.y) * ab.x / ab.y) inside = !inside;
    }
    float r = src.w;
    // Smooth inverse-square falloff that ends cleanly instead of fogging the whole board. The light
    // shines outward from the outline: inside it, it's much weaker.
    float att = 1.0 / (1.0 + best / (r * r));
    att *= (1.0 - smoothstep(r * 2.0, r * 4.5, sqrt(best))) * (inside ? 0.35 : 1.0);
    // The light hangs just above the board; shade toward its nearest point.
    vec3 L = normalize(vec3(q - p, rg.z));
    diff += src.rgb * att * max(dot(N, L), 0.0);
    vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
    spec += src.rgb * att * pow(max(dot(N, H), 0.0), 16.0);
    halo += src.rgb * exp(-best / (2.0 * rg.w * rg.w)) * (inside ? 0.3 : 1.0);
  }

  // Strokes are glossy: they reflect mostly the light's colour, not their own. The dark board only
  // picks up a little of it.
  vec3 albedo = mix(base.rgb, vec3(h), 0.6 * stroke);
  vec3 lit = base.rgb + albedo * diff * (0.6 + 1.4 * stroke) + spec * 0.9 * stroke * h + halo * 0.35;
  // Crests catch light, troughs fall into shade, and slopes facing the top-left glint.
  lit *= 1.0 + rip.z * 0.25;
  lit += ripTint * (max(rip.z, 0.0) * 0.12 + max(dot(rip.xy, vec2(-0.7, -0.7)), 0.0) * 0.8);
  // Over-bright light runs to white instead of clipping to a flat colour.
  lit += max(max(max(lit.r, lit.g), lit.b) - 1.0, 0.0) * 0.6;
  // Alpha stays the board's: off the board the halo is purely additive.
  finalColor = vec4(min(lit, vec3(1.0)), base.a);
}`;

/** A light's segments, or its bounding box when it has more than LIGHT_SEGS. */
function fitSegments(segs: number[][]): number[][] {
  if (segs.length <= LIGHT_SEGS) return segs;
  const xs = segs.flatMap((s) => [s[0], s[2]]), ys = segs.flatMap((s) => [s[1], s[3]]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]];
}

export class Lighting {
  private filter: Filter;
  private u: { uSeg: Float32Array; uSrc: Float32Array; uRange: Float32Array; uCount: number; uCell: number };
  private sources: Source[] = [];
  private cs = 40;
  private buttons: HTMLElement[] = [];

  /**
   * `target` is the whole scene (background + board), so lights and ripples are drawn once over both
   * and spill from the board into the background exactly. Light shapes are given in `space` (board)
   * coordinates.
   */
  constructor(private target: Container, private space: Container, private canvas: HTMLCanvasElement, private hud: HTMLElement, private ripples: Ripples) {
    this.filter = new Filter({
      glProgram: GlProgram.from({ vertex, fragment, name: 'board-lighting' }),
      resources: {
        ripples: ripples.group,
        light: {
          uSeg: { value: new Float32Array(MAX_SEG * 4), type: 'vec4<f32>', size: MAX_SEG },
          uSrc: { value: new Float32Array(MAX_SRC * 4), type: 'vec4<f32>', size: MAX_SRC },
          uRange: { value: new Float32Array(MAX_SRC * 4), type: 'vec4<f32>', size: MAX_SRC },
          uCount: { value: 0, type: 'f32' },
          uCell: { value: 40, type: 'f32' },
        },
      },
      resolution: 'inherit',
    });
    this.u = this.filter.resources.light.uniforms;
  }

  /** Board cell size, which scales light reach and the bevel. */
  build(cs: number): void {
    this.cs = cs;
    this.u.uCell = cs;
  }

  add(spec: LightSpec, duration: number): void {
    this.sources.push({ ...spec, duration, elapsed: 0 });
  }

  clear(): void {
    this.sources = [];
  }

  update(dtMs: number): void {
    // The pass also runs while ripples cross the board, even with no light alive.
    if (!this.sources.length && !this.ripples.active) {
      if (this.target.filters) this.off();
      return;
    }
    if (!this.target.filters) {
      this.target.filters = [this.filter];
      this.buttons = [...this.hud.querySelectorAll<HTMLElement>('button')];
    }
    const { uSeg, uSrc, uRange } = this.u;
    const cs = this.cs;
    const lights: { segs: number[][]; rgb: number[]; level: number }[] = [];
    let src = 0;
    this.sources = this.sources.filter((s) => {
      s.elapsed += dtMs;
      const t = Math.min(1, s.elapsed / s.duration);
      const level = s.level(t);
      if (src < MAX_SRC && level > 0.001) {
        const rgb = [(s.color >> 16) / 255, ((s.color >> 8) & 255) / 255, (s.color & 255) / 255];
        const segs: number[][] = [];
        for (const [x1, y1, x2, y2] of fitSegments(s.segments)) {
          const a = this.space.toGlobal({ x: x1, y: y1 }), b = this.space.toGlobal({ x: x2, y: y2 });
          uSeg.set([a.x, a.y, b.x, b.y], (src * LIGHT_SEGS + segs.length) * 4);
          segs.push([a.x, a.y, b.x, b.y]);
        }
        uSrc.set([rgb[0] * level, rgb[1] * level, rgb[2] * level, s.radius], src * 4);
        uRange.set([segs.length, 0, cs * 0.3, cs * 0.2], src * 4);
        src++;
        lights.push({ segs, rgb, level });
      }
      return t < 1 && (s.alive?.() ?? true);
    });
    this.u.uCount = src;
    this.lightButtons(lights);
  }

  private off(): void {
    this.target.filters = null;
    for (const b of this.buttons) b.style.removeProperty('--li');
    this.buttons = [];
  }

  /** Light the HUD buttons from the same lights: where on each button the light lands, and how much. */
  private lightButtons(lights: { segs: number[][]; rgb: number[]; level: number }[]): void {
    const view = this.canvas.getBoundingClientRect();
    const reach = this.cs * 1.4;
    // Read every rect before writing any style, so the browser lays out once.
    const rects = this.buttons.map((b) => b.getBoundingClientRect());
    rects.forEach((r, k) => {
      let sum = 0, lx = 0, ly = 0;
      const rgb = [0, 0, 0];
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      for (const light of lights) {
        // Nearest point of the light to the button, then the spot on the button nearest to that.
        let best = Infinity, qx = 0, qy = 0;
        for (const [x1, y1, x2, y2] of light.segs) {
          const ax = x1 + view.left, ay = y1 + view.top, dx = x2 - x1, dy = y2 - y1;
          const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / Math.max(dx * dx + dy * dy, 1e-4)));
          const px = ax + dx * t, py = ay + dy * t;
          const ex = Math.max(r.left, Math.min(r.right, px)), ey = Math.max(r.top, Math.min(r.bottom, py));
          const d2 = (px - ex) ** 2 + (py - ey) ** 2;
          if (d2 < best) [best, qx, qy] = [d2, ex, ey];
        }
        const w = (light.level * reach * reach) / (reach * reach + best) * (Math.sqrt(best) < reach * 5 ? 1 : 0);
        sum += w;
        lx += (qx - r.left) * w;
        ly += (qy - r.top) * w;
        for (let i = 0; i < 3; i++) rgb[i] += light.rgb[i] * w;
      }
      const s = this.buttons[k].style;
      if (sum < 0.01) return s.removeProperty('--li');
      s.setProperty('--li', Math.min(1, sum).toFixed(3));
      s.setProperty('--lx', `${(lx / sum).toFixed(1)}px`);
      s.setProperty('--ly', `${(ly / sum).toFixed(1)}px`);
      s.setProperty('--lr', `${Math.round(reach * (0.8 + Math.min(1, sum)))}px`);
      s.setProperty('--lc', rgb.map((c) => Math.round(Math.min(1, c / sum) * 255)).join(' '));
    });
  }
}
