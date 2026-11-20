// 把"当前阶段的配色"变成界面上的颜色。主窗口和桌面小组件共用，所以两边颜色永远一致。

import { useEffect } from "react";
import { INK, PRESETS, applyLook, deepTone, glow, ramp } from "./palette";
import { useSettings, type Phase, type ThemeChoice } from "./settings";

/** 一个阶段的配色算成 6 个颜色。预设直接用；自选的先调成发光色。 */
export function colorsOf(choice: ThemeChoice): string[] {
  if (choice.preset !== "custom") {
    const preset = PRESETS[choice.preset];
    return ramp(preset.a, preset.b);
  }
  return ramp(glow(choice.a), glow(choice.b));
}

/** 按某个阶段的配色给当前窗口上色，设置变了会自己跟着变。 */
export function useLook(phase: Phase): void {
  const [settings] = useSettings();
  const choice = settings.themes[phase];
  useEffect(() => {
    const colors = colorsOf(choice);
    applyLook({
      colors,
      base: settings.baseFollows ? deepTone(colors) : INK,
      vivid: settings.vivid,
      dim: settings.dim,
    });
  }, [choice, settings.baseFollows, settings.vivid, settings.dim]);
}
