/**
 * 助眠模式：玻璃上的雨，不用显卡的简单画法。
 * 只在显卡画法（rain.ts）起不来的机器上用：每一滴水都是同一张小图
 * （把窗外的景色颠倒、缩进一个圆里），不会并在一起，也没有水痕把雾擦开的效果。
 */
import { stormMix, type Glass } from "./rain";

interface Drop {
  x: number;
  y: number;
  r: number;
  vy: number;
  /** 还要粘多久才开始往下滑（秒） */
  stick: number;
  /** 走走停停：当前这一段是走（1）还是慢（接近 0），还剩多久 */
  gait: number;
  gaitLeft: number;
  /** 离上一颗水痕走了多远 */
  since: number;
  phase: number;
}
interface Streak {
  x: number;
  y: number;
  len: number;
  speed: number;
  a: number;
}

const SPRITE = 96;
const MAX_DROPS = 220;

export class RainGlassFlat implements Glass {
  private ctx: CanvasRenderingContext2D;
  /** 攒小水珠的那张画布 */
  private mist = document.createElement("canvas");
  private mctx = this.mist.getContext("2d")!;
  private sprite = document.createElement("canvas");
  private clear: HTMLCanvasElement | null = null;
  private storm: HTMLCanvasElement | null = null;
  private spriteMix = -1;
  private w = 0;
  private h = 0;
  /** 画布像素 / CSS 像素 */
  private s = 1;
  private k = 0;
  private target = 0;
  private drops: Drop[] = [];
  private streaks: Streak[] = [];
  private raf = 0;
  private last = 0;
  private evap = 0;
  private dryFor = 0;
  private bigDebt = 0;
  private smallDebt = 0;
  private still = false;
  /** 晴天、玻璃也干透了：没有东西要画，循环空转 */
  private idle = false;
  /** 雨丝斜多少（正切值，正数往右） */
  private tilt = Math.tan((-8 * Math.PI) / 180);
  private flashAt = -1e9;

  constructor(private cv: HTMLCanvasElement) {
    const ctx = cv.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    this.ctx = ctx;
    this.sprite.width = this.sprite.height = SPRITE;
    this.still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /** w、h：窗口的 CSS 尺寸；scale：画布像素比 */
  resize(w: number, h: number, scale: number) {
    this.w = Math.max(1, Math.round(w * scale));
    this.h = Math.max(1, Math.round(h * scale));
    this.s = scale;
    this.cv.width = this.mist.width = this.w;
    this.cv.height = this.mist.height = this.h;
    this.drops = [];
    this.streaks = [];
    this.idle = false;
  }

  readonly gl = false;

  setScene(clear: HTMLCanvasElement, storm: HTMLCanvasElement) {
    this.clear = clear;
    this.storm = storm;
    this.spriteMix = -1;
  }

  /** 雨量 0–1 */
  setRain(k: number) {
    this.target = Math.max(0, Math.min(1, k));
    if (this.target > 0) this.idle = false;
  }

  start() {
    if (this.raf) return;
    this.last = 0;
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      // 大约每秒 30 帧就够了（减弱动态效果时更慢，只让水珠慢慢攒）
      if (this.idle || now - this.last < (this.still ? 480 : 30)) return;
      const dt = this.last ? Math.min(0.06, (now - this.last) / 1000) : 0.033;
      this.last = now;
      this.step(this.still ? 0.2 : dt);
      this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  dispose() {
    this.stop();
    this.mist.width = 0;
    this.mist.height = 0;
    // 页面上的画布等它真的被拿掉再清空，免得同一块画布重新建雨景时是空的
    const cv = this.cv;
    window.setTimeout(() => {
      if (cv.isConnected) return;
      cv.width = 0;
      cv.height = 0;
    }, 0);
    this.clear = this.storm = null;
  }

  setAngle(deg: number) {
    this.tilt = Math.tan((Math.max(-45, Math.min(45, deg)) * Math.PI) / 180);
  }

  /** 简单画法不跟视频走：水滴里还是画的景色 */
  setVideo() {}

  /** 简单画法里闪电只是整面亮一下 */
  flash() {
    this.flashAt = performance.now();
    this.idle = false;
  }

  // ---------------------------------------------------------------- 水滴的小图

  private buildSprite() {
    const g = this.sprite.getContext("2d");
    if (!g || !this.clear || !this.storm) return;
    const S = SPRITE;
    const mix = stormMix(this.k);
    this.spriteMix = mix;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
    g.clearRect(0, 0, S, S);
    // 颠倒的景色
    g.save();
    g.setTransform(-1, 0, 0, -1, S, S);
    // 水滴比起雾的玻璃透亮：折射进来的景色提亮、加一点对比
    g.filter = "brightness(1.18) contrast(1.1)";
    g.drawImage(this.clear, 0, 0, S, S);
    g.globalAlpha = mix;
    g.drawImage(this.storm, 0, 0, S, S);
    g.restore();
    // 边缘压暗
    const edge = g.createRadialGradient(S / 2, S / 2, S * 0.3, S / 2, S / 2, S / 2);
    edge.addColorStop(0, "rgba(0,0,0,0)");
    edge.addColorStop(0.8, "rgba(0,0,0,0.2)");
    edge.addColorStop(1, "rgba(0,0,0,0.6)");
    g.fillStyle = edge;
    g.fillRect(0, 0, S, S);
    // 上暗下亮：光从下沿透出来，像一弯亮边
    const tb = g.createLinearGradient(0, 0, 0, S);
    tb.addColorStop(0, "rgba(0,0,0,0.5)");
    tb.addColorStop(0.45, "rgba(0,0,0,0)");
    tb.addColorStop(0.8, "rgba(255,255,255,0.03)");
    tb.addColorStop(1, "rgba(255,255,255,0.3)");
    g.fillStyle = tb;
    g.fillRect(0, 0, S, S);
    // 左上角的一点高光
    const hl = g.createRadialGradient(S * 0.35, S * 0.29, 0, S * 0.35, S * 0.29, S * 0.1);
    hl.addColorStop(0, "rgba(255,255,255,0.8)");
    hl.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = hl;
    g.fillRect(0, 0, S, S);
    // 圆形、边缘柔和
    g.globalCompositeOperation = "destination-in";
    const mask = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    mask.addColorStop(0, "rgba(0,0,0,1)");
    mask.addColorStop(0.88, "rgba(0,0,0,1)");
    mask.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = mask;
    g.fillRect(0, 0, S, S);
    g.globalCompositeOperation = "source-over";
  }

  // ---------------------------------------------------------------- 模拟

  private step(dt: number) {
    // 雨量慢慢跟到滑块的位置，不突变
    this.k += (this.target - this.k) * Math.min(1, dt * 2.5);
    if (Math.abs(this.target - this.k) < 0.002) this.k = this.target;
    const k = this.k;
    const s = this.s;
    const raining = k > 0.01;
    // 画面越大，落在上面的雨越多
    const area = (this.w * this.h) / (s * s) / (1440 * 900);
    if (!this.clear || Math.abs(stormMix(k) - this.spriteMix) > 0.04) this.buildSprite();

    // 小水珠
    if (raining) {
      this.smallDebt += (30 + 300 * Math.pow(k, 1.5)) * area * dt;
      const n = Math.min(90, Math.floor(this.smallDebt));
      this.smallDebt -= n;
      for (let i = 0; i < n; i++) {
        // 绝大多数很细，偶尔一颗大一点的
        const r = (0.5 + Math.pow(Math.random(), 3) * (1.4 + 1.8 * k)) * s;
        this.stamp(Math.random() * this.w, Math.random() * this.h, r, 1);
      }
    }
    // 蒸发：隔一阵整体淡一点。天晴了干得快
    this.evap += dt * (raining ? 0.045 + 0.045 * k : 0.14);
    if (this.evap >= 0.15) {
      this.evap = 0;
      this.mctx.globalCompositeOperation = "destination-out";
      this.mctx.fillStyle = "rgba(0,0,0,0.15)";
      this.mctx.fillRect(0, 0, this.w, this.h);
      this.mctx.globalCompositeOperation = "source-over";
    }
    this.dryFor = raining ? 0 : this.dryFor + dt;
    if (this.dryFor > 40 && this.dryFor - dt <= 40) this.mctx.clearRect(0, 0, this.w, this.h);
    // 干透了就停下来不画，等再下雨（这一帧照常画完，把画面清干净）
    this.idle = this.dryFor > 41 && this.target === 0 && this.drops.length === 0 && performance.now() - this.flashAt > 1700;

    // 新的大水滴
    if (raining && this.drops.length < MAX_DROPS) {
      this.bigDebt += (0.5 + 22 * k * k) * area * dt;
      while (this.bigDebt >= 1) {
        this.bigDebt -= 1;
        const r = (2.6 + Math.pow(Math.random(), 2) * (2.6 + 6 * k)) * s;
        this.drops.push({
          x: Math.random() * this.w,
          y: Math.random() * this.h * 0.9 - r,
          r,
          vy: 0,
          stick: Math.random() * 7,
          gait: 1,
          gaitLeft: 0,
          since: 0,
          phase: Math.random() * 6.28,
        });
      }
    }

    const slideAt = 4.6 * s; // 攒到这么大就粘不住了
    for (const d of this.drops) {
      if (raining) d.r = Math.min(13 * s, d.r + dt * k * (d.vy > 1 ? 0.4 : 0.7) * s);
      else if (d.vy < 1) d.r -= dt * 0.4 * s; // 天晴了：不动的水滴慢慢干
      if (d.r < slideAt && d.vy < 1) continue;
      d.stick -= dt;
      if (this.still || (d.stick > 0 && d.vy < 1)) continue; // 减弱动态效果时水滴不往下滑
      // 走走停停
      d.gaitLeft -= dt;
      if (d.gaitLeft <= 0) {
        d.gait = Math.random() < 0.35 ? 0.08 : 1;
        d.gaitLeft = 0.15 + Math.random() * (d.gait < 1 ? 0.5 : 1.1);
      }
      const speed = Math.pow(d.r / s, 1.6) * 22 * s * d.gait;
      d.vy += (speed - d.vy) * Math.min(1, dt * 5);
      const dy = d.vy * dt;
      d.phase += dt * 3;
      d.x += Math.sin(d.phase) * d.r * 0.5 * dt * (d.vy > 30 * s ? 1 : 0);
      d.x += this.tilt * 0.55 * dy; // 被风带歪一些
      d.y += dy;
      d.since += dy;
      // 擦掉路上的小水珠，留下水痕
      this.wipe(d.x, d.y, d.r * 1.05);
      if (d.since > d.r * (1.5 + Math.random())) {
        d.since = 0;
        this.stamp(d.x + (Math.random() - 0.5) * d.r * 0.5, d.y - d.r * 1.25, d.r * (0.22 + Math.random() * 0.2), 1.25);
        d.r *= 0.992;
      }
    }
    // 合并：挨着的两滴并成一滴更大的
    const ds = this.drops;
    for (let i = 0; i < ds.length; i++) {
      const a = ds[i];
      if (a.r <= 0) continue;
      for (let j = i + 1; j < ds.length; j++) {
        const b = ds[j];
        if (b.r <= 0) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const reach = (a.r + b.r) * 0.72;
        if (dx * dx + dy * dy > reach * reach) continue;
        const low = a.y > b.y ? a : b;
        const r = Math.min(14 * s, Math.sqrt(a.r * a.r + b.r * b.r));
        a.x = low.x;
        a.y = low.y;
        a.r = r;
        a.vy = Math.max(a.vy, b.vy);
        a.stick = 0;
        b.r = 0;
      }
    }
    this.drops = ds.filter((d) => d.r > 1.2 * s && d.y - d.r * 2 < this.h);

    // 玻璃外面的雨丝
    const want = this.still ? 0 : Math.round(Math.pow(k, 1.3) * 150 * area);
    while (this.streaks.length < want) this.streaks.push(this.newStreak(true));
    if (this.streaks.length > want) this.streaks.length = want;
    const tilt = -this.tilt;
    for (const st of this.streaks) {
      st.y += st.speed * dt;
      st.x -= st.speed * dt * tilt;
      if (st.y - st.len > this.h) Object.assign(st, this.newStreak(false));
    }
  }

  private newStreak(anywhere: boolean): Streak {
    const s = this.s;
    return {
      x: Math.random() * (this.w + Math.abs(this.h * this.tilt)) - Math.max(0, this.h * this.tilt),
      y: anywhere ? Math.random() * this.h : -Math.random() * this.h * 0.3,
      len: (50 + Math.random() * 90 + 140 * this.k) * s,
      speed: (1300 + Math.random() * 900 + 1500 * this.k) * s,
      a: Math.random(),
    };
  }

  /** 在攒水珠的画布上按一颗水珠（tall：竖着拉长多少） */
  private stamp(x: number, y: number, r: number, tall: number) {
    this.mctx.drawImage(this.sprite, x - r, y - r * tall, r * 2, r * 2 * tall);
  }

  private wipe(x: number, y: number, r: number) {
    const m = this.mctx;
    m.globalCompositeOperation = "destination-out";
    m.beginPath();
    m.arc(x, y, r, 0, Math.PI * 2);
    m.fill();
    m.globalCompositeOperation = "source-over";
  }

  // ---------------------------------------------------------------- 画

  private draw() {
    const c = this.ctx;
    const s = this.s;
    c.clearRect(0, 0, this.w, this.h);
    const ft = (performance.now() - this.flashAt) / 1000;
    if (ft >= 0 && ft < 1.6) {
      const level = this.still ? 0.28 * Math.exp(-ft / 0.45) : Math.min(1, Math.exp(-ft / 0.07) + (ft > 0.18 ? 0.85 * Math.exp(-(ft - 0.18) / 0.2) : 0));
      c.fillStyle = `rgba(205,220,255,${(level * 0.4).toFixed(3)})`;
      c.fillRect(0, 0, this.w, this.h);
    }
    if (this.streaks.length) {
      const tilt = -this.tilt;
      c.lineCap = "round";
      // 分三档深浅，一档画一次
      for (let b = 0; b < 3; b++) {
        c.beginPath();
        for (const st of this.streaks) {
          if (Math.floor(st.a * 3) !== b) continue;
          c.moveTo(st.x, st.y);
          c.lineTo(st.x + st.len * tilt, st.y - st.len);
        }
        c.strokeStyle = `rgba(205,218,255,${0.05 + b * 0.045})`;
        c.lineWidth = (0.9 + b * 0.35) * s;
        c.stroke();
      }
    }
    c.drawImage(this.mist, 0, 0);
    for (const d of this.drops) {
      // 滑得快的拉长一点，像泪滴
      const tall = 1 + Math.min(0.55, d.vy / (1400 * s));
      c.drawImage(this.sprite, d.x - d.r, d.y - d.r * tall * 1.15, d.r * 2, d.r * 2 * tall);
    }
  }
}
