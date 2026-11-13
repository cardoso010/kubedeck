import { useState } from "react";
import { useTranslation } from "react-i18next";
import TypeToConfirm, { confirms } from "./TypeToConfirm";
import Modal from "./Modal";

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
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const ok = !typeToConfirm || confirms(typed, typeToConfirm);
  return (
    <Modal onClose={onCancel}>
      <h3>{title}</h3>
      <p>{message}</p>
      {typeToConfirm && <TypeToConfirm expected={typeToConfirm} value={typed} onChange={setTyped} />}
      <div className="modal-actions">
        <button onClick={onCancel}>{t("common.cancel")}</button>
        <button className="danger" disabled={!ok} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
