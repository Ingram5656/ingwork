// 睡眠模式：整个窗口变成一扇夜里下雨的窗（画面从 ingfy 的助眠模式搬过来）。
//
// SleepBackdrop：铺满窗口的那扇窗，垫在界面下面（舞台里原来的内容在睡眠模式里藏起来）。
// SleepBar：顶上一排控件，和平时的顶栏同一个位置：左边退出，中间雨量，右边声音、定时、设置、全屏。
// 鼠标不动 3 秒控件和鼠标都藏起来（和专注时一样），动一下又出来。

import { useEffect, useState, type ChangeEvent, type CSSProperties } from "react";
import { t } from "../lib/i18n";
import { rainWord } from "../lib/sleep/rain";
import { useBackgroundVideo, useSleepImage } from "../lib/sleep/media";
import { closeSleep, cycleSleepTimer, useSleep } from "../lib/sleep/session";
import { useSettings } from "../lib/settings";
import {
  IconClock,
  IconFullscreen,
  IconFullscreenExit,
  IconGear,
  IconMoon,
  IconRain,
  IconSound,
  IconSoundOff,
  IconSun,
} from "./Icons";
import { SleepWindow } from "./SleepWindow";

/** 退场动画多久，和样式里 .sleepwin[data-state="out"] 一致 */
const EXIT_MS = 450;

export function SleepBackdrop() {
  const { open } = useSleep();
  const [settings] = useSettings();
  const [mounted, setMounted] = useState(open);
  const image = useSleepImage();
  const video = useBackgroundVideo(open && settings.sleepScene === "video");

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const id = window.setTimeout(() => setMounted(false), EXIT_MS);
    return () => window.clearTimeout(id);
  }, [open]);

  if (!open && !mounted) return null;
  return (
    <div className="sleepwin" data-state={open ? "in" : "out"}>
      <SleepWindow
        rain={settings.sleepRain}
        scene={settings.sleepScene}
        frame={settings.sleepFrame}
        image={image}
        video={video}
        angle={settings.sleepAngle}
        thunder={settings.sleepThunder}
        sound={settings.sleepSound}
      />
    </div>
  );
}

interface BarProps {
  fullscreen: boolean;
  onFullscreen: () => void;
  onSettings: () => void;
}

/** "还剩 12 分钟"：开着定时时每秒刷新 */
function useLeft(endsAt: number | null): number | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (endsAt === null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [endsAt]);
  return endsAt === null ? null : Math.max(0, endsAt - now);
}

export function SleepBar({ fullscreen, onFullscreen, onSettings }: BarProps) {
  const [settings, update] = useSettings();
  const { endsAt, minutes } = useSleep();
  const left = useLeft(endsAt);
  const sound = settings.sleepSound;

  let timerText = t("定时");
  if (left !== null) {
    timerText =
      left < 60_000
        ? t("还剩 {n} 秒", { n: Math.ceil(left / 1000) })
        : t("还剩 {n} 分钟", { n: Math.ceil(left / 60_000) });
  }
  const nextTimer = minutes === null ? 15 : minutes === 15 ? 30 : minutes === 30 ? 60 : null;
  const timerTitle =
    nextTimer === null ? t("关掉定时") : t("{n} 分钟后声音慢慢变小、停下", { n: nextTimer });

  return (
    <header className="topbar sleepbar">
      <div className="topbar__left glass capsule sleepbar__exit">
        <IconMoon />
        <span>{t("睡眠模式")}</span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={closeSleep}>
          {t("回到主界面")}
        </button>
      </div>

      {/* 雨量：从晴天一路拖到瓢泼大雨 */}
      <label className="glass capsule sleepbar__rain">
        <IconSun />
        <input
          className="sleepbar__range"
          type="range"
          min={0}
          max={100}
          value={settings.sleepRain}
          aria-label={t("雨量")}
          aria-valuetext={t(rainWord(settings.sleepRain))}
          style={{ "--p": `${settings.sleepRain}%` } as CSSProperties}
          onChange={(event: ChangeEvent<HTMLInputElement>) => update({ sleepRain: Number(event.target.value) })}
        />
        <IconRain />
        <span className="sleepbar__word">{t(rainWord(settings.sleepRain))}</span>
      </label>

      <div className="topbar__tools glass capsule">
        <button
          type="button"
          className={sound ? "ibtn is-on" : "ibtn"}
          title={sound ? t("关掉声音") : t("打开声音")}
          aria-label={sound ? t("关掉声音") : t("打开声音")}
          aria-pressed={sound}
          onClick={() => update({ sleepSound: !sound })}
        >
          {sound ? <IconSound /> : <IconSoundOff />}
        </button>
        <button
          type="button"
          className={left !== null ? "chip-btn is-on" : "chip-btn"}
          title={timerTitle}
          onClick={cycleSleepTimer}
        >
          <IconClock />
          <span>{timerText}</span>
        </button>
        <button type="button" className="ibtn" title={t("睡眠模式设置")} aria-label={t("睡眠模式设置")} onClick={onSettings}>
          <IconGear />
        </button>
        <button
          type="button"
          className="ibtn"
          title={fullscreen ? t("退出全屏") : t("全屏")}
          aria-label={fullscreen ? t("退出全屏") : t("全屏")}
          onClick={onFullscreen}
        >
          {fullscreen ? <IconFullscreenExit /> : <IconFullscreen />}
        </button>
      </div>
    </header>
  );
}
