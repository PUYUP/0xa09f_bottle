import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonTextarea,
  IonTitle,
  IonToolbar,
} from "@ionic/react";
import { close, send } from "ionicons/icons";
import {
  getState,
  log,
  openThread,
  replyBottle,
  subscribe,
} from "@shared/store";
import { useSyncExternalStore } from "react";
import { MAX_THREAD_DEPTH } from "@shared/crypto";
import type { ThreadRecord } from "@shared/types";
import { useThreadRows } from "../lib/useThreads";
import { MessageRow } from "../components/MessageRow";

// Standalone chat page at /bottles/:id — no tab bar, WhatsApp-style:
// straight-line bubbles + an IonFooter reply form.
export function ChatScreen() {
  const { id: chatId } = useParams<{ id: string }>();
  const state = useSyncExternalStore(subscribe, getState);
  const { rows, sentIds } = useThreadRows();
  const [replyTo, setReplyTo] = useState<ThreadRecord | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (chatId) openThread(chatId).catch(() => {});
  }, [chatId]);

  const chatRec = chatId
    ? state.records.find((r) => r.bottle?.id === chatId)
    : null;
  const chatKey = chatRec?.bottle
    ? chatRec.bottle.rootId || chatRec.bottle.id
    : null;
  const chatRows = chatKey
    ? rows.filter(({ node }) => {
        const b = node.rec.bottle;
        return !!b && (b.rootId || b.id) === chatKey;
      })
    : [];

  const replyable = (rec: ThreadRecord | undefined): rec is ThreadRecord =>
    !!rec &&
    rec.claim?.status !== "SENT" &&
    !rec.deleted &&
    !!rec.plain?.reply &&
    (rec.bottle?.depth || 1) < MAX_THREAD_DEPTH;

  // Default reply target: the newest incoming (non-own) message in the
  // thread — replying to it reaches that message's author.
  const lastIncoming = [...chatRows].reverse().find(({ node }) =>
    replyable(node.rec)
  )?.node.rec;
  const target = replyTo && replyable(replyTo) ? replyTo : lastIncoming;

  const sendReply = () => {
    const text = draft.trim();
    if (!text || !target) return;
    replyBottle(target, text).catch((e) =>
      log(`reply: ${(e as Error).message}`, "err")
    );
    setDraft("");
    setReplyTo(null);
  };

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar color="primary">
          <IonButtons slot="start">
            <IonBackButton defaultHref="/catch" />
          </IonButtons>
          <IonTitle>
            #{(chatId || "").slice(0, 8)}
            {chatRows.length > 0 &&
              ` · ${chatRows.length} message${chatRows.length === 1 ? "" : "s"}`}
          </IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <IonList inset>
          {chatRows.length === 0 && (
            <IonItem lines="none">
              <IonLabel className="ion-text-center ion-padding">
                <IonNote>loading thread…</IonNote>
              </IonLabel>
            </IonItem>
          )}
          {chatRows.map((row) => (
            <MessageRow
              key={row.node.rec.id}
              row={row}
              sentIds={sentIds}
              hasNew={false}
              showReplies={false}
              onOpen={(bid) => bid !== chatId && openThread(bid).catch(() => {})}
              onReply={setReplyTo}
            />
          ))}
        </IonList>
      </IonContent>

      <IonFooter>
        <IonToolbar>
          {replyTo && replyable(replyTo) && replyTo !== lastIncoming && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 8px",
                fontSize: 12,
                color: "var(--ion-color-medium)",
              }}
            >
              <span>
                ↩ replying to #{(replyTo.bottle?.id || "").slice(0, 8)}
              </span>
              <IonButton
                size="small"
                fill="clear"
                onClick={() => setReplyTo(null)}
              >
                <IonIcon icon={close} slot="icon-only" />
              </IonButton>
            </div>
          )}
          <IonItem lines="none">
            <IonTextarea
              placeholder={
                target ? "write a reply…" : "nothing to reply to yet"
              }
              value={draft}
              autoGrow
              rows={1}
              disabled={!target}
              onIonInput={(e) => setDraft(e.detail.value ?? "")}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendReply();
                }
              }}
            />
            <IonButton
              slot="end"
              fill="clear"
              disabled={!draft.trim() || !target}
              onClick={sendReply}
            >
              <IonIcon icon={send} slot="icon-only" />
            </IonButton>
          </IonItem>
        </IonToolbar>
      </IonFooter>
    </IonPage>
  );
}
