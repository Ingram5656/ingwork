// 分段控件：白色滑块在选项间滑动（位移用弹簧，宽度用 apple 曲线），
// 按住选中项时滑块轻收到 0.95。

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

export interface SegOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  options: SegOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** 小号，用在设置面板里 */
  small?: boolean;
  /** 读屏用的名字 */
  label: string;
}

export function Segmented<T extends string>({ options, value, onChange, small, label }: Props<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  const [pressing, setPressing] = useState(false);
  // 第一次定位不要动画，不然滑块会从最左边飞过来
  const [instant, setInstant] = useState(true);

  const index = options.findIndex((option) => option.value === value);
  const labels = options.map((option) => option.label).join("|");

  // 舞台是整体缩放的，这里用 offsetLeft / offsetWidth（排版尺寸），不受缩放影响
  useLayoutEffect(() => {
    const el = refs.current[index];
    if (!el) return;
    setThumb({ x: el.offsetLeft, w: el.offsetWidth });
  }, [index, labels, small]);

  useLayoutEffect(() => {
    if (!thumb || !instant) return;
    const id = requestAnimationFrame(() => setInstant(false));
    return () => cancelAnimationFrame(id);
  }, [thumb, instant]);

  const classes = ["seg"];
  if (small) classes.push("seg--sm", "seg--inset");
  if (pressing) classes.push("is-pressing");
  if (instant) classes.push("is-instant");

  return (
    <div className={classes.join(" ")} role="radiogroup" aria-label={label}>
      {thumb ? (
        <div
          className="seg__thumb"
          style={{ "--x": `${thumb.x}px`, width: thumb.w } as CSSProperties}
        />
      ) : null}
      {options.map((option, i) => (
        <button
          key={option.value}
          ref={(el: HTMLButtonElement | null) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className="seg__opt"
          onPointerDown={() => {
            if (option.value === value) setPressing(true);
          }}
          onPointerUp={() => setPressing(false)}
          onPointerLeave={() => setPressing(false)}
          onClick={() => {
            if (option.value !== value) onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
