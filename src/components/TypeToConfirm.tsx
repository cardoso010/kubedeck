import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconCheck, IconCopy } from "@tabler/icons-react";

/** Whether what the user typed confirms `expected` (surrounding spaces from a paste are fine). */
export const confirms = (typed: string, expected: string) => typed.trim() === expected;

interface Props {
  expected: string;
  value: string;
  onChange: (value: string) => void;
}

/**
 * The "type the name to confirm" field for production. The name is shown exactly as it must be
 * typed (outside any uppercase label) and can be selected or copied.
 */
export default function TypeToConfirm({ expected, value, onChange }: Props) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard.writeText(expected).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  return (
    <div className="type-confirm">
      <div className="type-confirm-hint">
        <span>{t("dialogs.typeToConfirm.type")}</span>
        <code className="confirm-name">{expected}</code>
        <button type="button" className="icon-button" title={t("dialogs.typeToConfirm.copyName")} aria-label={t("dialogs.typeToConfirm.copyName")} onClick={copy}>
          {copied ? <IconCheck size={13} className="ok" /> : <IconCopy size={13} />}
        </button>
        <span>{t("dialogs.typeToConfirm.toConfirm")}</span>
      </div>
      <input autoFocus value={value} onChange={(e) => onChange(e.target.value)} aria-label={t("dialogs.typeToConfirm.label", { name: expected })} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
    </div>
  );
}
