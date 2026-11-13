import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import * as api from "../api";
import type { Connected } from "../api";
import { saveLoginCommand, savedLoginCommand } from "../readOnly";

/** Shown while the cluster rejects the credentials: how to renew them, and a login command to run. */
export default function AuthBanner({ problem, auth, onRetry }: { problem: { context: string; tries: number }; auth: Connected["auth"]; onRetry: () => void }) {
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);
  const [command, setCommand] = useState(() => savedLoginCommand(problem.context) ?? (auth?.awsProfile ? `aws sso login --profile ${auth.awsProfile}` : ""));
  const [login, setLogin] = useState<{ state: "running" | "ok" | "failed"; output: string } | null>(null);
  async function runLogin() {
    saveLoginCommand(problem.context, command);
    setLogin({ state: "running", output: "" });
    try {
      const output = await api.runLogin(command);
      setLogin({ state: "ok", output });
      onRetry();
    } catch (e) {
      setLogin({ state: "failed", output: api.errorText(e) });
    }
  }
  const retry = () => {
    setRetrying(true);
    onRetry();
    setTimeout(() => setRetrying(false), 1500);
  };
  return (
    <div className="auth-banner" role="alert">
      <div className="auth-banner-text">
        <strong>{t("app.auth.rejected", { name: api.shortContextName(problem.context) })}</strong> {t("app.auth.expired")}{" "}
        {auth?.awsProfile ? (
          <Trans i18nKey="app.auth.aws" values={{ command: auth.command, profile: auth.awsProfile }} components={[<code key={0} />, <code key={1} />, <code key={2} />, <code key={3} />]} />
        ) : auth ? (
          <Trans i18nKey="app.auth.exec" values={{ command: auth.command }} components={[<code key={0} />]} />
        ) : (
          <>{t("app.auth.kubeconfig")}</>
        )}{" "}
        <span className="faint">{t("app.auth.retries")}</span>
        <div className="auth-login">
          <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder={t("app.auth.commandPlaceholder")} spellCheck={false} aria-label={t("app.auth.commandLabel")} />
          <button disabled={!command.trim() || login?.state === "running"} onClick={() => void runLogin()} title={t("app.auth.runTitle")}>
            {login?.state === "running" ? t("app.auth.waiting") : t("app.auth.run")}
          </button>
        </div>
        {login?.state === "ok" && <div className="ok auth-output">{t("app.auth.finished")}</div>}
        {login?.state === "failed" && <pre className="bad auth-output">{login.output}</pre>}
      </div>
      <button className="primary" disabled={retrying} onClick={retry}>
        {retrying ? t("app.auth.reconnecting") : t("app.auth.reconnect")}
      </button>
    </div>
  );
}
