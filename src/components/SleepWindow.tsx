// 睡眠模式的那扇窗（从 ingfy 的助眠模式搬过来，画面完全一样）。
// 和 ingfy 不同的是声音：这里不管音乐，声音开关由睡眠模式自己的按钮管（见 lib/sleep/sound.ts）。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SleepFrame } from "../lib/sleep/frames";
import { fogMix, RainGlass, stormMix, type Glass } from "../lib/sleep/rain";
import { RainGlassFlat } from "../lib/sleep/rainFlat";
import { paintScene, type SleepScene } from "../lib/sleep/scenery";
import { playThunder, stopThunder } from "../lib/sleep/thunder";

interface Props {
  /** 雨量 0–100：0 是晴天，100 是瓢泼大雨 */
  rain: number;
  scene: SleepScene;
  frame: SleepFrame;
  /** 自己选的窗外图片（data URL），scene 是 custom 时用 */
  image: string | null;
  /** 自己选的窗外视频（播放地址），scene 是 video 时用；还在读是 undefined，没有是 null */
  video?: string | null;
  /** 雨往哪边斜（度）：负数往左，正数往右 */
  angle: number;
  /** 打雷：下雨时隔一阵来一次，两次之间至少隔 40 秒 */
  thunder: boolean;
  /** 声音开着：打雷有雷声。关着只有闪电 */
  sound: boolean;
}

/** 上一次打雷是什么时候。放在组件外面：关了再开、换了景色，"至少隔 40 秒"照样算数 */
let lastStrike = 0;
const THUNDER_GAP = 40_000;

function useImage(src: string | null) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!src) {
      setImg(null);
      return;
    }
    let alive = true;
    const el = new Image();
    el.onload = () => alive && setImg(el);
    el.onerror = () => alive && setImg(null);
    el.src = src;
    return () => {
      alive = false;
    };
  }, [src]);
  return img;
}

/**
 * 助眠模式的那扇窗，铺满整个窗口。从下到上：
 * 晴天的景色 → 雨天的景色（按雨量淡入）→（窗外是视频时：视频）→ 玻璃外面的雨丝和闪电 → 起雾的玻璃和雨滴 → 窗框。
 * 雾和雨滴由显卡画在同一层（水滴滑过的地方雾会被擦开）；显卡起不来时退回简单画法，
 * 雾用两张模糊的画布垫在下面。
 */
export function SleepWindow({ rain, scene, frame, image, video, angle, thunder, sound }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const clearRef = useRef<HTMLCanvasElement>(null);
  const stormRef = useRef<HTMLCanvasElement>(null);
  const fogClearRef = useRef<HTMLCanvasElement>(null);
  const fogStormRef = useRef<HTMLCanvasElement>(null);
  const streakRef = useRef<HTMLCanvasElement>(null);
  const dropsRef = useRef<HTMLCanvasElement>(null);
  const glass = useRef<Glass | null>(null);
  // 雾由谁画：显卡那一层自己画（true），还是用下面两张模糊的画布（false）
  const [glFog, setGlFog] = useState(true);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const videoRef = useRef<HTMLVideoElement>(null);
  const img = useImage(scene === "custom" ? image : null);
  const videoSrc = scene === "video" && video ? video : null;
  // 选了"我的图片 / 我的视频"但还没有（或者打不开）时先用城市夜景；视频放起来以后盖在它上面
  const shown: SleepScene = scene === "video" || (scene === "custom" && !img) ? "city" : scene;

  // 跟着窗口大小走；拖窗口边的时候等停下来再重画
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => setSize((p) => (p.w === el.clientWidth && p.h === el.clientHeight ? p : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(measure, 160);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const cv = dropsRef.current;
    if (!cv || !streakRef.current) return;
    let g: Glass | null = null;
    try {
      g = new RainGlass(cv, streakRef.current);
    } catch {
      try {
        g = new RainGlassFlat(cv);
      } catch {
        g = null; // 两种都起不来：只有景色和雾，没有雨滴
      }
    }
    glass.current = g;
    setGlFog(!!g?.gl);
    g?.start();
    return () => {
      g?.dispose();
      glass.current = null;
    };
  }, []);

  // 画景色：晴、雨各一张，再各缩一张模糊的当起雾的玻璃
  useEffect(() => {
    const { w, h } = size;
    const clear = clearRef.current;
    const storm = stormRef.current;
    const fogA = fogClearRef.current;
    const fogB = fogStormRef.current;
    if (!w || !h || !clear || !storm || !fogA || !fogB) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = Math.min(dpr, 2880 / w);
    paintScene(clear, w * scale, h * scale, shown, false, img);
    paintScene(storm, w * scale, h * scale, shown, true, img);
    for (const [src, dst] of [[clear, fogA], [storm, fogB]] as const) {
      // 模糊的那张只要四分之一大小：反正是糊的，省内存
      dst.width = Math.max(1, Math.round(w / 4));
      dst.height = Math.max(1, Math.round(h / 4));
      const c = dst.getContext("2d");
      if (!c) continue;
      c.filter = "blur(3px)";
      // 画大一圈，模糊后四边不露底
      c.drawImage(src, -8, -8, dst.width + 16, dst.height + 16);
      c.filter = "none";
      // 雾气本身带一点冷白
      c.fillStyle = "rgba(196,208,232,0.05)";
      c.fillRect(0, 0, dst.width, dst.height);
    }
    const g = glass.current;
    if (g) {
      g.resize(w, h, Math.min(window.devicePixelRatio || 1, 1.5));
      g.setScene(clear, storm, fogA, fogB);
      g.setRain(rain / 100);
    }
  }, [size, shown, img]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    glass.current?.setRain(rain / 100);
  }, [rain]);

  useEffect(() => {
    glass.current?.setAngle(angle);
  }, [angle, size]);

  // 窗外是视频：交给画雨滴的那一层（折射和雾跟着视频走）；窗口不在前台时停下来
  useEffect(() => {
    const v = videoRef.current;
    if (!videoSrc || !v) return;
    glass.current?.setVideo(v);
    const sync = () => {
      if (document.hidden) v.pause();
      else void v.play().catch(() => {});
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      glass.current?.setVideo(null);
    };
  }, [videoSrc, size]);

  // 打雷：下雨的时候隔一阵来一次。雨越大来得越勤，但两次之间至少隔 40 秒；晴天不打。
  // 声音关着时只有闪电
  const rainRef = useRef(rain);
  rainRef.current = rain;
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const raining = rain > 0;
  useEffect(() => {
    if (!sound) stopThunder();
  }, [sound]);
  useEffect(() => {
    if (!thunder || !raining) return;
    let timer: ReturnType<typeof setTimeout>;
    const plan = (first: boolean) => {
      const k = rainRef.current / 100;
      const now = Date.now();
      // 刚打开时很快先来一次，让人知道开着；之后隔 40 秒再加一段随机的时间
      const at = first ? Math.max(now + 5000 + Math.random() * 12000, lastStrike + THUNDER_GAP) : lastStrike + THUNDER_GAP + Math.random() * (90000 - 50000 * k);
      timer = setTimeout(strike, Math.max(0, at - now));
    };
    const strike = () => {
      if (!document.hidden) {
        lastStrike = Date.now();
        const near = Math.random(); // 离得多近：近的更亮、看得见闪电、雷声来得快也更响
        glass.current?.flash(near > 0.4);
        if (soundRef.current) playThunder(0.4 + (1 - near) * 2.8, near);
      }
      plan(false);
    };
    plan(true);
    return () => {
      clearTimeout(timer);
      stopThunder();
    };
  }, [thunder, raining]);

  const k = Math.max(0, Math.min(1, rain / 100));
  const mix = stormMix(k);
  return (
    <div className="sleep" ref={root} aria-hidden="true">
      <canvas ref={clearRef} className="sleep-cv" />
      <canvas ref={stormRef} className="sleep-cv sleep-fade" style={{ opacity: mix }} />
      {videoSrc && (
        <video
          ref={videoRef}
          className="sleep-cv sleep-video"
          src={videoSrc}
          muted
          loop
          playsInline
          autoPlay
          disablePictureInPicture
          // 下雨时压灰、压暗（和雨滴那一层里对视频的处理一致）
          style={{ filter: `saturate(${(1 - 0.5 * mix).toFixed(3)}) brightness(${(1 - 0.28 * mix).toFixed(3)})` }}
        />
      )}
      <canvas ref={streakRef} className="sleep-cv" />
      <div className="sleep-fog sleep-fade" style={{ opacity: glFog || videoSrc ? 0 : fogMix(k) }}>
        <canvas ref={fogClearRef} className="sleep-cv" />
        <canvas ref={fogStormRef} className="sleep-cv sleep-fade" style={{ opacity: mix }} />
      </div>
      <canvas ref={dropsRef} className="sleep-cv" />
      <WindowFrame kind={frame} w={size.w} h={size.h} />
    </div>
  );
}

// ------------------------------------------------------------------ 窗框

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/**
 * 窗框，画在雨滴上面。夜里屋里没开灯，窗框只是深色的剪影，边上有一点被窗外映亮的棱。
 * w、h 是窗口的 CSS 尺寸，SVG 按像素画，窗口变了跟着重排。
 */
function WindowFrame({ kind, w, h }: { kind: SleepFrame; w: number; h: number }) {
  if (!w || !h) return null;
  if (kind === "wood") return <WoodFrame w={w} h={h} />;
  if (kind === "arch") return <ArchFrame w={w} h={h} />;
  // 无边框：整面都是玻璃，只有四角压暗和一道很淡的反光
  return <div className="sleep-frame sleep-frame--none" />;
}

function WoodFrame({ w, h }: { w: number; h: number }) {
  const t = clamp(Math.min(w, h) * 0.05, 22, 60); // 边框的宽度
  const bar = t * 0.56; // 中间十字格的宽度
  const sill = t * 1.5; // 窗台
  const top = t;
  const bottom = h - sill;
  const cx = w / 2;
  const cy = top + (bottom - top) * 0.42; // 横格偏上一点，下面两扇更高
  const ring = `M0 0H${w}V${h}H0Z M${t} ${top}V${bottom}H${w - t}V${top}Z`;
  return (
    <svg className="sleep-frame" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <defs>
        <linearGradient id="sw-v" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#1B120F" />
          <stop offset="0.45" stopColor="#38271F" />
          <stop offset="1" stopColor="#170F0C" />
        </linearGradient>
        <linearGradient id="sw-h" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#1B120F" />
          <stop offset="0.45" stopColor="#38271F" />
          <stop offset="1" stopColor="#170F0C" />
        </linearGradient>
        <linearGradient id="sw-ring" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#32231C" />
          <stop offset="1" stopColor="#1A110E" />
        </linearGradient>
        <linearGradient id="sw-sill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#4A352A" />
          <stop offset="0.3" stopColor="#32231C" />
          <stop offset="1" stopColor="#130D0A" />
        </linearGradient>
        <filter id="sw-shadow" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="0" stdDeviation={t * 0.45} floodColor="#05030C" floodOpacity="0.7" />
        </filter>
      </defs>
      <g filter="url(#sw-shadow)">
        <path d={ring} fill="url(#sw-ring)" fillRule="evenodd" />
        <rect x={cx - bar / 2} y={top} width={bar} height={bottom - top} fill="url(#sw-v)" />
        <rect x={t} y={cy - bar / 2} width={w - t * 2} height={bar} fill="url(#sw-h)" />
      </g>
      {/* 靠玻璃那一圈被窗外映亮的棱 */}
      <path d={`M${t} ${top}V${bottom}H${w - t}V${top}Z`} fill="none" stroke="rgba(190,205,255,0.16)" strokeWidth="1.5" />
      <path
        d={`M${cx - bar / 2} ${top}V${bottom} M${cx + bar / 2} ${top}V${bottom} M${t} ${cy - bar / 2}H${w - t} M${t} ${cy + bar / 2}H${w - t}`}
        stroke="rgba(190,205,255,0.1)"
        strokeWidth="1"
      />
      {/* 窗台 */}
      <rect x="0" y={bottom} width={w} height={sill} fill="url(#sw-sill)" />
      <rect x="0" y={bottom} width={w} height="1.5" fill="rgba(200,212,255,0.22)" />
      {/* 中间的窗扣 */}
      <rect x={cx - bar * 0.22} y={cy - bar * 1.1} width={bar * 0.44} height={bar * 2.2} rx={bar * 0.22} fill="#6B5846" />
      <circle cx={cx} cy={cy} r={bar * 0.2} fill="#A08A6C" />
    </svg>
  );
}

function ArchFrame({ w, h }: { w: number; h: number }) {
  const ow = Math.min(w * 0.56, h * 1.02); // 窗洞的宽
  const oh = h * 0.84;
  const x0 = (w - ow) / 2;
  const x1 = x0 + ow;
  const y0 = h * 0.07;
  const y1 = y0 + oh;
  const R = ow / 2;
  const cx = w / 2;
  const sy = y0 + R; // 拱和直边交界的那条线
  const ft = clamp(Math.min(w, h) * 0.013, 7, 16); // 窗框的粗细
  const thin = ft * 0.5;
  const opening = `M${x0} ${y1}V${sy}A${R} ${R} 0 0 1 ${x1} ${sy}V${y1}Z`;
  const rows = [1 / 3, 2 / 3].map((p) => sy + (y1 - sy) * p);
  const cols = [1 / 3, 2 / 3].map((p) => x0 + ow * p);
  const ri = R * 0.36; // 扇形格里面那道小拱
  const spokes = [45, 90, 135].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return `M${cx - Math.cos(a) * ri} ${sy - Math.sin(a) * ri}L${cx - Math.cos(a) * R} ${sy - Math.sin(a) * R}`;
  });
  return (
    <svg className="sleep-frame" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <defs>
        {/* 墙：靠窗的地方被窗外的光映亮一点，越远越暗 */}
        <radialGradient id="sa-wall" gradientUnits="userSpaceOnUse" cx={cx} cy={(y0 + y1) / 2} r={Math.max(w, h) * 0.7}>
          <stop offset="0" stopColor="#241B3C" />
          <stop offset="0.5" stopColor="#150F28" />
          <stop offset="1" stopColor="#0A0716" />
        </radialGradient>
        <linearGradient id="sa-sill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#3A2E58" />
          <stop offset="0.25" stopColor="#1E1734" />
          <stop offset="1" stopColor="#0D0919" />
        </linearGradient>
        <filter id="sa-shadow" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="0" stdDeviation={ft * 1.6} floodColor="#04020A" floodOpacity="0.75" />
        </filter>
      </defs>
      <path d={`M0 0H${w}V${h}H0Z ${opening}`} fill="url(#sa-wall)" fillRule="evenodd" filter="url(#sa-shadow)" />
      {/* 细的黑钢窗格：下半截是格子，拱里是扇形 */}
      <g fill="none" stroke="#0B0817" strokeLinecap="butt">
        <path d={`${cols.map((x) => `M${x} ${sy}V${y1}`).join(" ")} ${rows.map((y) => `M${x0} ${y}H${x1}`).join(" ")} ${spokes.join(" ")} M${cx - ri} ${sy}A${ri} ${ri} 0 0 1 ${cx + ri} ${sy}`} strokeWidth={thin} />
        <path d={`M${x0} ${sy}H${x1}`} strokeWidth={ft * 0.8} />
        <path d={opening} strokeWidth={ft} />
      </g>
      <path d={opening} fill="none" stroke="rgba(190,205,255,0.2)" strokeWidth="1.2" transform={`translate(${cx} ${(y0 + y1) / 2}) scale(${1 - ft / ow}) translate(${-cx} ${-(y0 + y1) / 2})`} />
      {/* 窗台 */}
      <rect x={x0 - ft * 2.4} y={y1 - ft * 0.2} width={ow + ft * 4.8} height={ft * 2.4} rx={ft * 0.3} fill="url(#sa-sill)" />
      <rect x={x0 - ft * 2.4} y={y1 - ft * 0.2} width={ow + ft * 4.8} height="1.5" fill="rgba(200,212,255,0.25)" />
    </svg>
  );
}
