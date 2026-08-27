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
  fetchCheeseBalance,
  fetchNftHolders,
  fetchRamPrice,
  fetchResourcePricing,
  fetchTokenHolders,
  fetchTokenStat,
  fetchWalletTokens,
} from "@/lib/chain.functions";
import {
  CHEESE_CPU_CONTRACT,
  CHEESE_RAM_CONTRACT,
  CHEESE_SYMBOL,
  DEFAULT_CPU_PERCENT,
  powerupMemo,
  ramMemo,
  txLink,
} from "@/lib/cheese";
import {
  ceilCheese,
  cheeseForBytes,
  cheeseForCpuUs,
  formatCheese,
  splitPurchases,
  weightCalibration,
  type ResourcePricing,
} from "@/lib/resources";
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

interface AccountResourceView {
  cpuAvailableUs: number;
  netAvailableBytes: number;
  ramAvailableBytes: number;
  cpuMaxUs: number;
  netMaxBytes: number;
  ramQuotaBytes: number;
  cpuWeightUnits: number;
  netWeightUnits: number;
}

/** RAM bytes a fresh token balance row costs the sender. */
const RAM_BYTES_PER_ROW = 276;

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
  const [resources, setResources] = useState<AccountResourceView | null>(null);
  const [ramPrice, setRamPrice] = useState<{ waxPerKb: number; waxPerNewRow: number } | null>(null);

  // CHEESE resource purchases (handled automatically when the airdrop runs)
  const [cheeseBalance, setCheeseBalance] = useState<number | null>(null);
  const [pricing, setPricing] = useState<ResourcePricing | null>(null);
  const cpuPercent = DEFAULT_CPU_PERCENT;
  const [purchaseLog, setPurchaseLog] = useState<
    Array<{ kind: "cpu" | "ram"; cheese: number; txId?: string; error?: string }>
  >([]);

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

  const refreshAccount = useCallback(async (account: string) => {
    await Promise.all([
      fetchAccountResources({ data: { account } })
        .then((r) =>
          setResources({
            cpuAvailableUs: r.cpuAvailableUs,
            netAvailableBytes: r.netAvailableBytes,
            ramAvailableBytes: r.ramAvailableBytes,
            cpuMaxUs: r.cpuMaxUs,
            netMaxBytes: r.netMaxBytes,
            ramQuotaBytes: r.ramQuotaBytes,
            cpuWeightUnits: r.cpuWeightUnits,
            netWeightUnits: r.netWeightUnits,
          }),
        )
        .catch(() => setResources(null)),
      fetchCheeseBalance({ data: { account } })
        .then(setCheeseBalance)
        .catch(() => setCheeseBalance(null)),
    ]);
  }, []);

  // Load account data on login
  useEffect(() => {
    if (!actor) return;
    fetchWalletTokens({ data: { account: actor } })
      .then(setWalletTokens)
      .catch(() => setWalletTokens([]));
    void refreshAccount(actor);
    fetchRamPrice({ data: {} })
      .then(setRamPrice)
      .catch(() => setRamPrice(null));
    fetchResourcePricing({ data: {} })
      .then(setPricing)
      .catch(() => setPricing(null));
  }, [actor, refreshAccount]);

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
      estimateResources(recipients.length, Math.max(1, batchSize), ramPrice?.waxPerNewRow ?? 0.028),
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

  // ---- CHEESE resource purchases -----------------------------------------
  const calibration = useMemo(
    () =>
      resources
        ? weightCalibration(resources)
        : { cpuUsPerWeightUnit: null, netBytesPerWeightUnit: null },
    [resources],
  );

  /** CPU needed for one batch plus 20% headroom. */
  const cpuNeededUs = estimate.cpuPerTxUs * 1.2;
  const ramNeededBytes = estimate.maxNewRows * RAM_BYTES_PER_ROW;
  const cpuShortUs =
    resources && recipients.length > 0 ? Math.max(0, cpuNeededUs - resources.cpuAvailableUs) : 0;
  const ramShortBytes =
    resources && recipients.length > 0
      ? Math.max(0, ramNeededBytes - resources.ramAvailableBytes)
      : 0;

  const suggestedCpuCheese = useMemo(
    () =>
      pricing && cpuShortUs > 0
        ? cheeseForCpuUs(cpuShortUs, pricing, calibration, cpuPercent)
        : null,
    [pricing, cpuShortUs, calibration, cpuPercent],
  );
  const suggestedRamCheese = useMemo(() => {
    if (!pricing || ramShortBytes <= 0) return null;
    const needed = cheeseForBytes(ramShortBytes, pricing);
    if (needed === null) return null;
    return ceilCheese(Math.max(needed, pricing.ram.minCheese));
  }, [pricing, ramShortBytes]);

  /** Sign one or more CHEESE transfers to a resource contract. Returns true on full success. */
  const buyWithCheese = useCallback(
    async (kind: "cpu" | "ram", amounts: number[]): Promise<boolean> => {
      const wallet = walletRef.current;
      if (!wallet || !sessionInfo || amounts.length === 0) return false;
      const to = kind === "cpu" ? CHEESE_CPU_CONTRACT : CHEESE_RAM_CONTRACT;
      const memoText =
        kind === "cpu"
          ? powerupMemo(sessionInfo.actor, cpuPercent)
          : ramMemo(sessionInfo.actor, true);
      setBusy(kind === "cpu" ? "buy-cpu" : "buy-ram");
      let ok = true;
      try {
        for (let i = 0; i < amounts.length; i++) {
          const cheese = amounts[i];
          if (cheese === undefined || cheese <= 0) continue;
          try {
            const txId = await wallet.transferCheese(sessionInfo.session, {
              to,
              quantity: `${formatCheese(cheese)} ${CHEESE_SYMBOL}`,
              memo: memoText,
            });
            setPurchaseLog((prev) => [...prev, { kind, cheese, txId }]);
          } catch (err) {
            ok = false;
            setPurchaseLog((prev) => [...prev, { kind, cheese, error: shortError(err) }]);
            break;
          }
          if (i < amounts.length - 1) await new Promise((r) => setTimeout(r, 1200));
        }
      } finally {
        setBusy(null);
      }
      // Give the chain a moment to apply the powerup / RAM purchase, then re-read.
      await new Promise((r) => setTimeout(r, 3000));
      await refreshAccount(sessionInfo.actor);
      return ok;
    },
    [sessionInfo, cpuPercent, refreshAccount],
  );

  const runAirdrop = async () => {
    if (!walletRef.current || !sessionInfo || recipients.length === 0) return;

    // Resources are handled for the user: buy exactly what the drop is short of,
    // with CHEESE, as separate transactions before the first batch.
    if (pricing) {
      if (suggestedCpuCheese && (cheeseBalance === null || cheeseBalance >= suggestedCpuCheese)) {
        const ok = await buyWithCheese("cpu", [suggestedCpuCheese]);
        if (!ok) return;
      }
      if (
        suggestedRamCheese &&
        pricing.ram.enabled &&
        (cheeseBalance === null || cheeseBalance >= suggestedRamCheese)
      ) {
        const ok = await buyWithCheese(
          "ram",
          splitPurchases(suggestedRamCheese, pricing.ram.minCheese, pricing.ram.maxCheese),
        );
        if (!ok) return;
      }
    }

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
    void refreshAccount(sessionInfo.actor);
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
    busy === null &&
    tokenStat !== null;

  return (
    <main className="mx-auto min-h-screen max-w-6xl px-4 py-8">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            WAX <span className="text-primary">Airdrop</span> Tool
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Snapshot token or NFT holders, configure the drop, sign batched transfers from your
            wallet.
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
                <p className="mt-2 text-xs text-destructive">Token not found on {sendContract}.</p>
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
                      <th className="px-3 py-2 text-xs font-medium text-muted-foreground">
                        Account
                      </th>
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
                    Showing first 500 rows — all {filteredHolders.length.toLocaleString()} selected
                    accounts are still included in the drop.
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
                <dd className="text-lg text-foreground">
                  ~{(estimate.totalCpuUs / 1000).toFixed(0)} ms
                </dd>
              </div>
            </dl>
            {warnings.filter((w) => w.level === "error").length > 0 && (
              <div className="mb-3 space-y-1">
                {warnings
                  .filter((w) => w.level === "error")
                  .map((w, i) => (
                    <p key={i} className="text-xs text-destructive">
                      ✕ {w.message}
                    </p>
                  ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {runState !== "running" ? (
                <button
                  onClick={runAirdrop}
                  disabled={!canRun}
                  className="rounded-md bg-primary px-6 py-2.5 text-sm font-bold text-primary-foreground hover:opacity-90 disabled:opacity-40"
                >
                  AIRDROP{" "}
                  {recipients.length > 0 && `(${recipients.length.toLocaleString()} recipients)`}
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
            {sessionInfo && (
              <p className="mt-2 text-xs text-muted-foreground">
                CPU, NET and RAM are topped up automatically with {CHEESE_SYMBOL} when needed — you
                may be asked to sign those purchases before the first batch.
              </p>
            )}

            {purchaseLog.length > 0 && (
              <div className="mt-4 max-h-40 overflow-y-auto rounded-md border border-border bg-background p-2 font-mono text-xs">
                {purchaseLog.map((p, i) => (
                  <div key={i} className="flex items-start gap-2 py-0.5">
                    {p.txId ? (
                      <>
                        <span className="text-primary">✓</span>
                        <span className="text-muted-foreground">
                          {p.kind === "cpu" ? "CPU/NET" : "RAM"} · {formatCheese(p.cheese)}{" "}
                          {CHEESE_SYMBOL} ·{" "}
                        </span>
                        <a
                          href={txLink(p.txId)}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate text-primary underline"
                        >
                          {p.txId.slice(0, 16)}…
                        </a>
                      </>
                    ) : (
                      <>
                        <span className="text-destructive">✕</span>
                        <span className="text-destructive">
                          {p.kind === "cpu" ? "CPU/NET" : "RAM"} · {formatCheese(p.cheese)}{" "}
                          {CHEESE_SYMBOL} · {p.error}
                        </span>
                      </>
                    )}
                  </div>
                ))}
              </div>
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
                    Done · {batchLog.filter((b) => b.txId).length}/{estimate.txCount} batches
                    succeeded. Failed batches can be re-sent by pressing Airdrop again after fixing
                    the issue.
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
