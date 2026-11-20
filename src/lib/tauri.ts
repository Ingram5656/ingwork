// 和后端打交道的两个小工具。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * 监听一个事件，返回取消监听的函数。
 * 开发时 React 的 StrictMode 会把每个效果装两次，这里保证卸载时收干净。
 */
export function onEvent<T>(name: string, handler: (payload: T) => void): () => void {
  let off: (() => void) | null = null;
  let dead = false;
  listen<T>(name, (event) => handler(event.payload))
    .then((unlisten) => {
      if (dead) unlisten();
      else off = unlisten;
    })
    .catch(() => {});
  return () => {
    dead = true;
    if (off) off();
  };
}

/** 调一个不关心返回值的命令。失败时只在控制台留一条记录。 */
export function call(command: string, args?: Record<string, unknown>): void {
  invoke(command, args).catch((error) => console.error(`[ingwork] ${command}`, error));
}
