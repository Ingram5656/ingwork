// Mac 触控板的轻震（见 src-tauri/src/haptics.rs）。Windows 上不调。
// 调到头以后再往外滑，每一格都会来一次"到头了"，这里压成至少隔 0.6 秒一次，不然一直嗡嗡响。

import { IS_MAC } from "./platform";
import { call } from "./tauri";

let lastEdge = 0;

export function haptic(kind: "tick" | "edge"): void {
  if (!IS_MAC) return;
  if (kind === "edge") {
    const now = Date.now();
    if (now - lastEdge < 600) return;
    lastEdge = now;
  }
  call("haptic", { kind });
}
