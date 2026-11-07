import { useRef, useState, useSyncExternalStore } from "react";
import { useApp } from "../hooks/useApp";
import { subscribe } from "../lib/store";
import { getIdentityRecord, randomUsername as genName } from "../lib/identity";
import {
  blockOrReportUser,
  claimUsernameUI,
  exportVault,
  formatExpiry,
  formatTTL,
  importVaultFile,
  log,
  refreshBlocks,
  refreshPoolKeys,
  unblockUser,
} from "../lib/store";
import type { KeyRecord } from "../lib/types";

function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="mt-2 rounded border border-neutral-800 bg-neutral-900/60 p-3">
      <div className="mb-2 flex items-center justify-between text-[11px] text-neutral-500">
        <span>[ {title} ]</span>
        <button className="hover:text-neutral-200" onClick={onClose}>[ close ]</button>
      </div>
      {children}
    </div>
  );
}

export function MyKeysPanel({ onClose }: { onClose: () => void }) {
  const { keys, ownPoolKids, activePoolKeys } = useApp();
  return (
    <Panel title={`my keys (${keys.length})`} onClose={onClose}>
      <div className="space-y-1">
        {keys.length === 0 && <div className="text-neutral-600">no local keys</div>}
        {keys.map((k: KeyRecord) => {
          let meta: string;
          let cls = "text-neutral-500";
          if (!k.depositedAt) {
            meta = `pending · created ${k.createdAt ? new Date(k.createdAt).toLocaleString() : "—"}`;
            cls = "text-amber-500/80";
          } else if (ownPoolKids.has(k.kid)) {
            const remaining = k.expiresAt ? (k.expiresAt - Date.now()) / 1000 : NaN;
            meta = `in pool${k.expiresAt ? ` · ${remaining > 0 ? formatTTL(remaining) : "expired"}` : ""}`;
            cls = "text-emerald-500/80";
          } else if (k.expiresAt && k.expiresAt <= Date.now()) {
            meta = `expired ${new Date(k.expiresAt).toLocaleString()}`;
            cls = "text-red-500/80";
          } else {
            meta = `used · deposited ${k.depositedAt ? new Date(k.depositedAt).toLocaleString() : "—"}`;
            cls = "text-sky-500/80";
          }
          return (
            <div key={k.kid} className="flex items-baseline gap-3 text-[11px]">
              <span className="text-neutral-400" title={k.kid}>{k.kid.slice(0, 13)}…</span>
              <span className={cls}>{meta}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-2 text-[10px] text-neutral-600">in pool: {activePoolKeys ?? "…"}</div>
    </Panel>
  );
}

export function PoolPanel({ onClose }: { onClose: () => void }) {
  const { poolKeys, poolSize } = useApp();
  const [loaded, setLoaded] = useState(false);
  if (!loaded) {
    setLoaded(true);
    refreshPoolKeys().catch((e) => log(`pool: ${(e as Error).message}`, "err"));
  }
  return (
    <Panel title={`blind pool (${poolSize ?? "…"} in pool)`} onClose={onClose}>
      <div className="max-h-64 space-y-1 overflow-y-auto">
        {poolKeys === null && <div className="text-neutral-600">loading…</div>}
        {poolKeys?.length === 0 && <div className="text-neutral-600">no keys in pool</div>}
        {poolKeys?.map((k) => (
          <div key={k.kid} className="flex items-baseline gap-3 text-[11px]">
            <span className="text-neutral-400" title={k.kid}>{k.kid.slice(0, 13)}…</span>
            <span className="text-neutral-500">{formatExpiry(k.expiresAt)}</span>
          </div>
        ))}
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
    <Panel title="account" onClose={onClose}>
      <div className="space-y-3 text-[11px]">
        <div className="text-neutral-400">
          {identity?.username ? `@${identity.username} · ${identity.userId}` : "anonymous — claim a username to enable block/report"}
        </div>
        <div className="flex gap-2">
          <input
            className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-200 outline-none focus:border-neutral-600"
            placeholder="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <button
            className="rounded border border-neutral-700 px-2 py-1 hover:border-neutral-500"
            onClick={() => setUsername(genName())}
            title="random username"
          >
            ⚄
          </button>
          <button
            className="rounded border border-neutral-700 px-2 py-1 hover:border-neutral-500"
            onClick={() => claimUsernameUI(username.trim()).catch((e) => log(`claim: ${(e as Error).message}`, "err"))}
          >
            [ claim ]
          </button>
        </div>
        {identity?.username && (
          <>
            <div className="flex gap-2">
              <input
                className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-200 outline-none focus:border-neutral-600"
                placeholder="username or user id"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
              <button
                className="rounded border border-neutral-700 px-2 py-1 hover:border-red-500/60"
                onClick={() => blockOrReportUser("block", target).catch((e) => log(`block: ${(e as Error).message}`, "err"))}
              >
                [ block ]
              </button>
              <button
                className="rounded border border-neutral-700 px-2 py-1 hover:border-amber-500/60"
                onClick={() => blockOrReportUser("report", target).catch((e) => log(`report: ${(e as Error).message}`, "err"))}
              >
                [ report ]
              </button>
            </div>
            <div>
              <div className="mb-1 text-neutral-600">blocked users</div>
              <div className="space-y-1">
                {blocks === null && <div className="text-neutral-600">loading…</div>}
                {blocks?.length === 0 && <div className="text-neutral-600">not blocking anyone</div>}
                {blocks?.map((b) => (
                  <div key={b.blockedUserId} className="flex items-baseline gap-3">
                    <span className="text-neutral-400" title={`${b.blockedUserId}${b.reason ? ` · ${b.reason}` : ""}`}>
                      @{b.username}
                    </span>
                    <button
                      className="text-[11px] text-neutral-500 hover:text-neutral-200"
                      onClick={() => unblockUser(b.blockedUserId).catch((e) => log(`unblock: ${(e as Error).message}`, "err"))}
                    >
                      [ unblock ]
                    </button>
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

function useAppIdentity() {
  useSyncExternalStore(subscribe, () => getIdentityRecord());
  return getIdentityRecord();
}

export function VaultButtons() {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        className="rounded border border-neutral-800 px-2 py-1 text-[11px] text-neutral-400 hover:border-neutral-600"
        onClick={() => exportVault().catch((e) => log(`export: ${(e as Error).message}`, "err"))}
      >
        [ export vault ]
      </button>
      <button
        className="rounded border border-neutral-800 px-2 py-1 text-[11px] text-neutral-400 hover:border-neutral-600"
        onClick={() => fileRef.current?.click()}
      >
        [ import vault ]
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
