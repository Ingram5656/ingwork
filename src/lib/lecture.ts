// 听课：麦克风录下老师讲的话，DeepSeek 一段一段听写成英文、翻成中文；
// 听课中每 5 分钟左右把提纲更新一次，下课点"结束"后从头到尾完整整理成笔记。
//
// 录音、切段、送去识别、翻译、整理都在后台（Rust）做，窗口最小化、切到别的软件都不断。
// 后台每变一次就把整个状态（LectureState）发过来；麦克风的音量单独发（一秒十几次），只给音量条用。

import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";
import { getPlanner, type Course } from "./planner";
import { classesOn } from "./schedule";
import { getSettings, subscribeSettings } from "./settings";
import { readSlides } from "./slides";
import { call, onEvent } from "./tauri";

/** 一段话：英文原文和中文翻译 */
export interface Segment {
  id: number;
  /** 这一段开始的时刻（毫秒时间戳） */
  at: number;
  en: string;
  /** 还在翻译是 null */
  zh: string | null;
  /** 这里有人说话但没听清：en 是空的，没翻译、没进笔记（存了录音的话能点开听原声） */
  unclear?: boolean;
}

export interface NotePoint {
  text: string;
  refs: number[];
}

/** 老师怎么说截止时间的：具体日期、周几、下节课、几天后 */
export interface DueWhen {
  kind: "date" | "weekday" | "next_class" | "in_days" | "unknown";
  weekday?: number;
  nextWeek?: boolean;
  days?: number;
}

export interface LectureDue {
  title: string;
  /** "2026-12-04"。"下节课"要按课表算，这里是 null */
  date: string | null;
  quote: string;
  when?: DueWhen;
  /** 出自左边哪一句 */
  atRef?: number;
}

/** 整理出来的笔记 */
export interface LectureNotes {
  /** 这节课讲了什么：两三句话 */
  summary: string;
  /** 按主题分段的提纲。每条要点记着出自左边哪几句（句子编号） */
  outline: { title: string; points: NotePoint[] }[];
  /** 关键术语，中英对照 */
  terms: { en: string; zh: string; note?: string }[];
  /** 老师提到的作业、考试、截止日期 */
  dues: LectureDue[];
  /** 值得回去复习的地方 */
  review: string[];
}

export type LectureStatus = "idle" | "listening" | "paused" | "finishing" | "done" | "importing";

export interface LectureUsage {
  /** 送去 DeepSeek 听写的时长 */
  asrMs: number;
  /** 送去 Groq 听写的时长（按它的算法：一次不到 10 秒算 10 秒） */
  groqMs?: number;
  hit: number;
  miss: number;
  out: number;
}

/**
 * 大概花了多少美元。按标价的上限算（DeepSeek 听写不算限时折扣、模型按高峰价；
 * Groq 按付费价，在它的免费额度里其实不花钱），实际只会更少。价格变了改这里。
 */
export function costOf(u: LectureUsage | undefined): number {
  if (!u) return 0;
  const asr = (u.asrMs / 3_600_000) * 0.116 + ((u.groqMs ?? 0) / 3_600_000) * 0.111;
  const llm = (u.hit * 0.006 + u.miss * 0.3 + u.out * 1.2) / 1_000_000;
  return asr + llm;
}

/** "$0.03"；太少就写"不到 $0.01" */
/** 1 美元大约多少人民币：只用来把估出来的花费换个单位显示，汇率变多了改这里 */
const CNY_PER_USD = 7.2;

/** 把美元数写成设置里选的那种钱 */
export function moneyText(usd: number): string {
  if (usd <= 0) return "";
  if (getSettings().lectureCurrency === "cny") {
    const yuan = usd * CNY_PER_USD;
    if (yuan < 0.01) return t("不到 ¥0.01");
    return `¥${yuan.toFixed(2)}`;
  }
  if (usd < 0.01) return t("不到 $0.01");
  return `$${usd.toFixed(2)}`;
}

export function costText(u: LectureUsage | undefined): string {
  return moneyText(costOf(u));
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
  /** 还没说完、等着凑成整句的半句话 */
  pending: { at: number; en: string } | null;
  /** 说话的声音太小 */
  quiet: boolean;
  /** 这台电脑上有这节课的录音（能回放、能用录音重新整理） */
  audioHere: boolean;
  /** 正在用录音重新整理：进度 0～100 */
  redo: number | null;
  /** 正在导入录音或视频：进度 0～100 */
  progress: number | null;
  /** 从录音或视频导入的：文件名。时刻显示成"第几分几秒" */
  imported: string | null;
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
  usage?: LectureUsage;
  /** 这台电脑上这节课的录音有多大（字节），没有是 0 */
  audioBytes?: number;
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
  pending: null,
  quiet: false,
  audioHere: false,
  redo: null,
  progress: null,
  imported: null,
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
  // 设置里换了密钥、听写方式：正在听的这节课也用新的
  let key = getSettings().lectureKey;
  let asr = JSON.stringify(asrConfig());
  call("lecture_set_asr", { asr: asrConfig() });
  subscribeSettings(() => {
    const next = getSettings().lectureKey;
    if (next !== key) {
      key = next;
      call("lecture_set_key", { key: next });
    }
    const nextAsr = JSON.stringify(asrConfig());
    if (nextAsr !== asr) {
      asr = nextAsr;
      call("lecture_set_asr", { asr: asrConfig() });
    }
  });
}

/** 设置里选的听写方式：用哪个、Groq 的密钥、老师讲课的语言 */
function asrConfig(): { engine: string; groqKey: string; language: string } {
  const s = getSettings();
  return { engine: s.lectureAsr, groqKey: s.lectureGroqKey.trim(), language: s.lectureLanguage };
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
      denoise: getSettings().lectureDenoise,
      // 生词本里的词也算进这门课的术语表（拼写以它为准）
      words: getPlanner().words.map((w) => w.word),
      saveAudio: getSettings().lectureSaveAudio,
      source: getSettings().lectureSource,
      device: getSettings().lectureMic || null,
      asr: asrConfig(),
    }).then(
      () => null,
      (e) => String(e),
    ),
  /** 删掉一节课的笔记（连同这台电脑上的录音）。不行的话返回中文说明 */
  remove: (id: string) =>
    invoke("lecture_remove", { id }).then(
      () => {
        bumpHistory();
        return null;
      },
      (e) => String(e),
    ),
  /** 只删录音，笔记留着 */
  removeAudio: (id: string) =>
    invoke("lecture_delete_audio", { id }).then(
      () => {
        bumpHistory();
        return null;
      },
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
  /** 导入录音或视频：弹出选文件的窗口。返回 null 是开始了或者取消了，否则是中文说明 */
  importFile: (course: string, courseId: string | null = null) =>
    invoke<boolean>("lecture_import", {
      course,
      courseId,
      key: getSettings().lectureKey,
      utcOffsetMin: -new Date().getTimezoneOffset(),
      words: getPlanner().words.map((w) => w.word),
      saveAudio: getSettings().lectureSaveAudio,
      asr: asrConfig(),
    }).then(
      () => null,
      (e) => String(e),
    ),
  /** 下课后用录音重新整理一遍。不行的话返回中文说明 */
  redo: () =>
    invoke("lecture_redo", { key: getSettings().lectureKey, asr: asrConfig() }).then(
      () => null,
      (e) => String(e),
    ),
  /** 打开以前的一份笔记 */
  open: (id: string) => call("lecture_open", { id }),
  /** 导出成 Markdown 文件（笔记加上整节课的中英对照），返回 false 是取消了 */
  exportMarkdown: (s: LectureState) =>
    invoke<boolean>("lecture_export", { name: s.course, content: notesMarkdown(s, true) }),
};

// 删了笔记或录音以后，列表要重新读一遍
let historyTick = 0;
const historyListeners = new Set<() => void>();
function bumpHistory(): void {
  historyTick += 1;
  historyListeners.forEach((listener) => listener());
}

/** 以前的笔记，新的在前 */
export function useLectureHistory(): LectureEntry[] {
  const [list, setList] = useState<LectureEntry[]>([]);
  const { status, notesAt } = useLecture();
  const tick = useSyncExternalStore(
    (listener) => {
      historyListeners.add(listener);
      return () => {
        historyListeners.delete(listener);
      };
    },
    () => historyTick,
  );
  useEffect(() => {
    invoke<LectureEntry[]>("lecture_list")
      .then((got) => setList(got ?? []))
      .catch(() => setList([]));
  }, [status, notesAt, tick]);
  return list;
}

/** 这个月听了几节课、一共大概花了多少（美元） */
export function monthTotal(list: LectureEntry[], now: Date): { count: number; usd: number } {
  let count = 0;
  let usd = 0;
  for (const entry of list) {
    const d = new Date(entry.startedAt);
    if (d.getFullYear() !== now.getFullYear() || d.getMonth() !== now.getMonth()) continue;
    count += 1;
    usd += costOf(entry.usage);
  }
  return { count, usd };
}

/** 文件大小写成人看的：312 KB、28 MB、1.2 GB */
export function sizeText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
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
      for (const p of part.points) lines.push(`- ${p.text}`);
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
    for (const due of n.dues) {
      const when = due.date ?? (due.when?.kind === "next_class" ? t("下节课前") : "");
      lines.push(`- ${due.title}${when ? `（${when}）` : ""}`);
    }
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
      if (seg.unclear) continue;
      const d = new Date(seg.at);
      const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      lines.push(`**${time}** ${seg.en}`, "", seg.zh || "", "");
    }
  }
  return lines.join("\n");
}

// ---------- 课件（可选，随时传） ----------

export interface SlideInfo {
  name: string;
  addedAt: number;
  terms: number;
}

export interface Material {
  slides: SlideInfo[];
  terms: number;
}

const NO_MATERIAL: Material = { slides: [], terms: 0 };

/** 这门课传过的课件。course 是空的就不查 */
export function useMaterial(course: string, courseId: string | null): [Material, (m: Material) => void] {
  const [material, setMaterial] = useState<Material>(NO_MATERIAL);
  useEffect(() => {
    if (!course.trim()) {
      setMaterial(NO_MATERIAL);
      return;
    }
    let alive = true;
    invoke<Material>("lecture_material", { course, courseId })
      .then((m) => alive && setMaterial(m))
      .catch(() => alive && setMaterial(NO_MATERIAL));
    return () => {
      alive = false;
    };
  }, [course, courseId]);
  return [material, setMaterial];
}

export const slides = {
  /** 读课件、整理出术语和提纲。失败抛出中文说明 */
  add: async (course: string, courseId: string | null, file: File): Promise<Material> => {
    const text = await readSlides(file);
    try {
      return await invoke<Material>("lecture_add_slides", {
        course,
        courseId,
        name: file.name,
        text,
        key: getSettings().lectureKey,
      });
    } catch (e) {
      throw new Error(String(e));
    }
  },
  remove: (course: string, courseId: string | null, name: string) =>
    invoke<Material>("lecture_remove_slides", { course, courseId, name }),
};

// ---------- 笔记和左边原文之间跳转 ----------

const JUMP = "lecture-jump";

/** 让左边滚到这一句并闪一下 */
export function jumpToSegment(id: number): void {
  window.dispatchEvent(new CustomEvent<number>(JUMP, { detail: id }));
}

export function onJump(fn: (id: number) => void): () => void {
  const handler = (e: Event) => fn((e as CustomEvent<number>).detail);
  window.addEventListener(JUMP, handler);
  return () => window.removeEventListener(JUMP, handler);
}

// ---------- "下节课前"按课表算 ----------

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 截止日期：笔记里算好了就用；"下节课"按课表找这门课的下一次课（四周以内） */
export function dueDate(due: LectureDue, s: LectureState, courses: Course[]): string | null {
  if (due.date) return due.date;
  if (due.when?.kind !== "next_class" || !s.startedAt) return null;
  const start = new Date(s.startedAt);
  for (let i = 1; i <= 28; i++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const hit = classesOn(courses, day).some((c) =>
      s.courseId ? c.course.id === s.courseId : c.course.title.trim().toLowerCase() === s.course.trim().toLowerCase(),
    );
    if (hit) return ymd(day);
  }
  return null;
}

// ---------- 回放原声 ----------

let player: HTMLAudioElement | null = null;
let playerUrl = "";
let playing: number | null = null;
const playListeners = new Set<() => void>();

function setPlaying(id: number | null) {
  playing = id;
  playListeners.forEach((fn) => fn());
}

export function usePlaying(): number | null {
  return useSyncExternalStore(
    (fn) => {
      playListeners.add(fn);
      return () => playListeners.delete(fn);
    },
    () => playing,
  );
}

export function stopClip(): void {
  player?.pause();
  player = null;
  if (playerUrl) URL.revokeObjectURL(playerUrl);
  playerUrl = "";
  setPlaying(null);
}

/** 放第 index 句的原声（到下一句开始，最多 30 秒）。再点一次停 */
export async function playSegment(s: LectureState, index: number): Promise<void> {
  const seg = s.segments[index];
  if (!seg || !s.id) return;
  if (playing === seg.id) {
    stopClip();
    return;
  }
  stopClip();
  const next = s.segments[index + 1];
  const buf = await invoke<ArrayBuffer>("lecture_clip", {
    id: s.id,
    from: seg.at,
    to: next ? next.at : seg.at + 15_000,
  });
  playerUrl = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  player = new Audio(playerUrl);
  player.onended = stopClip;
  setPlaying(seg.id);
  await player.play();
}

/** 从开始过了多久："12:05"、"1:02:03" */
export function elapsed(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor(secs / 60) % 60;
  const sec = secs % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}
