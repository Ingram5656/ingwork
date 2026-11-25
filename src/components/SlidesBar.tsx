// 听课页上的"课件"一行：这门课传过哪些课件，随时能再传一份或删掉。
// 课件是可选的：传了，专业词听写和翻译更准、笔记跟着课件的结构走。

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { t, tMsg, useLang } from "../lib/i18n";
import { slides, useMaterial } from "../lib/lecture";

interface Props {
  course: string;
  courseId: string | null;
  /** 开始之前那一页上多显示一句说明 */
  explain?: boolean;
}

export function SlidesBar({ course, courseId, explain }: Props) {
  useLang();
  const [material, setMaterial] = useMaterial(course, courseId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      setMaterial(await slides.add(course, courseId, file));
    } catch (e) {
      setError(tMsg(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  // 删课件要再点一次确认：删错了得重新上传、重新整理术语
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (armed === null) return;
    const timer = window.setTimeout(() => setArmed(null), 3000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const remove = async (name: string) => {
    if (armed !== name) {
      setArmed(name);
      return;
    }
    setArmed(null);
    try {
      setMaterial(await slides.remove(course, courseId, name));
    } catch (e) {
      setError(tMsg(String(e)));
    }
  };

  return (
    <div className="slides">
      <div className="slides__row">
        <span className="slides__label">{t("课件")}</span>
        {material.slides.map((s) => (
          <span key={s.name} className="slides__chip" title={s.name}>
            <span className="slides__name">{s.name}</span>
            <span className="slides__count">{t("{n} 个术语", { n: s.terms })}</span>
            <button
              type="button"
              className={armed === s.name ? "slides__remove is-armed" : "slides__remove"}
              aria-label={t("删掉 {name}", { name: s.name })}
              title={armed === s.name ? t("再点一次就删掉") : t("删掉这份课件")}
              onClick={() => void remove(s.name)}
            >
              {armed === s.name ? t("删掉？") : "×"}
            </button>
          </span>
        ))}
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={busy || !course.trim()}
          onClick={() => fileRef.current?.click()}
        >
          {busy ? t("正在读课件") : material.slides.length ? t("再传一份") : t("传课件")}
        </button>
        <input ref={fileRef} type="file" accept=".pdf,.pptx,.txt,.md" hidden onChange={(e: ChangeEvent<HTMLInputElement>) => void pick(e)} />
      </div>
      {error ? <p className="row__error slides__error">{error}</p> : null}
      {explain && material.slides.length === 0 && !error ? (
        <p className="slides__hint">{t("可选。传了课件，专业词听写和翻译更准；上课中也能随时传。")}</p>
      ) : null}
    </div>
  );
}
