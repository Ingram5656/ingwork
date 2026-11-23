// 设置里的"听课"一页：DeepSeek 密钥、试一下能不能用、怎么申请（一步一步），以及上课时要不要问一声。
// 分组、开关用设置面板自己的，从外面传进来，样子保持一致。

import { invoke } from "@tauri-apps/api/core";
import { useState, type ChangeEvent, type ComponentType, type ReactNode } from "react";
import { t, tMsg } from "../lib/i18n";
import type { Settings } from "../lib/settings";
import { call } from "../lib/tauri";

interface Parts {
  Group: ComponentType<{ title?: string; children: ReactNode }>;
  Row: ComponentType<{ label: string; wrap?: boolean; children: ReactNode }>;
  Toggle: ComponentType<{ on: boolean; label: string; disabled?: boolean; onChange: (on: boolean) => void }>;
}

interface Props extends Parts {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}

/** 申请 DeepSeek 密钥的几步。真的是一步接一步，所以用编号 */
const STEPS: { text: string; detail?: string }[] = [
  {
    text: "打开 DeepSeek 开放平台，用手机号或微信登录",
    detail: "没有账号的话，登录时会顺便注册。",
  },
  {
    text: "按提示完成实名认证",
    detail: "没认证的账号建不了密钥，也充不了钱。",
  },
  {
    text: "在“充值”里充一点钱",
    detail: "听课花得很少：语音听写一小时不到一块钱，翻译和整理笔记一节课大概几毛钱。充十块钱能用很久。",
  },
  {
    text: "左边菜单点“API Keys”，再点“创建 API Key”",
    detail: "名字随便写，比如 ingwork。",
  },
  {
    text: "马上点复制，粘到上面的框里，再点“试一下”",
    detail: "密钥只显示这一次，关掉就看不到了。丢了也没关系，删掉重新建一个就行。密钥只存在这台电脑上，换电脑要再填一次。",
  },
];

export function LecturePrefsPage({ settings: s, update, Group, Row, Toggle }: Props) {
  const [show, setShow] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const llm = s.trLlm;
  // 翻译小窗里填过 DeepSeek 的密钥：可以直接拿来用
  const reuse = !s.lectureKey && s.trEngine === "llm" && /deepseek\.com/i.test(llm.baseUrl) && llm.apiKey.trim();

  const check = async () => {
    setChecking(true);
    setResult(null);
    try {
      await invoke("lecture_check_key", { key: s.lectureKey.trim() });
      setResult({ ok: true, text: t("能用，可以开始听课了") });
    } catch (e) {
      setResult({ ok: false, text: tMsg(String(e)) });
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <Group title={t("DeepSeek 密钥")}>
        <Row label={t("密钥")}>
          <div className="keyfield">
            <input
              className="field field--setting keyfield__input"
              type={show ? "text" : "password"}
              value={s.lectureKey}
              placeholder="sk-…"
              spellCheck={false}
              autoComplete="off"
              aria-label={t("DeepSeek 密钥")}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                setResult(null);
                update({ lectureKey: event.target.value.trim() });
              }}
            />
            <button type="button" className="keyfield__eye" onClick={() => setShow(!show)}>
              {show ? t("藏起来") : t("显示")}
            </button>
          </div>
        </Row>
        {reuse ? (
          <Row label={t("翻译里填过 DeepSeek 的密钥")}>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => update({ lectureKey: llm.apiKey.trim() })}>
              {t("用这个")}
            </button>
          </Row>
        ) : null}
        <Row label={result ? result.text : t("填好以后试一下能不能用")}>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={!s.lectureKey.trim() || checking}
            onClick={() => void check()}
          >
            {checking ? t("正在试") : t("试一下")}
          </button>
        </Row>
        {result && !result.ok ? <p className="row__error keyfield__error">{result.text}</p> : null}
      </Group>

      <Group title={t("听课")}>
        <Row label={t("上课时间到了问一下要不要开始听课")}>
          <Toggle
            label={t("上课时间到了问一下要不要开始听课")}
            on={s.lectureAsk}
            onChange={(lectureAsk) => update({ lectureAsk })}
          />
        </Row>
        <Row label={t("降噪（只用于麦克风）：去掉空调、风扇这类一直响的声音。声音本来就清楚时别开，会把人声削坏")}>
          <Toggle
            label={t("降噪（只用于麦克风）：去掉空调、风扇这类一直响的声音。声音本来就清楚时别开，会把人声削坏")}
            on={s.lectureDenoise}
            onChange={(lectureDenoise) => update({ lectureDenoise })}
          />
        </Row>
        <Row label={t("保存录音，只存在这台电脑上")}>
          <Toggle
            label={t("保存录音，只存在这台电脑上")}
            on={s.lectureSaveAudio}
            onChange={(lectureSaveAudio) => update({ lectureSaveAudio })}
          />
        </Row>
      </Group>

      <Group title={t("怎么申请 DeepSeek 密钥")}>
        <ol className="howto">
          {STEPS.map((step, i) => (
            <li key={step.text} className="howto__step">
              <span className="howto__num" aria-hidden="true">
                {i + 1}
              </span>
              <div className="howto__text">
                <p className="howto__main">{t(step.text)}</p>
                {step.detail ? <p className="howto__detail">{t(step.detail)}</p> : null}
                {i === 0 ? (
                  <button type="button" className="btn btn--ghost btn--sm howto__open" onClick={() => call("lecture_open_platform")}>
                    {t("打开 DeepSeek 开放平台")}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </Group>
    </>
  );
}
