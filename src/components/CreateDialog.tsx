import { useState } from "react";
import Editor from "@monaco-editor/react";
import { createResources, errorText } from "../api";
import { useCurrentTheme } from "../theme";
import { useReadOnly } from "../readOnly";

interface Props {
  /** Kind key of the current view, used to pick a starting template. */
  kindKey: string | null;
  namespaces: string[];
  defaultNamespace: string;
  production: boolean;
  context: string;
  onClose: () => void;
}

const TEMPLATES: Record<string, string> = {
  configmaps: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\ndata:\n  KEY: value\n",
  secrets: "apiVersion: v1\nkind: Secret\nmetadata:\n  name: my-secret\ntype: Opaque\nstringData:\n  password: change-me\n",
  deployments:
    "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: my-app\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: my-app\n  template:\n    metadata:\n      labels:\n        app: my-app\n    spec:\n      containers:\n        - name: app\n          image: nginx:1.27-alpine\n          ports:\n            - containerPort: 80\n          resources:\n            requests: { cpu: 50m, memory: 64Mi }\n            limits: { memory: 128Mi }\n",
  services: "apiVersion: v1\nkind: Service\nmetadata:\n  name: my-app\nspec:\n  selector:\n    app: my-app\n  ports:\n    - port: 80\n      targetPort: 80\n",
  namespaces: "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: my-namespace\n",
};

/** Creates objects from pasted YAML (several documents allowed), with a server-side dry run first. */
export default function CreateDialog({ kindKey, namespaces, defaultNamespace, production, context, onClose }: Props) {
  const monacoTheme = useCurrentTheme().monaco;
  const readOnly = useReadOnly();
  const [yaml, setYaml] = useState(TEMPLATES[kindKey ?? ""] ?? "# Paste one or more objects, separated by ---\n");
  const [namespace, setNamespace] = useState(defaultNamespace);
  const [result, setResult] = useState<{ ok: boolean; text: string; dry: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");

  async function run(dryRun: boolean) {
    setBusy(true);
    try {
      const created = await createResources(yaml, namespace, dryRun);
      setResult({ ok: true, dry: dryRun, text: `${dryRun ? "Valid, would create" : "Created"}:\n${created.map((c) => `  ${c}`).join("\n")}` });
      if (!dryRun) setTimeout(onClose, 900);
    } catch (e) {
      setResult({ ok: false, dry: dryRun, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const validated = result?.ok && result.dry;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-large" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>Create from YAML</strong>
          <label className="create-ns">
            <span className="faint">Namespace for objects without one</span>
            <select value={namespace} onChange={(e) => setNamespace(e.target.value)}>
              {[...new Set([defaultNamespace, ...namespaces])].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <button onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="create-editor">
          <Editor language="yaml" theme={monacoTheme} value={yaml} onChange={(v) => (setYaml(v ?? ""), setResult(null))} options={{ minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, tabSize: 2 }} />
        </div>
        {result && <pre className={`create-result ${result.ok ? "ok" : "bad"}`}>{result.text}</pre>}
        <div className="modal-actions create-actions">
          {readOnly && <span className="faint">Read-only mode: you can validate, not create.</span>}
          {production && validated && !readOnly && (
            <input placeholder={`type ${context.split("/").pop()} to create`} value={typed} onChange={(e) => setTyped(e.target.value)} />
          )}
          <button disabled={busy} onClick={() => void run(true)}>
            Validate (dry run)
          </button>
          <button className="primary" disabled={busy || readOnly || !validated || (production && typed !== context.split("/").pop())} title={validated ? undefined : "Validate first"} onClick={() => void run(false)}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
