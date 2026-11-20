// 统计面板：今天、本周、连续打卡三项概览；一周七根光条；点一根光条看那一天的记录。
// 图表只有一个系列（每天的专注时长），所以不需要图例；
// 数值写在选中的那根光条顶上，其他的悬停或键盘走到时显示，下面的列表是它的明细。

import { useMemo, useState } from "react";
import { t, tMsg, useLang } from "../lib/i18n";
import {
  addDays,
  byDay,
  clearStats,
  dayKey,
  formatDuration,
  streak,
  useStats,
  weekStart,
  type DaySummary,
} from "../lib/stats";
import { IconChevronLeft, IconChevronRight, IconClose } from "./Icons";
import type { SheetSpec } from "./Sheet";

/** 光条最高多少像素 */
const BAR_MAX = 108;
/** 一周里最长的一天不到这么久时，也按这么久来定高度，免得十分钟就顶到头 */
const SCALE_FLOOR_MS = 60 * 60_000;

const EMPTY: DaySummary = { ms: 0, pomodoros: 0, records: [] };

interface Props {
  onClose: () => void;
  /** 清空前要再确认一次，对话框由主界面显示 */
  confirm: (spec: SheetSpec) => void;
  closeConfirm: () => void;
}

export function StatsPanel({ onClose, confirm, closeConfirm }: Props) {
  const lang = useLang();
  const stats = useStats();
  const days = useMemo(() => byDay(stats.records), [stats.records]);
  const [weekOffset, setWeekOffset] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [clearError, setClearError] = useState("");

  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const today = new Date();
  const todayKey = dayKey(today);
  const sum = (key: string) => days.get(key) ?? EMPTY;

  // ---------- 三项概览 ----------

  const thisWeek = Array.from({ length: 7 }, (_, i) => sum(dayKey(addDays(weekStart(today), i))));
  const weekMs = thisWeek.reduce((total, day) => total + day.ms, 0);
  const weekPomodoros = thisWeek.reduce((total, day) => total + day.pomodoros, 0);
  const streakDays = streak(days, today);

  // ---------- 正在看的那一周 ----------

  const start = addDays(weekStart(today), weekOffset * 7);
  const week = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const weekKeys = week.map(dayKey);
  const scale = Math.max(SCALE_FLOOR_MS, ...weekKeys.map((key) => sum(key).ms));

  // 没点过哪一天时：本周看今天；别的周看最后一个有记录的日子，都没有就看周一
  const fallback =
    weekOffset === 0
      ? todayKey
      : ([...weekKeys].reverse().find((key) => sum(key).ms > 0) ?? weekKeys[0]);
  const selected = picked && weekKeys.includes(picked) ? picked : fallback;
  const selectedDate = week[weekKeys.indexOf(selected)] ?? today;
  const selectedDay = sum(selected);

  const shortDate = (date: Date) =>
    date.toLocaleDateString(locale, { month: "short", day: "numeric" });
  const longDate = (date: Date) =>
    date.toLocaleDateString(locale, { month: "long", day: "numeric", weekday: "long" });
  const clock = (ms: number) =>
    new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });

  let rangeLabel = `${shortDate(week[0])} – ${shortDate(week[6])}`;
  if (weekOffset === 0) rangeLabel = t("本周");
  else if (weekOffset === -1) rangeLabel = t("上周");

  const changeWeek = (delta: number) => {
    setWeekOffset(weekOffset + delta);
    setPicked(null);
  };

  const askClear = () =>
    confirm({
      title: t("清空全部专注记录？"),
      body: t("每天的时长、连续打卡和历史记录都会清掉，找不回来。任务不受影响。"),
      actions: [
        { label: t("留着"), onPick: closeConfirm },
        {
          label: t("清空全部记录"),
          primary: true,
          onPick: () => {
            closeConfirm();
            void clearStats().then(setClearError);
          },
        },
      ],
    });

  let note = "";
  if (clearError) note = tMsg(clearError);
  else if (stats.saveFailed) note = t("最近的记录没存进文件，请检查磁盘空间");

  return (
    <div className="stats glass glass--thick" role="dialog" aria-modal="true" aria-label={t("统计")}>
      <div className="stats__head">
        <h2 className="stats__title">{t("统计")}</h2>
        <button
          type="button"
          className="ibtn"
          title={t("关闭统计")}
          aria-label={t("关闭统计")}
          onClick={onClose}
        >
          <IconClose />
        </button>
      </div>

      <div className="stats__body">
        <div className="tiles">
          <div className="tile">
            <div className="tile__label">{t("今天")}</div>
            <div className="tile__value">{formatDuration(sum(todayKey).ms)}</div>
            <div className="tile__sub">{t("{n} 个番茄", { n: sum(todayKey).pomodoros })}</div>
          </div>
          <div className="tile">
            <div className="tile__label">{t("本周")}</div>
            <div className="tile__value">{formatDuration(weekMs)}</div>
            <div className="tile__sub">{t("{n} 个番茄", { n: weekPomodoros })}</div>
          </div>
          <div className="tile">
            <div className="tile__label">{t("连续打卡")}</div>
            <div className="tile__value">{t("{n} 天", { n: streakDays })}</div>
            <div className="tile__sub">{t("每天至少一个番茄")}</div>
          </div>
        </div>

        <section className="chart" aria-label={t("每天的专注时长")}>
          <div className="chart__nav">
            <button
              type="button"
              className="ibtn ibtn--sm"
              title={t("前一周")}
              aria-label={t("前一周")}
              onClick={() => changeWeek(-1)}
            >
              <IconChevronLeft />
            </button>
            <div className="chart__range">{rangeLabel}</div>
            <button
              type="button"
              className="ibtn ibtn--sm"
              title={t("后一周")}
              aria-label={t("后一周")}
              disabled={weekOffset >= 0}
              onClick={() => changeWeek(1)}
            >
              <IconChevronRight />
            </button>
          </div>
          <div className="chart__plot">
            {week.map((date, i) => {
              const key = weekKeys[i];
              const day = sum(key);
              const future = key > todayKey;
              const height = day.ms > 0 ? Math.max(4, Math.round((day.ms / scale) * BAR_MAX)) : 0;
              const label = t("{date}：专注 {time}，{n} 个番茄", {
                date: longDate(date),
                time: formatDuration(day.ms),
                n: day.pomodoros,
              });
              const classes = ["col"];
              if (key === selected) classes.push("is-selected");
              if (key === todayKey) classes.push("is-today");
              return (
                <button
                  key={key}
                  type="button"
                  className={classes.join(" ")}
                  title={label}
                  aria-label={label}
                  aria-pressed={key === selected}
                  disabled={future}
                  onClick={() => setPicked(key)}
                >
                  <span className="col__stem">
                    {day.ms > 0 ? (
                      <>
                        <span className="col__value">{formatDuration(day.ms)}</span>
                        <span className="col__bar" style={{ height }} />
                      </>
                    ) : null}
                  </span>
                  <span className="col__day">
                    {date.toLocaleDateString(locale, { weekday: "short" })}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="daylist">
          <div className="daylist__head">
            <span className="daylist__date">{longDate(selectedDate)}</span>
            <span className="daylist__sum">
              {selectedDay.ms > 0
                ? `${formatDuration(selectedDay.ms)} · ${t("{n} 个番茄", { n: selectedDay.pomodoros })}`
                : ""}
            </span>
          </div>
          <div className="daylist__rows">
            {selectedDay.records.length === 0 ? (
              <div className="daylist__empty">
                {selected === todayKey
                  ? t("今天还没有专注记录。走完一段专注，这里就会有。")
                  : t("这一天没有专注记录。")}
              </div>
            ) : null}
            {selectedDay.records.map((record) => (
              <div key={record.t} className="entry">
                <span className="entry__time">{clock(record.t)}</span>
                <span className="entry__length">{formatDuration(record.ms)}</span>
                <span className={record.task ? "entry__task" : "entry__task is-none"}>
                  {record.task || t("没有选任务")}
                </span>
                {record.done ? null : <span className="entry__tag">{t("中途停下")}</span>}
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="stats__foot">
        <span className="stats__note">{note}</span>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={stats.records.length === 0}
          onClick={askClear}
        >
          {t("清空全部记录")}
        </button>
      </div>
    </div>
  );
}
