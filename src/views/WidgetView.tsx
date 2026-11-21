// 桌面小组件：一个透明的小窗口，显示剩余时间和进度环。
// 小号只有时间和进度环；中号多显示当前任务（没有就显示阶段）、轮次和今天的番茄数。
// 鼠标移上去，开始 / 暂停、跳过这些按钮从下方浮起；按住空白处可以拖走。
// 它自己只改设置，开关、大小、锁定都由主窗口告诉后端去做。

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { PHASE_NAMES, RoundDots, TimeDigits } from "../components/Clock";
import { IconClose, IconLock, IconOpen, IconPause, IconPlay, IconSkip } from "../components/Icons";
import { t, useLang } from "../lib/i18n";
import { IS_MAC } from "../lib/platform";
import { initSettingsSync, useSettings } from "../lib/settings";
import { initStats, pomodorosToday, useStats } from "../lib/stats";
import { currentTask, initTasks, useTasks } from "../lib/tasks";
import { call, nextFrame } from "../lib/tauri";
import { useLook } from "../lib/theme";
import { initTimer, timer, useCountdown, useTimer } from "../lib/timer";
import { patchWidget } from "../lib/windows";

/** 进度环分多少档 */
const RING_STEPS = 240;

/** 窗口四周留给投影的边（和样式里 .widget 的 left / top 一致） */
const SHADOW_MARGIN = 14;

/** 最近一次是我们自己让后端改窗口大小（可能顺带挪了位置）的时刻 */
let lastFit = 0;

/**
 * 量出小组件实际要多大，让后端把窗口改成刚好装下。
 * 窗口大小不能写死：没装设计稿的字体、或者在 Windows 里调大了"文本大小"时，字会变宽。
 */
async function fitWindow(card: HTMLElement): Promise<void> {
  const rect = card.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.ceil((rect.width + SHADOW_MARGIN * 2) * ratio);
  const height = Math.ceil((rect.height + SHADOW_MARGIN * 2) * ratio);
  lastFit = performance.now();
  await invoke("widget_fit", { width, height }).catch((e) =>
    console.error("[ingwork] widget_fit", e),
  );
}

/** 拖动后把新位置记下来，下次打开还在原处 */
function trackPosition(): () => void {
  let off: (() => void) | null = null;
  let dead = false;
  let pending: number | null = null;
  getCurrentWindow()
    .onMoved((event) => {
      // 改大小时后端可能顺带把窗口重新贴到右下角，那不是用户拖的，不记
      if (performance.now() - lastFit < 800) return;
      const { x, y } = event.payload;
      if (pending !== null) window.clearTimeout(pending);
      pending = window.setTimeout(() => {
        call("widget_moved");
        patchWidget({ x, y });
      }, 400);
    })
    .then((unlisten) => {
      if (dead) unlisten();
      else off = unlisten;
    })
    .catch(() => {});
  return () => {
    dead = true;
    if (off) off();
    if (pending !== null) window.clearTimeout(pending);
  };
}

function MiniRing({ size, stroke, progress }: { size: number; stroke: number; progress: number }) {
  const r = (size - stroke) / 2;
  const length = 2 * Math.PI * r;
  return (
    <svg className="widget__ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <defs>
        <linearGradient id="widget-ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "var(--c1)" }} />
          <stop offset="1" style={{ stopColor: "var(--c5)" }} />
        </linearGradient>
      </defs>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="rgba(255,255,255,0.16)"
        strokeWidth={stroke}
      />
      <circle
        className="widget__arc"
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="url(#widget-ring)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={length}
        strokeDashoffset={length * (1 - progress)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

export function WidgetView() {
  useLang();
  const [settings] = useSettings();
  const state = useTimer();
  const view = useCountdown(RING_STEPS);
  const [hover, setHover] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const task = currentTask(useTasks());
  const todayCount = pomodorosToday(useStats().records);
  useLook(state.phase);

  useEffect(() => {
    initSettingsSync();
    initTimer();
    initTasks();
    initStats();
    const untrack = trackPosition();
    // 内容变宽变窄（换了大小、语言、任务名）时，窗口跟着变
    let last = "";
    const observer = new ResizeObserver(() => {
      const el = card.current;
      if (!el) return;
      const key = `${el.offsetWidth}x${el.offsetHeight}`;
      if (key === last) return;
      last = key;
      void fitWindow(el);
    });
    if (card.current) observer.observe(card.current);
    // 等字体加载好、量好大小、窗口改好，再让后端显示，免得先露出一个装不下的样子
    let alive = true;
    void document.fonts.ready
      .then(nextFrame)
      .then(async () => {
        if (!alive || !card.current) return;
        last = `${card.current.offsetWidth}x${card.current.offsetHeight}`;
        await fitWindow(card.current);
        if (alive) call("widget_ready");
      });
    return () => {
      alive = false;
      observer.disconnect();
      untrack();
    };
  }, []);

  // 鼠标离开窗口时一定收起按钮（透明窗口上 :hover 有时会卡住，所以自己记）
  useEffect(() => {
    const root = document.documentElement;
    const enter = () => setHover(true);
    const leave = () => setHover(false);
    root.addEventListener("pointerenter", enter);
    root.addEventListener("pointermove", enter);
    root.addEventListener("pointerleave", leave);
    window.addEventListener("blur", leave);
    return () => {
      root.removeEventListener("pointerenter", enter);
      root.removeEventListener("pointermove", enter);
      root.removeEventListener("pointerleave", leave);
      window.removeEventListener("blur", leave);
    };
  }, []);

  const medium = settings.widget.size === "medium";
  const progress = view.lit / RING_STEPS;

  let toggleLabel = t("开始");
  if (state.running) toggleLabel = t("暂停");
  else if (state.started) toggleLabel = t("继续");

  const classes = ["widget"];
  if (hover) classes.push("is-hover");
  if (!state.running && state.started) classes.push("is-paused");

  const lockHint = IS_MAC
    ? t("锁定小组件（在菜单栏图标的菜单里解锁）")
    : t("锁定小组件（在托盘菜单里解锁）");

  return (
    <div
      ref={card}
      className={classes.join(" ")}
      data-size={settings.widget.size}
      data-tauri-drag-region
    >
      <div className="widget__body">
        <MiniRing size={medium ? 84 : 40} stroke={medium ? 8 : 5} progress={progress} />
        <div className="widget__text">
          <TimeDigits secs={view.secs} className="widget__time" />
          {medium ? (
            <>
              {/* 有当前任务时显示任务名，没有就显示阶段 */}
              <div className="widget__phase">{task ? task.name : t(PHASE_NAMES[state.phase])}</div>
              <div className="widget__meta">
                <RoundDots round={state.round} rounds={state.rounds} />
                <span className="widget__today">{t("今天 {n} 个番茄", { n: todayCount })}</span>
              </div>
            </>
          ) : null}
        </div>
      </div>

      <div className="widget__tools">
        <button
          type="button"
          className="ibtn ibtn--sm"
          title={toggleLabel}
          aria-label={toggleLabel}
          onClick={timer.toggle}
        >
          {state.running ? <IconPause /> : <IconPlay />}
        </button>
        <button
          type="button"
          className="ibtn ibtn--sm"
          title={t("跳过这一段")}
          aria-label={t("跳过这一段")}
          onClick={timer.skip}
        >
          <IconSkip />
        </button>
        <button
          type="button"
          className="ibtn ibtn--sm"
          title={t("打开主窗口")}
          aria-label={t("打开主窗口")}
          onClick={() => call("open_main")}
        >
          <IconOpen />
        </button>
        <button
          type="button"
          className="ibtn ibtn--sm"
          title={lockHint}
          aria-label={lockHint}
          onClick={() => patchWidget({ locked: true })}
        >
          <IconLock />
        </button>
        <button
          type="button"
          className="ibtn ibtn--sm"
          title={t("隐藏小组件")}
          aria-label={t("隐藏小组件")}
          onClick={() => patchWidget({ open: false })}
        >
          <IconClose />
        </button>
      </div>
    </div>
  );
}
