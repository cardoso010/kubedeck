import { useState } from "react";
import TypeToConfirm, { confirms } from "./TypeToConfirm";

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
  const ok = !typeToConfirm || confirms(typed, typeToConfirm);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{message}</p>
        {typeToConfirm && <TypeToConfirm expected={typeToConfirm} value={typed} onChange={setTyped} />}
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
