// 设置里的"睡眠模式"一页：声音、天气、窗外景色、窗框（和 ingfy 的助眠模式设置一样）。
// 分组、开关、滑块用设置面板自己的，从外面传进来，样子保持一致。

import { useEffect, useRef, useState, type ChangeEvent, type ComponentType, type ReactNode } from "react";
import { useAmbient } from "../lib/ambient";
import { t, tMsg } from "../lib/i18n";
import type { Settings } from "../lib/settings";
import { SLEEP_FRAMES, type SleepFrame } from "../lib/sleep/frames";
import {
  deleteBackgroundVideo,
  downscaleImage,
  loadSleepImage,
  saveBackgroundVideo,
  saveSleepImage,
  useVideoPoster,
} from "../lib/sleep/media";
import { rainWord } from "../lib/sleep/rain";
import { paintScene, SLEEP_SCENES, type SleepScene } from "../lib/sleep/scenery";
import { openSleep, SLEEP_SOUNDS, useSleep } from "../lib/sleep/session";
import { IconCheck } from "./Icons";

interface Parts {
  Group: ComponentType<{ title?: string; children: ReactNode }>;
  Row: ComponentType<{ label: string; wrap?: boolean; children: ReactNode }>;
  Toggle: ComponentType<{ on: boolean; label: string; disabled?: boolean; onChange: (on: boolean) => void }>;
  Slider: ComponentType<{
    value: number;
    min: number;
    max: number;
    step?: number;
    label: string;
    text: string;
    onChange: (value: number) => void;
  }>;
}

interface Props extends Parts {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}

/** 内置景色的小预览：直接把景色画在一张小画布上 */
function SceneThumb({ scene }: { scene: Exclude<SleepScene, "custom" | "video"> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) paintScene(ref.current, 360, 200, scene, false, null);
  }, [scene]);
  return <canvas ref={ref} className="pick__canvas" />;
}

/** 窗框的小预览 */
function FrameThumb({ id }: { id: SleepFrame }) {
  const arch = "M68 64V28A22 22 0 0 1 112 28V64Z";
  return (
    <svg viewBox="0 0 180 68" preserveAspectRatio="xMidYMid slice" width="100%" height="100%" aria-hidden="true">
      <defs>
        <linearGradient id={`sf-${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#0B1030" />
          <stop offset="1" stopColor="#4A3B74" />
        </linearGradient>
      </defs>
      <rect width="180" height="68" fill={`url(#sf-${id})`} />
      <circle cx={id === "arch" ? 98 : 44} cy={id === "arch" ? 40 : 22} r={id === "arch" ? 3.5 : 5.5} fill="#EDEAE0" />
      {id === "none" ? (
        <g fill="rgba(255,255,255,0.5)">
          <circle cx="24" cy="46" r="2.2" />
          <circle cx="76" cy="44" r="3" />
          <circle cx="104" cy="22" r="1.8" />
          <circle cx="132" cy="50" r="2.4" />
          <circle cx="84" cy="14" r="1.4" />
          <circle cx="152" cy="30" r="1.6" />
        </g>
      ) : null}
      {id === "wood" ? (
        <g fill="#33241D">
          <path fillRule="evenodd" d="M0 0H180V68H0Z M8 6V57H172V6Z" />
          <rect x="88" y="6" width="4" height="51" />
          <rect x="8" y="27" width="164" height="4" />
          <rect y="57" width="180" height="11" fill="#48362B" />
        </g>
      ) : null}
      {id === "arch" ? (
        <g>
          <path fillRule="evenodd" fill="#171029" d={`M0 0H180V68H0Z ${arch}`} />
          <path
            d={`${arch} M68 28H112 M82.7 28V64 M97.3 28V64 M68 46H112 M90 28V6 M74.4 12.4L90 28L105.6 12.4`}
            fill="none"
            stroke="#0B0817"
            strokeWidth="1.6"
          />
        </g>
      ) : null}
    </svg>
  );
}

const Check = () => (
  <span className="pick__check">
    <IconCheck />
  </span>
);

export function SleepPage({ settings: s, update, Group, Row, Toggle, Slider }: Props) {
  const { open } = useSleep();
  const { list } = useAmbient();
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  const [image, setImage] = useState<string | null>(loadSleepImage);
  const [error, setError] = useState("");
  const poster = useVideoPoster("sleep");
  const hasVideo = poster !== null;
  const [importing, setImporting] = useState(false);
  const sunny = s.sleepRain <= 0;
  const a = s.sleepAngle;
  const sounds = SLEEP_SOUNDS.filter((sound) => list.length === 0 || list.includes(sound.id));

  const pickImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const url = await downscaleImage(file, 1920);
      if (!saveSleepImage(url)) {
        setError(t("图片太大了，换一张小一点的试试"));
        return;
      }
      setImage(url);
      setError("");
      update({ sleepScene: "custom" });
    } catch (e) {
      setError(tMsg(String((e as Error).message ?? e)));
    }
  };

  const pickVideo = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImporting(true);
    setError("");
    try {
      await saveBackgroundVideo(file, "sleep");
      update({ sleepScene: "video" });
    } catch (e) {
      setError(tMsg(String((e as Error).message ?? e)));
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <Group>
        <Row label={t("整个窗口变成一扇夜里下雨的窗")}>
          <button type="button" className="btn btn--ghost btn--sm" disabled={open} onClick={openSleep}>
            {open ? t("已经开着") : t("打开睡眠模式")}
          </button>
        </Row>
      </Group>

      <Group title={t("声音")}>
        <Row label={t("睡眠模式里放声音")}>
          <Toggle label={t("睡眠模式里放声音")} on={s.sleepSound} onChange={(sleepSound) => update({ sleepSound })} />
        </Row>
        {sounds.map(({ id, label }) => {
          const percent = Math.round((s.sleepAmbient[id] ?? 0) * 100);
          let text = percent === 0 ? t("不放") : `${percent}%`;
          if (percent > 0 && id === "rain" && sunny) text = t("晴天不响");
          return (
            <Row key={id} label={t(label)}>
              <Slider
                label={t(label)}
                min={0}
                max={100}
                step={5}
                value={percent}
                text={text}
                onChange={(v) => update({ sleepAmbient: { ...s.sleepAmbient, [id]: v / 100 } })}
              />
            </Row>
          );
        })}
      </Group>

      <Group title={t("天气")}>
        <Row label={t("雨量")}>
          <Slider
            label={t("雨量")}
            min={0}
            max={100}
            value={s.sleepRain}
            text={t(rainWord(s.sleepRain))}
            onChange={(sleepRain) => update({ sleepRain })}
          />
        </Row>
        <Row label={t("雨的角度")}>
          <Slider
            label={t("雨的角度")}
            min={-40}
            max={40}
            value={a}
            text={a === 0 ? t("直着下") : `${t(a < 0 ? "往左斜" : "往右斜")} ${Math.abs(a)}°`}
            onChange={(v) => update({ sleepAngle: Math.abs(v) <= 1 ? 0 : v })}
          />
        </Row>
        <Row label={t("打雷")}>
          <Toggle
            label={t("打雷")}
            on={s.sleepThunder && !sunny}
            disabled={sunny}
            onChange={(sleepThunder) => update({ sleepThunder })}
          />
        </Row>
      </Group>

      <Group title={t("窗外景色")}>
        <div className="row row--wrap">
          <div className="picks picks--scene" role="radiogroup" aria-label={t("窗外景色")}>
            {SLEEP_SCENES.map((o) => (
              <button
                key={o.id}
                type="button"
                className="pick"
                role="radio"
                aria-checked={s.sleepScene === o.id}
                onClick={() => update({ sleepScene: o.id })}
              >
                <span className="pick__thumb">
                  <SceneThumb scene={o.id} />
                  {s.sleepScene === o.id ? <Check /> : null}
                </span>
                <span>{t(o.label)}</span>
              </button>
            ))}
            <button
              type="button"
              className="pick"
              role="radio"
              aria-checked={s.sleepScene === "custom"}
              onClick={() => (image ? update({ sleepScene: "custom" }) : fileRef.current?.click())}
            >
              <span
                className="pick__thumb"
                style={image ? { backgroundImage: `url(${image})`, backgroundSize: "cover", backgroundPosition: "center" } : {}}
              >
                {!image ? <span className="pick__hint">{t("点击选择")}</span> : null}
                {s.sleepScene === "custom" && image ? <Check /> : null}
              </span>
              <span>{image ? t("我的图片") : t("选择图片")}</span>
            </button>
            <button
              type="button"
              className="pick"
              role="radio"
              aria-checked={s.sleepScene === "video"}
              disabled={importing}
              onClick={() => (hasVideo ? update({ sleepScene: "video" }) : videoRef.current?.click())}
            >
              <span
                className="pick__thumb"
                style={poster ? { backgroundImage: `url(${poster})`, backgroundSize: "cover", backgroundPosition: "center" } : {}}
              >
                {!hasVideo || importing ? (
                  <span className="pick__hint">{importing ? t("正在导入…") : t("点击选择")}</span>
                ) : null}
                {s.sleepScene === "video" && hasVideo ? <Check /> : null}
              </span>
              <span>{hasVideo ? t("我的视频") : t("选择视频")}</span>
            </button>
          </div>
          {image || hasVideo ? (
            <div className="picks__links">
              {image ? (
                <button type="button" className="linkbtn" onClick={() => fileRef.current?.click()}>
                  {t("换一张图片")}
                </button>
              ) : null}
              {hasVideo ? (
                <button type="button" className="linkbtn" disabled={importing} onClick={() => videoRef.current?.click()}>
                  {t("换一个视频")}
                </button>
              ) : null}
              {hasVideo ? (
                <button
                  type="button"
                  className="linkbtn"
                  disabled={importing}
                  onClick={() => {
                    void deleteBackgroundVideo("sleep");
                    if (s.sleepScene === "video") update({ sleepScene: "city" });
                  }}
                >
                  {t("删除视频")}
                </button>
              ) : null}
            </div>
          ) : null}
          {error ? <div className="row__error">{error}</div> : null}
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickImage} />
          <input
            ref={videoRef}
            type="file"
            accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.m4v"
            hidden
            onChange={pickVideo}
          />
        </div>
      </Group>

      <Group title={t("窗框")}>
        <div className="row row--wrap">
          <div className="picks picks--frame" role="radiogroup" aria-label={t("窗框")}>
            {SLEEP_FRAMES.map((o) => (
              <button
                key={o.id}
                type="button"
                className="pick"
                role="radio"
                aria-checked={s.sleepFrame === o.id}
                onClick={() => update({ sleepFrame: o.id })}
              >
                <span className="pick__thumb">
                  <FrameThumb id={o.id} />
                  {s.sleepFrame === o.id ? <Check /> : null}
                </span>
                <span>{t(o.label)}</span>
              </button>
            ))}
          </div>
        </div>
      </Group>
    </>
  );
}
