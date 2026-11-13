import { useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { IconStar, IconStarFilled } from "@tabler/icons-react";
import { errorText, listPortForwards, startPortForward, stopStream, type ForwardInfo } from "../api";
import { favoriteId, loadFavorites, saveFavorites, type Favorite } from "../favorites";
import { usePoll } from "../usePoll";

/**
 * Active port forwards of the connected cluster (they stop when switching clusters), and
 * the starred ones, which start again whenever a window connects to this cluster.
 */
export default function PortForwardsView({ context }: { context: string }) {
  const { t } = useTranslation();
  const [forwards, setForwards] = useState<ForwardInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<Favorite[]>(() => loadFavorites(context));
  const starred = new Set(favorites.map(favoriteId));
  const running = new Set((forwards ?? []).map(favoriteId));

  function updateFavorites(next: Favorite[]) {
    setFavorites(next);
    saveFavorites(context, next);
  }
  const toggleStar = (f: ForwardInfo) =>
    updateFavorites(
      starred.has(favoriteId(f))
        ? favorites.filter((x) => favoriteId(x) !== favoriteId(f))
        : [...favorites, { kind: f.kind, namespace: f.namespace, name: f.name, remotePort: f.remotePort, localPort: f.localPort }],
    );
  async function start(f: Favorite) {
    setError(null);
    try {
      await startPortForward(f.kind, f.namespace, f.name, f.remotePort, f.localPort);
      void refresh();
    } catch (e) {
      setError(`${f.name}:${f.remotePort}: ${errorText(e)}`);
    }
  }

  const refresh = () => listPortForwards().then(setForwards, (e) => setError(errorText(e)));

  // Connection counts and errors change in the background.
  usePoll(refresh, 2000, []);

  async function stop(id: number) {
    await stopStream(id);
    void refresh();
  }

  return (
    <section className="table">
      <header className="table-toolbar">
        <h2>{t("forwards.view.title")}</h2>
        <span className="count">{forwards?.length ?? ""}</span>
      </header>
      {error && <div className="error-bar">{error}</div>}
      <div className="simple-table">
        <div className="simple-row head">
          <div>{t("forwards.view.resource")}</div>
          <div>{t("common.namespace")}</div>
          <div>{t("forwards.view.remote")}</div>
          <div>{t("forwards.view.local")}</div>
          <div>{t("forwards.view.connections")}</div>
          <div>{t("forwards.view.lastError")}</div>
          <div />
        </div>
        {forwards?.map((f) => {
          const url = `http://localhost:${f.localPort}`;
          return (
            <div className="simple-row" key={f.id}>
              <div title={f.name}>
                <span className="kind-chip">{f.kind}</span> {f.name}
              </div>
              <div>{f.namespace}</div>
              <div>{f.remotePort}</div>
              <div>
                <a href={url} onClick={(e) => (e.preventDefault(), void openUrl(url))}>
                  localhost:{f.localPort}
                </a>
              </div>
              <div>{f.connections}</div>
              <div className="bad" title={f.lastError ?? ""}>
                {f.lastError}
              </div>
              <div className="forward-actions">
                <button className="icon-button" title={starred.has(favoriteId(f)) ? t("forwards.view.unstarHint") : t("forwards.view.starHint")} onClick={() => toggleStar(f)}>
                  {starred.has(favoriteId(f)) ? <IconStarFilled size={14} className="warn" /> : <IconStar size={14} />}
                </button>
                <button onClick={() => stop(f.id)}>{t("forwards.view.stop")}</button>
              </div>
            </div>
          );
        })}
        {forwards?.length === 0 && <div className="empty">{t("forwards.view.empty")}</div>}
      </div>
      {favorites.some((f) => !running.has(favoriteId(f))) && (
        <div className="simple-table">
          <div className="related-title favorites-title">{t("forwards.view.starredStopped")}</div>
          {favorites
            .filter((f) => !running.has(favoriteId(f)))
            .map((f) => (
              <div className="simple-row" key={favoriteId(f)}>
                <div>
                  <span className="kind-chip">{f.kind}</span> {f.name}
                </div>
                <div>{f.namespace}</div>
                <div>{f.remotePort}</div>
                <div>localhost:{f.localPort}</div>
                <div />
                <div />
                <div className="forward-actions">
                  <button className="icon-button" title={t("forwards.view.removeStar")} onClick={() => updateFavorites(favorites.filter((x) => favoriteId(x) !== favoriteId(f)))}>
                    <IconStarFilled size={14} className="warn" />
                  </button>
                  <button onClick={() => void start(f)}>{t("forwards.view.start")}</button>
                </div>
              </div>
            ))}
        </div>
      )}
    </section>
  );
}
