import { useEffect, useState, useSyncExternalStore } from "react";
import { buildThreads, getState, subscribe } from "@shared/store";
import type { ThreadNode } from "@shared/store";
import { flatten, type Row } from "./rows";

// Shared thread forest → flat rows + sent-id set. Used by the catch list and
// the standalone chat screen so both see the same rebuilt tree.
export function useThreadRows() {
  const state = useSyncExternalStore(subscribe, getState);
  const [threads, setThreads] = useState<ThreadNode[]>([]);

  const refresh = () => {
    buildThreads()
      .then((t) => setThreads(t.roots))
      .catch(() => {});
  };

  useEffect(() => {
    refresh();
    // No interval: rebuilds are driven by state.records changes (every
    // store write calls renderInbox) — fully event-driven, no ticking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.records, state.ready]);

  const rows: Row[] = [];
  for (const t of threads) flatten(t, 0, rows);
  const sentIds = new Set(
    state.records
      .filter((r) => r.id.startsWith("sent:"))
      .map((r) => r.bottle?.id)
      .filter(Boolean) as string[]
  );

  return { threads, rows, sentIds, refresh };
}
