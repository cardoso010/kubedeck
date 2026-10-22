import { useEffect, useState } from "react";
import { IconArrowRight } from "@tabler/icons-react";
import { errorText, related, type KindInfo, type RelatedGroup, type RelatedItem } from "../api";

interface Props {
  kindKey: string;
  namespace: string | null;
  name: string;
  kinds: KindInfo[];
  onOpen: (item: RelatedItem) => void;
}

/** Owners, pods, services, ingresses, config and node related to one object; each opens it. */
export default function RelatedView({ kindKey, namespace, name, kinds, onOpen }: Props) {
  const [groups, setGroups] = useState<RelatedGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setGroups(null);
    related(kindKey, namespace, name).then(
      (g) => !stale && setGroups(g),
      (e) => !stale && setError(errorText(e)),
    );
    return () => {
      stale = true;
    };
  }, [kindKey, namespace, name]);

  if (error) return <div className="error-bar">{error}</div>;
  if (!groups) return <div className="empty">Loading…</div>;
  if (groups.length === 0) return <div className="empty">Nothing related found.</div>;
  const label = (key: string) => kinds.find((k) => k.key === key)?.label.replace(/s$/, "") ?? key;

  return (
    <div className="related">
      {groups.map((g) => (
        <div key={g.relation} className="related-group">
          <div className="related-title">
            {g.relation} <span className="faint">{g.items.length}</span>
          </div>
          {g.items.map((item) => (
            <button key={`${item.kindKey}/${item.namespace}/${item.name}`} className="related-item" onClick={() => onOpen(item)}>
              <span className="kind-chip">{label(item.kindKey)}</span>
              <span className="related-name">{item.name}</span>
              {item.status && <span className={`faint ${/Running|Succeeded/.test(item.status) ? "ok" : /Pending|Failed|Unknown/.test(item.status) ? "warn" : ""}`}>{item.status}</span>}
              <IconArrowRight size={13} className="faint related-arrow" />
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
