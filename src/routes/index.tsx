import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  computeAmounts,
  chunk,
  estimateResources,
  formatQuantity,
  formatUnits,
  resourceWarnings,
  totalUnits,
  type AirdropRecipient,
  type DistributionMode,
} from "@/lib/airdrop";
import type { Holder, HolderSnapshot } from "@/lib/chain.server";
import {
  fetchAccountResources,
  fetchNftHolders,
  fetchRamPrice,
  fetchTokenHolders,
  fetchTokenStat,
  fetchWalletTokens,
} from "@/lib/chain.functions";
import type { Session } from "@wharfkit/session";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "WAX Airdrop Tool — Airdrop tokens to token & NFT holders" },
      {
        name: "description",
        content:
          "Snapshot WAX token or AtomicAssets NFT holders, configure equal or pro-rata distribution, and airdrop tokens in batched wallet-signed transactions with CPU/NET/RAM cost checks.",
      },
      { property: "og:title", content: "WAX Airdrop Tool" },
      {
        property: "og:description",
        content:
          "Snapshot WAX token or NFT holders and airdrop tokens in batched, wallet-signed transactions.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AirdropPage,
});

type WalletModule = typeof import("@/lib/wallet");

interface SessionInfo {
  actor: string;
  permission: string;
  session: Session;
}

const ACCOUNT_RE = /^[a-z1-5.]{1,12}$/;

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const detail = msg.match(/"message":"([^"]+)"/)?.[1];
  return (detail ?? msg).slice(0, 300);
}

function AirdropPage() {
  const walletRef = useRef<WalletModule | null>(null);
  const [walletReady, setWalletReady] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);

  // Send-token state
  const [sendContract, setSendContract] = useState("eosio.token");
  const [sendSymbol, setSendSymbol] = useState("WAX");
  const [precision, setPrecision] = useState(8);
  const [tokenStat, setTokenStat] = useState<{ precision: number; supply: string } | null>(null);
  const [walletTokens, setWalletTokens] = useState<
    Array<{ contract: string; symbol: string; amount: number; precision: number }>
  >([]);

  // Snapshot state
  const [snapshotMode, setSnapshotMode] = useState<"token" | "nft">("token");
  const [snapContract, setSnapContract] = useState("");
  const [snapSymbol, setSnapSymbol] = useState("");
  const [snapCollection, setSnapCollection] = useState("");
  const [snapSchema, setSnapSchema] = useState("");
  const [snapTemplate, setSnapTemplate] = useState("");
  const [snapshot, setSnapshot] = useState<HolderSnapshot | null>(null);
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Distribution state
  const [mode, setMode] = useState<DistributionMode>("equal");
  const [amountText, setAmountText] = useState("");
  const [memo, setMemo] = useState("Airdrop");
  const [batchSize, setBatchSize] = useState(15);
  const [minWeight, setMinWeight] = useState("");

  // Resources
  const [resources, setResources] = useState<{
    cpuAvailableUs: number;
    netAvailableBytes: number;
    ramAvailableBytes: number;
    cpuMaxUs: number;
    ramQuotaBytes: number;
  } | null>(null);
  const [ramPrice, setRamPrice] = useState<{ waxPerKb: number; waxPerNewRow: number } | null>(null);

  // Run state
  const [busy, setBusy] = useState<string | null>(null);
  const [runState, setRunState] = useState<"idle" | "running" | "done">("idle");
  const [batchLog, setBatchLog] = useState<
    Array<{ batch: number; recipients: number; txId?: string; error?: string }>
  >([]);
  const [cancelRequested, setCancelRequested] = useState(false);
  const cancelRef = useRef(false);

  const actor = sessionInfo?.actor ?? null;

  // Load wallet module + restore session after hydration (client-only)
  useEffect(() => {
    let cancelled = false;
    import("@/lib/wallet").then(async (mod) => {
      if (cancelled) return;
      walletRef.current = mod;
      setWalletReady(true);
      const restored = await mod.restoreWallet();
      if (!cancelled && restored) {
        setSessionInfo({
          actor: restored.actor.toString(),
          permission: restored.permission.toString(),
          session: restored,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load account data on login
  useEffect(() => {
    if (!actor) return;
    fetchWalletTokens({ data: { account: actor } })
      .then(setWalletTokens)
      .catch(() => setWalletTokens([]));
    fetchAccountResources({ data: { account: actor } })
      .then((r) =>
        setResources({
          cpuAvailableUs: r.cpuAvailableUs,
          netAvailableBytes: r.netAvailableBytes,
          ramAvailableBytes: r.ramAvailableBytes,
          cpuMaxUs: r.cpuMaxUs,
          ramQuotaBytes: r.ramQuotaBytes,
        }),
      )
      .catch(() => setResources(null));
    fetchRamPrice({ data: {} })
      .then(setRamPrice)
      .catch(() => setRamPrice(null));
  }, [actor]);

  // Fetch token stat whenever send token changes
  useEffect(() => {
    if (!ACCOUNT_RE.test(sendContract) || !sendSymbol) {
      setTokenStat(null);
      return;
    }
    let cancelled = false;
    fetchTokenStat({ data: { code: sendContract, symbol: sendSymbol.toUpperCase() } })
      .then((s) => {
        if (cancelled) return;
        setTokenStat({ precision: s.precision, supply: s.supply });
        setPrecision(s.precision);
      })
      .catch(() => {
        if (!cancelled) setTokenStat(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sendContract, sendSymbol]);

  const connect = async () => {
    if (!walletRef.current) return;
    setBusy("connect");
    try {
      const session = await walletRef.current.loginWallet();
      setSessionInfo({
        actor: session.actor.toString(),
        permission: session.permission.toString(),
        session,
      });
    } catch (err) {
      alert(`Login failed: ${shortError(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!walletRef.current || !sessionInfo) return;
    await walletRef.current.logoutWallet(sessionInfo.session);
    setSessionInfo(null);
    setSnapshot(null);
    setBatchLog([]);
    setRunState("idle");
  };

  const loadSnapshot = async () => {
    setBusy("snapshot");
    setSnapshot(null);
    setRunState("idle");
    setBatchLog([]);
    try {
      const snap =
        snapshotMode === "token"
          ? await fetchTokenHolders({
              data: { code: snapContract, symbol: snapSymbol.toUpperCase() },
            })
          : await fetchNftHolders({
              data: {
                collection: snapCollection,
                schema: snapSchema || undefined,
                templateId: snapTemplate ? parseInt(snapTemplate, 10) : undefined,
              },
            });
      // Exclude sender and common system/contract accounts by default
      const excluded = new Set(
        [actor, "eosio", "eosio.ram", "eosio.stake", sendContract, snapContract].filter(
          (x): x is string => !!x,
        ),
      );
      const holders = snap.holders.filter((h) => ACCOUNT_RE.test(h.account));
      setSnapshot({ ...snap, holders });
      setSelected(new Set(holders.map((h) => h.account).filter((a) => !excluded.has(a))));
      setSnapshotAt(new Date().toISOString());
    } catch (err) {
      alert(`Failed to load holders: ${shortError(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const sortedHolders = useMemo(
    () => [...(snapshot?.holders ?? [])].sort((a, b) => b.weight - a.weight),
    [snapshot],
  );

  const filteredHolders = useMemo(() => {
    const min = parseFloat(minWeight);
    if (!minWeight || isNaN(min) || min <= 0) return sortedHolders;
    return sortedHolders.filter((h) => h.weight >= min);
  }, [sortedHolders, minWeight]);

  const quickSelect = (n: number | "all" | "none") => {
    if (n === "all") setSelected(new Set(filteredHolders.map((h) => h.account)));
    else if (n === "none") setSelected(new Set());
    else setSelected(new Set(filteredHolders.slice(0, n).map((h) => h.account)));
  };

  const toggle = (account: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(account)) next.delete(account);
      else next.add(account);
      return next;
    });
  };

  const senderBalanceUnits = useMemo(() => {
    if (!actor || !tokenStat) return null;
    const t = walletTokens.find(
      (w) => w.contract === sendContract && w.symbol === sendSymbol.toUpperCase(),
    );
    if (!t) return null;
    return BigInt(Math.round(t.amount * 10 ** precision));
  }, [actor, tokenStat, walletTokens, sendContract, sendSymbol, precision]);

  const recipients: AirdropRecipient[] = useMemo(() => {
    if (!snapshot || !amountText) return [];
    const chosen = filteredHolders.filter((h) => selected.has(h.account));
    try {
      return computeAmounts(chosen, mode, amountText, precision);
    } catch {
      return [];
    }
  }, [snapshot, filteredHolders, selected, mode, amountText, precision]);

  const total = useMemo(() => totalUnits(recipients), [recipients]);
  const estimate = useMemo(
    () =>
      estimateResources(
        recipients.length,
        Math.max(1, batchSize),
        ramPrice?.waxPerNewRow ?? 0.028,
      ),
    [recipients.length, batchSize, ramPrice],
  );
  const warnings = useMemo(
    () =>
      resourceWarnings(
        estimate,
        resources,
        senderBalanceUnits,
        total,
        precision,
        sendSymbol.toUpperCase(),
      ),
    [estimate, resources, senderBalanceUnits, total, precision, sendSymbol],
  );
  const hasError = warnings.some((w) => w.level === "error");

  const runAirdrop = async () => {
    if (!walletRef.current || !sessionInfo || recipients.length === 0) return;
    setRunState("running");
    setBatchLog([]);
    setCancelRequested(false);
    cancelRef.current = false;
    const batches = chunk(recipients, Math.max(1, batchSize));
    for (let i = 0; i < batches.length; i++) {
      if (cancelRef.current) {
        setBatchLog((prev) => [
          ...prev,
          { batch: i + 1, recipients: 0, error: "Cancelled by user" },
        ]);
        break;
      }
      const batch = batches[i];
      if (!batch) continue;
      try {
        const txId = await walletRef.current.transactTransfers(
          sessionInfo.session,
          batch.map((r) => ({
            tokenContract: sendContract,
            from: sessionInfo.actor,
            to: r.account,
            quantity: formatQuantity(r.units, precision, sendSymbol.toUpperCase()),
            memo,
          })),
        );
        setBatchLog((prev) => [...prev, { batch: i + 1, recipients: batch.length, txId }]);
      } catch (err) {
        setBatchLog((prev) => [
          ...prev,
          { batch: i + 1, recipients: batch.length, error: shortError(err) },
        ]);
      }
      if (i < batches.length - 1) await new Promise((r) => setTimeout(r, 1200));
    }
    setRunState("done");
    // refresh resources after run
    fetchAccountResources({ data: { account: sessionInfo.actor } })
      .then((r) =>
        setResources({
          cpuAvailableUs: r.cpuAvailableUs,
          netAvailableBytes: r.netAvailableBytes,
          ramAvailableBytes: r.ramAvailableBytes,
          cpuMaxUs: r.cpuMaxUs,
          ramQuotaBytes: r.ramQuotaBytes,
        }),
      )
      .catch(() => undefined);
  };

  const downloadCsv = useCallback(() => {
    const lines = ["account,amount,token,memo"];
    for (const r of recipients) {
      lines.push(
        `${r.account},${formatUnits(r.units, precision)},${sendSymbol.toUpperCase()},"${memo.replace(/"/g, '""')}"`,
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `airdrop-${sendSymbol.toLowerCase()}-${snapshotAt?.slice(0, 19).replace(/[:T]/g, "-") ?? "report"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [recipients, precision, sendSymbol, memo, snapshotAt]);

  const canRun =
    !!sessionInfo &&
    recipients.length > 0 &&
    !hasError &&
    runState !== "running" &&
    tokenStat !== null;

  return (
    <main className="mx-auto min-h-screen max-w-6xl px-4 py-8">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            WAX <span className="text-primary">Airdrop</span> Tool
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Snapshot token or NFT holders, configure the drop, sign batched transfers from your wallet.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {actor && (
            <span className="rounded-md border border-border bg-card px-3 py-1.5 font-mono text-sm text-primary">
              {actor}@{sessionInfo?.permission}
            </span>
          )}
          {actor ? (
            <button
              onClick={disconnect}
              className="rounded-md border border-border bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground hover:bg-accent"
            >
              Disconnect
            </button>
          ) : (
            <button
              onClick={connect}
              disabled={!walletReady || busy === "connect"}
              className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {busy === "connect" ? "Connecting…" : "Connect Wallet"}
            </button>
          )}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-5">
        {/* LEFT: configuration */}
        <div className="space-y-6 lg:col-span-2">
          {/* Token to send */}
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              1 · Token to send
            </h2>
            <div className="grid grid-cols-2 gap-2">
              <label className="col-span-1">
                <span className="mb-1 block text-xs text-muted-foreground">Contract</span>
                <input
                  value={sendContract}
                  onChange={(e) => setSendContract(e.target.value.trim().toLowerCase())}
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm text-foreground"
                  placeholder="eosio.token"
                />
              </label>
              <label className="col-span-1">
                <span className="mb-1 block text-xs text-muted-foreground">Symbol</span>
                <input
                  value={sendSymbol}
                  onChange={(e) => setSendSymbol(e.target.value.trim().toUpperCase())}
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm text-foreground"
                  placeholder="WAX"
                />
              </label>
            </div>
            {tokenStat ? (
              <p className="mt-2 text-xs text-primary">
                ✓ {sendSymbol.toUpperCase()} · precision {tokenStat.precision} · supply{" "}
                {tokenStat.supply}
              </p>
            ) : (
              sendContract &&
              sendSymbol && (
                <p className="mt-2 text-xs text-destructive">
                  Token not found on {sendContract}.
                </p>
              )
            )}
            {walletTokens.length > 0 && (
              <div className="mt-3">
                <span className="mb-1 block text-xs text-muted-foreground">Your tokens</span>
                <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
                  {walletTokens.slice(0, 40).map((t) => (
                    <button
                      key={`${t.contract}:${t.symbol}`}
                      onClick={() => {
                        setSendContract(t.contract);
                        setSendSymbol(t.symbol);
                      }}
                      className={`rounded border px-2 py-0.5 font-mono text-xs ${
                        t.contract === sendContract && t.symbol === sendSymbol.toUpperCase()
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-background text-muted-foreground hover:text-foreground"
                      }`}
                      title={t.contract}
                    >
                      {t.symbol} {t.amount.toFixed(Math.min(t.precision, 4))}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Snapshot source */}
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              2 · Airdrop to holders of
            </h2>
            <div className="mb-3 grid grid-cols-2 gap-1 rounded-md border border-border bg-background p-1">
              {(["token", "nft"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setSnapshotMode(m)}
                  className={`rounded px-2 py-1 text-sm font-medium ${
                    snapshotMode === m
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {m === "token" ? "Token" : "NFT collection"}
                </button>
              ))}
            </div>
            {snapshotMode === "token" ? (
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={snapContract}
                  onChange={(e) => setSnapContract(e.target.value.trim().toLowerCase())}
                  placeholder="contract (e.g. token.boc)"
                  className="rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm text-foreground"
                />
                <input
                  value={snapSymbol}
                  onChange={(e) => setSnapSymbol(e.target.value.trim().toUpperCase())}
                  placeholder="symbol"
                  className="rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm text-foreground"
                />
              </div>
            ) : (
              <div className="space-y-2">
                <input
                  value={snapCollection}
                  onChange={(e) => setSnapCollection(e.target.value.trim().toLowerCase())}
                  placeholder="collection name (required)"
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm text-foreground"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={snapSchema}
                    onChange={(e) => setSnapSchema(e.target.value.trim())}
                    placeholder="schema (optional)"
                    className="rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm text-foreground"
                  />
                  <input
                    value={snapTemplate}
                    onChange={(e) => setSnapTemplate(e.target.value.trim())}
                    placeholder="template id (optional)"
                    className="rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm text-foreground"
                  />
                </div>
              </div>
            )}
            <button
              onClick={loadSnapshot}
              disabled={
                busy === "snapshot" ||
                (snapshotMode === "token"
                  ? !ACCOUNT_RE.test(snapContract) || !snapSymbol
                  : !snapCollection)
              }
              className="mt-3 w-full rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {busy === "snapshot" ? "Loading holders…" : "Load holder list"}
            </button>
            {snapshot && (
              <p className="mt-2 text-xs text-muted-foreground">
                {snapshot.holders.length.toLocaleString()} holders
                {snapshot.truncated && " (truncated)"} · via {snapshot.source}
                {snapshotAt && ` · ${new Date(snapshotAt).toLocaleTimeString()}`}
              </p>
            )}
            {snapshot && !snapshot.hasBalances && (
              <p className="mt-1 text-xs text-destructive">
                Fallback source has no balances — pro-rata distribution is unavailable.
              </p>
            )}
          </section>

          {/* Distribution */}
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              3 · Distribution
            </h2>
            <div className="mb-3 grid grid-cols-3 gap-1 rounded-md border border-border bg-background p-1">
              {(
                [
                  ["equal", "Equal split"],
                  ["fixed", "Fixed each"],
                  ["prorata", "Pro-rata"],
                ] as Array<[DistributionMode, string]>
              ).map(([m, label]) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  disabled={m === "prorata" && snapshot !== null && !snapshot.hasBalances}
                  className={`rounded px-2 py-1 text-sm font-medium disabled:opacity-40 ${
                    mode === m
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="mb-2 block">
              <span className="mb-1 block text-xs text-muted-foreground">
                {mode === "fixed"
                  ? `Amount per holder (${sendSymbol.toUpperCase()})`
                  : `Total amount (${sendSymbol.toUpperCase()})`}
              </span>
              <input
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
                placeholder={mode === "fixed" ? "e.g. 5.0000" : "e.g. 10000.0000"}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm text-foreground"
              />
            </label>
            <label className="mb-2 block">
              <span className="mb-1 block text-xs text-muted-foreground">Memo</span>
              <input
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                maxLength={256}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm text-foreground"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label>
                <span className="mb-1 block text-xs text-muted-foreground">
                  Batch size (actions/tx)
                </span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={batchSize}
                  onChange={(e) => setBatchSize(parseInt(e.target.value, 10) || 15)}
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm text-foreground"
                />
              </label>
              <label>
                <span className="mb-1 block text-xs text-muted-foreground">
                  Min. balance to include
                </span>
                <input
                  value={minWeight}
                  onChange={(e) => setMinWeight(e.target.value)}
                  placeholder="0"
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm text-foreground"
                />
              </label>
            </div>
          </section>

          {/* Resources & cost */}
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              4 · Cost check
            </h2>
            {resources ? (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs">
                <dt className="text-muted-foreground">CPU available</dt>
                <dd className="text-right text-foreground">
                  {(resources.cpuAvailableUs / 1000).toFixed(1)} / {(resources.cpuMaxUs / 1000).toFixed(1)} ms
                </dd>
                <dt className="text-muted-foreground">NET available</dt>
                <dd className="text-right text-foreground">
                  {(resources.netAvailableBytes / 1024).toFixed(1)} KB
                </dd>
                <dt className="text-muted-foreground">RAM free</dt>
                <dd className="text-right text-foreground">
                  {(resources.ramAvailableBytes / 1024).toFixed(1)} / {(resources.ramQuotaBytes / 1024).toFixed(1)} KB
                </dd>
                {ramPrice && (
                  <>
                    <dt className="text-muted-foreground">RAM price</dt>
                    <dd className="text-right text-foreground">{ramPrice.waxPerKb.toFixed(3)} WAX/KB</dd>
                  </>
                )}
                <dt className="text-muted-foreground">Est. CPU / tx</dt>
                <dd className="text-right text-foreground">~{(estimate.cpuPerTxUs / 1000).toFixed(1)} ms</dd>
                <dt className="text-muted-foreground">Worst-case RAM cost</dt>
                <dd className="text-right text-foreground">
                  ~{estimate.maxRamCostWax.toFixed(2)} WAX ({estimate.maxNewRows} new rows)
                </dd>
              </dl>
            ) : (
              <p className="text-xs text-muted-foreground">
                Connect your wallet to check CPU / NET / RAM headroom.
              </p>
            )}
            <div className="mt-3 space-y-1">
              {warnings.map((w, i) => (
                <p
                  key={i}
                  className={`text-xs ${w.level === "error" ? "text-destructive" : "text-yellow-500"}`}
                >
                  {w.level === "error" ? "✕" : "⚠"} {w.message}
                </p>
              ))}
            </div>
          </section>
        </div>

        {/* RIGHT: holders + run */}
        <div className="space-y-6 lg:col-span-3">
          <section className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Holders{" "}
                <span className="font-mono text-primary">
                  {selected.size.toLocaleString()} / {filteredHolders.length.toLocaleString()}
                </span>
              </h2>
              <div className="flex flex-wrap gap-1">
                {[10, 50, 100].map((n) => (
                  <button
                    key={n}
                    onClick={() => quickSelect(n)}
                    disabled={filteredHolders.length === 0}
                    className="rounded border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-40"
                  >
                    Top {n}
                  </button>
                ))}
                <button
                  onClick={() => quickSelect("all")}
                  disabled={filteredHolders.length === 0}
                  className="rounded border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-40"
                >
                  All
                </button>
                <button
                  onClick={() => quickSelect("none")}
                  disabled={filteredHolders.length === 0}
                  className="rounded border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-40"
                >
                  None
                </button>
              </div>
            </div>
            {snapshot ? (
              <div className="max-h-[420px] overflow-y-auto rounded-md border border-border">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-secondary">
                    <tr>
                      <th className="px-3 py-2 text-xs font-medium text-muted-foreground">#</th>
                      <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Account</th>
                      <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">
                        {snapshotMode === "nft" ? "NFTs" : "Balance"}
                      </th>
                      <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">
                        Receives ({sendSymbol.toUpperCase()})
                      </th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {filteredHolders.slice(0, 500).map((h, i) => {
                      const r = recipients.find((x) => x.account === h.account);
                      const isSel = selected.has(h.account);
                      return (
                        <tr
                          key={h.account}
                          onClick={() => toggle(h.account)}
                          className={`cursor-pointer border-t border-border ${
                            isSel ? "bg-primary/5" : "opacity-45"
                          } hover:bg-accent/50`}
                        >
                          <td className="px-3 py-1.5 text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={isSel}
                              onChange={() => toggle(h.account)}
                              onClick={(e) => e.stopPropagation()}
                              className="mr-2 accent-primary"
                            />
                            {i + 1}
                          </td>
                          <td className="px-3 py-1.5 text-foreground">{h.account}</td>
                          <td className="px-3 py-1.5 text-right text-muted-foreground">
                            {snapshotMode === "nft"
                              ? h.raw
                              : parseFloat(h.raw).toLocaleString(undefined, {
                                  maximumFractionDigits: 4,
                                })}
                          </td>
                          <td className="px-3 py-1.5 text-right text-primary">
                            {r ? formatUnits(r.units, precision) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {filteredHolders.length > 500 && (
                  <p className="bg-secondary px-3 py-2 text-xs text-muted-foreground">
                    Showing first 500 rows — all {filteredHolders.length.toLocaleString()} selected accounts are still included in the drop.
                  </p>
                )}
              </div>
            ) : (
              <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                Load a holder list to preview recipients.
              </p>
            )}
          </section>

          {/* Summary + run */}
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Summary
            </h2>
            <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">Recipients</dt>
                <dd className="text-lg text-foreground">{recipients.length.toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Total to send</dt>
                <dd className="text-lg text-primary">
                  {formatUnits(total, precision)} {sendSymbol.toUpperCase()}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Transactions</dt>
                <dd className="text-lg text-foreground">{estimate.txCount}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Est. total CPU</dt>
                <dd className="text-lg text-foreground">~{(estimate.totalCpuUs / 1000).toFixed(0)} ms</dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-2">
              {runState !== "running" ? (
                <button
                  onClick={runAirdrop}
                  disabled={!canRun}
                  className="rounded-md bg-primary px-6 py-2.5 text-sm font-bold text-primary-foreground hover:opacity-90 disabled:opacity-40"
                >
                  AIRDROP {recipients.length > 0 && `(${recipients.length.toLocaleString()} recipients)`}
                </button>
              ) : (
                <button
                  onClick={() => {
                    cancelRef.current = true;
                    setCancelRequested(true);
                  }}
                  disabled={cancelRequested}
                  className="rounded-md bg-destructive px-6 py-2.5 text-sm font-bold text-destructive-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {cancelRequested ? "Cancelling…" : "Cancel after current batch"}
                </button>
              )}
              {recipients.length > 0 && (
                <button
                  onClick={downloadCsv}
                  className="rounded-md border border-border bg-secondary px-4 py-2.5 text-sm font-medium text-secondary-foreground hover:bg-accent"
                >
                  Download CSV
                </button>
              )}
            </div>
            {!sessionInfo && (
              <p className="mt-2 text-xs text-muted-foreground">
                Connect your wallet to enable the airdrop.
              </p>
            )}

            {batchLog.length > 0 && (
              <div className="mt-4 max-h-64 overflow-y-auto rounded-md border border-border bg-background p-2 font-mono text-xs">
                {batchLog.map((b) => (
                  <div key={b.batch} className="flex items-start gap-2 py-0.5">
                    {b.txId ? (
                      <>
                        <span className="text-primary">✓</span>
                        <span className="text-muted-foreground">
                          batch {b.batch} · {b.recipients} transfers ·{" "}
                        </span>
                        <a
                          href={`https://waxblock.io/transaction/${b.txId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate text-primary underline"
                        >
                          {b.txId.slice(0, 20)}…
                        </a>
                      </>
                    ) : (
                      <>
                        <span className="text-destructive">✕</span>
                        <span className="text-destructive">
                          batch {b.batch} · {b.recipients} transfers · {b.error}
                        </span>
                      </>
                    )}
                  </div>
                ))}
                {runState === "done" && (
                  <div className="mt-1 border-t border-border pt-1 text-foreground">
                    Done · {batchLog.filter((b) => b.txId).length}/{estimate.txCount} batches succeeded.
                    Failed batches can be re-sent by pressing Airdrop again after fixing the issue.
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </div>

      <footer className="mt-10 border-t border-border pt-4 text-xs text-muted-foreground">
        Private keys never leave your wallet. Every batch is a separate transaction signed by you.
        Verify recipient lists before sending — airdrops are irreversible.
      </footer>
    </main>
  );
}
