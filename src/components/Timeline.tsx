// 今天的时间轴：课、已经专注过的时间、排进空档的待办、接下来的空档，从早排到晚，一根白线标着现在。
// 主界面左边那一栏。整栏按固定高度排，不滚动：一天有多长就压多扁。
// 点一段空档挑一个待办排进去；点"帮我排"按待办清单的顺序把今天空着的时间排满；
// 点排好的一段可以马上开始，或者删掉。

import { useEffect, useState, type CSSProperties } from "react";
import { blocksOn, fitInGap, freeGaps, planDay, planTask } from "../lib/blocks";
import { t, useLang } from "../lib/i18n";
import { useNow } from "../lib/now";
import { planner, usePlanner, type Block } from "../lib/planner";
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
import { tasks as taskActions, useTasks, type Task } from "../lib/tasks";
import { timer, useTimer } from "../lib/timer";

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

  const { blocks } = usePlanner();
  const { tasks } = useTasks();
  const timerState = useTimer();
  const [picking, setPicking] = useState<number | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const todayBlocks = blocksOn(blocks, now);
  const gaps =
    courses.length > 0
      ? freeGaps(gapsBetween(classes, Math.max(minute, range.start), range.end), todayBlocks)
      : [];
  const planned = new Set(todayBlocks.map((b) => b.taskId));
  const open = tasks.filter((task) => !task.finished);
  const canPlan = gaps.length > 0 && open.some((task) => !planned.has(task.id));

  // 弹出来的小面板：点别处、按 Esc 收起来
  useEffect(() => {
    if (picking === null && chosen === null) return;
    const close = () => {
      setPicking(null);
      setChosen(null);
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest(".tl__pop, .tl__block--gap, .tl__block--plan")) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [picking, chosen]);

  const pick = async (task: Task, gapStart: number) => {
    const gap = gaps.find((g) => g.start === gapStart);
    setPicking(null);
    setNote("");
    if (gap && !(await planTask(task, gap))) setNote(t("这段空档放不下一个番茄"));
  };
  const planAll = async () => {
    setNote("");
    // 排好了不用另外说：上面一行会写"排了几段"，时间轴上也看得见
    const n = await planDay(tasks, now);
    if (n === 0) setNote(t("空档放不下，或者待办都排过了"));
  };
  const startBlock = (block: Block) => {
    setChosen(null);
    if (tasks.some((task) => task.id === block.taskId)) taskActions.setCurrent(block.taskId);
    if (!timerState.running) {
      if (timerState.phase !== "focus") timer.setPhase("focus");
      timer.toggle();
    }
  };
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
  if (todayBlocks.length > 0) summary += t("，排了 {n} 段", { n: todayBlocks.length });
  if (gaps.length > 0) summary += t("，接下来 {n} 段空档", { n: gaps.length });
  if (focusedMs > 0) summary += t("，已专注 {d}", { d: formatDuration(focusedMs) });

  return (
    <section className="tl glass glass--thick" aria-label={t("今天的时间轴")}>
      <div className="tl__head">
        <h2 className="tl__title">{t("今天")}</h2>
        <span className="tl__date">{dateTitle(now, lang)}</span>
      </div>
      <p className="tl__summary">{courses.length === 0 ? t("还没有课表") : summary}</p>
      {canPlan || note ? (
        <div className="tl__plan">
          {canPlan ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void planAll()}>
              {t("帮我排")}
            </button>
          ) : null}
          {note ? <span className="tl__plannote">{note}</span> : null}
        </div>
      ) : null}

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

        {todayBlocks.map((block) => {
          const tall = y(block.end) - y(block.start);
          const time = `${fmtMinute(block.start)}–${fmtMinute(block.end)}`;
          const past = block.end <= minute;
          return (
            <button
              type="button"
              key={block.id}
              className={past ? "tl__block tl__block--plan is-past" : "tl__block tl__block--plan"}
              style={place(block.start, block.end)}
              title={`${time} ${block.title}`}
              onClick={() => {
                setPicking(null);
                setChosen(chosen === block.id ? null : block.id);
              }}
            >
              <span className="tl__line1">{block.title}</span>
              {tall >= ONE_LINE ? <span className="tl__line2">{time}</span> : null}
            </button>
          );
        })}

        {gaps.map((gap) => {
          const n = pomodorosIn(gap, settings.focusMin, settings.shortMin, settings.classLead);
          const tall = y(gap.end) - y(gap.start);
          if (tall < 18) return null;
          return (
            <button
              type="button"
              key={`g${gap.start}`}
              className="tl__block tl__block--gap"
              style={place(gap.start, gap.end)}
              title={t("点一下，排一个待办进去")}
              onClick={() => {
                setChosen(null);
                setPicking(picking === gap.start ? null : gap.start);
              }}
            >
              <span className="tl__line1">{t("空档 {d}", { d: minutesText(gap.end - gap.start, t) })}</span>
              {tall >= ONE_LINE ? (
                <span className="tl__line2">
                  {n > 0 ? t("放得下 {n} 个番茄", { n }) : t("不够一个番茄")}
                </span>
              ) : null}
            </button>
          );
        })}

        {picking !== null
          ? (() => {
              const gap = gaps.find((g) => g.start === picking);
              if (!gap) return null;
              return (
                <div className="tl__pop" style={{ top: Math.min(y(gap.start), BODY_H - 220) }}>
                  <p className="tl__poptitle">
                    {t("{time} 开始做什么", { time: fmtMinute(gap.start) })}
                  </p>
                  {open.length === 0 ? (
                    <p className="tl__popempty">{t("待办清单是空的")}</p>
                  ) : (
                    open.slice(0, 6).map((task) => {
                      const fit = fitInGap(task, gap);
                      return (
                        <button
                          type="button"
                          key={task.id}
                          className="tl__popitem"
                          disabled={!fit}
                          onClick={() => void pick(task, gap.start)}
                        >
                          <span>{task.name}</span>
                          <span className="tl__popmeta">
                            {fit ? `${fmtMinute(fit.start)}–${fmtMinute(fit.end)}` : t("放不下")}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              );
            })()
          : null}

        {chosen !== null
          ? (() => {
              const block = todayBlocks.find((b) => b.id === chosen);
              if (!block) return null;
              return (
                <div className="tl__pop" style={{ top: Math.min(y(block.end) + 4, BODY_H - 110) }}>
                  <p className="tl__poptitle">{block.title}</p>
                  <div className="tl__poprow">
                    <button type="button" className="btn btn--primary btn--sm" onClick={() => startBlock(block)}>
                      {t("现在开始")}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => {
                        setChosen(null);
                        void planner.remove(block.id);
                      }}
                    >
                      {t("不排了")}
                    </button>
                  </div>
                </div>
              );
            })()
          : null}

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
