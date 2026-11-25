// 截止日期：考试、交作业。按日子排，三天以内的标出来。勾掉的不再显示。

import { useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { imeBusy } from "../lib/platform";
import { t, tMsg, useLang } from "../lib/i18n";
import { useNow } from "../lib/now";
import { clearPlannerError, planner, usePlanner, usePlannerError, type Deadline } from "../lib/planner";
import { daysUntil } from "../lib/schedule";
import { addDays, dayKey } from "../lib/stats";
import { IconTrash } from "./Icons";

/** 这么多天以内的算紧急 */
const URGENT_DAYS = 3;

function leftText(days: number): string {
  if (days < 0) return t("过了 {n} 天", { n: -days });
  if (days === 0) return t("今天");
  if (days === 1) return t("明天");
  return t("{n} 天", { n: days });
}

/** "11月26日" / "26 Nov" */
function shortDate(key: string, lang: string): string {
  const [, m, d] = key.split("-").map(Number);
  if (lang === "en") {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(2000, m - 1, d));
  }
  return `${m}月${d}日`;
}

function Row({ item, today }: { item: Deadline; today: Date }) {
  const lang = useLang();
  const days = daysUntil(item.due, today);
  const classes = ["dl__row"];
  if (days <= URGENT_DAYS) classes.push("is-urgent");
  return (
    <li className={classes.join(" ")}>
      <button
        type="button"
        className="task__check"
        title={t("标记为完成")}
        aria-label={t("把「{name}」标记为完成", { name: item.title })}
        onClick={() => void planner.setDeadlineDone(item.id, true)}
      />
      <div className="dl__main">
        <span className="dl__title">{item.title}</span>
        <span className="dl__date">{shortDate(item.due, lang)}</span>
      </div>
      <span className="dl__left">{leftText(days)}</span>
      <button
        type="button"
        className="ibtn ibtn--sm dl__remove"
        title={t("删除")}
        aria-label={t("删除「{name}」", { name: item.title })}
        onClick={() => void planner.remove(item.id)}
      >
        <IconTrash />
      </button>
    </li>
  );
}

export function Deadlines() {
  useLang();
  const now = useNow();
  const { deadlines } = usePlanner();
  const error = usePlannerError();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState(() => dayKey(addDays(new Date(), 7)));
  // 提前几天再提醒一次（前一天晚上和当天早上那两次照常）
  const [early, setEarly] = useState(0);

  const open = deadlines.filter((d) => !d.done).sort((a, b) => a.due.localeCompare(b.due));

  const add = async () => {
    if (await planner.addDeadline(title, due, early)) {
      setTitle("");
      setEarly(0);
      setAdding(false);
    }
  };

  const onKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (imeBusy(event)) return;
    if (event.key === "Enter") void add();
    if (event.key === "Escape") {
      event.stopPropagation();
      clearPlannerError();
      setAdding(false);
    }
  };

  return (
    <section className="dl" aria-label={t("截止日期")}>
      <div className="dl__head">
        <h2 className="dl__heading">{t("截止日期")}</h2>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-expanded={adding}
          onClick={() => {
            clearPlannerError();
            setAdding(!adding);
          }}
        >
          {adding ? t("不加了") : t("添加")}
        </button>
      </div>

      {adding ? (
        <div className="dl__add">
          <input
            className="field"
            value={title}
            maxLength={60}
            autoFocus
            placeholder={t("考试、作业")}
            aria-label={t("要截止的事")}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setTitle(event.target.value)}
            onKeyDown={onKey}
          />
          <input
            className="field field--date"
            type="date"
            value={due}
            aria-label={t("截止日期")}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setDue(event.target.value)}
            onKeyDown={onKey}
          />
        </div>
      ) : null}
      {adding ? (
        <div className="dl__add dl__add--more">
          <select
            className="field field--select dl__early"
            value={early}
            aria-label={t("提前提醒")}
            title={t("前一天晚上和当天早上都会提醒；这里可以再选早几天提醒一次")}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => setEarly(Number(event.target.value))}
          >
            <option value={0}>{t("不另外提前提醒")}</option>
            <option value={3}>{t("提前 3 天提醒")}</option>
            <option value={7}>{t("提前 7 天提醒")}</option>
            <option value={14}>{t("提前 14 天提醒")}</option>
          </select>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void add()}>
            {t("添加")}
          </button>
        </div>
      ) : null}
      {adding && error ? <div className="dl__error">{tMsg(error)}</div> : null}

      {open.length === 0 && !adding ? (
        <p className="dl__empty">{t("考试和作业的截止日期记在这里，临近时会标出来。")}</p>
      ) : (
        <ul className="dl__list">
          {open.map((item) => (
            <Row key={item.id} item={item} today={now} />
          ))}
        </ul>
      )}
    </section>
  );
}
