// 杂念箱小窗：专注时想到别的事，按快捷键呼出，写一句，回车记下就收起，不用切到主窗口。
// 记下的东西在主窗口"复盘"页里整理：转成待办，或者删掉。

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { IconInbox } from "../components/Icons";
import { t, tMsg, useLang } from "../lib/i18n";
import { initPlanner, planner, usePlanner, usePlannerError } from "../lib/planner";
import { fitPopup, onPixelRatioChange } from "../lib/popups";
import { initSettingsSync, useSettings } from "../lib/settings";
import { currentTask, initTasks, useTasks } from "../lib/tasks";
import { call, onEvent } from "../lib/tauri";
import { useLook } from "../lib/theme";
import { initTimer, useTimer } from "../lib/timer";

const LABEL = "capture";

export function CaptureView() {
  useLang();
  const [settings] = useSettings();
  const state = useTimer();
  const task = currentTask(useTasks());
  const { notes } = usePlanner();
  const error = usePlannerError();
  useLook(state.phase);

  const [text, setText] = useState("");
  const [phase, setPhase] = useState<"in" | "out" | "">("");
  const [saved, setSaved] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    initSettingsSync();
    initTimer();
    initTasks();
    initPlanner();
    document.documentElement.classList.add("is-popup");
    const frame = requestAnimationFrame(() => call("popup_ready", { label: LABEL }));
    return () => cancelAnimationFrame(frame);
  }, []);

  useLayoutEffect(() => {
    document.documentElement.style.setProperty("zoom", String(settings.popupScale || 1));
  }, [settings.popupScale]);

  // 窗口大小跟着页面走：内容变了、窗口被系统改了大小（换到缩放不一样的屏幕）都重新量一次
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const zoom = settings.popupScale || 1;
    const report = () => void fitPopup(LABEL, zoom);
    const observer = new ResizeObserver(report);
    observer.observe(el);
    window.addEventListener("resize", report);
    const offRatio = onPixelRatioChange(report);
    // 呼出时窗口可能换了屏幕，系统缩放跟着变要等一会儿：马上量一次，稍后再量一次
    let later = 0;
    const offSummoned = onEvent<unknown>(`${LABEL}-summoned`, () => {
      requestAnimationFrame(report);
      window.clearTimeout(later);
      later = window.setTimeout(report, 250);
    });
    report();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
      offRatio();
      offSummoned();
      window.clearTimeout(later);
    };
  }, [settings.popupScale]);

  useEffect(
    () =>
      onEvent<unknown>(`${LABEL}-summoned`, () => {
        setPhase("in");
        setSaved(false);
        window.setTimeout(() => field.current?.focus(), 30);
      }),
    [],
  );

  useEffect(() => onEvent<unknown>(`${LABEL}-dismiss`, () => setPhase("out")), []);

  const hide = () => call("popup_hide", { label: LABEL });

  const save = async () => {
    if (!text.trim()) {
      hide();
      return;
    }
    if (await planner.addNote(text)) {
      setText("");
      setSaved(true);
      window.setTimeout(hide, 420);
    }
  };

  const onKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void save();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      hide();
    }
  };

  let status = t("回车记下，Esc 收起");
  if (state.running && state.phase === "focus") {
    status = task ? t("专注中 · {name}，记下就回去", { name: task.name }) : t("专注中，记下就回去");
  }

  const classes = ["cap-panel"];
  if (phase === "in") classes.push("is-in");
  if (phase === "out") classes.push("is-out");

  return (
    <main ref={panel} className={classes.join(" ")}>
      <div className="tr-aura" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="cap-row" data-tauri-drag-region>
        <span className="cap-icon" aria-hidden="true">
          <IconInbox />
        </span>
        <input
          ref={field}
          className="cap-input"
          value={text}
          maxLength={200}
          placeholder={t("想到什么，先记在这里")}
          aria-label={t("记一条杂念")}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            setText(event.target.value);
            setSaved(false);
          }}
          onKeyDown={onKey}
        />
      </div>
      <div className="cap-foot">
        <span className={saved ? "cap-status is-saved" : "cap-status"}>
          {error ? tMsg(error) : saved ? t("记下了") : status}
        </span>
        <span className="cap-count">
          {notes.length > 0 ? t("杂念箱里有 {n} 条", { n: notes.length }) : ""}
        </span>
      </div>
    </main>
  );
}
