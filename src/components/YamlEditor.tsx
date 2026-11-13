import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Editor } from "./CodeEditor";
import { useCurrentTheme } from "../theme";
import { errorText, getYaml, replaceYaml, type Target } from "../api";
import ConfirmDialog from "./ConfirmDialog";
import DiffDialog from "./DiffDialog";
import { useReadOnly } from "../readOnly";

export default function YamlEditor({ target, production }: { target: Target; production: boolean }) {
  const { t } = useTranslation();
  const monacoTheme = useCurrentTheme().monaco;
  const [original, setOriginal] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const readOnly = useReadOnly();
  const secret = target.kindKey === "secrets";
  /** Secret values are shown (and editable) only after asking. */
  const [revealed, setRevealed] = useState(false);
  const [confirmReveal, setConfirmReveal] = useState(false);
  const masked = secret && !revealed;

  async function load(reveal = revealed) {
    setStatus(null);
    try {
      const yaml = await getYaml(target, reveal);
      setOriginal(yaml);
      setDraft(yaml);
    } catch (e) {
      setStatus({ kind: "error", text: errorText(e) });
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(), [target.kindKey, target.namespace, target.name]);

  async function save() {
    setConfirming(false);
    setSaving(true);
    try {
      const saved = await replaceYaml(target, draft);
      setOriginal(saved);
      setDraft(saved);
      setStatus({ kind: "ok", text: t("resources.yaml.saved") });
    } catch (e) {
      setStatus({ kind: "error", text: errorText(e) });
    } finally {
      setSaving(false);
    }
  }

  const dirty = original !== null && draft !== original;

  return (
    <div className="yaml">
      <div className="yaml-toolbar">
        <button onClick={() => void load()} disabled={saving}>
          {t("resources.yaml.reload")}
        </button>
        <button
          className="primary"
          disabled={!dirty || saving || readOnly || masked}
          title={readOnly ? t("resources.yaml.readOnly") : masked ? t("resources.yaml.revealToEdit") : undefined}
          onClick={() => setConfirming(true)}
        >
          {saving ? t("resources.yaml.saving") : t("common.save")}
        </button>
        {secret &&
          (masked ? (
            <button onClick={() => (production ? setConfirmReveal(true) : (setRevealed(true), void load(true)))}>{t("resources.yaml.reveal")}</button>
          ) : (
            <button onClick={() => (setRevealed(false), void load(false))}>{t("resources.yaml.hide")}</button>
          ))}
        {masked && <span className="muted">{t("resources.yaml.hidden")}</span>}
        {dirty && <span className="muted">{t("resources.yaml.unsaved")}</span>}
        {status && <span className={status.kind === "error" ? "bad" : "ok"}>{status.text}</span>}
      </div>
      <div className="yaml-editor">
        {original === null ? (
          <div className="empty">{t("common.loading")}</div>
        ) : (
          <Editor
            language="yaml"
            theme={monacoTheme}
            value={draft}
            onChange={(v) => setDraft(v ?? "")}
            options={{ minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, tabSize: 2, readOnly: masked }}
          />
        )}
      </div>
      {confirmReveal && (
        <ConfirmDialog
          title={t("resources.secrets.revealTitle")}
          message={t("resources.secrets.revealMessage", { name: target.name })}
          confirmLabel={t("resources.secrets.reveal")}
          onConfirm={() => (setConfirmReveal(false), setRevealed(true), void load(true))}
          onCancel={() => setConfirmReveal(false)}
        />
      )}
      {confirming && (
        <DiffDialog
          title={t(production ? "resources.yaml.saveProductionTitle" : "resources.yaml.saveTitle", { name: target.name })}
          original={original ?? ""}
          modified={draft}
          confirmLabel={t("common.save")}
          typeToConfirm={production ? target.name : undefined}
          onConfirm={save}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
