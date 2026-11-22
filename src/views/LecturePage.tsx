// "听课"页：左边是实时翻译，右边是整理出来的笔记。
//
// 左边：没开始时选要听哪节课；开始以后顶上是课名、听了多久、暂停和结束，
// 下面一条音量带（最近几秒的声音，停顿的地方就是切段的地方），再下面一段一段的英文原文和中文翻译往下滚。
// 右边：听课中每 5 分钟左右更新一次提纲；结束后完整整理。没在听的时候列着以前的笔记。

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { IconCheck } from "../components/Icons";
import { SlidesBar } from "../components/SlidesBar";
import { t, tMsg, useLang } from "../lib/i18n";
import {
  costText,
  lecture,
  listenedNow,
  notesMarkdown,
  useLecture,
  useLectureHistory,
  useLevels,
  type LectureNotes,
  type LectureState,
} from "../lib/lecture";
import { useNow } from "../lib/now";
import { planner, usePlanner } from "../lib/planner";
import { classesOn, fmtMinute, minuteOfDay } from "../lib/schedule";
import { useSettings } from "../lib/settings";

interface Props {
  /** 打开设置里"听课"那一页（填密钥、看申请教程） */
  openSettings: () => void;
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function minutesOf(ms: number): number {
  return Math.max(0, Math.floor(ms / 60_000));
}

export function LecturePage({ openSettings }: Props) {
  useLang();
  const s = useLecture();
  const active = s.status !== "idle";
  return (
    <div className="page page--lecture">
      <section className="lec-live glass glass--thick" aria-label={t("实时翻译")}>
        {active ? <Live s={s} /> : <Starter openSettings={openSettings} />}
      </section>
      <section className="lec-notes glass glass--thick" aria-label={t("笔记")}>
        <Notes s={s} />
      </section>
    </div>
  );
}

// ---------- 左边：开始之前 ----------

function Starter({ openSettings }: Props) {
  const [settings] = useSettings();
  const { courses } = usePlanner();
  const now = useNow();
  const minute = minuteOfDay(now);
  const today = classesOn(courses, now).filter((c) => c.end > minute - 10);
  const current = today.find((c) => c.start - 10 <= minute && minute < c.end) ?? null;
  const [picked, setPicked] = useState<string | null>(current ? current.course.id : null);
  const [other, setOther] = useState("");
  // 课表是后读进来的：读进来时正在上课，就先选上这节；用户自己点过、写过就不再动
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current && picked === null && current) setPicked(current.course.id);
  }, [current, picked]);
  const hasKey = settings.lectureKey.trim().length > 0;

  const chosen = today.find((c) => c.course.id === picked) ?? null;
  const name = chosen ? chosen.course.title : other.trim();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const begin = async () => {
    setStarting(true);
    setError("");
    const failed = await lecture.start(name, chosen ? chosen.course.id : null);
    setStarting(false);
    if (failed) setError(tMsg(failed));
  };

  return (
    <div className="lec-start">
      <h2 className="lec-start__title">{t("要听哪节课")}</h2>
      {today.length > 0 ? (
        <div className="lec-start__list" role="radiogroup" aria-label={t("今天的课")}>
          {today.map((c) => {
            const on = picked === c.course.id;
            const live = c.start - 10 <= minute && minute < c.end;
            return (
              <button
                key={`${c.course.id}${c.start}`}
                type="button"
                role="radio"
                aria-checked={on}
                className={on ? "lec-class is-on" : "lec-class"}
                onClick={() => {
                  touched.current = true;
                  setPicked(on ? null : c.course.id);
                  setOther("");
                }}
              >
                <span className="lec-class__time">
                  {fmtMinute(c.start)}–{fmtMinute(c.end)}
                </span>
                <span className="lec-class__name">{c.course.title}</span>
                {live ? <span className="lec-class__now">{t("正在上")}</span> : null}
                {c.course.place ? <span className="lec-class__place">{c.course.place}</span> : null}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="lec-start__hint">{t("今天课表上没有课了，写一个名字也能开始。")}</p>
      )}
      <input
        className="field lec-start__other"
        placeholder={today.length > 0 ? t("别的课，写个名字") : t("课名")}
        value={other}
        maxLength={60}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          touched.current = true;
          setOther(event.target.value);
          if (event.target.value) setPicked(null);
        }}
      />

      {hasKey && name ? <SlidesBar course={name} courseId={chosen ? chosen.course.id : null} explain /> : null}

      {hasKey ? (
        <div className="lec-start__go">
          <button
            type="button"
            className="btn btn--primary lec-start__btn"
            disabled={!name || starting}
            onClick={() => void begin()}
          >
            {starting ? t("正在打开麦克风") : t("开始听课")}
          </button>
          {error ? <p className="row__error">{error}</p> : null}
          <p className="lec-start__note">
            {t("用麦克风听，英文一段一段听写下来、翻成中文。录音不留，只留文字。")}
          </p>
        </div>
      ) : (
        <div className="lec-start__key">
          <p>{t("听写、翻译和整理笔记都用 DeepSeek。先填一个 DeepSeek 密钥，申请只要几分钟。")}</p>
          <button type="button" className="btn btn--primary" onClick={openSettings}>
            {t("去填密钥")}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- 左边：听课中 ----------

/** 最近几秒的声音：竖条从左往右是从以前到现在，停顿的地方矮下去 */
function LevelBand({ quiet }: { quiet: boolean }) {
  const levels = useLevels();
  return (
    <div className={quiet ? "lec-band is-quiet" : "lec-band"} aria-hidden="true">
      {levels.map((v, i) => (
        <span key={i} style={{ transform: `scaleY(${quiet ? 0.06 : Math.max(0.06, v)})` }} />
      ))}
    </div>
  );
}

function Live({ s }: { s: LectureState }) {
  const now = useNow();
  const listRef = useRef<HTMLOListElement>(null);
  const [follow, setFollow] = useState(true);

  // 新的一段进来：在最底下就跟着往下滚；往上翻着看时不打扰，底下出一个"回到最新"
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [s.segments, s.pending, follow]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  const listening = s.status === "listening";
  const listened = minutesOf(listenedNow(s, now.getTime()));

  let sub = "";
  if (s.startedAt) sub = t("{time} 开始，听了 {n} 分钟", { time: clock(s.startedAt), n: listened });
  if (s.status === "paused") sub = t("暂停了，听了 {n} 分钟", { n: listened });
  if (s.status === "finishing") sub = t("录音停了，正在整理整节课");
  if (s.status === "done") sub = t("这节课听了 {n} 分钟", { n: listened });
  const cost = costText(s.usage);
  if (cost && s.status !== "finishing") sub += t("，大概花了 {cost}", { cost });

  return (
    <>
      <header className="lec-head">
        <div className="lec-head__text">
          <h2 className="lec-head__title" title={s.course}>
            {s.course}
          </h2>
          <p className="lec-head__sub">{sub}</p>
        </div>
        <div className="lec-head__actions">
          {s.status === "listening" ? (
            <button type="button" className="btn btn--ghost" onClick={lecture.pause}>
              {t("暂停")}
            </button>
          ) : null}
          {s.status === "paused" ? (
            <button type="button" className="btn btn--ghost" onClick={lecture.resume}>
              {t("继续")}
            </button>
          ) : null}
          {s.status === "listening" || s.status === "paused" ? (
            <button type="button" className="btn btn--primary" onClick={lecture.stop}>
              {t("下课，整理笔记")}
            </button>
          ) : null}
          {s.status === "done" ? (
            <button type="button" className="btn btn--ghost" onClick={lecture.close}>
              {t("听下一节")}
            </button>
          ) : null}
        </div>
      </header>

      {s.status === "listening" || s.status === "paused" ? (
        <>
          <SlidesBar course={s.course} courseId={s.courseId} />
          <LevelBand quiet={!listening} />
        </>
      ) : null}

      <ol className="lec-stream" ref={listRef} onScroll={onScroll} aria-live="polite">
        {s.segments.length === 0 && !s.pending ? (
          <li className="lec-stream__empty">{listening ? t("在听了。老师开口以后，几秒钟内第一段就会出来。") : null}</li>
        ) : null}
        {s.segments.map((seg, i) => {
          const last = i === s.segments.length - 1 && !s.pending;
          return (
            <li key={seg.id} className={last && listening ? "lec-seg is-latest" : "lec-seg"}>
              <time className="lec-seg__time">{clock(seg.at)}</time>
              <div className="lec-seg__body">
                <p className="lec-seg__en" lang="en">
                  {seg.en}
                </p>
                {seg.zh === null ? (
                  <p className="lec-seg__zh is-pending">{t("翻译中")}</p>
                ) : seg.zh === "" ? (
                  <p className="lec-seg__zh is-pending">{t("这一段没翻译出来")}</p>
                ) : (
                  <p className="lec-seg__zh">{seg.zh}</p>
                )}
              </div>
            </li>
          );
        })}
        {s.pending ? (
          <li className={listening ? "lec-seg is-latest" : "lec-seg"}>
            <time className="lec-seg__time">{clock(s.pending.at)}</time>
            <div className="lec-seg__body">
              <p className="lec-seg__en" lang="en">
                {s.pending.en}
              </p>
              <p className="lec-seg__zh is-pending">{t("等这句说完再翻译")}</p>
            </div>
          </li>
        ) : null}
      </ol>

      {!follow ? (
        <button
          type="button"
          className="lec-latest"
          onClick={() => {
            setFollow(true);
            const el = listRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          {t("回到最新")}
        </button>
      ) : null}

      <footer className="lec-foot">
        {listening ? (
          <span className="lec-foot__live">
            <span className="lec-dot" aria-hidden="true" />
            {t("正在听")}
          </span>
        ) : null}
        {s.quiet ? <span className="lec-foot__warn">{t("声音有点小，坐近一点或者换个麦克风")}</span> : null}
        {s.backlog > 0 ? <span>{t("有 {n} 段还没送出去，网好了会自动补上", { n: s.backlog })}</span> : null}
        {s.error ? <span className="lec-foot__error">{tMsg(s.error)}</span> : null}
      </footer>
    </>
  );
}

// ---------- 右边：笔记 ----------

function Notes({ s }: { s: LectureState }) {
  const [copied, setCopied] = useState(false);
  const active = s.status !== "idle";

  let status = "";
  if (s.summarizing) status = s.status === "finishing" ? t("正在从头整理整节课…") : t("正在更新提纲…");
  else if (s.status === "done" && s.notesAt) status = t("{time} 整理好", { time: clock(s.notesAt) });
  else if (s.notesAt && s.nextNotesAt) {
    status = t("{time} 更新过，下一次大约 {next}", { time: clock(s.notesAt), next: clock(s.nextNotesAt) });
  } else if (s.nextNotesAt) status = t("大约 {time} 出第一版提纲", { time: clock(s.nextNotesAt) });

  const copy = () => {
    void navigator.clipboard.writeText(notesMarkdown(s)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <>
      <header className="lec-nhead">
        <h2 className="lec-nhead__title">{active ? t("笔记") : t("以前的笔记")}</h2>
        {status ? (
          <p className={s.summarizing ? "lec-nhead__status is-busy" : "lec-nhead__status"}>{status}</p>
        ) : null}
        {s.status === "done" && s.notes && s.id ? (
          <div className="lec-nhead__actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={copy}>
              {copied ? t("已复制") : t("复制")}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void lecture.exportMarkdown(s)}>
              {t("导出")}
            </button>
          </div>
        ) : null}
      </header>
      <div className="lec-paper">
        {!active ? <History /> : null}
        {active && s.notes ? <NotesBody notes={s.notes} draft={s.status !== "done"} /> : null}
        {active && !s.notes ? (
          <p className="lec-paper__empty">
            {s.status === "finishing"
              ? t("正在整理，整节课大概要半分钟。")
              : t("听到 5 分钟左右，这里会出现第一版提纲；下课点“下课，整理笔记”再完整整理一遍。")}
          </p>
        ) : null}
        {s.status === "done" && !s.notes && !s.summarizing ? (
          <button type="button" className="btn btn--primary btn--sm" onClick={lecture.summarize}>
            {t("再整理一次")}
          </button>
        ) : null}
      </div>
    </>
  );
}

function NotesBody({ notes, draft }: { notes: LectureNotes; draft: boolean }) {
  const { words, deadlines } = usePlanner();
  const known = useMemo(() => new Set(words.map((w) => w.word.toLowerCase())), [words]);
  const dueTitles = useMemo(() => new Set(deadlines.map((d) => d.title)), [deadlines]);

  return (
    <article className={draft ? "lec-doc is-draft" : "lec-doc"}>
      {notes.summary ? <p className="lec-doc__summary">{notes.summary}</p> : null}

      {notes.outline.map((part) => (
        <section key={part.title} className="lec-doc__part">
          <h3>{part.title}</h3>
          <ul>
            {part.points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </section>
      ))}

      {notes.terms.length > 0 ? (
        <section className="lec-doc__part">
          <h3>{t("术语")}</h3>
          <dl className="lec-terms">
            {notes.terms.map((term) => {
              const added = known.has(term.en.toLowerCase());
              return (
                <div key={term.en} className="lec-term">
                  <dt lang="en">{term.en}</dt>
                  <dd>
                    {term.zh}
                    {term.note ? <span className="lec-term__note">{term.note}</span> : null}
                  </dd>
                  <button
                    type="button"
                    className={added ? "lec-add is-done" : "lec-add"}
                    disabled={added}
                    onClick={() => planner.addWord(term.en, term.zh)}
                  >
                    {added ? (
                      <>
                        <IconCheck />
                        {t("在生词本里")}
                      </>
                    ) : (
                      t("加进生词本")
                    )}
                  </button>
                </div>
              );
            })}
          </dl>
        </section>
      ) : null}

      {notes.dues.length > 0 ? (
        <section className="lec-doc__part">
          <h3>{t("作业和截止日期")}</h3>
          <ul className="lec-dues">
            {notes.dues.map((due) => (
              <Due key={due.title} due={due} added={dueTitles.has(due.title)} />
            ))}
          </ul>
        </section>
      ) : null}

      {notes.review.length > 0 ? (
        <section className="lec-doc__part">
          <h3>{t("回去复习")}</h3>
          <ul>
            {notes.review.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}

/** 一条作业：老师说了哪天就直接能加；没说哪天先选个日子 */
function Due({ due, added }: { due: LectureNotes["dues"][number]; added: boolean }) {
  const [date, setDate] = useState(due.date ?? "");
  useEffect(() => setDate(due.date ?? ""), [due.date]);
  return (
    <li className="lec-due">
      <div className="lec-due__text">
        <span className="lec-due__title">{due.title}</span>
        <q className="lec-due__quote" lang="en">
          {due.quote}
        </q>
      </div>
      <div className="lec-due__act">
        <input
          type="date"
          className="field field--date"
          value={date}
          aria-label={t("截止日期")}
          disabled={added}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setDate(event.target.value)}
        />
        <button
          type="button"
          className={added ? "lec-add is-done" : "lec-add"}
          disabled={added || !date}
          onClick={() => planner.addDeadline(due.title, date)}
        >
          {added ? (
            <>
              <IconCheck />
              {t("已加上")}
            </>
          ) : (
            t("加进截止日期")
          )}
        </button>
      </div>
    </li>
  );
}

function History() {
  const list = useLectureHistory();
  if (list.length === 0) {
    return <p className="lec-paper__empty">{t("听完一节课，整理好的笔记会存在这里，几台电脑同步。")}</p>;
  }
  return (
    <ul className="lec-history">
      {list.map((entry) => {
        const d = new Date(entry.startedAt);
        return (
          <li key={entry.id}>
            <button type="button" className="lec-history__item" onClick={() => lecture.open(entry.id)}>
              <span className="lec-history__date">
                {t("{m}月{d}日", { m: d.getMonth() + 1, d: d.getDate() })}
              </span>
              <span className="lec-history__course">{entry.course}</span>
              <span className="lec-history__summary">{entry.summary}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
