// 自己选的背景图片或视频。
// 文件本身存在 IndexedDB 里（localStorage 放不下大东西），设置里只记"是图片还是视频、叫什么"。
// 图片先缩小再存；视频原样存，所以限制大小。存不下、放不了都要告诉用户，不悄悄失败。

import { useEffect, useState, useSyncExternalStore } from "react";
import type { BgMedia } from "./settings";

/** 视频最大多少 */
export const MAX_VIDEO_BYTES = 400 * 1024 * 1024;
/** 图片长边超过这么多就缩小 */
const MAX_IMAGE_SIDE = 2560;

const DB_NAME = "ingwork";
const STORE = "files";
const KEY = "background";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** 把图片缩到长边不超过 MAX_IMAGE_SIDE，存成 JPEG */
async function shrinkImage(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("这张图片打不开，换一张试试");
  }
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("这张图片打不开，换一张试试");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.88),
  );
  if (!blob) throw new Error("这张图片打不开，换一张试试");
  return blob;
}

/**
 * 把选的文件存成背景。成功返回它是图片还是视频；
 * 不行就抛出一句能直接给用户看的中文。
 */
export async function saveBackground(file: File): Promise<"image" | "video"> {
  let kind: "image" | "video";
  let blob: Blob;
  if (file.type.startsWith("image/")) {
    kind = "image";
    blob = await shrinkImage(file);
  } else if (file.type.startsWith("video/")) {
    if (file.size > MAX_VIDEO_BYTES) throw new Error("视频太大了，请选 400 MB 以内的");
    kind = "video";
    blob = file;
  } else {
    throw new Error("这个文件不是图片也不是视频");
  }
  try {
    await withStore("readwrite", (store) => store.put(blob, KEY));
  } catch {
    throw new Error("背景没存下来，可能是磁盘空间不够");
  }
  return kind;
}

export async function removeBackground(): Promise<void> {
  try {
    await withStore("readwrite", (store) => store.delete(KEY));
  } catch {
    // 删不掉也不要紧，设置里已经不再用它了，下次选新的会盖掉
  }
}

async function loadBackground(): Promise<Blob | null> {
  try {
    const value = await withStore<unknown>("readonly", (store) => store.get(KEY));
    return value instanceof Blob ? value : null;
  } catch {
    return null;
  }
}

// ---------- 出错时给设置面板看的一句话 ----------

let error = "";
const listeners = new Set<() => void>();

export function setBackgroundError(message: string): void {
  if (message === error) return;
  error = message;
  listeners.forEach((listener) => listener());
}

export function useBackgroundError(): string {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => error,
  );
}

/**
 * 背景文件的地址，给 <img> 或 <video> 用。没有选、还没读出来时是 null。
 * `media` 变了（换了文件）会重新读；用完的地址会收回。
 */
export function useBackgroundUrl(media: BgMedia | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const stamp = media ? media.stamp : 0;

  useEffect(() => {
    if (!stamp) {
      setUrl(null);
      return;
    }
    let alive = true;
    let made: string | null = null;
    void loadBackground().then((blob) => {
      if (!alive) return;
      if (!blob) {
        setUrl(null);
        return;
      }
      made = URL.createObjectURL(blob);
      setUrl(made);
    });
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [stamp]);

  return url;
}
