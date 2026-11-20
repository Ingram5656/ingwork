// 让浮层关掉时有退场动画：show 变成 false 后先播完退场，再真正卸载。
// 包出来的元素带 data-state="in" | "out"，样式按它播进场和退场。

import { useEffect, useState, type ReactNode } from "react";

interface Props {
  show: boolean;
  /** 退场动画多久（毫秒），播完才卸载 */
  exitMs?: number;
  /** 点浮层外面的暗底时 */
  onScrim?: () => void;
  /** 靠右的侧边面板：没有暗底，不挡住后面的界面 */
  side?: boolean;
  children: ReactNode;
}

export function Presence({ show, exitMs = 240, onScrim, side, children }: Props) {
  const [mounted, setMounted] = useState(show);

  useEffect(() => {
    if (show) {
      setMounted(true);
      return;
    }
    const id = window.setTimeout(() => setMounted(false), exitMs);
    return () => window.clearTimeout(id);
  }, [show, exitMs]);

  if (!show && !mounted) return null;

  return (
    <div className={side ? "overlay overlay--side" : "overlay"} data-state={show ? "in" : "out"}>
      {side ? null : <div className="overlay__scrim" onClick={onScrim} />}
      <div className="overlay__panel">{children}</div>
    </div>
  );
}
