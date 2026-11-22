// 上课时间到了，在主界面下面问一句要不要开始听课。
// 点"开始听课"就开麦克风、切到听课页；点"这节不用"这节课就不再问。

import { useState } from "react";
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
