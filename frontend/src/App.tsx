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
  const [showMyKeys, setShowMyKeys] = useState(false);
  const [showPool, setShowPool] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [threads, setThreads] = useState<ThreadNode[]>([]);
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
  const capLabel = Number.isFinite(MAX_LOCAL_KEYS) ? String(MAX_LOCAL_KEYS) : "∞";

  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    fn()
      .catch((e) => log(`${(e as Error).message}`, "err"))
      .finally(() => setBusy(false));
  };

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <header className="mb-4">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-xl font-bold text-neutral-100">saltleak</h1>
            <p className="text-[11px] text-neutral-500">anonymous e2ee bottle network for engineers</p>
          </div>
          <div className="text-right text-[11px] text-neutral-500">
            <div>
              keys {state.keys.length} ·{" "}
              <button
                className="text-sky-500/80 hover:text-sky-300"
                onClick={() => setShowMyKeys((v) => !v)}
                title="click to view your keys"
              >
                in pool {state.activePoolKeys ?? "…"}
              </button>{" "}
              · pool cap {capLabel} · quota {BOTTLE_QUOTA} · e2ee ·{" "}
              {identity?.username ? `@${identity.username}` : "anon"}
            </div>
            {!state.ready && <div className="text-neutral-600">booting…</div>}
          </div>
        </div>
      </header>

      <section className="mb-4 rounded border border-neutral-800 bg-neutral-900/50 p-3">
        <div className="flex gap-2">
          <input
            className="w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-neutral-600"
            placeholder="write a message to the sea…"
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
            className="rounded border border-emerald-800 px-4 py-2 text-emerald-300 hover:bg-emerald-950 disabled:opacity-40"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await dropBottle(message, ttl);
                setMessage("");
              })
            }
          >
            [ drop ]
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
          <label className="text-neutral-500">key ttl (s):</label>
          <input
            className="w-24 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-200 outline-none focus:border-neutral-600"
            value={ttl}
            onChange={(e) => setTtl(e.target.value)}
          />
          <span className="text-neutral-500">
            {ttlValid ? `expires in ${Math.round(ttlValid / 3600)}h` : "expires in —"}
          </span>
          <span className="mx-1 text-neutral-700">|</span>
          <button
            className="rounded border border-neutral-800 px-2 py-1 text-neutral-400 hover:border-neutral-600"
            onClick={() => run(() => generateAndDeposit(ttl))}
          >
            [ + key ]
          </button>
          <button
            className="rounded border border-neutral-800 px-2 py-1 text-neutral-400 hover:border-neutral-600"
            onClick={() => run(checkBottles)}
          >
            [ check bottles ]
          </button>
          <button
            className="rounded border border-neutral-800 px-2 py-1 text-neutral-400 hover:border-neutral-600"
            onClick={() => setShowPool((v) => !v)}
          >
            [ pool keys ]
          </button>
          <button
            className="rounded border border-neutral-800 px-2 py-1 text-neutral-400 hover:border-neutral-600"
            onClick={() => setShowAccount((v) => !v)}
          >
            [ account ]
          </button>
          <VaultButtons />
        </div>
      </section>

      {showMyKeys && <MyKeysPanel onClose={() => setShowMyKeys(false)} />}
      {showPool && <PoolPanel onClose={() => setShowPool(false)} />}
      {showAccount && <AccountPanel onClose={() => setShowAccount(false)} />}

      <section className="space-y-3">
        {threads.length === 0 &&
          (state.keys.length === 0 && !identity?.username ? (
            <div className="rounded border border-neutral-800 bg-neutral-900/50 p-4">
              <div className="mb-2 text-sm font-semibold text-neutral-200">welcome to the sea</div>
              <p className="mb-3 text-[12px] leading-relaxed text-neutral-500">
                Messages here are sealed with E2EE — only the sender and the intended recipient can
                ever read them. To start receiving, throw some bait: deposit your public keys into
                the blind pool. Anyone can then seal a message to your keys.
              </p>
              <ol className="mb-3 list-decimal space-y-1 pl-5 text-[12px] text-neutral-400">
                <li>
                  <span className="text-neutral-300">[ + key ]</span> — generate a keypair and
                  deposit the public half into the pool (max {MAX_LOCAL_KEYS})
                </li>
                <li>
                  <span className="text-neutral-300">[ account ]</span> — claim a username to enable
                  blocking &amp; reporting
                </li>
                <li>
                  <span className="text-neutral-300">[ drop ]</span> a message, or wait for the
                  current sea to wash one your way — then{" "}
                  <span className="text-neutral-300">[ check bottles ]</span>
                </li>
              </ol>
              <div className="flex gap-2">
                <button
                  className="rounded border border-emerald-800 px-3 py-1.5 text-[12px] text-emerald-300 hover:bg-emerald-950"
                  onClick={() => run(() => generateAndDeposit(ttl))}
                >
                  [ throw bait ]
                </button>
                <button
                  className="rounded border border-neutral-800 px-3 py-1.5 text-[12px] text-neutral-300 hover:border-neutral-600"
                  onClick={() => setShowAccount(true)}
                >
                  [ claim username ]
                </button>
                <button
                  className="rounded border border-neutral-800 px-3 py-1.5 text-[12px] text-neutral-400 hover:border-neutral-600"
                  onClick={() => run(checkBottles)}
                >
                  [ check bottles ]
                </button>
              </div>
            </div>
          ) : (
            <div className="text-neutral-600">no messages yet</div>
          ))}
        <ThreadList roots={threads} />
      </section>

      <section className="mt-6">
        <div className="mb-1 text-[11px] text-neutral-600">[ log ]</div>
        <div className="max-h-48 space-y-0.5 overflow-y-auto rounded border border-neutral-800 bg-neutral-900/40 p-2 text-[11px]">
          {state.logs.map((l) => (
            <div key={l.id} className={l.cls === "err" ? "text-red-400" : l.cls === "warn" ? "text-amber-400" : "text-neutral-500"}>
              [{l.time}] {l.msg}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
