// 数据文件夹：任务和专注记录放在哪。默认在本机，可以换到 OneDrive 这类同步文件夹，几台电脑共用。
// 换文件夹、合并都在后端（src-tauri/src/location.rs）做，这里只管界面要的状态。

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { onEvent } from "./tauri";

export interface DataDirView {
  path: string;
  isDefault: boolean;
  defaultPath: string;
  /** 选了但启动时打不开的文件夹（这时用的是本机的） */
  unavailable: string | null;
}

export interface Inspection {
  path: string;
  /** 就是现在用的这个 */
  same: boolean;
  /** 那边已有的任务数。读不出来（网盘还没下载完）是 null */
  tasks: number | null;
  records: number;
  /** 不能用的原因（中文） */
  problem: string | null;
}

let view: DataDirView | null = null;
const listeners = new Set<() => void>();
let started = false;

function receive(next: DataDirView): void {
  view = next;
  listeners.forEach((listener) => listener());
}

function start(): void {
  if (started) return;
  started = true;
  onEvent<DataDirView>("data-dir-changed", receive);
  invoke<DataDirView>("data_dir_get")
    .then(receive)
    .catch((e) => console.error("[ingwork] data_dir_get", e));
}

export function useDataDir(): DataDirView | null {
  start();
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

/** 弹出选文件夹的窗口。取消了返回 null */
export async function pickFolder(): Promise<string | null> {
  try {
    return await invoke<string | null>("data_dir_pick");
  } catch (e) {
    console.error("[ingwork] data_dir_pick", e);
    return null;
  }
}

export function inspectFolder(path: string): Promise<Inspection> {
  return invoke<Inspection>("data_dir_inspect", { path });
}

/**
 * 换数据文件夹。path 为 null 是换回本机的。
 * keep：把现在的任务和记录带过去合并；否则直接用那边的。失败时抛出后端给的原因（中文）。
 */
export async function moveTo(path: string | null, keep: boolean): Promise<void> {
  receive(await invoke<DataDirView>("data_dir_set", { path, keep }));
}

export function openFolder(): void {
  invoke("data_dir_open").catch((e) => console.error("[ingwork] data_dir_open", e));
}
