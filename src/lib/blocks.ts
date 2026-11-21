// 把待办排进空档：时间轴上点一段空档挑一个待办，或者点"帮我排"一口气排满。
// 排好的一段存在课表数据里（planner.json），几台电脑同步；到点发一条提醒（见 reminders.ts）。
//
// 一个番茄 = 一段专注 + 一段短休息；排的时候按待办还差几个番茄、空档放得下几个来算。

import { t } from "./i18n";
import { getPlanner, planner, type Block, type BlockInput } from "./planner";
import { provideBlockReminders, type Reminder } from "./reminders";
import { classesOn, dayRange, fmtMinute, gapsBetween, minuteOfDay, type Gap } from "./schedule";
import { getSettings } from "./settings";
import { dayKey } from "./stats";
import type { Task } from "./tasks";

/** 某天排了哪些段，按开始时间排好 */
export function blocksOn(blocks: Block[], day: Date): Block[] {
  const key = dayKey(day);
  return blocks.filter((b) => b.day === key).sort((a, b) => a.start - b.start);
}

/**
 * 空档里去掉已经排了的段，剩下的才是真正空着的。
 * 被排了的段切开以后，前半截后面接的不是课了，就不用再给路上留时间
 */
export function freeGaps(gaps: Gap[], blocks: Block[], minLength = 15): Gap[] {
  const result: Gap[] = [];
  for (const gap of gaps) {
    let cursor = gap.start;
    for (const b of blocks) {
      if (b.end <= cursor || b.start >= gap.end) continue;
      if (b.start - cursor >= minLength) result.push({ start: cursor, end: b.start, before: null });
      cursor = Math.max(cursor, b.end);
    }
    if (gap.end - cursor >= minLength) result.push({ start: cursor, end: gap.end, before: gap.before });
  }
  return result;
}

/** 今天还空着的时间（从现在起） */
export function todayFreeGaps(now: Date): Gap[] {
  const { courses, blocks } = getPlanner();
  const classes = classesOn(courses, now);
  const minute = minuteOfDay(now);
  const range = dayRange(classes, minute);
  const gaps = gapsBetween(classes, Math.max(minute, range.start), range.end);
  return freeGaps(gaps, blocksOn(blocks, now));
}

/** 这个待办还差几个番茄（至少排一个） */
function remaining(task: Task): number {
  return Math.max(1, task.estimate - task.spent);
}

/**
 * 在一段空档里给一个待办排几个番茄，最多排到它还差的数。
 * 空档后面是课的话，末尾留出去上课路上的时间。放不下一个番茄就返回空
 */
export function fitInGap(task: Task, gap: Gap, wanted = remaining(task)): BlockInput | null {
  const { focusMin, shortMin, classLead } = getSettings();
  const end = gap.end - (gap.before ? classLead : 0);
  const room = end - gap.start;
  if (room < focusMin) return null;
  const fits = Math.floor((room + shortMin) / (focusMin + shortMin));
  const n = Math.min(fits, wanted);
  if (n < 1) return null;
  return {
    day: dayKey(new Date()),
    start: gap.start,
    end: gap.start + n * focusMin + (n - 1) * shortMin,
    taskId: "",
    title: "",
  };
}

/** 把一个待办排进一段空档 */
export async function planTask(task: Task, gap: Gap): Promise<boolean> {
  const fit = fitInGap(task, gap);
  if (!fit) return false;
  return planner.addBlocks([{ ...fit, taskId: task.id, title: task.name }]);
}

/**
 * 帮我排：把今天还空着的时间，按待办清单的顺序排满。
 * 已经在今天排过的待办跳过；一个待办在一段空档里排不完，接着往下一段排。返回排了几段
 */
export async function planDay(tasks: Task[], now: Date): Promise<number> {
  const { shortMin } = getSettings();
  const today = blocksOn(getPlanner().blocks, now);
  const planned = new Set(today.map((b) => b.taskId));
  const todo = tasks.filter((task) => !task.finished && !planned.has(task.id));
  const left = new Map(todo.map((task) => [task.id, remaining(task)]));
  const out: BlockInput[] = [];
  let queue = [...todo];
  for (const gap of todayFreeGaps(now)) {
    let cursor = gap.start;
    while (queue.length > 0) {
      const task = queue[0];
      const fit = fitInGap(task, { ...gap, start: cursor }, left.get(task.id));
      if (!fit) break;
      out.push({ ...fit, taskId: task.id, title: task.name });
      const done = Math.round((fit.end - fit.start + shortMin) / (getSettings().focusMin + shortMin));
      const rest = (left.get(task.id) ?? 0) - done;
      left.set(task.id, rest);
      if (rest <= 0) queue = queue.slice(1);
      cursor = fit.end + shortMin;
    }
    if (queue.length === 0) break;
  }
  if (out.length === 0) return 0;
  const ok = await planner.addBlocks(out);
  return ok ? out.length : 0;
}

/** 到点提醒：今天和明天排了的每一段，开始时提醒一次 */
function reminders(): Reminder[] {
  if (!getSettings().blockRemind) return [];
  const list: Reminder[] = [];
  const now = Date.now();
  for (const b of getPlanner().blocks) {
    const [y, m, d] = b.day.split("-").map(Number);
    const start = new Date(y, m - 1, d, 0, b.start).getTime();
    const end = new Date(y, m - 1, d, 0, b.end).getTime();
    if (end <= now || start - now > 2 * 86_400_000) continue;
    list.push({
      key: `block|${b.id}`,
      at: start,
      until: end,
      title: t("该做：{title}", { title: b.title }),
      body: `${fmtMinute(b.start)}–${fmtMinute(b.end)}`,
    });
  }
  return list;
}

let started = false;

/** 主窗口调一次：把"排进空档的段"的提醒接进提醒里 */
export function initBlocks(): void {
  if (started) return;
  started = true;
  // 课表数据一变，提醒那边会自己重新排，这里只要把来源交过去
  provideBlockReminders(reminders);
}
