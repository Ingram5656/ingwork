// 图标。全部是 20×20 的线条图标，颜色跟随文字色。

import type { ReactNode } from "react";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconSkip() {
  return (
    <Icon>
      <path d="M4.5 4.8v10.4l8-5.2-8-5.2Z" fill="currentColor" stroke="none" />
      <path d="M15.2 4.6v10.8" />
    </Icon>
  );
}

export function IconReset() {
  return (
    <Icon>
      <path d="M4.2 10a5.8 5.8 0 1 0 1.9-4.3" />
      <path d="M4 3.6v3.2h3.2" />
    </Icon>
  );
}

export function IconGear() {
  return (
    <Icon>
      <path d="M3.5 6h6.2M13.5 6h3M3.5 14h3M10.3 14h6.2" />
      <circle cx="11.6" cy="6" r="1.9" />
      <circle cx="8.4" cy="14" r="1.9" />
    </Icon>
  );
}

export function IconMinimize() {
  return (
    <Icon>
      <path d="M5 10h10" />
    </Icon>
  );
}

export function IconMaximize() {
  return (
    <Icon>
      <rect x="5" y="5" width="10" height="10" rx="2.6" />
    </Icon>
  );
}

export function IconClose() {
  return (
    <Icon>
      <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
    </Icon>
  );
}

export function IconPlay() {
  return (
    <Icon>
      <path d="M6.2 4.4v11.2l9.2-5.6-9.2-5.6Z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function IconPause() {
  return (
    <Icon>
      <path d="M7 4.8v10.4M13 4.8v10.4" strokeWidth="2.6" />
    </Icon>
  );
}

/** 桌面小组件：大窗口右下角叠着一个小窗口 */
export function IconWidget() {
  return (
    <Icon>
      <path d="M8.2 15H5.4A2.4 2.4 0 0 1 3 12.6V6.4A2.4 2.4 0 0 1 5.4 4h9.2A2.4 2.4 0 0 1 17 6.4v2" />
      <rect x="10.6" y="11" width="6.4" height="5" rx="1.6" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** 总在最前：图钉 */
export function IconPin() {
  return (
    <Icon>
      <path d="M7.2 3.5h5.6l-.8 5 2.6 2.7H5.4L8 8.5l-.8-5Z" />
      <path d="M10 11.2v5.3" />
    </Icon>
  );
}

export function IconFullscreen() {
  return (
    <Icon>
      <path d="M4 7.6V4h3.6M12.4 4H16v3.6M16 12.4V16h-3.6M7.6 16H4v-3.6" />
    </Icon>
  );
}

export function IconFullscreenExit() {
  return (
    <Icon>
      <path d="M7.6 4v3.6H4M16 7.6h-3.6V4M12.4 16v-3.6H16M4 12.4h3.6V16" />
    </Icon>
  );
}

export function IconLock() {
  return (
    <Icon>
      <rect x="4.6" y="9" width="10.8" height="7.4" rx="2.2" />
      <path d="M7 9V6.8a3 3 0 0 1 6 0V9" />
    </Icon>
  );
}

/** 打开主窗口：一个箭头指向窗口外 */
export function IconOpen() {
  return (
    <Icon>
      <path d="M11.4 4H16v4.6M16 4l-6.4 6.4" />
      <path d="M8 5H6.4A2.4 2.4 0 0 0 4 7.4v6.2A2.4 2.4 0 0 0 6.4 16h6.2a2.4 2.4 0 0 0 2.4-2.4V12" />
    </Icon>
  );
}

/** 任务：一张打了勾的清单 */
export function IconTasks() {
  return (
    <Icon>
      <path d="M3.6 5.6l1.5 1.5 2.5-2.7M3.6 12.6l1.5 1.5 2.5-2.7" />
      <path d="M10.6 6h5.8M10.6 13h5.8" />
    </Icon>
  );
}

export function IconCheck() {
  return (
    <Icon>
      <path d="M4.6 10.4l3.5 3.5 7.3-7.8" strokeWidth="2.2" />
    </Icon>
  );
}

export function IconPencil() {
  return (
    <Icon>
      <path d="M4 16l.7-3.3 8.4-8.4a1.8 1.8 0 0 1 2.6 2.6l-8.4 8.4L4 16Z" />
    </Icon>
  );
}

export function IconTrash() {
  return (
    <Icon>
      <path d="M4.5 6h11M8 6V4.4h4V6M6 6l.6 9a1.6 1.6 0 0 0 1.6 1.5h3.6a1.6 1.6 0 0 0 1.6-1.5L14 6" />
    </Icon>
  );
}

export function IconPlus() {
  return (
    <Icon>
      <path d="M10 5v10M5 10h10" />
    </Icon>
  );
}

export function IconMinus() {
  return (
    <Icon>
      <path d="M5 10h10" />
    </Icon>
  );
}

/** 拖动排序的把手：六个点 */
export function IconGrip() {
  return (
    <Icon>
      <g fill="currentColor" stroke="none">
        <circle cx="7.4" cy="5.6" r="1.2" />
        <circle cx="12.6" cy="5.6" r="1.2" />
        <circle cx="7.4" cy="10" r="1.2" />
        <circle cx="12.6" cy="10" r="1.2" />
        <circle cx="7.4" cy="14.4" r="1.2" />
        <circle cx="12.6" cy="14.4" r="1.2" />
      </g>
    </Icon>
  );
}

/** 统计：三根高低不同的柱子 */
export function IconChart() {
  return (
    <Icon>
      <path d="M5 16v-5M10 16V4.5M15 16V8.5" strokeWidth="2.4" />
    </Icon>
  );
}

export function IconChevronLeft() {
  return (
    <Icon>
      <path d="M12 4.8L6.8 10l5.2 5.2" />
    </Icon>
  );
}

export function IconChevronRight() {
  return (
    <Icon>
      <path d="M8 4.8l5.2 5.2L8 15.2" />
    </Icon>
  );
}

/** 环境音：三道波浪 */
export function IconWaves() {
  return (
    <Icon>
      <path d="M3 6.4c1.8-1.5 3.4-1.5 5.2 0s3.4 1.5 5.2 0 2.6-1.3 3.6-.6" />
      <path d="M3 10.4c1.8-1.5 3.4-1.5 5.2 0s3.4 1.5 5.2 0 2.6-1.3 3.6-.6" />
      <path d="M3 14.4c1.8-1.5 3.4-1.5 5.2 0s3.4 1.5 5.2 0 2.6-1.3 3.6-.6" />
    </Icon>
  );
}

/** 时钟：离下节课还有多久 */
export function IconClock() {
  return (
    <Icon>
      <circle cx="10" cy="10" r="6.8" />
      <path d="M10 6.4V10l2.6 1.6" />
    </Icon>
  );
}

/** 翻译：文 和 A */
export function IconTranslate() {
  return (
    <Icon>
      <path d="M3 5h7M6.5 3.4V5M8.6 5c-.6 3-2.6 5.2-5.1 6.4M4.8 7.6c.9 1.6 2.2 2.8 3.8 3.5" />
      <path d="M10.4 16.6l3-7.2 3 7.2M11.5 14.2h3.8" />
    </Icon>
  );
}

/** 杂念箱：一个托盘 */
export function IconInbox() {
  return (
    <Icon>
      <path d="M3.5 11.2 5.6 4.8h8.8l2.1 6.4v3.6a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6Z" />
      <path d="M3.5 11.2h3.6l.9 1.8h4l.9-1.8h3.6" />
    </Icon>
  );
}

/** 上传：导入文件 */
export function IconUpload() {
  return (
    <Icon>
      <path d="M10 12.6V3.6M6.4 7.2 10 3.6l3.6 3.6" />
      <path d="M3.8 12.4v2.2a1.8 1.8 0 0 0 1.8 1.8h8.8a1.8 1.8 0 0 0 1.8-1.8v-2.2" />
    </Icon>
  );
}

/** 月亮：睡眠模式 */
export function IconMoon() {
  return (
    <Icon>
      <path d="M15.8 12.4A6.4 6.4 0 0 1 7.6 4.2a6.4 6.4 0 1 0 8.2 8.2Z" />
    </Icon>
  );
}

/** 太阳：雨量滑块的晴天那头 */
export function IconSun() {
  return (
    <Icon>
      <circle cx="10" cy="10" r="3.2" />
      <path d="M10 2.8v1.6M10 15.6v1.6M2.8 10h1.6M15.6 10h1.6M4.9 4.9l1.1 1.1M14 14l1.1 1.1M4.9 15.1 6 14M14 6l1.1-1.1" />
    </Icon>
  );
}

/** 云和雨：雨量滑块的大雨那头 */
export function IconRain() {
  return (
    <Icon>
      <path d="M6 11.8a3.6 3.6 0 0 1 .4-7.2 4.4 4.4 0 0 1 8.2 1.6 2.8 2.8 0 0 1-.2 5.6H6Z" />
      <path d="M7 14.4 6.2 16.6M10.4 14.4l-.8 2.2M13.8 14.4 13 16.6" />
    </Icon>
  );
}

/** 喇叭：声音开着 */
export function IconSound() {
  return (
    <Icon>
      <path d="M3.6 7.6h2.6L10 4.4v11.2l-3.8-3.2H3.6V7.6Z" />
      <path d="M13 7.2a4 4 0 0 1 0 5.6M15.2 5a7 7 0 0 1 0 10" />
    </Icon>
  );
}

/** 喇叭打叉：声音关着 */
export function IconSoundOff() {
  return (
    <Icon>
      <path d="M3.6 7.6h2.6L10 4.4v11.2l-3.8-3.2H3.6V7.6Z" />
      <path d="m13 7.6 4.4 4.8M17.4 7.6 13 12.4" />
    </Icon>
  );
}
