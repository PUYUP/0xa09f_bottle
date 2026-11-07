import type { ThreadNode } from "../lib/store";
import { MAX_THREAD_DEPTH } from "../lib/crypto";
import { replyBottle, reportBottle } from "../lib/store";
import { useApp } from "../hooks/useApp";

function MessageNode({ node, sentIds }: { node: ThreadNode; sentIds: Set<string> }) {
  const { bottle, plain, kid, claim } = node.rec;
  const depth = bottle!.depth || 1;
  const isReply = !!bottle!.parentId;
  const isSent = claim?.status === "SENT";
  const canReply =
    !!plain?.reply && depth < MAX_THREAD_DEPTH && !isSent && !sentIds.has(bottle!.id);

  return (
    <div className={`msg bevel-in${isReply ? " reply" : ""}${isSent ? " sent" : ""}`}>
      <div className="mb-1 text-[13px] text-neutral-600">
        <b>{isReply ? `↳ re: ${(bottle!.parentId || "").slice(0, 8)}` : `🎣 ${(bottle!.id || "").slice(0, 8)}`}</b>
        {" · "}
        {claim?.status || "CLAIMED"} · {claim?.deliveries ?? "?"}/{bottle!.maxDeliveries} · depth{" "}
        {depth}/{MAX_THREAD_DEPTH} · key {(kid || "").slice(0, 8)}
        {isSent && " · (yours)"}
      </div>
      <p className="whitespace-pre-wrap text-[16px] leading-relaxed">{plain!.text}</p>
      <div className="mt-1 text-[13px]">
        {!isSent && (
          <span
            className="retro-link text-red-800"
            onClick={() => reportBottle(bottle!.id).catch((e) => console.error(e))}
          >
            [! report]
          </span>
        )}
        {!isSent && canReply && (
          <>
            {" "}
            <span
              className="retro-link"
              onClick={() => {
                const text = window.prompt("write your reply…");
                if (!text?.trim()) return;
                replyBottle(node.rec, text.trim()).catch((e) => console.error(e));
              }}
            >
              [↩ reply]
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function Thread({ node, sentIds }: { node: ThreadNode; sentIds: Set<string> }) {
  const orphan = !!node.rec.bottle?.parentId;
  return (
    <div className={orphan ? "ml-6" : ""}>
      <MessageNode node={node} sentIds={sentIds} />
      {node.children.length > 0 && (
        <div className="ml-3 border-l-2 border-neutral-400 pl-2">
          {node.children.map((c) => (
            <Thread key={c.rec.id} node={c} sentIds={sentIds} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ThreadList({ roots }: { roots: ThreadNode[] }) {
  const { records } = useApp();
  const sentIds = new Set(
    records.filter((r) => r.id.startsWith("sent:")).map((r) => r.bottle?.id).filter(Boolean) as string[]
  );
  return (
    <>
      {roots.map((r) => (
        <Thread key={r.rec.id} node={r} sentIds={sentIds} />
      ))}
    </>
  );
}
