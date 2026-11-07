import type { ThreadNode } from "../lib/store";
import { MAX_THREAD_DEPTH } from "../lib/crypto";
import { replyBottle, reportBottle } from "../lib/store";
import { useApp } from "../hooks/useApp";

function MessageNode({ node, sentIds }: { node: ThreadNode; sentIds: Set<string> }) {
  const { bottle, plain, kid, claim } = node.rec;
  const depth = bottle!.depth || 1;
  const isReply = !!bottle!.parentId;
  const canReply =
    !!plain?.reply && depth < MAX_THREAD_DEPTH && claim?.status !== "SENT" && !sentIds.has(bottle!.id);

  return (
    <div className={isReply ? "msg reply" : "msg"}>
      <div className="flex items-baseline gap-3 text-[11px] text-neutral-500">
        <span className="text-neutral-300">{isReply ? `↳ reply to ${(bottle!.parentId || "").slice(0, 8)}` : bottle!.id.slice(0, 8)}</span>
        <span>
          {claim?.status || "CLAIMED"} · {claim?.deliveries ?? "?"}/{bottle!.maxDeliveries} · depth {depth}/{MAX_THREAD_DEPTH} · key {(kid || "").slice(0, 8)}
        </span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-neutral-100">{plain!.text}</p>
      <div className="mt-1 flex gap-2">
        {claim?.status !== "SENT" && (
          <button
            className="text-[11px] text-neutral-500 hover:text-red-400"
            onClick={() => reportBottle(bottle!.id).catch((e) => console.error(e))}
          >
            [ report ]
          </button>
        )}
        {canReply && (
          <button
            className="text-[11px] text-neutral-500 hover:text-emerald-400"
            onClick={() => {
              const text = window.prompt("reply message");
              if (!text?.trim()) return;
              replyBottle(node.rec, text.trim()).catch((e) => console.error(e));
            }}
          >
            [ reply ]
          </button>
        )}
      </div>
    </div>
  );
}

function Thread({ node, sentIds }: { node: ThreadNode; sentIds: Set<string> }) {
  const orphan = !!node.rec.bottle?.parentId;
  return (
    <article className={`thread bottle${orphan ? " orphan" : ""}`}>
      <MessageNode node={node} sentIds={sentIds} />
      {node.children.length > 0 && (
        <div className="replies ml-4 border-l border-neutral-800 pl-3">
          {node.children.map((c) => (
            <Thread key={c.rec.id} node={c} sentIds={sentIds} />
          ))}
        </div>
      )}
    </article>
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
