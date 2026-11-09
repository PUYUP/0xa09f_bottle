import { useEffect, useRef, useState } from "react";
import { useApp } from "./hooks/useApp";
import { AccountPanel, DeviceCard, MyKeysPanel, PoolPanel, StatsCard, VaultButtons } from "./components/Panels";
import { ThreadList, countReplies, findNode } from "./components/Thread";
import { BaitLine } from "./components/BaitLine";
import { BOTTLE_QUOTA, MAX_LOCAL_KEYS } from "./lib/crypto";
import {
  buildThreads,
  checkBottles,
  deleteBottle,
  dropBottle,
  formatTTL,
  generateAndDeposit,
  init,
  log,
  openThread,
  readTTLSeconds,
  importVaultFile,
  exportVault,
  vaultReminderState,
  snoozeVaultReminder,
} from "./lib/store";
import { getIdentity, randomUsername as genName } from "./lib/identity";
import { claimUsernameUI } from "./lib/store";
import { billingStatus, checkout, extendTrial, type Entitlement } from "./lib/billing";
import { TermsContent, PrivacyContent, HowItWorksContent } from "./legal";
import type { ThreadNode } from "./lib/store";

type DocKind = "terms" | "privacy" | "how";

const DOC_TITLES: Record<DocKind, string> = {
  terms: "terms of service",
  privacy: "privacy policy",
  how: "how it works",
};

function DocModal({ kind, onClose }: { kind: DocKind; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div className="bevel max-h-[80vh] w-[34rem] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <div className="retro-titlebar">
          <span>{DOC_TITLES[kind]}</span>
          <button className="retro-btn" style={{ padding: "0 6px" }} onClick={onClose}>✕</button>
        </div>
        <div className="retro-body max-h-[60vh] overflow-y-auto text-[14px] leading-relaxed">
          {kind === "terms" ? <TermsContent /> : kind === "privacy" ? <PrivacyContent /> : <HowItWorksContent />}
        </div>
      </div>
    </div>
  );
}

// UsernameGate blocks the whole app until a username is claimed. A random
// default is prefilled; the dice button regenerates it.
function UsernameGate({ onClaimed }: { onClaimed: () => void }) {
  const [name, setName] = useState(() => genName());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const [showHow, setShowHow] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const claim = () => {
    const v = name.trim();
    if (!v || busy) return;
    setBusy(true);
    setErr("");
    claimUsernameUI(v)
      .then(onClaimed)
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false));
  };
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center p-4">
      <div className="bevel w-full">
        <div className="retro-titlebar">
          <span>👤 choose your name</span>
          <span className="text-[13px]">required</span>
        </div>
        <div className="retro-body space-y-3">
          <p className="text-[14px] text-neutral-700">
            a09f needs a username to identify you — for blocking, reporting
            and your public profile. It is bound to this device's identity key
            forever; pick carefully.
          </p>
          <div className="flex gap-2">
            <input
              className="retro-input flex-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && claim()}
              autoFocus
            />
            <button
              className="retro-btn flex items-center justify-center px-3"
              title="random username"
              onClick={() => setName(genName())}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
            </button>
          </div>
          {err && <div className="text-[13px] text-red-700">{err}</div>}
          {notice && <div className="text-[13px] text-neutral-700">{notice}</div>}
          <button className="retro-btn w-full" disabled={busy || !name.trim()} onClick={claim}>
            {busy ? "claiming…" : "claim & enter"}
          </button>
          <div className="border-t border-neutral-300 pt-2 text-[13px] text-neutral-600">
            <p className="mb-1">
              coming back on a new device? your vault export holds the private
              keys that prove this identity — import it to restore your
              username, bait and message history.
            </p>
            <button
              className="retro-link"
              onClick={() => fileRef.current?.click()}
            >
              📂 import vault / secret file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setErr("");
                setNotice("");
                try {
                  await importVaultFile(file);
                  const id = await getIdentity();
                  if (id.username) {
                    onClaimed();
                  } else {
                    setNotice(
                      "vault imported — your keys are restored. pick a name below to finish setup."
                    );
                  }
                } catch (ex) {
                  setErr(`import failed: ${(ex as Error).message}`);
                }
              }}
            />
          </div>
          <div className="border-t border-neutral-300 pt-2 text-center">
            <span className="retro-link" onClick={() => setShowHow(true)}>
              ❓ how does this work?
            </span>
          </div>
        </div>
      </div>
      {showHow && <DocModal kind="how" onClose={() => setShowHow(false)} />}
    </main>
  );
}

// Paywall blocks the app once the free trial (plus its one extension) has
// lapsed without payment. Checkout happens on Polar.sh — we only ever see
// the anonymous userId, never billing PII.
function Paywall({ ent, onChanged }: { ent: Entitlement; onChanged: (ent: Entitlement) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const act = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    fn()
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false));
  };
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center p-4">
      <div className="bevel w-full">
        <div className="retro-titlebar">
          <span>🌊 the tide has gone out</span>
          <span className="text-[13px]">trial ended</span>
        </div>
        <div className="retro-body space-y-3">
          <p className="text-[14px] text-neutral-700">
            your free trial is over. subscribe to keep this identity — and
            every message in it — alive. a new private key always works, but
            starts with an empty sea.
          </p>
          {ent.canExtend && (
            <button
              className="retro-btn w-full"
              disabled={busy}
              onClick={() => act(async () => onChanged(await extendTrial()))}
            >
              {busy ? "extending…" : `extend trial — ${ent.extensionsLeft} left`}
            </button>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button
              className="retro-btn"
              disabled={busy}
              onClick={() => act(async () => { window.location.href = await checkout("monthly"); })}
            >
              $2 / month
            </button>
            <button
              className="retro-btn"
              disabled={busy}
              onClick={() => act(async () => { window.location.href = await checkout("yearly"); })}
            >
              $10 / year
            </button>
          </div>
          {err && <div className="text-[13px] text-red-700">{err}</div>}
          <p className="text-[12px] text-neutral-500">
            payments are processed by Polar.sh — we only receive your anonymous
            identity id, never your card or email.
          </p>
        </div>
      </div>
    </main>
  );
}

export default function App() {
  const state = useApp();
  const [message, setMessage] = useState("");
  const [baitTtl, setBaitTtl] = useState("86400");
  const [baitDialog, setBaitDialog] = useState(false);
  const [legal, setLegal] = useState<DocKind | null>(null);
  const [page, setPage] = useState<"catch" | "pool" | "bait" | "account">("catch");
  const [threads, setThreads] = useState<ThreadNode[]>([]);
  const [threadLimit, setThreadLimit] = useState(10);
  const [detailPath, setDetailPath] = useState<string[]>([]);
  const [catchToast, setCatchToast] = useState(false);
  const [vaultDue, setVaultDue] = useState(false);
  const [billing, setBilling] = useState<Entitlement | null>(null);
  const [identity, setIdentity] = useState<Awaited<ReturnType<typeof getIdentity>> | null>(null);
  const [busy, setBusy] = useState(false);
  const autoBaited = useRef(false);

  useEffect(() => {
    init().catch((e) => log(`boot: ${(e as Error).message}`, "err"));
    getIdentity().then(setIdentity).catch(() => {});
    vaultReminderState()
      .then((r) => setVaultDue(r.due))
      .catch(() => {});
  }, []);

  // Billing entitlement: fetched once the username (and therefore the
  // server-side user row + trial clock) exists. A ?checkout=success return
  // from Polar polls until the webhook lands.
  const refreshBilling = () =>
    billingStatus()
      .then(setBilling)
      .catch(() => {});
  useEffect(() => {
    if (!identity?.username) return;
    refreshBilling();
    if (new URLSearchParams(window.location.search).get("checkout") === "success") {
      const iv = setInterval(refreshBilling, 3000);
      const stop = setTimeout(() => {
        clearInterval(iv);
        window.history.replaceState(null, "", window.location.pathname);
      }, 90000);
      return () => {
        clearInterval(iv);
        clearTimeout(stop);
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.username]);

  // New-catch toast: an SSE bottle event means something landed on our
  // bait — flash a banner for a few seconds.
  useEffect(() => {
    if (!state.lastCatchAt) return;
    setCatchToast(true);
    const t = setTimeout(() => setCatchToast(false), 6000);
    return () => clearTimeout(t);
  }, [state.lastCatchAt]);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      buildThreads()
        .then((t) => alive && setThreads(t.roots))
        .catch(() => {});
    };
    refresh();
    const iv = setInterval(refresh, 4000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [state.records, state.ready]);

  const ttlValid = readTTLSeconds(baitTtl);
  const isNewUser = state.keys.length === 0 && !identity?.username;

  // Onboarding: a brand-new user (just claimed a username, zero keys) gets
  // three starter baits cast automatically so catches are possible without
  // figuring out the throw-bait flow first.
  useEffect(() => {
    if (autoBaited.current || !state.ready || state.keys.length > 0 || !identity?.username) return;
    autoBaited.current = true;
    (async () => {
      for (let i = 0; i < 3; i++) {
        await generateAndDeposit("86400").catch(() => {});
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.ready, state.keys.length, identity?.username]);

  // Mandatory username: once the identity record exists, the app stays
  // locked behind the claim screen until a username is set.
  if (identity && !identity.username) {
    return (
      <UsernameGate
        onClaimed={() => getIdentity().then(setIdentity).catch(() => {})}
      />
    );
  }

  // Paywall: lapsed trial + no payment → only billing routes remain usable.
  if (billing && !billing.entitled) {
    return <Paywall ent={billing} onChanged={setBilling} />;
  }

  const openBaitDialog = () => setBaitDialog(true);
  const confirmBait = () => {
    if (!ttlValid) {
      log("invalid ttl — pick a number of seconds", "warn");
      return;
    }
    setBaitDialog(false);
    run(() => generateAndDeposit(baitTtl));
  };

  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    fn()
      .catch((e) => log(`${(e as Error).message}`, "err"))
      .finally(() => setBusy(false));
  };

  return (
    <main className="mx-auto max-w-3xl p-2">
      {/* ── site header ────────────────────────────────────── */}
      <div className="mb-2 text-center">
        <h1
          className="text-3xl font-bold"
          style={{ textShadow: "1px 1px 0 #ffffff, -1px -1px 0 #909090" }}
        >
          <span className="text-blue-900">🌊</span> a09f
        </h1>
        <p className="text-xs italic text-neutral-700">
          A quiet cove for a crowded mind — est. 2025
        </p>
        <hr className="retro-hr" />
      </div>

      {/* ── status bar ─────────────────────────────────────── */}
      <div className="bevel mb-2 flex flex-wrap items-center justify-between gap-2 px-2 py-1 text-[13px]">
        <span>
          you are:{" "}
          <b>{identity?.username ? `@${identity.username}` : "anonymous drifter"}</b>
          {!state.ready && <span className="text-neutral-600"> · booting…</span>}
        </span>
        <span className="text-neutral-700">
          🎣 bait in pool: <b>{state.activePoolKeys ?? "…"}</b>/{MAX_LOCAL_KEYS} · casts:{" "}
          <b>{BOTTLE_QUOTA}</b>/day · e2ee:{" "}
          <b className="text-green-700">on</b>
        </span>
      </div>

      {/* ── toolbar (yahoo messenger style) ────────────────── */}
      <div className="bevel mb-2">
        <div className="retro-titlebar">
          <span>⚙ menu</span>
          <span className="text-[13px]">a09f.com</span>
        </div>
        <div className="retro-body flex flex-wrap gap-2 p-3">
          <button
            className="retro-tool"
            disabled={busy}
            onClick={openBaitDialog}
            title="generate a keypair and publish the public half to the bait pool"
          >
            <span className="retro-tool-icon">🎣</span>
            <span>throw bait</span>
          </button>
          <button
            className="retro-tool"
            disabled={busy}
            onClick={() => {
              setPage("catch");
              run(checkBottles);
            }}
            title="scan the sea for catches addressed to your bait"
          >
            <span className="retro-tool-icon">🪝</span>
            <span>check catch</span>
          </button>
          <button
            className={`retro-tool${page === "pool" ? " active" : ""}`}
            onClick={() => setPage("pool")}
          >
            <span className="retro-tool-icon">🌊</span>
            <span>bait pool</span>
          </button>
          <button
            className={`retro-tool${page === "bait" ? " active" : ""}`}
            onClick={() => setPage("bait")}
          >
            <span className="retro-tool-icon">🪱</span>
            <span>my bait</span>
          </button>
          <button
            className={`retro-tool${page === "account" ? " active" : ""}`}
            onClick={() => setPage("account")}
          >
            <span className="retro-tool-icon">👤</span>
            <span>account</span>
          </button>
          <VaultButtons />
        </div>
      </div>

      {billing?.status === "trialing" && billing.daysLeft <= 7 && billing.entitled && (
        <div className="bevel mb-2">
          <div className="retro-titlebar">
            <span>⏳ free trial</span>
            <span className="text-[13px]">{billing.daysLeft}d left</span>
          </div>
          <div className="retro-body flex items-center justify-between gap-3 text-[13px]">
            <span>
              your identity key stops working when the trial ends — subscribe
              ($2/mo · $10/yr) or extend once to keep it alive.
            </span>
            <button
              className="retro-btn shrink-0"
              onClick={() =>
                checkout("monthly")
                  .then((u) => { window.location.href = u; })
                  .catch((e) => log(`checkout: ${(e as Error).message}`, "err"))
              }
            >
              subscribe
            </button>
          </div>
        </div>
      )}

      {vaultDue && (
        <div className="bevel mb-2">
          <div className="retro-titlebar">
            <span>🔑 vault backup</span>
            <button
              className="retro-btn"
              style={{ padding: "0 6px" }}
              onClick={async () => {
                await snoozeVaultReminder();
                setVaultDue(false);
              }}
            >
              later
            </button>
          </div>
          <div className="retro-body flex items-center justify-between gap-3 text-[13px]">
            <span>
              no vault export yet — lose this device and every message is gone
              forever. export your keys to a file you keep safe.
            </span>
            <button
              className="retro-btn shrink-0"
              onClick={() =>
                exportVault()
                  .then(() => vaultReminderState().then((r) => setVaultDue(r.due)))
                  .catch((e) => log(`export: ${(e as Error).message}`, "err"))
              }
            >
              export vault
            </button>
          </div>
        </div>
      )}

      {catchToast && (
        <div
          className="bevel fixed bottom-4 left-1/2 z-50 w-[24rem] max-w-[90vw] cursor-pointer"
          onClick={() => {
            setCatchToast(false);
            run(checkBottles);
          }}
        >
          <div className="retro-titlebar">
            <span>🎣 something bit!</span>
            <span className="text-[12px]">tap to check catch</span>
          </div>
        </div>
      )}

      {/* ── composer ───────────────────────────────────────── */}
      <div className="bevel mb-2">
        <div className="retro-titlebar">
          <span>🎣 cast into the sea</span>
          <span className="text-[13px]">sealed with AES-256-GCM</span>
        </div>
        <div className="retro-body">
          <div className="flex gap-2">
            <input
              className="retro-input retro-msg w-full"
              placeholder="write something for the sea…"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  run(async () => {
                    await dropBottle(message, "86400");
                    setMessage("");
                  });
                }
              }}
            />
            <button
              className="retro-btn retro-cast"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await dropBottle(message, "86400");
                  setMessage("");
                })
              }
            >
              🎣<br />
              cast it
            </button>
          </div>
        </div>
      </div>

      {page === "bait" && <MyKeysPanel onClose={() => setPage("catch")} />}
      {page === "pool" && <PoolPanel onClose={() => setPage("catch")} />}
      {page === "account" && (
        <>
          <AccountPanel onClose={() => setPage("catch")} />
          <DeviceCard />
          <StatsCard />
        </>
      )}

      {/* ── catch page ─────────────────────────────────────── */}
      {page === "catch" && (() => {
        const detailNode = detailPath.length ? findNode(threads, detailPath[detailPath.length - 1]) : null;
        return (
      <div className="bevel mb-2">
        <div className="retro-titlebar">
          <span>
            {detailNode
              ? `📬 message ${(detailNode.rec.bottle?.id || "").slice(0, 8)} — depth ${(detailNode.rec.bottle?.depth || 1)}`
              : `📬 catch — ${threads.length} message${threads.length === 1 ? "" : "s"}`}
          </span>
          <span className="flex items-center gap-2 text-[13px]">
            {detailNode && (
              <span className="retro-link" onClick={() => setDetailPath([])}>← back to catch</span>
            )}
            {!detailNode && "only you can read these"}
            <button
              className="retro-btn"
              style={{ padding: "0 8px" }}
              title="check for new catches"
              onClick={() => run(checkBottles)}
            >
              🔄 refresh
            </button>
          </span>
        </div>
        <div className="retro-body">
          {!detailNode && (
            <BaitLine
              onOpen={(bottleId) => {
                openThread(bottleId).catch(() => {});
                setDetailPath([bottleId]);
              }}
            />
          )}
          {detailNode && (
            <div className="mb-2 text-[13px] text-neutral-600">
              <span className="retro-link" onClick={() => setDetailPath([])}>📬 catch</span>
              {detailPath.map((id, i) => (
                <span key={id}>
                  {" / "}
                  <span
                    className={i === detailPath.length - 1 ? "font-bold text-neutral-800" : "retro-link"}
                    onClick={() => i < detailPath.length - 1 && setDetailPath(detailPath.slice(0, i + 1))}
                  >
                    #{id.slice(0, 8)}
                  </span>
                </span>
              ))}
            </div>
          )}
          {detailNode ? (
            <ThreadList
              roots={[detailNode]}
              onOpen={(n) => {
                const id = n.rec.bottle?.id;
                if (id && id !== detailPath[detailPath.length - 1]) {
                  openThread(id).catch(() => {});
                  setDetailPath((p) => [...p, id]);
                }
              }}
            />
          ) : (
            <>
          {threads.length === 0 &&
            (isNewUser ? (
              <div className="msg bevel-in">
                <p className="mb-2">
                  <b>👋 welcome drifter!</b> This corner of the internet seals every catch with
                  end-to-end encryption — nobody, not even the server, can read what you write.
                  Only the sender and the intended recipient ever see the plaintext.
                </p>
                <p className="mb-2">
                  We've already cast <b>3 starter bait</b> for you — they're in the water
                  now. To start catching:
                </p>
                <ol className="mb-3 list-decimal pl-6">
                  <li>
                    <span className="retro-link" onClick={openBaitDialog}>
                      🎣 throw more bait
                    </span>{" "}
                    — generate extra keys to widen your catch surface
                  </li>
                  <li>
                    <span className="retro-link" onClick={() => run(checkBottles)}>
                      🪝 check catch
                    </span>{" "}
                    — scan the sea for catches addressed to your bait
                  </li>
                  <li>
                    <span className="retro-link" onClick={() => setPage("account")}>
                      👤 claim a username
                    </span>{" "}
                    — needed for blocking &amp; reporting
                  </li>
                </ol>
                <p className="text-neutral-600">
                  …or just cast below and see what bites back.
                </p>
              </div>
            ) : (
              <div className="msg bevel-in text-center text-neutral-700">
                🎣 the sea is quiet — nothing on the line yet.
              </div>
            ))}
          {threads.slice(0, threadLimit).map((r) => {
            const replies = countReplies(r);
            const isSent = r.rec.claim?.status === "SENT";
            const bottleId = r.rec.bottle?.id || "";
            // Badge: thread-level reply activity (any depth, via rootId)
            // newer than what we've opened, on bottles we authored.
            const authored = state.records.some(
              (m) => m.id === `sent:${bottleId}`
            );
            const lastActivity = r.rec.threadLastAt || r.rec.lastChildAt || 0;
            const hasNewReplies =
              authored &&
              lastActivity > 0 &&
              lastActivity * 1000 > (r.rec.repliesSeenAt || 0);
            return (
              <div
                key={r.rec.id}
                className={`msg bevel-in clickable${isSent ? " sent" : ""}`}
                onClick={() => {
                  if (!bottleId) return;
                  openThread(bottleId).catch(() => {});
                  setDetailPath([bottleId]);
                }}
              >
                <div className="mb-1 text-[13px] text-neutral-600">
                  <b>🎣 {bottleId.slice(0, 8)}</b>
                  {" · "}
                  {r.rec.claim?.status || "CLAIMED"} · {r.rec.claim?.deliveries ?? "?"}/{r.rec.bottle?.maxDeliveries}
                  {isSent && " · (yours)"}
                  {replies > 0 && <span className="text-blue-800"> · 💬 {replies} repl{replies === 1 ? "y" : "ies"}</span>}
                  {hasNewReplies && (
                    <span className="ml-1 rounded-sm bg-red-600 px-1 font-bold text-white">
                      ● new
                    </span>
                  )}
                  {isSent && bottleId && (
                    <span
                      className="retro-link ml-2 text-red-800"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteBottle(bottleId).catch(() => {});
                      }}
                    >
                      [🗑]
                    </span>
                  )}
                </div>
                {r.rec.deleted ? (
                  <p className="text-[15px] italic text-neutral-500">[this message was deleted]</p>
                ) : (
                  <p className="whitespace-pre-wrap text-[16px] leading-relaxed">{r.rec.plain?.text}</p>
                )}
              </div>
            );
          })}
          {threads.length > threadLimit && (
            <div className="mt-2 text-center">
              <button
                className="retro-btn"
                onClick={() => setThreadLimit((n) => n + 10)}
              >
                load more messages ({threads.length - threadLimit} left)
              </button>
            </div>
          )}
            </>
          )}
        </div>
      </div>
        );
      })()}

      {/* ── log ────────────────────────────────────────────── */}
      <div className="bevel">
        <div className="retro-titlebar">
          <span>📟 system log</span>
          <span className="text-[13px]">debug console</span>
        </div>
        <div className="retro-body max-h-40 overflow-y-auto font-mono text-[13px] leading-tight">
          {state.logs.map((l) => (
            <div
              key={l.id}
              className={
                l.cls === "err"
                  ? "text-red-700"
                  : l.cls === "warn"
                    ? "text-amber-700"
                    : "text-neutral-600"
              }
            >
              [{l.time}] {l.msg}
            </div>
          ))}
        </div>
      </div>

      {/* ── throw bait dialog ──────────────────────────────── */}
      {baitDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setBaitDialog(false)}
        >
          <div className="bevel w-80" onClick={(e) => e.stopPropagation()}>
            <div className="retro-titlebar">
              <span>🎣 throw bait</span>
              <button className="retro-btn" style={{ padding: "0 6px" }} onClick={() => setBaitDialog(false)}>✕</button>
            </div>
            <div className="retro-body space-y-2 text-[14px]">
              <p className="text-neutral-700">
                publish a fresh keypair into the bait pool so strangers can cast sealed catches to it.
              </p>
              <label className="block text-[13px] text-neutral-600">
                bait ttl (seconds) — how long the key stays catchable:
              </label>
              <div className="flex items-center gap-1">
                <button
                  className="retro-btn"
                  style={{ padding: "2px 8px" }}
                  onClick={() => setBaitTtl((v) => String(Math.max(60, (Number(v) || 0) - 3600)))}
                  title="-1 hour"
                >
                  −
                </button>
                <input
                  className="retro-input w-full text-center"
                  value={baitTtl}
                  onChange={(e) => setBaitTtl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && confirmBait()}
                  autoFocus
                />
                <button
                  className="retro-btn"
                  style={{ padding: "2px 8px" }}
                  onClick={() => setBaitTtl((v) => String((Number(v) || 0) + 3600))}
                  title="+1 hour"
                >
                  +
                </button>
              </div>
              <p className="text-[13px] text-neutral-600">
                {ttlValid ? formatTTL(ttlValid) : "invalid — enter seconds (60–2592000)"}
              </p>
              <div className="flex justify-end gap-2">
                <button className="retro-btn" onClick={() => setBaitDialog(false)}>cancel</button>
                <button className="retro-btn" onClick={confirmBait} disabled={!ttlValid}>
                  throw it
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── terms & privacy ────────────────────────────────── */}
      {legal && <DocModal kind={legal} onClose={() => setLegal(null)} />}

      <p className="mt-3 text-center text-[13px] text-neutral-600">
        a09f · best viewed at 800×600 · works in netscape navigator · no cookies were harmed
        {" · "}
        <span className="retro-link" onClick={() => setLegal("how")}>how it works</span>
        {" · "}
        <span className="retro-link" onClick={() => setLegal("terms")}>terms</span>
        {" · "}
        <span className="retro-link" onClick={() => setLegal("privacy")}>privacy</span>
      </p>
      <p className="mt-1 text-center text-[12px] text-neutral-500">
        your IP is visible to the relay — use{" "}
        <a
          className="retro-link"
          href="https://www.torproject.org/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Tor Browser
        </a>{" "}
        for untracked browsing
      </p>
    </main>
  );
}
