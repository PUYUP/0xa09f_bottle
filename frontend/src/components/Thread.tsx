import type { ThreadNode } from "../lib/store";
import { MAX_THREAD_DEPTH } from "../lib/crypto";
import { deleteBottle, reportBottle } from "../lib/store";
import { useApp } from "../hooks/useApp";

function MessageNode({
  node,
  sentIds,
  onOpen,
  onReply,
}: {
  node: ThreadNode;
  sentIds: Set<string>;
  onOpen?: (node: ThreadNode) => void;
  onReply?: (node: ThreadNode) => void;
}) {
  const { bottle, plain, kid, claim } = node.rec;
  const deleted = !!node.rec.deleted;
  const depth = bottle!.depth || 1;
  const isReply = !!bottle!.parentId;
  const isSent = claim?.status === "SENT";
  const canReply =
    !!plain?.reply && depth < MAX_THREAD_DEPTH && !isSent && !sentIds.has(bottle!.id);

  return (
    <div
      id={bottle?.id ? `msg-${bottle.id}` : undefined}
      className={`msg bevel-in${isReply ? " reply" : ""}${isSent ? " sent" : ""}${onOpen ? " clickable" : ""}`}
      onClick={onOpen ? () => onOpen(node) : undefined}
    >
      <div className="mb-1 text-[13px] text-neutral-600">
        <b>{isReply ? `re: ${(bottle!.parentId || "").slice(0, 8)}` : `🎣 ${(bottle!.id || "").slice(0, 8)}`}</b>
        {" · "}
        {claim?.status || "CLAIMED"} · {claim?.deliveries ?? "?"}/{bottle!.maxDeliveries} · depth{" "}
        {depth}/{MAX_THREAD_DEPTH} · key {(kid || "").slice(0, 8)}
        {isSent && " · (yours)"}
      </div>
      {deleted ? (
        <p className="text-[15px] italic text-neutral-500">[this message was deleted]</p>
      ) : (
        <p className="whitespace-pre-wrap text-[16px] leading-relaxed">{plain!.text}</p>
      )}
      {!deleted && (
      <div className="mt-1 text-[13px]">
        {isSent && (
          <button
            className="retro-btn retro-btn-sm"
            style={{ color: "#a00" }}
            onClick={(e) => {
              e.stopPropagation();
              deleteBottle(bottle!.id).catch((err) => console.error(err));
            }}
          >
            🗑 delete
          </button>
        )}
        {!isSent && (
          <button
            className="retro-btn retro-btn-sm"
            style={{ color: "#a00" }}
            onClick={(e) => {
              e.stopPropagation();
              reportBottle(bottle!.id).catch((err) => console.error(err));
            }}
          >
            ! report
          </button>
        )}
        {!isSent && canReply && onReply && (
          <button
            className="retro-btn retro-btn-sm"
            onClick={(e) => {
              e.stopPropagation();
              onReply(node);
            }}
          >
            ↩ reply
          </button>
        )}
      </div>
      )}
    </div>
  );
}

// FlatThread renders a whole thread as one straight list — no per-depth
// indentation. Messages are ordered by depth then timestamp so the
// conversation reads #0 root, #1 replies, #2 replies-to-replies, etc.
function collectNodes(node: ThreadNode, out: ThreadNode[] = []): ThreadNode[] {
  out.push(node);
  for (const c of node.children) collectNodes(c, out);
  return out;
}

function bottleTimeSec(rec: ThreadNode["rec"]): number {
  const c = rec.bottle?.createdAt || 0;
  return c > 1e11 ? Math.floor(c / 1000) : c;
}

export function FlatThread({
  root,
  onOpen,
  onReply,
}: {
  root: ThreadNode;
  onOpen?: (node: ThreadNode) => void;
  onReply?: (node: ThreadNode) => void;
}) {
  const { records } = useApp();
  const sentIds = new Set(
    records.filter((r) => r.id.startsWith("sent:")).map((r) => r.bottle?.id).filter(Boolean) as string[]
  );
  const nodes = collectNodes(root).sort((a, b) => {
    const da = a.rec.bottle?.depth || 1;
    const db = b.rec.bottle?.depth || 1;
    if (da !== db) return da - db;
    return bottleTimeSec(a.rec) - bottleTimeSec(b.rec);
  });
  return (
    <div className="chat-thread">
      <div className="mb-2 text-[13px] text-neutral-600">
        total messages: {nodes.length}
      </div>
      {nodes.map((n) => (
        <MessageNode key={n.rec.id} node={n} sentIds={sentIds} onOpen={onOpen} onReply={onReply} />
      ))}
    </div>
  );
}

export function findNode(roots: ThreadNode[], bottleId: string): ThreadNode | null {
  for (const r of roots) {
    if (r.rec.bottle?.id === bottleId) return r;
    const found = findNode(r.children, bottleId);
    if (found) return found;
  }
  return null;
}
