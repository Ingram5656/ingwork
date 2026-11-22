// 窗口相关：桌面小组件（Mac 上也可以放在刘海上）的开关和样子、主窗口置顶和全屏。
// 这些都记在设置里，由主窗口负责告诉后端；小组件自己只改设置。

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import {
  getSettings,
  subscribeSettings,
  updateSettings,
  type WidgetSettings,
  type WidgetSize,
} from "./settings";
import { IS_MAC } from "./platform";
import { toggleSleep } from "./sleep/session";
import { call, onEvent } from "./tauri";

/** 小组件窗口的大小（逻辑像素）。四周各留 14 像素给投影。 */
export const WIDGET_SIZES: Record<WidgetSize, { width: number; height: number }> = {
  small: { width: 240, height: 92 },
  medium: { width: 328, height: 160 },
};

/** 改小组件的某几项 */
export function patchWidget(patch: Partial<WidgetSettings>): void {
  updateSettings((latest) => ({ widget: { ...latest.widget, ...patch } }));
}

/** 显示 / 隐藏小组件。重新显示时总是解锁的，免得一出来就点不到。 */
export function toggleWidget(): void {
  const open = !getSettings().widget.open;
  patchWidget(open ? { open, locked: false } : { open });
}

/** 锁定 / 解锁小组件 */
export function toggleWidgetLock(): void {
  patchWidget({ locked: !getSettings().widget.locked });
}

/** 小组件没打开时后端给的原因（中文），空字符串是没出错 */
let widgetError = "";
const errorListeners = new Set<() => void>();

function setWidgetError(message: string): void {
  if (message === widgetError) return;
  widgetError = message;
  errorListeners.forEach((listener) => listener());
}

/** 设置面板用：小组件没打开时显示原因 */
export function useWidgetError(): string {
  return useSyncExternalStore(
    (listener) => {
      errorListeners.add(listener);
      return () => {
        errorListeners.delete(listener);
      };
    },
    () => widgetError,
  );
}

// ---------- ingfy 的灵动岛 ----------
// 灵动岛开着时，番茄已经显示在灵动岛上了，小组件先让位，免得桌面上漂着两个浮窗。
// 设置里的"显示桌面小组件"不变，灵动岛一关，小组件就回来。

let island = false;
const islandListeners = new Set<() => void>();

function setIsland(next: boolean): void {
  if (next === island) return;
  island = next;
  islandListeners.forEach((listener) => listener());
}

/** ingfy 的灵动岛现在开着 */
export function useIngfyIsland(): boolean {
  return useSyncExternalStore(
    (listener) => {
      islandListeners.add(listener);
      return () => {
        islandListeners.delete(listener);
      };
    },
    () => island,
  );
}

/** 小组件这次显示在刘海上（只有 Mac 有） */
function onNotch(widget: WidgetSettings): boolean {
  return IS_MAC && widget.place === "notch";
}

/** 后端没打开时：把开关拨回去，并把原因留给设置面板显示，不悄悄失败 */
function failed(command: string, error: unknown): void {
  console.error(`[ingwork] ${command}`, error);
  if (getSettings().widget.open) {
    setWidgetError(String(error));
    patchWidget({ open: false });
  }
}

/** 同一时间只有一个在路上：浮窗和刘海要先关一个再开另一个，不能交叉 */
let pushing: Promise<void> = Promise.resolve();

function pushWidget(): void {
  pushing = pushing.then(applyWidget, applyWidget);
}

async function applyWidget(): Promise<void> {
  const { widget } = getSettings();
  const open = widget.open && !island;
  const notch = onNotch(widget);
  const size = WIDGET_SIZES[widget.size];
  const floatSpec = {
    open: open && !notch,
    width: size.width,
    height: size.height,
    x: widget.x,
    y: widget.y,
    onTop: widget.layer === "top",
    locked: widget.locked,
  };
  // 先关掉不用的那个，再开要用的那个，托盘菜单上的字以后开的为准
  if (notch) {
    try {
      await invoke("widget_apply", { spec: { ...floatSpec, open: false } });
      await invoke("island_apply", { open });
      if (open) setWidgetError("");
    } catch (error) {
      if (open) failed("island_apply", error);
    }
    return;
  }
  try {
    if (IS_MAC) await invoke("island_apply", { open: false });
    await invoke("widget_apply", { spec: floatSpec });
    if (open) setWidgetError("");
  } catch (error) {
    if (open) failed("widget_apply", error);
  }
}

let started = false;

/** 把窗口相关的设置同步给后端，之后每次改设置都再同步。只有主窗口调。 */
export function initWindows(): void {
  if (started) return;
  started = true;

  let lastWidget = "";
  let lastPlaced = false;
  let lastOnTop: boolean | null = null;
  let lastDockHidden = false;
  const sync = () => {
    const s = getSettings();
    const key = JSON.stringify([
      s.widget.open && !island,
      s.widget.size,
      s.widget.layer,
      s.widget.locked,
      onNotch(s.widget),
    ]);
    // 位置只在创建窗口时用，拖动后存下来的新位置不用再发给后端；
    // 只有"位置被清空"（放回屏幕右下角）才要发
    const placed = s.widget.x !== null && s.widget.y !== null;
    const cleared = lastPlaced && !placed;
    lastPlaced = placed;
    if (key !== lastWidget || cleared) {
      // 第一次同步时小组件没开，就不用告诉后端了
      const skip = lastWidget === "" && !s.widget.open;
      lastWidget = key;
      if (!skip) pushWidget();
    }
    if (s.alwaysOnTop !== lastOnTop) {
      const skip = lastOnTop === null && !s.alwaysOnTop;
      lastOnTop = s.alwaysOnTop;
      if (!skip) call("set_main_on_top", { on: s.alwaysOnTop });
    }
    // Mac：只在菜单栏显示。默认就是显示在 Dock 上，所以没开过就不用发
    if (IS_MAC && s.dockHidden !== lastDockHidden) {
      lastDockHidden = s.dockHidden;
      call("set_dock_hidden", { hidden: s.dockHidden });
    }
  };
  sync();
  subscribeSettings(sync);

  // ingfy 的灵动岛开了、关了
  islandListeners.add(sync);
  onEvent<boolean>("ingfy-island", setIsland);
  invoke<boolean>("ingfy_island")
    .then(setIsland)
    .catch(() => {});

  // 托盘菜单里点了小组件那两项
  onEvent<string>("tray-command", (command) => {
    if (command === "widget-toggle") toggleWidget();
    else if (command === "widget-lock") toggleWidgetLock();
    else if (command === "sleep-toggle") toggleSleep();
  });
}

/** 进入 / 退出全屏，返回现在是不是全屏 */
export async function toggleFullscreen(): Promise<boolean> {
  try {
    return await invoke<boolean>("toggle_fullscreen");
  } catch (error) {
    console.error("[ingwork] toggle_fullscreen", error);
    return false;
  }
}
