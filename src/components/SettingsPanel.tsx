// 设置面板：左边分类，右边分组，像 iOS 的设置。
// 分组下面不放小字说明，一个选项的名字要自己说得清楚。

import { getVersion } from "@tauri-apps/api/app";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ambientName, setAmbientPreview, toggleAmbient, useAmbient } from "../lib/ambient";
import {
  removeBackground,
  saveBackground,
  setBackgroundError,
  useBackgroundError,
} from "../lib/background";
import {
  inspectFolder,
  moveTo,
  openFolder,
  pickFolder,
  useDataDir,
  type Inspection,
} from "../lib/datadir";
import { t, tMsg, useLang } from "../lib/i18n";
import { IS_MAC } from "../lib/platform";
import { PRESETS, PRESET_IDS, glow } from "../lib/palette";
import {
  DEFAULT_SETTINGS,
  DURATIONS,
  PHASES,
  useSettings,
  type BgMode,
  type CloseAction,
  type Lang,
  type Phase,
  type Settings,
  type ShortcutId,
  type SoundId,
  type ThemeChoice,
  type TranslateEngine,
  type WidgetLayer,
  type WidgetPlace,
  type WidgetSize,
} from "../lib/settings";
import {
  SHORTCUT_IDS,
  SHORTCUT_NAMES,
  accelFromEvent,
  accelKeys,
  useFailedShortcuts,
} from "../lib/shortcuts";
import { playSound } from "../lib/timer";
import { checkUpdate, installUpdate, useUpdate } from "../lib/update";
import { patchWidget, toggleWidget, useIngfyIsland, useWidgetError } from "../lib/windows";
import { IconClose } from "./Icons";
import { Segmented } from "./Segmented";

export type Category =
  | "timer"
  | "schedule"
  | "alert"
  | "translate"
  | "ambient"
  | "look"
  | "widget"
  | "keys"
  | "general";

const CATEGORIES: { id: Category; name: string }[] = [
  { id: "timer", name: "计时" },
  { id: "schedule", name: "课表" },
  { id: "alert", name: "提醒" },
  { id: "translate", name: "翻译" },
  { id: "ambient", name: "环境音" },
  { id: "look", name: "外观" },
  { id: "widget", name: "小组件" },
  { id: "keys", name: "快捷键" },
  { id: "general", name: "通用" },
];

const SOUNDS: { id: SoundId; name: string }[] = [
  { id: "bell", name: "钟声" },
  { id: "drop", name: "水滴" },
  { id: "chord", name: "和弦" },
  { id: "marimba", name: "木琴" },
  { id: "none", name: "不出声" },
];

const THEME_TITLES: Record<Phase, string> = {
  focus: "专注时的配色",
  shortBreak: "短休息时的配色",
  longBreak: "长休息时的配色",
};

// ---------- 小控件 ----------

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="group">
      {title ? <div className="group__title">{title}</div> : null}
      <div className="group__card">{children}</div>
    </section>
  );
}

function Row({ label, wrap, children }: { label: string; wrap?: boolean; children: ReactNode }) {
  return (
    <div className={wrap ? "row row--wrap" : "row"}>
      <div className="row__label">{label}</div>
      <div className="row__end">{children}</div>
    </div>
  );
}

function Toggle({
  on,
  label,
  disabled,
  onChange,
}: {
  on: boolean;
  label: string;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className="toggle"
      disabled={disabled}
      onClick={() => onChange(!on)}
    />
  );
}

function Slider({
  value,
  min,
  max,
  step = 1,
  label,
  text,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  /** 右边显示的字，例如"25 分钟" */
  text: string;
  onChange: (value: number) => void;
}) {
  const percent = ((value - min) / (max - min)) * 100;
  return (
    <div className="slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        style={{ "--p": `${percent}%` } as CSSProperties}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(Number(event.target.value))}
      />
      <span className="slider__value">{text}</span>
    </div>
  );
}

// ---------- 各分类 ----------

interface PageProps {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}


function TimerPage({ settings, update }: PageProps) {
  const minutes = (n: number) => t("{n} 分钟", { n });
  return (
    <>
      <Group title={t("每段多久")}>
        <Row label={t("专注")}>
          <Slider
            label={t("专注")}
            min={DURATIONS.focus.min}
            max={DURATIONS.focus.max}
            value={settings.focusMin}
            text={minutes(settings.focusMin)}
            onChange={(focusMin) => update({ focusMin })}
          />
        </Row>
        <Row label={t("短休息")}>
          <Slider
            label={t("短休息")}
            min={DURATIONS.shortBreak.min}
            max={DURATIONS.shortBreak.max}
            value={settings.shortMin}
            text={minutes(settings.shortMin)}
            onChange={(shortMin) => update({ shortMin })}
          />
        </Row>
        <Row label={t("长休息")}>
          <Slider
            label={t("长休息")}
            min={DURATIONS.longBreak.min}
            max={DURATIONS.longBreak.max}
            value={settings.longMin}
            text={minutes(settings.longMin)}
            onChange={(longMin) => update({ longMin })}
          />
        </Row>
      </Group>
      <Group title={t("节奏")}>
        <Row label={t("几轮专注后长休息")}>
          <Slider
            label={t("几轮专注后长休息")}
            min={2}
            max={8}
            value={settings.rounds}
            text={t("{n} 轮", { n: settings.rounds })}
            onChange={(rounds) => update({ rounds })}
          />
        </Row>
        <Row label={t("一段结束后自动开始下一段")}>
          <Toggle
            label={t("一段结束后自动开始下一段")}
            on={settings.autoStart}
            onChange={(autoStart) => update({ autoStart })}
          />
        </Row>
      </Group>
    </>
  );
}

function SchedulePrefsPage({ settings, update }: PageProps) {
  const lead = settings.classLead;
  return (
    <>
      <Group title={t("上课")}>
        <Row label={t("课前多久提醒，也是留给路上的时间")}>
          <Slider
            value={lead}
            min={0}
            max={30}
            step={5}
            label={t("课前多久提醒，也是留给路上的时间")}
            text={lead === 0 ? t("不提醒") : t("{n} 分钟", { n: lead })}
            onChange={(classLead) => update({ classLead })}
          />
        </Row>
        <Row label={t("离下节课不够一个番茄时提示改短这一段")}>
          <Toggle
            label={t("离下节课不够一个番茄时提示改短这一段")}
            on={settings.gapHint}
            onChange={(gapHint) => update({ gapHint })}
          />
        </Row>
      </Group>
      <Group title={t("专注时")}>
        <Row label={t("收起两边，只留倒计时、下节课和杂念箱")}>
          <Toggle
            label={t("收起两边，只留倒计时、下节课和杂念箱")}
            on={settings.focusLayout}
            onChange={(focusLayout) => update({ focusLayout })}
          />
        </Row>
      </Group>
    </>
  );
}

function TextRow({
  label,
  value,
  placeholder,
  secret,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  secret?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Row label={label}>
      <input
        className="field field--setting"
        type={secret ? "password" : "text"}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-label={label}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      />
    </Row>
  );
}

function TranslatePage({ settings, update }: PageProps) {
  const llm = settings.trLlm;
  const setLlm = (patch: Partial<typeof llm>) => update({ trLlm: { ...llm, ...patch } });
  const scale = Math.round(settings.popupScale * 100);
  return (
    <>
      <Group title={t("翻译引擎")}>
        <Row label={settings.trEngine === "llm" ? t("用自己的 OpenAI 兼容接口") : t("Google 翻译，连不上时换 MyMemory")}>
          <Segmented<TranslateEngine>
            small
            label={t("翻译引擎")}
            value={settings.trEngine}
            options={[
              { value: "google", label: t("免费接口") },
              { value: "llm", label: t("大模型") },
            ]}
            onChange={(trEngine) => update({ trEngine })}
          />
        </Row>
        {settings.trEngine === "llm" ? (
          <>
            <TextRow
              label={t("接口地址")}
              value={llm.baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(baseUrl) => setLlm({ baseUrl })}
            />
            <TextRow
              label="API Key"
              value={llm.apiKey}
              placeholder="sk-…"
              secret
              onChange={(apiKey) => setLlm({ apiKey })}
            />
            <TextRow
              label={t("模型")}
              value={llm.model}
              placeholder="gpt-4o-mini"
              onChange={(model) => setLlm({ model })}
            />
          </>
        ) : null}
      </Group>
      <Group title={t("小窗")}>
        <Row label={t("呼出翻译时填入刚复制的文字")}>
          <Toggle
            label={t("呼出翻译时填入刚复制的文字")}
            on={settings.trClipboard}
            onChange={(trClipboard) => update({ trClipboard })}
          />
        </Row>
        <Row label={t("翻译和杂念箱小窗的大小")}>
          <Slider
            value={scale}
            min={70}
            max={160}
            step={5}
            label={t("翻译和杂念箱小窗的大小")}
            text={`${scale}%`}
            onChange={(value) => update({ popupScale: value / 100 })}
          />
        </Row>
      </Group>
    </>
  );
}

function AlertPage({ settings, update }: PageProps) {
  return (
    <>
      <Group title={t("提示音")}>
        <Row label={t("一段结束时的声音")} wrap>
          <div className="chips" role="radiogroup" aria-label={t("一段结束时的声音")}>
            {SOUNDS.map((sound) => (
              <button
                key={sound.id}
                type="button"
                role="radio"
                aria-checked={settings.sound === sound.id}
                className="chip"
                onClick={() => {
                  update({ sound: sound.id });
                  playSound(sound.id, settings.volume);
                }}
              >
                {t(sound.name)}
              </button>
            ))}
          </div>
        </Row>
        <Row label={t("音量")}>
          <Slider
            label={t("音量")}
            min={0}
            max={100}
            step={5}
            value={Math.round(settings.volume * 100)}
            text={`${Math.round(settings.volume * 100)}%`}
            onChange={(percent) => update({ volume: percent / 100 })}
          />
        </Row>
      </Group>
      <Group title={t("到点时")}>
        <Row label={t("发系统通知")}>
          <Toggle
            label={t("发系统通知")}
            on={settings.notify}
            onChange={(notify) => update({ notify })}
          />
        </Row>
        <Row label={t("把主窗口叫出来")}>
          <Toggle
            label={t("把主窗口叫出来")}
            on={settings.raiseWindow}
            onChange={(raiseWindow) => update({ raiseWindow })}
          />
        </Row>
      </Group>
    </>
  );
}

function AmbientPage({ settings, update }: PageProps) {
  const { list, preview } = useAmbient();
  // 离开这一页时停止试听
  useEffect(() => () => setAmbientPreview(false), []);

  const setVolume = (id: string, volume: number) =>
    update({ ambientMix: { ...settings.ambientMix, [id]: volume } });

  return (
    <>
      <Group title={t("什么时候放")}>
        <Row label={t("专注时播放环境音")}>
          <Toggle label={t("专注时播放环境音")} on={settings.ambientOn} onChange={toggleAmbient} />
        </Row>
        <Row label={t("休息时也播放")}>
          <Toggle
            label={t("休息时也播放")}
            on={settings.ambientInBreaks}
            onChange={(ambientInBreaks) => update({ ambientInBreaks })}
          />
        </Row>
      </Group>
      <Group title={t("放哪些声音，各自多大声")}>
        {list.length === 0 ? (
          <div className="row">
            <div className="row__note">{t("还没有可以用的环境音")}</div>
          </div>
        ) : null}
        {list.map((id) => {
          const percent = Math.round((settings.ambientMix[id] ?? 0) * 100);
          return (
            <Row key={id} label={ambientName(id)}>
              <Slider
                label={ambientName(id)}
                min={0}
                max={100}
                step={5}
                value={percent}
                text={percent === 0 ? t("不放") : `${percent}%`}
                onChange={(value) => setVolume(id, value / 100)}
              />
            </Row>
          );
        })}
      </Group>
      <Group>
        <Row label={t("现在这样搭配是什么声音")}>
          <button
            type="button"
            className={preview ? "btn btn--primary btn--sm" : "btn btn--ghost btn--sm"}
            disabled={list.length === 0}
            onClick={() => setAmbientPreview(!preview)}
          >
            {preview ? t("停止试听") : t("试听")}
          </button>
        </Row>
      </Group>
    </>
  );
}

const BG_KIND_NAMES = { image: "图片", video: "视频" } as const;

/** 背景样式，和自己选的图片或视频 */
function BackgroundRows({ settings, update }: PageProps) {
  const input = useRef<HTMLInputElement>(null);
  const error = useBackgroundError();
  const [busy, setBusy] = useState(false);
  const media = settings.bgMedia;

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // 清空选择，这样下次再选同一个文件也会触发
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setBackgroundError("");
    try {
      const kind = await saveBackground(file);
      update({
        bgMode: "media",
        bgMedia: { kind, name: file.name, stamp: Date.now() },
        // 图片和视频通常比色块亮，暗度太低时字会看不清，顺手调高一些
        dim: Math.max(settings.dim, 0.45),
      });
    } catch (e) {
      setBackgroundError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    setBackgroundError("");
    update({ bgMedia: null });
    void removeBackground();
  };

  let pickLabel = t("选择图片或视频");
  if (busy) pickLabel = t("正在保存");
  else if (media) pickLabel = t("换一个{kind}", { kind: t(BG_KIND_NAMES[media.kind]) });

  return (
    <>
      <Row label={t("背景样式")}>
        <Segmented<BgMode>
          small
          label={t("背景样式")}
          value={settings.bgMode}
          options={[
            { value: "fluid", label: t("流体色块") },
            { value: "gradient", label: t("渐变") },
            { value: "media", label: t("图片或视频") },
          ]}
          onChange={(bgMode) => update({ bgMode })}
        />
      </Row>
      {settings.bgMode === "media" ? (
        <Row label={media ? media.name : t("还没有选图片或视频")}>
          {error ? <span className="row__note">{tMsg(error)}</span> : null}
          <input
            ref={input}
            type="file"
            accept="image/*,video/*"
            hidden
            aria-label={t("选择图片或视频")}
            onChange={(event: ChangeEvent<HTMLInputElement>) => void pick(event)}
          />
          <button
            type="button"
            className={media ? "btn btn--ghost btn--sm" : "btn btn--primary btn--sm"}
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            {pickLabel}
          </button>
          {media ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={remove}>
              {t("不再用这个{kind}", { kind: t(BG_KIND_NAMES[media.kind]) })}
            </button>
          ) : null}
        </Row>
      ) : null}
    </>
  );
}

function ThemeGroup({
  phase,
  settings,
  update,
  onPreview,
}: PageProps & { phase: Phase; onPreview: (phase: Phase) => void }) {
  const choice = settings.themes[phase];
  const set = (next: ThemeChoice) => {
    update({ themes: { ...settings.themes, [phase]: next } });
    onPreview(phase);
  };
  const customPair = { a: glow(choice.a), b: glow(choice.b) };

  return (
    <Group title={t(THEME_TITLES[phase])}>
      <Row label={t("配色")} wrap>
        <div className="chips" role="radiogroup" aria-label={t(THEME_TITLES[phase])}>
          {PRESET_IDS.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={choice.preset === id}
              className="chip chip--color"
              onClick={() => set({ preset: id, a: PRESETS[id].a, b: PRESETS[id].b })}
            >
              <span
                className="chip__swatch"
                style={{ "--a": PRESETS[id].a, "--b": PRESETS[id].b } as CSSProperties}
              />
              {t(PRESETS[id].name)}
            </button>
          ))}
          <button
            type="button"
            role="radio"
            aria-checked={choice.preset === "custom"}
            className="chip chip--color"
            onClick={() => set({ ...choice, preset: "custom" })}
          >
            <span
              className="chip__swatch"
              style={{ "--a": customPair.a, "--b": customPair.b } as CSSProperties}
            />
            {t("自选")}
          </button>
        </div>
      </Row>
      {choice.preset === "custom" ? (
        <Row label={t("自选颜色")}>
          <div className="wells">
            <label className="well">
              {t("起始色")}
              <input
                type="color"
                value={choice.a}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  set({ ...choice, a: event.target.value.toUpperCase() })
                }
              />
            </label>
            <label className="well">
              {t("结束色")}
              <input
                type="color"
                value={choice.b}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  set({ ...choice, b: event.target.value.toUpperCase() })
                }
              />
            </label>
          </div>
        </Row>
      ) : null}
    </Group>
  );
}

function LookPage({
  settings,
  update,
  onPreview,
}: PageProps & { onPreview: (phase: Phase) => void }) {
  return (
    <>
      {PHASES.map((phase) => (
        <ThemeGroup
          key={phase}
          phase={phase}
          settings={settings}
          update={update}
          onPreview={onPreview}
        />
      ))}
      <Group title={t("背景")}>
        <BackgroundRows settings={settings} update={update} />
        <Row label={t("色彩鲜艳度")}>
          <Slider
            label={t("色彩鲜艳度")}
            min={0}
            max={100}
            step={5}
            value={Math.round(settings.vivid * 100)}
            text={`${Math.round(settings.vivid * 100)}%`}
            onChange={(percent) => update({ vivid: percent / 100 })}
          />
        </Row>
        <Row label={t("背景暗度")}>
          <Slider
            label={t("背景暗度")}
            min={0}
            max={80}
            step={5}
            value={Math.round(settings.dim * 100)}
            text={`${Math.round(settings.dim * 100)}%`}
            onChange={(percent) => update({ dim: percent / 100 })}
          />
        </Row>
        <Row label={t("底色跟随配色")}>
          <Toggle
            label={t("底色跟随配色")}
            on={settings.baseFollows}
            onChange={(baseFollows) => update({ baseFollows })}
          />
        </Row>
        <Row label={t("显示进度光圈")}>
          <Toggle
            label={t("显示进度光圈")}
            on={settings.ring}
            onChange={(ring) => update({ ring })}
          />
        </Row>
      </Group>
    </>
  );
}

function WidgetPage({ settings }: PageProps) {
  const widget = settings.widget;
  const placed = widget.x !== null && widget.y !== null;
  const error = useWidgetError();
  const island = useIngfyIsland();
  // Mac 上可以放在刘海上；放在刘海上时，大小、层、锁定、位置这些都用不上
  const notch = IS_MAC && widget.place === "notch";
  let note = error ? tMsg(error) : "";
  if (!note && island && widget.open) note = t("ingfy 的灵动岛开着，番茄显示在那里");
  return (
    <>
      <Group title={t("桌面小组件")}>
        <Row label={t("显示桌面小组件")}>
          {note ? <span className="row__note">{note}</span> : null}
          <Toggle label={t("显示桌面小组件")} on={widget.open} onChange={toggleWidget} />
        </Row>
        {IS_MAC ? (
          <Row label={t("显示在")}>
            <Segmented<WidgetPlace>
              small
              label={t("显示在")}
              value={widget.place}
              options={[
                { value: "float", label: t("桌面浮窗") },
                { value: "notch", label: t("刘海") },
              ]}
              onChange={(place) => patchWidget({ place })}
            />
          </Row>
        ) : null}
        {notch ? null : (
          <>
            <Row label={t("大小")}>
              <Segmented<WidgetSize>
                small
                label={t("大小")}
                value={widget.size}
                options={[
                  { value: "small", label: t("小") },
                  { value: "medium", label: t("中") },
                ]}
                onChange={(size) => patchWidget({ size })}
              />
            </Row>
            <Row label={t("放在哪一层")}>
              <Segmented<WidgetLayer>
                small
                label={t("放在哪一层")}
                value={widget.layer}
                options={[
                  { value: "top", label: t("置顶悬浮") },
                  { value: "desktop", label: t("贴在桌面") },
                ]}
                onChange={(layer) => patchWidget({ layer })}
              />
            </Row>
            <Row label={t("锁定，鼠标穿过去点不到它")}>
              <Toggle
                label={t("锁定，鼠标穿过去点不到它")}
                on={widget.locked}
                disabled={!widget.open}
                onChange={(locked) => patchWidget({ locked })}
              />
            </Row>
          </>
        )}
      </Group>
      {notch ? null : (
        <Group>
          <Row label={t("位置")}>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={!placed}
              onClick={() => patchWidget({ x: null, y: null })}
            >
              {t("放回屏幕右下角")}
            </button>
          </Row>
        </Group>
      )}
    </>
  );
}

function ShortcutRow({
  id,
  settings,
  update,
  failed,
}: PageProps & { id: ShortcutId; failed: boolean }) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState("");
  const accel = settings.shortcuts[id];

  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(false);
        setHint("");
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        update({ shortcuts: { ...settings.shortcuts, [id]: "" } });
        setRecording(false);
        setHint("");
        return;
      }
      if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
      const next = accelFromEvent(event);
      if (!next) {
        setHint(IS_MAC ? t("要带上 ⌃、⌥ 或 ⌘") : t("要带上 Ctrl 或 Alt"));
        return;
      }
      const taken = SHORTCUT_IDS.find((other) => other !== id && settings.shortcuts[other] === next);
      if (taken) {
        setHint(t("已经用在「{name}」上了", { name: t(SHORTCUT_NAMES[taken]) }));
        return;
      }
      update({ shortcuts: { ...settings.shortcuts, [id]: next } });
      setRecording(false);
      setHint("");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, id, settings.shortcuts, update]);

  const keys = accelKeys(accel);
  let note = "";
  if (recording) note = hint;
  else if (failed && accel) note = t("被别的软件占用了，换一个组合");

  return (
    <Row label={t(SHORTCUT_NAMES[id])}>
      {note ? <span className="row__note">{note}</span> : null}
      <button
        type="button"
        className={recording ? "keys is-recording" : "keys"}
        onClick={() => {
          setRecording(!recording);
          setHint("");
        }}
        onBlur={() => setRecording(false)}
      >
        {recording
          ? t("按下新的组合")
          : keys.length > 0
            ? keys.map((key) => (
                <span key={key} className="kbd">
                  {key}
                </span>
              ))
            : t("点击设置")}
      </button>
    </Row>
  );
}

function KeysPage({ settings, update }: PageProps) {
  const failed = useFailedShortcuts();
  const isDefault =
    JSON.stringify(settings.shortcuts) === JSON.stringify(DEFAULT_SETTINGS.shortcuts);
  return (
    <>
      <Group title={t("全局快捷键")}>
        {SHORTCUT_IDS.map((id) => (
          <ShortcutRow
            key={id}
            id={id}
            settings={settings}
            update={update}
            failed={failed.has(id)}
          />
        ))}
      </Group>
      <Group>
        <Row label={t("恢复默认的快捷键")}>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={isDefault}
            onClick={() => update({ shortcuts: { ...DEFAULT_SETTINGS.shortcuts } })}
          >
            {t("恢复默认")}
          </button>
        </Row>
      </Group>
    </>
  );
}

/** 选了一个已经有数据的文件夹，等用户决定合并还是只用那边的 */
interface PendingMove {
  /** null 是换回本机的 */
  path: string | null;
  found: Inspection;
}

function DataGroup() {
  const dir = useDataDir();
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!dir) return null;

  const move = async (path: string | null, keep: boolean) => {
    setBusy(true);
    setError("");
    try {
      await moveTo(path, keep);
      setPending(null);
    } catch (e) {
      setError(tMsg(e));
    } finally {
      setBusy(false);
    }
  };

  // 先看看那边：空的就直接把这边的带过去；已经有数据就问一句
  const choose = async (path: string | null) => {
    setError("");
    setPending(null);
    setBusy(true);
    let found: Inspection;
    try {
      found = await inspectFolder(path ?? dir.defaultPath);
    } catch (e) {
      setBusy(false);
      setError(tMsg(e));
      return;
    }
    setBusy(false);
    if (found.problem) {
      setError(tMsg(found.problem));
      return;
    }
    if (found.same) return;
    if (found.tasks === null || found.tasks > 0 || found.records > 0) {
      setPending({ path, found });
      return;
    }
    await move(path, true);
  };

  const change = async () => {
    const path = await pickFolder();
    if (path) await choose(path);
  };

  let foundText = "";
  if (pending) {
    foundText =
      pending.found.tasks === null
        ? t("那边已经有数据，还没从网盘下载完")
        : t("那边已经有 {n} 个任务、{m} 条专注记录", {
            n: pending.found.tasks,
            m: pending.found.records,
          });
  }

  return (
    <Group title={t("数据")}>
      <div className="row row--wrap">
        <div className="row__label">{t("任务和专注记录存在")}</div>
        <div className="row__end">
          <button type="button" className="btn btn--ghost btn--sm" onClick={openFolder}>
            {t("打开")}
          </button>
          {dir.isDefault ? null : (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy}
              onClick={() => void choose(null)}
            >
              {t("换回本机")}
            </button>
          )}
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy}
            onClick={() => void change()}
          >
            {t("换一个文件夹")}
          </button>
        </div>
        <div className="row__detail">
          <span className="row__path">{dir.path}</span>
          {dir.isDefault ? (
            <span>{t("选一个 OneDrive 里的文件夹，几台电脑的任务和记录就会同步")}</span>
          ) : null}
          {error ? <span className="row__error">{error}</span> : null}
        </div>
      </div>
      {dir.unavailable ? (
        <div className="row row--wrap">
          <div className="row__label">{t("设好的文件夹现在打不开")}</div>
          <div className="row__end">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={busy}
              onClick={() => void move(dir.unavailable, true)}
            >
              {t("再试一次")}
            </button>
          </div>
          <div className="row__detail">
            <span className="row__path">{dir.unavailable}</span>
            <span>{t("可能是 OneDrive 还没登录。这段时间先存在本机，连上以后会合并过去")}</span>
          </div>
        </div>
      ) : null}
      {pending ? (
        <div className="row row--wrap" role="group" aria-label={foundText}>
          <div className="row__label">{foundText}</div>
          <div className="row__end">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              {t("取消")}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy}
              onClick={() => void move(pending.path, false)}
            >
              {t("只用那边的")}
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={busy}
              onClick={() => void move(pending.path, true)}
            >
              {t("合并两边")}
            </button>
          </div>
          <div className="row__detail">
            <span className="row__path">{pending.found.path}</span>
            <span>
              {t("合并：这台电脑上的任务和记录也带过去。只用那边的：这台的留在原来的文件夹，不删")}
            </span>
          </div>
        </div>
      ) : null}
    </Group>
  );
}

function GeneralPage({ settings, update }: PageProps) {
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartError, setAutostartError] = useState("");
  const [version, setVersion] = useState("");
  const updateState = useUpdate();

  useEffect(() => {
    let alive = true;
    isEnabled()
      .then((on) => {
        if (alive) setAutostart(on);
      })
      .catch(() => {
        if (alive) setAutostart(false);
      });
    getVersion()
      .then((v) => {
        if (alive) setVersion(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const toggleAutostart = async (on: boolean) => {
    setAutostartError("");
    try {
      if (on) await enable();
      else await disable();
      setAutostart(on);
    } catch {
      setAutostartError(t("没设置上，请再试一次"));
    }
  };

  let updateNote = version ? t("当前版本 {v}", { v: version }) : "";
  if (updateState.kind === "checking") updateNote = t("正在检查");
  else if (updateState.kind === "latest") updateNote = t("已经是最新版本");
  else if (updateState.kind === "available")
    updateNote = t("有新版本 {v}", { v: updateState.info.version });
  else if (updateState.kind === "downloading") updateNote = t("正在下载，下好会自动开始安装");
  else if (updateState.kind === "error") updateNote = tMsg(updateState.message);

  const canInstall = updateState.kind === "available";

  return (
    <>
      <Group title={t("语言")}>
        <Row label={t("界面语言")}>
          <Segmented<Lang>
            small
            label={t("界面语言")}
            value={settings.lang}
            options={[
              { value: "zh", label: "中文" },
              { value: "en", label: "English" },
            ]}
            onChange={(lang) => update({ lang })}
          />
        </Row>
      </Group>
      <Group title={t("启动")}>
        <Row label={t("开机时自动启动")}>
          {autostartError ? <span className="row__note">{autostartError}</span> : null}
          <Toggle
            label={t("开机时自动启动")}
            on={autostart === true}
            disabled={autostart === null}
            onChange={(on) => void toggleAutostart(on)}
          />
        </Row>
      </Group>
      <Group title={t("主窗口")}>
        <Row label={t("总在最前")}>
          <Toggle
            label={t("总在最前")}
            on={settings.alwaysOnTop}
            onChange={(alwaysOnTop) => update({ alwaysOnTop })}
          />
        </Row>
        <Row label={t("关闭主窗口时")}>
          <Segmented<CloseAction>
            small
            label={t("关闭主窗口时")}
            value={settings.closeAction}
            options={[
              { value: "ask", label: t("问我") },
              { value: "tray", label: IS_MAC ? t("留在菜单栏") : t("留在托盘") },
              { value: "quit", label: t("退出") },
            ]}
            onChange={(closeAction) => update({ closeAction })}
          />
        </Row>
        {IS_MAC ? (
          <Row label={t("只在菜单栏显示，不占程序坞")}>
            <Toggle
              label={t("只在菜单栏显示，不占程序坞")}
              on={settings.dockHidden}
              onChange={(dockHidden) => update({ dockHidden })}
            />
          </Row>
        ) : null}
      </Group>
      <DataGroup />
      <Group title={t("更新")}>
        <Row label={t("软件更新")}>
          {updateNote ? <span className="row__note">{updateNote}</span> : null}
          <button
            type="button"
            className={canInstall ? "btn btn--primary btn--sm" : "btn btn--ghost btn--sm"}
            disabled={updateState.kind === "checking" || updateState.kind === "downloading"}
            onClick={() => void (canInstall ? installUpdate() : checkUpdate())}
          >
            {canInstall ? t("立即更新") : t("检查更新")}
          </button>
        </Row>
      </Group>
    </>
  );
}

// ---------- 面板 ----------

interface Props {
  /** 打开时先显示哪一类 */
  initial?: Category;
  onClose: () => void;
  /** 正在调某个阶段的配色时，让背景临时换成那个阶段的颜色 */
  onPreview: (phase: Phase | null) => void;
}

export function SettingsPanel({ initial, onClose, onPreview }: Props) {
  useLang();
  const [settings, update] = useSettings();
  const [category, setCategory] = useState<Category>(initial ?? "timer");
  const current = CATEGORIES.find((c) => c.id === category) ?? CATEGORIES[0];

  // 离开"外观"或关掉面板时，背景回到当前阶段的颜色
  useEffect(() => {
    if (category !== "look") onPreview(null);
  }, [category, onPreview]);
  useEffect(() => () => onPreview(null), [onPreview]);

  const page: PageProps = { settings, update };

  return (
    <div className="settings glass glass--thick" role="dialog" aria-modal="true" aria-label={t("设置")}>
      <nav className="settings__nav">
        <h2 className="settings__title">{t("设置")}</h2>
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            className="navitem"
            aria-current={c.id === category}
            onClick={() => setCategory(c.id)}
          >
            {t(c.name)}
          </button>
        ))}
        <div className="settings__credit">Made by Ingram &amp; Claude</div>
      </nav>
      <div className="settings__main">
        <div className="settings__head">
          <h3 className="settings__heading">{t(current.name)}</h3>
          <button
            type="button"
            className="ibtn"
            title={t("关闭设置")}
            aria-label={t("关闭设置")}
            onClick={onClose}
          >
            <IconClose />
          </button>
        </div>
        <div className="settings__body">
          <div className="settings__page" key={category}>
            {category === "timer" ? <TimerPage {...page} /> : null}
            {category === "schedule" ? <SchedulePrefsPage {...page} /> : null}
            {category === "alert" ? <AlertPage {...page} /> : null}
            {category === "translate" ? <TranslatePage {...page} /> : null}
            {category === "ambient" ? <AmbientPage {...page} /> : null}
            {category === "look" ? <LookPage {...page} onPreview={onPreview} /> : null}
            {category === "widget" ? <WidgetPage {...page} /> : null}
            {category === "keys" ? <KeysPage {...page} /> : null}
            {category === "general" ? <GeneralPage {...page} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
