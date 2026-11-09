import type { ThreadRecord } from "@shared/types";

// Unread-reply badge for a thread root record: true when we participate in
// the thread (authored root or sent a reply inside) and inbound reply
// activity is newer than what we've opened. Our own replies bump
// threadLastAt for sort order but never count as inbound. Mirrors the web
// client's hasUnreadReplies — kept local so mobile doesn't depend on
// frontend component code.
export function hasUnreadReplies(rec: ThreadRecord, records: ThreadRecord[]): boolean {
  const bottleId = rec.bottle?.id || "";
  if (!bottleId) return false;
  const weInThread = records.some(
    (m) =>
      m.id.startsWith("sent:") &&
      (m.bottle?.id === bottleId || m.bottle?.rootId === bottleId)
  );
  if (!weInThread) return false;
  const lastActivity = rec.threadLastAt || rec.lastChildAt || 0;
  const lastReplyOurs = rec.lastReplyId
    ? records.some((m) => m.id === `sent:${rec.lastReplyId}`)
    : false;
  const inboundAt = rec.lastInboundAt ?? (lastReplyOurs ? 0 : lastActivity);
  return inboundAt > 0 && inboundAt * 1000 > (rec.repliesSeenAt || 0);
}
