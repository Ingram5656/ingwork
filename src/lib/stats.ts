// 统计：专注记录由后端（Rust）一条条记下来，这里接过来，按本地日期算每天、每周和连续打卡。
// 规则：走完整段的专注算一个番茄；中途停下的（够一分钟）只算时长。当天至少一个番茄算打卡。

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { t } from "./i18n";
import { onEvent } from "./tauri";

/** 一段专注 */
export interface FocusRecord {
  /** 结束的时刻（毫秒时间戳） */
  t: number;
  /** 实际专注了多久（毫秒） */
  ms: number;
  /** 真：走完了整段，算一个番茄；假：中途停下 */
  done: boolean;
  /** 当时的当前任务名 */
  task?: string | null;
}

export interface StatsView {
  records: FocusRecord[];
  /** 最近有记录没存进文件 */
  saveFailed: boolean;
}

/** 某一天的汇总 */
export interface DaySummary {
  ms: number;
  pomodoros: number;
  /** 这一天的记录，新的在前 */
  records: FocusRecord[];
}

let view: StatsView = { records: [], saveFailed: false };
const listeners = new Set<() => void>();

function receive(next: StatsView): void {
  view = { records: next.records ?? [], saveFailed: !!next.saveFailed };
  listeners.forEach((listener) => listener());
}

export function useStats(): StatsView {
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

let started = false;

/** 接上后端的记录。每个窗口启动时调一次。 */
export function initStats(): void {
  if (started) return;
  started = true;
  onEvent<StatsView>("stats-changed", receive);
  invoke<StatsView>("stats_get")
    .then(receive)
    .catch((e) => console.error("[ingwork] stats_get", e));
}

/** 清空全部记录。失败时返回后端给的原因（中文），成功返回空字符串。 */
export async function clearStats(): Promise<string> {
  try {
    receive(await invoke<StatsView>("stats_clear"));
    return "";
  } catch (e) {
    return String(e);
  }
}

// ---------- 日期 ----------

/** 本地日期写成 "2026-11-19"，当作一天的名字 */
export function dayKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

/** 往后（负数往前）数 n 天，时间归到当天零点 */
export function addDays(date: Date, n: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

/** 这一周的周一 */
export function weekStart(date: Date): Date {
  const sinceMonday = (date.getDay() + 6) % 7;
  return addDays(date, -sinceMonday);
}

// ---------- 汇总 ----------

/** 把记录按本地日期分到每一天 */
export function byDay(records: FocusRecord[]): Map<string, DaySummary> {
  const days = new Map<string, DaySummary>();
  for (const record of records) {
    const key = dayKey(new Date(record.t));
    let day = days.get(key);
    if (!day) {
      day = { ms: 0, pomodoros: 0, records: [] };
      days.set(key, day);
    }
    day.ms += record.ms;
    if (record.done) day.pomodoros += 1;
    day.records.push(record);
  }
  days.forEach((day) => day.records.sort((a, b) => b.t - a.t));
  return days;
}

/** 连续打卡几天。今天还没打卡时，从昨天往回数（今天还来得及）。 */
export function streak(days: Map<string, DaySummary>, today: Date): number {
  const hit = (date: Date) => (days.get(dayKey(date))?.pomodoros ?? 0) > 0;
  let cursor = hit(today) ? today : addDays(today, -1);
  let count = 0;
  while (hit(cursor)) {
    count += 1;
    cursor = addDays(cursor, -1);
  }
  return count;
}

/** 今天完成了几个番茄 */
export function pomodorosToday(records: FocusRecord[]): number {
  const key = dayKey(new Date());
  let count = 0;
  for (const record of records) {
    if (record.done && dayKey(new Date(record.t)) === key) count += 1;
  }
  return count;
}

/** "25 分钟"、"1 小时 15 分"、"2 小时" */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return t("{m} 分钟", { m: minutes });
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? t("{h} 小时", { h }) : t("{h} 小时 {m} 分", { h, m });
}
