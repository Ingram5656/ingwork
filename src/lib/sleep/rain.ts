/**
 * 助眠模式：玻璃上的雨。
 *
 * 水是怎么画出来的：
 * - 先在一张看不见的画布上画"水的地图"：每一滴水是一小团边缘柔和的圆，颜色里记着这一点的
 *   水面朝哪边斜。挨得近的几团叠在一起，过了一条线才算有水，所以水滴会自己连成一片、
 *   拉出尾巴、断成一串小水珠，形状不是一个个正圆。
 * - 再交给显卡：有水的地方，按水面的斜度去取窗外的景色，于是每滴水里都是一幅上下颠倒、
 *   缩小了的窗外；边缘压暗，底下一弯亮边，左上一点高光，玻璃上落一点影子。
 * - 玻璃起的雾也在这一层画。水滴滑过的地方雾被擦掉，露出一道清楚的景色，过一阵雾再慢慢起回来。
 *
 * 水是怎么动的：
 * - 细小的水珠落在玻璃上慢慢攒，隔一阵整体缩一点（蒸发）。
 * - 大一点的水滴被雨喂大，挂不住了就往下滑：走走停停，左右微微拐弯，沿路吃掉小水珠越滑越快，
 *   身后拖一条水线，水线很快收细、断开，只剩几颗小水珠留在原地。碰到别的水滴就并成一滴。
 * - 玻璃后面再画几道斜的雨丝。
 * 雨量 0 是晴天：不再落新的雨，玻璃上剩下的水慢慢干掉。
 */

/** 雨量（0–100）的叫法 */
export function rainWord(v: number): string {
  if (v <= 0) return "晴";
  if (v <= 15) return "毛毛雨";
  if (v <= 35) return "小雨";
  if (v <= 60) return "中雨";
  if (v <= 85) return "大雨";
  return "瓢泼大雨";
}

/** 雨量 0–1 → 景色里"雨天版"占多少 */
export const stormMix = (k: number) => {
  const t = Math.min(1, k / 0.85);
  return t * t * (3 - 2 * t);
};
/** 雨量 0–1 → 玻璃起雾的程度 */
export const fogMix = (k: number) => 0.8 * (1 - Math.pow(1 - k, 1.7));

/** 两种画法（显卡 / 不用显卡）共用的接口 */
export interface Glass {
  /** 用的是不是显卡画法。是的话雾也由它来画 */
  readonly gl: boolean;
  /** w、h：窗口的 CSS 尺寸；scale：画布像素比 */
  resize(w: number, h: number, scale: number): void;
  setScene(clear: HTMLCanvasElement, storm: HTMLCanvasElement, fogClear: HTMLCanvasElement, fogStorm: HTMLCanvasElement): void;
  /** 雨量 0–1 */
  setRain(k: number): void;
  /** 雨往哪边斜（度）：负数往左，正数往右 */
  setAngle(deg: number): void;
  /** 窗外是视频时把它交过来（水滴里的折射和雾都跟着视频走）；不是视频传 null */
  setVideo(video: HTMLVideoElement | null): void;
  /** 打一道闪。bolt：要不要画出闪电本身，还是只有一片亮光 */
  flash(bolt: boolean): void;
  start(): void;
  stop(): void;
  /** 关掉助眠模式时调用 */
  dispose(): void;
}

/** 一滴会动的水 */
interface Body {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  /** 上一帧的位置（擦雾用） */
  px: number;
  py: number;
  /** 还要粘多久才开始往下滑（秒） */
  stick: number;
  /** 走走停停：这一段的快慢（0–1）和还剩多久 */
  gait: number;
  gaitLeft: number;
  /** 左右拐：这一段往哪边偏、还剩多久 */
  sway: number;
  swayLeft: number;
  /** 离上一截水线、上一颗留下的水珠各走了多远 */
  film: number;
  bead: number;
  beadAt: number;
  /** 往哪边歪（弧度）：跟着滑的方向走 */
  rot: number;
  /** 旁边粘着的一小团，让静止的水滴不是正圆（相对位置和相对大小） */
  lx: number;
  ly: number;
  lr: number;
}
interface Streak {
  x: number;
  y: number;
  len: number;
  speed: number;
  a: number;
}

/** 水滴小图的边长 */
const SPR = 96;
/** 水的地图上，浓度过了这条线才算有水 */
const EDGE = 0.5;
/** 小图上浓度刚好到 EDGE 的位置（半径的几分之几）：圆润的那种 (1-d²)² = 0.5，平顶的那种 (1-d⁴)² = 0.5 */
const D0 = 0.5412;
const D0_FLAT = 0.7357;
const MAX_BODIES = 380;
/** 折射用的景色贴图（要 2 的整数次幂才能逐级缩小） */
const SCENE_W = 1024;
const SCENE_H = 512;

/**
 * 水滴的小图。透明度是中间实、边缘虚的一团；红、绿两个通道记水面往左右、上下斜多少，蓝记水有多厚。
 * tear > 0 时上半截收窄，像挂在玻璃上往下坠的水滴。
 * flat：中间一片都是实的、边上才陡降。水线用这种：淡下去的时候粗细不怎么变，到头了一截一截地断。
 */
function makeSprite(tear: number, flat = false): HTMLCanvasElement {
  const d0 = flat ? D0_FLAT : D0;
  const cv = document.createElement("canvas");
  cv.width = cv.height = SPR;
  const g = cv.getContext("2d");
  if (!g) return cv;
  const im = g.createImageData(SPR, SPR);
  const p = im.data;
  for (let y = 0; y < SPR; y++) {
    for (let x = 0; x < SPR; x++) {
      let dx = ((x + 0.5) / SPR) * 2 - 1;
      let dy = ((y + 0.5) / SPR) * 2 - 1;
      if (tear > 0) {
        if (dy < 0) dx *= 1 + tear * Math.pow(-dy, 1.4) * 2.2; // 上面尖
        else dy *= 1 + tear * 0.35; // 下面坠得饱满一点
      }
      const d = Math.hypot(dx, dy);
      const i = (y * SPR + x) * 4;
      if (d >= 1) continue;
      const q = flat ? d * d * d * d : d * d;
      const a = (1 - q) * (1 - q);
      let nx = dx / d0;
      let ny = dy / d0;
      let m = Math.hypot(nx, ny);
      if (m > 1) {
        nx /= m;
        ny /= m;
        m = 1;
      }
      // 水滴像一颗小凸透镜：中间看得平一些，越靠边折得越厉害
      const f = 0.55 + 0.45 * m * m;
      p[i] = Math.round((0.5 + 0.5 * nx * f) * 255);
      p[i + 1] = Math.round((0.5 + 0.5 * ny * f) * 255);
      p[i + 2] = Math.round(Math.sqrt(Math.max(0, 1 - m * m)) * 255);
      p[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(im, 0, 0);
  return cv;
}

const VERT = `
attribute vec2 p;
varying vec2 vUv;
void main() {
  vUv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FRAG = (deriv: boolean) => `
${deriv ? "#extension GL_OES_standard_derivatives : enable" : ""}
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv;
uniform sampler2D uWater;   // 水的地图
uniform sampler2D uWipe;    // 雾被擦掉的地方
uniform sampler2D uClear;   // 窗外（晴）
uniform sampler2D uStorm;   // 窗外（雨）
uniform sampler2D uFogA;    // 起雾的玻璃（晴）
uniform sampler2D uFogB;    // 起雾的玻璃（雨）
uniform vec2 uPx;           // 模拟里的一个单位有多大
uniform vec2 uReach;        // 一滴水能把多远的景色折进来
uniform float uMix;         // 雨天版占多少
uniform float uFog;         // 雾有多浓
uniform float uVideo;       // 窗外是视频：只有 uClear 一张，雨天的样子现算
uniform float uFlash;       // 闪电有多亮
uniform vec2 uFlashAt;      // 闪电在哪

// 视频没有单独的雨天版：下雨时压灰、压暗（和界面上给视频加的滤镜一致）
vec3 grade(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return mix(c, vec3(l), 0.5 * uMix) * (1.0 - 0.28 * uMix);
}

vec3 scene(vec2 uv, float bias) {
  uv = clamp(uv, 0.004, 0.996);
  if (uVideo > 0.5) return grade(texture2D(uClear, uv, bias).rgb);
  return mix(texture2D(uClear, uv, bias).rgb, texture2D(uStorm, uv, bias).rgb, uMix);
}

void main() {
  vec4 w = texture2D(uWater, vUv);
  ${deriv ? "float aa = clamp(fwidth(w.a) * 0.8, 0.008, 0.2);" : "float aa = 0.05;"}
  float a = smoothstep(${EDGE.toFixed(2)} - aa, ${EDGE.toFixed(2)} + aa, w.a);

  // 起雾的玻璃；水滴滑过的地方雾被擦掉
  float wipe = texture2D(uWipe, vUv).a;
  float fa = uFog * (1.0 - wipe * 0.94);
  vec3 fog = uVideo > 0.5
    ? grade(texture2D(uClear, vUv, 3.4).rgb) + vec3(0.03, 0.035, 0.045)
    : mix(texture2D(uFogA, vUv).rgb, texture2D(uFogB, vUv).rgb, uMix);
  vec4 o = vec4(fog * fa, fa);

  // 闪电：天一下子亮了，隔着玻璃是一片发白的光，离闪电近的地方更亮
  float glow = 0.0;
  if (uFlash > 0.001) {
    vec2 fd = (vUv - uFlashAt) * vec2(1.5, 1.0);
    glow = uFlash * (0.3 + 0.7 * exp(-dot(fd, fd) * 2.6)) * (1.0 - 0.3 * vUv.y);
    float la = glow * 0.5;
    o = o * (1.0 - la) + vec4(vec3(0.8, 0.86, 1.0) * la, la);
  }

  // 水滴落在玻璃上的一点影子（偏下）
  float up = texture2D(uWater, vUv - vec2(0.0, 1.6) * uPx).a;
  float sh = smoothstep(${(EDGE - 0.24).toFixed(2)}, ${(EDGE + 0.04).toFixed(2)}, up) * 0.3;
  o = o * (1.0 - sh) + vec4(0.0, 0.0, 0.0, sh);

  if (a > 0.003) {
    vec2 n = w.rg * 2.0 - 1.0;
    float thick = w.b;
    // 离水边多远：0 在里面，1 在边上
    float e = 1.0 - smoothstep(${EDGE.toFixed(2)}, ${(EDGE + 0.36).toFixed(2)}, w.a);
    // 透过水看到的窗外：上下左右颠倒、缩小
    vec3 c = scene(vUv - n * uReach * (0.72 + 0.28 * thick), -1.2);
    c = c * 1.28 + 0.01;
    // 边缘暗，顶上更暗
    float rim = e * e;
    c *= 1.0 - rim * (0.5 + 0.34 * clamp(-n.y, 0.0, 1.0));
    // 底下一弯亮边：天上的光从底下透出来
    vec3 sky = scene(vec2(vUv.x, 0.16), 3.0);
    float cres = smoothstep(0.3, 0.95, n.y) * (1.0 - 0.55 * smoothstep(0.75, 1.0, e));
    c += (sky * 1.5 + vec3(0.05, 0.06, 0.09)) * cres * cres * 0.6;
    // 左上一点高光
    float sp = smoothstep(0.24, 0.05, length(n - vec2(-0.34, -0.44)));
    c += vec3(0.82, 0.88, 1.0) * sp * 0.5;
    c = c * (1.0 + 1.3 * glow) + vec3(0.8, 0.86, 1.0) * glow * 0.22;
    o = o * (1.0 - a) + vec4(c * a, a);
  }
  gl_FragColor = o;
}`;

export class RainGlass implements Glass {
  readonly gl = true;
  private g: WebGLRenderingContext;
  private tex: WebGLTexture[] = [];
  private uni: Record<string, WebGLUniformLocation | null> = {};
  private lost = false;

  /** 水的地图：每帧把下面两张和会动的水滴合到这一张上 */
  private map = document.createElement("canvas");
  private mx = this.map.getContext("2d")!;
  /** 攒小水珠的画布 */
  private beads = document.createElement("canvas");
  private bx = this.beads.getContext("2d")!;
  /** 水滴身后拖的水线，很快淡掉 */
  private trail = document.createElement("canvas");
  private tx = this.trail.getContext("2d")!;
  /** 雾被擦掉的地方，慢慢再起回来 */
  private wipe = document.createElement("canvas");
  private wx = this.wipe.getContext("2d")!;
  /** 折射用的缩小景色 */
  private small = [document.createElement("canvas"), document.createElement("canvas")];
  private round = makeSprite(0);
  private tear = makeSprite(0.3);
  private flat = makeSprite(0, true);
  private sx: CanvasRenderingContext2D | null;

  private clear: HTMLCanvasElement | null = null;
  private storm: HTMLCanvasElement | null = null;
  private fogA: HTMLCanvasElement | null = null;
  private fogB: HTMLCanvasElement | null = null;
  private video: HTMLVideoElement | null = null;
  /** 视频的画面已经传给显卡了没有（没有就先用画的景色） */
  private videoUp = false;
  private tick = 0;
  /** 雨丝斜多少（正切值，正数往右）；玻璃上的水滴只跟着歪一半多 */
  private tilt = Math.tan((-8 * Math.PI) / 180);
  /** 闪电：什么时候打的、第二下隔多久、在哪、闪电本身的折线 */
  private flashAt = -1e9;
  private flash2 = 0.15;
  private flashX = 0.5;
  private bolt: number[][] = [];
  /**
   * 模拟用的尺寸。不直接用屏幕像素：按 1440×900 的窗口定大小，窗口大了小了都按比例缩放，
   * 这样水滴相对这扇窗的大小不变（一滴水大约是窗宽的千分之几，和真的窗户差不多）。
   */
  private w = 0;
  private h = 0;
  /** 水的地图、擦雾的画布、雨丝的画布：模拟里的一个单位各是几个点 */
  private ms = 1;
  private wk = 0.25;
  private ss = 1;
  private k = 0;
  private target = 0;
  private bodies: Body[] = [];
  private streaks: Streak[] = [];
  private raf = 0;
  private last = 0;
  private evap = 0;
  private wipeFade = 0;
  private wiped = 0;
  private dryFor = 0;
  private bodyDebt = 0;
  private beadDebt = 0;
  private still = false;
  /** 玻璃上有没有水（落过水珠、还没干透） */
  private wet = false;
  /** 晴天、玻璃也干透了：没有东西要画，循环空转 */
  private idle = false;
  /** 每帧大约花多少毫秒。机器吃力就少画几帧 */
  private cost = 0;

  /** cv：画水滴和雾（显卡）；streakCv：画玻璃后面的雨丝，垫在 cv 下面。显卡起不来会抛错 */
  constructor(private cv: HTMLCanvasElement, private streakCv: HTMLCanvasElement) {
    const g = cv.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
    if (!g) throw new Error("no webgl");
    this.g = g;
    this.sx = streakCv.getContext("2d");
    for (const s of this.small) {
      s.width = SCENE_W;
      s.height = SCENE_H;
    }
    this.still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.initGL();
    cv.addEventListener("webglcontextlost", this.onLost);
    cv.addEventListener("webglcontextrestored", this.onRestored);
  }

  private onLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
  };
  private onRestored = () => {
    try {
      this.initGL();
      this.lost = false;
      this.uploadScene();
      this.idle = false;
    } catch {
      /* 还是起不来就不画水了 */
    }
  };

  private initGL() {
    const g = this.g;
    const deriv = !!g.getExtension("OES_standard_derivatives");
    const compile = (type: number, src: string) => {
      const s = g.createShader(type);
      if (!s) throw new Error("shader");
      g.shaderSource(s, src);
      g.compileShader(s);
      if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s) || "shader");
      return s;
    };
    const prog = g.createProgram();
    if (!prog) throw new Error("program");
    g.attachShader(prog, compile(g.VERTEX_SHADER, VERT));
    g.attachShader(prog, compile(g.FRAGMENT_SHADER, FRAG(deriv)));
    g.linkProgram(prog);
    if (!g.getProgramParameter(prog, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(prog) || "link");
    g.useProgram(prog);
    const buf = g.createBuffer();
    g.bindBuffer(g.ARRAY_BUFFER, buf);
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW);
    const loc = g.getAttribLocation(prog, "p");
    g.enableVertexAttribArray(loc);
    g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0);
    // 六张贴图：水、擦雾、晴、雨、雾（晴）、雾（雨）
    const names = ["uWater", "uWipe", "uClear", "uStorm", "uFogA", "uFogB"];
    this.tex = names.map((name, i) => {
      const t = g.createTexture();
      if (!t) throw new Error("texture");
      g.activeTexture(g.TEXTURE0 + i);
      g.bindTexture(g.TEXTURE_2D, t);
      const mip = i === 2 || i === 3;
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, mip ? g.LINEAR_MIPMAP_LINEAR : g.LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, 1, 1, 0, g.RGBA, g.UNSIGNED_BYTE, new Uint8Array(4));
      g.uniform1i(g.getUniformLocation(prog, name), i);
      return t;
    });
    for (const u of ["uPx", "uReach", "uMix", "uFog", "uVideo", "uFlash", "uFlashAt"]) this.uni[u] = g.getUniformLocation(prog, u);
    g.disable(g.DEPTH_TEST);
    g.disable(g.BLEND);
    g.clearColor(0, 0, 0, 0);
  }

  private put(i: number, src: HTMLCanvasElement, mip = false) {
    const g = this.g;
    g.activeTexture(g.TEXTURE0 + i);
    g.bindTexture(g.TEXTURE_2D, this.tex[i]);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, src);
    if (mip) g.generateMipmap(g.TEXTURE_2D);
  }

  private uploadScene() {
    if (this.lost || !this.clear || !this.storm || !this.fogA || !this.fogB) return;
    if (!this.clear.width || !this.fogA.width) return;
    [this.clear, this.storm].forEach((src, i) => {
      const c = this.small[i].getContext("2d");
      if (!c) return;
      c.imageSmoothingQuality = "high";
      c.drawImage(src, 0, 0, SCENE_W, SCENE_H);
      this.put(2 + i, this.small[i], true);
    });
    this.put(4, this.fogA);
    this.put(5, this.fogB);
  }

  resize(w: number, h: number, scale: number) {
    w = Math.max(1, w);
    h = Math.max(1, h);
    const unit = Math.max(0.7, Math.min(1.6, Math.min(w / 1440, h / 900)));
    this.w = w / unit;
    this.h = h / unit;
    this.cv.width = Math.max(1, Math.round(w * scale));
    this.cv.height = Math.max(1, Math.round(h * scale));
    // 水的地图比屏幕像素略细一点就够，特别大的窗口再缩一点：边缘是显卡算出来的，放大了也是圆滑的
    const fine = Math.min(Math.max(scale, 1), 1.25, Math.sqrt(2.6e6 / (w * h)));
    const mw = Math.max(1, Math.round(w * fine));
    const mh = Math.max(1, Math.round(h * fine));
    for (const c of [this.map, this.beads, this.trail]) {
      c.width = mw;
      c.height = mh;
    }
    this.ms = mw / this.w;
    this.wipe.width = Math.max(1, Math.round(w / 4));
    this.wipe.height = Math.max(1, Math.round(h / 4));
    this.wk = this.wipe.width / this.w;
    this.streakCv.width = Math.max(1, Math.round(w * Math.min(scale, 1)));
    this.streakCv.height = Math.max(1, Math.round(h * Math.min(scale, 1)));
    this.ss = this.streakCv.width / this.w;
    this.bodies = [];
    this.streaks = [];
    this.wiped = 0;
    this.wet = false;
    this.idle = false;
  }

  setScene(clear: HTMLCanvasElement, storm: HTMLCanvasElement, fogClear: HTMLCanvasElement, fogStorm: HTMLCanvasElement) {
    this.clear = clear;
    this.storm = storm;
    this.fogA = fogClear;
    this.fogB = fogStorm;
    this.uploadScene();
    this.videoUp = false; // 窗外是视频的话，下一帧重新取画面
    this.idle = false;
  }

  setRain(k: number) {
    this.target = Math.max(0, Math.min(1, k));
    if (this.target > 0) this.idle = false;
  }

  setAngle(deg: number) {
    this.tilt = Math.tan((Math.max(-45, Math.min(45, deg)) * Math.PI) / 180);
  }

  setVideo(video: HTMLVideoElement | null) {
    this.video = video;
    this.videoUp = false;
    if (!video) this.uploadScene(); // 换回画的景色
    this.idle = false;
  }

  flash(bolt: boolean) {
    this.flashAt = performance.now();
    this.flash2 = 0.12 + Math.random() * 0.14;
    this.flashX = 0.18 + Math.random() * 0.64;
    this.bolt = [];
    if (bolt && !this.still) {
      // 闪电本身：从天上往下的一道折线，中途分一两个叉
      const walk = (x: number, y: number, to: number, step: number, lean: number) => {
        const line = [x, y];
        while (y < to) {
          y += step * (0.6 + Math.random() * 0.8);
          x += (Math.random() - 0.5 + lean) * step * 1.5;
          line.push(x, y);
        }
        return line;
      };
      const main = walk(this.flashX * this.w + (Math.random() - 0.5) * 80, -10, this.h * (0.34 + Math.random() * 0.22), 26, (Math.random() - 0.5) * 0.5);
      this.bolt.push(main);
      for (let i = 0; i < 2; i++) {
        if (Math.random() < 0.35) continue;
        const at = 2 * (2 + Math.floor(Math.random() * Math.max(1, main.length / 2 - 4)));
        if (at + 1 < main.length) this.bolt.push(walk(main[at], main[at + 1], main[at + 1] + 60 + Math.random() * 110, 20, Math.random() < 0.5 ? -0.55 : 0.55));
      }
    }
    this.idle = false;
  }

  /** 这一刻闪电有多亮（0–1）：先猛地一亮，暗下去，隔一两百毫秒又亮一下再慢慢暗 */
  private flashLevel(now: number): number {
    const t = (now - this.flashAt) / 1000;
    if (t < 0 || t > 1.6) return 0;
    if (this.still) return 0.28 * Math.exp(-t / 0.45); // 减弱动态效果：只柔和地亮一下，不闪
    const second = t - this.flash2;
    return Math.min(1, Math.exp(-t / 0.07) + (second > 0 ? 0.85 * Math.exp(-second / 0.2) : 0));
  }

  start() {
    if (this.raf) return;
    this.last = 0;
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      // 大约每秒 30 帧就够了；机器吃力时降到 20 帧、15 帧（减弱动态效果时更慢，只让水珠慢慢攒）
      const gap = this.still ? 480 : this.cost > 22 ? 64 : this.cost > 12 ? 47 : 30;
      if (this.idle || this.lost || !this.w || now - this.last < gap) return;
      const dt = this.last ? Math.min(0.08, (now - this.last) / 1000) : 0.033;
      this.last = now;
      const t0 = performance.now();
      this.step(this.still ? 0.2 : dt);
      this.draw();
      this.cost += (performance.now() - t0 - this.cost) * 0.05;
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  dispose() {
    this.stop();
    this.cv.removeEventListener("webglcontextlost", this.onLost);
    this.cv.removeEventListener("webglcontextrestored", this.onRestored);
    // 退出睡眠模式就把显卡上的东西和这些大画布都还回去，不等垃圾回收
    for (const t of this.tex) this.g.deleteTexture(t);
    this.tex = [];
    this.g.getExtension("WEBGL_lose_context")?.loseContext();
    for (const c of [this.map, this.beads, this.trail, this.wipe, ...this.small, this.cv, this.streakCv]) {
      c.width = 0;
      c.height = 0;
    }
    this.clear = this.storm = this.fogA = this.fogB = null;
    this.video = null;
  }

  // ---------------------------------------------------------------- 模拟

  /** 在某张画布上按一团水（r：看得见的半径；tall：竖着拉长多少；rot：歪多少弧度） */
  private stamp(c: CanvasRenderingContext2D, img: HTMLCanvasElement, x: number, y: number, r: number, tall = 1, rot = 0) {
    const s = this.ms;
    const R = (r / (img === this.flat ? D0_FLAT : D0)) * s;
    this.wet = true;
    if (Math.abs(rot) < 0.02) {
      c.drawImage(img, x * s - R, y * s - R * tall, R * 2, R * 2 * tall);
      return;
    }
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    c.setTransform(cos, sin, -sin, cos, x * s, y * s);
    c.drawImage(img, -R, -R * tall, R * 2, R * 2 * tall);
    c.setTransform(1, 0, 0, 1, 0, 0);
  }

  private erase(c: CanvasRenderingContext2D, x: number, y: number, r: number, scale: number) {
    c.globalCompositeOperation = "destination-out";
    c.beginPath();
    c.arc(x * scale, y * scale, r * scale, 0, Math.PI * 2);
    c.fill();
    c.globalCompositeOperation = "source-over";
  }

  private fade(c: CanvasRenderingContext2D, amount: number) {
    c.globalCompositeOperation = "destination-out";
    c.fillStyle = `rgba(0,0,0,${amount})`;
    c.fillRect(0, 0, c.canvas.width, c.canvas.height);
    c.globalCompositeOperation = "source-over";
    c.fillStyle = "#000";
  }

  private newBody(x: number, y: number, r: number): Body {
    const ang = Math.random() * 6.283;
    const far = 0.35 + Math.random() * 0.4;
    return {
      x,
      y,
      r,
      vx: 0,
      vy: 0,
      px: x,
      py: y,
      stick: 0.5 + Math.random() * 6,
      gait: 1,
      gaitLeft: 0,
      sway: 0,
      swayLeft: 0,
      film: 0,
      bead: 0,
      beadAt: 0,
      rot: 0,
      lx: Math.cos(ang) * far,
      ly: Math.sin(ang) * far * 0.8,
      lr: Math.random() < 0.7 ? 0.45 + Math.random() * 0.35 : 0,
    };
  }

  private step(dt: number) {
    // 雨量慢慢跟到滑块的位置，不突变
    this.k += (this.target - this.k) * Math.min(1, dt * 2.5);
    if (Math.abs(this.target - this.k) < 0.002) this.k = this.target;
    const k = this.k;
    const raining = k > 0.01;
    // 画面越大，落在上面的雨越多
    const area = (this.w * this.h) / (1440 * 900);
    // 玻璃上的水主要还是往下流，风只把它带歪一些
    const lean = this.tilt * 0.55;

    // 细小的水珠：绝大多数很细，偶尔一颗大一点的
    if (raining) {
      this.beadDebt += (44 + 320 * Math.pow(k, 1.4)) * area * dt;
      const n = Math.min(90, Math.floor(this.beadDebt));
      this.beadDebt -= n;
      for (let i = 0; i < n; i++) {
        const r = 0.55 + Math.pow(Math.random(), 3.2) * (1.5 + 1.7 * k);
        this.stamp(this.bx, this.round, Math.random() * this.w, Math.random() * this.h, r, 1 + Math.random() * 0.12);
      }
    }
    // 蒸发：隔一阵整体缩一点。天晴了干得快
    this.evap += dt * (raining ? 1 + k : 3.2);
    if (this.evap >= 0.9) {
      this.evap = 0;
      this.fade(this.bx, 0.035);
    }
    // 身后的水线很快收细、断开
    this.fade(this.tx, 1 - Math.exp(-dt / 0.85));
    // 擦掉的雾慢慢起回来
    this.wipeFade += dt;
    if (this.wipeFade >= 1 && this.wiped > 0) {
      this.wipeFade = 0;
      this.wiped -= 1;
      this.fade(this.wx, 0.07);
    }
    this.dryFor = raining ? 0 : this.dryFor + dt;
    if (this.dryFor > 40 && this.dryFor - dt <= 40) {
      this.bx.clearRect(0, 0, this.beads.width, this.beads.height);
      this.tx.clearRect(0, 0, this.trail.width, this.trail.height);
      this.wx.clearRect(0, 0, this.wipe.width, this.wipe.height);
      this.wiped = 0;
      this.wet = false;
    }
    // 晴天、玻璃是干的：停下来不画，等再下雨（这一帧照常画完，把画面清干净）
    this.idle = this.target === 0 && k === 0 && this.bodies.length === 0 && !this.wet && performance.now() - this.flashAt > 1700 && !this.video;

    // 新落下的大一点的水滴
    if (raining && this.bodies.length < MAX_BODIES) {
      this.bodyDebt += (1 + 30 * k * k) * area * dt;
      while (this.bodyDebt >= 1) {
        this.bodyDebt -= 1;
        const r = 2 + Math.pow(Math.random(), 2.2) * (2.2 + 4.3 * k);
        // 斜着流的时候，从上风那一侧的窗外也落一些，免得那一侧空着
        const pad = Math.abs(lean) * this.h * 0.5;
        this.bodies.push(this.newBody(Math.random() * (this.w + pad) - (lean > 0 ? pad : 0), Math.random() * this.h * 0.92 - r, r));
      }
    }

    const slideAt = 4; // 攒到这么大就挂不住了
    for (const d of this.bodies) {
      d.px = d.x;
      d.py = d.y;
      const moving = d.vy > 2;
      // 被雨喂大；天晴了，不动的水滴慢慢干
      if (raining) d.r = Math.min(10, d.r + dt * k * (moving ? 0.14 : 0.5));
      else if (!moving) d.r -= dt * 0.3;
      if (this.still) continue; // 减弱动态效果时水滴不往下滑
      if (!moving) {
        if (d.r < slideAt) continue;
        d.stick -= dt;
        if (d.stick > 0) continue;
      }
      // 走走停停：小水滴更容易被玻璃拽住
      d.gaitLeft -= dt;
      if (d.gaitLeft <= 0) {
        const hold = d.r < 5.5 ? 0.45 : 0.22;
        d.gait = Math.random() < hold ? 0.04 + Math.random() * 0.1 : 0.7 + Math.random() * 0.3;
        d.gaitLeft = d.gait < 0.5 ? 0.12 + Math.random() * 0.55 : 0.25 + Math.random() * 1.3;
      }
      // 左右微微拐弯
      d.swayLeft -= dt;
      if (d.swayLeft <= 0) {
        d.sway = Math.random() < 0.3 ? 0 : (Math.random() - 0.5) * 0.5;
        d.swayLeft = 0.15 + Math.random() * 0.7;
      }
      const speed = 9 * Math.pow(d.r, 1.65) * d.gait;
      d.vy += (speed - d.vy) * Math.min(1, dt * (speed > d.vy ? 3.5 : 7));
      d.vx += ((d.sway + lean) * d.vy - d.vx) * Math.min(1, dt * 5);
      d.rot += (-Math.atan2(d.vx, Math.max(d.vy, 1)) - d.rot) * Math.min(1, dt * 6);
      const dy = d.vy * dt;
      d.x += d.vx * dt;
      d.y += dy;
      d.lr *= Math.max(0, 1 - dt * 4); // 动起来以后收成一滴
      // 沿路吃掉小水珠；雾也擦掉一道
      this.erase(this.bx, d.x, d.y, d.r * 0.9, this.ms);
      this.wx.lineCap = "round";
      this.wx.lineWidth = Math.max(1, d.r * 1.8 * this.wk);
      this.wx.strokeStyle = "#fff";
      this.wx.beginPath();
      this.wx.moveTo(d.px * this.wk, d.py * this.wk);
      this.wx.lineTo(d.x * this.wk, d.y * this.wk + 0.01);
      this.wx.stroke();
      this.wiped = 70;
      // 身后拖的水线：一截一截按在会淡掉的那张画布上，粗细不匀，淡的时候自然断成几段
      d.film += dy;
      const gap = Math.max(0.8, d.r * 0.34);
      while (d.film >= gap) {
        d.film -= gap;
        const back = d.film + d.r * 0.55;
        const wob = 0.3 + Math.random() * 0.16;
        // 每一截的浓淡不一样：淡的先断，剩下浓的几截成了一串水珠
        this.tx.globalAlpha = 0.62 + Math.random() * 0.38;
        this.stamp(this.tx, this.flat, d.x - d.vx * (back / Math.max(d.vy, 1)), d.y - back, d.r * wob, 1.5, d.rot);
        this.tx.globalAlpha = 1;
      }
      // 隔一段留下一颗小水珠
      d.bead += dy;
      if (d.bead >= d.beadAt) {
        d.bead = 0;
        d.beadAt = d.r * (1.2 + Math.random() * 4);
        const br = d.r * (0.18 + Math.random() * 0.22);
        const off = d.r * 1.25 + br;
        this.stamp(this.bx, this.round, d.x + (Math.random() - 0.5) * d.r * 0.45 - (d.vx / Math.max(d.vy, 1)) * off, d.y - off, br, 1.1 + Math.random() * 0.25);
      }
      // 一路留水，自己变小；雨大时沿路吃到的水更多
      d.r -= dy * (0.002 - 0.0013 * k);
      if (d.r < 2.6 && d.vy > 2) {
        // 太小了，停在原地
        d.vy = 0;
        d.vx = 0;
        d.stick = 4 + Math.random() * 8;
      }
    }
    // 合并：挨着的两滴并成一滴更大的，往下冲一下
    const ds = this.bodies;
    for (let i = 0; i < ds.length; i++) {
      const a = ds[i];
      if (a.r <= 0) continue;
      for (let j = i + 1; j < ds.length; j++) {
        const b = ds[j];
        if (b.r <= 0) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const reach = (a.r + b.r) * 0.82;
        if (dx * dx + dy * dy > reach * reach) continue;
        const low = a.y > b.y ? a : b;
        const r = Math.min(10.5, Math.sqrt(a.r * a.r + b.r * b.r));
        const vy = Math.max(a.vy, b.vy);
        a.x = low.x;
        a.y = low.y;
        a.px = a.x;
        a.py = a.y;
        a.r = r;
        a.vy = vy;
        a.stick = 0;
        a.gait = 1;
        a.gaitLeft = 0.5 + Math.random();
        b.r = 0;
      }
    }
    this.bodies = ds.filter((d) => d.r > 1 && d.y - d.r * 3 < this.h && d.x > -this.h * 0.6 && d.x < this.w + this.h * 0.6);

    // 玻璃外面的雨丝
    const want = this.still ? 0 : Math.round(Math.pow(k, 1.3) * 150 * area);
    while (this.streaks.length < want) this.streaks.push(this.newStreak(true));
    if (this.streaks.length > want) this.streaks.length = want;
    for (const st of this.streaks) {
      st.y += st.speed * dt;
      st.x += st.speed * dt * this.tilt;
      if (st.y - st.len > this.h) Object.assign(st, this.newStreak(false));
    }
  }

  private newStreak(anywhere: boolean): Streak {
    // 斜着下的时候，从上风那一侧的窗外也要有雨飘进来
    const drift = this.h * this.tilt;
    return {
      x: Math.random() * (this.w + Math.abs(drift)) - Math.max(0, drift),
      y: anywhere ? Math.random() * this.h : -Math.random() * this.h * 0.3,
      len: 50 + Math.random() * 90 + 140 * this.k,
      speed: 1300 + Math.random() * 900 + 1500 * this.k,
      a: Math.random(),
    };
  }

  // ---------------------------------------------------------------- 画

  private draw() {
    const level = this.flashLevel(performance.now());
    // 水的地图
    const m = this.mx;
    m.clearRect(0, 0, this.map.width, this.map.height);
    m.drawImage(this.beads, 0, 0);
    m.drawImage(this.trail, 0, 0);
    for (const d of this.bodies) {
      // 滑得快的拉长一点
      const tall = 1.08 + Math.min(0.5, d.vy / 700);
      if (d.lr > 0.05) this.stamp(m, this.round, d.x + d.lx * d.r, d.y + d.ly * d.r, d.r * d.lr);
      const up = d.r * (tall - 1) * 0.6; // 拉长的那一截留在身后
      this.stamp(m, this.tear, d.x + Math.sin(d.rot) * up, d.y - Math.cos(d.rot) * up, d.r, tall, d.rot);
    }

    // 玻璃后面的雨丝（隔着起雾的玻璃看，画得亮一点）
    const c = this.sx;
    if (c) {
      const s = this.ss;
      c.setTransform(s, 0, 0, s, 0, 0);
      c.clearRect(0, 0, this.w, this.h);
      if (this.streaks.length) {
        const tilt = this.tilt;
        c.lineCap = "round";
        // 分三档深浅，一档画一次
        for (let b = 0; b < 3; b++) {
          c.beginPath();
          for (const st of this.streaks) {
            if (Math.floor(st.a * 3) !== b) continue;
            c.moveTo(st.x, st.y);
            c.lineTo(st.x - st.len * tilt, st.y - st.len);
          }
          c.strokeStyle = `rgba(205,218,255,${0.1 + b * 0.08})`;
          c.lineWidth = 0.9 + b * 0.35;
          c.stroke();
        }
      }
      // 闪电本身（在玻璃外面，隔着雾看）
      if (level > 0.04 && this.bolt.length) {
        c.lineJoin = "round";
        c.shadowColor = "rgba(170,195,255,0.9)";
        c.shadowBlur = 16 * s;
        c.strokeStyle = `rgba(240,245,255,${Math.min(1, level * 1.4)})`;
        this.bolt.forEach((line, i) => {
          c.lineWidth = i ? 1.6 : 3;
          c.beginPath();
          c.moveTo(line[0], line[1]);
          for (let j = 2; j < line.length; j += 2) c.lineTo(line[j], line[j + 1]);
          c.stroke();
        });
        c.shadowBlur = 0;
      }
    }

    const g = this.g;
    g.viewport(0, 0, this.cv.width, this.cv.height);
    this.put(0, this.map);
    this.put(1, this.wipe);
    // 窗外是视频：每帧取一次画面（机器吃力时隔一帧取一次），裁成和窗口一样的比例，水滴里的折射和雾都用它
    const v = this.video;
    if (v && v.readyState >= 2 && v.videoWidth && (this.cost < 9 || this.tick++ % 2 === 0 || !this.videoUp)) {
      const c2 = this.small[0].getContext("2d");
      if (c2) {
        const fit = Math.max(this.w / v.videoWidth, this.h / v.videoHeight);
        const sw = this.w / fit;
        const sh = this.h / fit;
        try {
          c2.drawImage(v, (v.videoWidth - sw) / 2, (v.videoHeight - sh) / 2, sw, sh, 0, 0, SCENE_W, SCENE_H);
          this.put(2, this.small[0], true);
          this.videoUp = true;
        } catch {
          /* 这一帧取不到就用上一帧 */
        }
      }
    }
    g.uniform1f(this.uni.uVideo, v && this.videoUp ? 1 : 0);
    g.uniform1f(this.uni.uFlash, level);
    g.uniform2f(this.uni.uFlashAt, this.flashX, 0.2);
    g.uniform2f(this.uni.uPx, 1 / this.w, 1 / this.h);
    const reach = 0.3;
    g.uniform2f(this.uni.uReach, (reach * this.h) / this.w, reach);
    g.uniform1f(this.uni.uMix, stormMix(this.k));
    g.uniform1f(this.uni.uFog, fogMix(this.k));
    g.clear(g.COLOR_BUFFER_BIT);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
  }
}
