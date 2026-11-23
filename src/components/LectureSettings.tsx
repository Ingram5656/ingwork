// 设置里的"听课"一页：DeepSeek 密钥、试一下能不能用、怎么申请（一步一步）；
// 听写用哪个（DeepSeek 或 Groq 上的 Whisper）、老师讲课的语言；听哪里的声音、用哪个麦克风；上课时要不要问一声。
// 分组、开关用设置面板自己的，从外面传进来，样子保持一致。

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState, type ChangeEvent, type ComponentType, type ReactNode } from "react";
import { t, tMsg } from "../lib/i18n";
import type { Settings } from "../lib/settings";
import { call } from "../lib/tauri";
import { Segmented } from "./Segmented";

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

/** 申请 Groq 密钥的几步 */
const GROQ_STEPS: { text: string; detail?: string }[] = [
  {
    text: "打开 Groq 控制台，用邮箱、Google 或 GitHub 账号登录",
    detail: "没有账号的话，登录时会顺便注册，不用绑卡。在国内可能打不开，需要代理。",
  },
  {
    text: "点“Create API Key”，名字随便写，比如 ingwork",
  },
  {
    text: "马上点复制，粘到上面“Groq 密钥”的框里，再点“试一下”",
    detail: "密钥只显示这一次。丢了也没关系，删掉重新建一个就行。",
  },
  {
    text: "不用充值就能用",
    detail:
      "免费额度目前是每小时 2 小时、每天 8 小时的声音，平时上课够用。超了，或者 Groq 连不上，会自动换回 DeepSeek 听写，这节课不会断。",
  },
];

/** 一行设置，下面带一句说明（说明会换行，不会被截断） */
function Explained({ label, detail, children }: { label: string; detail: string; children: ReactNode }) {
  return (
    <div className="row row--wrap">
      <div className="row__label">{label}</div>
      <div className="row__end">{children}</div>
      <div className="row__detail">{detail}</div>
    </div>
  );
}

/** 用哪个麦克风：系统默认的，或者这台电脑上接着的某一个 */
function MicPicker({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  const [names, setNames] = useState<string[]>([]);
  const load = useCallback(() => {
    invoke<string[]>("lecture_inputs")
      .then((got) => setNames(got ?? []))
      .catch(() => setNames([]));
  }, []);
  useEffect(load, [load]);
  // 选过的那个现在没接着：照样列出来，不然看着像被改掉了
  const missing = value !== "" && !names.includes(value);
  return (
    <select
      className="field field--setting field--select"
      value={value}
      aria-label={t("用哪个麦克风")}
      // 点开前再找一遍：刚插上的耳机、话筒也能看到
      onMouseDown={load}
      onFocus={load}
      onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}
    >
      <option value="">{t("跟着系统默认的")}</option>
      {names.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
      {missing ? <option value={value}>{`${value}${t("（现在没接着）")}`}</option> : null}
    </select>
  );
}

export function LecturePrefsPage({ settings: s, update, Group, Row, Toggle }: Props) {
  const [show, setShow] = useState(false);
  const [showGroq, setShowGroq] = useState(false);
  const [checkingGroq, setCheckingGroq] = useState(false);
  const [groqResult, setGroqResult] = useState<{ ok: boolean; text: string } | null>(null);
  const groq = s.lectureAsr === "groq";
  const usingMic = s.lectureSource === "mic";

  const checkGroq = async () => {
    setCheckingGroq(true);
    setGroqResult(null);
    try {
      await invoke("lecture_check_groq_key", { key: s.lectureGroqKey.trim() });
      setGroqResult({ ok: true, text: t("能用，下一段开始就用它听写") });
    } catch (e) {
      setGroqResult({ ok: false, text: tMsg(String(e)) });
    } finally {
      setCheckingGroq(false);
    }
  };

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

      <Group title={t("听写")}>
        <Explained
          label={t("听写用哪个")}
          detail={
            groq
              ? t("Groq 上的 Whisper：能指定语言、带上这门课的术语，口音重的课更准。要另填一个 Groq 密钥；翻译和笔记还是用 DeepSeek。")
              : t("DeepSeek：不用另外申请。语言靠它自己猜，口音重、声音糊的时候可能听成别的语言。")
          }
        >
          <Segmented<Settings["lectureAsr"]>
            small
            label={t("听写用哪个")}
            value={s.lectureAsr}
            options={[
              { value: "deepseek", label: "DeepSeek" },
              { value: "groq", label: "Groq Whisper" },
            ]}
            onChange={(lectureAsr) => update({ lectureAsr })}
          />
        </Explained>
        {groq ? (
          <>
            <Row label={t("Groq 密钥")}>
              <div className="keyfield">
                <input
                  className="field field--setting keyfield__input"
                  type={showGroq ? "text" : "password"}
                  value={s.lectureGroqKey}
                  placeholder="gsk_…"
                  spellCheck={false}
                  autoComplete="off"
                  aria-label={t("Groq 密钥")}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    setGroqResult(null);
                    update({ lectureGroqKey: event.target.value.trim() });
                  }}
                />
                <button type="button" className="keyfield__eye" onClick={() => setShowGroq(!showGroq)}>
                  {showGroq ? t("藏起来") : t("显示")}
                </button>
              </div>
            </Row>
            <Row
              label={
                groqResult
                  ? groqResult.text
                  : s.lectureGroqKey.trim()
                    ? t("填好以后试一下能不能用")
                    : t("还没填，现在还是用 DeepSeek 听写")
              }
            >
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={!s.lectureGroqKey.trim() || checkingGroq}
                onClick={() => void checkGroq()}
              >
                {checkingGroq ? t("正在试") : t("试一下")}
              </button>
            </Row>
            {groqResult && !groqResult.ok ? <p className="row__error keyfield__error">{groqResult.text}</p> : null}
          </>
        ) : null}
        <Explained
          label={t("老师讲课的语言")}
          detail={
            s.lectureLanguage === "en"
              ? t("听成别的语言的地方算没听清：不翻译、不进笔记。")
              : t("不限语言，听成什么就是什么。")
          }
        >
          <Segmented<Settings["lectureLanguage"]>
            small
            label={t("老师讲课的语言")}
            value={s.lectureLanguage}
            options={[
              { value: "en", label: t("英文") },
              { value: "auto", label: t("不限") },
            ]}
            onChange={(lectureLanguage) => update({ lectureLanguage })}
          />
        </Explained>
      </Group>

      <Group title={t("声音来源")}>
        <Explained
          label={t("听哪里的声音")}
          detail={
            usingMic
              ? t("在教室里听课用麦克风。")
              : t("录电脑正在放的所有声音（网课、课程回放）。听课时把别的声音关掉，不然会一起录进去。")
          }
        >
          <Segmented<Settings["lectureSource"]>
            small
            label={t("听哪里的声音")}
            value={s.lectureSource}
            options={[
              { value: "mic", label: t("麦克风") },
              { value: "system", label: t("电脑的声音") },
            ]}
            onChange={(lectureSource) => update({ lectureSource })}
          />
        </Explained>
        {usingMic ? (
          <>
            <Row label={t("用哪个麦克风")}>
              <MicPicker value={s.lectureMic} onChange={(lectureMic) => update({ lectureMic })} />
            </Row>
            <Explained
              label={t("降噪")}
              detail={t("去掉空调、风扇这类一直响的声音。声音本来就清楚时别开，会把人声削坏，听写更容易出错。")}
            >
              <Toggle label={t("降噪")} on={s.lectureDenoise} onChange={(lectureDenoise) => update({ lectureDenoise })} />
            </Explained>
          </>
        ) : null}
      </Group>

      <Group title={t("听课")}>
        <Row label={t("上课时间到了问一下要不要开始听课")}>
          <Toggle
            label={t("上课时间到了问一下要不要开始听课")}
            on={s.lectureAsk}
            onChange={(lectureAsk) => update({ lectureAsk })}
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

      {groq ? (
        <Group title={t("怎么申请 Groq 密钥")}>
          <ol className="howto">
            {GROQ_STEPS.map((step, i) => (
              <li key={step.text} className="howto__step">
                <span className="howto__num" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="howto__text">
                  <p className="howto__main">{t(step.text)}</p>
                  {step.detail ? <p className="howto__detail">{t(step.detail)}</p> : null}
                  {i === 0 ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm howto__open"
                      onClick={() => call("lecture_open_platform", { site: "groq" })}
                    >
                      {t("打开 Groq 控制台")}
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </Group>
      ) : null}
    </>
  );
}
