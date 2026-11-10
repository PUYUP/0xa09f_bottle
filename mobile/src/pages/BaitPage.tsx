import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  IonAlert,
  IonButton,
  IonIcon,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonTitle,
  IonToolbar,
} from "@ionic/react";
import { fish, refresh } from "ionicons/icons";
import {
  fetchPoolStatus,
  formatExpiry,
  formatTTL,
  generateAndDeposit,
  getState,
  log,
  readTTLSeconds,
  refreshActivePoolKeys,
  refreshPoolKeys,
  restorePoolKeys,
  subscribe,
} from "@shared/store";
import type { PoolKeyStatus } from "@shared/store";
import type { KeyRecord } from "@shared/types";

const BAIT_PAGE = 50;

export function BaitPage() {
  const state = useSyncExternalStore(subscribe, getState);
  const { keys, ownPoolKids, activePoolKeys, poolKeys, poolSize } = state;
  const [baitOpen, setBaitOpen] = useState(false);
  const [shown, setShown] = useState(BAIT_PAGE);
  const [statuses, setStatuses] = useState<Map<string, PoolKeyStatus> | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const booted = useRef(false);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    refreshActivePoolKeys().catch(() => {});
    refreshPoolKeys(0).catch((e) => log(`pool: ${(e as Error).message}`, "err"));
  }, []);

  const depositedKids = keys.filter((k) => k.depositedAt).map((k) => k.kid);
  const checkSync = () => {
    if (!depositedKids.length) {
      setStatuses(new Map());
      return;
    }
    setSyncBusy(true);
    fetchPoolStatus(depositedKids)
      .then((list) => setStatuses(new Map(list.map((s) => [s.kid, s]))))
      .catch(() => setStatuses(null))
      .finally(() => setSyncBusy(false));
  };
  useEffect(checkSync, []); // eslint-disable-line react-hooks/exhaustive-deps

  const nowMs = Date.now();
  const lost = keys.filter((k) => {
    if (!k.depositedAt || (k.expiresAt && k.expiresAt <= nowMs)) return false;
    const st = statuses?.get(k.kid);
    return !!st && !st.inPool && !st.consumed;
  });
  const visible = keys.slice(0, shown);
  const own = keys.filter((k) => ownPoolKids.has(k.kid));
  const others = (poolKeys ?? []).filter((k) => !ownPoolKids.has(k.kid));
  const fetched = poolKeys?.length ?? 0;
  const hasMore = poolKeys !== null && fetched < (poolSize ?? 0);

  const keyStatus = (k: KeyRecord): { meta: string; cls: string } => {
    const st = statuses?.get(k.kid);
    if (!k.depositedAt) {
      return { meta: `🥚 on the bank · tied ${k.createdAt ? new Date(k.createdAt).toLocaleString() : "—"}`, cls: "text-amber-700" };
    }
    if (ownPoolKids.has(k.kid)) {
      const remaining = k.expiresAt ? (k.expiresAt - Date.now()) / 1000 : NaN;
      return {
        meta: `🎣 in the water${k.expiresAt ? ` · ${remaining > 0 ? formatTTL(remaining) : "expired"}` : ""}`,
        cls: "text-green-700",
      };
    }
    if (k.expiresAt && k.expiresAt <= Date.now()) {
      return { meta: `🕸 gone cold · ${new Date(k.expiresAt).toLocaleString()}`, cls: "text-red-700" };
    }
    if (st?.consumed) {
      return { meta: `😋 eaten! · ${k.depositedAt ? new Date(k.depositedAt).toLocaleString() : "—"}`, cls: "text-blue-800" };
    }
    return { meta: `🫥 lost at sea · ${k.depositedAt ? new Date(k.depositedAt).toLocaleString() : "—"}`, cls: "text-blue-800" };
  };

  return (
    <>
      <IonHeader>
        <IonToolbar color="primary">
          <IonTitle>bait</IonTitle>
        </IonToolbar>
      </IonHeader>
      <div className="tab-scroll ion-padding">
      <IonButton expand="block" className="ion-margin-top" onClick={() => setBaitOpen(true)}>
        <IonIcon icon={fish} slot="start" />
        throw bait
      </IonButton>

      {/* pool sync */}
      <IonItem lines="full" className="ion-margin-top">
        <IonLabel>
          <strong>🔄 pool sync</strong>
          <p>
            {statuses === null
              ? "status unavailable"
              : lost.length === 0
                ? `all live bait is in the water · active in pool: ${activePoolKeys ?? "…"}`
                : `⚠ ${lost.length} bait missing from the water — re-cast to restore`}
          </p>
        </IonLabel>
        <IonButton
          slot="end"
          size="small"
          fill="outline"
          disabled={syncBusy}
          onClick={checkSync}
        >
          <IonIcon icon={refresh} slot="icon-only" />
        </IonButton>
        {lost.length > 0 && (
          <IonButton
            slot="end"
            size="small"
            disabled={syncBusy}
            onClick={() => {
              setSyncBusy(true);
              restorePoolKeys(lost)
                .then((n) => {
                  log(`restored ${n} key(s) to the pool`);
                  checkSync();
                })
                .catch((e) => log(`restore failed: ${(e as Error).message}`, "err"))
                .finally(() => setSyncBusy(false));
            }}
          >
            re-cast {lost.length}
          </IonButton>
        )}
      </IonItem>

      {/* my keys */}
      <IonList inset>
        {keys.length === 0 && (
          <IonItem lines="none">
            <IonLabel className="ion-text-center ion-padding">
              no bait yet — hit "throw bait"
            </IonLabel>
          </IonItem>
        )}
        {visible.map((k) => {
          const s = keyStatus(k);
          return (
            <IonItem key={k.kid} lines="full">
              <IonLabel>
                <p style={{ fontFamily: "monospace", fontSize: 13 }}>{k.kid.slice(0, 13)}…</p>
                <IonNote>{s.meta}</IonNote>
              </IonLabel>
            </IonItem>
          );
        })}
      </IonList>
      {shown < keys.length && (
        <div className="ion-text-center ion-padding-bottom">
          <IonButton size="small" fill="outline" onClick={() => setShown((s) => s + BAIT_PAGE)}>
            show more ({keys.length - shown} left)
          </IonButton>
        </div>
      )}

      {/* public pool browser */}
      <IonItem lines="full">
        <IonLabel>
          <strong>🌊 bait pool</strong>
          <p className="ion-text-wrap">
            {(poolSize ?? 0).toLocaleString()} public keys anyone can cast a sealed catch to
            {own.length > 0 && ` · ${own.length} yours in the water`}
          </p>
        </IonLabel>
        <IonButton
          slot="end"
          size="small"
          fill="outline"
          onClick={() =>
            refreshPoolKeys(fetched).catch((e) =>
              log(`pool: ${(e as Error).message}`, "err")
            )
          }
        >
          refresh
        </IonButton>
      </IonItem>
      <IonList inset>
        {poolKeys === null && (
          <IonItem lines="none">
            <IonLabel>loading…</IonLabel>
          </IonItem>
        )}
        {poolKeys?.length === 0 && own.length === 0 && (
          <IonItem lines="none">
            <IonLabel>the sea is empty — no bait in the pool</IonLabel>
          </IonItem>
        )}
        {own.map((k) => (
          <IonItem key={`own-${k.kid}`} lines="none">
            <IonLabel>
              <p style={{ fontFamily: "monospace", fontSize: 13 }}>★ {k.kid.slice(0, 13)}…</p>
              <IonNote>yours · {formatExpiry(k.expiresAt)}</IonNote>
            </IonLabel>
          </IonItem>
        ))}
        {others.slice(0, 30).map((k, i) => (
          <IonItem key={k.kid} lines="none">
            <IonLabel>
              <p style={{ fontFamily: "monospace", fontSize: 13 }}>
                {i + 1}. {k.kid.slice(0, 13)}…
              </p>
              <IonNote>{formatExpiry(k.expiresAt)}</IonNote>
            </IonLabel>
          </IonItem>
        ))}
      </IonList>
      {hasMore && (
        <div className="ion-text-center ion-padding-bottom">
          <IonNote>
            showing {others.length.toLocaleString()} / {(poolSize ?? 0).toLocaleString()} —{" "}
            <span
              style={{ color: "var(--ion-color-primary)", cursor: "pointer" }}
              onClick={() =>
                refreshPoolKeys(fetched).catch((e) =>
                  log(`pool: ${(e as Error).message}`, "err")
                )
              }
            >
              load more
            </span>
          </IonNote>
        </div>
      )}

      {/* throw bait dialog */}
      <IonAlert
        isOpen={baitOpen}
        onDidDismiss={() => setBaitOpen(false)}
        header="throw bait"
        message="publish a fresh keypair into the pool so strangers can cast sealed catches to it"
        inputs={[
          {
            name: "ttl",
            type: "number",
            value: "86400",
            placeholder: "ttl seconds",
          },
        ]}
        buttons={[
          { text: "cancel", role: "cancel" },
          {
            text: "throw it",
            handler: (data) => {
              const v = String(data?.values?.ttl ?? "86400");
              if (!readTTLSeconds(v)) {
                log("invalid ttl", "warn");
                return false;
              }
              generateAndDeposit(v).catch((e) =>
                log(`bait: ${(e as Error).message}`, "err")
              );
            },
          },
        ]}
      />
      </div>
    </>
  );
}

