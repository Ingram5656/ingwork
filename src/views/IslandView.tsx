// Mac 的刘海番茄（灵动岛）：一块纯黑的形状贴着刘海，和刘海连成一片。
// 收起：计时进行中时两边各伸出一点，左边进度环、右边剩余时间；没开始计时时只剩刘海本身，看不出来。
// 展开（鼠标移上去，或者一段刚结束时自己探出来几秒）：当前任务、剩余时间、开始 / 暂停、跳过、打开主窗口，
// 下面一行是正在上或下一节的课。
// 鼠标在不在上面由后端查（收起时窗口是穿透的，页面收不到鼠标），通过 island-hover 事件告诉这里。

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { PHASE_NAMES, TimeDigits } from "../components/Clock";
import { IconOpen, IconPause, IconPlay, IconSkip } from "../components/Icons";
import { t, useLang } from "../lib/i18n";
import { useNow } from "../lib/now";
import { initPlanner, usePlanner } from "../lib/planner";
import { fmtMinute, minuteOfDay, minutesText, nowAndNext } from "../lib/schedule";
import { initSettingsSync, useSettings } from "../lib/settings";
import { initStats, pomodorosToday, useStats } from "../lib/stats";
import { currentTask, initTasks, useTasks } from "../lib/tasks";
import { call, nextFrame, onEvent } from "../lib/tauri";
import { useLook } from "../lib/theme";
import { initTimer, timer, useCountdown, useTimer } from "../lib/timer";

/** 后端量好的刘海和窗口大小（点 = CSS 像素），见 island.rs 的 Geometry */
interface Geometry {
  hasNotch: boolean;
  notchW: number;
  notchH: number;
  wing: number;
  width: number;
  height: number;
  shoulder: number;
}

/** 后端还没量好时先按 MacBook Air 的刘海画，不会露出来 */
const FALLBACK: Geometry = {
  hasNotch: true,
  notchW: 185,
  notchH: 32,
  wing: 76,
  width: 469,
  height: 148,
  shoulder: 12,
};

/** 进度环分多少档 */
const RING_STEPS = 120;
/** 一段结束时自己探出来多久 */
const PEEK_MS = 4500;

function Ring({ size, stroke, progress }: { size: number; stroke: number; progress: number }) {
  const r = (size - stroke) / 2;
  const length = 2 * Math.PI * r;
  return (
    <svg className="island__ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--c1)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={length}
        strokeDashoffset={length * (1 - progress)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

/** 正在上 / 下一节的课，一行字。没有课表就不显示 */
function ClassLine() {
  const now = useNow();
  const { courses } = usePlanner();
  if (courses.length === 0) return null;
  const { current, next } = nowAndNext(courses, now);
  const minute = minuteOfDay(now);
  if (current) {
    return (
      <span className="island__class">
        <b>{current.course.title}</b>
        <span>{t("{d}后下课", { d: minutesText(current.end - minute, t) })}</span>
      </span>
    );
  }
  if (!next) return <span className="island__class">{t("今天没有课了")}</span>;
  return (
    <span className="island__class">
      <span>{t("下节课")}</span>
      <b>{next.course.title}</b>
      <span>{fmtMinute(next.start)}</span>
    </span>
  );
}

export function IslandView() {
  useLang();
  const state = useTimer();
  const view = useCountdown(RING_STEPS);
  const task = currentTask(useTasks());
  const todayCount = pomodorosToday(useStats().records);
  const [geometry, setGeometry] = useState<Geometry>(FALLBACK);
  const [hover, setHover] = useState(false);
  const [peek, setPeek] = useState(false);
  const phase = useRef(state.phase);
  /** 刚打开时计时器的状态还在从后端同步，那时阶段变了不算"一段结束" */
  const openedAt = useRef(performance.now());
  useLook(state.phase);

  useEffect(() => {
    initSettingsSync();
    initTimer();
    initTasks();
    initStats();
    initPlanner();
    const offGeometry = onEvent<Geometry>("island-geometry", setGeometry);
    const offHover = onEvent<boolean>("island-hover", setHover);
    invoke<Geometry | null>("island_geometry")
      .then((g) => {
        if (g) setGeometry(g);
      })
      .catch(() => {});
    // 等字体加载好、画出第一帧再让后端显示，免得先闪一下没排好的样子
    let alive = true;
    void document.fonts.ready
      .then(nextFrame)
      .then(() => {
        if (alive) call("island_ready");
      });
    return () => {
      alive = false;
      offGeometry();
      offHover();
    };
  }, []);

  // 一段结束、换到下一段时，自己探出来几秒，说一声接下来是什么
  useEffect(() => {
    if (phase.current === state.phase) return;
    phase.current = state.phase;
    if (performance.now() - openedAt.current < 2000) return;
    setPeek(true);
    const id = window.setTimeout(() => setPeek(false), PEEK_MS);
    return () => window.clearTimeout(id);
  }, [state.phase]);

  // 计时开始了才伸出两边；没开始时只剩刘海本身。后端按这个决定鼠标要摸到哪里才展开
  const wings = state.started || !geometry.hasNotch;
  useEffect(() => {
    call("island_wings", { shown: wings });
  }, [wings]);

  // 展开那一下触控板震不震
  const [settings] = useSettings();
  useEffect(() => {
    call("island_haptics", { on: settings.islandHaptics });
  }, [settings.islandHaptics]);

  const open = hover || peek;
  const phaseName = t(PHASE_NAMES[state.phase]);
  // 自己探出来时说接下来是哪一段；平时显示当前任务，没有就显示阶段
  const label = peek && !hover ? t("接下来：{phase}", { phase: phaseName }) : (task?.name ?? phaseName);
  const progress = view.lit / RING_STEPS;

  let toggleLabel = t("开始");
  if (state.running) toggleLabel = t("暂停");
  else if (state.started) toggleLabel = t("继续");

  const classes = ["island"];
  if (open) classes.push("is-open");
  if (wings) classes.push("has-wings");
  if (!geometry.hasNotch) classes.push("is-pill");
  if (state.started && !state.running) classes.push("is-paused");

  const style = {
    "--notch-w": `${geometry.notchW}px`,
    "--notch-h": `${geometry.notchH}px`,
    "--wing": `${geometry.wing}px`,
    "--panel-w": `${geometry.width - geometry.shoulder * 2}px`,
    "--panel-h": `${geometry.height}px`,
  } as CSSProperties;

  return (
    <div className={classes.join(" ")} style={style}>
      <div className="island__shape">
        <i className="island__shoulder island__shoulder--l" aria-hidden="true" />
        <i className="island__shoulder island__shoulder--r" aria-hidden="true" />

        {/* 收起时：刘海左右两边 */}
        <div className="island__wing island__wing--l" aria-hidden={open}>
          <Ring size={18} stroke={3} progress={progress} />
        </div>
        <div className="island__wing island__wing--r" aria-hidden={open}>
          <TimeDigits secs={view.secs} className="island__mini-time" />
        </div>

        {/* 展开后 */}
        <div className="island__body" aria-hidden={!open}>
          <div className="island__main">
            <Ring size={44} stroke={5} progress={progress} />
            <div className="island__text">
              <span className="island__label">{label}</span>
              <TimeDigits secs={view.secs} className="island__time" />
            </div>
            <div className="island__tools">
              <button
                type="button"
                className="island__btn island__btn--main"
                title={toggleLabel}
                aria-label={toggleLabel}
                onClick={timer.toggle}
              >
                {state.running ? <IconPause /> : <IconPlay />}
              </button>
              <button
                type="button"
                className="island__btn"
                title={t("跳过这一段")}
                aria-label={t("跳过这一段")}
                onClick={timer.skip}
              >
                <IconSkip />
              </button>
              <button
                type="button"
                className="island__btn"
                title={t("打开主窗口")}
                aria-label={t("打开主窗口")}
                onClick={() => call("open_main")}
              >
                <IconOpen />
              </button>
            </div>
          </div>
          <div className="island__foot">
            <ClassLine />
            <span className="island__today">{t("今天 {n} 个番茄", { n: todayCount })}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
