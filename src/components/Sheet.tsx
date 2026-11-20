// 居中的对话框。按钮上写清楚会发生什么，不写"确定""取消"。

export interface SheetAction {
  label: string;
  /** 主要按钮是白底的那个 */
  primary?: boolean;
  onPick: () => void;
}

export interface SheetSpec {
  title: string;
  body?: string;
  actions: SheetAction[];
}

export function Sheet({ spec }: { spec: SheetSpec }) {
  return (
    <div className="sheet glass glass--thick" role="dialog" aria-modal="true" aria-label={spec.title}>
      <h2 className="sheet__title">{spec.title}</h2>
      {spec.body ? <p className="sheet__body">{spec.body}</p> : null}
      <div className="sheet__actions">
        {spec.actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className={action.primary ? "btn btn--primary" : "btn btn--ghost"}
            onClick={action.onPick}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}
