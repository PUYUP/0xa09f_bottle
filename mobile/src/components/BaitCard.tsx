import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonCol,
  IonGrid,
  IonNote,
  IonRow,
} from "@ionic/react";
import {
  fetchPoolStatus,
  getState,
  subscribe,
} from "@shared/store";
import type { PoolKeyStatus } from "@shared/store";
import { baitStatus } from "../lib/bait";

const SHOWN = 12;

// Compact bait overview for the home (catch) tab — animated per-key status
// indicators mirroring the web client's my-bait panel, laid out as a grid.
// Eaten bait is tappable and opens the caught message's chat thread.
export function BaitCard({
  onOpenChat,
}: {
  onOpenChat?: (bottleId: string, kid?: string) => void;
}) {
  const state = useSyncExternalStore(subscribe, getState);
  const { keys, ownPoolKids, activePoolKeys, records } = state;
  const [statuses, setStatuses] = useState<Map<string, PoolKeyStatus> | null>(null);
  const booted = useRef(false);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const deposited = keys.filter((k) => k.depositedAt).map((k) => k.kid);
    if (!deposited.length) {
      setStatuses(new Map());
      return;
    }
    fetchPoolStatus(deposited)
      .then((list) => setStatuses(new Map(list.map((s) => [s.kid, s]))))
      .catch(() => setStatuses(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inWater = keys.filter((k) => ownPoolKids.has(k.kid)).length;
  // dismissed bait (tapped eaten keys) is cleared from the card, same as web.
  const shown = keys.filter((k) => !k.dismissedAt);
  const visible = shown.slice(0, SHOWN);
  const rows = Math.ceil(visible.length / 3);

  // kid → caught bottle id, so eaten bait can deep-link into its thread.
  const caughtByKid = new Map(
    records
      .filter((r) => r.id.startsWith("caught:") && r.kid && r.bottle?.id)
      .map((r) => [r.kid as string, r.bottle!.id])
  );

  return (
    <IonCard className="ion-margin-top">
      <IonCardHeader>
        <IonCardTitle style={{ fontSize: 15 }}>
          🎣 your bait — {activePoolKeys ?? "…"}/5 in the water
        </IonCardTitle>
      </IonCardHeader>
      <IonCardContent>
        {shown.length === 0 ? (
          <IonNote>no bait yet — throw some from the bait tab</IonNote>
        ) : (
          <IonGrid className="ion-no-padding ion-padding-horizontal">
            {Array.from({ length: rows }, (_, r) => (
              <IonRow key={r}>
                {visible.slice(r * 3, r * 3 + 3).map((k) => {
                  const eaten =
                    caughtByKid.has(k.kid) || !!statuses?.get(k.kid)?.consumed;
                  const s = baitStatus(k, statuses, ownPoolKids, eaten);
                  const bottleId = eaten ? caughtByKid.get(k.kid) : undefined;
                  const clickable = !!bottleId && !!onOpenChat;
                  return (
                    <IonCol size="4" key={k.kid}>
                      <div
                        onClick={clickable ? () => onOpenChat!(bottleId!, k.kid) : undefined}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          padding: "8px 2px",
                          gap: 2,
                          borderRadius: 8,
                          cursor: clickable ? "pointer" : "default",
                          background: clickable ? "rgba(0,0,0,0.04)" : "transparent",
                        }}
                      >
                        <div style={{ height: 26, display: "flex", alignItems: "center" }}>
                          {s.animated ? (
                            <span className="bait-live" style={{ fontSize: 22 }}>
                              {s.icon}
                            </span>
                          ) : (
                            <span style={{ fontSize: 22 }}>{s.icon}
                              {clickable && <span style={{ fontSize: 12 }}> ›</span>}
                            </span>
                          )}
                        </div>
                        <span
                          style={{
                            fontFamily: "monospace",
                            fontSize: 10,
                            color: "var(--ion-color-medium)",
                          }}
                        >
                          {k.kid.slice(0, 8)}…
                        </span>
                        <span className={s.cls} style={{ fontSize: 10, textAlign: "center" }}>
                          {s.label.split(" · ")[0]}
                        </span>
                      </div>
                    </IonCol>
                  );
                })}
              </IonRow>
            ))}
          </IonGrid>
        )}
        {shown.length > SHOWN && (
          <IonNote style={{ display: "block", marginTop: 6 }}>
            +{shown.length - SHOWN} more in the bait tab
          </IonNote>
        )}
        {inWater > 0 && (
          <IonNote style={{ display: "block", marginTop: 6 }}>
            <span className="bait-live-dot" />
            {inWater} live{inWater === 1 ? "" : "s"} waiting for catches
          </IonNote>
        )}
      </IonCardContent>
    </IonCard>
  );
}
