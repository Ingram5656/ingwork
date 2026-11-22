// 倒计时和外面的进度光圈。
// 这块每秒都在变，所以单独成一个组件，自己定时刷新，不带着整页重画。

import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { t, useLang } from "../lib/i18n";
import { haptic } from "../lib/haptics";
import { DURATIONS, getSettings, updateSettings, type Phase } from "../lib/settings";
import { currentTask, useTasks } from "../lib/tasks";
import { useCountdown, useSegmentMinutes, useTimer } from "../lib/timer";

/** 光圈一共多少根光条 */
const TICKS = 72;
/** 每根光条的亮度分几档，决定光圈多久重画一次 */
const STEPS = 4;

export const PHASE_NAMES: Record<Phase, string> = {
  focus: "专注",
  shortBreak: "短休息",
  longBreak: "长休息",
};

/** 每根光条的位置和颜色，只算一次。颜色沿圆周从 c0 走到 c5 再走回来，首尾接得上。 */
const TICK_STYLES: CSSProperties[] = Array.from({ length: TICKS }, (_, i) => {
  const p = (1 - Math.abs((2 * i) / TICKS - 1)) * 5;
  const k = Math.min(4, Math.floor(p));
  const f = Math.round((p - k) * 100);
  return {
    "--a": `${(i * 360) / TICKS}deg`,
    "--tc": `color-mix(in srgb, var(--c${k + 1}) ${f}%, var(--c${k}))`,
  } as CSSProperties;
});

const Ring = memo(function Ring({ lit, hidden }: { lit: number; hidden: boolean }) {
  return (
    <div className={hidden ? "ring is-hidden" : "ring"} aria-hidden="true">
      {TICK_STYLES.map((base, i) => {
        const on = Math.max(0, Math.min(1, lit / STEPS - i));
        return (
          <div
            key={i}
            className="ring__tick"
            style={{ ...base, "--on": on } as CSSProperties}
          />
        );
      })}
    </div>
  );
});

/** "24:58" 这样的时间。每个数字占固定宽度，跳秒时不抖。主窗口和小组件共用。 */
export function TimeDigits({ secs, className }: { secs: number; className: string }) {
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return (
    <div className={className} role="timer" aria-label={`${mm}:${ss}`}>
      {mm.split("").map((d, i) => (
        <span key={`m${i}`} className="time__d">
          {d}
        </span>
      ))}
      <span className="time__sep">:</span>
      {ss.split("").map((d, i) => (
        <span key={`s${i}`} className="time__d">
          {d}
        </span>
      ))}
    </div>
  );
}

/** 这一组完成了几轮的小圆点 */
export function RoundDots({ round, rounds }: { round: number; rounds: number }) {
  return (
    <div
      className="rounds"
      title={t("这一组已完成 {done} 轮，共 {all} 轮", { done: round, all: rounds })}
    >
      {Array.from({ length: rounds }, (_, i) => (
        <span key={i} className={i < round ? "rounds__dot is-done" : "rounds__dot"} />
      ))}
    </div>
  );
}

interface ClockProps {
  showRing: boolean;
  /** 点当前任务的名字时：打开待办面板。待办已经摆在旁边时不传，名字就只是显示 */
  onOpenTasks?: () => void;
}

/** 触控板的小幅滑动攒到这么多算一格（一格一分钟） */
const WHEEL_STEP = 100;
/** 一次滚这么多以上的，是普通鼠标滚了一格，直接算一格 */
const WHEEL_NOTCH = 50;

/**
 * 滚轮或上下方向键调这一段的时长，一格一分钟。
 * 只在这一段还没开始时能调；已经开始的，调了会让进度对不上，所以给一句提示。
 */
function useAdjust(phase: Phase, started: boolean) {
  const acc = useRef(0);
  const [hint, setHint] = useState(false);

  useEffect(() => {
    if (!hint) return;
    const id = window.setTimeout(() => setHint(false), 1800);
    return () => window.clearTimeout(id);
  }, [hint]);

  // 换到另一段（或重置了）就不用再提示
  useEffect(() => setHint(false), [phase, started]);

  const step = (delta: number) => {
    if (started) {
      setHint(true);
      return;
    }
    const { key, min, max } = DURATIONS[phase];
    const now = getSettings()[key];
    const next = Math.max(min, Math.min(max, now + delta));
    if (next !== now) {
      updateSettings({ [key]: next });
      // Mac 触控板：每调一格轻轻"咔哒"一下，调到头那一下重一点
      haptic(next === min || next === max ? "edge" : "tick");
    } else {
      haptic("edge");
    }
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    // 往上滚加时长，往下滚减
    if (Math.abs(event.deltaY) >= WHEEL_NOTCH) {
      acc.current = 0;
      step(event.deltaY < 0 ? 1 : -1);
      return;
    }
    acc.current -= event.deltaY;
    if (Math.abs(acc.current) < WHEEL_STEP) return;
    step(acc.current > 0 ? 1 : -1);
    acc.current = 0;
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
    } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
    }
  };

  return { hint, onWheel, onKeyDown };
}

export function Clock({ showRing, onOpenTasks }: ClockProps) {
  useLang();
  const state = useTimer();
  const view = useCountdown(TICKS * STEPS);
  const task = currentTask(useTasks());
  const adjust = useAdjust(state.phase, state.started);
  const minutes = useSegmentMinutes();

  return (
    <div className="clock">
      <Ring lit={view.lit} hidden={!showRing} />
      {/* 光圈里面这一整块接滚轮 */}
      <div
        className={state.started ? "clock__dial" : "clock__dial is-adjustable"}
        role="slider"
        tabIndex={0}
        aria-label={t("{phase}时长", { phase: t(PHASE_NAMES[state.phase]) })}
        aria-valuemin={DURATIONS[state.phase].min}
        aria-valuemax={DURATIONS[state.phase].max}
        aria-valuenow={minutes}
        aria-valuetext={t("{n} 分钟", { n: minutes })}
        aria-disabled={state.started}
        title={state.started ? undefined : t("滚动鼠标滚轮调整时长")}
        onWheel={adjust.onWheel}
        onKeyDown={adjust.onKeyDown}
      />
      <div className="clock__center">
        <TimeDigits secs={view.secs} className="time" />
        <div className="clock__phase">
          {adjust.hint ? t("开始后不能调时长，先重置这一段") : t(PHASE_NAMES[state.phase])}
        </div>
        {task && onOpenTasks ? (
          <button
            type="button"
            className="clock__task"
            title={t("当前待办，点击打开待办")}
            onClick={onOpenTasks}
          >
            {task.name}
          </button>
        ) : null}
        {task && !onOpenTasks ? (
          <span className="clock__task" title={t("当前待办")}>
            {task.name}
          </span>
        ) : null}
        <RoundDots round={state.round} rounds={state.rounds} />
      </div>
    </div>
  );
}
