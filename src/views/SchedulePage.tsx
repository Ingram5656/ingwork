// 课表页：左边导入和编辑，右边一周的课、实际专注过的时间和今天剩下的空档叠在一起。

import {
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
} from "react";
import { IconChevronLeft, IconChevronRight, IconUpload } from "../components/Icons";
import { Segmented } from "../components/Segmented";
import type { SheetSpec } from "../components/Sheet";
import { parseIcs, type IcsResult } from "../lib/ics";
import { t, tMsg, useLang } from "../lib/i18n";
import { useNow } from "../lib/now";
import {
  clearPlannerError,
  planner,
  usePlanner,
  usePlannerError,
  type Course,
  type CourseInput,
} from "../lib/planner";
import {
  classesOn,
  dayRange,
  fmtMinute,
  gapsBetween,
  isoWeekday,
  minuteOfDay,
  parseMinute,
  recordSpan,
  weekDays,
} from "../lib/schedule";
import { addDays, dayKey, useStats } from "../lib/stats";

const WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
/** 周视图画多高（舞台上的像素），和样式里 .week__body 一致 */
const BODY_H = 580;

// ---------- 表单 ----------

interface Draft {
  title: string;
  place: string;
  weekday: number;
  start: string;
  end: string;
  from: string;
  until: string;
  every: number;
}

function emptyDraft(weekday: number): Draft {
  const today = new Date();
  return {
    title: "",
    place: "",
    weekday,
    start: "09:00",
    end: "10:00",
    from: dayKey(today),
    until: dayKey(addDays(today, 16 * 7)),
    every: 1,
  };
}

function draftOf(course: Course): Draft {
  return {
    title: course.title,
    place: course.place,
    weekday: course.weekday,
    start: fmtMinute(course.start),
    end: fmtMinute(course.end),
    from: course.from,
    until: course.until,
    every: course.every,
  };
}

/** 表单内容变成发给后端的样子。时间写错了返回出错原因 */
function toInput(draft: Draft, skip: string[]): CourseInput | string {
  const start = parseMinute(draft.start);
  const end = parseMinute(draft.end);
  if (start === null || end === null) return t("时间要写成 09:00 这样");
  return {
    title: draft.title,
    place: draft.place,
    weekday: draft.weekday,
    start,
    end,
    from: draft.from,
    until: draft.until,
    every: draft.every,
    skip,
  };
}

function CourseForm({
  editing,
  onDone,
  confirm,
  closeConfirm,
}: {
  editing: Course | null;
  onDone: () => void;
  confirm: (spec: SheetSpec) => void;
  closeConfirm: () => void;
}) {
  useLang();
  const error = usePlannerError();
  const [draft, setDraft] = useState<Draft>(() =>
    editing ? draftOf(editing) : emptyDraft(isoWeekday(new Date())),
  );
  const [local, setLocal] = useState("");
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const field =
    (key: keyof Draft) =>
    (event: ChangeEvent<HTMLInputElement>) =>
      set({ [key]: event.target.value } as Partial<Draft>);

  const save = async () => {
    const input = toInput(draft, editing?.skip ?? []);
    if (typeof input === "string") {
      setLocal(input);
      return;
    }
    setLocal("");
    const ok = editing ? await planner.editCourse(editing.id, input) : await planner.addCourse(input);
    if (ok) {
      if (editing) onDone();
      else setDraft({ ...emptyDraft(draft.weekday), from: draft.from, until: draft.until });
    }
  };

  const askRemove = () => {
    if (!editing) return;
    confirm({
      title: t("删除「{name}」？", { name: editing.title }),
      body: t("这节课每周的安排都会删掉。"),
      actions: [
        { label: t("留着"), onPick: closeConfirm },
        {
          label: t("删除这节课"),
          primary: true,
          onPick: () => {
            closeConfirm();
            void planner.remove(editing.id).then(onDone);
          },
        },
      ],
    });
  };

  const message = local || (error ? tMsg(error) : "");

  return (
    <div className="cform">
      <h3 className="sch__subtitle">{editing ? t("修改这节课") : t("加一节课")}</h3>
      <input
        className="field"
        value={draft.title}
        maxLength={60}
        placeholder={t("课程名")}
        aria-label={t("课程名")}
        onChange={field("title")}
      />
      <input
        className="field"
        value={draft.place}
        maxLength={40}
        placeholder={t("教室（可以不填）")}
        aria-label={t("教室")}
        onChange={field("place")}
      />
      <div className="cform__days" role="radiogroup" aria-label={t("星期几")}>
        {WEEKDAY_NAMES.map((name, i) => (
          <button
            key={name}
            type="button"
            role="radio"
            className="chip chip--day"
            aria-checked={draft.weekday === i + 1}
            onClick={() => set({ weekday: i + 1 })}
          >
            {t(name)}
          </button>
        ))}
      </div>
      <div className="cform__pair">
        <label className="cform__label">
          <span>{t("上课")}</span>
          <input className="field" type="time" value={draft.start} onChange={field("start")} />
        </label>
        <label className="cform__label">
          <span>{t("下课")}</span>
          <input className="field" type="time" value={draft.end} onChange={field("end")} />
        </label>
      </div>
      <div className="cform__pair">
        <label className="cform__label">
          <span>{t("从")}</span>
          <input className="field" type="date" value={draft.from} onChange={field("from")} />
        </label>
        <label className="cform__label">
          <span>{t("到")}</span>
          <input className="field" type="date" value={draft.until} onChange={field("until")} />
        </label>
      </div>
      <div className="cform__row">
        <Segmented<"1" | "2">
          small
          label={t("多久上一次")}
          value={draft.every === 2 ? "2" : "1"}
          options={[
            { value: "1", label: t("每周") },
            { value: "2", label: t("隔周") },
          ]}
          onChange={(value) => set({ every: Number(value) })}
        />
      </div>
      {message ? <div className="sch__error">{message}</div> : null}
      <div className="cform__actions">
        {editing ? (
          <>
            <button type="button" className="btn btn--ghost btn--sm" onClick={askRemove}>
              {t("删除这节课")}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                clearPlannerError();
                onDone();
              }}
            >
              {t("不改了")}
            </button>
          </>
        ) : null}
        <button type="button" className="btn btn--primary btn--sm" onClick={() => void save()}>
          {editing ? t("保存修改") : t("加上这节课")}
        </button>
      </div>
    </div>
  );
}

// ---------- 导入 ----------

function Importer({ hasCourses }: { hasCourses: boolean }) {
  useLang();
  const input = useRef<HTMLInputElement>(null);
  const [found, setFound] = useState<IcsResult | null>(null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [over, setOver] = useState(false);

  const read = async (file: File) => {
    setFound(null);
    setMessage("");
    if (!/\.ics$/i.test(file.name)) {
      setMessage(t("现在只认 .ics 日历文件。教务系统一般有「导出到日历」，导出来就是它"));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setMessage(t("文件太大了，课表文件一般不到 1 MB"));
      return;
    }
    try {
      const result = parseIcs(await file.text());
      setName(file.name);
      if (result.courses.length === 0) {
        setMessage(t("这个文件里没有找到课。全天的事件不算课"));
        return;
      }
      setFound(result);
    } catch {
      setMessage(t("这个文件读不懂，换一个试试"));
    }
  };

  const commit = async (replace: boolean) => {
    if (!found) return;
    if (await planner.importCourses(found.courses, replace)) {
      setMessage(t("导入了 {n} 节课", { n: found.courses.length }));
      setFound(null);
    }
  };

  const error = usePlannerError();

  return (
    <div
      className={over ? "drop is-over" : "drop"}
      onDragOver={(event: ReactDragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event: ReactDragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setOver(false);
        const file = event.dataTransfer.files[0];
        if (file) void read(file);
      }}
    >
      <input
        ref={input}
        type="file"
        accept=".ics,text/calendar"
        hidden
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const file = event.target.files?.[0];
          if (file) void read(file);
          event.target.value = "";
        }}
      />
      {found ? (
        <>
          <div className="drop__title">{name}</div>
          <div className="drop__note">
            {t("找到 {n} 节课", { n: found.courses.length })}
            {found.skipped > 0 ? t("，跳过了 {n} 个全天或跨天的事件", { n: found.skipped }) : ""}
          </div>
          <div className="drop__actions">
            {hasCourses ? (
              <>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => void commit(false)}>
                  {t("加到现有课表")}
                </button>
                <button type="button" className="btn btn--primary btn--sm" onClick={() => void commit(true)}>
                  {t("替换现有课表")}
                </button>
              </>
            ) : (
              <button type="button" className="btn btn--primary btn--sm" onClick={() => void commit(true)}>
                {t("导入这些课")}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <IconUpload />
          <div className="drop__title">{t("把 .ics 文件拖到这里")}</div>
          <div className="drop__note">{t("教务系统或课程表 App 导出的日历文件")}</div>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => input.current?.click()}>
            {t("选择文件")}
          </button>
        </>
      )}
      {message ? <div className="drop__message">{message}</div> : null}
      {error && found ? <div className="drop__message">{tMsg(error)}</div> : null}
    </div>
  );
}

// ---------- 周视图 ----------

function WeekGrid({ onPick }: { onPick: (course: Course) => void }) {
  const lang = useLang();
  const now = useNow();
  const { courses } = usePlanner();
  const { records } = useStats();
  const [offset, setOffset] = useState(0);

  const days = weekDays(addDays(now, offset * 7));
  const perDay = days.map((day) => classesOn(courses, day));
  const range = dayRange(perDay.flat());
  const span = range.end - range.start;
  const y = (m: number) => ((Math.max(range.start, Math.min(range.end, m)) - range.start) / span) * BODY_H;
  const place = (start: number, end: number): CSSProperties => ({
    top: y(start),
    height: Math.max(3, y(end) - y(start)),
  });
  const todayKey = dayKey(now);
  const minute = minuteOfDay(now);

  const hourPx = (60 / span) * BODY_H;
  const hourStep = hourPx < 30 ? 2 : 1;
  const hours: number[] = [];
  for (let h = Math.ceil(range.start / 60); h * 60 <= range.end; h += hourStep) hours.push(h);

  const fmt = (date: Date) =>
    lang === "en"
      ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(date)
      : `${date.getMonth() + 1}月${date.getDate()}日`;
  let rangeLabel = `${fmt(days[0])} – ${fmt(days[6])}`;
  if (offset === 0) rangeLabel = t("本周，{range}", { range: rangeLabel });

  return (
    <section className="week glass glass--thick" aria-label={t("一周的课")}>
      <div className="week__nav">
        <button
          type="button"
          className="ibtn"
          title={t("上一周")}
          aria-label={t("上一周")}
          onClick={() => setOffset(offset - 1)}
        >
          <IconChevronLeft />
        </button>
        <span className="week__range">{rangeLabel}</span>
        <button
          type="button"
          className="ibtn"
          title={t("下一周")}
          aria-label={t("下一周")}
          onClick={() => setOffset(offset + 1)}
        >
          <IconChevronRight />
        </button>
        {offset !== 0 ? (
          <button type="button" className="btn btn--ghost btn--sm week__back" onClick={() => setOffset(0)}>
            {t("回到本周")}
          </button>
        ) : null}
      </div>

      <div className="week__heads">
        {days.map((day, i) => (
          <div key={dayKey(day)} className={dayKey(day) === todayKey ? "week__head is-today" : "week__head"}>
            <span className="week__dow">{t(WEEKDAY_NAMES[i])}</span>
            <span className="week__dom">{day.getDate()}</span>
          </div>
        ))}
      </div>

      <div className="week__body" style={{ height: BODY_H }}>
        <div className="week__axis" aria-hidden="true">
          {hours.map((h) => (
            <span key={h} className="week__hour" style={{ top: y(h * 60) }}>
              {fmtMinute(h * 60)}
            </span>
          ))}
        </div>
        {hours.map((h) => (
          <div key={`l${h}`} className="week__line" style={{ top: y(h * 60) }} aria-hidden="true" />
        ))}
        <div className="week__cols">
          {days.map((day, i) => {
            const key = dayKey(day);
            const isToday = key === todayKey;
            const focus = records
              .map((record) => ({ record, span: recordSpan(record, day) }))
              .filter((x) => x.span !== null);
            const gaps = isToday
              ? gapsBetween(perDay[i], Math.max(minute, range.start), range.end, 30)
              : [];
            return (
              <div key={key} className={isToday ? "week__col is-today" : "week__col"}>
                {focus.map(({ record, span: s }) =>
                  s ? (
                    <div
                      key={`f${record.t}`}
                      className="wk wk--focus"
                      style={place(s.start, s.end)}
                      title={`${fmtMinute(s.start)}–${fmtMinute(s.end)} ${record.task ?? t("专注")}`}
                    />
                  ) : null,
                )}
                {gaps.map((gap) => (
                  <div key={`g${gap.start}`} className="wk wk--gap" style={place(gap.start, gap.end)}>
                    {y(gap.end) - y(gap.start) > 20 ? t("空档") : null}
                  </div>
                ))}
                {perDay[i].map((c) => (
                  <button
                    key={c.course.id}
                    type="button"
                    className={
                      isToday && c.start <= minute && minute < c.end ? "wk wk--class is-now" : "wk wk--class"
                    }
                    style={place(c.start, c.end)}
                    title={t("点击修改")}
                    onClick={() => onPick(c.course)}
                  >
                    <span className="wk__title">{c.course.title}</span>
                    {y(c.end) - y(c.start) > 36 ? (
                      <span className="wk__time">
                        {fmtMinute(c.start)}–{fmtMinute(c.end)}
                      </span>
                    ) : null}
                    {y(c.end) - y(c.start) > 54 && c.course.place ? (
                      <span className="wk__time">{c.course.place}</span>
                    ) : null}
                  </button>
                ))}
                {isToday && minute >= range.start && minute <= range.end ? (
                  <div className="week__now" style={{ top: y(minute) }} aria-hidden="true" />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <div className="week__legend" aria-hidden="true">
        <span className="legend legend--class">{t("课")}</span>
        <span className="legend legend--focus">{t("专注过的时间")}</span>
        <span className="legend legend--gap">{t("今天还能用的空档")}</span>
      </div>
    </section>
  );
}

// ---------- 页面 ----------

interface Props {
  confirm: (spec: SheetSpec) => void;
  closeConfirm: () => void;
}

export function SchedulePage({ confirm, closeConfirm }: Props) {
  useLang();
  const { courses } = usePlanner();
  const [editing, setEditing] = useState<Course | null>(null);
  // 换一节课编辑时，表单要从头装一遍
  const [formKey, setFormKey] = useState(0);

  const pick = (course: Course) => {
    clearPlannerError();
    setEditing(course);
    setFormKey(formKey + 1);
  };

  const done = () => {
    setEditing(null);
    setFormKey(formKey + 1);
  };

  const askClear = () =>
    confirm({
      title: t("清空课表？"),
      body: t("全部 {n} 节课都会删掉，之后可以重新导入。", { n: courses.length }),
      actions: [
        { label: t("留着"), onPick: closeConfirm },
        {
          label: t("清空课表"),
          primary: true,
          onPick: () => {
            closeConfirm();
            done();
            void planner.clearCourses();
          },
        },
      ],
    });

  return (
    <div className="page page--schedule">
      <aside className="sch glass glass--thick" aria-label={t("导入和编辑课表")}>
        <h2 className="sch__title">{t("课表")}</h2>
        <Importer hasCourses={courses.length > 0} />
        <CourseForm
          key={formKey}
          editing={editing}
          onDone={done}
          confirm={confirm}
          closeConfirm={closeConfirm}
        />
        <div className="sch__foot">
          <span className="sch__count">
            {courses.length > 0 ? t("课表里有 {n} 节课", { n: courses.length }) : t("还没有课")}
          </span>
          {courses.length > 0 ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={askClear}>
              {t("清空课表")}
            </button>
          ) : null}
        </div>
      </aside>
      <WeekGrid onPick={pick} />
    </div>
  );
}
