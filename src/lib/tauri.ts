// 和后端打交道的两个小工具。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** 还没在后端登记好的监听 */
const pending = new Set<Promise<void>>();

/**
 * 等到目前所有的监听都在后端登记好了。
 * 登记要走一趟后端，没登记好之前发来的事件会丢；小窗要在这之后才告诉后端"可以呼出了"，
 * 不然第一次呼出时的 summoned 事件可能比监听先到，面板就一直不出来
 */
export async function listening(): Promise<void> {
  // 先让一下：同一批里排在后面的效果这时还没跑，它们的监听也要算进来
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  while (pending.size > 0) await Promise.all([...pending]);
}

/**
 * 监听一个事件，返回取消监听的函数。
 * 开发时 React 的 StrictMode 会把每个效果装两次，这里保证卸载时收干净。
 */
export function onEvent<T>(name: string, handler: (payload: T) => void): () => void {
  let off: (() => void) | null = null;
  let dead = false;
  const registering = listen<T>(name, (event) => handler(event.payload))
    .then((unlisten) => {
      if (dead) unlisten();
      else off = unlisten;
    })
    .catch(() => {});
  pending.add(registering);
  void registering.finally(() => pending.delete(registering));
  return () => {
    dead = true;
    if (off) off();
  };
}

/** 调一个不关心返回值的命令。失败时只在控制台留一条记录。 */
export function call(command: string, args?: Record<string, unknown>): void {
  invoke(command, args).catch((error) => console.error(`[ingwork] ${command}`, error));
}
