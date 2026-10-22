// Full-screen animated background drawn by one fragment shader (single draw call, no render texture).
// It owns the scene's water ripples (see Ripples); they are drawn by the scene-wide pass in Lighting,
// so they cross the board and the background as one surface.

import { Geometry, Mesh, Shader } from 'pixi.js';
import { Ripples } from './Ripples';

const vertex = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}`;

const fragment = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform float uTime;
uniform float uEnergy;
uniform float uMaybe;
uniform vec2 uResolution;
// Lightning behind the clouds: xy = where (px), z = brightness now; and its colour.
uniform vec4 uFlash;
uniform vec3 uFlashColor;
uniform float uClouds;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}
void main() {
  vec2 px = vUV * uResolution;
  vec2 p = px / min(uResolution.x, uResolution.y);
  float t = uTime * 0.09;
  // One layer of flow warping the fog, so it rolls and folds rather than sliding.
  vec2 q = vec2(fbm(p * 2.0 + vec2(t, -t * 0.7)), fbm(p * 2.0 + vec2(-t * 0.8, t) + 3.7));
  float n = fbm(p * 2.5 + q * 1.8 + t * 0.3);
  vec3 deep = vec3(0.02, 0.02, 0.07);
  vec3 violet = vec3(0.30, 0.10, 0.52);
  vec3 teal = vec3(0.03, 0.42, 0.56);
  vec3 col = mix(deep, violet, smoothstep(0.3, 0.85, n));
  col = mix(col, teal, smoothstep(0.5, 0.95, q.x) * 0.65);
  // Bright folds where the fog is thickest.
  col += vec3(0.16, 0.12, 0.32) * pow(n, 4.0) * 2.2;
  // Maybe mode: lean the palette violet.
  col = mix(col, col * vec3(1.45, 0.95, 0.5) + vec3(0.06, 0.025, 0.0), uMaybe);
  col *= 0.85 + 0.35 * uEnergy;
  // Lightning: lights the clouds from behind, brightest where the fog is thick.
  if (uFlash.z > 0.0) {
    float d = length(px - uFlash.xy) / min(uResolution.x, uResolution.y);
    col += uFlashColor * uFlash.z * exp(-d * d * 5.0) * (0.15 + 2.2 * n * n);
  }
  // Clouds hidden (H key): just the deep backdrop.
  col = mix(deep, col, uClouds);
  // Horizontal vignette: the sides fade darker, off toward the screen edges.
  float side = min(vUV.x, 1.0 - vUV.x);
  col *= mix(0.4, 1.0, smoothstep(0.0, 0.22, side));
  float vig = smoothstep(1.3, 0.3, length(vUV - 0.5) * 1.6);
  finalColor = vec4(col * vig, 1.0);
}`;

export class Background {
  readonly mesh: Mesh<Geometry, Shader>;
  readonly ripples = new Ripples();
  private uniforms: { uTime: number; uEnergy: number; uMaybe: number; uResolution: Float32Array; [k: string]: unknown };
  energy = 0;
  /** 0..1 maybe-mode tint, set by the board. */
  maybe = 0;
  time = 0;
  /** The current lightning strike (or the wait until the next one). */
  private bolt = { wait: 3, age: -1, x: 0, y: 0, pattern: [] as [number, number][] };

  constructor() {
    const geometry = new Geometry({
      attributes: {
        aPosition: [0, 0, 1, 0, 1, 1, 0, 1],
        aUV: [0, 0, 1, 0, 1, 1, 0, 1],
      },
      indexBuffer: [0, 1, 2, 0, 2, 3],
    });
    const shader = Shader.from({
      gl: { vertex, fragment },
      resources: {
        bgUniforms: {
          uTime: { value: 0, type: 'f32' },
          uEnergy: { value: 0, type: 'f32' },
          uMaybe: { value: 0, type: 'f32' },
          uResolution: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
          uFlash: { value: new Float32Array([0, 0, 0, 0]), type: 'vec4<f32>' },
          uFlashColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          // On by default; H cycles them with the board fog.
          uClouds: { value: 1, type: 'f32' },
        },
      },
    });
    this.mesh = new Mesh({ geometry, shader });
    this.uniforms = shader.resources.bgUniforms.uniforms;
  }

  /** Show or hide the clouds (H key, with the board fog). */
  setClouds(on: boolean): void {
    this.uniforms.uClouds = on ? 1 : 0;
  }

  resize(w: number, h: number): void {
    this.mesh.scale.set(w, h);
    this.uniforms.uResolution[0] = w;
    this.uniforms.uResolution[1] = h;
  }

  /** A water drop at x, y (screen pixels). */
  shock(x: number, y: number, strength: number): void {
    this.ripples.add([[x, y, x, y]], strength);
  }

  /** Low graphics: the clouds hold still. */
  still = false;

  update(dt: number): void {
    if (!this.still) this.time += dt;
    this.ripples.update(dt);
    this.energy *= Math.exp(-dt * 1.5);
    this.uniforms.uTime = this.time;
    this.uniforms.uEnergy = Math.min(1.5, this.energy);
    this.uniforms.uMaybe = this.maybe;
    this.lightning(dt);
  }

  /**
   * Every few seconds a strike lights the clouds somewhere: white-pink or yellow, a quick flicker of
   * one to three pulses, like lightning behind thick cloud.
   */
  private lightning(dt: number): void {
    const b = this.bolt;
    const flash = this.uniforms.uFlash as Float32Array;
    if (b.age < 0) {
      b.wait -= dt;
      flash[2] = 0;
      if (b.wait > 0) return;
      const w = this.uniforms.uResolution[0], h = this.uniforms.uResolution[1];
      b.x = w * (0.1 + Math.random() * 0.8);
      b.y = h * (0.05 + Math.random() * 0.9);
      b.age = 0;
      // [start s, strength] pulses.
      const pulses = 1 + Math.floor(Math.random() * 3);
      b.pattern = Array.from({ length: pulses }, (_, i) => [i * (0.09 + Math.random() * 0.12), (i ? 0.5 : 1) * (0.5 + Math.random() * 0.5)] as [number, number]);
      const col = this.uniforms.uFlashColor as Float32Array;
      col.set(Math.random() < 0.5 ? [1, 0.82, 0.95] : [1, 0.92, 0.45]);
    }
    b.age += dt;
    // Each pulse: instant on, fast decay.
    let level = 0;
    for (const [at, k] of b.pattern) if (b.age >= at) level = Math.max(level, k * Math.exp(-(b.age - at) / 0.06));
    flash[0] = b.x;
    flash[1] = b.y;
    flash[2] = level * 0.9;
    if (b.age > (b.pattern.at(-1)?.[0] ?? 0) + 0.4) {
      b.age = -1;
      b.wait = 3 + Math.random() * 7;
    }
  }
}
