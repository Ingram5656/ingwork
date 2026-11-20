// 动效用到的几个小钩子：舞台缩放、闲置检测。

import { useEffect, useState } from "react";

export const STAGE_W = 1440;
export const STAGE_H = 900;

/** 主界面按 1440×900 排版，这里算出缩放比例写进 --stage-scale */
export function useStageScale(): void {
  useEffect(() => {
    const apply = () => {
      const scale = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
      document.documentElement.style.setProperty("--stage-scale", String(scale));
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, []);
}

/**
 * 闲置检测：鼠标 `ms` 毫秒不动就算闲置；鼠标移出窗口 0.7 秒也算。
 * `hold` 为真时（有面板开着）永远不算闲置。
 */
export function useIdle(ms: number, hold: boolean): boolean {
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    if (hold) {
      setIdle(false);
      return;
    }
    let timer: number | null = null;
    const arm = (delay: number) => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), delay);
    };
    const wake = () => {
      setIdle(false);
      arm(ms);
    };
    const leave = () => arm(700);

    arm(ms);
    window.addEventListener("pointermove", wake);
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
    document.documentElement.addEventListener("pointerleave", leave);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
      document.documentElement.removeEventListener("pointerleave", leave);
    };
  }, [ms, hold]);

  return idle;
}
