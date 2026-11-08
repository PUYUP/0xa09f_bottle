import { useEffect, useState } from "react";
import { useApp } from "./hooks/useApp";
import { AccountPanel, DeviceCard, MyKeysPanel, PoolPanel, StatsCard, VaultButtons } from "./components/Panels";
import { ThreadList, countReplies, findNode } from "./components/Thread";
import { BOTTLE_QUOTA, MAX_LOCAL_KEYS } from "./lib/crypto";
import {
  buildThreads,
  checkBottles,
  dropBottle,
  formatTTL,
  generateAndDeposit,
  init,
  log,
  readTTLSeconds,
} from "./lib/store";
import { getIdentity } from "./lib/identity";
import { TermsContent, PrivacyContent } from "./legal";
import type { ThreadNode } from "./lib/store";

export default function App() {
  const state = useApp();
  const [message, setMessage] = useState("");
  const [baitTtl, setBaitTtl] = useState("86400");
  const [baitDialog, setBaitDialog] = useState(false);
  const [legal, setLegal] = useState<"terms" | "privacy" | null>(null);
  const [page, setPage] = useState<"catch" | "pool" | "bait" | "account">("catch");
  const [threads, setThreads] = useState<ThreadNode[]>([]);
  const [threadLimit, setThreadLimit] = useState(10);
  const [detailPath, setDetailPath] = useState<string[]>([]);
  const [identity, setIdentity] = useState<Awaited<ReturnType<typeof getIdentity>> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    init().catch((e) => log(`boot: ${(e as Error).message}`, "err"));
    getIdentity().then(setIdentity).catch(() => {});
  }, []);

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
        <h1 className="text-3xl font-bold">
          <span className="text-blue-900">🌊</span> saltleak
        </h1>
        <p className="text-xs italic text-neutral-700">
          A quiet room for a crowded mind — est. 2025
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
          <span className="text-[13px]">saltleak.com</span>
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
            title="scan the void for catches addressed to your bait"
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

      {/* ── composer ───────────────────────────────────────── */}
      <div className="bevel mb-2">
        <div className="retro-titlebar">
          <span>🎣 cast into the void</span>
          <span className="text-[13px]">sealed with AES-256-GCM</span>
        </div>
        <div className="retro-body">
          <div className="flex gap-2">
            <input
              className="retro-input retro-msg w-full"
              placeholder="write something for the void…"
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
          <span className="text-[13px]">
            {detailNode ? (
              <span className="retro-link" onClick={() => setDetailPath([])}>← back to catch</span>
            ) : (
              "only you can read these"
            )}
          </span>
        </div>
        <div className="retro-body">
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
                if (id && id !== detailPath[detailPath.length - 1])
                  setDetailPath((p) => [...p, id]);
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
                <p className="mb-2">To start catching, throw some bait:</p>
                <ol className="mb-3 list-decimal pl-6">
                  <li>
                    <span className="retro-link" onClick={openBaitDialog}>
                      🎣 throw bait
                    </span>{" "}
                    — generate a keypair and publish the public half into the bait pool
                  </li>
                  <li>
                    <span className="retro-link" onClick={() => setPage("account")}>
                      👤 claim a username
                    </span>{" "}
                    — needed for blocking &amp; reporting
                  </li>
                  <li>
                    <span className="retro-link" onClick={() => run(checkBottles)}>
                      🪝 check catch
                    </span>{" "}
                    — scan the void for catches addressed to your bait
                  </li>
                </ol>
                <p className="text-neutral-600">
                  …or just cast below and see what bites back.
                </p>
              </div>
            ) : (
              <div className="msg bevel-in text-center text-neutral-700">
                🎣 the void is quiet — nothing on the line yet.
              </div>
            ))}
          {threads.slice(0, threadLimit).map((r) => {
            const replies = countReplies(r);
            const isSent = r.rec.claim?.status === "SENT";
            return (
              <div
                key={r.rec.id}
                className={`msg bevel-in clickable${isSent ? " sent" : ""}`}
                onClick={() => r.rec.bottle?.id && setDetailPath([r.rec.bottle.id])}
              >
                <div className="mb-1 text-[13px] text-neutral-600">
                  <b>🎣 {(r.rec.bottle?.id || "").slice(0, 8)}</b>
                  {" · "}
                  {r.rec.claim?.status || "CLAIMED"} · {r.rec.claim?.deliveries ?? "?"}/{r.rec.bottle?.maxDeliveries}
                  {isSent && " · (yours)"}
                  {replies > 0 && <span className="text-blue-800"> · 💬 {replies} repl{replies === 1 ? "y" : "ies"}</span>}
                </div>
                <p className="whitespace-pre-wrap text-[16px] leading-relaxed">{r.rec.plain?.text}</p>
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
      {legal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setLegal(null)}
        >
          <div className="bevel max-h-[80vh] w-[34rem] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
            <div className="retro-titlebar">
              <span>{legal === "terms" ? "terms of service" : "privacy policy"}</span>
              <button className="retro-btn" style={{ padding: "0 6px" }} onClick={() => setLegal(null)}>✕</button>
            </div>
            <div className="retro-body max-h-[60vh] overflow-y-auto text-[14px] leading-relaxed">
              {legal === "terms" ? <TermsContent /> : <PrivacyContent />}
            </div>
          </div>
        </div>
      )}

      <p className="mt-3 text-center text-[13px] text-neutral-600">
        saltleak · best viewed at 800×600 · works in netscape navigator · no cookies were harmed
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
