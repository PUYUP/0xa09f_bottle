import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  IonAlert,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonPage,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from "@ionic/react";
import { refresh } from "ionicons/icons";
import { useHistory } from "react-router-dom";
import {
  checkBottles,
  dismissEatenBait,
  exportVault,
  getState,
  log,
  openThread,
  replyBottle,
  snoozeVaultReminder,
  subscribe,
  vaultReminderState,
} from "@shared/store";
import type { ThreadNode } from "@shared/store";
import type { ThreadRecord } from "@shared/types";
import { hasUnreadReplies } from "../lib/unread";
import { useThreadRows } from "../lib/useThreads";
import { BaitCard } from "../components/BaitCard";
import { MessageRow } from "../components/MessageRow";

export function CatchPage() {
  const state = useSyncExternalStore(subscribe, getState);
  const history = useHistory();
  const { threads, sentIds, refresh: refreshThreads } = useThreadRows();
  const [replyTarget, setReplyTarget] = useState<ThreadRecord | null>(null);
  const [vaultDue, setVaultDue] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const fetchingRef = useRef(false);

  useEffect(() => {
    vaultReminderState()
      .then((r) => setVaultDue(r.due))
      .catch(() => {});
  }, []);

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
      refreshThreads();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, state.records]);

  // Chat detail is a real route (/bottles/:id) — tapping a message or an
  // eaten bait navigates there; eaten bait is dismissed like on web.
  const openChat = (bottleId: string, kid?: string) => {
    if (kid) dismissEatenBait(kid).catch(() => {});
    history.push(`/bottles/${bottleId}`);
  };

  const doRefresh = () => {
    setRefreshing(true);
    checkBottles()
      .catch((e) => log(`check: ${(e as Error).message}`, "err"))
      .finally(() => setRefreshing(false));
  };

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar color="primary">
          <IonTitle>catch</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={doRefresh} disabled={refreshing}>
              <IonIcon icon={refresh} slot="icon-only" />
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        {vaultDue && (
          <IonItem
            lines="full"
            className="ion-margin-top"
            style={{ "--background": "#fff3cd", "--color": "#333" } as React.CSSProperties}
          >
            <IonLabel>
              <strong>🔑 backup your vault</strong>
              <p>no export yet — lose this device and every message is gone forever</p>
            </IonLabel>
            <IonButton
              slot="end"
              size="small"
              onClick={() =>
                exportVault()
                  .then(() => vaultReminderState().then((r) => setVaultDue(r.due)))
                  .catch((e) => log(`export: ${(e as Error).message}`, "err"))
              }
            >
              export
            </IonButton>
            <IonButton
              slot="end"
              size="small"
              fill="clear"
              onClick={async () => {
                await snoozeVaultReminder();
                setVaultDue(false);
              }}
            >
              later
            </IonButton>
          </IonItem>
        )}

        <BaitCard onOpenChat={openChat} />

        <IonList inset className="ion-margin-top">
          {threads.length === 0 && (
            <IonItem lines="none">
              <IonLabel className="ion-text-center ion-padding">
                {state.ready ? "the sea is quiet — nothing on the line yet" : "booting…"}
              </IonLabel>
            </IonItem>
          )}
          {/* list shows thread roots only — replies live inside /bottles/:id */}
          {threads.map((node) => (
            <MessageRow
              key={node.rec.id}
              row={{ node, depth: 0 }}
              sentIds={sentIds}
              hasNew={hasUnreadReplies(node.rec, state.records)}
              showReplies={false}
              onOpen={openChat}
              onReply={setReplyTarget}
            />
          ))}
        </IonList>

        {/* reply dialog (list view) */}
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

        {refreshing && (
          <div className="ion-text-center ion-padding">
            <IonSpinner name="crescent" />
          </div>
        )}

        {/* system log */}
        {state.logs.length > 0 && (
          <IonItem lines="none" className="ion-no-padding">
            <IonLabel>
              {state.logs.slice(0, 5).map((l) => (
                <p key={l.id} style={{ fontSize: 12, margin: "2px 0" }}>
                  [{l.time}] {l.msg}
                </p>
              ))}
            </IonLabel>
          </IonItem>
        )}
      </IonContent>
    </IonPage>
  );
}
