/**
 * 助眠模式窗外的景色。三幅内置的夜景用画布现画（不带图片文件），也可以用自己的图片。
 * 每幅都有两个版本：晴朗的夜（storm=false）和大雨里的样子（storm=true），布局完全一样，
 * 界面把两张叠起来按雨量混合，拖雨量滑块时不用重画。
 */
export type SleepScene = "city" | "mountain" | "sea" | "custom" | "video";

export const SLEEP_SCENES: { id: Exclude<SleepScene, "custom" | "video">; label: string }[] = [
  { id: "city", label: "城市夜景" },
  { id: "mountain", label: "山间" },
  { id: "sea", label: "海边" },
];

type Ctx = CanvasRenderingContext2D;
type Stops = [number, string][];

/** 固定种子的随机数：同一幅景色每次画出来都一样，晴、雨两版的布局也才对得上 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

function vgrad(ctx: Ctx, y0: number, y1: number, stops: Stops) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  for (const [p, c] of stops) g.addColorStop(p, c);
  return g;
}

/** 一团柔和的光（或雾）：中心最浓，往外淡出 */
function glow(ctx: Ctx, x: number, y: number, rx: number, ry: number, rgb: string, alpha: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, ry / rx);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, `rgba(${rgb},${alpha})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function stars(ctx: Ctx, r: () => number, W: number, maxY: number) {
  const n = Math.round(W * 0.09);
  for (let i = 0; i < n; i++) {
    const x = r() * W;
    const y = Math.pow(r(), 1.4) * maxY;
    const s = 0.4 + r() * 0.9;
    const a = (0.25 + r() * 0.65) * (1 - (y / maxY) * 0.7);
    if (s > 1.15) glow(ctx, x, y, s * 5, s * 5, "200,215,255", a * 0.35);
    ctx.fillStyle = `rgba(232,238,255,${a})`;
    ctx.beginPath();
    ctx.arc(x, y, s, 0, Math.PI * 2);
    ctx.fill();
  }
}

function moon(ctx: Ctx, x: number, y: number, rad: number) {
  glow(ctx, x, y, rad * 7, rad * 7, "150,170,240", 0.2);
  glow(ctx, x, y, rad * 2.6, rad * 2.6, "210,222,255", 0.3);
  const g = ctx.createRadialGradient(x - rad * 0.3, y - rad * 0.3, rad * 0.1, x, y, rad);
  g.addColorStop(0, "#FBF8EE");
  g.addColorStop(1, "#D9D7CC");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, rad, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(120,120,140,0.10)";
  for (const [dx, dy, s] of [[-0.3, -0.1, 0.24], [0.25, 0.3, 0.18], [0.1, -0.4, 0.13], [-0.15, 0.42, 0.11]] as const) {
    ctx.beginPath();
    ctx.arc(x + dx * rad, y + dy * rad, s * rad, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 一片云：很多块扁的柔光叠起来 */
function cloudBank(ctx: Ctx, r: () => number, W: number, y0: number, y1: number, n: number, rgb: string, alpha: number) {
  for (let i = 0; i < n; i++) {
    const rx = 160 + r() * 380;
    glow(ctx, r() * (W + 400) - 200, lerp(y0, y1, r()), rx, rx * (0.2 + r() * 0.22), rgb, alpha * (0.5 + r() * 0.5));
  }
}

/** 给亮的地方加一圈光晕（灯、月亮）：把画好的画面模糊后叠亮一层 */
function bloom(ctx: Ctx, blur: number, alpha: number) {
  const cv = ctx.canvas;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = `blur(${blur}px)`;
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = alpha;
  ctx.drawImage(cv, 0, 0);
  ctx.restore();
}

// ------------------------------------------------------------------ 城市夜景

interface Tower {
  x: number;
  w: number;
  h: number;
  top: number; // 0 平顶 1 退台 2 尖顶
  lit: number; // 这栋楼亮灯的比例
  ant: boolean;
}

function skyline(r: () => number, W: number, minH: number, maxH: number, minW: number, maxW: number, gap: number): Tower[] {
  const out: Tower[] = [];
  let x = -r() * maxW;
  while (x < W) {
    const w = lerp(minW, maxW, r());
    out.push({ x, w, h: lerp(minH, maxH, Math.pow(r(), 1.7)), top: Math.floor(r() * 3), lit: r() < 0.15 ? 0.04 : 0.12 + r() * 0.45, ant: r() < 0.22 });
    x += w + r() * gap;
  }
  return out;
}

const WARM = ["255,214,150", "255,196,120", "255,228,180"];
const COOL = ["190,226,255", "160,208,255"];

function drawSkyline(ctx: Ctx, r: () => number, towers: Tower[], base: number, color: string, cw: number, ch: number, winAlpha: number) {
  for (const b of towers) {
    const top = base - b.h;
    ctx.fillStyle = color;
    ctx.fillRect(b.x, top, b.w, 900 - top);
    if (b.top === 1) ctx.fillRect(b.x + b.w * 0.2, top - b.h * 0.07, b.w * 0.6, b.h * 0.07 + 1);
    if (b.top === 2) {
      ctx.beginPath();
      ctx.moveTo(b.x + b.w * 0.5, top - b.h * 0.16);
      ctx.lineTo(b.x + b.w * 0.62, top + 1);
      ctx.lineTo(b.x + b.w * 0.38, top + 1);
      ctx.fill();
    }
    // 窗户：按格子排，随机亮一部分；一栋楼大多是同一种灯光
    const cool = r() < 0.3;
    const cols = Math.floor((b.w - cw * 0.6) / cw);
    const rows = Math.floor((b.h - ch) / ch);
    const ox = b.x + (b.w - cols * cw) / 2;
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        if (r() > b.lit) continue;
        const set = cool !== r() < 0.12 ? COOL : WARM;
        ctx.fillStyle = `rgba(${set[Math.floor(r() * set.length)]},${winAlpha * (0.45 + r() * 0.55)})`;
        ctx.fillRect(ox + j * cw + cw * 0.2, top + ch * 0.6 + i * ch, cw * 0.58, ch * 0.5);
      }
    }
    if (b.ant) {
      ctx.fillStyle = color;
      ctx.fillRect(b.x + b.w * 0.5 - 0.8, top - b.h * 0.12 - 14, 1.6, b.h * 0.12 + 16);
      glow(ctx, b.x + b.w * 0.5, top - b.h * 0.12 - 14, 9, 9, "255,80,80", winAlpha * 0.9);
    }
  }
}

function city(ctx: Ctx, W: number, storm: boolean) {
  ctx.fillStyle = storm
    ? vgrad(ctx, 0, 760, [[0, "#080B16"], [0.5, "#151A2B"], [0.85, "#2B2C40"], [1, "#4E404F"]])
    : vgrad(ctx, 0, 760, [[0, "#060918"], [0.45, "#121839"], [0.78, "#2A2558"], [1, "#5B3B72"]]);
  ctx.fillRect(0, 0, W, 900);
  if (!storm) {
    stars(ctx, rng(11), W, 520);
    moon(ctx, W * 0.8, 150, 42);
  } else {
    const rc = rng(37);
    cloudBank(ctx, rc, W, 20, 430, 46, "44,48,68", 0.42);
    cloudBank(ctx, rc, W, 420, 640, 22, "118,86,96", 0.18); // 云底被城市的灯映亮
  }
  // 地平线上的城市光
  glow(ctx, W * 0.5, 760, W * 0.75, 260, storm ? "170,120,120" : "190,110,170", storm ? 0.3 : 0.26);

  const rb = rng(23);
  const far = skyline(rb, W, 60, 250, 26, 64, 10);
  const mid = skyline(rb, W, 120, 400, 44, 110, 26);
  const near = skyline(rb, W, 90, 300, 90, 210, 70);
  const rw = rng(51);
  drawSkyline(ctx, rw, far, 700, storm ? "#262A3E" : "#1D2146", 6, 8, storm ? 0.3 : 0.42);
  if (storm) {
    ctx.fillStyle = vgrad(ctx, 380, 760, [[0, "rgba(58,60,82,0)"], [1, "rgba(58,60,82,0.5)"]]);
    ctx.fillRect(0, 380, W, 380);
  }
  drawSkyline(ctx, rw, mid, 790, storm ? "#151829" : "#12152F", 8, 11, storm ? 0.6 : 0.72);
  // 街面的暖光，夹在中景和近景之间
  ctx.fillStyle = vgrad(ctx, 660, 900, [[0, "rgba(255,170,96,0)"], [1, storm ? "rgba(255,170,96,0.3)" : "rgba(255,170,96,0.24)"]]);
  ctx.fillRect(0, 660, W, 240);
  drawSkyline(ctx, rw, near, 940, storm ? "#090A14" : "#080919", 12, 16, 0.92);
  bloom(ctx, storm ? 7 : 3.5, storm ? 0.55 : 0.3);
  if (storm) {
    ctx.fillStyle = vgrad(ctx, 0, 900, [[0, "rgba(96,106,132,0.1)"], [0.7, "rgba(96,106,132,0.07)"], [1, "rgba(96,106,132,0.03)"]]);
    ctx.fillRect(0, 0, W, 900);
  }
}

// ------------------------------------------------------------------ 山间

/** 平滑的一维噪声，叠几层得到山脊线 */
function ridge(r: () => number, W: number, base: number, amp: number, feature: number, sharp: boolean): number[] {
  const step = 6;
  const n = Math.ceil(W / step) + 2;
  const out = new Array<number>(n).fill(0);
  let a = 1;
  let f = feature;
  let total = 0;
  for (let o = 0; o < 4; o++) {
    const m = Math.ceil((n * step) / f) + 3;
    const v = Array.from({ length: m }, () => r());
    for (let i = 0; i < n; i++) {
      const x = (i * step) / f;
      const k = Math.floor(x);
      const t = x - k;
      const s = t * t * (3 - 2 * t);
      let y = lerp(v[k], v[k + 1], s);
      if (sharp && o < 2) y = 1 - Math.abs(y * 2 - 1); // 尖一点的山峰
      out[i] += y * a;
    }
    total += a;
    a *= 0.5;
    f *= 0.5;
  }
  return out.map((y) => base - (y / total) * amp);
}

function fillRidge(ctx: Ctx, ys: number[], color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, 900);
  ys.forEach((y, i) => ctx.lineTo(i * 6, y));
  ctx.lineTo((ys.length - 1) * 6, 900);
  ctx.fill();
}

function pines(ctx: Ctx, r: () => number, ys: number[], color: string, minH: number, maxH: number, gap: number) {
  ctx.fillStyle = color;
  let x = r() * gap;
  const W = (ys.length - 1) * 6;
  while (x < W) {
    const y = ys[Math.min(ys.length - 1, Math.round(x / 6))] + 4;
    const h = lerp(minH, maxH, r());
    const w = h * (0.34 + r() * 0.1);
    // 三层往上收的树冠
    for (let k = 0; k < 3; k++) {
      const top = y - h + (h * k) / 4.2;
      const bw = w * (0.45 + k * 0.28);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x + bw, top + h * 0.48);
      ctx.lineTo(x - bw, top + h * 0.48);
      ctx.fill();
    }
    ctx.fillRect(x - 1.2, y - h * 0.2, 2.4, h * 0.2);
    x += gap * (0.45 + r());
  }
}

function mountain(ctx: Ctx, W: number, storm: boolean) {
  ctx.fillStyle = storm
    ? vgrad(ctx, 0, 620, [[0, "#090C14"], [0.55, "#181E2D"], [1, "#2E3648"]])
    : vgrad(ctx, 0, 620, [[0, "#050919"], [0.5, "#111F45"], [0.85, "#2C3E70"], [1, "#586494"]]);
  ctx.fillRect(0, 0, W, 900);
  if (!storm) {
    stars(ctx, rng(13), W, 480);
    moon(ctx, W * 0.24, 165, 38);
  }
  const rr = rng(29);
  const clear = ["#35446F", "#28365E", "#1B2649", "#111935", "#070A18"];
  const wet = ["#2C3345", "#232A3A", "#1A2030", "#111522", "#07090F"];
  const layers = [0, 1, 2, 3, 4].map((i) => ridge(rr, W, 400 + i * 96, 250 - i * 36, 520 - i * 70, i < 3));
  const rp = rng(41);
  layers.forEach((ys, i) => {
    const color = (storm ? wet : clear)[i];
    if (storm && i === 1) cloudBank(ctx, rng(61), W, 130, 470, 40, "52,60,80", 0.5); // 云压在远山头上
    fillRidge(ctx, ys, color);
    if (i === 3) {
      pines(ctx, rp, ys, color, 26, 54, 20);
      // 半山腰的小木屋，亮着一扇窗
      const cx = W * 0.68;
      const cy = ys[Math.round(cx / 6)] + 6;
      ctx.fillStyle = storm ? "#0A0C14" : "#0A0E20";
      ctx.fillRect(cx - 26, cy - 26, 52, 30);
      ctx.beginPath();
      ctx.moveTo(cx - 34, cy - 24);
      ctx.lineTo(cx, cy - 52);
      ctx.lineTo(cx + 34, cy - 24);
      ctx.fill();
      glow(ctx, cx + 6, cy - 12, storm ? 70 : 46, storm ? 70 : 46, "255,196,120", storm ? 0.4 : 0.32);
      ctx.fillStyle = "#FFD08A";
      ctx.fillRect(cx, cy - 18, 12, 12);
    }
    if (i === 4) pines(ctx, rp, ys, color, 60, 130, 44);
    // 每层山脚下的雾
    const y = Math.min(...ys);
    const a = (storm ? 0.3 : 0.13) * (1 - i * 0.16);
    ctx.fillStyle = vgrad(ctx, y + 30, 400 + i * 96 + 110, [[0, `rgba(160,178,220,0)`], [1, `rgba(160,178,220,${a})`]]);
    if (i < 4) ctx.fillRect(0, y + 30, W, 400 + i * 96 + 110 - y - 30);
  });
  bloom(ctx, storm ? 6 : 3, storm ? 0.4 : 0.22);
  if (storm) {
    ctx.fillStyle = "rgba(96,106,132,0.07)";
    ctx.fillRect(0, 0, W, 900);
  }
}

// ------------------------------------------------------------------ 海边

function sea(ctx: Ctx, W: number, storm: boolean) {
  const HZ = 560;
  ctx.fillStyle = storm
    ? vgrad(ctx, 0, HZ, [[0, "#080A12"], [0.6, "#171C29"], [1, "#2C3242"]])
    : vgrad(ctx, 0, HZ, [[0, "#050816"], [0.5, "#0F1A3D"], [0.85, "#22306A"], [1, "#46538F"]]);
  ctx.fillRect(0, 0, W, HZ);
  const mx = W * 0.62;
  if (!storm) {
    stars(ctx, rng(17), W, 470);
    moon(ctx, mx, 205, 48);
  } else {
    cloudBank(ctx, rng(67), W, 10, 500, 52, "48,56,76", 0.45);
  }
  // 海面
  ctx.fillStyle = storm
    ? vgrad(ctx, HZ, 900, [[0, "#232A3A"], [0.4, "#121722"], [1, "#06080D"]])
    : vgrad(ctx, HZ, 900, [[0, "#1D2B5A"], [0.4, "#0B1230"], [1, "#04060F"]]);
  ctx.fillRect(0, HZ, W, 900 - HZ);

  const rs = rng(31);
  // 细碎的波光
  const glints = Math.round(W * (storm ? 1.1 : 0.6));
  for (let i = 0; i < glints; i++) {
    const d = Math.pow(rs(), 1.6); // 0 远 1 近
    const y = HZ + 4 + d * 330;
    const len = 6 + d * 60 * rs();
    ctx.fillStyle = storm ? `rgba(200,210,230,${0.04 + rs() * 0.1})` : `rgba(150,175,235,${0.03 + rs() * 0.06})`;
    ctx.fillRect(rs() * W, y, len, 0.8 + d * 1.8);
  }
  if (!storm) {
    // 月亮在水里的那条光路：越近越宽、越碎
    for (let y = HZ + 3; y < 900; y += 3 + (y - HZ) * 0.012) {
      const d = (y - HZ) / (900 - HZ);
      const half = 16 + d * 150;
      const n = 2 + Math.floor(rs() * 3);
      for (let k = 0; k < n; k++) {
        const len = (8 + d * 70) * (0.4 + rs());
        const x = mx + (rs() - 0.5) * 2 * half - len / 2;
        ctx.fillStyle = `rgba(224,232,255,${0.5 * Math.pow(1 - d, 0.7) * (0.35 + rs() * 0.65)})`;
        ctx.fillRect(x, y, len, 1.2 + d * 2.4);
      }
    }
    glow(ctx, mx, HZ + 6, 150, 22, "200,215,255", 0.22);
  }
  // 左边伸进海里的岬角和灯塔
  ctx.fillStyle = storm ? "#090B12" : "#080C1D";
  ctx.beginPath();
  ctx.moveTo(-10, HZ + 3);
  ctx.lineTo(-10, HZ - 92);
  ctx.bezierCurveTo(W * 0.08, HZ - 100, W * 0.14, HZ - 52, W * 0.21, HZ - 34);
  ctx.bezierCurveTo(W * 0.26, HZ - 20, W * 0.3, HZ - 4, W * 0.34, HZ + 3);
  ctx.fill();
  const lx = W * 0.185;
  const ly = HZ - 44;
  ctx.beginPath();
  ctx.moveTo(lx - 7, ly);
  ctx.lineTo(lx - 4.5, ly - 62);
  ctx.lineTo(lx + 4.5, ly - 62);
  ctx.lineTo(lx + 7, ly);
  ctx.fill();
  ctx.fillRect(lx - 6.5, ly - 72, 13, 4);
  // 灯塔的光柱
  ctx.save();
  const beam = ctx.createLinearGradient(lx, 0, lx + W * 0.42, 0);
  beam.addColorStop(0, `rgba(255,226,170,${storm ? 0.26 : 0.16})`);
  beam.addColorStop(1, "rgba(255,226,170,0)");
  ctx.fillStyle = beam;
  ctx.beginPath();
  ctx.moveTo(lx, ly - 67);
  ctx.lineTo(lx + W * 0.42, ly - 67 - 46);
  ctx.lineTo(lx + W * 0.42, ly - 67 + 20);
  ctx.fill();
  ctx.restore();
  glow(ctx, lx, ly - 67, storm ? 56 : 34, storm ? 56 : 34, "255,222,160", 0.75);
  ctx.fillStyle = "#FFF0CC";
  ctx.fillRect(lx - 3.5, ly - 70, 7, 6);
  // 远处的一条小船
  const bx = W * 0.86;
  ctx.fillStyle = storm ? "#090B12" : "#070A1A";
  ctx.beginPath();
  ctx.moveTo(bx - 20, HZ - 3);
  ctx.lineTo(bx + 20, HZ - 3);
  ctx.lineTo(bx + 14, HZ + 3);
  ctx.lineTo(bx - 14, HZ + 3);
  ctx.fill();
  ctx.fillRect(bx - 3, HZ - 12, 9, 9);
  glow(ctx, bx + 1, HZ - 13, 16, 16, "255,200,130", 0.8);
  ctx.fillStyle = "rgba(255,200,130,0.35)";
  ctx.fillRect(bx - 5, HZ + 6, 12, 1.6);
  ctx.fillRect(bx - 2, HZ + 11, 8, 1.4);
  if (storm) {
    // 雨幕把海天交界盖住
    ctx.fillStyle = vgrad(ctx, HZ - 90, HZ + 90, [[0, "rgba(66,74,94,0)"], [0.5, "rgba(66,74,94,0.62)"], [1, "rgba(66,74,94,0)"]]);
    ctx.fillRect(0, HZ - 90, W, 180);
  }
  bloom(ctx, storm ? 7 : 3.5, storm ? 0.45 : 0.25);
  if (storm) {
    ctx.fillStyle = "rgba(96,106,132,0.06)";
    ctx.fillRect(0, 0, W, 900);
  }
}

// ------------------------------------------------------------------ 自己的图片

function custom(ctx: Ctx, w: number, h: number, img: HTMLImageElement, storm: boolean) {
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * s;
  const dh = img.naturalHeight * s;
  ctx.save();
  if (storm) ctx.filter = "saturate(0.5) brightness(0.72)"; // 下雨天：发灰、变暗
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  ctx.restore();
  if (storm) {
    ctx.fillStyle = vgrad(ctx, 0, h, [[0, "rgba(96,108,134,0.42)"], [0.6, "rgba(96,108,134,0.22)"], [1, "rgba(60,68,90,0.18)"]]);
    ctx.fillRect(0, 0, w, h);
  }
}

/**
 * 把景色画到画布上。w、h 是画布的像素尺寸。
 * 内置景色按 900 高的画稿画，等比放大到画布高度，宽出来的部分接着往右画。
 */
export function paintScene(cv: HTMLCanvasElement, w: number, h: number, scene: SleepScene, storm: boolean, img: HTMLImageElement | null) {
  cv.width = Math.max(1, Math.round(w));
  cv.height = Math.max(1, Math.round(h));
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  if (scene === "custom" && img) {
    custom(ctx, cv.width, cv.height, img, storm);
    return;
  }
  const u = cv.height / 900;
  ctx.setTransform(u, 0, 0, u, 0, 0);
  const W = cv.width / u;
  if (scene === "mountain") mountain(ctx, W, storm);
  else if (scene === "sea") sea(ctx, W, storm);
  else city(ctx, W, storm);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
