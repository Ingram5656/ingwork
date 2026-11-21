// 翻译小窗：从 ingtranslate 搬过来的。按快捷键在鼠标所在的屏幕上方呼出，打字即译，按 Esc 收起。
// 复制了文字再呼出会直接翻译；查单个英文单词时能加进生词本，休息时拿出来复习。
//
// 界面按 680 像素宽排版，再按设置里的"小窗大小"整体缩放；窗口大小跟着页面走（popup_fit）。
// 设置（引擎、大模型接口、目标语言）在主窗口的设置面板里，齿轮按钮会把那里打开。

import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { IconClose, IconGear, IconPin } from "../components/Icons";
import { t, useLang } from "../lib/i18n";
import { initPlanner, planner, usePlanner } from "../lib/planner";
import { IS_MAC } from "../lib/platform";
import { fitPopup, onPixelRatioChange } from "../lib/popups";
import { accelKeys } from "../lib/shortcuts";
import { initSettingsSync, updateSettings, useSettings } from "../lib/settings";
import { call, listening, onEvent } from "../lib/tauri";
import { useLook } from "../lib/theme";
import { initTimer, useTimer } from "../lib/timer";

const LABEL = "translate";

/** 目标语言。名字是界面上显示的中文 */
const LANGS: [string, string][] = [
  ["zh-CN", "中文"],
  ["en", "英语"],
  ["ja", "日语"],
  ["ko", "韩语"],
  ["fr", "法语"],
  ["de", "德语"],
  ["es", "西班牙语"],
  ["ru", "俄语"],
];
const NAME: Record<string, string> = Object.fromEntries(LANGS);
NAME.zh = NAME["zh-TW"] = NAME["zh-CN"];

interface DictEntry {
  pos: string;
  terms: string[];
}

interface Translation {
  text: string;
  src: string;
  tgt: string;
  engine: string;
  dict: DictEntry[];
}

/** 粗略判断原文语言（引擎回答之前先用它显示） */
function guessSource(text: string): string {
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[가-힯]/.test(text)) return "ko";
  if (/[一-鿿]/.test(text)) return "zh-CN";
  return "en";
}

const smartTarget = (text: string) => (guessSource(text) === "zh-CN" ? "en" : "zh-CN");

/** 单个外语单词才能进生词本 */
const SINGLE_WORD = /^[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'’-]{0,39}$/;

/** 译文拆成一个个"唱"出来的单位：每个汉字、假名、谚文一个，拉丁文一个词一个 */
function toUnits(text: string): string[] {
  const units: string[] = [];
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) {
      units.push(part);
      continue;
    }
    const pieces = part.match(/[぀-ヿ㐀-鿿가-힯＀-￯　-〿]|[^぀-ヿ㐀-鿿가-힯＀-￯　-〿]+/g);
    units.push(...(pieces ?? [part]));
  }
  return units;
}

function Output({ result, error }: { result: Translation | null; error: string }) {
  const [revealing, setRevealing] = useState(true);
  const text = result?.text ?? "";
  const units = toUnits(text);
  const words = units.filter((u) => !/^\s+$/.test(u)).length;
  const step = Math.min(42, 900 / Math.max(words, 1));
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const animate = !reduce && text.length <= 400;

  // 唱完换回普通文字，选中和复制才正常
  useEffect(() => {
    setRevealing(true);
    if (!animate) return;
    const id = window.setTimeout(() => setRevealing(false), words * step + 480);
    return () => window.clearTimeout(id);
  }, [text, animate, words, step]);

  if (error) return <p className="tr-output tr-output--error">{error}</p>;
  const cls = text.length > 120 ? "tr-output tr-output--long" : "tr-output";
  if (!animate || !revealing) {
    return (
      <p className={cls} aria-live="polite">
        {text}
      </p>
    );
  }
  let i = 0;
  return (
    <p className={cls} aria-live="polite" aria-label={text}>
      {units.map((u, k) =>
        /^\s+$/.test(u) ? (
          u
        ) : (
          <span key={k} className="tr-u" style={{ "--d": `${Math.round(i++ * step)}ms` } as CSSProperties}>
            {u}
          </span>
        ),
      )}
    </p>
  );
}

export function TranslateView() {
  useLang();
  const [settings] = useSettings();
  const timerState = useTimer();
  const plan = usePlanner();
  useLook(timerState.phase);

  const [input, setInput] = useState("");
  const [result, setResult] = useState<Translation | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [phase, setPhase] = useState<"in" | "out" | "">("");
  const [toast, setToast] = useState("");
  const [copied, setCopied] = useState(false);
  const [turned, setTurned] = useState(false);
  const [avail, setAvail] = useState(0);

  const panel = useRef<HTMLElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const reqId = useRef(0);
  const debounce = useRef<number | null>(null);
  const toastTimer = useRef<number | null>(null);

  const target = settings.trTarget || "auto";
  const resolved = (text: string) => (target === "auto" ? smartTarget(text) : target);

  // ---------- 启动 ----------

  useEffect(() => {
    initSettingsSync();
    initTimer();
    initPlanner();
    document.documentElement.classList.add("is-popup");
    // 等呼出、收起的监听都登记好、画出第一帧，再告诉后端可以呼出了
    let alive = true;
    void listening()
      .then(() => new Promise((resolve) => requestAnimationFrame(resolve)))
      .then(() => {
        if (alive) call("popup_ready", { label: LABEL });
      });
    return () => {
      alive = false;
    };
  }, []);

  // 界面整体缩放
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("zoom", String(settings.popupScale || 1));
  }, [settings.popupScale]);

  // 窗口大小跟着页面走：内容变了、窗口被系统改了大小（换到缩放不一样的屏幕）都重新量一次
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const zoom = settings.popupScale || 1;
    const report = () => {
      void fitPopup(LABEL, zoom).then((max) => {
        if (max > 0) setAvail(max);
      });
    };
    const observer = new ResizeObserver(report);
    observer.observe(el);
    window.addEventListener("resize", report);
    const offRatio = onPixelRatioChange(report);
    // 呼出时窗口可能换了屏幕，系统缩放跟着变要等一会儿：马上量一次，稍后再量一次
    let later = 0;
    const offSummoned = onEvent<unknown>(`${LABEL}-summoned`, () => {
      requestAnimationFrame(report);
      window.clearTimeout(later);
      later = window.setTimeout(report, 250);
    });
    report();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
      offRatio();
      offSummoned();
      window.clearTimeout(later);
    };
  }, [settings.popupScale]);

  const flash = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 1800);
  }, []);

  // ---------- 翻译 ----------

  const run = useCallback(
    async (text: string, force: boolean, to: string) => {
      if (debounce.current !== null) window.clearTimeout(debounce.current);
      const trimmed = text.trim();
      if (!trimmed) {
        setResult(null);
        setQuery("");
        setError("");
        setLoading(false);
        return;
      }
      if (!force && trimmed === query) return;
      const id = ++reqId.current;
      setLoading(true);
      try {
        const res = await invoke<Translation>("translate", { text: trimmed, target: to });
        if (id !== reqId.current) return;
        setQuery(trimmed);
        setResult(res);
        setError("");
      } catch (e) {
        if (id !== reqId.current) return;
        setQuery("");
        setResult(null);
        setError(typeof e === "string" ? t(e) : t("连不上翻译服务，检查网络后按 Enter 重试"));
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [query],
  );

  const onInput = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const text = event.target.value;
    setInput(text);
    if (debounce.current !== null) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => void run(text, false, target), 450);
  };

  // 输入框高度跟着内容走，最高 168
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [input, settings.popupScale]);

  // ---------- 呼出、收起 ----------

  useEffect(
    () =>
      onEvent<{ clip: string; maxPanel: number }>(`${LABEL}-summoned`, ({ clip, maxPanel }) => {
        if (maxPanel > 0) setAvail(maxPanel);
        setPhase("in");
        setMenuOpen(false);
        if (clip) {
          setInput(clip);
          void run(clip, true, target);
        }
        window.setTimeout(() => {
          field.current?.focus();
          field.current?.select();
        }, 30);
      }),
    [run, target],
  );

  useEffect(
    () =>
      onEvent<unknown>(`${LABEL}-dismiss`, () => {
        setPhase("out");
        if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
      }),
    [],
  );

  const hide = () => call("popup_hide", { label: LABEL });

  // ---------- 操作 ----------

  const copy = (andHide: boolean) => {
    if (!result?.text) return;
    invoke("clipboard_write", { text: result.text }).catch(() => flash(t("没复制上，请再试一次")));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
    if (andHide) window.setTimeout(hide, 160);
  };

  const speak = () => {
    if (!result?.text || typeof speechSynthesis === "undefined") return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(result.text);
    u.lang = result.tgt || resolved(input);
    speechSynthesis.speak(u);
  };

  const pickTarget = (code: string) => {
    setMenuOpen(false);
    updateSettings({ trTarget: code });
    void run(input, true, code);
    field.current?.focus();
  };

  const swap = () => {
    setTurned(!turned);
    const text = input.trim();
    if (!text) return;
    const src = result?.src || guessSource(text);
    const next = NAME[src] ? (src.startsWith("zh") ? "zh-CN" : src) : "auto";
    const newInput = result?.text ?? input;
    setInput(newInput);
    updateSettings({ trTarget: next });
    void run(newInput, true, next);
  };

  const togglePin = () => {
    const on = !pinned;
    setPinned(on);
    call("popup_pin", { label: LABEL, on });
    flash(on ? t("已固定，切到别的窗口也不会收起") : t("已取消固定"));
  };

  const openSettings = () => {
    call("open_main");
    void emit("open-settings", "translate");
    hide();
  };

  const setScale = (scale: number) => {
    const next = Math.round(Math.min(1.6, Math.max(0.7, scale)) * 100) / 100;
    updateSettings({ popupScale: next });
    flash(t("小窗大小 {n}%", { n: Math.round(next * 100) }));
  };

  // 单个外语单词：可以加进生词本
  const single = query && SINGLE_WORD.test(query) && result && !query.includes(" ");
  const inBook = single ? plan.words.some((w) => w.word.toLowerCase() === query.toLowerCase()) : false;
  const addWord = () => {
    if (!result) return;
    const meaning =
      result.dict.length > 0
        ? result.dict.map((d) => `${d.pos} ${d.terms.slice(0, 3).join("，")}`).join("；")
        : result.text;
    void planner.addWord(query, meaning).then((ok) => flash(ok ? t("加进生词本了") : t("没加上，请再试一次")));
  };

  // ---------- 键盘 ----------

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (menuOpen) setMenuOpen(false);
        else hide();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && ["=", "+", "-", "_", "0"].includes(event.key)) {
        event.preventDefault();
        const now = settings.popupScale || 1;
        if (event.key === "0") setScale(1);
        else setScale(now + (event.key === "-" || event.key === "_" ? -0.1 : 0.1));
        return;
      }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        copy(true);
        return;
      }
      if (event.altKey && event.code === "KeyS") {
        event.preventDefault();
        swap();
      }
      // 网页内核自己的快捷键（打印、查找）在这里没有意义
      if ((event.ctrlKey || event.metaKey) && !event.altKey && ["p", "f", "g", "j", "u"].includes(event.key.toLowerCase())) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onFieldKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      void run(input, true, target);
    }
  };

  // ---------- 画面 ----------

  const text = input.trim();
  const srcCode = result && query === text ? result.src : text ? guessSource(text) : "";
  const srcName = srcCode ? t(NAME[srcCode] ?? "自动检测") : t("自动检测");
  const tgtName = t(NAME[resolved(text)] ?? "中文");
  const keys = accelKeys(settings.shortcuts.translate);
  const showResult = !!(result || error);

  const panelClasses = ["tr-panel"];
  if (phase === "in") panelClasses.push("is-in");
  if (phase === "out") panelClasses.push("is-out");

  return (
    <main
      ref={panel}
      className={panelClasses.join(" ")}
      style={avail > 0 ? ({ "--avail": `${avail}px` } as CSSProperties) : undefined}
    >
      <div className="tr-aura" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>

      <header className="tr-bar" data-tauri-drag-region>
        <div className="tr-langs glass">
          <span className="tr-lang tr-lang--src">{srcName}</span>
          <button
            type="button"
            className={turned ? "tr-swap is-turn" : "tr-swap"}
            title={IS_MAC ? t("交换语言（⌥S）") : t("交换语言（Alt+S）")}
            aria-label={t("交换语言")}
            onClick={swap}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 7h11l-3-3M16 13H5l3 3" />
            </svg>
          </button>
          <button
            type="button"
            className="tr-lang tr-lang--tgt"
            aria-haspopup="listbox"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {tgtName}
            {target === "auto" ? <b className="tr-dot" title={t("智能：中英互译")} /> : null}
            <svg className="tr-caret" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 4.5 6 7.5 9 4.5" />
            </svg>
          </button>
        </div>
        <div className="tr-tools">
          <button
            type="button"
            className="ibtn ibtn--sm"
            title={t("固定窗口（失去焦点时不收起）")}
            aria-label={t("固定窗口")}
            aria-pressed={pinned}
            onClick={togglePin}
          >
            <IconPin />
          </button>
          <button
            type="button"
            className="ibtn ibtn--sm"
            title={t("翻译设置")}
            aria-label={t("翻译设置")}
            onClick={openSettings}
          >
            <IconGear />
          </button>
        </div>
      </header>

      {menuOpen ? (
        <div className="tr-menu" role="listbox" aria-label={t("目标语言")}>
          {[["auto", "智能"] as [string, string], ...LANGS].map(([code, name]) => (
            <button
              key={code}
              type="button"
              role="option"
              aria-selected={code === target}
              className={code === "auto" ? "tr-opt tr-opt--smart" : "tr-opt"}
              onClick={() => pickTarget(code)}
            >
              {code === "auto" ? <b className="tr-dot" /> : null}
              {t(name)}
              {code === "auto" ? <small>{t("中文和英语自动互译")}</small> : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className="tr-source">
        <textarea
          ref={field}
          rows={1}
          spellCheck={false}
          autoComplete="off"
          placeholder={t("输入或粘贴文字")}
          value={input}
          onChange={onInput}
          onKeyDown={onFieldKey}
        />
        {input ? (
          <button
            type="button"
            className="ibtn ibtn--sm tr-clear"
            title={t("清空")}
            aria-label={t("清空")}
            onClick={() => {
              setInput("");
              void run("", true, target);
              field.current?.focus();
            }}
          >
            <IconClose />
          </button>
        ) : null}
      </div>

      <div className={loading ? "tr-rule is-loading" : "tr-rule"} aria-hidden="true" />

      {showResult ? (
        <div className="tr-result">
          <Output result={result} error={error} />
          {result && result.dict.length > 0 ? (
            <dl className="tr-dict">
              {result.dict.map((entry) => (
                <div key={entry.pos}>
                  <dt>{entry.pos}</dt>
                  <dd>{entry.terms.join("，")}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {result ? (
            <div className="tr-actions">
              <button type="button" className={copied ? "tr-chip is-done" : "tr-chip"} onClick={() => copy(false)}>
                {copied ? t("已复制") : t("复制")}
              </button>
              <button type="button" className="tr-chip" onClick={speak}>
                {t("朗读")}
              </button>
              {single ? (
                inBook ? (
                  <span className="tr-hint tr-hint--on">{t("已在生词本")}</span>
                ) : (
                  <button type="button" className="tr-chip" onClick={addWord}>
                    {t("加入生词本")}
                  </button>
                )
              ) : null}
              <span className="tr-hint tr-push">
                <kbd>{IS_MAC ? "⌘" : "Ctrl"}</kbd>
                <kbd>{IS_MAC ? "↩" : "Enter"}</kbd> {t("复制并收起")}
              </span>
            </div>
          ) : null}
        </div>
      ) : (
        <footer className="tr-idle">
          {keys.length > 0 ? (
            <span className="tr-hint">
              {keys.map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}{" "}
              {t("呼出")}
            </span>
          ) : null}
          <span className="tr-hint">
            <kbd>{IS_MAC ? "↩" : "Enter"}</kbd> {t("立即翻译")}
          </span>
          <span className="tr-hint">
            <kbd>Esc</kbd> {t("收起")}
          </span>
        </footer>
      )}

      <div className={toast ? "tr-toast is-on" : "tr-toast"} role="status">
        {toast}
      </div>
    </main>
  );
}
