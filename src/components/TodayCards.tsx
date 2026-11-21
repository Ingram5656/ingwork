// "今天"页倒计时下面和专注布局里的几张小卡片：
// - 空档提示：离下节课不够一个完整番茄时，提示把这一段改短
// - 休息时复习生词
// - 专注布局里的"下节课"和"杂念箱"

import { useEffect, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { imeBusy } from "../lib/platform";
import { t, tMsg, useLang } from "../lib/i18n";
import { useNow } from "../lib/now";
import { planner, usePlanner, usePlannerError, type Word } from "../lib/planner";
import { fmtMinute, minuteOfDay, minutesText, nowAndNext } from "../lib/schedule";
import { accelKeys } from "../lib/shortcuts";
import { useSettings } from "../lib/settings";
import { timer, useSegmentMinutes, useTimer } from "../lib/timer";
import { IconClock } from "./Icons";

// ---------- 空档提示 ----------

/**
 * 还没开始的专注，离下节课又不够一段时：说清楚还有多久，给一个改短这一段的按钮。
 * 正在上课时说一句几点下课。别的时候什么都不显示。
 */
export function GapHint() {
  useLang();
  const [settings] = useSettings();
  const state = useTimer();
  const length = useSegmentMinutes();
  const now = useNow();
  const { courses } = usePlanner();

  if (!settings.gapHint || state.phase !== "focus" || state.started) return null;
  const { current, next } = nowAndNext(courses, now);
  const minute = minuteOfDay(now);

  if (current) {
    return (
      <div className="hint-pill glass capsule" role="status">
        <IconClock />
        <span>
          {t("正在上{title}，{time} 下课", { title: current.course.title, time: fmtMinute(current.end) })}
        </span>
      </div>
    );
  }
  if (!next) return null;

  const until = next.start - minute;
  const usable = until - settings.classLead;
  // 一段完整的专注放得下，就不打扰
  if (usable >= length) return null;
  // 再过一会儿就该走了，也不打扰了
  if (until > 180) return null;

  // 改成 5 的倍数，最短 5 分钟
  const suggest = Math.floor(usable / 5) * 5;
  const lead = settings.classLead > 0 ? t("，留 {n} 分钟去教室", { n: settings.classLead }) : "";

  return (
    <div className="hint-pill glass capsule" role="status">
      <IconClock />
      <span>
        {t("离{title}还有 {d}", { title: next.course.title, d: minutesText(until, t) })}
        {suggest >= 5 ? lead : t("，该准备出发了")}
      </span>
      {suggest >= 5 && suggest < length ? (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => timer.setLength(suggest)}>
          {t("这一段改成 {n} 分钟", { n: suggest })}
        </button>
      ) : null}
    </div>
  );
}

// ---------- 休息时复习生词 ----------

/** 先复习不熟的、好久没看的 */
function pickWord(words: Word[], skip: Set<string>): Word | null {
  const pool = words.filter((w) => !skip.has(w.id) && w.known < 5);
  if (pool.length === 0) return null;
  pool.sort((a, b) => a.known - b.known || a.reviewedAt - b.reviewedAt || a.addedAt - b.addedAt);
  return pool[0];
}

/** 休息时从生词本里拿一个词出来：先想想意思，再翻开看 */
export function WordReview() {
  useLang();
  const state = useTimer();
  const { words } = usePlanner();
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const [reveal, setReveal] = useState(false);

  // 每次进入休息都从头挑
  useEffect(() => {
    setSeen(new Set());
    setReveal(false);
  }, [state.phase]);

  if (state.phase === "focus") return null;
  const word = pickWord(words, seen);
  if (!word) return null;

  const answer = (known: boolean) => {
    void planner.reviewWord(word.id, known);
    setSeen(new Set(seen).add(word.id));
    setReveal(false);
  };

  return (
    <div className="word-card glass capsule" role="group" aria-label={t("复习生词")}>
      <div className="word-card__text">
        <span className="word-card__word">{word.word}</span>
        <span className="word-card__meaning">
          {reveal ? word.meaning || t("没有记下释义") : t("想得起它的意思吗")}
        </span>
      </div>
      {reveal ? (
        <>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => answer(false)}>
            {t("没记住")}
          </button>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => answer(true)}>
            {t("记得")}
          </button>
        </>
      ) : (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setReveal(true)}>
          {t("看释义")}
        </button>
      )}
    </div>
  );
}

// ---------- 专注布局：下节课、杂念箱 ----------

export function NextClassCard() {
  useLang();
  const [settings] = useSettings();
  const now = useNow();
  const { courses } = usePlanner();
  const { current, next } = nowAndNext(courses, now);
  const minute = minuteOfDay(now);

  if (current) {
    const total = current.end - current.start;
    const done = minute - current.start;
    return (
      <section className="focus-card glass" aria-label={t("正在上的课")}>
        <div className="focus-card__label">{t("正在上")}</div>
        <div className="focus-card__row">
          <span className="focus-card__title">{current.course.title}</span>
          <span className="focus-card__time">{fmtMinute(current.end)}</span>
        </div>
        <div className="meter" aria-hidden="true">
          <div className="meter__fill" style={{ width: `${(done / total) * 100}%` }} />
        </div>
        <p className="focus-card__note">{t("{d}后下课", { d: minutesText(current.end - minute, t) })}</p>
      </section>
    );
  }
  if (!next) {
    return (
      <section className="focus-card glass" aria-label={t("下节课")}>
        <div className="focus-card__label">{t("下节课")}</div>
        <p className="focus-card__note">{courses.length === 0 ? t("还没有课表") : t("今天没有课了")}</p>
      </section>
    );
  }
  const until = next.start - minute;
  // 进度条：从提前两小时开始走，走满就该出发了
  const lookahead = 120;
  const fill = Math.max(0, Math.min(1, 1 - (until - settings.classLead) / lookahead));
  return (
    <section className="focus-card glass" aria-label={t("下节课")}>
      <div className="focus-card__label">{t("下节课")}</div>
      <div className="focus-card__row">
        <span className="focus-card__title">{next.course.title}</span>
        <span className="focus-card__time">{fmtMinute(next.start)}</span>
      </div>
      <div className="meter" aria-hidden="true">
        <div className="meter__fill" style={{ width: `${fill * 100}%` }} />
      </div>
      <p className="focus-card__note">
        {t("还有 {d}", { d: minutesText(until, t) })}
        {next.course.place ? ` · ${next.course.place}` : ""}
      </p>
    </section>
  );
}

export function InboxCard() {
  useLang();
  const [settings] = useSettings();
  const { notes } = usePlanner();
  const error = usePlannerError();
  const [text, setText] = useState("");
  const recent = notes.slice(-3).reverse();
  const keys = accelKeys(settings.shortcuts.capture);

  const add = async () => {
    if (!text.trim()) return;
    if (await planner.addNote(text)) setText("");
  };

  return (
    <section className="focus-card focus-card--inbox glass glass--thick" aria-label={t("杂念箱")}>
      <div className="focus-card__row">
        <h2 className="focus-card__heading">{t("杂念箱")}</h2>
        <span className="focus-card__note">
          {notes.length > 0 ? t("{n} 条，专注完到复盘里处理", { n: notes.length }) : t("想到别的事，先记在这里")}
        </span>
      </div>
      {recent.length > 0 ? (
        <ul className="inbox__list">
          {recent.map((note) => (
            <li key={note.id} className="inbox__item">
              {note.text}
            </li>
          ))}
        </ul>
      ) : null}
      <label className="inbox__add">
        <input
          className="inbox__input"
          value={text}
          maxLength={200}
          placeholder={t("记一条，回车保存")}
          aria-label={t("记一条杂念")}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setText(event.target.value)}
          onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
            if (imeBusy(event)) return;
            if (event.key === "Enter") void add();
          }}
        />
        {keys.length > 0 ? (
          <span className="inbox__keys" title={t("在任何程序里按这个组合也能记")}>
            {keys.map((key) => (
              <span key={key} className="kbd">
                {key}
              </span>
            ))}
          </span>
        ) : null}
      </label>
      {error ? <div className="inbox__error">{tMsg(error)}</div> : null}
    </section>
  );
}
