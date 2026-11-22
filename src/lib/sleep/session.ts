// 睡眠模式开没开、定时到几点，以及"现在该放哪些声音、多大声"。
//
// 声音（环境音、雷声）只看睡眠模式里那个声音按钮，不管计时在不在走、有没有在放音乐。
// 环境音本身由后端放（和专注时的环境音是同一套，见 lib/ambient.ts），这里算好音量交过去。
// 定时：到点前 20 秒声音慢慢变小，到点把声音关掉，画面留着。

import { useSyncExternalStore } from "react";
import { setSleepAmbient } from "../ambient";
import { getSettings, subscribeSettings, updateSettings } from "../settings";

/** 睡眠模式里有哪些环境音，按这个顺序列（后端的 sounds/ambient 里得有这个文件） */
export const SLEEP_SOUNDS: { id: string; label: string }[] = [
  { id: "rain", label: "雨声" },
  { id: "waves", label: "海浪" },
  { id: "brown", label: "褐噪音" },
  { id: "white", label: "白噪音" },
  { id: "birds", label: "鸟声" },
  { id: "traffic", label: "车声" },
  { id: "wind", label: "风声" },
];

/** 几个文件本身响度不一样，这里拉平；白噪音听着刺耳，压低一些 */
const BASE: Record<string, number> = {
  rain: 1,
  waves: 1.1,
  brown: 0.85,
  white: 0.6,
  birds: 1.2,
  traffic: 1,
  wind: 1,
};

/** 定时到点前多久开始慢慢变小 */
export const SLEEP_FADE_MS = 20_000;

/** 雨量 0–100 → 雨声有多响（0–1）：晴天没有，毛毛雨轻轻的，瓢泼大雨最响 */
function rainLoudness(rain: number): number {
  const k = Math.max(0, Math.min(1, rain / 100));
  if (k <= 0) return 0;
  return Math.min(1, k / 0.04) * (0.32 + 0.68 * Math.pow(k, 0.7));
}

/** 设置里的滑块 + 现在的雨量 → 每种声音实际放多大声。滑块按听感走：一半的位置听着是一半响 */
export function sleepLevels(mix: Record<string, number>, rain: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { id } of SLEEP_SOUNDS) {
    const v = Math.max(0, Math.min(1, mix[id] ?? 0));
    out[id] = v * v * (BASE[id] ?? 1) * (id === "rain" ? rainLoudness(rain) : 1);
  }
  return out;
}

interface Session {
  open: boolean;
  /** 定时到几点（毫秒时间戳），没开定时是 null */
  endsAt: number | null;
  /** 定时选的是几分钟（按钮上显示用） */
  minutes: number | null;
}

let session: Session = { open: false, endsAt: null, minutes: null };
const listeners = new Set<() => void>();

function set(next: Session): void {
  session = next;
  listeners.forEach((listener) => listener());
  drive();
}

export function useSleep(): Session {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => session,
  );
}

export function openSleep(): void {
  if (!session.open) set({ ...session, open: true });
}

export function closeSleep(): void {
  if (session.open) set({ open: false, endsAt: null, minutes: null });
}

export function toggleSleep(): void {
  if (session.open) closeSleep();
  else openSleep();
}

/** 定时可以选的几档（分钟） */
export const SLEEP_TIMERS = [15, 30, 60] as const;

/** 定时：null 是关掉。点一次换下一档：关 → 15 → 30 → 60 → 关 */
export function cycleSleepTimer(): void {
  const i = session.minutes === null ? -1 : SLEEP_TIMERS.indexOf(session.minutes as 15 | 30 | 60);
  const next = i + 1 < SLEEP_TIMERS.length ? SLEEP_TIMERS[i + 1] : null;
  // 定时是给声音用的：声音关着时开定时，顺手把声音打开
  if (next !== null && !getSettings().sleepSound) updateSettings({ sleepSound: true });
  set({ ...session, minutes: next, endsAt: next === null ? null : Date.now() + next * 60_000 });
}

// ---------- 把声音交给后端 ----------

let ticker: number | null = null;

/** 按现在的设置和定时算一遍音量，交给环境音 */
function drive(): void {
  if (!session.open) {
    if (ticker !== null) {
      window.clearInterval(ticker);
      ticker = null;
    }
    setSleepAmbient(null);
    return;
  }
  const s = getSettings();
  let fade = 1;
  if (session.endsAt !== null) {
    const left = session.endsAt - Date.now();
    if (left <= 0) {
      // 到点：声音关掉，定时清掉，画面留着
      if (ticker !== null) {
        window.clearInterval(ticker);
        ticker = null;
      }
      session = { ...session, endsAt: null, minutes: null };
      listeners.forEach((listener) => listener());
      setSleepAmbient({});
      if (s.sleepSound) updateSettings({ sleepSound: false });
      return;
    }
    if (left < SLEEP_FADE_MS) fade = left / SLEEP_FADE_MS;
  }
  if (!s.sleepSound) {
    setSleepAmbient({});
  } else {
    const levels = sleepLevels(s.sleepAmbient, s.sleepRain);
    // 一点点往下调，后端按新音量直接设，听起来就是慢慢变小。取两位小数，免得每秒都发一遍一样的
    for (const id of Object.keys(levels)) levels[id] = Math.round(levels[id] * fade * 100) / 100;
    setSleepAmbient(levels);
  }
  // 开着定时才需要每秒算一遍（剩余时间、最后 20 秒的渐弱）
  if (session.endsAt !== null && ticker === null) {
    ticker = window.setInterval(drive, 1000);
  } else if (session.endsAt === null && ticker !== null) {
    window.clearInterval(ticker);
    ticker = null;
  }
}

let started = false;

/** 主窗口调一次：设置变了（声音开关、滑块、雨量）重新算音量 */
export function initSleep(): void {
  if (started) return;
  started = true;
  subscribeSettings(() => {
    if (session.open) drive();
  });
}
