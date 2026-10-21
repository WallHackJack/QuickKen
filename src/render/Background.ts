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
  float t = uTime * 0.05;
  vec2 q = vec2(fbm(p * 2.0 + t), fbm(p * 2.0 - t + 3.7));
  float n = fbm(p * 2.5 + q * 1.5);
  vec3 deep = vec3(0.03, 0.03, 0.09);
  vec3 violet = vec3(0.22, 0.08, 0.38);
  vec3 teal = vec3(0.02, 0.32, 0.42);
  vec3 col = mix(deep, violet, smoothstep(0.35, 0.8, n));
  col = mix(col, teal, smoothstep(0.55, 0.95, q.x) * 0.6);
  // Maybe mode: lean the palette violet.
  col = mix(col, col * vec3(1.45, 0.95, 0.5) + vec3(0.06, 0.025, 0.0), uMaybe);
  col *= 0.85 + 0.35 * uEnergy;
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
        },
      },
    });
    this.mesh = new Mesh({ geometry, shader });
    this.uniforms = shader.resources.bgUniforms.uniforms;
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

  update(dt: number): void {
    this.time += dt;
    this.ripples.update(dt);
    this.energy *= Math.exp(-dt * 1.5);
    this.uniforms.uTime = this.time;
    this.uniforms.uEnergy = Math.min(1.5, this.energy);
    this.uniforms.uMaybe = this.maybe;
  }
}
