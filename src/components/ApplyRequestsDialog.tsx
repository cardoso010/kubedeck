import { useState } from "react";
import { useTranslation } from "react-i18next";
import { applyRequests, errorText, type ApplyOutcome, type NewRequests } from "../api";
import TypeToConfirm, { confirms } from "./TypeToConfirm";
import Modal from "./Modal";

const MI = 1024 * 1024;
const TEMPLATED = ["deployments", "statefulsets", "daemonsets"];

interface Props {
  namespace: string;
  kindKey: string;
  kindLabel: string;
  workload: string;
  container: string;
  cpuMillis: number | null;
  memoryBytes: number | null;
  production: boolean;
  context: string;
  onClose: (changed: boolean) => void;
}

/**
 * New requests for one container: resized in place on the running pods (no restart, until
 * they are replaced) or written to the workload's template (permanent, rolls the pods).
 * Always checked with a server-side dry run first.
 */
export default function ApplyRequestsDialog({ namespace, kindKey, kindLabel, workload, container, cpuMillis, memoryBytes, production, context, onClose }: Props) {
  const { t } = useTranslation();
  const hasTemplate = TEMPLATED.includes(kindKey);
  const [cpu, setCpu] = useState(cpuMillis === null ? "" : String(Math.round(cpuMillis)));
  const [memory, setMemory] = useState(memoryBytes === null ? "" : String(Math.round(memoryBytes / MI)));
  const [to, setTo] = useState<"pods" | "workload">("pods");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<ApplyOutcome[] | null>(null);

  const number = (v: string) => (v.trim() === "" ? null : Number(v));
  const request: NewRequests = { namespace, kindKey, workload, container, cpuMillis: number(cpu), memoryBytes: number(memory) === null ? null : number(memory)! * MI };
  const valid = [request.cpuMillis, request.memoryBytes].some((v) => v !== null) && [request.cpuMillis, request.memoryBytes].every((v) => v === null || (Number.isFinite(v) && v > 0));
  const ok = valid && !busy && (!production || confirms(typed, workload));

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const dry = await applyRequests(request, to, true);
      if (dry.some((o) => !o.ok)) {
        setOutcomes(dry);
        return;
      }
      setOutcomes(await applyRequests(request, to, false));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal className="modal-wide" onClose={() => onClose(!!outcomes)}>
      <h3>
        {t("rightsizing.applyDialog.title", { container })} <span className="faint">{t("rightsizing.applyDialog.in", { workload })}</span>
      </h3>
      {outcomes ? (
        <div className="apply-outcomes">
          {outcomes.map((o) => (
            <div key={o.target}>
              <span className={`status-dot ${o.ok ? "ok" : "bad"}`} /> <code>{o.target}</code> <span className={o.ok ? "faint" : "bad"}>{o.message}</span>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="apply-fields">
            <label>
              {t("rightsizing.applyDialog.cpu")} <input value={cpu} onChange={(e) => setCpu(e.target.value)} inputMode="numeric" /> <span className="faint">m</span>
            </label>
            <label>
              {t("rightsizing.applyDialog.memory")} <input value={memory} onChange={(e) => setMemory(e.target.value)} inputMode="numeric" /> <span className="faint">Mi</span>
            </label>
          </div>
          <label className="apply-choice">
            <input type="radio" checked={to === "pods"} onChange={() => setTo("pods")} />
            <span>
              <strong>{t("rightsizing.applyDialog.pods")}</strong>
              <span className="faint">{t("rightsizing.applyDialog.podsHint")}</span>
            </span>
          </label>
          <label className={`apply-choice ${hasTemplate ? "" : "disabled"}`}>
            <input type="radio" checked={to === "workload"} disabled={!hasTemplate} onChange={() => setTo("workload")} />
            <span>
              <strong>{t("rightsizing.applyDialog.workload", { kind: kindLabel })}</strong>
              <span className="faint">{hasTemplate ? t("rightsizing.applyDialog.workloadHint") : t("rightsizing.applyDialog.noTemplate")}</span>
            </span>
          </label>
          <p>{t("rightsizing.applyDialog.note", { cluster: context })}</p>
          {production && <TypeToConfirm expected={workload} value={typed} onChange={setTyped} />}
        </>
      )}
      {error && <div className="bad">{error}</div>}
      <div className="modal-actions">
        {outcomes ? (
          <button className="primary" onClick={() => onClose(true)}>
            {t("common.close")}
          </button>
        ) : (
          <>
            <button onClick={() => onClose(false)}>{t("common.cancel")}</button>
            <button className="primary" disabled={!ok} onClick={() => void apply()}>
              {busy ? t("rightsizing.applyDialog.applying") : to === "pods" ? t("rightsizing.applyDialog.resize") : t("rightsizing.applyDialog.update")}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
