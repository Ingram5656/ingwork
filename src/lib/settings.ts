// 设置：读、存、跨窗口同步。
// 加新设置时：在 Settings 里加一项并写一行注释，在 DEFAULT_SETTINGS 里给默认值。
// 读的时候用"默认值 + 存下来的"合并，所以老用户会自动拿到新设置的默认值，不用写迁移。

import { emit } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import type { PresetId } from "./palette";
import type { SleepScene } from "./sleep/scenery";
import type { SleepFrame } from "./sleep/frames";
import { IS_MAC } from "./platform";
import { onEvent } from "./tauri";

export type Phase = "focus" | "shortBreak" | "longBreak";
export const PHASES: Phase[] = ["focus", "shortBreak", "longBreak"];

export type Lang = "zh" | "en";
export type SoundId = "bell" | "drop" | "chord" | "marimba" | "none";
export type CloseAction = "ask" | "tray" | "quit";
export type ShortcutId = "toggle" | "skip" | "window" | "widget" | "translate" | "capture";
export type WidgetSize = "small" | "medium";
export type WidgetLayer = "top" | "desktop";
/** Mac 上小组件显示在哪：桌面上的浮窗，还是刘海（灵动岛） */
export type WidgetPlace = "float" | "notch";

export type BgMode = "fluid" | "gradient" | "media";

/** 自己选的背景文件。文件本身存在 IndexedDB 里，这里只记它是什么 */
export interface BgMedia {
  kind: "image" | "video";
  /** 原来的文件名，给设置面板显示 */
  name: string;
  /** 存进去的时刻。换了文件它就变，界面靠它知道要重新读 */
  stamp: number;
}

/** 桌面小组件 */
export interface WidgetSettings {
  /** 开着没有 */
  open: boolean;
  /** 小号只有时间和进度环；中号多显示阶段和轮次 */
  size: WidgetSize;
  /** 置顶悬浮，还是贴在桌面（在所有窗口下面） */
  layer: WidgetLayer;
  /** Mac：显示成桌面浮窗还是刘海番茄。Windows 上没有刘海，一直是浮窗 */
  place: WidgetPlace;
  /** 锁定：鼠标穿透，点不到它 */
  locked: boolean;
  /** 上次的位置（物理像素），null 是放到默认位置 */
  x: number | null;
  y: number | null;
}

/** 每个阶段的时长存在哪一项设置里，最短、最长各几分钟。设置面板和滚轮调时长共用 */
export const DURATIONS: Record<Phase, { key: "focusMin" | "shortMin" | "longMin"; min: number; max: number }> = {
  focus: { key: "focusMin", min: 1, max: 90 },
  shortBreak: { key: "shortMin", min: 1, max: 30 },
  longBreak: { key: "longMin", min: 1, max: 60 },
};

/** 主窗口的三页 */
export type Page = "today" | "schedule" | "review" | "lecture";

/** 翻译引擎："google" 是免费接口（连不上自动换 MyMemory），"llm" 是自己的大模型接口 */
export type TranslateEngine = "google" | "llm";

/** 大模型引擎用的 OpenAI 兼容接口 */
export interface LlmSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 一个阶段的配色：用预设，或者自己选两个颜色 */
export interface ThemeChoice {
  preset: PresetId | "custom";
  a: string;
  b: string;
}

export interface Settings {
  /** 专注多少分钟 */
  focusMin: number;
  /** 短休息多少分钟 */
  shortMin: number;
  /** 长休息多少分钟 */
  longMin: number;
  /** 几轮专注后长休息 */
  rounds: number;
  /** 一段结束后自动开始下一段 */
  autoStart: boolean;

  /** 提示音，"none" 是不出声 */
  sound: SoundId;
  /** 提示音音量 0–1 */
  volume: number;
  /** 到点发系统通知 */
  notify: boolean;
  /** 到点把主窗口叫出来 */
  raiseWindow: boolean;

  /** 专注时播放环境音 */
  ambientOn: boolean;
  /** 休息时也播放环境音 */
  ambientInBreaks: boolean;
  /** 每个环境音的音量 0–1。0 或者没写就是不放 */
  ambientMix: Record<string, number>;

  /** 三个阶段各自的配色 */
  themes: Record<Phase, ThemeChoice>;
  /** 色彩鲜艳度 0–1 */
  vivid: number;
  /** 背景暗度 0–0.8 */
  dim: number;
  /** 背景样式：流体色块、渐变、自己的图片或视频 */
  bgMode: BgMode;
  /** 自己选的背景文件，没选是 null */
  bgMedia: BgMedia | null;
  /** 底色跟随配色（关掉就是固定的深紫夜色） */
  baseFollows: boolean;
  /** 显示倒计时外面的进度光圈 */
  ring: boolean;

  /** 全局快捷键，空字符串是不设 */
  shortcuts: Record<ShortcutId, string>;

  /** 桌面小组件 */
  widget: WidgetSettings;
  /** 主窗口总在最前 */
  alwaysOnTop: boolean;
  /** Mac：只在菜单栏显示，不占 Dock 和 ⌘Tab */
  dockHidden: boolean;

  /** 主窗口现在在哪一页，下次打开还在这一页 */
  page: Page;
  /** 上课前几分钟提醒，也是路上要留的时间。0 是不提醒 */
  classLead: number;
  /** 离下节课不够一个完整番茄时，提示把这一段改短 */
  gapHint: boolean;
  /** 截止日期前一天晚上、当天早上各提醒一次 */
  /** 听课用的 DeepSeek 密钥（听写、翻译、整理笔记都用它） */
  lectureKey: string;
  /** 上课时间到了，问一下要不要开始听课 */
  lectureAsk: boolean;
  /** 听课时先降噪（去掉空调、风扇这类一直响的声音） */
  lectureDenoise: boolean;
  /** 听课时把录音存在这台电脑上（能回放、课后能用录音重新整理） */
  lectureSaveAudio: boolean;
  /** 听课录哪里的声音：麦克风，或者电脑正在放的声音（网课、回放） */
  lectureSource: "mic" | "system";
  /** 用麦克风时用哪一个（设备的名字）。空的是系统默认的 */
  lectureMic: string;
  /** 听写用哪个：DeepSeek，或者 Groq 上的 Whisper（能指定语言、带术语提示，要另填密钥） */
  lectureAsr: "deepseek" | "groq";
  /** Groq 的密钥 */
  lectureGroqKey: string;
  /** 老师讲课的语言：英文（听成别的语言的算没听清），或者不限 */
  lectureLanguage: "en" | "auto";
  /** 睡眠模式：雨量 0–100，0 是晴天 */
  sleepRain: number;
  /** 雨往哪边斜（度），-40 到 40 */
  sleepAngle: number;
  sleepThunder: boolean;
  /** 睡眠模式里的声音开没开（雷声、环境音都归它管） */
  sleepSound: boolean;
  /** 睡眠模式的环境音，各自的音量 0–1 */
  sleepAmbient: Record<string, number>;
  sleepScene: SleepScene;
  sleepFrame: SleepFrame;
  /** Mac 触控板轻震：调番茄时长的每一格、调到头、刘海番茄展开。名字是历史原因，管的是全部 */
  islandHaptics: boolean;
  /** 第一次打开时的引导走完了（或者点了跳过） */
  onboarded: boolean;
  deadlineRemind: boolean;
  /** 时间轴上排进空档的任务，到点提醒并设成当前任务 */
  blockRemind: boolean;
  /** 专注时收起两边，只留时钟、下节课和杂念箱 */
  focusLayout: boolean;

  /** 翻译引擎 */
  trEngine: TranslateEngine;
  /** 大模型接口 */
  trLlm: LlmSettings;
  /** 目标语言，"auto" 是中英互译 */
  trTarget: string;
  /** 呼出翻译时填入新复制的文字 */
  trClipboard: boolean;
  /** 翻译和杂念箱两个小窗的界面大小 0.7–1.6 */
  popupScale: number;
  /** ingtranslate 的设置已经接过来了（只接一次） */
  trImported: boolean;

  /** 界面语言 */
  lang: Lang;
  /** 关主窗口时：问一下、留在托盘、退出 */
  closeAction: CloseAction;
}

function systemLang(): Lang {
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export const DEFAULT_SETTINGS: Settings = {
  focusMin: 25,
  shortMin: 5,
  longMin: 15,
  rounds: 4,
  autoStart: false,

  sound: "bell",
  volume: 0.7,
  notify: true,
  raiseWindow: true,

  ambientOn: false,
  ambientInBreaks: false,
  ambientMix: { rain: 0.6 },

  themes: {
    focus: { preset: "neon", a: "#FF5FA2", b: "#7B5CFF" },
    shortBreak: { preset: "aurora", a: "#4BF0B5", b: "#9B7BFF" },
    longBreak: { preset: "ocean", a: "#3DE8FF", b: "#2F5BFF" },
  },
  vivid: 0.5,
  dim: 0.25,
  bgMode: "fluid",
  bgMedia: null,
  baseFollows: false,
  ring: true,

  shortcuts: {
    toggle: "Control+Alt+P",
    skip: "Control+Alt+N",
    window: "Control+Alt+O",
    widget: "Control+Alt+W",
    // Mac 上 ⌥ 加字母是用来打特殊字符的（⌥N 是 ñ 上那个波浪号），全局占了会打不出字，所以用 ⌃⌥
    translate: IS_MAC ? "Control+Alt+T" : "Alt+Q",
    capture: IS_MAC ? "Control+Alt+I" : "Alt+N",
  },

  widget: { open: false, size: "small", layer: "top", place: "float", locked: false, x: null, y: null },
  alwaysOnTop: false,
  dockHidden: false,

  page: "today",
  classLead: 10,
  gapHint: true,
  islandHaptics: true,
  lectureKey: "",
  lectureAsk: true,
  lectureDenoise: false,
  lectureSaveAudio: false,
  lectureSource: "mic",
  lectureMic: "",
  lectureAsr: "deepseek",
  lectureGroqKey: "",
  lectureLanguage: "en",
  sleepRain: 45,
  sleepAngle: -8,
  sleepThunder: false,
  sleepSound: true,
  sleepAmbient: { rain: 0.6 },
  sleepScene: "city",
  sleepFrame: "none",
  onboarded: false,
  deadlineRemind: true,
  blockRemind: true,
  focusLayout: true,

  trEngine: "google",
  trLlm: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" },
  trTarget: "auto",
  trClipboard: true,
  popupScale: 1,
  trImported: false,

  lang: "zh",
  closeAction: "ask",
};

/** 存在 localStorage 里的键。发布以后不要改，改了老用户的设置就找不到了。 */
const KEY = "ingwork.settings";

/** 存下来的设置和默认值合并：老版本存的设置少了新加的项，用默认值补上 */
function normalize(saved: Partial<Settings>): Settings {
  const base: Settings = { ...DEFAULT_SETTINGS, lang: systemLang() };
  return {
    ...base,
    ...saved,
    // 这几项里面还有一层，单独合并，以后往里加东西时老用户也有默认值
    themes: { ...base.themes, ...saved.themes },
    shortcuts: { ...base.shortcuts, ...saved.shortcuts },
    widget: { ...base.widget, ...saved.widget },
    trLlm: { ...base.trLlm, ...saved.trLlm },
    sleepAmbient: { ...(saved.sleepAmbient ?? base.sleepAmbient) },
  };
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return normalize({});
    const saved = JSON.parse(raw) as Partial<Settings>;
    // 老用户升级上来不再走一遍第一次打开的引导
    return normalize({ onboarded: true, ...saved });
  } catch {
    return normalize({});
  }
}

let current: Settings = load();
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

export function getSettings(): Settings {
  return current;
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

type Patch = Partial<Settings> | ((latest: Settings) => Partial<Settings>);

/**
 * 改设置：存一次，通知本窗口，再发事件让其他窗口同步。
 * 每次都在刚从存储里读出来的最新值上改，这样两个窗口先后改不同的项不会互相盖掉。
 * 要在某一项里面改一部分时传函数：update((s) => ({ widget: { ...s.widget, open: true } }))
 */
export function updateSettings(patch: Patch): void {
  current = { ...current, ...(typeof patch === "function" ? patch(current) : patch) };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch (error) {
    console.error("[ingwork] 设置没存下来", error);
  }
  notify();
  // 新的设置直接放在通知里：Mac 上每个窗口的网页在不同的进程里，
  // 收到通知时马上去读本地存储，可能还读到旧的
  emit("settings-changed", current).catch(() => {});
}

let syncing = false;

/** 其他窗口改了设置时跟着更新。每个窗口启动时调一次。 */
export function initSettingsSync(): void {
  if (syncing) return;
  syncing = true;
  onEvent<Partial<Settings> | null>("settings-changed", (payload) => {
    const next = payload && typeof payload === "object" ? normalize(payload) : load();
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      current = next;
      notify();
    }
  });
}

export function useSettings(): [Settings, (patch: Patch) => void] {
  const settings = useSyncExternalStore(subscribeSettings, getSettings);
  return [settings, updateSettings];
}
