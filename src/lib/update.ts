// 检查更新：后端读 GitHub 最新的 Release，这里记着结果给界面用。

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { onEvent } from "./tauri";

export interface UpdateInfo {
  version: string;
  /** 以前的方式：安装包的下载地址。自动更新时为空 */
  url: string;
  notes: string;
  /** 自动更新：下好、装好后自己重启 */
  seamless: boolean;
}

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "downloading"; info: UpdateInfo; percent?: number }
  /** 下载或安装没成：留着这一版的信息，可以直接再试 */
  | { kind: "failed"; info: UpdateInfo; message: string }
  | { kind: "error"; message: string };

let state: UpdateState = { kind: "idle" };
const listeners = new Set<() => void>();

function set(next: UpdateState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

export function useUpdate(): UpdateState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
  );
}

/** `quiet` 为真时是启动后悄悄查一次：查不到、连不上都不提示 */
export async function checkUpdate(quiet = false): Promise<void> {
  if (state.kind === "checking" || state.kind === "downloading") return;
  if (!quiet) set({ kind: "checking" });
  try {
    const info = await invoke<UpdateInfo | null>("check_update");
    if (info) set({ kind: "available", info });
    else if (!quiet) set({ kind: "latest" });
  } catch (error) {
    if (!quiet) set({ kind: "error", message: String(error) });
  }
}

let listening = false;

/** 下载并安装。成功的话软件会自己退出（自动更新时会自己重启），让安装程序接手。 */
export async function installUpdate(): Promise<void> {
  if (state.kind !== "available" && state.kind !== "failed") return;
  const info = state.info;
  set({ kind: "downloading", info });
  if (!listening) {
    listening = true;
    // 后端说下了百分之几
    onEvent<number>("update-progress", (percent) => {
      if (state.kind === "downloading") set({ ...state, percent });
    });
  }
  try {
    await invoke("install_update", { url: info.url });
  } catch (error) {
    set({ kind: "failed", info, message: String(error) });
  }
}
