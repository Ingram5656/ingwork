/**
 * 助眠模式的雷声。不带声音文件，用噪声现做：
 * 一层闷闷的滚雷（低通滤过的噪声，音量起伏几下再慢慢拖远），近的雷前面再加一声脆的炸响。
 */

import { audioContext } from "./audio";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let live: AudioBufferSourceNode[] = [];

function ensure(): AudioContext | null {
  if (ctx) return ctx;
  ctx = audioContext();
  if (!ctx) return null;
  master = ctx.createGain();
  master.gain.value = 0.7;
  master.connect(ctx.destination);
  // 8 秒的"棕噪声"：比白噪声闷，像远处的轰隆声
  const n = ctx.sampleRate * 8;
  noise = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = noise.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    d[i] = last * 3.5;
  }
  return ctx;
}

/** 一层噪声：从 offset 处开始放，过一个滤波器，按 shape 走音量 */
function layer(c: AudioContext, at: number, dur: number, type: BiquadFilterType, from: number, to: number, shape: (g: AudioParam) => void) {
  if (!noise || !master) return;
  const src = c.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(from, at);
  f.frequency.exponentialRampToValueAtTime(to, at + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, at);
  shape(g.gain);
  g.gain.setTargetAtTime(0.0001, at + dur * 0.7, dur * 0.12);
  src.connect(f).connect(g).connect(master);
  src.start(at, Math.random() * 6);
  src.stop(at + dur + 0.5);
  live.push(src);
  src.onended = () => {
    live = live.filter((s) => s !== src);
  };
}

/**
 * 打一声雷。delay：闪电之后隔几秒才响（越远隔得越久）；near：0–1，越近越响、越脆。
 */
export function playThunder(delay: number, near: number) {
  const c = ensure();
  if (!c) return;
  if (c.state === "suspended") void c.resume().catch(() => {});
  const at = c.currentTime + Math.max(0.05, delay);
  const dur = 4 + Math.random() * 3;
  const loud = 0.35 + 0.65 * near;
  // 滚雷：先顶上去，再起伏几下，一下比一下弱
  layer(c, at, dur, "lowpass", 260 + 700 * near, 70, (g) => {
    g.exponentialRampToValueAtTime(loud, at + 0.12 + 0.2 * (1 - near));
    let t = at + 0.5;
    let level = loud * 0.75;
    while (t < at + dur * 0.7) {
      g.setTargetAtTime(level * (0.45 + Math.random() * 0.55), t, 0.12);
      t += 0.25 + Math.random() * 0.5;
      level *= 0.8;
    }
  });
  // 很低的一层垫在下面，拖得更久
  layer(c, at + 0.1, dur + 1.5, "lowpass", 110, 50, (g) => {
    g.exponentialRampToValueAtTime(loud * 0.9, at + 0.7);
  });
  // 近的雷：前面一声脆响
  if (near > 0.55) {
    layer(c, at, 0.5, "bandpass", 2400, 700, (g) => {
      g.exponentialRampToValueAtTime(0.22 * near, at + 0.015);
      g.setTargetAtTime(0.0001, at + 0.03, 0.07);
    });
  }
}

/** 关掉助眠模式（或关掉打雷）时：正在响的雷很快收掉 */
export function stopThunder() {
  if (!ctx || !master) return;
  const now = ctx.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setTargetAtTime(0, now, 0.15);
  for (const s of live) {
    try {
      s.stop(now + 0.6);
    } catch {
      /* 已经停了 */
    }
  }
  master.gain.setValueAtTime(0.7, now + 0.8);
}
