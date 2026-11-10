import { IonButton, IonIcon, IonItem, IonLabel, IonNote } from "@ionic/react";
import { chatbox, trash } from "ionicons/icons";
import {
  deleteBottle,
  log,
  reportBottle,
} from "@shared/store";
import { MAX_THREAD_DEPTH } from "@shared/crypto";
import type { ThreadNode } from "@shared/store";
import type { ThreadRecord } from "@shared/types";
import type { Row } from "../lib/rows";

// total replies under a node, counting the locally-loaded subtree
const countDescendants = (n: ThreadNode): number =>
  n.children.reduce((acc, c) => acc + 1 + countDescendants(c), 0);

// One message bubble — shared by the catch list and the chat detail screen.
// WhatsApp-style: own messages right/aligned green, incoming left/gray,
// replies stack in a straight line (no depth indentation).
export function MessageRow({
  row,
  sentIds,
  hasNew,
  showReplies = true,
  onOpen,
  onReply,
}: {
  row: Row;
  sentIds: Set<string>;
  hasNew: boolean;
  // reply counter is shown in the chat detail only — the thread list keeps
  // just the unread badge to stay light.
  showReplies?: boolean;
  onOpen: (bottleId: string) => void;
  onReply: (rec: ThreadRecord) => void;
}) {
  const { node } = row;
  const { bottle, plain, claim } = node.rec;
  const isSent = claim?.status === "SENT";
  const canReply =
    !!plain?.reply &&
    (bottle?.depth || 1) < MAX_THREAD_DEPTH &&
    !isSent &&
    !sentIds.has(bottle?.id || "");

  return (
    <IonItem
      lines="full"
      button
      onClick={() => {
        const bid = bottle?.id;
        if (bid) onOpen(bid);
      }}
    >
      <IonLabel>
        <div className={isSent ? "wa-row wa-own" : "wa-row"}>
          <div className={node.rec.deleted ? "wa-bubble wa-deleted" : "wa-bubble"}>
            {node.rec.deleted ? "[this message was deleted]" : plain?.text}
          </div>
          <div className="wa-meta">
            <IonNote>
              {isSent ? "yours" : claim?.status || "CLAIMED"} ·{" "}
              {claim?.deliveries ?? "?"}/{bottle?.maxDeliveries} ·{" "}
              {(bottle?.id || "").slice(0, 8)}
              {showReplies && (() => {
                // Count only replies WE can read — the local subtree holds
                // exactly the bottles our keys decrypted (own replies +
                // replies addressed to our bottles). Server threadCount
                // counts every participant's replies and would leak the
                // existence of conversations between other users.
                const total = countDescendants(node);
                if (total <= 0) return null;
                return (
                  <span style={{ color: "#1a5276" }}>
                    {" "}· 💬 {total} repl{total === 1 ? "y" : "ies"}
                  </span>
                );
              })()}
              {hasNew && (
                <span style={{ color: "#c0392b", fontWeight: 700 }}> ● new</span>
              )}
            </IonNote>
          </div>
          {!isSent && !node.rec.deleted && (
            <div className="wa-actions">
              {canReply && (
                <IonButton
                  size="small"
                  fill="clear"
                  onClick={() => onReply(node.rec)}
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
            <div className="wa-actions">
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
}
