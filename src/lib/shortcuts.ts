// 全局快捷键：注册、录制、占用提示。
// 快捷键写成 "Control+Alt+P" 这样的字符串，空字符串表示不设。

import { register, unregister, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { useSyncExternalStore } from "react";
import { IS_MAC } from "./platform";
import { getSettings, subscribeSettings, type ShortcutId } from "./settings";
import { timer } from "./timer";
import { togglePopup } from "./popups";
import { call } from "./tauri";
import { toggleWidget } from "./windows";

export const SHORTCUT_IDS: ShortcutId[] = ["translate", "capture", "toggle", "skip", "window", "widget"];

/** 每个快捷键做什么。名字是界面上显示的中文。 */
export const SHORTCUT_NAMES: Record<ShortcutId, string> = {
  toggle: "开始 / 暂停",
  skip: "跳过这一段",
  window: "显示 / 隐藏主窗口",
  widget: "显示 / 隐藏小组件",
  translate: "呼出翻译",
  capture: "记一条杂念",
};

function run(id: ShortcutId): void {
  if (id === "toggle") timer.toggle();
  else if (id === "skip") timer.skip();
  else if (id === "widget") toggleWidget();
  else if (id === "translate") togglePopup("translate");
  else if (id === "capture") togglePopup("capture");
  else call("toggle_main");
}

/** 现在注册着的组合 */
const active = new Map<ShortcutId, string>();
/** 没注册上的（多半是被别的软件占用了） */
let failed: ReadonlySet<ShortcutId> = new Set();
const listeners = new Set<() => void>();

function setFailed(next: Set<ShortcutId>): void {
  failed = next;
  listeners.forEach((listener) => listener());
}

/** 一个接一个地做，免得两次改动互相打架 */
let queue: Promise<void> = Promise.resolve();

async function apply(wanted: Record<ShortcutId, string>): Promise<void> {
  const nextFailed = new Set(failed);
  for (const id of SHORTCUT_IDS) {
    const accel = wanted[id];
    if (active.get(id) === accel && !failed.has(id)) continue;

    const old = active.get(id);
    if (old) {
      try {
        await unregister(old);
      } catch {
        // 本来就没注册上，不用管
      }
    }
    active.delete(id);
    nextFailed.delete(id);
    if (!accel) continue;

    try {
      await register(accel, (event) => {
        if (event.state === "Pressed") run(id);
      });
      active.set(id, accel);
    } catch {
      active.set(id, accel);
      nextFailed.add(id);
    }
  }
  setFailed(nextFailed);
}

let started = false;

/** 按设置注册快捷键，之后设置变了就跟着改。只有主窗口调。 */
export function initShortcuts(): void {
  if (started) return;
  started = true;
  // 开发时页面刷新后，上一次注册的还留在后端，先清掉
  queue = queue.then(() => unregisterAll().catch(() => {}));
  let last = "";
  const sync = () => {
    const wanted = { ...getSettings().shortcuts };
    const key = JSON.stringify(wanted);
    if (key === last) return;
    last = key;
    queue = queue.then(() => apply(wanted)).catch(() => {});
  };
  sync();
  subscribeSettings(sync);
}

/** 哪些快捷键没注册上 */
export function useFailedShortcuts(): ReadonlySet<ShortcutId> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => failed,
  );
}

const ARROWS: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

/**
 * 把一次按键变成快捷键字符串。
 * 只按了修饰键、或者没带 Ctrl / Alt（Mac 上还有 ⌘）时返回 null（全局快捷键不带修饰键会抢走正常打字）。
 */
export function accelFromEvent(event: KeyboardEvent): string | null {
  const code = event.code;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(code)) key = code;
  else if (code === "Space") key = "Space";
  else if (code in ARROWS) key = ARROWS[code];
  if (!key) return null;
  const command = IS_MAC && event.metaKey;
  if (!event.ctrlKey && !event.altKey && !command) return null;

  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Control");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (command) parts.push("Command");
  parts.push(key);
  return parts.join("+");
}

/** Mac 上修饰键用符号写 */
const MAC_KEYS: Record<string, string> = {
  Control: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Command: "⌘",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
};

/** 显示用：Windows 上 ["Ctrl", "Alt", "P"]，Mac 上 ["⌃", "⌥", "P"] */
export function accelKeys(accel: string): string[] {
  if (!accel) return [];
  return accel
    .split("+")
    .map((part) => (IS_MAC ? (MAC_KEYS[part] ?? part) : part === "Control" ? "Ctrl" : part));
}
