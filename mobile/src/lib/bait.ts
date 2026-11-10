import type { KeyRecord } from "@shared/types";
import type { PoolKeyStatus } from "@shared/store";

export interface BaitStatus {
  icon: string;
  label: string;
  // css class for colored text
  cls: string;
  // whether the icon should animate (live bait only)
  animated: boolean;
}

// Per-key bait status — mirrors the web client's my-bait panel:
// 🥚 on the bank / 🎣 in the water / 🕸 gone cold / 😋 eaten / 🫥 lost at sea.
export function baitStatus(
  k: KeyRecord,
  statuses: Map<string, PoolKeyStatus> | null,
  ownPoolKids: Set<string>,
  // local ground truth: a caught:<bottleId> record exists for this kid.
  // server pool status can lag, so callers should OR it with st?.consumed.
  eaten?: boolean
): BaitStatus {
  const st = statuses?.get(k.kid);
  const isEaten = eaten ?? !!st?.consumed;
  if (!k.depositedAt) {
    return { icon: "🥚", label: "on the bank", cls: "bait-amber", animated: false };
  }
  if (ownPoolKids.has(k.kid)) {
    const remaining = k.expiresAt ? (k.expiresAt - Date.now()) / 1000 : NaN;
    return {
      icon: "🎣",
      label: remaining > 0 ? `in the water · ${formatRemaining(remaining)}` : "in the water",
      cls: "bait-green",
      animated: true,
    };
  }
  if (k.expiresAt && k.expiresAt <= Date.now()) {
    return { icon: "🕸", label: "gone cold", cls: "bait-red", animated: false };
  }
  if (isEaten) {
    return { icon: "😋", label: "eaten!", cls: "bait-blue", animated: false };
  }
  return { icon: "🫥", label: "lost at sea", cls: "bait-blue", animated: false };
}

function formatRemaining(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}
