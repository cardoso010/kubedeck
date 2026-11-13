import { useTranslation } from "react-i18next";
import { IconServer2 } from "@tabler/icons-react";
import * as api from "../api";
import type { Contexts } from "../api";
import { clusterColor } from "../pins";
import Logo from "./Logo";

/** The empty window: recent and pinned clusters to connect to. */
export default function Welcome({ contexts, pins, connecting, onChoose, onPalette }: { contexts: Contexts | null; pins: string[]; connecting: boolean; onChoose: (c: string) => void; onPalette: () => void }) {
  const { t } = useTranslation();
  const ordered = contexts ? [...pins, ...contexts.contexts.map((c) => c.name).filter((c) => !pins.includes(c))] : [];
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-logo">
          <Logo size={28} />
        </div>
        <h1>kubedeck</h1>
        <p className="faint">{connecting ? t("app.welcome.connecting") : t("app.welcome.pick")}</p>
        <div className="welcome-list">
          {ordered.slice(0, 8).map((c) => (
            <button key={c} className="welcome-item" disabled={connecting} onClick={() => onChoose(c)}>
              <span className="cluster-dot" style={{ background: clusterColor(c) }} />
              <span className="welcome-item-name">{api.shortContextName(c)}</span>
              {api.isProduction(c) && <span className="prod-badge small">{t("app.welcome.prod")}</span>}
              {c === contexts?.current && <span className="faint">{t("app.welcome.current")}</span>}
              <IconServer2 size={14} className="faint" />
            </button>
          ))}
        </div>
        <button className="link" onClick={onPalette}>
          {t("app.welcome.or")} <kbd>⌘K</kbd> {t("app.welcome.toSearch")}
        </button>
      </div>
    </div>
  );
}
