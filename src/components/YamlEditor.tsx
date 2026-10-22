import { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { useCurrentTheme } from "../theme";
import { errorText, getYaml, replaceYaml, type Target } from "../api";
import ConfirmDialog from "./ConfirmDialog";
import { useReadOnly } from "../readOnly";

export default function YamlEditor({ target, production }: { target: Target; production: boolean }) {
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
      setStatus({ kind: "ok", text: "Saved." });
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
          Reload
        </button>
        <button
          className="primary"
          disabled={!dirty || saving || readOnly || masked}
          title={readOnly ? "Read-only mode" : masked ? "Reveal the values to edit this Secret" : undefined}
          onClick={() => (production ? setConfirming(true) : save())}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {secret &&
          (masked ? (
            <button onClick={() => (production ? setConfirmReveal(true) : (setRevealed(true), void load(true)))}>Reveal values</button>
          ) : (
            <button onClick={() => (setRevealed(false), void load(false))}>Hide values</button>
          ))}
        {masked && <span className="muted">values hidden</span>}
        {dirty && <span className="muted">unsaved changes</span>}
        {status && <span className={status.kind === "error" ? "bad" : "ok"}>{status.text}</span>}
      </div>
      <div className="yaml-editor">
        {original === null ? (
          <div className="empty">Loading…</div>
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
          title="Show production secret values?"
          message={`The values of ${target.name} will be visible on screen (and in screen shares).`}
          confirmLabel="Reveal"
          onConfirm={() => (setConfirmReveal(false), setRevealed(true), void load(true))}
          onCancel={() => setConfirmReveal(false)}
        />
      )}
      {confirming && (
        <ConfirmDialog
          title="Save to production?"
          message={`This replaces ${target.name} on a production cluster.`}
          confirmLabel="Save"
          typeToConfirm={target.name}
          onConfirm={save}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
