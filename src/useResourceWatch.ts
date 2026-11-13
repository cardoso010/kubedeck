import { useEffect, useRef, useState } from "react";
import * as api from "./api";
import type { KindInfo, Row } from "./api";
import { useStream } from "./useStream";

interface Handlers {
  /** A new watch starts (other kind, namespaces or connection). */
  onStart: () => void;
  /** The cluster rejected the credentials. */
  onUnauthorized: () => void;
}

/**
 * The live rows of `kind` in `namespaces` (all when empty), by uid, while `connection` stays
 * the same; null until the first snapshot. `rowsKind` says which kind `rows` belongs to: it
 * lags the requested kind for a render after switching.
 */
export function useResourceWatch(connection: unknown, kind: KindInfo | null, namespaces: string[], handlers: Handlers) {
  const [rows, setRows] = useState<Map<string, Row> | null>(null);
  const [rowsKind, setRowsKind] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The handlers are new closures every render; the watch reads the latest ones.
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useStream(
    connection && kind
      ? () => {
          setRows(null);
          setRowsKind(kind.key);
          setError(null);
          latest.current.onStart();
          // The backend batches changes every 100ms; this also folds whatever arrives within a frame.
          let queue: api.WatchMsg[] = [];
          const flush = () => {
            const batch = queue;
            queue = [];
            setRows((prev) => {
              let next = new Map(prev ?? []);
              for (const msg of batch) {
                if (msg.type === "snapshot") next = new Map(msg.rows.map((r) => [r.uid, r]));
                else if (msg.type === "changes") {
                  for (const row of msg.upserts) next.set(row.uid, row);
                  for (const uid of msg.deletes) next.delete(uid);
                }
              }
              return next;
            });
          };
          return api.watchResources(kind.key, namespaces, (msg) => {
            if (msg.type === "error") {
              if (msg.unauthorized) latest.current.onUnauthorized();
              return setError(msg.unauthorized ? null : msg.message);
            }
            setError(null);
            if (queue.push(msg) === 1) requestAnimationFrame(flush);
          });
        }
      : null,
    (e) => setError(api.errorText(e)),
    [connection, kind?.key, namespaces.join(",")],
  );

  return { rows, rowsKind, error };
}
