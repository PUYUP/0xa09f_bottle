import { useEffect, useState } from "react";
import { useApp } from "./hooks/useApp";
import { AccountPanel, MyKeysPanel, PoolPanel, VaultButtons } from "./components/Panels";
import { ThreadList } from "./components/Thread";
import { BOTTLE_QUOTA, MAX_LOCAL_KEYS } from "./lib/crypto";
import {
  buildThreads,
  checkBottles,
  dropBottle,
  generateAndDeposit,
  init,
  log,
  readTTLSeconds,
} from "./lib/store";
import { getIdentity } from "./lib/identity";
import type { ThreadNode } from "./lib/store";

export default function App() {
  const state = useApp();
  const [message, setMessage] = useState("");
  const [ttl, setTtl] = useState("86400");
  const [page, setPage] = useState<"catch" | "pool" | "bait" | "account">("catch");
  const [threads, setThreads] = useState<ThreadNode[]>([]);
  const [threadLimit, setThreadLimit] = useState(10);
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

  const ttlValid = readTTLSeconds(ttl);
  const isNewUser = state.keys.length === 0 && !identity?.username;

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
        <h1 className="text-3xl font-bold" style={{ fontFamily: "Georgia, serif" }}>
          <span className="text-blue-900">🌊</span> saltleak
        </h1>
        <p className="text-xs italic text-neutral-700">
          anonymous e2ee messages lost in the void — est. 2025
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
            onClick={() => run(() => generateAndDeposit(ttl))}
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
                    await dropBottle(message, ttl);
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
                  await dropBottle(message, ttl);
                  setMessage("");
                })
              }
            >
              🎣<br />
              cast it
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-neutral-700">
            <label>bait ttl (seconds):</label>
            <input
              className="retro-input w-24"
              value={ttl}
              onChange={(e) => setTtl(e.target.value)}
            />
            <span>
              {ttlValid ? `floats for ~${Math.round(ttlValid / 3600)}h` : "invalid ttl"}
            </span>
          </div>
        </div>
      </div>

      {page === "bait" && <MyKeysPanel onClose={() => setPage("catch")} />}
      {page === "pool" && <PoolPanel onClose={() => setPage("catch")} />}
      {page === "account" && <AccountPanel onClose={() => setPage("catch")} />}

      {/* ── catch page ─────────────────────────────────────── */}
      {page === "catch" && (
      <div className="bevel mb-2">
        <div className="retro-titlebar">
          <span>📬 catch — {threads.length} message{threads.length === 1 ? "" : "s"}</span>
          <span className="text-[13px]">only you can read these</span>
        </div>
        <div className="retro-body">
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
                    <span className="retro-link" onClick={() => run(() => generateAndDeposit(ttl))}>
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
          <ThreadList roots={threads.slice(0, threadLimit)} />
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
        </div>
      </div>
      )}

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

      <p className="mt-3 text-center text-[13px] text-neutral-600">
        saltleak · best viewed at 800×600 · works in netscape navigator · no cookies were harmed
      </p>
    </main>
  );
}
