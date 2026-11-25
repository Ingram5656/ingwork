// 计划：课表、截止日期、杂念箱、生词本。
// 数据在后端（src-tauri/src/planner.rs）手里，存在数据文件夹的 planner.json 里；这里只是接过来给界面用。

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { onEvent } from "./tauri";

/** 一节课：每隔几周的星期几、几点到几点，从哪天上到哪天 */
export interface Course {
  id: string;
  title: string;
  place: string;
  /** 1 是周一，7 是周日 */
  weekday: number;
  /** 从零点算起的分钟数 */
  start: number;
  end: number;
  /** "2026-09-07" */
  from: string;
  until: string;
  /** 每隔几周上一次，1 是每周 */
  every: number;
  /** 这几天不上 */
  skip: string[];
}

/** 发给后端的一节课（还没有 id） */
export type CourseInput = Omit<Course, "id">;

export interface Deadline {
  id: string;
  title: string;
  /** "2026-11-26" */
  due: string;
  done: boolean;
  /** 提前几天再提醒一次，0 或没有是不另外提前 */
  remindDays?: number;
}

export interface Note {
  id: string;
  text: string;
  /** 什么时候记的（毫秒时间戳） */
  at: number;
}

export interface Word {
  id: string;
  word: string;
  meaning: string;
  addedAt: number;
  /** 连续几次复习都记得 */
  known: number;
  /** 上次复习的时刻，没复习过是 0 */
  reviewedAt: number;
}

/** 排进空档的一段：哪天几点到几点做哪个待办 */
export interface Block {
  id: string;
  /** "2026-11-21" */
  day: string;
  /** 从零点算起的分钟 */
  start: number;
  end: number;
  taskId: string;
  /** 排的时候待办的名字。待办删了也照样显示 */
  title: string;
}

export type BlockInput = Omit<Block, "id">;

export interface PlannerStore {
  courses: Course[];
  deadlines: Deadline[];
  notes: Note[];
  words: Word[];
  blocks: Block[];
}

let store: PlannerStore = { courses: [], deadlines: [], notes: [], words: [], blocks: [] };
let error = "";
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

export function subscribePlanner(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function receive(next: PlannerStore): void {
  store = {
    courses: next.courses ?? [],
    deadlines: next.deadlines ?? [],
    notes: next.notes ?? [],
    words: next.words ?? [],
    blocks: next.blocks ?? [],
  };
  notify();
}

function setError(message: string): void {
  if (message === error) return;
  error = message;
  notify();
}

export function usePlanner(): PlannerStore {
  return useSyncExternalStore(subscribePlanner, () => store);
}

export function getPlanner(): PlannerStore {
  return store;
}

/** 上一次操作没成功的原因（后端给的中文），空字符串是没出错 */
export function usePlannerError(): string {
  return useSyncExternalStore(subscribePlanner, () => error);
}

export function clearPlannerError(): void {
  setError("");
}

let started = false;

/** 接上后端的数据。每个窗口启动时调一次。 */
export function initPlanner(): void {
  if (started) return;
  started = true;
  onEvent<PlannerStore>("planner-changed", receive);
  invoke<PlannerStore>("planner_get")
    .then(receive)
    .catch((e) => console.error("[ingwork] planner_get", e));
}

/** 调一个改数据的命令。成功返回真；失败把原因记下来给界面显示。 */
async function run(command: string, args?: Record<string, unknown>): Promise<boolean> {
  try {
    receive(await invoke<PlannerStore>(command, args));
    setError("");
    return true;
  } catch (e) {
    setError(String(e));
    return false;
  }
}

export const planner = {
  addCourse: (course: CourseInput) => run("course_add", { course }),
  editCourse: (id: string, course: CourseInput) => run("course_edit", { id, course }),
  importCourses: (courses: CourseInput[], replace: boolean) =>
    run("courses_import", { courses, replace }),
  clearCourses: () => run("courses_clear"),
  /** remindDays：提前几天再提醒一次（前一天晚上和当天早上那两次照常） */
  addDeadline: (title: string, due: string, remindDays = 0) => run("deadline_add", { title, due, remindDays }),
  setDeadlineDone: (id: string, done: boolean) => run("deadline_set_done", { id, done }),
  addNote: (text: string) => run("note_add", { text }),
  noteToTask: (id: string) => run("note_to_task", { id }),
  addWord: (word: string, meaning: string) => run("word_add", { word, meaning }),
  reviewWord: (id: string, known: boolean) => run("word_review", { id, known }),
  /** 把待办排进空档，可以一次排好几段。和已经排了的时间重叠的不排 */
  addBlocks: (blocks: BlockInput[]) => run("blocks_add", { blocks }),
  /** 删掉一节课、一个截止日期、一条杂念、一个生词或排进空档的一段 */
  remove: (id: string) => run("planner_remove", { id }),
};
