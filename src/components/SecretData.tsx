import { useEffect, useState } from "react";
import { IconCopy, IconEye, IconEyeOff } from "@tabler/icons-react";
import { errorText, secretKeys, secretValue } from "../api";
import ConfirmDialog from "./ConfirmDialog";

interface Props {
  namespace: string;
  name: string;
  production: boolean;
}

/** A Secret's keys; each value is fetched and decoded only when revealed or copied. */
export default function SecretData({ namespace, name, production }: Props) {
  const [keys, setKeys] = useState<{ key: string; bytes: number }[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  /** On production, revealing asks once per drawer. */
  const [allowed, setAllowed] = useState(!production);
  const [asking, setAsking] = useState<{ key: string; copy: boolean } | null>(null);

  useEffect(() => {
    secretKeys(namespace, name).then(setKeys, (e) => setError(errorText(e)));
  }, [namespace, name]);

  async function fetchValue(key: string): Promise<string> {
    const v = await secretValue(namespace, name, key);
    return v.text ?? `(binary, base64) ${v.base64}`;
  }

  async function act(key: string, copy: boolean) {
    if (!allowed) return setAsking({ key, copy });
    setError(null);
    try {
      if (copy) {
        await navigator.clipboard.writeText(values[key] ?? (await fetchValue(key)));
        setCopied(key);
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
      } else if (key in values) {
        setValues(({ [key]: _, ...rest }) => rest);
      } else {
        const text = await fetchValue(key);
        setValues((v) => ({ ...v, [key]: text }));
      }
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (error && !keys) return <div className="error-bar">{error}</div>;
  if (!keys) return <div className="empty">Loading…</div>;
  if (keys.length === 0) return <div className="empty">This Secret has no data.</div>;

  return (
    <div className="secret-data">
      {error && <div className="error-bar">{error}</div>}
      {keys.map(({ key, bytes }) => (
        <div key={key} className="secret-row">
          <div className="secret-head">
            <code>{key}</code>
            <span className="faint">{bytes} bytes</span>
            <span className="spacer" />
            <button className="icon-button" title={key in values ? "Hide" : "Reveal"} onClick={() => void act(key, false)}>
              {key in values ? <IconEyeOff size={14} /> : <IconEye size={14} />}
            </button>
            <button className="icon-button" title="Copy the value" onClick={() => void act(key, true)}>
              <IconCopy size={14} />
            </button>
            {copied === key && <span className="ok">copied</span>}
          </div>
          <pre className={`secret-value ${key in values ? "" : "hidden"}`}>{values[key] ?? "••••••••"}</pre>
        </div>
      ))}
      {asking && (
        <ConfirmDialog
          title="Show production secret values?"
          message={`Values of ${name} will be ${asking.copy ? "copied to the clipboard" : "visible on screen (and in screen shares)"}. You will not be asked again until you leave this tab.`}
          confirmLabel={asking.copy ? "Copy" : "Reveal"}
          onConfirm={() => {
            const next = asking;
            setAsking(null);
            setAllowed(true);
            // allowed is applied on the next render; act directly here.
            void (async () => {
              try {
                const text = values[next.key] ?? (await fetchValue(next.key));
                if (next.copy) await navigator.clipboard.writeText(text);
                else setValues((v) => ({ ...v, [next.key]: text }));
              } catch (e) {
                setError(errorText(e));
              }
            })();
          }}
          onCancel={() => setAsking(null)}
        />
      )}
    </div>
  );
}
