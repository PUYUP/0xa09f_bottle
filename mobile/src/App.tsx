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
  IonInput,
  IonList,
  IonItem,
  IonLabel,
  IonNote,
  IonAlert,
  IonSpinner,
  IonIcon,
  IonModal,
  IonFooter,
} from "@ionic/react";
import { send, refresh, fish, cloudUpload, cloudDownload, chatbox, trash, helpCircle } from "ionicons/icons";
import { getState, subscribe } from "@shared/store";
import {
  init,
  dropBottle,
  checkBottles,
  generateAndDeposit,
  buildThreads,
  replyBottle,
  reportBottle,
  deleteBottle,
  exportVault,
  importVaultFile,
  readTTLSeconds,
  log,
  fetchThreadChildren,
  openThread,
} from "@shared/store";
import type { ThreadNode } from "@shared/store";
import type { ThreadRecord, IdentityRecord } from "@shared/types";
import { MAX_THREAD_DEPTH } from "@shared/crypto";
import { getIdentity, randomUsername as genName } from "@shared/identity";
import { claimUsernameUI } from "@shared/store";
import { TermsContent, PrivacyContent, HowItWorksContent } from "./legal";

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
  const [legal, setLegal] = useState<"terms" | "privacy" | "how" | null>(null);
  const [busy, setBusy] = useState(false);
  const [identity, setIdentity] = useState<IdentityRecord | null>(null);
  const [claimName, setClaimName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const gateFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    init().catch((e) => log(`boot: ${(e as Error).message}`, "err"));
    getIdentity().then((id) => {
      setIdentity(id);
      setClaimName((n) => n || genName());
    }).catch(() => {});
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

  // Lazy reply loading: the server reports childCount per bottle, so any
  // authored node whose direct children aren't all local yet gets a
  // per-thread fetch — capped per cycle to stay gentle.
  const fetchingRef = useRef(false);
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
        await fetchThreadChildren(id).catch(() => {});
      }
      fetchingRef.current = false;
      buildThreads().then((t) => setThreads(t.roots)).catch(() => {});
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, state.records]);

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

  // Mandatory username gate — same policy as the web client.
  if (identity && !identity.username) {
    return (
      <IonApp>
        <IonContent className="ion-padding" style={{ display: "flex", alignItems: "center" }}>
          <div style={{ width: "100%" }}>
            <h2>choose your name</h2>
            <p style={{ color: "var(--ion-color-medium)", fontSize: 14 }}>
              a09f needs a username — bound to this device's identity key
              forever. A random one is prefilled; regenerate if you like.
            </p>
            <IonItem lines="none" className="ion-margin-top">
              <IonInput
                label="username"
                value={claimName}
                onIonInput={(e) => setClaimName(e.detail.value ?? "")}
              />
              <IonButton
                slot="end"
                fill="clear"
                onClick={() => setClaimName(genName())}
                title="random username"
              >
                <IonIcon icon={refresh} slot="icon-only" />
              </IonButton>
            </IonItem>
            <IonButton
              expand="block"
              className="ion-margin-top"
              disabled={busy || !claimName.trim()}
              onClick={() =>
                run(async () => {
                  await claimUsernameUI(claimName.trim());
                  setIdentity(await getIdentity());
                })
              }
            >
              claim &amp; enter
            </IonButton>
            <IonButton
              expand="block"
              fill="outline"
              size="small"
              className="ion-margin-top"
              onClick={() => setLegal("how")}
            >
              <IonIcon icon={helpCircle} slot="start" />
              how does this work?
            </IonButton>
            <div className="ion-margin-top" style={{ borderTop: "1px solid var(--ion-color-light)", paddingTop: 12 }}>
              <p style={{ color: "var(--ion-color-medium)", fontSize: 13 }}>
                coming back on a new device? your vault export holds the
                private keys that prove this identity — import it to restore
                your username, bait and message history.
              </p>
              <IonButton
                expand="block"
                fill="outline"
                size="small"
                onClick={() => gateFileRef.current?.click()}
              >
                <IonIcon icon={cloudDownload} slot="start" />
                import vault / secret file
              </IonButton>
              <input
                ref={gateFileRef}
                type="file"
                accept="application/json"
                style={{ display: "none" }}
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  try {
                    await importVaultFile(f);
                    setIdentity(await getIdentity());
                  } catch (err) {
                    log(`import: ${(err as Error).message}`, "err");
                  }
                }}
              />
            </div>
          </div>
        </IonContent>
        <IonModal isOpen={legal === "how"} onDidDismiss={() => setLegal(null)}>
          <IonHeader>
            <IonToolbar>
              <IonTitle>how it works</IonTitle>
              <IonButtons slot="end">
                <IonButton onClick={() => setLegal(null)}>close</IonButton>
              </IonButtons>
            </IonToolbar>
          </IonHeader>
          <IonContent className="ion-padding" style={{ fontSize: 14, lineHeight: 1.5 }}>
            <HowItWorksContent />
          </IonContent>
        </IonModal>
      </IonApp>
    );
  }

  return (
    <IonApp>
      <IonHeader>
        <IonToolbar color="primary">
          <IonTitle>a09f</IonTitle>
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
            const authored = sentIds.has(bottle?.id || "");
            const lastActivity = node.rec.threadLastAt || node.rec.lastChildAt || 0;
            const hasNewReplies =
              authored &&
              lastActivity > 0 &&
              lastActivity * 1000 > (node.rec.repliesSeenAt || 0);
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
                    <p style={{ margin: "4px 0", whiteSpace: "pre-wrap" }}>{plain?.text}</p>
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
                      {hasNewReplies && (
                        <span style={{ color: "#c0392b", fontWeight: 700 }}> ● new</span>
                      )}
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
                    {isSent && bottle && (
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

        {busy && (
          <div className="ion-text-center ion-padding">
            <IonSpinner name="crescent" />
          </div>
        )}

        {/* system log */}
        {state.logs.length > 0 && (
          <IonList inset>
            {state.logs.slice(0, 5).map((l) => (
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

      {/* terms & privacy */}
      <IonModal isOpen={legal !== null} onDidDismiss={() => setLegal(null)}>
        <IonHeader>
          <IonToolbar>
            <IonTitle>
              {legal === "terms" ? "terms of service" : legal === "privacy" ? "privacy policy" : "how it works"}
            </IonTitle>
            <IonButtons slot="end">
              <IonButton onClick={() => setLegal(null)}>close</IonButton>
            </IonButtons>
          </IonToolbar>
        </IonHeader>
        <IonContent className="ion-padding" style={{ fontSize: 14, lineHeight: 1.5 }}>
          {legal === "terms" ? <TermsContent /> : legal === "privacy" ? <PrivacyContent /> : <HowItWorksContent />}
        </IonContent>
      </IonModal>

      <IonFooter>
        <IonToolbar>
          <div
            className="ion-text-center ion-padding-vertical"
            style={{ fontSize: 12, display: "flex", justifyContent: "center", gap: 16 }}
          >
            <span onClick={() => setLegal("how")} style={{ cursor: "pointer", color: "var(--ion-color-primary)" }}>
              how it works
            </span>
            <span style={{ color: "var(--ion-color-medium)" }}>·</span>
            <span onClick={() => setLegal("terms")} style={{ cursor: "pointer", color: "var(--ion-color-primary)" }}>
              terms
            </span>
            <span style={{ color: "var(--ion-color-medium)" }}>·</span>
            <span onClick={() => setLegal("privacy")} style={{ cursor: "pointer", color: "var(--ion-color-primary)" }}>
              privacy
            </span>
          </div>
          <div
            className="ion-text-center"
            style={{ fontSize: 11, paddingBottom: 8, color: "var(--ion-color-medium)" }}
          >
            your IP is visible to the relay — use{" "}
            <a
              href="https://www.torproject.org/"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--ion-color-primary)" }}
            >
              Tor Browser
            </a>{" "}
            for untracked browsing
          </div>
        </IonToolbar>
      </IonFooter>
    </IonApp>
  );
}
