import { useRef, useState, useSyncExternalStore } from "react";
import { subscribe } from "../lib/store";
import { getIdentityRecord, randomUsername as genName } from "../lib/identity";
import {
  blockOrReportUser,
  claimUsernameUI,
  exportVault,
  fetchMyStats,
  formatExpiry,
  formatTTL,
  getClientMeta,
  importVaultFile,
  log,
  refreshActivePoolKeys,
  refreshBlocks,
  refreshPoolKeys,
  unblockUser,
} from "../lib/store";
import type { ClientMeta, UserStats } from "../lib/store";
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
  if (!refreshed) {
    setRefreshed(true);
    refreshActivePoolKeys().catch(() => {});
  }
  return (
    <Panel title={`🪱 my bait (${keys.length})`} onClose={onClose}>
      <div className="max-h-80 overflow-y-auto">
      <table className="w-full text-[13px]">
        <tbody>
          {keys.length === 0 && (
            <tr><td className="text-neutral-600">no bait yet — hit "throw bait"</td></tr>
          )}
          {visible.map((k: KeyRecord) => {
            let meta: string;
            let cls = "";
            if (!k.depositedAt) {
              meta = `pending · created ${k.createdAt ? new Date(k.createdAt).toLocaleString() : "—"}`;
              cls = "text-amber-700";
            } else if (ownPoolKids.has(k.kid)) {
              const remaining = k.expiresAt ? (k.expiresAt - Date.now()) / 1000 : NaN;
              meta = `in pool${k.expiresAt ? ` · ${remaining > 0 ? formatTTL(remaining) : "expired"}` : ""}`;
              cls = "text-green-700";
            } else if (k.expiresAt && k.expiresAt <= Date.now()) {
              meta = `expired ${new Date(k.expiresAt).toLocaleString()}`;
              cls = "text-red-700";
            } else {
              meta = `used · deposited ${k.depositedAt ? new Date(k.depositedAt).toLocaleString() : "—"}`;
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
              <tr><td className="text-neutral-600">the void is empty — no bait in the pool</td></tr>
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
  const { blocks } = useApp();
  const [username, setUsername] = useState("");
  const [target, setTarget] = useState("");
  const identity = useAppIdentity();

  if (blocks === null) refreshBlocks().catch(() => {});

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
        {identity?.username && (
          <>
            <div className="flex gap-2">
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
                🚫 block
              </button>
              <button
                className="retro-btn"
                onClick={() => blockOrReportUser("report", target).catch((e) => log(`report: ${(e as Error).message}`, "err"))}
              >
                ⚠ report
              </button>
            </div>
            <div>
              <p className="mb-1 text-[13px] text-neutral-600">blocked users:</p>
              <div>
                {blocks === null && <span className="text-neutral-600">loading…</span>}
                {blocks?.length === 0 && <span className="text-neutral-600">not blocking anyone</span>}
                {blocks?.map((b) => (
                  <div key={b.blockedUserId} className="flex items-baseline gap-3">
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
            </div>
          </>
        )}
      </div>
    </Panel>
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
        title="export encrypted vault (private keys only)"
        onClick={() => exportVault().catch((e) => log(`export: ${(e as Error).message}`, "err"))}
      >
        <span className="retro-tool-icon">🔐</span>
        <span>export vault</span>
      </button>
      <button className="retro-tool" title="import vault on a new device" onClick={() => fileRef.current?.click()}>
        <span className="retro-tool-icon">📂</span>
        <span>import vault</span>
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
