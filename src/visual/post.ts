import type { VisualSettings } from './settings';

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const BRIGHT = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform float uThreshold;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb;
  float l = max(c.r, max(c.g, c.b));
  float w = smoothstep(uThreshold, uThreshold + 0.3, l);
  gl_FragColor = vec4(c * w, 1.0);
}`;

const BLUR = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb * 0.227027;
  c += texture2D(uTex, vUv + uDir * 1.3846153).rgb * 0.3162162;
  c += texture2D(uTex, vUv - uDir * 1.3846153).rgb * 0.3162162;
  c += texture2D(uTex, vUv + uDir * 3.2307692).rgb * 0.0702703;
  c += texture2D(uTex, vUv - uDir * 3.2307692).rgb * 0.0702703;
  gl_FragColor = vec4(c, 1.0);
}`;

const FINAL = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloomA;
uniform sampler2D uBloomB;
uniform vec2 uRes;
uniform float uBloom;
uniform float uDistort;
uniform float uChroma;
uniform float uGrade;
uniform float uBright;
uniform float uContrast;
uniform float uSat;
uniform float uHue;
uniform float uVignette;
uniform float uGrain;
uniform float uScan;
uniform float uTime;

vec2 lens(vec2 uv, float k) {
  vec2 c = uv - 0.5;
  float aspect = uRes.x / uRes.y;
  c.x *= aspect;
  float r2 = dot(c, c) / (0.25 * (aspect * aspect + 1.0));
  vec2 d = c * (1.0 + k * r2);
  if (k > 0.0) d /= (1.0 + k);
  d.x /= aspect;
  return d + 0.5;
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 hueShift(vec3 col, float a) {
  const vec3 k = vec3(0.57735);
  float c = cos(a);
  return col * c + cross(k, col) * sin(a) + k * dot(k, col) * (1.0 - c);
}

void main() {
  vec2 uv = lens(vUv, uDistort);
  vec2 dir = (uv - 0.5);
  float ca = uChroma * 0.012;
  vec3 col;
  col.r = texture2D(uScene, 0.5 + dir * (1.0 + ca)).r;
  col.g = texture2D(uScene, uv).g;
  col.b = texture2D(uScene, 0.5 + dir * (1.0 - ca)).b;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) col = vec3(0.0);
  if (uBloom > 0.0) {
    vec3 b = texture2D(uBloomA, uv).rgb * 0.9 + texture2D(uBloomB, uv).rgb * 1.2;
    col += b * uBloom;
  }
  if (uGrade > 0.5) {
    col *= uBright;
    col = (col - 0.5) * uContrast + 0.5;
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(l), col, uSat);
    if (abs(uHue) > 0.0001) col = hueShift(col, uHue * 6.2831853);
  }
  vec2 vc = vUv - 0.5;
  float vig = smoothstep(0.85, 0.2, length(vc * vec2(1.0, uRes.y / uRes.x) * 1.35));
  col *= mix(1.0, vig, uVignette);
  if (uScan > 0.0) col *= 1.0 - uScan * 0.35 * (0.5 + 0.5 * sin(vUv.y * uRes.y * 1.5708));
  if (uGrain > 0.0) col += (hash(vUv * uRes + fract(uTime) * 91.7) - 0.5) * uGrain * 0.3;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

interface Target {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

/** GPU post-processing. Falls back to a plain 2D copy when WebGL is unavailable. */
export class Post {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private progs: Record<string, { p: WebGLProgram; u: Map<string, WebGLUniformLocation | null> }> = {};
  private sceneTex: WebGLTexture | null = null;
  private targets: Target[] = [];
  private tw = 0;
  private th = 0;
  private time = 0;
  /** The GPU dropped the context (driver reset, too many tabs…); wait for it to come back. */
  private lost = false;

  constructor() {
    this.canvas = document.createElement('canvas');
    try {
      this.gl = this.canvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      }) as WebGLRenderingContext | null;
      if (this.gl) this.init(this.gl);
    } catch {
      // A canvas that already has a WebGL context can't give a 2D one: start over on a fresh canvas.
      this.gl = null;
      this.canvas = document.createElement('canvas');
    }
    if (!this.gl) {
      this.ctx2d = this.canvas.getContext('2d');
      return;
    }
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); // allows the browser to restore it
      this.lost = true;
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      const gl = this.gl;
      if (!gl) return;
      this.progs = {};
      this.targets = [];
      this.tw = 0;
      this.th = 0;
      try {
        this.init(gl);
        this.lost = false;
      } catch {
        /* stay paused on the last frame */
      }
    });
  }

  get webgl(): boolean {
    return !!this.gl;
  }

  private init(gl: WebGLRenderingContext): void {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    for (const [name, src] of Object.entries({ bright: BRIGHT, blur: BLUR, final: FINAL })) {
      const p = this.program(gl, VERT, src);
      this.progs[name] = { p, u: new Map() };
    }
    this.sceneTex = this.texture(gl);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  }

  private program(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
    return p;
  }

  private texture(gl: WebGLRenderingContext): WebGLTexture {
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private target(gl: WebGLRenderingContext, w: number, h: number): Target {
    const tex = this.texture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, tex, w, h };
  }

  setSize(w: number, h: number): void {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const gl = this.gl;
    if (!gl || (this.tw === w && this.th === h)) return;
    for (const t of this.targets) {
      gl.deleteFramebuffer(t.fb);
      gl.deleteTexture(t.tex);
    }
    const q = [Math.max(1, Math.round(w / 4)), Math.max(1, Math.round(h / 4))];
    const e = [Math.max(1, Math.round(w / 10)), Math.max(1, Math.round(h / 10))];
    this.targets = [this.target(gl, q[0], q[1]), this.target(gl, q[0], q[1]), this.target(gl, e[0], e[1]), this.target(gl, e[0], e[1])];
    this.tw = w;
    this.th = h;
  }

  private use(name: string): { p: WebGLProgram; u: (n: string) => WebGLUniformLocation | null } {
    const gl = this.gl!;
    const prog = this.progs[name];
    gl.useProgram(prog.p);
    return {
      p: prog.p,
      u: (n: string) => {
        if (!prog.u.has(n)) prog.u.set(n, gl.getUniformLocation(prog.p, n));
        return prog.u.get(n)!;
      },
    };
  }

  private draw(target: Target | null): void {
    const gl = this.gl!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? target.w : this.canvas.width, target ? target.h : this.canvas.height);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  render(scene: HTMLCanvasElement, v: VisualSettings, dt: number): void {
    this.time += dt;
    if (!this.gl) {
      if (this.canvas.width !== scene.width || this.canvas.height !== scene.height) this.setSize(scene.width, scene.height);
      this.ctx2d?.drawImage(scene, 0, 0, this.canvas.width, this.canvas.height);
      return;
    }
    if (this.lost || this.gl.isContextLost()) return;
    const gl = this.gl;
    if (this.canvas.width !== scene.width || this.canvas.height !== scene.height || !this.targets.length) this.setSize(scene.width, scene.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, scene);

    const [A, B, C, D] = this.targets;
    const bloom = v.bloom && v.bloomStrength > 0;
    if (bloom) {
      let s = this.use('bright');
      gl.uniform1i(s.u('uTex'), 0);
      gl.uniform1f(s.u('uThreshold'), v.bloomThreshold);
      this.draw(A);
      s = this.use('blur');
      gl.uniform1i(s.u('uTex'), 0);
      const r = 0.6 + v.bloomRadius * 1.6;
      for (let i = 0; i < 2; i++) {
        gl.bindTexture(gl.TEXTURE_2D, A.tex);
        gl.uniform2f(s.u('uDir'), r / A.w, 0);
        this.draw(B);
        gl.bindTexture(gl.TEXTURE_2D, B.tex);
        gl.uniform2f(s.u('uDir'), 0, r / A.h);
        this.draw(A);
      }
      // Wide layer from the quarter-res result.
      gl.bindTexture(gl.TEXTURE_2D, A.tex);
      gl.uniform2f(s.u('uDir'), r / C.w, 0);
      this.draw(D);
      gl.bindTexture(gl.TEXTURE_2D, D.tex);
      gl.uniform2f(s.u('uDir'), 0, r / C.h);
      this.draw(C);
      gl.bindTexture(gl.TEXTURE_2D, C.tex);
      gl.uniform2f(s.u('uDir'), (r * 1.5) / C.w, 0);
      this.draw(D);
      gl.bindTexture(gl.TEXTURE_2D, D.tex);
      gl.uniform2f(s.u('uDir'), 0, (r * 1.5) / C.h);
      this.draw(C);
    }

    const s = this.use('final');
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.uniform1i(s.u('uScene'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, A.tex);
    gl.uniform1i(s.u('uBloomA'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, C.tex);
    gl.uniform1i(s.u('uBloomB'), 2);
    gl.uniform2f(s.u('uRes'), this.canvas.width, this.canvas.height);
    gl.uniform1f(s.u('uBloom'), bloom ? v.bloomStrength * 0.8 : 0);
    const k = v.distortion === 'fisheye' ? v.distortionAmount * 0.6 : v.distortion === 'pincushion' ? -v.distortionAmount * 0.3 : 0;
    gl.uniform1f(s.u('uDistort'), k);
    gl.uniform1f(s.u('uChroma'), v.chroma);
    gl.uniform1f(s.u('uGrade'), v.grade ? 1 : 0);
    gl.uniform1f(s.u('uBright'), v.brightness);
    gl.uniform1f(s.u('uContrast'), v.contrast);
    gl.uniform1f(s.u('uSat'), v.saturation);
    gl.uniform1f(s.u('uHue'), v.hue);
    gl.uniform1f(s.u('uVignette'), v.vignette);
    gl.uniform1f(s.u('uGrain'), v.grain);
    gl.uniform1f(s.u('uScan'), v.scanlines);
    gl.uniform1f(s.u('uTime'), this.time);
    this.draw(null);
    gl.activeTexture(gl.TEXTURE0);
  }
}
