// 颜色：预设配色、自选颜色调成"发光色"、两色插值成 6 色、跟随配色的深色底。
// 规则照《ingfy 设计风格》3.2 和 3.3，只是颜色来源从专辑封面换成了阶段。

export interface Pair {
  a: string;
  b: string;
}

/** 预设配色。名字是界面上显示的中文，也是翻译用的 key。 */
export const PRESETS = {
  neon: { name: "霓虹", a: "#FF5FA2", b: "#7B5CFF" },
  ocean: { name: "海洋", a: "#3DE8FF", b: "#2F5BFF" },
  sunset: { name: "落日", a: "#FFB547", b: "#FF4F7B" },
  aurora: { name: "极光", a: "#4BF0B5", b: "#9B7BFF" },
  white: { name: "纯白", a: "#FFFFFF", b: "#C9C4E8" },
} as const;

export type PresetId = keyof typeof PRESETS;

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

/** 默认底色：深紫夜色 */
export const INK = "#1A1238";

type Rgb = [number, number, number];
type Hsl = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: Rgb): string {
  const part = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}

function rgbToHsl([r, g, b]: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]: Hsl): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * 把任意颜色调成"发光色"：亮度拉到 0.55–0.75，饱和度至少 0.55（乘 1.25）。
 * 灰色（饱和度 < 0.12）保持低饱和，不硬染色。
 * 自选颜色都过这一道，所以选得再深，白字也看得清。
 */
export function glow(hex: string): string {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  const sat = s < 0.12 ? s : clamp(Math.max(0.55, s * 1.25), 0, 1);
  return rgbToHex(hslToRgb([h, sat, clamp(l, 0.55, 0.75)]));
}

/** 两色插值成 n 个颜色 */
export function ramp(a: string, b: string, n = 6): string[] {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0 : i / (n - 1);
    return rgbToHex([
      ra[0] + (rb[0] - ra[0]) * t,
      ra[1] + (rb[1] - ra[1]) * t,
      ra[2] + (rb[2] - ra[2]) * t,
    ]);
  });
}

/** 跟随配色的底色：挑饱和度最高的颜色，饱和度压到 0.6 以内，亮度固定 0.11 */
export function deepTone(colors: string[]): string {
  let best: Hsl = [0, 0, 0];
  for (const c of colors) {
    const hsl = rgbToHsl(hexToRgb(c));
    if (hsl[1] > best[1]) best = hsl;
  }
  return rgbToHex(hslToRgb([best[0], Math.min(best[1], 0.6), 0.11]));
}

export interface Look {
  /** 6 个颜色，写进 --c0 ~ --c5 */
  colors: string[];
  /** 底色，写进 --base */
  base: string;
  /** 色彩鲜艳度 0–1 */
  vivid: number;
  /** 背景暗度 0–1 */
  dim: number;
}

/** 把一套外观写成 CSS 变量。颜色变量注册过，变化时会自己过渡 1.2 秒。 */
export function applyLook(look: Look): void {
  const style = document.documentElement.style;
  look.colors.forEach((c, i) => style.setProperty(`--c${i}`, c));
  style.setProperty("--base", look.base);
  style.setProperty("--vivid", String(0.3 + look.vivid * 1.4));
  style.setProperty("--dim", String(look.dim));
}
