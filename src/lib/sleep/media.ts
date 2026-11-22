import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";

/**
 * 睡眠模式窗外用的自己的视频和图片（从 ingfy 搬过来）。
 * 视频太大，不能像图片那样放进 localStorage，所以整个文件存进网页内核的 IndexedDB
 * （在软件自己的数据文件夹里，原文件挪走、删掉都不影响），播放时再取出来生成一个本地地址。
 * 另存一张小封面，给设置里的缩略图用。图片缩小成 JPEG 放 localStorage。
 */
const DB = "ingwork-media";
const STORE = "files";
export type VideoSlot = "sleep";
const SLOTS: Record<VideoSlot, { key: string; poster: string; event: string }> = {
  sleep: { key: "sleep-video", poster: "ingwork.sleepVideoPoster", event: "sleep-video-changed" },
};
/** 再大播放和导入都会很吃内存 */
export const MAX_VIDEO_BYTES = 400 * 1024 * 1024;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error ?? req.error);
      t.onabort = () => reject(t.error ?? new Error("aborted"));
    });
  } finally {
    db.close();
  }
}

/** 读出视频文件；没有返回 null */
async function loadVideoBlob(slot: VideoSlot): Promise<Blob | null> {
  try {
    const v = await tx<Blob | undefined>("readonly", (s) => s.get(SLOTS[slot].key) as IDBRequest<Blob | undefined>);
    return v instanceof Blob ? v : null;
  } catch {
    return null;
  }
}

/** 试着打开这个视频：能放就截一帧当封面（缩到 480 宽的 JPEG），放不了就报错 */
function probe(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    let done = false;
    const finish = (err: Error | null, poster = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      v.removeAttribute("src");
      v.load();
      URL.revokeObjectURL(url);
      if (err) reject(err);
      else resolve(poster);
    };
    const timer = setTimeout(() => finish(new Error("这个视频放不了，换一个 MP4 或 WebM 试试")), 15000);
    v.onerror = () => finish(new Error("这个视频放不了，换一个 MP4 或 WebM 试试"));
    v.onloadedmetadata = () => {
      if (!v.videoWidth || !v.videoHeight) return finish(new Error("这个视频放不了，换一个 MP4 或 WebM 试试"));
      // 跳到靠前一点的位置截封面，避开开头的黑场
      v.currentTime = Math.min(1, (v.duration || 0) * 0.1);
    };
    v.onseeked = () => {
      try {
        const w = Math.min(480, v.videoWidth);
        const h = Math.round((w / v.videoWidth) * v.videoHeight);
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d")!.drawImage(v, 0, 0, w, h);
        finish(null, c.toDataURL("image/jpeg", 0.8));
      } catch {
        finish(null, "");
      }
    };
    v.src = url;
  });
}

/** 存一个新的背景视频。超大、放不了、存不下都会抛出可以直接给人看的错误 */
export async function saveBackgroundVideo(file: File, slot: VideoSlot = "sleep"): Promise<void> {
  if (file.size > MAX_VIDEO_BYTES) throw new Error("视频太大了，请选 400 MB 以内的");
  const { key, poster: posterKey, event } = SLOTS[slot];
  const poster = await probe(file);
  try {
    await tx("readwrite", (s) => s.put(file, key));
  } catch {
    throw new Error("存不下这个视频，可能是磁盘空间不够");
  }
  try {
    if (poster) localStorage.setItem(posterKey, poster);
    else localStorage.removeItem(posterKey);
  } catch {
    // 封面存不下也不影响播放
  }
  await emit(event, null);
}

export async function deleteBackgroundVideo(slot: VideoSlot = "sleep"): Promise<void> {
  try {
    await tx("readwrite", (s) => s.delete(SLOTS[slot].key));
  } catch {
    // 本来就没有
  }
  localStorage.removeItem(SLOTS[slot].poster);
  await emit(SLOTS[slot].event, null);
}

function readPoster(slot: VideoSlot): string | null {
  try {
    return localStorage.getItem(SLOTS[slot].poster);
  } catch {
    return null;
  }
}

/** 设置里的缩略图：有视频时返回封面（截不到封面时返回空字符串），没有视频返回 null */
export function useVideoPoster(slot: VideoSlot = "sleep"): string | null {
  const [poster, setPoster] = useState<string | null>(() => readPoster(slot));
  const [has, setHas] = useState<boolean>(() => readPoster(slot) !== null);
  useEffect(() => {
    let alive = true;
    const check = () =>
      void loadVideoBlob(slot).then((b) => {
        if (!alive) return;
        setHas(!!b);
        setPoster(readPoster(slot));
      });
    check();
    const un = listen(SLOTS[slot].event, check);
    return () => {
      alive = false;
      void un.then((f) => f());
    };
  }, [slot]);
  return has ? poster ?? "" : null;
}

/**
 * 全屏背景（或助眠模式的窗外）：enabled 时取出视频生成播放地址，不用了就释放。
 * 返回 undefined 表示还在读，null 表示没有视频
 */
export function useBackgroundVideo(enabled: boolean, slot: VideoSlot = "sleep"): string | null | undefined {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const un = listen(SLOTS[slot].event, () => setVersion((v) => v + 1));
    return () => void un.then((f) => f());
  }, [slot]);
  useEffect(() => {
    if (!enabled) {
      setUrl(undefined);
      return;
    }
    let alive = true;
    let made: string | null = null;
    void loadVideoBlob(slot).then((b) => {
      if (!alive) return;
      made = b ? URL.createObjectURL(b) : null;
      setUrl(made);
    });
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [enabled, version, slot]);
  return url;
}

// ---------- 图片 ----------

const IMAGE_KEY = "ingwork.sleepImage";

/** 窗外用的自己的图片（data URL），没有是 null */
export function loadSleepImage(): string | null {
  try {
    return localStorage.getItem(IMAGE_KEY);
  } catch {
    return null;
  }
}

/** 存窗外的图片。返回 false 表示图片太大存不下 */
export function saveSleepImage(dataUrl: string | null): boolean {
  try {
    if (dataUrl) localStorage.setItem(IMAGE_KEY, dataUrl);
    else localStorage.removeItem(IMAGE_KEY);
    void emit("sleep-image-changed", null);
    return true;
  } catch {
    return false;
  }
}

export function useSleepImage(): string | null {
  const [img, setImg] = useState<string | null>(loadSleepImage);
  useEffect(() => {
    const un = listen("sleep-image-changed", () => setImg(loadSleepImage()));
    return () => void un.then((f) => f());
  }, []);
  return img;
}

/** 把用户选的图片缩到最长边 maxSide，转成 JPEG，控制体积 */
export function downscaleImage(file: File, maxSide = 1920): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.88));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("这个文件不是能打开的图片"));
    };
    img.src = url;
  });
}
