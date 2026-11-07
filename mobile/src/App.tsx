import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  IonApp,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButtons,
  IonButton,
  IonTextarea,
  IonList,
  IonItem,
  IonLabel,
  IonNote,
  IonAlert,
  IonSpinner,
  IonIcon,
} from "@ionic/react";
import { send, refresh, fish, cloudUpload, cloudDownload, chatbox } from "ionicons/icons";
import { getState, subscribe } from "@shared/store";
import {
  init,
  dropBottle,
  checkBottles,
  generateAndDeposit,
  buildThreads,
  replyBottle,
  reportBottle,
  exportVault,
  importVaultFile,
  readTTLSeconds,
  log,
} from "@shared/store";
import type { ThreadNode } from "@shared/store";
import type { ThreadRecord } from "@shared/types";
import { MAX_THREAD_DEPTH } from "@shared/crypto";

interface Row {
  node: ThreadNode;
  depth: number;
}

function flatten(node: ThreadNode, depth: number, out: Row[]) {
  out.push({ node, depth });
  for (const c of node.children) flatten(c, depth + 1, out);
}

export default function App() {
  const state = useSyncExternalStore(subscribe, getState);
  const [message, setMessage] = useState("");
  const [threads, setThreads] = useState<ThreadNode[]>([]);
  const [replyTarget, setReplyTarget] = useState<ThreadRecord | null>(null);
  const [baitOpen, setBaitOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    init().catch((e) => log(`boot: ${(e as Error).message}`, "err"));
    const iv = setInterval(() => {
      buildThreads()
        .then((t) => setThreads(t.roots))
        .catch(() => {});
    }, 4000);
    buildThreads().then((t) => setThreads(t.roots)).catch(() => {});
    return () => clearInterval(iv);
  }, []);

  const rows: Row[] = [];
  for (const r of threads) flatten(r, 0, rows);
  const sentIds = new Set(
    state.records
      .filter((r) => r.id.startsWith("sent:"))
      .map((r) => r.bottle?.id)
      .filter(Boolean) as string[]
  );

  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    fn()
      .catch((e) => log((e as Error).message, "err"))
      .finally(() => setBusy(false));
  };

  const cast = () =>
    run(async () => {
      await dropBottle(message, "86400");
      setMessage("");
    });

  return (
    <IonApp>
      <IonHeader>
        <IonToolbar color="primary">
          <IonTitle>saltleak</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={() => run(checkBottles)} disabled={busy}>
              <IonIcon icon={refresh} slot="icon-only" />
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>

      <IonContent className="ion-padding">
        {/* status */}
        <IonNote>
          {state.activePoolKeys ?? "…"}/{5} bait in pool · e2ee on
        </IonNote>

        {/* composer */}
        <IonItem lines="none" className="ion-margin-top">
          <IonTextarea
            placeholder="write something for the void…"
            value={message}
            autoGrow
            onIonInput={(e) => setMessage(e.detail.value ?? "")}
          />
        </IonItem>
        <IonButton expand="block" onClick={cast} disabled={busy || !message.trim()}>
          <IonIcon icon={send} slot="start" />
          cast it
        </IonButton>

        {/* actions */}
        <div className="ion-margin-top" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <IonButton size="small" fill="outline" onClick={() => setBaitOpen(true)}>
            <IonIcon icon={fish} slot="start" />
            throw bait
          </IonButton>
          <IonButton
            size="small"
            fill="outline"
            onClick={() => fileRef.current?.click()}
          >
            <IonIcon icon={cloudUpload} slot="start" />
            vault
          </IonButton>
          <IonButton
            size="small"
            fill="outline"
            onClick={() =>
              exportVault().catch((e) => log(`export: ${(e as Error).message}`, "err"))
            }
          >
            <IonIcon icon={cloudDownload} slot="start" />
            export
          </IonButton>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) importVaultFile(f).catch((err) => log(`import: ${(err as Error).message}`, "err"));
            }}
          />
        </div>

        {/* catch list */}
        <IonList inset className="ion-margin-top">
          {rows.length === 0 && (
            <IonItem lines="none">
              <IonLabel className="ion-text-center ion-padding">
                {state.ready ? "the void is quiet — nothing on the line yet" : "booting…"}
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
            return (
              <IonItem key={node.rec.id} lines="full">
                <IonLabel>
                  <div style={{ paddingLeft: depth * 16 }}>
                    <p style={{ margin: "4px 0", whiteSpace: "pre-wrap" }}>{plain?.text}</p>
                    <IonNote>
                      {isSent ? "yours" : claim?.status || "CLAIMED"} ·{" "}
                      {claim?.deliveries ?? "?"}/{bottle?.maxDeliveries} ·{" "}
                      {(bottle?.id || "").slice(0, 8)}
                      {depth > 0 && " ↳"}
                    </IonNote>
                    {!isSent && (
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
                  </div>
                </IonLabel>
              </IonItem>
            );
          })}
        </IonList>

        {busy && (
          <div className="ion-text-center ion-padding">
            <IonSpinner name="crescent" />
          </div>
        )}

        {/* system log */}
        {state.logs.length > 0 && (
          <IonList inset>
            {state.logs.slice(-5).map((l) => (
              <IonItem key={l.id} lines="none" className="ion-no-padding">
                <IonNote>
                  [{l.time}] {l.msg}
                </IonNote>
              </IonItem>
            ))}
          </IonList>
        )}
      </IonContent>

      {/* throw bait dialog */}
      <IonAlert
        isOpen={baitOpen}
        onDidDismiss={() => setBaitOpen(false)}
        header="throw bait"
        message="publish a fresh keypair into the pool so strangers can cast sealed catches to it"
        inputs={[
          {
            name: "ttl",
            type: "number",
            value: "86400",
            placeholder: "ttl seconds",
          },
        ]}
        buttons={[
          { text: "cancel", role: "cancel" },
          {
            text: "throw it",
            handler: (data) => {
              const v = String(data?.values?.ttl ?? "86400");
              if (!readTTLSeconds(v)) {
                log("invalid ttl", "warn");
                return false;
              }
              run(() => generateAndDeposit(v));
            },
          },
        ]}
      />

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
              run(() => replyBottle(replyTarget, t));
            },
          },
        ]}
      />
    </IonApp>
  );
}
