// 计时在后端（Rust）里走，这里只是把状态接过来给界面用。
// 后端每秒发一次状态；两次之间界面自己按本地时间往下推，数字才走得顺。

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { t } from "./i18n";
import { getSettings, subscribeSettings, type Phase, type Settings } from "./settings";
import { call, onEvent } from "./tauri";

/** 后端发来的状态 */
export interface TimerState {
  phase: Phase;
  running: boolean;
  remainingMs: number;
  totalMs: number;
  /** 这一组里已经完成了几轮专注 */
  round: number;
  rounds: number;
  /** 这一段是专注结束后在 ingfy 灵动岛上点的"再专注几分钟" */
  bonus?: boolean;
}

/** 不随每一秒变化的那部分。主界面只订阅这个，不会每秒整页重画。 */
export interface TimerCoarse {
  phase: Phase;
  running: boolean;
  /** 这一段已经走过一些时间了 */
  started: boolean;
  round: number;
  rounds: number;
}

let state: TimerState = {
  phase: "focus",
  running: false,
  remainingMs: 25 * 60_000,
  totalMs: 25 * 60_000,
  round: 0,
  rounds: 4,
};
let receivedAt = performance.now();
let coarse: TimerCoarse = toCoarse(state);

const fineListeners = new Set<() => void>();
const coarseListeners = new Set<() => void>();

function toCoarse(s: TimerState): TimerCoarse {
  return {
    phase: s.phase,
    running: s.running,
    started: s.remainingMs < s.totalMs,
    round: s.round,
    rounds: s.rounds,
  };
}

function receive(next: TimerState): void {
  state = next;
  receivedAt = performance.now();
  fineListeners.forEach((listener) => listener());

  const c = toCoarse(next);
  if (
    c.phase !== coarse.phase ||
    c.running !== coarse.running ||
    c.started !== coarse.started ||
    c.round !== coarse.round ||
    c.rounds !== coarse.rounds
  ) {
    coarse = c;
    coarseListeners.forEach((listener) => listener());
  }
}

/** 现在还剩多少毫秒 */
export function remainingNow(): number {
  if (!state.running) return state.remainingMs;
  return Math.max(0, state.remainingMs - (performance.now() - receivedAt));
}

/** 后端每次发来状态时调用（每秒一次，或者有操作时） */
export function subscribeTimer(listener: () => void): () => void {
  fineListeners.add(listener);
  return () => {
    fineListeners.delete(listener);
  };
}

function subscribeCoarse(listener: () => void): () => void {
  coarseListeners.add(listener);
  return () => {
    coarseListeners.delete(listener);
  };
}

export function useTimer(): TimerCoarse {
  return useSyncExternalStore(subscribeCoarse, () => coarse);
}

/** 倒计时现在该显示什么 */
export interface Countdown {
  /** 还剩多少秒（向上取整） */
  secs: number;
  /** 进度，量化成 0 到 resolution 的整数。量化得越粗，重画得越少 */
  lit: number;
}

function readCountdown(resolution: number): Countdown {
  const remaining = remainingNow();
  const total = state.totalMs || 1;
  const progress = Math.max(0, Math.min(1, 1 - remaining / total));
  return { secs: Math.ceil(remaining / 1000), lit: Math.round(progress * resolution) };
}

/**
 * 每秒都在变的那部分：剩余秒数和进度。
 * 只有用到它的组件会跟着刷新；暂停时没东西可画，定时器就停掉。
 */
export function useCountdown(resolution: number): Countdown {
  const running = useTimer().running;
  const [view, setView] = useState<Countdown>(() => readCountdown(resolution));

  useEffect(() => {
    const refresh = () =>
      setView((prev) => {
        const next = readCountdown(resolution);
        return next.secs === prev.secs && next.lit === prev.lit ? prev : next;
      });
    refresh();
    const unsubscribe = subscribeTimer(refresh);
    const id = running ? window.setInterval(refresh, 200) : null;
    return () => {
      unsubscribe();
      if (id !== null) window.clearInterval(id);
    };
  }, [running, resolution]);

  return view;
}

// ---------- 操作 ----------

export const timer = {
  toggle: () => call("timer_toggle"),
  skip: () => call("timer_skip"),
  reset: () => call("timer_reset"),
  setPhase: (phase: Phase) => call("timer_set_phase", { phase }),
  /** 只改这一段的长度，不动设置。这一段已经开始了就不改 */
  setLength: (minutes: number) => call("timer_set_length", { minutes }),
};

/** 这一段一共多少分钟（可能被 setLength 改短过） */
export function useSegmentMinutes(): number {
  return useSyncExternalStore(subscribeTimer, () => Math.round(state.totalMs / 60_000));
}

/** 试听提示音 */
export function playSound(id: string, volume: number): void {
  if (id === "none") return;
  call("play_sound", { id, volume });
}

// ---------- 把设置发给后端 ----------

function pushConfig(s: Settings): void {
  call("timer_configure", {
    config: {
      focusMin: s.focusMin,
      shortMin: s.shortMin,
      longMin: s.longMin,
      rounds: s.rounds,
      autoStart: s.autoStart,
      sound: s.sound,
      volume: s.volume,
      notify: s.notify,
      raiseWindow: s.raiseWindow,
    },
  });
}

/** 托盘菜单和系统通知上的文字。后端不懂语言，由界面按当前语言发过去。 */
function pushTexts(s: Settings): void {
  call("set_tray_texts", {
    texts: {
      start: t("开始"),
      pause: t("暂停"),
      skip: t("跳过这一段"),
      open: t("打开主窗口"),
      quit: t("退出"),
      focus: t("专注"),
      shortBreak: t("短休息"),
      longBreak: t("长休息"),
      running: t("{phase} · 还剩 {time}"),
      paused: t("{phase} · 已暂停，还剩 {time}"),
      focusDoneTitle: t("专注结束"),
      focusDoneShort: t("休息 {n} 分钟", { n: s.shortMin }),
      focusDoneLong: t("这一组完成了，休息 {n} 分钟", { n: s.longMin }),
      breakDoneTitle: t("休息结束"),
      breakDoneBody: t("开始下一段专注，{n} 分钟", { n: s.focusMin }),
      widgetShow: t("显示小组件"),
      widgetHide: t("隐藏小组件"),
      widgetLock: t("锁定小组件"),
      widgetUnlock: t("解锁小组件"),
    },
  });
}

let listening = false;
let pushing = false;

/** 接上后端的状态。每个窗口启动时调一次。 */
export function initTimer(): void {
  if (listening) return;
  listening = true;
  onEvent<TimerState>("timer-state", receive);
  invoke<TimerState>("timer_get")
    .then(receive)
    .catch((error) => console.error("[ingwork] timer_get", error));
}

/** 把设置同步给后端，之后每次改设置都再发一次。只有主窗口调。 */
export function initTimerConfig(): void {
  if (pushing) return;
  pushing = true;
  let last = "";
  const push = () => {
    const s = getSettings();
    const key = JSON.stringify([
      s.focusMin,
      s.shortMin,
      s.longMin,
      s.rounds,
      s.autoStart,
      s.sound,
      s.volume,
      s.notify,
      s.raiseWindow,
      s.lang,
    ]);
    if (key === last) return;
    last = key;
    pushConfig(s);
    pushTexts(s);
  };
  push();
  subscribeSettings(push);
}
