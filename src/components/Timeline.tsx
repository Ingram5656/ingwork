// 今天的时间轴：课、已经专注过的时间、接下来的空档，从早排到晚，一根白线标着现在。
// 主界面左边那一栏。整栏按固定高度排，不滚动：一天有多长就压多扁。

import type { CSSProperties } from "react";
import { t, useLang } from "../lib/i18n";
import { useNow } from "../lib/now";
import { usePlanner } from "../lib/planner";
import {
  classesOn,
  dayRange,
  fmtMinute,
  gapsBetween,
  minuteOfDay,
  minutesText,
  pomodorosIn,
  recordSpan,
} from "../lib/schedule";
import { useSettings } from "../lib/settings";
import { formatDuration, useStats } from "../lib/stats";

/** 时间轴画多高（舞台上的像素），和样式里 .tl__body 的高度一致 */
const BODY_H = 624;
/** 太矮的块只写一行 */
const ONE_LINE = 40;

/** "11月20日 周五" / "Fri, Nov 20" */
export function dateTitle(date: Date, lang: string): string {
  if (lang === "en") {
    return new Intl.DateTimeFormat("en-GB", { weekday: "short", month: "short", day: "numeric" }).format(date);
  }
  const week = ["日", "一", "二", "三", "四", "五", "六"][date.getDay()];
  return `${date.getMonth() + 1}月${date.getDate()}日 周${week}`;
}

interface Props {
  /** 点"去导入课表"时 */
  onOpenSchedule: () => void;
}

export function Timeline({ onOpenSchedule }: Props) {
  const lang = useLang();
  const [settings] = useSettings();
  const now = useNow();
  const { courses } = usePlanner();
  const { records } = useStats();

  const minute = minuteOfDay(now);
  const classes = classesOn(courses, now);
  const range = dayRange(classes, minute);
  const span = range.end - range.start;
  const y = (m: number) => ((Math.max(range.start, Math.min(range.end, m)) - range.start) / span) * BODY_H;
  const place = (start: number, end: number): CSSProperties => ({
    top: y(start),
    height: Math.max(3, y(end) - y(start)),
  });

  const gaps = courses.length > 0 ? gapsBetween(classes, Math.max(minute, range.start), range.end) : [];
  const focused = records
    .map((record) => ({ record, span: recordSpan(record, now) }))
    .filter((x): x is { record: (typeof records)[number]; span: { start: number; end: number } } => !!x.span);
  const focusedMs = focused.reduce((sum, x) => sum + x.record.ms, 0);

  // 一小时多高：太挤时隔一个小时写一个数
  const hourPx = (60 / span) * BODY_H;
  const hourStep = hourPx < 34 ? 2 : 1;
  const hours: number[] = [];
  for (let h = Math.ceil(range.start / 60); h * 60 <= range.end; h += hourStep) hours.push(h);

  let summary = t("{n} 节课", { n: classes.length });
  if (gaps.length > 0) summary += t("，接下来 {n} 段空档", { n: gaps.length });
  if (focusedMs > 0) summary += t("，已专注 {d}", { d: formatDuration(focusedMs) });

  return (
    <section className="tl glass glass--thick" aria-label={t("今天的时间轴")}>
      <div className="tl__head">
        <h2 className="tl__title">{t("今天")}</h2>
        <span className="tl__date">{dateTitle(now, lang)}</span>
      </div>
      <p className="tl__summary">{courses.length === 0 ? t("还没有课表") : summary}</p>

      <div className="tl__body" style={{ height: BODY_H }}>
        {hours.map((h) => (
          <div key={h} className="tl__hour" style={{ top: y(h * 60) }}>
            <span className="tl__hourlabel">{fmtMinute(h * 60)}</span>
          </div>
        ))}

        {focused.map(({ record, span: s }) => (
          <div
            key={`f${record.t}`}
            className="tl__block tl__block--focus"
            style={place(s.start, s.end)}
            title={`${fmtMinute(s.start)}–${fmtMinute(s.end)} ${record.task ?? t("专注")}`}
          >
            {y(s.end) - y(s.start) >= 22 ? (
              <span className="tl__line1">{record.task ?? t("专注")}</span>
            ) : null}
          </div>
        ))}

        {gaps.map((gap) => {
          const n = pomodorosIn(gap, settings.focusMin, settings.shortMin, settings.classLead);
          const tall = y(gap.end) - y(gap.start);
          if (tall < 18) return null;
          return (
            <div key={`g${gap.start}`} className="tl__block tl__block--gap" style={place(gap.start, gap.end)}>
              <span className="tl__line1">{t("空档 {d}", { d: minutesText(gap.end - gap.start, t) })}</span>
              {tall >= ONE_LINE ? (
                <span className="tl__line2">
                  {n > 0 ? t("放得下 {n} 个番茄", { n }) : t("不够一个番茄")}
                </span>
              ) : null}
            </div>
          );
        })}

        {classes.map((c) => {
          const past = c.end <= minute;
          const live = c.start <= minute && minute < c.end;
          const tall = y(c.end) - y(c.start);
          const time = `${fmtMinute(c.start)}–${fmtMinute(c.end)}`;
          let cls = "tl__block tl__block--class";
          if (past) cls += " is-past";
          if (live) cls += " is-now";
          return (
            <div
              key={`c${c.course.id}`}
              className={cls}
              style={place(c.start, c.end)}
              title={`${c.course.title} ${time} ${c.course.place}`}
            >
              <span className="tl__line1">{c.course.title}</span>
              {tall >= ONE_LINE ? (
                <span className="tl__line2">
                  {c.course.place ? `${time} · ${c.course.place}` : time}
                </span>
              ) : null}
            </div>
          );
        })}

        {minute >= range.start && minute <= range.end ? (
          <div className="tl__now" style={{ top: y(minute) }} aria-label={t("现在 {time}", { time: fmtMinute(minute) })}>
            <span className="tl__nowlabel">{fmtMinute(minute)}</span>
          </div>
        ) : null}

        {courses.length === 0 ? (
          <div className="tl__empty">
            <p>{t("导入学校的课表，空档和下节课都会排在这里。")}</p>
            <button type="button" className="btn btn--primary btn--sm" onClick={onOpenSchedule}>
              {t("去导入课表")}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
