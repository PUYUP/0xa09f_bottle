import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { subscribe } from "../lib/store";
import { getIdentityRecord, randomUsername as genName } from "../lib/identity";
import {
  blockOrReportUser,
  claimUsernameUI,
  changeUsernameUI,
  deleteAccount,
  exportVault,
  fetchDevices,
  fetchMyStats,
  fetchPoolStatus,
  formatExpiry,
  formatTTL,
  getClientMeta,
  importVaultFile,
  log,
  refreshActivePoolKeys,
  refreshBlocks,
  refreshPoolKeys,
  restorePoolKeys,
  revokeDevice,
  unblockUser,
} from "../lib/store";
import type { ClientMeta, DeviceInfo, PoolKeyStatus, UserStats } from "../lib/store";
import { billingStatus, checkout, extendTrial, type Entitlement } from "../lib/billing";
import { useApp } from "../hooks/useApp";
import type { KeyRecord } from "../lib/types";

function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="bevel mb-2">
      <div className="retro-titlebar">
        <span>{title}</span>
        <button className="retro-btn" style={{ padding: "0 6px" }} onClick={onClose}>✕</button>
      </div>
      <div className="retro-body">{children}</div>
    </div>
  );
}

const BAIT_PAGE = 50;

function formatUTCOffset(minutes?: number): string {
  if (minutes == null) return "?";
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

export function MyKeysPanel({ onClose }: { onClose: () => void }) {
  const { keys, ownPoolKids, activePoolKeys } = useApp();
  const [shown, setShown] = useState(BAIT_PAGE);
  const visible = keys.slice(0, shown);
  const [refreshed, setRefreshed] = useState(false);
  const [statuses, setStatuses] = useState<Map<string, PoolKeyStatus> | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  if (!refreshed) {
    setRefreshed(true);
    refreshActivePoolKeys().catch(() => {});
  }

  const checkSync = () => {
    const deposited = keys.filter((k) => k.depositedAt).map((k) => k.kid);
    if (!deposited.length) {
      setStatuses(new Map());
      return;
    }
    setSyncBusy(true);
    fetchPoolStatus(deposited)
      .then((list) => setStatuses(new Map(list.map((s) => [s.kid, s]))))
      .catch(() => setStatuses(null))
      .finally(() => setSyncBusy(false));
  };
  useEffect(checkSync, []);

  // "Lost" = deposited, unexpired client-side, absent from the live pool,
  // and the registry says it was never consumed — the Redis-collapse case.
  const nowMs = Date.now();
  const lost = keys.filter((k) => {
    if (!k.depositedAt || (k.expiresAt && k.expiresAt <= nowMs)) return false;
    const st = statuses?.get(k.kid);
    return !!st && !st.inPool && !st.consumed;
  });
  const usedCount = keys.filter((k) => {
    if (!k.depositedAt) return false;
    const st = statuses?.get(k.kid);
    return !!st && st.consumed;
  }).length;

  return (
    <Panel title={`🪱 my bait (${keys.length})`} onClose={onClose}>
      <div className="bevel-in mb-2 p-2 text-[13px]">
        <div className="mb-1 flex items-center justify-between">
          <b>🔄 pool sync</b>
          <button className="retro-btn" style={{ padding: "0 8px" }} disabled={syncBusy} onClick={checkSync}>
            {syncBusy ? "checking…" : "check"}
          </button>
        </div>
        {statuses === null ? (
          <div className="text-neutral-600">status unavailable</div>
        ) : lost.length === 0 ? (
          <div className="text-green-700">
            all live bait is in the water{usedCount > 0 ? ` · ${usedCount} eaten` : ""}
          </div>
        ) : (
          <>
            <div className="mb-1 text-amber-700">
              ⚠ {lost.length} bait missing from the water{usedCount > 0 ? ` · ${usedCount} eaten` : ""} — re-cast to restore
            </div>
            <div className="mb-1 font-mono text-[12px] text-neutral-600">
              {lost.map((k) => k.kid.slice(0, 13) + "…").join("  ")}
            </div>
            <button
              className="retro-btn"
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
              re-cast {lost.length} bait
            </button>
          </>
        )}
      </div>
      <div className="max-h-80 overflow-y-auto">
      <table className="w-full text-[13px]">
        <tbody>
          {keys.length === 0 && (
            <tr><td className="text-neutral-600">no bait yet — hit "throw bait"</td></tr>
          )}
          {visible.map((k: KeyRecord) => {
            const st = statuses?.get(k.kid);
            let meta: string;
            let cls = "";
            if (!k.depositedAt) {
              meta = `🥚 on the bank · tied ${k.createdAt ? new Date(k.createdAt).toLocaleString() : "—"}`;
              cls = "text-amber-700";
            } else if (ownPoolKids.has(k.kid)) {
              const remaining = k.expiresAt ? (k.expiresAt - Date.now()) / 1000 : NaN;
              meta = `🎣 in the water${k.expiresAt ? ` · ${remaining > 0 ? formatTTL(remaining) : "expired"}` : ""}`;
              cls = "text-green-700";
            } else if (k.expiresAt && k.expiresAt <= Date.now()) {
              meta = `🕸 gone cold · ${new Date(k.expiresAt).toLocaleString()}`;
              cls = "text-red-700";
            } else if (st?.consumed) {
              meta = `😋 eaten! · ${k.depositedAt ? new Date(k.depositedAt).toLocaleString() : "—"}`;
              cls = "text-blue-800";
            } else {
              meta = `🫥 lost at sea · ${k.depositedAt ? new Date(k.depositedAt).toLocaleString() : "—"}`;
              cls = "text-blue-800";
            }
            return (
              <tr key={k.kid}>
                <td className="pr-3 font-mono" title={k.kid}>{k.kid.slice(0, 13)}…</td>
                <td className={cls}>{meta}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      <div className="mt-2 flex items-center gap-3 text-[13px]">
        <span className="text-neutral-600">
          showing {Math.min(shown, keys.length)} / {keys.length}
        </span>
        {shown < keys.length && (
          <button className="retro-btn" onClick={() => setShown((s) => s + BAIT_PAGE)}>
            show more
          </button>
        )}
      </div>
      <p className="mt-1 text-[13px] text-neutral-600">active in pool: {activePoolKeys ?? "…"}</p>
    </Panel>
  );
}

export function PoolPanel({ onClose }: { onClose: () => void }) {
  const { poolKeys, poolSize, ownPoolKids, keys } = useApp();
  const [loaded, setLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  if (!loaded) {
    setLoaded(true);
    refreshPoolKeys(0).catch((e) => log(`pool: ${(e as Error).message}`, "err"));
    refreshActivePoolKeys().catch(() => {});
  }
  const own = keys.filter((k) => ownPoolKids.has(k.kid));
  const others = (poolKeys ?? []).filter((k) => !ownPoolKids.has(k.kid));
  const fetched = poolKeys?.length ?? 0;
  const hasMore = poolKeys !== null && fetched < (poolSize ?? 0);
  return (
    <Panel title={`🌊 bait pool (${(poolSize ?? 0).toLocaleString()} keys)`} onClose={onClose}>
      <p className="mb-2 text-[13px] text-neutral-600">
        public keys anyone can cast a sealed catch to — the server cannot tell which ones are yours.
      </p>
      <div className="max-h-80 overflow-y-auto">
        <table className="w-full text-[13px]">
          <tbody>
            {poolKeys === null && <tr><td className="text-neutral-600">loading…</td></tr>}
            {own.map((k) => (
              <tr key={`own-${k.kid}`}>
                <td className="pr-3 font-mono">★</td>
                <td className="pr-3 font-mono">{k.kid.slice(0, 13)}…</td>
                <td className="text-green-700">yours · {formatExpiry(k.expiresAt)}</td>
              </tr>
            ))}
            {poolKeys?.length === 0 && own.length === 0 && (
              <tr><td className="text-neutral-600">the sea is empty — no bait in the pool</td></tr>
            )}
            {others.map((k, i) => (
              <tr key={k.kid}>
                <td className="pr-3 font-mono">{i + 1}.</td>
                <td className="pr-3 font-mono">{k.kid.slice(0, 13)}…</td>
                <td className="text-neutral-600">{formatExpiry(k.expiresAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex items-center gap-3 text-[13px]">
        <span className="text-neutral-600">
          showing {others.length.toLocaleString()} / {(poolSize ?? 0).toLocaleString()}
        </span>
        {hasMore && (
          <button
            className="retro-btn"
            disabled={loadingMore}
            onClick={() => {
              setLoadingMore(true);
              refreshPoolKeys(fetched)
                .catch((e) => log(`pool: ${(e as Error).message}`, "err"))
                .finally(() => setLoadingMore(false));
            }}
          >
            {loadingMore ? "loading…" : "load more"}
          </button>
        )}
      </div>
    </Panel>
  );
}

export function AccountPanel({ onClose }: { onClose: () => void }) {
  const [username, setUsername] = useState("");
  const identity = useAppIdentity();

  return (
    <Panel title="👤 account" onClose={onClose}>
      <div className="space-y-3 text-[14px]">
        <div>
          {identity?.username ? (
            <>
              signed in as <b>@{identity.username}</b>{" "}
              <span className="font-mono text-[13px] text-neutral-600">({identity.userId})</span>
            </>
          ) : (
            <i>anonymous — claim a username to enable blocking, reporting &amp; stats</i>
          )}
        </div>
        {identity?.username ? (
          <div className="flex gap-2">
            <input
              className="retro-input flex-1"
              placeholder="new username (once every 7 days)"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <button className="retro-btn" onClick={() => setUsername(genName())} title="random username">
              ⚄
            </button>
            <button
              className="retro-btn"
              onClick={() => changeUsernameUI(username).catch((e) => log(`rename: ${(e as Error).message}`, "err"))}
            >
              rename
            </button>
          </div>
        ) : (
        <div className="flex gap-2">
          <input
            className="retro-input flex-1"
            placeholder="choose a username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <button className="retro-btn" onClick={() => setUsername(genName())} title="random username">
            ⚄
          </button>
          <button
            className="retro-btn"
            onClick={() => claimUsernameUI(username.trim()).catch((e) => log(`claim: ${(e as Error).message}`, "err"))}
          >
            claim
          </button>
        </div>
        )}
        {identity?.username && (
          <div className="border-t border-neutral-300 pt-2">
            <p className="mb-1 text-[13px] text-neutral-600">
              danger zone — permanent, cannot be undone:
            </p>
            <button
              className="retro-btn"
              style={{ color: "#a00" }}
              onClick={() => {
                if (!window.confirm(`delete @${identity.username} permanently? your username, blocks, reports and sync data are erased; messages already delivered to others stay readable by them.`)) return;
                if (!window.confirm("are you absolutely sure? this cannot be undone.")) return;
                deleteAccount().catch((e) => log(`delete account: ${(e as Error).message}`, "err"));
              }}
            >
              🗑 delete account
            </button>
          </div>
        )}
      </div>
    </Panel>
  );
}

export function SubscriptionCard() {
  const identity = useAppIdentity();
  const [billing, setBilling] = useState<Entitlement | null>(null);

  useEffect(() => {
    if (!identity?.username) return;
    billingStatus().then(setBilling).catch(() => setBilling(null));
  }, [identity?.username]);

  const fmt = (unix: number) =>
    unix ? new Date(unix * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";

  return (
    <InfoCard title="💳 subscription">
      {!identity?.username && <span className="text-neutral-600">claim a username first</span>}
      {identity?.username && billing === null && <span className="text-neutral-600">loading…</span>}
      {billing && (
        <div className="space-y-1 text-[13px]">
          <div>
            status <b>{billing.status}</b>
            {billing.entitled && billing.daysLeft > 0 && (
              <span className="text-neutral-600"> · {billing.daysLeft}d left</span>
            )}
          </div>
          {billing.status === "trialing" && (
            <div className="text-neutral-600">
              trial ends {fmt(billing.trialEndsAt)}
              {billing.extensionsLeft > 0 && ` · ${billing.extensionsLeft} extension(s) left`}
            </div>
          )}
          {billing.periodEnd > 0 && (
            <div className="text-neutral-600">paid period ends {fmt(billing.periodEnd)}</div>
          )}
          {!billing.entitled && billing.canExtend && (
            <div className="text-amber-700">trial lapsed — extend once or subscribe</div>
          )}
          {!billing.entitled && !billing.canExtend && (
            <div className="text-red-700">access blocked — subscribe to continue</div>
          )}
          {billing.status !== "active" && billing.status !== "past_due" && (
            <div className="flex gap-3 pt-1">
              {billing.canExtend && (
                <span className="retro-link" onClick={() => extendTrial().then(setBilling).catch(() => {})}>
                  extend trial
                </span>
              )}
              <span className="retro-link" onClick={() => checkout("monthly").then((u) => { window.location.href = u; }).catch(() => {})}>
                subscribe $2/mo
              </span>
              <span className="retro-link" onClick={() => checkout("yearly").then((u) => { window.location.href = u; }).catch(() => {})}>
                $10/yr
              </span>
            </div>
          )}
        </div>
      )}
    </InfoCard>
  );
}

export function DevicesCard() {
  const identity = useAppIdentity();
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);

  useEffect(() => {
    if (!identity?.username) return;
    fetchDevices().then(setDevices).catch(() => setDevices([]));
  }, [identity?.username]);

  return (
    <InfoCard title="📱 your devices">
      {!identity?.username && <span className="text-neutral-600">claim a username first</span>}
      {identity?.username && devices === null && <span className="text-neutral-600">loading…</span>}
      {devices?.length === 0 && <span className="text-neutral-600">no devices registered yet</span>}
      {devices?.map((d) => (
        <div key={d.deviceId} className="flex items-baseline gap-3 py-0.5">
          <span title={d.deviceId} className="font-mono text-[12px]">
            {d.deviceId.slice(0, 8)}…
          </span>
          <span className="text-[12px] text-neutral-600">
            {d.userAgent ? d.userAgent.slice(0, 40) : "unknown client"} · seen{" "}
            {new Date(d.lastSeen * 1000).toLocaleString()}
            {d.current && " · this device"}
            {d.revoked && " · revoked"}
          </span>
          {!d.current && !d.revoked && (
            <span
              className="retro-link text-[13px]"
              onClick={() =>
                revokeDevice(d.deviceId)
                  .then(() => fetchDevices().then(setDevices))
                  .catch((e) => log(`revoke: ${(e as Error).message}`, "err"))
              }
            >
              revoke
            </span>
          )}
        </div>
      ))}
    </InfoCard>
  );
}

export function BlocksCard() {
  const { blocks } = useApp();
  const [target, setTarget] = useState("");
  const identity = useAppIdentity();

  useEffect(() => {
    if (blocks === null) refreshBlocks().catch(() => {});
  }, [blocks]);

  return (
    <InfoCard title="🚫 blocked users">
      {!identity?.username && <span className="text-neutral-600">claim a username to manage blocks</span>}
      {identity?.username && (
        <>
          <div className="mb-2 flex gap-2">
            <input
              className="retro-input flex-1"
              placeholder="username or user id"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
            <button
              className="retro-btn"
              onClick={() => blockOrReportUser("block", target).catch((e) => log(`block: ${(e as Error).message}`, "err"))}
            >
              block
            </button>
            <button
              className="retro-btn"
              onClick={() => blockOrReportUser("report", target).catch((e) => log(`report: ${(e as Error).message}`, "err"))}
            >
              report
            </button>
          </div>
          <div>
            {blocks === null && <span className="text-neutral-600">loading…</span>}
            {blocks?.length === 0 && <span className="text-neutral-600">not blocking anyone</span>}
            {blocks?.map((b) => (
              <div key={b.blockedUserId} className="flex items-baseline gap-3 py-0.5">
                <span title={`${b.blockedUserId}${b.reason ? ` · ${b.reason}` : ""}`}>
                  @{b.username}
                </span>
                <span
                  className="retro-link text-[13px]"
                  onClick={() => unblockUser(b.blockedUserId).catch((e) => log(`unblock: ${(e as Error).message}`, "err"))}
                >
                  unblock
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </InfoCard>
  );
}

function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bevel mb-2">
      <div className="retro-titlebar">
        <span>{title}</span>
      </div>
      <div className="retro-body text-[14px]">{children}</div>
    </div>
  );
}

export function DeviceCard() {
  const [meta, setMeta] = useState<ClientMeta | null>(null);
  if (!meta) {
    getClientMeta().then(setMeta).catch(() => {});
  }
  return (
    <InfoCard title="🖥 your device & network">
      {!meta && <span className="text-neutral-600">loading…</span>}
      {meta && (
        <>
          <table className="w-full text-[13px]">
            <tbody>
              <tr><td className="pr-3">ip (as seen by relay)</td><td className="font-mono">{meta.ip || "…"}</td></tr>
              <tr><td className="pr-3">datetime</td><td>{meta.datetime}</td></tr>
              <tr><td className="pr-3">timezone</td><td>{meta.timezone} (UTC{formatUTCOffset(meta.timezoneOffset)})</td></tr>
              <tr><td className="pr-3">language</td><td>{meta.language}{meta.languages ? ` (${meta.languages})` : ""}</td></tr>
              <tr><td className="pr-3">platform</td><td>{meta.platform || "—"}</td></tr>
              <tr><td className="pr-3">screen</td><td>{meta.screen}</td></tr>
              <tr><td className="pr-3">cpu cores</td><td>{meta.cores || "—"}</td></tr>
              {meta.memoryGB ? <tr><td className="pr-3">memory</td><td>{meta.memoryGB} GB</td></tr> : null}
              {meta.connection ? <tr><td className="pr-3">connection</td><td>{meta.connection}</td></tr> : null}
              <tr><td className="pr-3">cookies</td><td>{meta.cookies ? "enabled" : "disabled"}</td></tr>
              <tr><td className="pr-3">do not track</td><td>{meta.doNotTrack || "not set"}</td></tr>
              <tr><td className="pr-3">touch</td><td>{meta.touch ? "yes" : "no"}</td></tr>
              <tr><td className="pr-3">online</td><td>{meta.online ? "yes" : "no"}</td></tr>
            </tbody>
          </table>
          <p className="mt-1 break-all font-mono text-[11px] text-neutral-500">{meta.userAgent}</p>
        </>
      )}
    </InfoCard>
  );
}

export function StatsCard() {
  const identity = useAppIdentity();
  const [stats, setStats] = useState<UserStats | null>(null);
  const [loaded, setLoaded] = useState(false);
  if (identity?.username && !loaded) {
    setLoaded(true);
    fetchMyStats().then(setStats).catch(() => {});
  }
  return (
    <InfoCard title="📊 your numbers (server-side)">
      {!identity?.username && (
        <span className="text-neutral-600">claim a username to see your stats</span>
      )}
      {identity?.username && !loaded && <span className="text-neutral-600">loading…</span>}
      {identity?.username && loaded && !stats && (
        <span className="text-neutral-600">stats unavailable — backend may be outdated</span>
      )}
      {stats && (
        <table className="w-full text-[13px]">
          <tbody>
            <tr><td className="pr-3">casts</td><td><b>{stats.casts}</b></td></tr>
            <tr><td className="pr-3">replies</td><td><b>{stats.replies}</b></td></tr>
            <tr>
              <td className="pr-3">picked up by someone</td>
              <td>
                <b>{stats.castsDelivered}</b>
                {stats.casts + stats.replies > 0 && (
                  <span className="text-neutral-600"> ({Math.round((stats.castsDelivered / (stats.casts + stats.replies)) * 100)}%)</span>
                )}
              </td>
            </tr>
            <tr><td className="pr-3">fully delivered</td><td><b>{stats.castsExhausted}</b></td></tr>
            <tr><td className="pr-3">bottles received</td><td><b>{stats.received}</b></td></tr>
            <tr><td className="pr-3">delivery claims</td><td><b>{stats.claims}</b></td></tr>
            <tr><td className="pr-3">keys deposited</td><td><b>{stats.keysDeposited}</b></td></tr>
            <tr><td className="pr-3">users blocked</td><td><b>{stats.usersBlocked}</b></td></tr>
            <tr><td className="pr-3">reports filed</td><td><b>{stats.reportsFiled}</b></td></tr>
            <tr><td className="pr-3">times reported</td><td><b>{stats.timesReported}</b></td></tr>
            <tr>
              <td className="pr-3">member since</td>
              <td>{stats.memberSince ? new Date(stats.memberSince * 1000).toLocaleDateString() : "—"}</td>
            </tr>
            <tr>
              <td className="pr-3">last activity</td>
              <td>{stats.lastActivity ? new Date(stats.lastActivity * 1000).toLocaleString() : "—"}</td>
            </tr>
          </tbody>
        </table>
      )}
    </InfoCard>
  );
}

function useAppIdentity() {
  useSyncExternalStore(subscribe, () => getIdentityRecord());
  return getIdentityRecord();
}

export function VaultButtons() {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        className="retro-tool"
        title="export encrypted secret key (private keys only)"
        onClick={() => exportVault().catch((e) => log(`export: ${(e as Error).message}`, "err"))}
      >
        <span className="retro-tool-icon">🔐</span>
        <span>export secret key</span>
      </button>
      <button className="retro-tool" title="import secret key on a new device" onClick={() => fileRef.current?.click()}>
        <span className="retro-tool-icon">📂</span>
        <span>import secret key</span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          importVaultFile(file).catch((err) => log(`import: ${(err as Error).message || "failed"}`, "err"));
        }}
      />
    </>
  );
}
