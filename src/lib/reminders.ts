// 提醒：上课前几分钟、截止日期前一天晚上和当天早上、排进空档的任务到点，各发一条系统通知。
// 这里只负责排时间：算好今天和明天每节课该在几点提醒，交给后端；到点由后端发通知（见 reminders.rs）。
// 主窗口收起来以后，网页的定时器会被系统大幅拖慢（Mac 上尤其狠），所以到点这件事不能靠网页。
// 只有主窗口调。

import { getPlanner, subscribePlanner } from "./planner";
import { classesOn, fmtMinute, parseDay } from "./schedule";
import { getSettings, subscribeSettings } from "./settings";
import { addDays, dayKey } from "./stats";
import { t } from "./i18n";
import { call } from "./tauri";

export interface Reminder {
  key: string;
  at: number;
  until: number;
  title: string;
  body: string;
}

let started = false;

/** 排进空档的任务到点的提醒，由 blocks.ts 提供（避免互相引用，开始时登记进来） */
let blockReminders: () => Reminder[] = () => [];

export function provideBlockReminders(source: () => Reminder[]): void {
  blockReminders = source;
  if (started) schedule();
}
let last = "";

/** 某天第 minute 分钟的时刻（Unix 毫秒） */
function at(day: Date, minute: number): number {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minute).getTime();
}

function schedule(): void {
  const { classLead, lang } = getSettings();
  const list: Reminder[] = [];
  if (classLead > 0) {
    const today = new Date();
    for (const day of [today, addDays(today, 1)]) {
      for (const c of classesOn(getPlanner().courses, day)) {
        const place = c.course.place ? ` · ${c.course.place}` : "";
        list.push({
          key: `${dayKey(day)}|${c.course.id}|${c.start}`,
          at: at(day, c.start - classLead),
          until: at(day, c.start),
          // {n} 留给后端：到点时还有几分钟上课由它填
          title: t("{n} 分钟后上{title}", { n: "{n}", title: c.course.title }),
          body: `${fmtMinute(c.start)}–${fmtMinute(c.end)}${place}`,
        });
      }
    }
  }
  const { deadlineRemind } = getSettings();
  if (deadlineRemind) {
    const now = Date.now();
    for (const d of getPlanner().deadlines) {
      if (d.done) continue;
      const due = parseDay(d.due);
      if (Number.isNaN(due.getTime())) continue;
      const end = at(due, 24 * 60);
      if (end <= now) continue;
      const eve = addDays(due, -1);
      // 自己选的提前几天：那天早上 9 点提醒一次（没赶上的话，到前一天晚上那次之前都还会补）
      const early = d.remindDays ?? 0;
      if (early >= 2) {
        list.push({
          key: `ddl|${d.id}|${d.due}|early${early}`,
          at: at(addDays(due, -early), 9 * 60),
          until: at(eve, 20 * 60),
          title: t("还有 {n} 天截止：{title}", { n: early, title: d.title }),
          body: t("提前跟你说一声，可以先排进待办"),
        });
      }
      // 前一天晚上 8 点
      list.push({
        key: `ddl|${d.id}|${d.due}|eve`,
        at: at(eve, 20 * 60),
        until: at(due, 0),
        title: t("明天截止：{title}", { title: d.title }),
        body: t("还剩一天，今晚能做多少做多少"),
      });
      // 当天早上 9 点
      list.push({
        key: `ddl|${d.id}|${d.due}|day`,
        at: at(due, 9 * 60),
        until: end,
        title: t("今天截止：{title}", { title: d.title }),
        body: t("今天就要交了"),
      });
    }
  }
  for (const block of blockReminders()) list.push(block);
  // 没变就不重复发
  const text = JSON.stringify([lang, list]);
  if (text === last) return;
  last = text;
  call("reminders_set", { list });
}

/** 别处的数据变了（比如排进空档的任务），重新排一次 */
export function rescheduleReminders(): void {
  if (started) schedule();
}

export function initReminders(): void {
  if (started) return;
  started = true;
  schedule();
  subscribePlanner(schedule);
  subscribeSettings(schedule);
  // 过了零点要把"明天"的排上。网页的定时器在后台会被拖慢，晚一点也没关系：一次排两天
  window.setInterval(schedule, 10 * 60_000);
  document.addEventListener("visibilitychange", schedule);
}
