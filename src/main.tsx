// 所有窗口加载同一个页面，这里按窗口标签决定显示哪个界面。
// 桌面小组件、刘海番茄、翻译、杂念箱的窗口是透明的，所以先给它们加个标记，让页面底色也变透明。

import { getCurrentWindow } from "@tauri-apps/api/window";
import React from "react";
import ReactDOM from "react-dom/client";
import { IS_MAC } from "./lib/platform";
import "./styles.css";
import { CaptureView } from "./views/CaptureView";
import { IslandView } from "./views/IslandView";
import { MainView } from "./views/MainView";
import { TranslateView } from "./views/TranslateView";
import { WidgetView } from "./views/WidgetView";

const label = getCurrentWindow().label;
if (label === "widget") document.documentElement.classList.add("is-widget");
if (label === "island") document.documentElement.classList.add("is-island");
if (label === "translate" || label === "capture") document.documentElement.classList.add("is-popup");
// Mac 上左上角是系统的红黄绿三个按钮，样式里要给它们让位
if (IS_MAC) document.documentElement.classList.add("is-mac");

function viewFor(windowLabel: string) {
  switch (windowLabel) {
    case "widget":
      return <WidgetView />;
    case "island":
      return <IslandView />;
    case "translate":
      return <TranslateView />;
    case "capture":
      return <CaptureView />;
    case "main":
    default:
      return <MainView />;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{viewFor(label)}</React.StrictMode>,
);
