// 上课时间到了，在主界面下面问一句要不要开始听课。
// 点"开始听课"就开麦克风、切到听课页；点"这节不用"这节课就不再问。
//
// 到了下课时间还在听，也问一句下课了没有：没人理就先暂停，免得忘了点一直录、一直花钱。

import { useEffect, useMemo, useState } from "react";
import { t, tMsg, useLang } from "../lib/i18n";
import { lecture, useLecture } from "../lib/lecture";
import { useNow } from "../lib/now";
import { usePlanner } from "../lib/planner";
import { classesOn, minuteOfDay } from "../lib/schedule";
import { useSettings } from "../lib/settings";
import { IconClock } from "./Icons";

/** 问过、点过"这节不用"的课（课的编号 + 日期），软件开着时记着 */
const asked = new Set<string>();

interface Props {
  /** 开始以后切到听课页 */
  onStarted: () => void;
  hidden: boolean;
}

export function LectureAsk({ onStarted, hidden }: Props) {
  useLang();
  const [settings] = useSettings();
  const { courses } = usePlanner();
  const s = useLecture();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [, setTick] = useState(0);

  if (hidden || !settings.lectureAsk || !settings.lectureKey.trim() || s.status !== "idle") return null;
  const minute = minuteOfDay(now);
  // 上课前 2 分钟到上课后 15 分钟之间问
  const current = classesOn(courses, now).find((c) => c.start - 2 <= minute && minute < Math.min(c.end, c.start + 15));
  if (!current) return null;
  const key = `${current.course.id}@${now.toDateString()}`;
  if (asked.has(key)) return null;

  const dismiss = () => {
    asked.add(key);
    setTick((n) => n + 1);
  };
  const start = async () => {
    setBusy(true);
    setError("");
    const failed = await lecture.start(current.course.title, current.course.id);
    setBusy(false);
    if (failed) {
      setError(tMsg(failed));
      return;
    }
    asked.add(key);
    onStarted();
  };

  return (
    <div className="lec-ask glass capsule" role="status">
      <IconClock />
      <span className="lec-ask__text">
        {error || t("{title}开始了，要听课吗", { title: current.course.title })}
      </span>
      <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => void start()}>
        {busy ? t("正在打开麦克风") : t("开始听课")}
      </button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={dismiss}>
        {t("这节不用")}
      </button>
    </div>
  );
}

/** 过了下课时间多久开始问（分钟）：老师拖一会儿堂很常见 */
const END_GRACE = 3;
/** 问了以后多久没人理就先暂停（分钟） */
const END_WAIT = 10;
/** 点了"还在上"以后过多久再问（分钟） */
const END_SNOOZE = 15;

/** 点了"还在上"的那节（笔记的编号）到什么时刻之前不再问 */
const snoozed = new Map<string, number>();
/** 已经替它暂停过的那节：只替一次，之后听用户的 */
const autoPaused = new Set<string>();

/** 到了下课时间还在听：问一句下课了没有；没人理就先暂停 */
export function LectureEndAsk({ hidden }: { hidden: boolean }) {
  useLang();
  const [settings] = useSettings();
  const { courses } = usePlanner();
  const s = useLecture();
  const now = useNow();
  const [, setTick] = useState(0);

  // 这节课在课表上几点下课：从课表开始听的才知道
  const endAt = useMemo(() => {
    if (!s.courseId || !s.startedAt || s.imported) return null;
    const started = new Date(s.startedAt);
    const minute = minuteOfDay(started);
    const cls = classesOn(courses, started).find(
      (c) => c.course.id === s.courseId && c.start - 20 <= minute && minute < c.end,
    );
    if (!cls) return null;
    const day = new Date(started);
    day.setHours(0, 0, 0, 0);
    return day.getTime() + cls.end * 60_000;
  }, [courses, s.courseId, s.startedAt, s.imported]);

  const id = s.id;
  const listening = s.status === "listening";
  const askFrom =
    endAt === null || id === null ? null : Math.max(endAt + END_GRACE * 60_000, snoozed.get(id) ?? 0);
  const due = settings.lectureAsk && listening && askFrom !== null && now.getTime() >= askFrom;
  const overdue = due && askFrom !== null && now.getTime() >= askFrom + END_WAIT * 60_000;

  useEffect(() => {
    if (!overdue || id === null || autoPaused.has(id)) return;
    autoPaused.add(id);
    lecture.pause();
  }, [overdue, id]);

  const pausedForYou = s.status === "paused" && id !== null && autoPaused.has(id) && settings.lectureAsk;
  if (hidden || id === null || (!due && !pausedForYou)) return null;

  const later = () => {
    snoozed.set(id, Date.now() + END_SNOOZE * 60_000);
    if (pausedForYou) {
      // 用户说还在上：接着听，这节课不再替它暂停
      lecture.resume();
    }
    setTick((n) => n + 1);
  };

  return (
    <div className="lec-ask glass capsule" role="status">
      <IconClock />
      <span className="lec-ask__text">
        {pausedForYou
          ? t("{title}过了下课时间，听课先暂停了", { title: s.course })
          : t("{title}到下课时间了，下课了吗", { title: s.course })}
      </span>
      <button type="button" className="btn btn--primary btn--sm" onClick={lecture.stop}>
        {t("下课，整理笔记")}
      </button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={later}>
        {pausedForYou ? t("接着听") : t("还在上")}
      </button>
    </div>
  );
}
