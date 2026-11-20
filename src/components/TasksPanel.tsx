// 任务面板：待办清单，每个任务有预计番茄数。
// 点一个任务把它设成"当前任务"，之后每走完一段专注，后端自动给它加一个番茄。
// 只做清单这一件事：没有项目、标签、子任务。截止日期单独放在 Deadlines 里。
// 在"今天"这一页它常驻在右边（docked）；专注布局收起两边时，点当前任务名会把它作为侧边面板叫出来。

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { t, tMsg, useLang } from "../lib/i18n";
import {
  MAX_ESTIMATE,
  clearTaskError,
  tasks,
  useTaskError,
  useTasks,
  type Task,
} from "../lib/tasks";
import {
  IconCheck,
  IconClose,
  IconGrip,
  IconMinus,
  IconPencil,
  IconPlus,
  IconTrash,
} from "./Icons";
import type { SheetSpec } from "./Sheet";

/** 一行任务的高度加行距（舞台上的像素），拖动排序时用它算挪到了第几行 */
const ROW_PITCH = 58;
/** 番茄数不超过这么多时画成小圆点，再多就写成"3 / 12" */
const DOTS_MAX = 6;

function Stepper({
  value,
  label,
  onChange,
}: {
  value: number;
  label: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="stepper" role="group" aria-label={label} title={label}>
      <button
        type="button"
        className="stepper__btn"
        aria-label={t("少一个番茄")}
        disabled={value <= 1}
        onClick={() => onChange(value - 1)}
      >
        <IconMinus />
      </button>
      <span className="stepper__value">{value}</span>
      <button
        type="button"
        className="stepper__btn"
        aria-label={t("多一个番茄")}
        disabled={value >= MAX_ESTIMATE}
        onClick={() => onChange(value + 1)}
      >
        <IconPlus />
      </button>
    </div>
  );
}

/** 已完成 / 预计的番茄数 */
function Pomodoros({ task }: { task: Task }) {
  const label = t("已完成 {spent} 个番茄，预计 {estimate} 个", {
    spent: task.spent,
    estimate: task.estimate,
  });
  if (task.estimate > DOTS_MAX || task.spent > task.estimate) {
    return (
      <span className="pomos pomos--text" title={label}>
        {task.spent} / {task.estimate}
      </span>
    );
  }
  return (
    <span className="pomos" title={label} aria-label={label}>
      {Array.from({ length: task.estimate }, (_, i) => (
        <span key={i} className={i < task.spent ? "pomos__dot is-done" : "pomos__dot"} />
      ))}
    </span>
  );
}

function EditRow({ task, onDone }: { task: Task; onDone: () => void }) {
  const [name, setName] = useState(task.name);
  const [estimate, setEstimate] = useState(task.estimate);

  const save = async () => {
    if (await tasks.edit(task.id, name, estimate)) onDone();
  };

  return (
    <div className="task task--editing">
      <input
        className="field"
        value={name}
        maxLength={80}
        autoFocus
        aria-label={t("任务名")}
        onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)}
        onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
          if (event.key === "Enter") void save();
          if (event.key === "Escape") {
            // 只取消编辑，不让外面把整个面板关掉
            event.stopPropagation();
            clearTaskError();
            onDone();
          }
        }}
      />
      <Stepper value={estimate} label={t("预计番茄数")} onChange={setEstimate} />
      <button
        type="button"
        className="ibtn ibtn--sm"
        title={t("保存修改")}
        aria-label={t("保存修改")}
        onClick={() => void save()}
      >
        <IconCheck />
      </button>
    </div>
  );
}

interface Props {
  /** 常驻在"今天"页右边一栏时为真：没有关闭按钮 */
  docked?: boolean;
  onClose?: () => void;
  /** 删除、清空前要再确认一次，对话框由主界面显示 */
  confirm: (spec: SheetSpec) => void;
  closeConfirm: () => void;
}

export function TasksPanel({ docked, onClose, confirm, closeConfirm }: Props) {
  useLang();
  const store = useTasks();
  const error = useTaskError();
  const [name, setName] = useState("");
  const [estimate, setEstimate] = useState(1);
  const [editing, setEditing] = useState<string | null>(null);
  // 正在拖的那一行：从第几行拖起、竖直方向拖了多远（舞台上的像素）
  const [drag, setDrag] = useState<{ id: string; from: number; dy: number } | null>(null);
  // 松手后的一帧里不要过渡，不然各行会从让位的地方再"弹"一次
  const [settling, setSettling] = useState(false);
  const dragStart = useRef({ y: 0, scale: 1 });

  const open = store.tasks.filter((task) => !task.finished);
  const done = store.tasks.filter((task) => task.finished);
  const left = open.reduce((sum, task) => sum + Math.max(0, task.estimate - task.spent), 0);

  useEffect(() => clearTaskError, []);

  useEffect(() => {
    if (!settling) return;
    const id = requestAnimationFrame(() => setSettling(false));
    return () => cancelAnimationFrame(id);
  }, [settling]);

  const add = async () => {
    if (await tasks.add(name, estimate)) {
      setName("");
      setEstimate(1);
    }
  };

  // ---------- 拖动排序 ----------

  const target = drag
    ? Math.max(0, Math.min(open.length - 1, Math.round(drag.from + drag.dy / ROW_PITCH)))
    : -1;

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>, id: string, index: number) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // 舞台是整体缩放的，鼠标挪的距离要换算回舞台上的像素
    const scale =
      Number(getComputedStyle(document.documentElement).getPropertyValue("--stage-scale")) || 1;
    dragStart.current = { y: event.clientY, scale };
    setEditing(null);
    setDrag({ id, from: index, dy: 0 });
  };

  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    const dy = (event.clientY - dragStart.current.y) / dragStart.current.scale;
    setDrag({ ...drag, dy });
  };

  const endDrag = () => {
    if (!drag) return;
    if (target !== drag.from) {
      const ids = open.map((task) => task.id);
      const [moved] = ids.splice(drag.from, 1);
      ids.splice(target, 0, moved);
      void tasks.reorder(ids);
    }
    setSettling(true);
    setDrag(null);
  };

  const rowStyle = (id: string, index: number): CSSProperties | undefined => {
    if (!drag) return undefined;
    if (id === drag.id) return { transform: `translateY(${drag.dy}px) scale(1.03)` };
    // 其他行给它让位
    if (drag.from < index && index <= target) return { transform: `translateY(${-ROW_PITCH}px)` };
    if (target <= index && index < drag.from) return { transform: `translateY(${ROW_PITCH}px)` };
    return undefined;
  };

  // ---------- 删除、清空 ----------

  const askRemove = (task: Task) =>
    confirm({
      title: t("删除「{name}」？", { name: task.name }),
      body: t("它已经记下的番茄数也会一起删掉。"),
      actions: [
        { label: t("留着"), onPick: closeConfirm },
        {
          label: t("删除任务"),
          primary: true,
          onPick: () => {
            closeConfirm();
            void tasks.remove(task.id);
          },
        },
      ],
    });

  const askClear = () =>
    confirm({
      title: t("清空 {n} 个已完成的任务？", { n: done.length }),
      body: t("清空后找不回来。"),
      actions: [
        { label: t("留着"), onPick: closeConfirm },
        {
          label: t("清空已完成"),
          primary: true,
          onPick: () => {
            closeConfirm();
            void tasks.clearFinished();
          },
        },
      ],
    });

  const listClasses = ["tasks__list"];
  if (drag) listClasses.push("is-dragging");
  if (settling) listClasses.push("is-settling");

  return (
    <div
      className={docked ? "tasks tasks--docked glass glass--thick" : "tasks glass glass--thick"}
      role={docked ? "region" : "dialog"}
      aria-label={t("待办")}
    >
      <div className="tasks__head">
        <h2 className="tasks__title">{t("待办")}</h2>
        {docked ? null : (
          <button
            type="button"
            className="ibtn"
            title={t("关闭待办")}
            aria-label={t("关闭待办")}
            onClick={onClose}
          >
            <IconClose />
          </button>
        )}
      </div>

      <div className="tasks__add">
        <input
          className="field"
          value={name}
          maxLength={80}
          placeholder={t("要做什么")}
          aria-label={t("要做什么")}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)}
          onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
            if (event.key === "Enter") void add();
          }}
        />
        <Stepper value={estimate} label={t("预计番茄数")} onChange={setEstimate} />
        <button type="button" className="btn btn--primary btn--sm" onClick={() => void add()}>
          {t("添加")}
        </button>
      </div>
      {error ? <div className="tasks__error">{tMsg(error)}</div> : null}

      <div className={listClasses.join(" ")}>
        {store.tasks.length === 0 ? (
          <div className="tasks__empty">{t("还没有待办。在上面写下要做的事，再选预计要几个番茄；点一下它，下一段专注就记在它上面。")}</div>
        ) : null}

        {open.map((task, index) =>
          editing === task.id ? (
            <EditRow key={task.id} task={task} onDone={() => setEditing(null)} />
          ) : (
            <div
              key={task.id}
              className={[
                "task",
                task.id === store.current ? "is-current" : "",
                drag?.id === task.id ? "is-dragged" : "",
              ].join(" ")}
              style={rowStyle(task.id, index)}
            >
              <button
                type="button"
                className="task__grip"
                title={t("按住拖动来排序")}
                aria-label={t("按住拖动来排序")}
                onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) =>
                  startDrag(event, task.id, index)
                }
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <IconGrip />
              </button>
              <button
                type="button"
                className="task__check"
                title={t("标记为完成")}
                aria-label={t("把「{name}」标记为完成", { name: task.name })}
                onClick={() => void tasks.setFinished(task.id, true)}
              />
              <button
                type="button"
                className="task__main"
                title={task.id === store.current ? t("当前任务") : t("设为当前任务")}
                aria-pressed={task.id === store.current}
                onClick={() => void tasks.setCurrent(task.id === store.current ? null : task.id)}
              >
                <span className="task__name">{task.name}</span>
                <Pomodoros task={task} />
              </button>
              <div className="task__actions">
                <button
                  type="button"
                  className="ibtn ibtn--sm"
                  title={t("改名字或番茄数")}
                  aria-label={t("修改「{name}」", { name: task.name })}
                  onClick={() => setEditing(task.id)}
                >
                  <IconPencil />
                </button>
                <button
                  type="button"
                  className="ibtn ibtn--sm"
                  title={t("删除任务")}
                  aria-label={t("删除「{name}」", { name: task.name })}
                  onClick={() => askRemove(task)}
                >
                  <IconTrash />
                </button>
              </div>
            </div>
          ),
        )}

        {done.length > 0 ? <div className="tasks__divider">{t("已完成")}</div> : null}
        {done.map((task) => (
          <div key={task.id} className="task is-finished">
            <button
              type="button"
              className="task__check is-checked"
              title={t("取消完成")}
              aria-label={t("把「{name}」改回未完成", { name: task.name })}
              onClick={() => void tasks.setFinished(task.id, false)}
            >
              <IconCheck />
            </button>
            <div className="task__main">
              <span className="task__name">{task.name}</span>
              <Pomodoros task={task} />
            </div>
            <div className="task__actions">
              <button
                type="button"
                className="ibtn ibtn--sm"
                title={t("删除任务")}
                aria-label={t("删除「{name}」", { name: task.name })}
                onClick={() => askRemove(task)}
              >
                <IconTrash />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="tasks__foot">
        <span className="tasks__left">
          {open.length > 0 ? t("还要 {n} 个番茄", { n: left }) : ""}
        </span>
        {done.length > 0 ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={askClear}>
            {t("清空已完成")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
