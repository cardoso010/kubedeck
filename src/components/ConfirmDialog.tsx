import { useState } from "react";

interface Props {
  title: string;
  message: string;
  confirmLabel: string;
  /** When set, the user must type this text to enable the button (used on production). */
  typeToConfirm?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

// window.confirm is not reliable inside every platform's webview, so dialogs are rendered in React.
export default function ConfirmDialog({ title, message, confirmLabel, typeToConfirm, onConfirm, onCancel }: Props) {
  const [typed, setTyped] = useState("");
  const ok = !typeToConfirm || typed === typeToConfirm;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{message}</p>
        {typeToConfirm && (
          <label className="field">
            <span>
              Type <code>{typeToConfirm}</code> to confirm
            </span>
            <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
        )}
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="danger" disabled={!ok} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
