import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DiffEditor } from "./CodeEditor";
import { useCurrentTheme } from "../theme";
import TypeToConfirm, { confirms } from "./TypeToConfirm";
import Modal from "./Modal";

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
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  return (
    <Modal className="modal-large" onClose={onCancel}>
      <div className="modal-header">
        <strong>{title}</strong>
        <span className="faint">{t("dialogs.diff.sides")}</span>
      </div>
      <div className="create-editor">
        <DiffEditor language="yaml" theme={monacoTheme} original={original} modified={modified} options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false }} />
      </div>
      <div className="modal-actions create-actions">
        {typeToConfirm && <TypeToConfirm expected={typeToConfirm} value={typed} onChange={setTyped} />}
        <button onClick={onCancel}>{t("common.cancel")}</button>
        <button className="primary" disabled={!!typeToConfirm && !confirms(typed, typeToConfirm)} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
