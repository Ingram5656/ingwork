// 课表的日期计算：某天有哪几节课、空档有多长、下节课是什么、放得下几个番茄。
// 时间一律用本地时间：课表上写的就是本地的几点几分。

import type { Course } from "./planner";
import { addDays, dayKey, weekStart, type FocusRecord } from "./stats";

/** 某一天的一节课 */
export interface Occurrence {
  course: Course;
  /** 从零点算起的分钟数 */
  start: number;
  end: number;
}

/** 一段空档 */
export interface Gap {
  start: number;
  end: number;
  /** 空档后面接着的那节课，没有就是到这天结束 */
  before: Course | null;
}

/** "2026-11-19" 变回那天零点 */
export function parseDay(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** 星期几：1 是周一，7 是周日 */
export function isoWeekday(date: Date): number {
  return ((date.getDay() + 6) % 7) + 1;
}

/** 现在是这一天的第几分钟 */
export function minuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/** 540 写成 "09:00" */
export function fmtMinute(minute: number): string {
  const m = Math.max(0, Math.min(24 * 60, Math.round(minute)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "09:00" 变成 540，写错了是 null */
export function parseMinute(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 24 || m > 59 || (h === 24 && m > 0)) return null;
  return h * 60 + m;
}

/** 这节课在这一天上不上 */
export function occursOn(course: Course, date: Date): boolean {
  const key = dayKey(date);
  if (key < course.from || key > course.until) return false;
  if (isoWeekday(date) !== course.weekday) return false;
  if (course.skip.includes(key)) return false;
  const every = Math.max(1, course.every || 1);
  if (every === 1) return true;
  const weeks = Math.round(
    (weekStart(date).getTime() - weekStart(parseDay(course.from)).getTime()) / (7 * 86_400_000),
  );
  return weeks % every === 0;
}

/** 这一天的课，按上课时间排好 */
export function classesOn(courses: Course[], date: Date): Occurrence[] {
  return courses
    .filter((course) => occursOn(course, date))
    .map((course) => ({ course, start: course.start, end: course.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/** 时间轴从几点画到几点：至少 8 点到 20 点，课更早或更晚就往外扩到整点 */
export function dayRange(classes: Occurrence[]): { start: number; end: number } {
  let start = 8 * 60;
  let end = 20 * 60;
  for (const c of classes) {
    start = Math.min(start, Math.floor(c.start / 60) * 60);
    end = Math.max(end, Math.ceil(c.end / 60) * 60);
  }
  return { start, end: Math.min(end, 24 * 60) };
}

/** 从 `from` 到 `until` 之间没课的空档，短于 `minLength` 分钟的不算 */
export function gapsBetween(
  classes: Occurrence[],
  from: number,
  until: number,
  minLength = 15,
): Gap[] {
  const gaps: Gap[] = [];
  let cursor = from;
  for (const c of classes) {
    if (c.end <= cursor) continue;
    if (c.start > cursor) {
      const end = Math.min(c.start, until);
      if (end - cursor >= minLength) gaps.push({ start: cursor, end, before: c.course });
    }
    cursor = Math.max(cursor, c.end);
    if (cursor >= until) break;
  }
  if (until - cursor >= minLength) gaps.push({ start: cursor, end: until, before: null });
  return gaps;
}

/** 一段空档放得下几个番茄。后面有课的话先留出路上的时间 */
export function pomodorosIn(gap: Gap, focusMin: number, shortMin: number, leadMin: number): number {
  const usable = gap.end - gap.start - (gap.before ? leadMin : 0);
  if (usable < focusMin) return 0;
  return Math.floor((usable + shortMin) / (focusMin + shortMin));
}

/** 现在正在上的课和今天接下来的第一节课 */
export function nowAndNext(
  courses: Course[],
  now: Date,
): { current: Occurrence | null; next: Occurrence | null } {
  const minute = minuteOfDay(now);
  const today = classesOn(courses, now);
  return {
    current: today.find((c) => c.start <= minute && minute < c.end) ?? null,
    next: today.find((c) => c.start > minute) ?? null,
  };
}

/** 往后找最近的一天有课的日子（最多看两周），返回那天和那天的课 */
export function nextSchoolDay(
  courses: Course[],
  after: Date,
): { date: Date; classes: Occurrence[] } | null {
  for (let i = 1; i <= 14; i++) {
    const date = addDays(after, i);
    const classes = classesOn(courses, date);
    if (classes.length > 0) return { date, classes };
  }
  return null;
}

/** 一段专注在时间轴上占哪一段（分钟），不在这一天就是 null */
export function recordSpan(record: FocusRecord, day: Date): { start: number; end: number } | null {
  const end = new Date(record.t);
  if (dayKey(end) !== dayKey(day)) return null;
  const endMin = minuteOfDay(end) + end.getSeconds() / 60;
  return { start: Math.max(0, endMin - record.ms / 60_000), end: endMin };
}

/** 离某天还有几天：今天是 0，明天是 1，过了是负数 */
export function daysUntil(key: string, today: Date): number {
  const target = parseDay(key);
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target.getTime() - base.getTime()) / 86_400_000);
}

/** 这一周七天（周一到周日） */
export function weekDays(anchor: Date): Date[] {
  const monday = weekStart(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** 离开始还有多少分钟，写成"50 分钟"或"2 小时 10 分" */
export function minutesText(minutes: number, t: (key: string, vars?: Record<string, number>) => string): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return t("{m} 分钟", { m });
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? t("{h} 小时", { h }) : t("{h} 小时 {m} 分", { h, m: rest });
}
