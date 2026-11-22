// 睡眠模式的窗框。画法在 components/SleepWindow.tsx 里

export type SleepFrame = "none" | "wood" | "arch";

export const SLEEP_FRAMES: { id: SleepFrame; label: string }[] = [
  { id: "none", label: "无边框玻璃" },
  { id: "wood", label: "木格窗" },
  { id: "arch", label: "拱形窗" },
];
