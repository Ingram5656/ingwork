// 任务：待办清单和每个任务的番茄数。
// 数据在后端（Rust）手里，存在数据文件夹里（默认本机，可以换到网盘里同步）；这里只是接过来给界面用。
// 专注走完时由后端给当前任务加 1，所以主窗口关着也照记。

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { onEvent } from "./tauri";

export interface Task {
  id: string;
  name: string;
  /** 预计要几个番茄 */
  estimate: number;
  /** 已经完成了几个番茄 */
  spent: number;
  /** 勾掉了 */
  finished: boolean;
}

export interface TaskStore {
  /** 还没完成的在前，已完成的在后 */
  tasks: Task[];
  /** 当前任务的 id，没有就是 null */
  current: string | null;
}

/** 预计番茄数最多填到多少（和后端的上限一致） */
export const MAX_ESTIMATE = 20;

let store: TaskStore = { tasks: [], current: null };
let error = "";
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function receive(next: TaskStore): void {
  store = { tasks: next.tasks, current: next.current ?? null };
  notify();
}

function setError(message: string): void {
  if (message === error) return;
  error = message;
  notify();
}

export function useTasks(): TaskStore {
  return useSyncExternalStore(subscribe, () => store);
}

/** 上一次操作没成功的原因（后端给的中文），空字符串是没出错 */
export function useTaskError(): string {
  return useSyncExternalStore(subscribe, () => error);
}

export function clearTaskError(): void {
  setError("");
}

/** 当前任务，没有就是 null */
export function currentTask(s: TaskStore): Task | null {
  return s.tasks.find((task) => task.id === s.current) ?? null;
}

let started = false;

/** 接上后端的任务数据。每个窗口启动时调一次。 */
export function initTasks(): void {
  if (started) return;
  started = true;
  onEvent<TaskStore>("tasks-changed", receive);
  invoke<TaskStore>("tasks_get")
    .then(receive)
    .catch((e) => console.error("[ingwork] tasks_get", e));
}

/** 调一个改任务的命令。成功返回真；失败把原因记下来给面板显示。 */
async function run(command: string, args?: Record<string, unknown>): Promise<boolean> {
  try {
    receive(await invoke<TaskStore>(command, args));
    setError("");
    return true;
  } catch (e) {
    setError(String(e));
    return false;
  }
}

export const tasks = {
  add: (name: string, estimate: number) => run("task_add", { name, estimate }),
  edit: (id: string, name: string, estimate: number) => run("task_edit", { id, name, estimate }),
  setFinished: (id: string, finished: boolean) => run("task_set_finished", { id, finished }),
  setCurrent: (id: string | null) => run("task_set_current", { id }),
  remove: (id: string) => run("task_remove", { id }),
  clearFinished: () => run("tasks_clear_finished"),
  /** 拖动排序：先在本地排好，界面不用等后端，松手就到位 */
  reorder: (ids: string[]) => {
    const byId = new Map(store.tasks.map((task) => [task.id, task]));
    const moved = ids.map((id) => byId.get(id)).filter((task): task is Task => !!task);
    const rest = store.tasks.filter((task) => !ids.includes(task.id));
    receive({ tasks: [...moved, ...rest], current: store.current });
    return run("tasks_reorder", { ids });
  },
};
