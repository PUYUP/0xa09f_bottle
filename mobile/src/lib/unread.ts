import type { ThreadRecord } from "@shared/types";

// Unread-reply badge for a thread root record: true when we participate in
// the thread (authored root or sent a reply inside) and inbound reply
// activity is newer than what we've opened. Our own replies bump
// threadLastAt for sort order but never count as inbound — stats activity
// only counts as inbound when it's newer than our newest reply in the
// thread (same clock domain: bottle.createdAt). Mirrors the web client's
// badge logic — kept local so mobile doesn't depend on frontend code.
export function hasUnreadReplies(rec: ThreadRecord, records: ThreadRecord[]): boolean {
  const bottleId = rec.bottle?.id || "";
  if (!bottleId) return false;
  const own = records.filter(
    (m) =>
      m.id.startsWith("sent:") &&
      (m.bottle?.id === bottleId || m.bottle?.rootId === bottleId)
  );
  if (!own.length) return false;
  let lastActivity = rec.threadLastAt || rec.lastChildAt || 0;
  if (lastActivity > 1e11) lastActivity = Math.floor(lastActivity / 1000);
  const ownLatest = Math.max(
    0,
    ...own.map((m) => {
      const c = m.bottle?.createdAt || 0;
      return c > 1e11 ? Math.floor(c / 1000) : c;
    })
  );
  const statInbound = lastActivity > ownLatest ? lastActivity : 0;
  const inboundAt = Math.max(rec.lastInboundAt || 0, statInbound);
  return inboundAt > 0 && inboundAt * 1000 > (rec.repliesSeenAt || 0);
}
