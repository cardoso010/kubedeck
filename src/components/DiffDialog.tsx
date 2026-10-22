import { useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { useCurrentTheme } from "../theme";

interface Props {
  title: string;
  original: string;
  modified: string;
  confirmLabel: string;
  /** When set, the user must type it to enable the button (production). */
  typeToConfirm?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Shows exactly what a save changes before it is sent. */
export default function DiffDialog({ title, original, modified, confirmLabel, typeToConfirm, onConfirm, onCancel }: Props) {
  const monacoTheme = useCurrentTheme().monaco;
  const [typed, setTyped] = useState("");
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal modal-large" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>{title}</strong>
          <span className="faint">left: on the cluster · right: what will be saved</span>
        </div>
        <div className="create-editor">
          <DiffEditor language="yaml" theme={monacoTheme} original={original} modified={modified} options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false }} />
        </div>
        <div className="modal-actions create-actions">
          {typeToConfirm && <input autoFocus placeholder={`type ${typeToConfirm} to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} />}
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={!!typeToConfirm && typed !== typeToConfirm} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
