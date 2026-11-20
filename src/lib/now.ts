// 现在几点。时间轴、下节课倒计时这些按分钟变的东西用它，每分钟整点刷新一次，不每秒重画。

import { useSyncExternalStore } from "react";

let now = new Date();
const listeners = new Set<() => void>();
let timer: number | null = null;

function tick(): void {
  now = new Date();
  listeners.forEach((listener) => listener());
  schedule();
}

/** 定到下一分钟的第 0 秒 */
function schedule(): void {
  const wait = 60_000 - (Date.now() % 60_000) + 50;
  timer = window.setTimeout(tick, wait);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    now = new Date();
    schedule();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };
}

/** 现在的时间，精确到分钟 */
export function useNow(): Date {
  return useSyncExternalStore(subscribe, () => now);
}

/** 窗口从睡眠里醒来、或者从托盘里叫出来时，马上刷新一次 */
export function refreshNow(): void {
  if (listeners.size > 0) {
    if (timer !== null) window.clearTimeout(timer);
    tick();
  }
}
