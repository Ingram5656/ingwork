// 听课：麦克风录下老师讲的话，DeepSeek 一段一段听写成英文、翻成中文；
// 听课中每 5 分钟左右把提纲更新一次，下课点"结束"后从头到尾完整整理成笔记。
//
// 录音、切段、送去识别、翻译、整理都在后台（Rust）做，窗口最小化、切到别的软件都不断。
// 后台每变一次就把整个状态（LectureState）发过来；麦克风的音量单独发（一秒十几次），只给音量条用。

import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";
import { getSettings, subscribeSettings } from "./settings";
import { call, onEvent } from "./tauri";

/** 一段话：英文原文和中文翻译 */
export interface Segment {
  id: number;
  /** 这一段开始的时刻（毫秒时间戳） */
  at: number;
  en: string;
  /** 还在翻译是 null */
  zh: string | null;
}

/** 整理出来的笔记 */
export interface LectureNotes {
  /** 这节课讲了什么：两三句话 */
  summary: string;
  /** 按主题分段的提纲 */
  outline: { title: string; points: string[] }[];
  /** 关键术语，中英对照 */
  terms: { en: string; zh: string; note?: string }[];
  /** 老师提到的作业、考试、截止日期 */
  dues: { title: string; /** "2026-12-04"，老师没说具体哪天是 null */ date: string | null; quote: string }[];
  /** 值得回去复习的地方 */
  review: string[];
}

export type LectureStatus = "idle" | "listening" | "paused" | "finishing" | "done";

export interface LectureUsage {
  asrMs: number;
  hit: number;
  miss: number;
  out: number;
}

/**
 * 大概花了多少美元。按 DeepSeek 标价的上限算（听写不算限时折扣、模型按高峰价），
 * 实际只会更少。价格变了改这里。
 */
export function costOf(u: LectureUsage | undefined): number {
  if (!u) return 0;
  const asr = (u.asrMs / 3_600_000) * 0.116;
  const llm = (u.hit * 0.006 + u.miss * 0.3 + u.out * 1.2) / 1_000_000;
  return asr + llm;
}

/** "$0.03"；太少就写"不到 $0.01" */
export function costText(u: LectureUsage | undefined): string {
  const c = costOf(u);
  if (c <= 0) return "";
  if (c < 0.01) return t("不到 $0.01");
  return `$${c.toFixed(2)}`;
}

export interface LectureState {
  status: LectureStatus;
  /** 这节笔记的编号（存档用），没开始是 null */
  id: string | null;
  course: string;
  /** 课表里那节课的编号，从课表开始的才有 */
  courseId: string | null;
  startedAt: number | null;
  /** 真正在听的时长（暂停的不算），不含正在听的这一截 */
  listenedMs: number;
  /** 这一截从什么时候开始在听，没在听是 null。听了多久 = listenedMs + (现在 - listeningSince) */
  listeningSince: number | null;
  segments: Segment[];
  /** 录好了还没送出去的段数（断网时会攒着，网好了补上） */
  backlog: number;
  notes: LectureNotes | null;
  /** 笔记上次整理的时刻 */
  notesAt: number | null;
  /** 用了多少：听写时长（毫秒）、命中缓存 / 没命中的输入字数、输出字数 */
  usage: LectureUsage;
  /** 下一次整理大约在什么时候（听课中才有） */
  nextNotesAt: number | null;
  /** 正在整理笔记 */
  summarizing: boolean;
  /** 出错时的说明（后台给的中文），没出错是 null */
  error: string | null;
}

/** 以前的笔记，列表里的一行 */
export interface LectureEntry {
  id: string;
  course: string;
  startedAt: number;
  listenedMs: number;
  /** 一句话的总结，列表里显示 */
  summary: string;
}

const EMPTY: LectureState = {
  status: "idle",
  id: null,
  course: "",
  courseId: null,
  startedAt: null,
  listenedMs: 0,
  listeningSince: null,
  segments: [],
  backlog: 0,
  notes: null,
  notesAt: null,
  usage: { asrMs: 0, hit: 0, miss: 0, out: 0 },
  nextNotesAt: null,
  summarizing: false,
  error: null,
};

let state: LectureState = EMPTY;
const listeners = new Set<() => void>();

function receive(next: LectureState): void {
  state = { ...EMPTY, ...next };
  listeners.forEach((listener) => listener());
}

export function useLecture(): LectureState {
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

// ---------- 音量 ----------

/** 最近几秒的音量（0–1），一格大约 0.1 秒，给音量条画"刚才说了什么、在哪停顿"用 */
export const LEVEL_SLOTS = 72;
let levels: number[] = new Array(LEVEL_SLOTS).fill(0);
const levelListeners = new Set<() => void>();

function pushLevel(value: number): void {
  levels = [...levels.slice(1), Math.max(0, Math.min(1, value))];
  levelListeners.forEach((listener) => listener());
}

export function useLevels(): number[] {
  return useSyncExternalStore(
    (listener) => {
      levelListeners.add(listener);
      return () => {
        levelListeners.delete(listener);
      };
    },
    () => levels,
  );
}

let started = false;

/** 主窗口调一次：接上后台的状态 */
export function initLecture(): void {
  if (started) return;
  started = true;
  onEvent<LectureState>("lecture-state", receive);
  onEvent<number>("lecture-level", pushLevel);
  invoke<LectureState>("lecture_get")
    .then(receive)
    .catch(() => undefined);
  // 设置里换了密钥：正在听的这节课也用新的
  let key = getSettings().lectureKey;
  subscribeSettings(() => {
    const next = getSettings().lectureKey;
    if (next !== key) {
      key = next;
      call("lecture_set_key", { key: next });
    }
  });
}

/** 听了多久（毫秒），正在听的这一截也算上 */
export function listenedNow(s: LectureState, now: number): number {
  return s.listenedMs + (s.listeningSince ? Math.max(0, now - s.listeningSince) : 0);
}

// ---------- 操作 ----------

export const lecture = {
  /** 开始听：course 是课名，从课表开始的带上那节课的编号。打不开麦克风之类的返回中文说明 */
  start: (course: string, courseId: string | null = null) =>
    invoke("lecture_start", {
      course,
      courseId,
      key: getSettings().lectureKey,
      // 按这台电脑的时区给模型看日期和时刻
      utcOffsetMin: -new Date().getTimezoneOffset(),
    }).then(
      () => null,
      (e) => String(e),
    ),
  pause: () => call("lecture_pause"),
  resume: () => call("lecture_resume"),
  /** 结束：停止录音，把整节课完整整理成笔记 */
  stop: () => call("lecture_stop"),
  /** 看完了，回到"要听哪节课" */
  close: () => call("lecture_close"),
  /** 重新整理一遍（整理失败、或者想再来一次） */
  summarize: () => call("lecture_summarize", { key: getSettings().lectureKey }),
  /** 打开以前的一份笔记 */
  open: (id: string) => call("lecture_open", { id }),
  remove: (id: string) => call("lecture_remove", { id }),
  /** 导出成 Markdown 文件（笔记加上整节课的中英对照），返回 false 是取消了 */
  exportMarkdown: (s: LectureState) =>
    invoke<boolean>("lecture_export", { name: s.course, content: notesMarkdown(s, true) }),
};

/** 以前的笔记，新的在前 */
export function useLectureHistory(): LectureEntry[] {
  const [list, setList] = useState<LectureEntry[]>([]);
  const { status, notesAt } = useLecture();
  useEffect(() => {
    invoke<LectureEntry[]>("lecture_list")
      .then((got) => setList(got ?? []))
      .catch(() => setList([]));
  }, [status, notesAt]);
  return list;
}

/** 笔记 → Markdown（复制用）。withTranscript：后面附上整节课的中英对照（导出用） */
export function notesMarkdown(s: LectureState, withTranscript = false): string {
  const n = s.notes;
  if (!n) return "";
  const date = s.startedAt ? new Date(s.startedAt) : new Date();
  const lines: string[] = [`# ${s.course}`, "", `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`, ""];
  if (n.summary) lines.push(n.summary, "");
  if (n.outline.length) {
    for (const part of n.outline) {
      lines.push(`## ${part.title}`, "");
      for (const p of part.points) lines.push(`- ${p}`);
      lines.push("");
    }
  }
  if (n.terms.length) {
    lines.push("## 术语", "");
    for (const term of n.terms) lines.push(`- **${term.en}** ${term.zh}${term.note ? `：${term.note}` : ""}`);
    lines.push("");
  }
  if (n.dues.length) {
    lines.push("## 作业和截止日期", "");
    for (const due of n.dues) lines.push(`- ${due.title}${due.date ? `（${due.date}）` : ""}`);
    lines.push("");
  }
  if (n.review.length) {
    lines.push("## 回去复习", "");
    for (const r of n.review) lines.push(`- ${r}`);
    lines.push("");
  }
  if (withTranscript && s.segments.length) {
    lines.push("## 课堂原文和翻译", "");
    for (const seg of s.segments) {
      const d = new Date(seg.at);
      const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      lines.push(`**${time}** ${seg.en}`, "", seg.zh || "", "");
    }
  }
  return lines.join("\n");
}
