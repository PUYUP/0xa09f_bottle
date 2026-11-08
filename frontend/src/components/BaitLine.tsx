import { useEffect, useRef, useState } from "react";
import { useApp } from "../hooks/useApp";
import { baitStatus } from "../lib/store";
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
// animation, and an unread catch addressed to a key shows a pulsing dot
// until the message is opened.
export function BaitLine() {
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

  const slot = (k: KeyRecord) => {
    // persisted status wins; derive live when it's missing or the key just
    // transitioned (eaten animation runs before the sync lands)
    const status =
      eaten.has(k.kid) && !ownPoolKids.has(k.kid)
        ? "eaten"
        : k.status || baitStatus(k, ownPoolKids.has(k.kid));
    const meta = STATUS_META[status] ?? STATUS_META.pending;
    const anim =
      status === "active" ? "bait-bob" : eaten.has(k.kid) ? "bait-eaten" : "";
    return (
      <div key={k.kid} className={`bait-slot ${meta.cls}`} title={`${k.kid}\n${meta.label} · status: ${status}`}>
        {unreadKids.has(k.kid) && <span className="bait-unread-dot">!</span>}
        <span className={`bait-emoji ${anim}`}>{meta.emoji}</span>
        <span className="bait-kid">{k.kid.slice(0, 8)}…</span>
        <span className="bait-status">{meta.label}</span>
      </div>
    );
  };

  if (!keys.length) return null;
  return (
    <div className="mb-2">
      <div className="text-[12px] italic text-neutral-600">
        your bait line — 🎣 waiting · 😋 just eaten · 🍽️ used · 🫥 lost? · ❗ unread catch
      </div>
      <div className="bait-line bevel-in">{keys.map(slot)}</div>
    </div>
  );
}
