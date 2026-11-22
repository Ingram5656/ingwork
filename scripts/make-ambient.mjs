// 现做助眠模式的三种环境音：鸟声、车声、风声。不用录音，全是算出来的，没有版权问题。
//
// 用法（项目根目录）：
//   node scripts/make-ambient.mjs            → 在 src-tauri/sounds/ambient/ 写出 birds.wav、traffic.wav、wind.wav
//   然后转成 ogg（和别的环境音一样的格式）：
//   ffmpeg -i src-tauri/sounds/ambient/birds.wav -c:a libvorbis -q:a 4 src-tauri/sounds/ambient/birds.ogg
//
// 每个声音都要能无缝循环：多算 3 秒，把结尾那 3 秒叠到开头淡进去，接缝处听不出来。
// 随机数用固定的种子，每次生成的都一样。

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SR = 44100;
const FADE = 3;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "sounds", "ambient");

// ---------- 小工具 ----------

/** 固定种子的随机数 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 二阶滤波器（RBJ 的公式），可以边走边改频率 */
class Biquad {
  constructor(type, freq, q = 0.707) {
    this.type = type;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    this.set(freq, q);
  }
  set(freq, q = this.q) {
    this.q = q;
    const w = (2 * Math.PI * Math.min(freq, SR * 0.45)) / SR;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    let b0, b1, b2;
    if (this.type === "lowpass") {
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = b0;
    } else if (this.type === "highpass") {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = b0;
    } else {
      // bandpass，峰值增益 0 dB
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    }
    const a0 = 1 + alpha;
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** 粉噪音（Paul Kellet 的近似） */
function pink(rand) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  return () => {
    const w = rand() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    return out * 0.11;
  };
}

/** 褐噪音（白噪音积分，带一点泄漏免得漂走） */
function brown(rand) {
  let last = 0;
  return () => {
    last = (last + 0.02 * (rand() * 2 - 1)) / 1.02;
    return last * 3.5;
  };
}

/**
 * 慢慢起伏的曲线，0–1。几条整数圈数的正弦叠起来，正好在 period 秒走完一圈，循环时接得上
 */
function swell(rand, period, waves = [1, 2, 3, 5]) {
  const parts = waves.map((k) => ({ k, phase: rand() * Math.PI * 2, amp: 1 / Math.sqrt(k) }));
  const total = parts.reduce((s, p) => s + p.amp, 0);
  return (t) => {
    let v = 0;
    for (const p of parts) v += p.amp * Math.sin((2 * Math.PI * p.k * t) / period + p.phase);
    return 0.5 + (0.5 * v) / total;
  };
}

/** 两个声道里放一个声音：pan 从 -1（左）到 1（右），等功率 */
function panGains(pan) {
  const a = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
}

/** 叠出循环、统一响度（按 RMS 对齐到和原来那几种环境音差不多），写成 WAV */
function finish(name, L, R, seconds, targetDb) {
  const n = seconds * SR;
  const f = FADE * SR;
  const out = [new Float32Array(n), new Float32Array(n)];
  [L, R].forEach((x, ch) => {
    const o = out[ch];
    for (let i = 0; i < n; i++) o[i] = x[i];
    for (let i = 0; i < f; i++) {
      const a = (i / f) * (Math.PI / 2);
      o[i] = x[i] * Math.sin(a) + x[n + i] * Math.cos(a);
    }
  });
  let sum = 0;
  for (const o of out) for (let i = 0; i < n; i++) sum += o[i] * o[i];
  const rms = Math.sqrt(sum / (2 * n));
  let gain = Math.pow(10, targetDb / 20) / (rms || 1);
  let peak = 0;
  for (const o of out) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(o[i] * gain));
  if (peak > 0.6) gain *= 0.6 / peak; // 留余量，几种叠在一起也不爆
  const pcm = Buffer.alloc(44 + n * 4);
  pcm.write("RIFF", 0);
  pcm.writeUInt32LE(36 + n * 4, 4);
  pcm.write("WAVEfmt ", 8);
  pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20);
  pcm.writeUInt16LE(2, 22);
  pcm.writeUInt32LE(SR, 24);
  pcm.writeUInt32LE(SR * 4, 28);
  pcm.writeUInt16LE(4, 32);
  pcm.writeUInt16LE(16, 34);
  pcm.write("data", 36);
  pcm.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    for (let ch = 0; ch < 2; ch++) {
      const v = Math.max(-1, Math.min(1, out[ch][i] * gain));
      pcm.writeInt16LE(Math.round(v * 32767), 44 + i * 4 + ch * 2);
    }
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${name}.wav`), pcm);
  console.log(`${name}.wav  ${seconds}s`);
}

// ---------- 风声 ----------
// 粉噪音过一个会动的带通：阵风来时中心频率升高、声音变大；再垫一层低沉的呼呼声，
// 阵风大的时候偶尔带一点细细的呼啸。两个声道的噪音大半相同、小半各自不同，听着有宽度。

function wind() {
  const seconds = 32;
  const total = (seconds + FADE) * SR;
  const rand = rng(11);
  const shared = pink(rand);
  const own = [pink(rand), pink(rand)];
  const gust = swell(rand, seconds, [1, 2, 3, 4, 7]);
  const whistleCurve = swell(rand, seconds, [2, 3, 5]);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const body = [new Biquad("bandpass", 400, 0.6), new Biquad("bandpass", 400, 0.6)];
  const low = [new Biquad("lowpass", 140), new Biquad("lowpass", 140)];
  const whistle = [new Biquad("bandpass", 800, 9), new Biquad("bandpass", 800, 9)];
  let g = 0;
  for (let i = 0; i < total; i++) {
    const t = (i % (seconds * SR)) / SR;
    if (i % 64 === 0) {
      g = Math.pow(gust(t), 2.2);
      const w = whistleCurve(t);
      for (let ch = 0; ch < 2; ch++) {
        body[ch].set(170 + 650 * g + ch * 25, 0.55);
        whistle[ch].set(520 + 620 * w + ch * 40, 9);
      }
    }
    const s = shared();
    const outs = [L, R];
    for (let ch = 0; ch < 2; ch++) {
      const x = 0.72 * s + 0.28 * own[ch]();
      const v =
        body[ch].run(x) * (0.15 + 1.6 * g) +
        low[ch].run(x) * (0.55 + 0.6 * g) +
        whistle[ch].run(x) * 0.9 * g * g * whistleCurve(t);
      outs[ch][i] = v;
    }
  }
  finish("wind", L, R, seconds, -22);
}

// ---------- 车声 ----------
// 夜里窗外的马路：远处一直有低低的车流声，隔一阵有一辆车从一边开过去。
// 开过的那一辆：轮胎噪音和发动机声随距离变大再变小，过来时音高略高、开走时略低（多普勒），声像从一边移到另一边。

function traffic() {
  const seconds = 48;
  const total = (seconds + FADE) * SR;
  const rand = rng(23);
  const L = new Float32Array(total);
  const R = new Float32Array(total);

  // 远处的车流：褐噪音压得很低沉，慢慢起伏
  const hum = [brown(rand), brown(rand)];
  const humLp = [new Biquad("lowpass", 260), new Biquad("lowpass", 260)];
  const humLevel = swell(rand, seconds, [1, 2, 3]);
  for (let i = 0; i < total; i++) {
    const t = (i % (seconds * SR)) / SR;
    const k = 0.55 + 0.45 * humLevel(t);
    L[i] += humLp[0].run(hum[0]()) * 0.9 * k;
    R[i] += humLp[1].run(hum[1]()) * 0.9 * k;
  }

  // 一辆辆开过去的车
  let at = 1.5;
  while (at < seconds + FADE) {
    const dur = 5 + rand() * 4;
    const loud = 0.45 + rand() * 0.55;
    const dir = rand() < 0.5 ? -1 : 1;
    const engine = 65 + rand() * 55;
    const tire = new Biquad("bandpass", 700, 0.7);
    const hiss = new Biquad("highpass", 2200);
    const engLp = new Biquad("lowpass", 320);
    const noise = rand;
    let phase = 0;
    const start = Math.floor((at - dur / 2) * SR);
    const len = Math.floor(dur * SR);
    for (let j = 0; j < len; j++) {
      const i = start + j;
      if (i < 0 || i >= total) continue;
      const u = j / len - 0.5; // -0.5 刚开始，0 正好在窗前，0.5 开远了
      // 两头再乘一个渐弱，开远了就真的没声了，不会"咔"一下断掉
      const near = (1 / (1 + Math.pow(u * 9, 2))) * Math.pow(Math.cos(u * Math.PI), 2);
      const doppler = 1 - 0.05 * Math.tanh(u * 10);
      if (j % 64 === 0) tire.set(620 * doppler + 500 * near, 0.7);
      const w = noise() * 2 - 1;
      phase += (engine * doppler) / SR;
      phase -= Math.floor(phase);
      const saw = 2 * phase - 1;
      const v = (tire.run(w) * 1.4 + hiss.run(w) * 0.25 * near + engLp.run(saw) * 0.5) * near * loud;
      const [gl, gr] = panGains(Math.tanh(u * 7) * dir * 0.9);
      L[i] += v * gl;
      R[i] += v * gr;
    }
    at += 5 + rand() * 9;
  }
  finish("traffic", L, R, seconds, -24);
}

// ---------- 鸟声 ----------
// 清晨窗外的几只鸟，各叫各的调子，在左右不同的位置：
// 短促的"啾"（往下滑的一声）、一串颤音、两个音的口哨、连着两三声的"唧唧"。
// 底下垫一层很轻的风吹树叶声，再加两道短回声，像是在院子里。

function birds() {
  const seconds = 40;
  const total = (seconds + FADE) * SR;
  const rand = rng(37);
  const L = new Float32Array(total);
  const R = new Float32Array(total);

  // 树叶的沙沙声
  const bed = [pink(rand), pink(rand)];
  const bedHp = [new Biquad("highpass", 2500), new Biquad("highpass", 2500)];
  const leaves = swell(rand, seconds, [1, 3, 4]);
  for (let i = 0; i < total; i++) {
    const t = (i % (seconds * SR)) / SR;
    const k = 0.04 + 0.05 * leaves(t);
    L[i] += bedHp[0].run(bed[0]()) * k;
    R[i] += bedHp[1].run(bed[1]()) * k;
  }

  /** 一个音节：频率从 f0 滑到 f1，带一点颤 */
  const syllable = (start, dur, f0, f1, amp, pan, vib = 0) => {
    const n = Math.floor(dur * SR);
    const s0 = Math.floor(start * SR);
    const [gl, gr] = panGains(pan);
    let phase = 0;
    for (let j = 0; j < n; j++) {
      const i = s0 + j;
      if (i < 0 || i >= total) break;
      const x = j / n;
      // 先快后慢地滑过去，听着像鸟而不像哨子
      const f = f0 + (f1 - f0) * (1 - Math.pow(1 - x, 2)) + vib * Math.sin(2 * Math.PI * 28 * (j / SR)) * f0;
      phase += (2 * Math.PI * f) / SR;
      const env = Math.pow(Math.sin(Math.PI * x), 1.5);
      const v = (Math.sin(phase) + 0.12 * Math.sin(2 * phase)) * env * amp;
      L[i] += v * gl;
      R[i] += v * gr;
    }
  };

  const calls = {
    // 啾：一声往下滑
    tweet: (t, amp, pan, pitch) => {
      const n = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < n; k++) syllable(t + k * 0.16, 0.07 + rand() * 0.03, 4300 * pitch, 2900 * pitch, amp, pan);
      return n * 0.16;
    },
    // 一串颤音
    trill: (t, amp, pan, pitch) => {
      const n = 7 + Math.floor(rand() * 8);
      for (let k = 0; k < n; k++) syllable(t + k * 0.048, 0.03, 3000 * pitch, 4100 * pitch, amp * (0.7 + 0.3 * Math.sin((k / n) * Math.PI)), pan);
      return n * 0.048;
    },
    // 两个音的口哨
    whistle: (t, amp, pan, pitch) => {
      syllable(t, 0.24, 2250 * pitch, 2350 * pitch, amp * 0.8, pan, 0.006);
      syllable(t + 0.3, 0.3, 2750 * pitch, 2650 * pitch, amp * 0.8, pan, 0.006);
      return 0.65;
    },
    // 唧唧：高而短，连着几声
    chirp: (t, amp, pan, pitch) => {
      const n = 2 + Math.floor(rand() * 2);
      for (let k = 0; k < n; k++) syllable(t + k * 0.11, 0.045, 5200 * pitch, 6400 * pitch, amp * 0.8, pan);
      return n * 0.11;
    },
  };

  // 四只鸟：各有自己的位置、远近、调子和叫的频率
  const flock = [
    { kind: "tweet", pan: -0.6, amp: 0.5, pitch: 1, gap: [2.5, 6] },
    { kind: "trill", pan: 0.5, amp: 0.32, pitch: 1.04, gap: [5, 11] },
    { kind: "whistle", pan: 0.1, amp: 0.36, pitch: 0.97, gap: [6, 13] },
    { kind: "chirp", pan: 0.75, amp: 0.25, pitch: 1.02, gap: [3, 8] },
  ];
  for (const bird of flock) {
    let t = rand() * 3;
    while (t < seconds + FADE) {
      const amp = bird.amp * (0.75 + rand() * 0.25);
      const pitch = bird.pitch * (0.97 + rand() * 0.06);
      const used = calls[bird.kind](t, amp, bird.pan + (rand() - 0.5) * 0.15, pitch);
      t += used + bird.gap[0] + rand() * (bird.gap[1] - bird.gap[0]);
    }
  }

  // 两道短回声（左右交叉），像在院子里
  for (const [delay, gain] of [
    [0.043, 0.22],
    [0.097, 0.12],
  ]) {
    const d = Math.floor(delay * SR);
    for (let i = total - 1; i >= d; i--) {
      const l = L[i - d];
      const r = R[i - d];
      L[i] += r * gain;
      R[i] += l * gain;
    }
  }
  finish("birds", L, R, seconds, -27);
}

wind();
traffic();
birds();
