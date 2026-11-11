import { useEffect, useRef, useState, type ReactNode } from "react";
import { useApp } from "../hooks/useApp";
import { baitStatus, dismissEatenBait, openThread } from "../lib/store";
import type { KeyRecord } from "../lib/types";

const STATUS_META: Record<string, { emoji: string; label: string; cls: string }> = {
  pending: { emoji: "🥚", label: "pending", cls: "pending" },
  active: { emoji: "🎣", label: "in pool", cls: "" },
  eaten: { emoji: "😋", label: "eaten!", cls: "" },
  expired: { emoji: "🥀", label: "expired", cls: "expired" },
  lost: { emoji: "🫥", label: "lost?", cls: "used" },
};

// BaitLine renders the user's deposited keys as a row of lures. Each record
// carries a persisted `status` (synced from the pool on every refresh); a
// key still in the pool bobs gently, a freshly consumed one plays an "eaten"
// animation, and tapping an eaten bait marks its catch read and clears the
// slot from the line.
export function BaitLine({ onOpen, extra }: { onOpen?: (bottleId: string) => void; extra?: ReactNode }) {
  const { keys, ownPoolKids, records } = useApp();
  const [eaten, setEaten] = useState<Map<string, number>>(new Map());
  const prevPool = useRef<Set<string> | null>(null);

  useEffect(() => {
    const prev = prevPool.current;
    prevPool.current = new Set(ownPoolKids);
    if (!prev) return;
    const now = Date.now();
    const byKid = new Map(keys.map((k) => [k.kid, k]));
    const newly = [...prev].filter((kid) => {
      if (ownPoolKids.has(kid)) return false;
      const k = byKid.get(kid);
      // only animate genuine consumption — expired keys leaving the pool
      // aren't "eaten"
      return !!k && !(k.expiresAt && k.expiresAt <= now);
    });
    if (!newly.length) return;
    setEaten((m) => {
      const next = new Map(m);
      for (const kid of newly) next.set(kid, now);
      return next;
    });
    const timer = setTimeout(() => {
      setEaten((m) => {
        const next = new Map(m);
        for (const kid of newly) next.delete(kid);
        return next;
      });
    }, 3400);
    return () => clearTimeout(timer);
  }, [ownPoolKids, keys]);

  const unreadKids = new Set(
    records
      .filter((r) => r.id.startsWith("caught:") && !r.readAt && r.kid)
      .map((r) => r.kid as string)
  );

  const statusOf = (k: KeyRecord) =>
    eaten.has(k.kid) && !ownPoolKids.has(k.kid)
      ? "eaten"
      : k.status || baitStatus(k, ownPoolKids.has(k.kid));

  const slot = (k: KeyRecord) => {
    const status = statusOf(k);
    const meta = STATUS_META[status] ?? STATUS_META.pending;
    const anim =
      status === "active" ? "bait-bob" : eaten.has(k.kid) ? "bait-eaten" : "";
    const dismissible = status === "eaten" || status === "lost";
    // Tapping an eaten/lost bait opens the message it caught (latest catch
    // for that kid, preferring unread), then clears the slot.
    const openCatch = async () => {
      const catches = records
        .filter((r) => r.id.startsWith("caught:") && r.kid === k.kid)
        .sort((a, b) => Number(!!a.readAt) - Number(!!b.readAt) || (b.caughtAt || 0) - (a.caughtAt || 0));
      const target = catches[0];
      if (target) {
        const bottleId = target.id.slice("caught:".length);
        await openThread(bottleId).catch(() => {});
        onOpen?.(bottleId);
      }
      await dismissEatenBait(k.kid).catch(() => {});
    };
    const inner = (
      <>
        {unreadKids.has(k.kid) && <span className="bait-unread-dot">!</span>}
        <span className={`bait-emoji ${anim}`}>{meta.emoji}</span>
        <span className="bait-kid">{k.kid.slice(0, 8)}…</span>
        <span className="bait-status">{meta.label === "in pool" ? `${k.kid.slice(0, 5)}…` : meta.label}</span>
      </>
    );
    const cls = `bait-slot ${meta.cls}${dismissible ? " dismissible" : ""}`;
    const title = `${k.kid}\n${meta.label} · status: ${status}${
      dismissible ? "\ntap to mark read & clear" : ""
    }`;
    if (dismissible) {
      return (
        <button
          key={k.kid}
          type="button"
          className={cls}
          title={title}
          onClick={() => openCatch()}
        >
          {inner}
        </button>
      );
    }
    return (
      <div key={k.kid} className={cls} title={title}>
        {inner}
      </div>
    );
  };

  // Dismissed baits stay hidden unless they somehow become fishable again.
  const visible = keys.filter((k) => {
    if (!k.dismissedAt) return true;
    const s = statusOf(k);
    return s === "active" || s === "pending";
  });

  if (!visible.length) return null;
  return <div className="bait-line bevel-in">{visible.map(slot)}{extra}</div>;
}
