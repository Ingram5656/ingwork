// 上课提醒：课前几分钟发一条系统通知。
// 这里只负责排时间：算好今天和明天每节课该在几点提醒，交给后端；到点由后端发通知（见 reminders.rs）。
// 主窗口收起来以后，网页的定时器会被系统大幅拖慢（Mac 上尤其狠），所以到点这件事不能靠网页。
// 只有主窗口调。

import { getPlanner, subscribePlanner } from "./planner";
import { classesOn, fmtMinute } from "./schedule";
import { getSettings, subscribeSettings } from "./settings";
import { addDays, dayKey } from "./stats";
import { t } from "./i18n";
import { call } from "./tauri";

interface Reminder {
  key: string;
  at: number;
  until: number;
  title: string;
  body: string;
}

let started = false;
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
  // 没变就不重复发
  const text = JSON.stringify([lang, list]);
  if (text === last) return;
  last = text;
  call("reminders_set", { list });
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
