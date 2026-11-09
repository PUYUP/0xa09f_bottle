import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  IonAlert,
  IonButton,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
} from "@ionic/react";
import { chatbox, trash } from "ionicons/icons";
import {
  buildThreads,
  deleteBottle,
  getState,
  log,
  openThread,
  replyBottle,
  reportBottle,
  subscribe,
} from "@shared/store";
import { MAX_THREAD_DEPTH } from "@shared/crypto";
import type { ThreadNode } from "@shared/store";
import type { ThreadRecord } from "@shared/types";
import { hasUnreadReplies } from "../lib/unread";

interface Row {
  node: ThreadNode;
  depth: number;
}

function flatten(node: ThreadNode, depth: number, out: Row[]) {
  out.push({ node, depth });
  for (const c of node.children) flatten(c, depth + 1, out);
}

export function CatchPage() {
  const state = useSyncExternalStore(subscribe, getState);
  const [threads, setThreads] = useState<ThreadNode[]>([]);
  const [replyTarget, setReplyTarget] = useState<ThreadRecord | null>(null);
  const fetchingRef = useRef(false);

  useEffect(() => {
    const refresh = () => {
      buildThreads()
        .then((t) => setThreads(t.roots))
        .catch(() => {});
    };
    refresh();
    const iv = setInterval(refresh, 4000);
    return () => clearInterval(iv);
  }, [state.records, state.ready]);

  const rows: Row[] = [];
  for (const r of threads) flatten(r, 0, rows);
  const sentIds = new Set(
    state.records
      .filter((r) => r.id.startsWith("sent:"))
      .map((r) => r.bottle?.id)
      .filter(Boolean) as string[]
  );

  // Lazy reply loading: the server reports childCount per bottle, so any
  // authored node whose children aren't all local yet gets a whole-subtree
  // fetch via openThread — capped per cycle to stay gentle.
  useEffect(() => {
    if (fetchingRef.current) return;
    const authored = new Set(
      state.records
        .filter((r) => r.id.startsWith("sent:"))
        .map((r) => r.bottle?.id)
        .filter(Boolean) as string[]
    );
    const missing: string[] = [];
    const walk = (n: ThreadNode) => {
      const bid = n.rec.bottle?.id;
      if (bid && authored.has(bid) && (n.rec.childCount || 0) > n.children.length) {
        missing.push(bid);
      }
      n.children.forEach(walk);
    };
    threads.forEach(walk);
    if (!missing.length) return;
    fetchingRef.current = true;
    (async () => {
      for (const id of missing.slice(0, 10)) {
        await openThread(id).catch(() => {});
      }
      fetchingRef.current = false;
      buildThreads().then((t) => setThreads(t.roots)).catch(() => {});
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, state.records]);

  return (
    <>
      <IonNote>
        {state.activePoolKeys ?? "…"}/5 bait in pool · e2ee on
      </IonNote>

      <IonList inset className="ion-margin-top">
        {rows.length === 0 && (
          <IonItem lines="none">
            <IonLabel className="ion-text-center ion-padding">
              {state.ready ? "the sea is quiet — nothing on the line yet" : "booting…"}
            </IonLabel>
          </IonItem>
        )}
        {rows.map(({ node, depth }) => {
          const { bottle, plain, claim } = node.rec;
          const isSent = claim?.status === "SENT";
          const canReply =
            !!plain?.reply &&
            (bottle?.depth || 1) < MAX_THREAD_DEPTH &&
            !isSent &&
            !sentIds.has(bottle?.id || "");
          const hasNew = depth === 0 && hasUnreadReplies(node.rec, state.records);
          return (
            <IonItem
              key={node.rec.id}
              lines="full"
              button
              onClick={() => {
                const bid = bottle?.id;
                if (bid) openThread(bid).catch(() => {});
              }}
            >
              <IonLabel>
                <div style={{ paddingLeft: depth * 16 }}>
                  {node.rec.deleted ? (
                    <p style={{ margin: "4px 0", fontStyle: "italic", color: "var(--ion-color-medium)" }}>
                      [this message was deleted]
                    </p>
                  ) : (
                    <p style={{ margin: "4px 0", whiteSpace: "pre-wrap" }}>{plain?.text}</p>
                  )}
                  <IonNote>
                    {isSent ? "yours" : claim?.status || "CLAIMED"} ·{" "}
                    {claim?.deliveries ?? "?"}/{bottle?.maxDeliveries} ·{" "}
                    {(bottle?.id || "").slice(0, 8)}
                    {depth > 0 && " ↳"}
                    {(() => {
                      const total = node.rec.childCount || 0;
                      const loaded = node.children.length;
                      if (total > loaded)
                        return <span style={{ color: "#1a5276" }}> · 💬 {total} repl{total === 1 ? "y" : "ies"} ▸</span>;
                      if (loaded > 0)
                        return <span style={{ color: "#1a5276" }}> · 💬 {loaded} repl{loaded === 1 ? "y" : "ies"}</span>;
                      return null;
                    })()}
                    {hasNew && (
                      <span style={{ color: "#c0392b", fontWeight: 700 }}> ● new</span>
                    )}
                  </IonNote>
                  {!isSent && !node.rec.deleted && (
                    <div style={{ marginTop: 4, display: "flex", gap: 12 }}>
                      {canReply && (
                        <IonButton
                          size="small"
                          fill="clear"
                          onClick={() => setReplyTarget(node.rec)}
                        >
                          <IonIcon icon={chatbox} slot="start" />
                          reply
                        </IonButton>
                      )}
                      <IonButton
                        size="small"
                        fill="clear"
                        color="danger"
                        onClick={() =>
                          reportBottle(bottle!.id).catch((e) =>
                            log(`report: ${(e as Error).message}`, "err")
                          )
                        }
                      >
                        report
                      </IonButton>
                    </div>
                  )}
                  {isSent && bottle && !node.rec.deleted && (
                    <div style={{ marginTop: 4 }}>
                      <IonButton
                        size="small"
                        fill="clear"
                        color="danger"
                        onClick={() =>
                          deleteBottle(bottle.id).catch((e: Error) =>
                            log(`delete: ${e.message}`, "err")
                          )
                        }
                      >
                        <IonIcon icon={trash} slot="start" />
                        delete
                      </IonButton>
                    </div>
                  )}
                </div>
              </IonLabel>
            </IonItem>
          );
        })}
      </IonList>

      {/* reply dialog */}
      <IonAlert
        isOpen={!!replyTarget}
        onDidDismiss={() => setReplyTarget(null)}
        header="reply"
        inputs={[
          {
            name: "text",
            type: "textarea",
            placeholder: "write your reply…",
          },
        ]}
        buttons={[
          { text: "cancel", role: "cancel" },
          {
            text: "send",
            handler: (data) => {
              const t = String(data?.values?.text ?? "").trim();
              if (!t || !replyTarget) return false;
              replyBottle(replyTarget, t).catch((e) =>
                log(`reply: ${(e as Error).message}`, "err")
              );
            },
          },
        ]}
      />
    </>
  );
}
