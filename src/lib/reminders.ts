// 上课提醒：课前几分钟发一条系统通知。只有主窗口调，窗口藏在托盘里也照样提醒。

import { getPlanner } from "./planner";
import { classesOn, fmtMinute, minuteOfDay } from "./schedule";
import { getSettings } from "./settings";
import { dayKey } from "./stats";
import { t } from "./i18n";
import { call } from "./tauri";

/** 已经提醒过的：日期 + 课的 id */
const done = new Set<string>();
let started = false;

function check(): void {
  const lead = getSettings().classLead;
  if (lead <= 0) return;
  const now = new Date();
  const minute = minuteOfDay(now);
  for (const c of classesOn(getPlanner().courses, now)) {
    const key = `${dayKey(now)}|${c.course.id}|${c.start}`;
    if (done.has(key)) continue;
    const until = c.start - minute;
    // 提醒的那一分钟软件没开着（或者电脑睡着了），开课前补一次
    if (until <= lead && until > 0) {
      done.add(key);
      const place = c.course.place ? ` · ${c.course.place}` : "";
      call("notify", {
        title: t("{n} 分钟后上{title}", { n: until, title: c.course.title }),
        body: `${fmtMinute(c.start)}–${fmtMinute(c.end)}${place}`,
      });
    }
  }
}

export function initReminders(): void {
  if (started) return;
  started = true;
  check();
  window.setInterval(check, 20_000);
}
