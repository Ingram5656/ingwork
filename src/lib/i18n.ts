// 界面语言。写代码时直接用中文原文当 key：t("开始专注")。
// 带变量的写 t("休息 {n} 分钟", { n: 5 })。
// 每加一句中文，就在 i18n-en.ts 的表里补一句英文。
// 英文里单数复数不一样的词写成 {n:task|tasks}：n 是 1 时用前一个，否则用后一个。

import { EN } from "./i18n-en";
import { getSettings, useSettings, type Lang } from "./settings";

export type Vars = Record<string, string | number>;

const warned = new Set<string>();

function fill(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text
    .replace(/\{(\w+):([^|}]*)\|([^}]*)\}/g, (whole, name: string, one: string, many: string) =>
      name in vars ? (Number(vars[name]) === 1 ? one : many) : whole,
    )
    .replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

export function t(key: string, vars?: Vars): string {
  if (getSettings().lang !== "en") return fill(key, vars);
  const english = EN[key];
  if (english === undefined && !warned.has(key)) {
    warned.add(key);
    console.warn(`[ingwork] 缺英文：${key}`);
  }
  return fill(english ?? key, vars);
}

/** 后端返回的提示是中文，显示前过一遍翻译 */
export function tMsg(message: unknown): string {
  return t(typeof message === "string" ? message : "出了点问题，请再试一次");
}

/** 用到 t() 的组件调一次，切换语言时才会刷新 */
export function useLang(): Lang {
  const [settings] = useSettings();
  return settings.lang;
}
