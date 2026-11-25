// 复盘页：今天专注了多久、做了什么、预计和实际差多少；杂念箱在这里整理；生词本也放在这里。
// 历史上每一天的专注记录还是看原来的统计面板（"按周看"）。

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { SheetSpec } from "../components/Sheet";
import { t, useLang } from "../lib/i18n";
import { useNow } from "../lib/now";
import { planner, usePlanner, type Word } from "../lib/planner";
import {
  classesOn,
  fmtMinute,
  gapsBetween,
  minutesText,
  nextSchoolDay,
  pomodorosIn,
} from "../lib/schedule";
import { useSettings } from "../lib/settings";
import { byDay, dayKey, formatDuration, useStats } from "../lib/stats";
import { useTasks, type Task } from "../lib/tasks";
import { dateTitle } from "../components/Timeline";

/** 番茄数不超过这么多时画成小圆点 */
const DOTS_MAX = 10;
/** 生词本里记熟了的标准：连续这么多次都记得 */
const KNOWN = 5;

function EstimateRow({ task }: { task: Task }) {
  const diff = task.spent - task.estimate;
  let note = t("刚好");
  let tone = "";
  if (diff > 0) {
    note = t("多用 {n} 个", { n: diff });
    tone = "is-over";
  } else if (diff < 0) {
    note = task.finished ? t("少用 {n} 个", { n: -diff }) : t("还差 {n} 个", { n: -diff });
  }
  const total = Math.max(task.spent, task.estimate);
  return (
    <li className="est">
      <span className={task.finished ? "est__name is-finished" : "est__name"}>{task.name}</span>
      {total <= DOTS_MAX ? (
        <span
          className="est__dots"
          role="img"
          aria-label={t("预计 {e} 个，实际 {s} 个", { e: task.estimate, s: task.spent })}
        >
          {Array.from({ length: total }, (_, i) => {
            let cls = "est__dot";
            if (i < Math.min(task.spent, task.estimate)) cls += " is-done";
            else if (i >= task.estimate) cls += " is-extra";
            return <span key={i} className={cls} />;
          })}
        </span>
      ) : (
        <span className="est__text">
          {task.spent} / {task.estimate}
        </span>
      )}
      <span className={`est__note ${tone}`}>{note}</span>
    </li>
  );
}

function WordRow({ word }: { word: Word }) {
  return (
    <li className="wordrow">
      <span className="wordrow__word">{word.word}</span>
      <span className="wordrow__meaning">{word.meaning}</span>
      {word.known >= KNOWN ? <span className="entry__tag">{t("记熟了")}</span> : null}
      <button
        type="button"
        className="btn btn--ghost btn--sm wordrow__remove"
        aria-label={t("从生词本里删掉「{name}」", { name: word.word })}
        onClick={() => void planner.remove(word.id)}
      >
        {t("删掉")}
      </button>
    </li>
  );
}

interface Props {
  onOpenHistory: () => void;
  confirm: (spec: SheetSpec) => void;
  closeConfirm: () => void;
}

export function ReviewPage({ onOpenHistory, confirm, closeConfirm }: Props) {
  const lang = useLang();
  const [settings] = useSettings();
  const now = useNow();
  const { records } = useStats();
  const tasks = useTasks();
  const plan = usePlanner();

  // ---------- 今天 ----------
  const today = byDay(records).get(dayKey(now)) ?? { ms: 0, pomodoros: 0, records: [] };
  const stopped = today.records.filter((r) => !r.done).length;
  const classes = classesOn(plan.courses, now);
  const classMin = classes.reduce((sum, c) => sum + (c.end - c.start), 0);

  const open = tasks.tasks.filter((task) => !task.finished);
  const leftPomos = open.reduce((sum, task) => sum + Math.max(0, task.estimate - task.spent), 0);

  // 按任务分的专注时间
  const byTask = new Map<string, number>();
  for (const record of today.records) {
    const name = record.task ?? t("没有选待办");
    byTask.set(name, (byTask.get(name) ?? 0) + record.ms);
  }
  const spread = [...byTask.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const most = spread[0]?.[1] ?? 1;

  // 预计和实际：动过的待办
  const touched = tasks.tasks.filter((task) => task.spent > 0).slice(0, 8);
  const finished = tasks.tasks.filter((task) => task.finished && task.spent > 0);
  let insight = "";
  if (finished.length >= 3) {
    const spent = finished.reduce((sum, task) => sum + task.spent, 0);
    const estimate = finished.reduce((sum, task) => sum + task.estimate, 0);
    const ratio = Math.round(((spent - estimate) / Math.max(1, estimate)) * 100);
    if (ratio >= 10) insight = t("做完的待办平均比预计多用 {n}%，下次估的时候可以多留一点。", { n: ratio });
    else if (ratio <= -10) insight = t("做完的待办平均比预计少用 {n}%。", { n: -ratio });
    else insight = t("做完的待办和预计差不多，估得挺准。");
  }

  // ---------- 明天 ----------
  const next = nextSchoolDay(plan.courses, now);
  let tomorrow = "";
  if (next) {
    const first = next.classes[0];
    const day = dateTitle(next.date, lang);
    tomorrow = t("下一个有课的日子是 {day}，第一节是 {time} 的{title}", {
      day,
      time: fmtMinute(first.start),
      title: first.course.title,
    });
    const morning = gapsBetween(next.classes, 8 * 60, first.start)[0];
    const n = morning ? pomodorosIn(morning, settings.focusMin, settings.shortMin, settings.travelMin) : 0;
    if (n > 0) tomorrow += t("。上课前放得下 {n} 个番茄", { n });
    if (n > 0 && leftPomos > 0) tomorrow += t("，待办里还剩 {p} 个", { p: leftPomos });
  }

  // ---------- 杂念箱：删掉以后几秒内可以撤销 ----------
  // 点"删掉"先只是藏起来，过几秒才真删；这期间点"撤销"就放回来
  const [trashed, setTrashed] = useState<{ id: string; text: string } | null>(null);
  const trashTimer = useRef<number | null>(null);
  const flushTrash = (item: { id: string } | null) => {
    if (trashTimer.current !== null) window.clearTimeout(trashTimer.current);
    trashTimer.current = null;
    if (item) void planner.remove(item.id);
  };
  const trashedRef = useRef(trashed);
  trashedRef.current = trashed;
  const trash = (id: string, text: string) => {
    // 上一条还在等：先把它真删掉
    flushTrash(trashedRef.current);
    setTrashed({ id, text });
    trashTimer.current = window.setTimeout(() => {
      trashTimer.current = null;
      setTrashed(null);
      void planner.remove(id);
    }, 6000);
  };
  const undoTrash = () => {
    if (trashTimer.current !== null) window.clearTimeout(trashTimer.current);
    trashTimer.current = null;
    setTrashed(null);
  };
  // 离开这一页：还在等的那条照删
  useEffect(() => () => flushTrash(trashedRef.current), []);

  // ---------- 生词本 ----------
  const words = [...plan.words].sort((a, b) => b.addedAt - a.addedAt);
  const knownCount = words.filter((w) => w.known >= KNOWN).length;

  const askClearKnown = () =>
    confirm({
      title: t("删掉 {n} 个记熟的词？", { n: knownCount }),
      body: t("删掉以后休息时不会再出现。"),
      actions: [
        { label: t("留着"), onPick: closeConfirm },
        {
          label: t("删掉记熟的"),
          primary: true,
          onPick: () => {
            closeConfirm();
            const ids = words.filter((w) => w.known >= KNOWN).map((w) => w.id);
            void ids.reduce<Promise<unknown>>((p, id) => p.then(() => planner.remove(id)), Promise.resolve());
          },
        },
      ],
    });

  return (
    <div className="page page--review">
      <div className="rv__head">
        <h2 className="rv__title">{t("复盘")}</h2>
        <span className="rv__date">{dateTitle(now, lang)}</span>
      </div>

      <div className="tiles rv__tiles">
        <div className="tile glass glass--thick">
          <div className="tile__label">{t("今天专注")}</div>
          <div className="tile__value">{formatDuration(today.ms)}</div>
          <div className="tile__sub">
            {t("{n} 个番茄", { n: today.pomodoros })}
            {stopped > 0 ? t("，中途停下 {n} 次", { n: stopped }) : ""}
          </div>
          <button type="button" className="tile__more" onClick={onOpenHistory}>
            {t("按周看专注记录")}
          </button>
        </div>
        <div className="tile glass glass--thick">
          <div className="tile__label">{t("待办")}</div>
          <div className="tile__value">{t("还剩 {n} 件", { n: open.length })}</div>
          <div className="tile__sub">{t("预计还要 {n} 个番茄", { n: leftPomos })}</div>
        </div>
        <div className="tile glass glass--thick">
          <div className="tile__label">{t("今天上课")}</div>
          <div className="tile__value">{classMin > 0 ? minutesText(classMin, t) : t("没有课")}</div>
          <div className="tile__sub">{t("{n} 节", { n: classes.length })}</div>
        </div>
      </div>

      <div className="rv__grid">
        <section className="rv__card glass glass--thick" aria-label={t("预计和实际")}>
          <h3 className="rv__heading">{t("预计和实际")}</h3>
          {touched.length === 0 ? (
            <p className="rv__empty">{t("选一个待办再开始专注，这里就能看到每件事实际用了几个番茄。")}</p>
          ) : (
            <ul className="est__list">
              {touched.map((task) => (
                <EstimateRow key={task.id} task={task} />
              ))}
            </ul>
          )}
          {insight ? <p className="rv__insight">{insight}</p> : null}

          <h3 className="rv__heading rv__heading--gap">{t("今天的专注花在哪")}</h3>
          {spread.length === 0 ? (
            <p className="rv__empty">{t("今天还没有专注记录。")}</p>
          ) : (
            <ul className="bars">
              {spread.map(([name, ms]) => (
                <li key={name} className="bars__row">
                  <span className="bars__name">{name}</span>
                  <span className="bars__track" aria-hidden="true">
                    <span className="bars__fill" style={{ width: `${(ms / most) * 100}%` } as CSSProperties} />
                  </span>
                  <span className="bars__value">{formatDuration(ms)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rv__card glass glass--thick" aria-label={t("杂念箱")}>
          <div className="rv__cardhead">
            <h3 className="rv__heading">{t("杂念箱")}</h3>
            <span className="rv__count">{plan.notes.length > 0 ? t("{n} 条待整理", { n: plan.notes.length }) : ""}</span>
          </div>
          {trashed ? (
            <div className="notes__undo" role="status">
              <span className="notes__undotext">{t("删掉了“{text}”", { text: trashed.text })}</span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={undoTrash}>
                {t("撤销")}
              </button>
            </div>
          ) : null}
          {plan.notes.length === 0 ? (
            <p className="rv__empty">{t("专注时想到别的事，按快捷键记一句，回头在这里转成待办或删掉。")}</p>
          ) : (
            <ul className="notes">
              {[...plan.notes]
                .reverse()
                .filter((note) => note.id !== trashed?.id)
                .map((note) => (
                <li key={note.id} className="notes__item">
                  <span className="notes__text">{note.text}</span>
                  <span className="notes__time">{fmtMinute(new Date(note.at).getHours() * 60 + new Date(note.at).getMinutes())}</span>
                  <span className="notes__actions">
                    <button type="button" className="btn btn--primary btn--sm" onClick={() => void planner.noteToTask(note.id)}>
                      {t("转为待办")}
                    </button>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => trash(note.id, note.text)}>
                      {t("删掉")}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rv__card glass glass--thick" aria-label={t("生词本")}>
          <div className="rv__cardhead">
            <h3 className="rv__heading">{t("生词本")}</h3>
            <span className="rv__count">
              {words.length > 0 ? t("{n} 个词，{k} 个记熟了", { n: words.length, k: knownCount }) : ""}
            </span>
          </div>
          {words.length === 0 ? (
            <p className="rv__empty">{t("在翻译小窗里查单词时点「加入生词本」，休息的时候会拿出来复习。")}</p>
          ) : (
            <ul className="words">
              {words.slice(0, 30).map((word) => (
                <WordRow key={word.id} word={word} />
              ))}
            </ul>
          )}
          {knownCount > 0 ? (
            <button type="button" className="btn btn--ghost btn--sm rv__clear" onClick={askClearKnown}>
              {t("删掉记熟的")}
            </button>
          ) : null}
        </section>
      </div>

      {tomorrow ? (
        <div className="rv__tomorrow glass capsule">
          <span>{tomorrow}</span>
        </div>
      ) : null}
    </div>
  );
}
