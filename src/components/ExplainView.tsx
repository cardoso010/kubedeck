import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { IconKey, IconSparkles } from "@tabler/icons-react";
import { aiClearKey, aiExplain, aiSetKey, aiStatus, errorText, stopStream } from "../api";

interface Props {
  kindKey: string;
  namespace: string | null;
  name: string;
  production: boolean;
}

type Status = Awaited<ReturnType<typeof aiStatus>>;

/**
 * Asks Claude what is wrong with this object. Sends only on click, after saying what leaves
 * the machine: the manifest with secret values removed, events and (for pods) recent logs.
 */
export default function ExplainView({ kindKey, namespace, name, production }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "running" | "done">("idle");
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stream = useRef<number | null>(null);

  useEffect(() => {
    aiStatus().then(setStatus, (e) => setError(errorText(e)));
    return () => {
      if (stream.current !== null) void stopStream(stream.current);
    };
  }, []);

  async function explain() {
    setText("");
    setError(null);
    setInfo(null);
    setState("running");
    try {
      stream.current = await aiExplain(kindKey, namespace, name, (m) => {
        if (m.type === "context") setInfo(`Sent ${Math.round(m.characters / 1000)}k characters of context.`);
        else if (m.type === "text") setText((t) => t + m.text);
        // A fallback model took over: what the first model wrote so far is discarded.
        else if (m.type === "restart") setText("");
        else if (m.type === "error") (setError(m.message), setState("done"));
        else if (m.type === "done") {
          setState("done");
          if (m.refused) setError("Claude declined to answer this one.");
          else setInfo((i) => `${i ?? ""} Answer by ${m.model}.`);
        }
      });
    } catch (e) {
      setError(errorText(e));
      setState("done");
    }
  }

  if (!status) return <div className="empty">Loading…</div>;
  if (!status.configured) return <KeySetup onSaved={() => aiStatus().then(setStatus)} />;
  if (kindKey === "secrets") return <div className="empty">kubedeck never sends Secrets to Claude.</div>;

  return (
    <div className="explain">
      <div className="explain-toolbar">
        <button className="primary" disabled={state === "running"} onClick={() => void explain()}>
          <IconSparkles size={14} /> {state === "idle" ? "Explain with Claude" : state === "running" ? "Thinking…" : "Explain again"}
        </button>
        <span className="faint explain-note">
          Sends this {kindKey === "pods" ? "pod's manifest (secret values removed), events and recent logs" : "object's manifest (secret values removed) and events"} to the Anthropic API.
          {production && <strong className="warn"> This is a production cluster.</strong>}
        </span>
        {status.source === "keychain" && (
          <button className="link" onClick={() => void aiClearKey().then(() => aiStatus().then(setStatus))}>
            Remove key
          </button>
        )}
      </div>
      {error && <div className="error-bar">{error}</div>}
      <div className="explain-body">
        {text ? <Markdown>{text}</Markdown> : state === "idle" ? <div className="empty">Claude reads what kubectl describe and logs would show you, and suggests the likely cause and a fix.</div> : null}
        {info && <div className="faint explain-info">{info}</div>}
      </div>
    </div>
  );
}

function KeySetup({ onSaved }: { onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="key-setup">
      <IconKey size={26} stroke={1.5} />
      <h3>Connect Claude</h3>
      <p className="faint">
        Paste an Anthropic API key. It is stored in your system keychain, never in a file, and only used when you click Explain. You can also set <code>ANTHROPIC_API_KEY</code>.
      </p>
      <input type="password" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} autoFocus />
      {error && <div className="bad">{error}</div>}
      <button className="primary" disabled={!key.trim()} onClick={() => void aiSetKey(key).then(onSaved, (e) => setError(errorText(e)))}>
        Save key
      </button>
    </div>
  );
}
