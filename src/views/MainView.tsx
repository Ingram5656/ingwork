// 主窗口：三页。
// - 今天：左边今天的时间轴（课、空档、专注过的时间），中间番茄钟，右边待办和截止日期
// - 课表：导入 .ics、一节节加课、一周的课
// - 复盘：今天的专注、预计和实际、杂念箱、生词本
//
// 内容是主角，控件退后：在"今天"页，鼠标 3 秒不动，顶栏和底栏滑出画面、光标隐藏。
// 专注开始后（设置里能关）两边收起来，只留倒计时、下节课和杂念箱；全屏（F11）时也是这样。

import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { Clock, PHASE_NAMES, TimeDigits } from "../components/Clock";
import { Deadlines } from "../components/Deadlines";
import {
  IconClose,
  IconFullscreen,
  IconFullscreenExit,
  IconGear,
  IconInbox,
  IconMaximize,
  IconMinimize,
  IconPause,
  IconPin,
  IconPlay,
  IconReset,
  IconSkip,
  IconTranslate,
  IconWaves,
  IconWidget,
} from "../components/Icons";
import { Presence } from "../components/Presence";
import { Segmented } from "../components/Segmented";
import { SettingsPanel, type Category } from "../components/SettingsPanel";
import { Sheet, type SheetSpec } from "../components/Sheet";
import { StatsPanel } from "../components/StatsPanel";
import { TasksPanel } from "../components/TasksPanel";
import { Timeline } from "../components/Timeline";
import { GapHint, InboxCard, NextClassCard, WordReview } from "../components/TodayCards";
import { initAmbient, toggleAmbient } from "../lib/ambient";
import { setBackgroundError, useBackgroundUrl } from "../lib/background";
import { t, useLang } from "../lib/i18n";
import { useIdle, useStageScale } from "../lib/motion";
import { refreshNow } from "../lib/now";
import { initPlanner } from "../lib/planner";
import { IS_MAC } from "../lib/platform";
import { initPopups, togglePopup } from "../lib/popups";
import { initReminders } from "../lib/reminders";
import { PHASES, getSettings, initSettingsSync, useSettings, type Page, type Phase } from "../lib/settings";
import { accelKeys, initShortcuts } from "../lib/shortcuts";
import { initStats } from "../lib/stats";
import { currentTask, initTasks, useTasks } from "../lib/tasks";
import { call, nextFrame, onEvent } from "../lib/tauri";
import { useLook } from "../lib/theme";
import { initTimer, initTimerConfig, timer, useCountdown, useTimer } from "../lib/timer";
import { checkUpdate, useUpdate } from "../lib/update";
import { initWindows, toggleFullscreen, toggleWidget } from "../lib/windows";
import { ReviewPage } from "./ReviewPage";
import { SchedulePage } from "./SchedulePage";

const START_LABELS: Record<Phase, string> = {
  focus: "开始专注",
  shortBreak: "开始短休息",
  longBreak: "开始长休息",
};

const PAGES: { value: Page; label: string }[] = [
  { value: "today", label: "今天" },
  { value: "schedule", label: "课表" },
  { value: "review", label: "复盘" },
];

/** 不在"今天"页时，顶栏中间的小计时：一眼看到还剩多久，点一下回到今天 */
function MiniTimer({ onOpen }: { onOpen: () => void }) {
  useLang();
  const state = useTimer();
  const view = useCountdown(1);
  const task = currentTask(useTasks());
  const label = task ? task.name : t(PHASE_NAMES[state.phase]);
  return (
    <div className="mini glass capsule">
      <button type="button" className="mini__main" title={t("回到今天")} onClick={onOpen}>
        <span className={state.running ? "mini__dot is-running" : "mini__dot"} aria-hidden="true" />
        <TimeDigits secs={view.secs} className="mini__time" />
        <span className="mini__label">{label}</span>
      </button>
      <button
        type="button"
        className="ibtn"
        title={state.running ? t("暂停") : t("开始")}
        aria-label={state.running ? t("暂停") : t("开始")}
        onClick={timer.toggle}
      >
        {state.running ? <IconPause /> : <IconPlay />}
      </button>
    </div>
  );
}

export function MainView() {
  useLang();
  useStageScale();
  const [settings, update] = useSettings();
  const state = useTimer();
  const updateState = useUpdate();
  const page = settings.page;

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState<Category>("timer");
  const [tasksOpen, setTasksOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sheet, setSheet] = useState<SheetSpec | null>(null);
  // 对话框退场时还要显示内容，所以留着最后一次的
  const [lastSheet, setLastSheet] = useState<SheetSpec | null>(null);
  const [previewPhase, setPreviewPhase] = useState<Phase | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  // 专注布局：两边收起，只留倒计时、下节课和杂念箱
  const focusing =
    page === "today" &&
    (fullscreen || (settings.focusLayout && state.running && state.phase === "focus"));

  // 课表、复盘页是拿来操作的，控件不自己收起
  const idle = useIdle(
    3000,
    page !== "today" || settingsOpen || tasksOpen || historyOpen || sheet !== null,
  );

  const openSheet = useCallback((spec: SheetSpec) => {
    setLastSheet(spec);
    setSheet(spec);
  }, []);
  const closeSheet = useCallback(() => setSheet(null), []);

  const goTo = useCallback((next: Page) => update({ page: next }), [update]);

  // 两边又展开了，侧边的待办面板就不用了
  useEffect(() => {
    if (!focusing) setTasksOpen(false);
  }, [focusing]);

  // ---------- 启动 ----------

  useEffect(() => {
    initSettingsSync();
    initTimer();
    initTimerConfig();
    initTasks();
    initStats();
    initPlanner();
    initAmbient();
    initShortcuts();
    initWindows();
    initPopups();
    initReminders();
    // 画好第一帧再让后端显示窗口，免得闪一下（Mac 上藏着的窗口不画，最多等 100 毫秒）
    let alive = true;
    void nextFrame().then(() => {
      if (alive) call("frontend_ready");
    });
    // 启动后悄悄查一次更新，有新版本时设置按钮上出小红点
    const check = window.setTimeout(() => void checkUpdate(true), 4000);
    // 从托盘里叫出来、电脑睡醒时，时间轴马上对准现在
    const wake = () => {
      if (!document.hidden) refreshNow();
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      alive = false;
      window.clearTimeout(check);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);

  // 翻译小窗里点了齿轮：打开设置的"翻译"
  useEffect(
    () =>
      onEvent<Category>("open-settings", (category) => {
        setSettingsCategory(category);
        setSettingsOpen(true);
      }),
    [],
  );

  // ---------- 颜色 ----------

  // 在设置里调某个阶段的配色时，背景临时换成那个阶段的颜色
  const lookPhase = previewPhase ?? state.phase;
  useLook(lookPhase);

  // ---------- 背景 ----------

  const media = settings.bgMode === "media" ? settings.bgMedia : null;
  const mediaUrl = useBackgroundUrl(media);
  const video = useRef<HTMLVideoElement>(null);

  // 窗口藏起来、最小化时视频暂停，回来再接着放
  useEffect(() => {
    const sync = () => {
      const el = video.current;
      if (!el) return;
      if (document.hidden) el.pause();
      else void el.play().catch(() => {});
    };
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  let background = (
    <>
      <div className="bg__blob bg__blob--a" />
      <div className="bg__blob bg__blob--b" />
      <div className="bg__blob bg__blob--c" />
    </>
  );
  if (settings.bgMode === "gradient") {
    background = <div className="bg__gradient" />;
  } else if (media && mediaUrl) {
    background =
      media.kind === "video" ? (
        <video
          ref={video}
          className="bg__media"
          src={mediaUrl}
          autoPlay
          muted
          loop
          playsInline
          onError={() => setBackgroundError("这个视频放不了，换一个 MP4 或 WebM 试试")}
        />
      ) : (
        <img
          className="bg__media"
          src={mediaUrl}
          alt=""
          onError={() => setBackgroundError("这张图片打不开，换一张试试")}
        />
      );
  }

  // ---------- 关主窗口 ----------

  const requestClose = useCallback(() => {
    const action = getSettings().closeAction;
    if (action === "tray") {
      call("hide_main");
      return;
    }
    if (action === "quit") {
      call("quit_app");
      return;
    }
    // 第一次问一下，之后照选的来，设置里能改
    openSheet({
      title: t("关闭主窗口时"),
      body: IS_MAC
        ? t("留在菜单栏里，计时照常走，到点照样提醒，翻译和杂念箱的快捷键也照样能用。以后都照这次选的来，设置里可以改。")
        : t("留在托盘里，计时照常走，到点照样提醒，翻译和杂念箱的快捷键也照样能用。以后都照这次选的来，设置里可以改。"),
      actions: [
        {
          label: t("退出 ingwork"),
          onPick: () => {
            update({ closeAction: "quit" });
            call("quit_app");
          },
        },
        {
          label: IS_MAC ? t("留在菜单栏") : t("留在托盘"),
          primary: true,
          onPick: () => {
            update({ closeAction: "tray" });
            closeSheet();
            call("hide_main");
          },
        },
      ],
    });
  }, [openSheet, closeSheet, update]);

  useEffect(() => onEvent<unknown>("close-requested", requestClose), [requestClose]);

  // ---------- 操作 ----------

  /** 会丢掉这一段专注进度的操作，先问一句。休息不用问。 */
  const guard = useCallback(
    (title: string, body: string, confirm: string, action: () => void) => {
      if (!(state.phase === "focus" && state.started)) {
        action();
        return;
      }
      openSheet({
        title,
        body,
        actions: [
          { label: t("继续专注"), onPick: closeSheet },
          {
            label: confirm,
            primary: true,
            onPick: () => {
              closeSheet();
              action();
            },
          },
        ],
      });
    },
    [state.phase, state.started, openSheet, closeSheet],
  );

  const skip = () =>
    guard(t("跳过这一段专注？"), t("这一段不会算作完成的番茄。"), t("跳过这一段"), timer.skip);

  const reset = () =>
    guard(t("重置这一段专注？"), t("已经走过的时间会清零。"), t("重置这一段"), timer.reset);

  const pickPhase = (phase: Phase) => {
    const name = t(PHASE_NAMES[phase]);
    guard(
      t("切到{phase}？", { phase: name }),
      t("这一段专注已经走过的时间会清零。"),
      t("切到{phase}", { phase: name }),
      () => timer.setPhase(phase),
    );
  };

  const openSettings = () => {
    setSettingsCategory("timer");
    setSettingsOpen(true);
  };

  // ---------- 全屏 ----------

  const switchFullscreen = useCallback(() => {
    void toggleFullscreen().then(setFullscreen);
  }, []);

  // ---------- 键盘 ----------

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Mac 上全屏是 ⌃⌘F
      const macFullscreen = IS_MAC && event.metaKey && event.ctrlKey && event.code === "KeyF";
      if (event.key === "F11" || macFullscreen) {
        event.preventDefault();
        switchFullscreen();
        return;
      }
      if (event.key === "Escape") {
        if (sheet) closeSheet();
        else if (settingsOpen) setSettingsOpen(false);
        else if (historyOpen) setHistoryOpen(false);
        else if (tasksOpen) setTasksOpen(false);
        else if (fullscreen) switchFullscreen();
        return;
      }
      if (event.code === "Space" && !settingsOpen && !historyOpen && !sheet) {
        const target = event.target as HTMLElement | null;
        const typing = target && ["BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
        if (typing) return;
        event.preventDefault();
        timer.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, settingsOpen, historyOpen, tasksOpen, fullscreen, closeSheet, switchFullscreen]);

  // ---------- 画面 ----------

  const phaseOptions = PHASES.map((phase) => ({ value: phase, label: t(PHASE_NAMES[phase]) }));
  const pageOptions = PAGES.map((p) => ({ value: p.value, label: t(p.label) }));

  let mainLabel = t(START_LABELS[state.phase]);
  if (state.running) mainLabel = t("暂停");
  else if (state.started) mainLabel = t("继续");

  const classes = ["app", `page-${page}`];
  if (idle) classes.push("is-idle");
  if (state.running) classes.push("is-running");
  else if (state.started) classes.push("is-paused");
  if (focusing) classes.push("is-focusing");

  const appWindow = getCurrentWindow();
  const translateKeys = accelKeys(settings.shortcuts.translate);
  const captureKeys = accelKeys(settings.shortcuts.capture);
  const keyHint = (keys: string[]) => {
    if (keys.length === 0) return "";
    const combo = keys.join(IS_MAC ? "" : "+");
    return settings.lang === "en" ? ` (${combo})` : `（${combo}）`;
  };

  return (
    <div className={classes.join(" ")} data-phase={lookPhase}>
      <div className="bg">
        {background}
        <div className="bg__dim" />
      </div>

      <div className="stage">
        <div className="dragzone" data-tauri-drag-region />

        {page === "today" ? (
          <div className="page page--today">
            <div className="today__left">
              <Timeline onOpenSchedule={() => goTo("schedule")} />
            </div>
            <div className="today__right">
              <TasksPanel docked confirm={openSheet} closeConfirm={closeSheet} />
              <Deadlines />
            </div>
            <Clock showRing={settings.ring} onOpenTasks={focusing ? () => setTasksOpen(true) : undefined} />
            <div className="today__under">
              <GapHint />
              <WordReview />
            </div>
            <div className="today__corner today__corner--left">
              <NextClassCard />
            </div>
            <div className="today__corner today__corner--right">
              <InboxCard />
            </div>
          </div>
        ) : null}

        {page === "schedule" ? <SchedulePage confirm={openSheet} closeConfirm={closeSheet} /> : null}

        {page === "review" ? (
          <ReviewPage onOpenHistory={() => setHistoryOpen(true)} confirm={openSheet} closeConfirm={closeSheet} />
        ) : null}

        <header className="topbar">
          <div className="topbar__left glass capsule">
            <Segmented<Page> label={t("页面")} options={pageOptions} value={page} onChange={goTo} />
          </div>
          {page === "today" ? (
            <div className="glass capsule">
              <Segmented<Phase>
                label={t("阶段")}
                options={phaseOptions}
                value={state.phase}
                onChange={pickPhase}
              />
            </div>
          ) : (
            <MiniTimer onOpen={() => goTo("today")} />
          )}
          <div className="topbar__tools glass capsule">
            <button
              type="button"
              className="ibtn"
              title={t("翻译") + keyHint(translateKeys)}
              aria-label={t("翻译")}
              onClick={() => togglePopup("translate")}
            >
              <IconTranslate />
            </button>
            <button
              type="button"
              className="ibtn"
              title={t("记一条杂念") + keyHint(captureKeys)}
              aria-label={t("记一条杂念")}
              onClick={() => togglePopup("capture")}
            >
              <IconInbox />
            </button>
            <button
              type="button"
              className={settings.ambientOn ? "ibtn is-on" : "ibtn"}
              title={settings.ambientOn ? t("关掉环境音") : t("专注时播放环境音")}
              aria-label={settings.ambientOn ? t("关掉环境音") : t("专注时播放环境音")}
              aria-pressed={settings.ambientOn}
              onClick={toggleAmbient}
            >
              <IconWaves />
            </button>
            <button
              type="button"
              className={settings.widget.open ? "ibtn is-on" : "ibtn"}
              title={settings.widget.open ? t("隐藏桌面小组件") : t("显示桌面小组件")}
              aria-label={settings.widget.open ? t("隐藏桌面小组件") : t("显示桌面小组件")}
              aria-pressed={settings.widget.open}
              onClick={toggleWidget}
            >
              <IconWidget />
            </button>
            <button
              type="button"
              className={settings.alwaysOnTop ? "ibtn is-on" : "ibtn"}
              title={settings.alwaysOnTop ? t("取消总在最前") : t("主窗口总在最前")}
              aria-label={settings.alwaysOnTop ? t("取消总在最前") : t("主窗口总在最前")}
              aria-pressed={settings.alwaysOnTop}
              onClick={() => update({ alwaysOnTop: !settings.alwaysOnTop })}
            >
              <IconPin />
            </button>
            <button
              type="button"
              className="ibtn"
              title={fullscreen ? t("退出全屏") : t("全屏")}
              aria-label={fullscreen ? t("退出全屏") : t("全屏")}
              onClick={switchFullscreen}
            >
              {fullscreen ? <IconFullscreenExit /> : <IconFullscreen />}
            </button>
            <button type="button" className="ibtn" title={t("设置")} aria-label={t("设置")} onClick={openSettings}>
              <IconGear />
              {updateState.kind === "available" ? <span className="dot" /> : null}
            </button>
            {/* Mac 上用左上角系统的红黄绿按钮，这里就不放了 */}
            {IS_MAC ? null : <span className="divider" />}
            {/* 全屏时没有"最小化""最大化"可言，收起来 */}
            {fullscreen || IS_MAC ? null : (
              <>
                <button
                  type="button"
                  className="ibtn"
                  title={t("最小化")}
                  aria-label={t("最小化")}
                  onClick={() => void appWindow.minimize()}
                >
                  <IconMinimize />
                </button>
                <button
                  type="button"
                  className="ibtn"
                  title={t("最大化")}
                  aria-label={t("最大化")}
                  onClick={() => void appWindow.toggleMaximize()}
                >
                  <IconMaximize />
                </button>
              </>
            )}
            {IS_MAC ? null : (
              <button type="button" className="ibtn" title={t("关闭")} aria-label={t("关闭")} onClick={requestClose}>
                <IconClose />
              </button>
            )}
          </div>
        </header>

        {page === "today" ? (
          <footer className="bottombar">
            <div className="playbar glass capsule">
              <button type="button" className="ibtn" title={t("重置这一段")} aria-label={t("重置这一段")} onClick={reset}>
                <IconReset />
              </button>
              <button type="button" className="btn btn--primary" onClick={timer.toggle}>
                {mainLabel}
              </button>
              <button type="button" className="ibtn" title={t("跳过这一段")} aria-label={t("跳过这一段")} onClick={skip}>
                <IconSkip />
              </button>
            </div>
          </footer>
        ) : null}

        <Presence show={tasksOpen} side>
          <TasksPanel onClose={() => setTasksOpen(false)} confirm={openSheet} closeConfirm={closeSheet} />
        </Presence>

        <Presence show={historyOpen} onScrim={() => setHistoryOpen(false)}>
          <StatsPanel onClose={() => setHistoryOpen(false)} confirm={openSheet} closeConfirm={closeSheet} />
        </Presence>

        <Presence show={settingsOpen} onScrim={() => setSettingsOpen(false)}>
          <SettingsPanel
            initial={settingsCategory}
            onClose={() => setSettingsOpen(false)}
            onPreview={setPreviewPhase}
          />
        </Presence>

        <Presence show={sheet !== null} onScrim={closeSheet}>
          {lastSheet ? <Sheet spec={lastSheet} /> : null}
        </Presence>
      </div>
    </div>
  );
}
