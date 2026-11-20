// 翻译和杂念箱两个小窗：呼出、把设置告诉后端、接过 ingtranslate 的设置。

import { invoke } from "@tauri-apps/api/core";
import { IS_MAC } from "./platform";
import { getSettings, subscribeSettings, updateSettings, type Settings } from "./settings";
import { call } from "./tauri";

export type PopupLabel = "translate" | "capture";

/** 面板的宽度（未缩放），和样式表里 .tr-panel、.cap-panel 一致 */
const PANEL_W: Record<PopupLabel, number> = { translate: 680, capture: 560 };
/** 面板左右的留白（各 24，给投影），和样式表里小窗 body 的 padding 一致 */
const GUTTER_W = 48;

/**
 * 量出小窗现在要多大，交给后端改窗口大小，返回面板最多能有多高（未缩放）。
 * 直接换算成物理像素再交出去，用的是页面自己实际的 devicePixelRatio：
 * 窗口换到缩放不一样的屏幕后，WebView 有时还按原来的缩放在画，按屏幕算会比页面小一圈。
 * 页面上加了 CSS zoom 时，不同版本的 WebView2 量出来的是缩放前还是缩放后的尺寸不一定，
 * 拿整页宽度和窗口宽度对一下就知道该乘多少。
 */
export async function fitPopup(label: PopupLabel, zoom: number): Promise<number> {
  const dpr = window.devicePixelRatio || 1;
  const pageW = document.documentElement.getBoundingClientRect().width;
  const k = pageW > 0 ? window.innerWidth / pageW : 1;
  const height = Math.ceil(document.body.getBoundingClientRect().height * k * dpr);
  const width = Math.round((PANEL_W[label] + GUTTER_W) * zoom * dpr);
  try {
    return await invoke<number>("popup_fit", { label, width, height, dpr, zoom });
  } catch {
    return 0;
  }
}

/**
 * 页面的 devicePixelRatio 变了（窗口换到了缩放不一样的屏幕）就调 `run`。返回取消监听的函数
 */
export function onPixelRatioChange(run: () => void): () => void {
  let query: MediaQueryList | null = null;
  const listen = () => {
    query?.removeEventListener("change", changed);
    query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    query.addEventListener("change", changed);
  };
  const changed = () => {
    listen();
    run();
  };
  listen();
  return () => query?.removeEventListener("change", changed);
}

/** 呼出或收起一个小窗 */
export function togglePopup(label: PopupLabel): void {
  call("popup_toggle", { label });
}

export function showPopup(label: PopupLabel): void {
  call("popup_show", { label });
}

/** ingtranslate 的快捷键写法（"Alt+KeyQ"）换成这里的写法（"Alt+Q"）。换不了的返回空 */
function convertShortcut(acc: unknown): string {
  if (typeof acc !== "string" || !acc) return "";
  const parts = acc.split("+").map((part) => {
    if (part === "Ctrl" || part === "CommandOrControl" || part === "CmdOrCtrl") return "Control";
    if (/^Key[A-Z]$/.test(part)) return part.slice(3);
    if (/^Digit\d$/.test(part)) return part.slice(5);
    return part;
  });
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const known = mods.every((m) => m === "Control" || m === "Alt" || m === "Shift");
  const keyOk = /^([A-Z0-9]|F([1-9]|1[0-2])|Space)$/.test(key);
  if (!known || !keyOk || !mods.some((m) => m === "Control" || m === "Alt")) return "";
  return parts.join("+");
}

/** 第一次启动时，把 ingtranslate 的引擎、大模型接口、目标语言和快捷键接过来。只接一次 */
async function importIngtranslate(): Promise<void> {
  if (getSettings().trImported) return;
  let legacy: Record<string, unknown> | null = null;
  try {
    legacy = await invoke<Record<string, unknown> | null>("legacy_translate");
  } catch {
    legacy = null;
  }
  updateSettings((latest) => {
    const patch: Partial<Settings> = { trImported: true };
    if (!legacy) return patch;
    if (legacy.engine === "llm" || legacy.engine === "google") patch.trEngine = legacy.engine;
    const llm = legacy.llm as Partial<Settings["trLlm"]> | undefined;
    if (llm && typeof llm === "object") {
      patch.trLlm = {
        baseUrl: typeof llm.baseUrl === "string" && llm.baseUrl ? llm.baseUrl : latest.trLlm.baseUrl,
        apiKey: typeof llm.apiKey === "string" ? llm.apiKey : latest.trLlm.apiKey,
        model: typeof llm.model === "string" && llm.model ? llm.model : latest.trLlm.model,
      };
    }
    if (typeof legacy.target === "string") patch.trTarget = legacy.target;
    if (typeof legacy.readClipboard === "boolean") patch.trClipboard = legacy.readClipboard;
    if (typeof legacy.scale === "number") patch.popupScale = legacy.scale;
    // ingtranslate 只有 Windows 版，它的 Alt 组合在 Mac 上会占掉打特殊字符的键，Mac 上不接
    const shortcut = IS_MAC ? "" : convertShortcut(legacy.shortcut);
    if (shortcut) patch.shortcuts = { ...latest.shortcuts, translate: shortcut };
    return patch;
  });
}

let started = false;

/** 把小窗和翻译的设置发给后端，之后每次改设置都再发一次。只有主窗口调。 */
export function initPopups(): void {
  if (started) return;
  started = true;
  let lastPopup = "";
  let lastTranslate = "";
  const push = () => {
    const s = getSettings();
    const popup = JSON.stringify([s.trClipboard]);
    if (popup !== lastPopup) {
      lastPopup = popup;
      call("popup_configure", { readClipboard: s.trClipboard });
    }
    const translate = JSON.stringify([s.trEngine, s.trLlm]);
    if (translate !== lastTranslate) {
      lastTranslate = translate;
      call("translate_configure", { config: { engine: s.trEngine, llm: s.trLlm } });
    }
  };
  push();
  subscribeSettings(push);
  void importIngtranslate();
}
