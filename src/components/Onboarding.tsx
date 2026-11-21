// 第一次打开时的引导：三步，放课表、认一下快捷键、试一条通知。
// 每一步都能跳过；走完或者跳过以后不再出现（设置里的 onboarded）。

import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { t, tMsg } from "../lib/i18n";
import { IS_MAC } from "../lib/platform";
import { updateSettings, useSettings } from "../lib/settings";
import { accelKeys, SHORTCUT_IDS, SHORTCUT_NAMES } from "../lib/shortcuts";
import type { Category } from "./SettingsPanel";

interface Props {
  /** 打开设置的某一页（引导先收起来，设置关了再接着走） */
  openSettings: (category: Category) => void;
}

/** 走到第几步。打开设置时引导会收起来（组件卸掉），回来要接着这一步 */
let lastStep = 0;

export function Onboarding({ openSettings }: Props) {
  const [settings] = useSettings();
  const [step, setStepState] = useState(lastStep);
  const setStep = (n: number) => {
    lastStep = n;
    setStepState(n);
  };
  const [note, setNote] = useState("");

  const finish = () => updateSettings({ onboarded: true });
  const next = () => {
    setNote("");
    if (step >= 2) finish();
    else setStep(step + 1);
  };
  const tryNotify = () => {
    setNote("");
    invoke("notify", { title: t("通知能收到"), body: t("课前、截止日期和排好的待办都会这样提醒你") })
      .then(() => setNote(t("没看到的话，到系统设置的通知里打开 ingwork")))
      .catch((e) => setNote(tMsg(String(e))));
  };

  const shown = SHORTCUT_IDS.filter((id) => settings.shortcuts[id]).slice(0, 4);

  return (
    <div className="sheet onboard glass glass--thick" role="dialog" aria-modal="true" aria-label={t("开始用 ingwork")}>
      <div className="onboard__dots" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span key={i} className={i === step ? "onboard__dot is-on" : "onboard__dot"} />
        ))}
      </div>

      {step === 0 ? (
        <>
          <h2 className="sheet__title">{t("先把课表放进来")}</h2>
          <p className="sheet__body">
            {t("学校给的 PDF、网页课表、.ics 文件都能导。放进来以后，时间轴会标出课和课之间的空档，课前也会提醒你。")}
          </p>
          <div className="sheet__actions">
            <button type="button" className="btn btn--ghost" onClick={next}>
              {t("先跳过")}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                setStep(1);
                openSettings("schedule");
              }}
            >
              {t("导入课表")}
            </button>
          </div>
        </>
      ) : null}

      {step === 1 ? (
        <>
          <h2 className="sheet__title">{t("记几个快捷键")}</h2>
          <p className="sheet__body">{t("在别的软件里也能按，不用切回来。")}</p>
          <ul className="onboard__keys">
            {shown.map((id) => (
              <li key={id}>
                <span>{t(SHORTCUT_NAMES[id])}</span>
                <span className="onboard__accel">
                  {accelKeys(settings.shortcuts[id]).map((key) => (
                    <kbd key={key}>{key}</kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <div className="sheet__actions">
            <button type="button" className="btn btn--ghost" onClick={() => openSettings("keys")}>
              {t("改快捷键")}
            </button>
            <button type="button" className="btn btn--primary" onClick={next}>
              {t("下一步")}
            </button>
          </div>
        </>
      ) : null}

      {step === 2 ? (
        <>
          <h2 className="sheet__title">{t("试一条通知")}</h2>
          <p className="sheet__body">
            {IS_MAC
              ? t("提醒都靠系统通知发出来。第一次发的时候 Mac 会问要不要允许，点允许。")
              : t("提醒都靠系统通知发出来。开了专注助手的话，记得把 ingwork 加到允许列表里。")}
          </p>
          {note ? <p className="onboard__note">{note}</p> : null}
          <div className="sheet__actions">
            <button type="button" className="btn btn--ghost" onClick={tryNotify}>
              {t("发一条试试")}
            </button>
            <button type="button" className="btn btn--primary" onClick={finish}>
              {t("开始用")}
            </button>
          </div>
        </>
      ) : null}

      {step < 2 ? (
        <button type="button" className="onboard__skip" onClick={finish}>
          {t("跳过引导")}
        </button>
      ) : null}
    </div>
  );
}
