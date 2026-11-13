import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconCheck, IconX } from "@tabler/icons-react";
import { getVersion } from "@tauri-apps/api/app";
import { aiClearKey, aiStatus, errorText, shortContextName } from "../api";
import { LANGUAGES, systemLanguage, useLanguage, type LanguageId } from "../i18n";
import { THEMES, type Theme, type ThemeId } from "../theme";

interface Props {
  theme: Theme;
  onTheme: (id: ThemeId) => void;
  /** The window's cluster, or null when not connected. */
  context: string | null;
  lockedByDefault: boolean;
  onLockedByDefault: (locked: boolean) => void;
  notify: boolean;
  /** Resolves false when the system refuses notifications. */
  onNotify: (on: boolean) => Promise<boolean>;
  onClose: () => void;
}

/** App preferences (every window) and this window's cluster preferences (per viewer). */
export default function SettingsDialog({ theme, onTheme, context, lockedByDefault, onLockedByDefault, notify, onNotify, onClose }: Props) {
  const { t } = useTranslation();
  const { language, setLanguage } = useLanguage();
  const [version, setVersion] = useState("");
  const [claude, setClaude] = useState<Awaited<ReturnType<typeof aiStatus>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setVersion, () => {});
    aiStatus().then(setClaude, () => {});
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const languageName = (id: LanguageId) => LANGUAGES.find((l) => l.id === id)?.label ?? id;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide settings" role="dialog" aria-label={t("settings.title")} onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h3>{t("settings.title")}</h3>
          <button className="icon-button" aria-label={t("settings.close")} onClick={onClose}>
            <IconX size={16} />
          </button>
        </div>

        <section>
          <h4>{t("settings.language.title")}</h4>
          <select value={language ?? ""} onChange={(e) => setLanguage((e.target.value || null) as LanguageId | null)}>
            <option value="">{t("settings.language.system", { language: languageName(systemLanguage()) })}</option>
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          <p className="faint">{t("settings.language.note")}</p>
        </section>

        <section>
          <h4>{t("settings.theme.title")}</h4>
          <div className="settings-themes">
            {THEMES.map((th) => (
              <button key={th.id} className={`settings-theme ${th.id === theme.id ? "active" : ""}`} aria-pressed={th.id === theme.id} onClick={() => onTheme(th.id)}>
                <span className={`theme-swatch swatch-${th.id}`} />
                <span className="popover-item-text">
                  <span>{t(`themes.${th.id}.label`)}</span>
                  <span className="faint">{t(`themes.${th.id}.description`)}</span>
                </span>
                {th.id === theme.id && <IconCheck size={14} />}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h4>
            {t("settings.cluster.title")} {context && <span className="faint">{shortContextName(context)}</span>}
          </h4>
          {context ? (
            <>
              <label className="settings-toggle">
                <input type="checkbox" checked={lockedByDefault} onChange={(e) => onLockedByDefault(e.target.checked)} />
                <span className="popover-item-text">
                  <span>{t("settings.cluster.readOnly")}</span>
                  <span className="faint">{t("settings.cluster.readOnlyHint")}</span>
                </span>
              </label>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={notify}
                  onChange={(e) => {
                    setError(null);
                    void onNotify(e.target.checked).then((ok) => ok || setError(t("settings.cluster.notifyDenied")));
                  }}
                />
                <span className="popover-item-text">
                  <span>{t("settings.cluster.notify")}</span>
                  <span className="faint">{t("settings.cluster.notifyHint")}</span>
                </span>
              </label>
            </>
          ) : (
            <p className="faint">{t("settings.cluster.none")}</p>
          )}
        </section>

        <section>
          <h4>{t("settings.claude.title")}</h4>
          <div className="settings-row">
            <p className="faint">{claude && t(`settings.claude.${claude.source ?? "none"}`)}</p>
            {claude?.source === "keychain" && (
              <button onClick={() => void aiClearKey().then(() => aiStatus().then(setClaude), (e) => setError(errorText(e)))}>{t("settings.claude.remove")}</button>
            )}
          </div>
        </section>

        {error && <div className="bad">{error}</div>}
        <p className="faint settings-version">kubedeck {version && `v${version}`}</p>
      </div>
    </div>
  );
}
