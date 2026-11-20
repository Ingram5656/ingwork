// 环境音：专注时循环播放，可以几种叠在一起，各自调音量。
// 声音在后端（Rust）里放；有哪些声音由后端告诉（sounds/ambient 文件夹里有什么就有什么）。
// 什么时候响由后端按计时状态决定，这里只把设置发过去。

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { t } from "./i18n";
import { getSettings, subscribeSettings, updateSettings } from "./settings";
import { call } from "./tauri";

/** 认识的文件名对应的中文名。不认识的直接显示文件名，所以文件也可以直接起中文名。 */
const NAMES: Record<string, string> = {
  rain: "雨声",
  waves: "海浪",
  white: "白噪音",
  brown: "褐噪音",
  cafe: "咖啡馆",
  fire: "篝火",
  forest: "森林",
  wind: "风声",
  stream: "溪流",
  night: "夏夜",
  thunder: "雷雨",
  birds: "鸟鸣",
  train: "火车",
  library: "图书馆",
};

export function ambientName(id: string): string {
  return id in NAMES ? t(NAMES[id]) : id;
}

/** 新选上一个声音时的音量 */
const DEFAULT_VOLUME = 0.6;

interface AmbientView {
  /** 有哪些声音可以选 */
  list: string[];
  /** 正在设置里试听 */
  preview: boolean;
}

let view: AmbientView = { list: [], preview: false };
const listeners = new Set<() => void>();

function setView(next: AmbientView): void {
  view = next;
  listeners.forEach((listener) => listener());
}

export function useAmbient(): AmbientView {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => view,
  );
}

let lastPushed = "";

function push(): void {
  const s = getSettings();
  const config = {
    on: s.ambientOn,
    inBreaks: s.ambientInBreaks,
    preview: view.preview,
    // 只发现在真有的声音，文件换过以后旧名字不会留着
    mix: view.list
      .filter((id) => (s.ambientMix[id] ?? 0) > 0)
      .map((id) => ({ id, volume: s.ambientMix[id] })),
  };
  const key = JSON.stringify(config);
  if (key === lastPushed) return;
  lastPushed = key;
  call("ambient_configure", { config });
}

/** 试听：不管计时走没走，先放出来听听 */
export function setAmbientPreview(on: boolean): void {
  if (view.preview === on) return;
  setView({ ...view, preview: on });
  push();
}

/** 开 / 关环境音。打开时如果一个声音都没选，先替用户选上一个，免得开了没声音。 */
export function toggleAmbient(): void {
  const s = getSettings();
  if (s.ambientOn) {
    updateSettings({ ambientOn: false });
    return;
  }
  const picked = view.list.some((id) => (s.ambientMix[id] ?? 0) > 0);
  if (picked || view.list.length === 0) {
    updateSettings({ ambientOn: true });
    return;
  }
  const first = view.list.includes("rain") ? "rain" : view.list[0];
  updateSettings({ ambientOn: true, ambientMix: { ...s.ambientMix, [first]: DEFAULT_VOLUME } });
}

let started = false;

/** 问后端有哪些声音，并把设置同步过去。只有主窗口调。 */
export function initAmbient(): void {
  if (started) return;
  started = true;
  invoke<string[]>("ambient_list")
    .then((list) => {
      setView({ ...view, list });
      push();
    })
    .catch((e) => console.error("[ingwork] ambient_list", e));
  subscribeSettings(push);
}
