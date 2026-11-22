/**
 * 软件自己出的声音（助眠模式的雷声、环境音）共用的一个出口。
 * 第一次用到时才打开，免得没开助眠模式也占着声卡。
 */

let ctx: AudioContext | null = null;

export function audioContext(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext();
  } catch {
    return null;
  }
  // 浏览器内核有时要等人点过一下才让出声：点了、按了键以后把它叫醒
  const wake = () => {
    if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
  };
  window.addEventListener("pointerdown", wake);
  window.addEventListener("keydown", wake);
  return ctx;
}
