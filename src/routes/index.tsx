import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  assignAssets,
  computeAmounts,
  chunk,
  estimateNftResources,
  estimateResources,
  formatQuantity,
  formatUnits,
  resourceWarnings,
  totalUnits,
  RAM_BYTES_PER_NFT,
  type AirdropRecipient,
  type DistributionMode,
} from "@/lib/airdrop";
import type {
  Holder,
  HolderSnapshot,
  InventoryCollection,
  InventoryTemplate,
} from "@/lib/chain.server";
import {
  fetchAccountResources,
  fetchCheeseBalance,
  fetchExistingTokenRows,
  fetchInventoryAssets,
  fetchInventoryCollections,
  fetchInventoryTemplates,
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
  MIN_RAM_PURCHASE_CHEESE,
  powerupMemo,
  ramMemo,
  txLink,
} from "@/lib/cheese";
import {
  bytesPerCheese,
  ceilCheese,
  cheeseForBytes,
  cheeseForCpuUs,
  cpuUsPerCheese,
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

  // What to send: a token, or NFTs from your own inventory
  const [assetKind, setAssetKind] = useState<"token" | "nft">("token");

  // Send-token state
  const [sendContract, setSendContract] = useState("eosio.token");
  const [sendSymbol, setSendSymbol] = useState("WAX");
  const [precision, setPrecision] = useState(8);
  const [tokenStat, setTokenStat] = useState<{ precision: number; supply: string } | null>(null);
  const [walletTokens, setWalletTokens] = useState<
    Array<{ contract: string; symbol: string; amount: number; precision: number }>
  >([]);

  // Send-NFT state (pool = assets of one template owned by the connected account)
  const [nftCollections, setNftCollections] = useState<InventoryCollection[]>([]);
  const [nftCollection, setNftCollection] = useState("");
  const [nftTemplates, setNftTemplates] = useState<InventoryTemplate[]>([]);
  const [nftTemplateId, setNftTemplateId] = useState<number | null>(null);
  const [nftPool, setNftPool] = useState<string[]>([]);
  const [nftLoading, setNftLoading] = useState<null | "collections" | "templates" | "assets">(null);
  const [nftError, setNftError] = useState<string | null>(null);


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
  const [runError, setRunError] = useState<string | null>(null);

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

  const isNft = assetKind === "nft";

  // NFT inventory: collections owned by the connected account
  useEffect(() => {
    if (!isNft || !actor) return;
    let cancelled = false;
    setNftLoading("collections");
    setNftError(null);
    fetchInventoryCollections({ data: { account: actor } })
      .then((cols) => {
        if (cancelled) return;
        setNftCollections(cols);
      })
      .catch((err) => {
        if (!cancelled) {
          setNftCollections([]);
          setNftError(`Could not load your NFT collections: ${shortError(err)}`);
        }
      })
      .finally(() => {
        if (!cancelled) setNftLoading(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isNft, actor]);

  // NFT inventory: templates owned inside the chosen collection
  useEffect(() => {
    if (!isNft || !actor || !nftCollection) {
      setNftTemplates([]);
      return;
    }
    let cancelled = false;
    setNftLoading("templates");
    setNftError(null);
    setNftTemplateId(null);
    setNftPool([]);
    fetchInventoryTemplates({ data: { account: actor, collection: nftCollection } })
      .then((tpls) => {
        if (cancelled) return;
        setNftTemplates(tpls);
      })
      .catch((err) => {
        if (!cancelled) {
          setNftTemplates([]);
          setNftError(`Could not load templates for ${nftCollection}: ${shortError(err)}`);
        }
      })
      .finally(() => {
        if (!cancelled) setNftLoading(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isNft, actor, nftCollection]);

  // NFT inventory: the pool of asset ids for the chosen template
  useEffect(() => {
    if (!isNft || !actor || !nftCollection || nftTemplateId === null) {
      setNftPool([]);
      return;
    }
    let cancelled = false;
    setNftLoading("assets");
    setNftError(null);
    fetchInventoryAssets({
      data: { account: actor, collection: nftCollection, templateId: nftTemplateId },
    })
      .then((res) => {
        if (cancelled) return;
        setNftPool(res.assetIds);
      })
      .catch((err) => {
        if (!cancelled) {
          setNftPool([]);
          setNftError(`Could not load your NFTs of this template: ${shortError(err)}`);
        }
      })
      .finally(() => {
        if (!cancelled) setNftLoading(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isNft, actor, nftCollection, nftTemplateId]);



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

  /** Selected recipients in list order — used directly by NFT drops. */
  const selectedAccounts = useMemo(
    () => filteredHolders.filter((h) => selected.has(h.account)).map((h) => h.account),
    [filteredHolders, selected],
  );
  const { assignments: nftAssignments, shortfall: nftShortfall } = useMemo(
    () => (isNft ? assignAssets(nftPool, selectedAccounts) : { assignments: [], shortfall: 0 }),
    [isNft, nftPool, selectedAccounts],
  );

  // ---- Existing token rows -------------------------------------------------
  // Recipients that already hold a row for the token being sent cost no RAM.
  // Cache is keyed by contract|symbol|account so re-checks are cheap.
  const rowCacheRef = useRef<Map<string, boolean>>(new Map());
  const [rowCacheVersion, setRowCacheVersion] = useState(0);
  const [rowCheckLoading, setRowCheckLoading] = useState(false);
  const rowKey = useCallback(
    (account: string) => `${sendContract}|${sendSymbol.toUpperCase()}|${account}`,
    [sendContract, sendSymbol],
  );
  const recipientAccounts = useMemo(() => recipients.map((r) => r.account), [recipients]);
  const recipientKey = recipientAccounts.join(",");

  useEffect(() => {
    if (isNft || !sendContract || !sendSymbol || recipientAccounts.length === 0) return;
    const pending = recipientAccounts.filter((a) => !rowCacheRef.current.has(rowKey(a)));
    if (pending.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setRowCheckLoading(true);
      fetchExistingTokenRows({
        data: { code: sendContract, symbol: sendSymbol.toUpperCase(), accounts: pending },
      })
        .then((res) => {
          if (cancelled) return;
          const unknown = new Set(res.unknown);
          const existing = new Set(res.existing);
          for (const account of pending) {
            if (unknown.has(account)) continue; // leave uncached, stays conservative
            rowCacheRef.current.set(rowKey(account), existing.has(account));
          }
          setRowCacheVersion((v) => v + 1);
        })
        .catch(() => {
          // keep the worst case on failure
        })
        .finally(() => {
          if (!cancelled) setRowCheckLoading(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNft, sendContract, sendSymbol, recipientKey, rowKey]);

  const rowStats = useMemo(() => {
    void rowCacheVersion;
    let existing = 0;
    let checked = 0;
    for (const account of recipientAccounts) {
      const hit = rowCacheRef.current.get(rowKey(account));
      if (hit === undefined) continue;
      checked += 1;
      if (hit) existing += 1;
    }
    return {
      existing,
      checked,
      newRows: recipientAccounts.length - existing,
      complete: checked === recipientAccounts.length && recipientAccounts.length > 0,
    };
  }, [recipientAccounts, rowKey, rowCacheVersion]);

  const estimate = useMemo(
    () =>
      isNft
        ? estimateNftResources(
            nftAssignments.length,
            Math.max(1, batchSize),
            ramPrice?.waxPerKb ?? 0.1,
          )
        : estimateResources(
            recipients.length,
            Math.max(1, batchSize),
            ramPrice?.waxPerNewRow ?? 0.028,
            rowStats.checked > 0 ? rowStats.newRows : null,
          ),
    [isNft, nftAssignments.length, recipients.length, batchSize, ramPrice, rowStats],
  );
  const warnings = useMemo(() => {
    if (isNft) {
      // NFTs come out of your own inventory: the only blocker is pool coverage.
      return nftShortfall > 0
        ? [
            {
              level: "error" as const,
              message: `You need ${nftShortfall} more NFT${nftShortfall === 1 ? "" : "s"} of this template to cover every selected recipient. Deselect recipients or pick a template you own more of.`,
            },
          ]
        : [];
    }
    // Resource shortfalls are handled automatically with CHEESE top-ups, so
    // only the token balance is validated here.
    return resourceWarnings(
      estimate,
      null,
      senderBalanceUnits,
      total,
      precision,
      sendSymbol.toUpperCase(),
    );
  }, [isNft, nftShortfall, estimate, senderBalanceUnits, total, precision, sendSymbol]);
  const hasError = warnings.some((w) => w.level === "error");

  // ---- CHEESE resource purchases -----------------------------------------
  const calibration = useMemo(
    () =>
      resources
        ? weightCalibration(resources)
        : { cpuUsPerWeightUnit: null, netBytesPerWeightUnit: null },
    [resources],
  );

  const recipientCount = isNft ? nftAssignments.length : recipients.length;

  /** CPU needed for one batch plus 20% headroom. */
  const cpuNeededUs = estimate.cpuPerTxUs * 1.2;
  const ramNeededBytes = estimate.maxNewRows * (isNft ? RAM_BYTES_PER_NFT : RAM_BYTES_PER_ROW);
  const cpuShortUs =
    resources && recipientCount > 0 ? Math.max(0, cpuNeededUs - resources.cpuAvailableUs) : 0;
  const ramShortBytes =
    resources && recipientCount > 0
      ? Math.max(0, ramNeededBytes - resources.ramAvailableBytes)
      : 0;


  const suggestedCpuCheese = useMemo(
    () =>
      pricing && cpuShortUs > 0
        ? cheeseForCpuUs(cpuShortUs, pricing, calibration, cpuPercent)
        : null,
    [pricing, cpuShortUs, calibration, cpuPercent],
  );
  /**
   * RAM is always purchased: at least MIN_RAM_PURCHASE_CHEESE, more when the
   * drop's estimated RAM need is larger. Null only when pricing is unavailable.
   */
  const requiredRamCheese = useMemo(() => {
    if (!pricing) return null;
    const needed = ramShortBytes > 0 ? cheeseForBytes(ramShortBytes, pricing) : 0;
    return ceilCheese(Math.max(MIN_RAM_PURCHASE_CHEESE, needed ?? 0, pricing.ram.minCheese));
  }, [pricing, ramShortBytes]);

  /** Current CHEESE prices: how much 1 ms of CPU / 1 KB of RAM costs right now. */
  const cheesePerCpuMs = useMemo(() => {
    if (!pricing) return null;
    const per = cpuUsPerCheese(pricing, calibration, cpuPercent);
    if (!per || per <= 0) return null;
    return 1000 / per;
  }, [pricing, calibration, cpuPercent]);
  const cheesePerRamKb = useMemo(() => {
    if (!pricing) return null;
    const per = bytesPerCheese(pricing);
    if (!per || per <= 0) return null;
    return 1024 / per;
  }, [pricing]);

  /** Full estimated CHEESE cost of this airdrop's CPU and RAM needs. */
  const estCpuCheese = useMemo(
    () =>
      pricing && recipientCount > 0
        ? cheeseForCpuUs(cpuNeededUs, pricing, calibration, cpuPercent)
        : null,
    [pricing, cpuNeededUs, calibration, cpuPercent, recipientCount],
  );
  const estRamCheese = useMemo(
    () => (pricing && ramNeededBytes > 0 ? cheeseForBytes(ramNeededBytes, pricing) : null),
    [pricing, ramNeededBytes],
  );

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
    if (!walletRef.current || !sessionInfo) return;
    if (isNft ? nftAssignments.length === 0 || nftShortfall > 0 : recipients.length === 0) return;

    setBatchLog([]);
    setPurchaseLog([]);
    setRunError(null);

    // Every airdrop buys RAM with CHEESE first (minimum MIN_RAM_PURCHASE_CHEESE,
    // more if the drop needs it). CPU/NET is topped up only when short.
    if (pricing) {
      if (requiredRamCheese === null) {
        setRunError(
          `${CHEESE_SYMBOL} resource pricing is unavailable right now, so the required RAM purchase cannot be made. Try again in a moment.`,
        );
        return;
      }
      if (!pricing.ram.enabled) {
        setRunError(
          `The ${CHEESE_RAM_CONTRACT} contract has RAM buying disabled right now, so the required RAM purchase cannot be made. Try again later.`,
        );
        return;
      }
      const totalNeeded = requiredRamCheese + (suggestedCpuCheese ?? 0);
      if (cheeseBalance !== null && cheeseBalance < totalNeeded) {
        setRunError(
          `This airdrop requires ${formatCheese(totalNeeded)} ${CHEESE_SYMBOL} of resources (including the ${formatCheese(requiredRamCheese)} ${CHEESE_SYMBOL} RAM purchase), but your balance is ${formatCheese(cheeseBalance)} ${CHEESE_SYMBOL}.`,
        );
        return;
      }
      if (suggestedCpuCheese) {
        const ok = await buyWithCheese("cpu", [suggestedCpuCheese]);
        if (!ok) return;
      }
      const ok = await buyWithCheese(
        "ram",
        splitPurchases(requiredRamCheese, pricing.ram.minCheese, pricing.ram.maxCheese),
      );
      if (!ok) return;
    } else {
      setRunError(
        `${CHEESE_SYMBOL} resource pricing is unavailable right now, so the required RAM purchase cannot be made. Try again in a moment.`,
      );
      return;
    }

    setRunState("running");
    setBatchLog([]);
    setCancelRequested(false);
    cancelRef.current = false;
    if (isNft) {
      const batches = chunk(nftAssignments, Math.max(1, batchSize));
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
          const txId = await walletRef.current.transactNftTransfers(
            sessionInfo.session,
            batch.map((a) => ({
              from: sessionInfo.actor,
              to: a.account,
              assetIds: [a.assetId],
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
      return;
    }
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
    const quotedMemo = `"${memo.replace(/"/g, '""')}"`;
    const stamp = snapshotAt?.slice(0, 19).replace(/[:T]/g, "-") ?? "report";
    let lines: string[];
    let name: string;
    if (isNft) {
      lines = ["account,asset_id,collection,template_id,memo"];
      for (const a of nftAssignments) {
        lines.push(
          `${a.account},${a.assetId},${nftCollection},${nftTemplateId ?? ""},${quotedMemo}`,
        );
      }
      name = `airdrop-nft-${nftCollection || "assets"}-${stamp}.csv`;
    } else {
      lines = ["account,amount,token,memo"];
      for (const r of recipients) {
        lines.push(
          `${r.account},${formatUnits(r.units, precision)},${sendSymbol.toUpperCase()},${quotedMemo}`,
        );
      }
      name = `airdrop-${sendSymbol.toLowerCase()}-${stamp}.csv`;
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }, [
    isNft,
    nftAssignments,
    nftCollection,
    nftTemplateId,
    recipients,
    precision,
    sendSymbol,
    memo,
    snapshotAt,
  ]);


  const canRun =
    !!sessionInfo &&
    !hasError &&
    runState !== "running" &&
    busy === null &&
    (isNft
      ? nftAssignments.length > 0 && nftShortfall === 0
      : recipients.length > 0 && tokenStat !== null);


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
          {/* What to send */}
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              1 · What to send
            </h2>
            <div className="mb-3 grid grid-cols-2 gap-1 rounded-md border border-border bg-background p-1">
              {(["token", "nft"] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setAssetKind(k)}
                  className={`rounded px-2 py-1 text-sm font-medium ${
                    assetKind === k
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {k === "token" ? "Token" : "NFTs"}
                </button>
              ))}
            </div>
            {isNft ? (
              <div className="space-y-3">
                {!actor ? (
                  <p className="text-xs text-muted-foreground">
                    Connect your wallet to load the NFTs you own.
                  </p>
                ) : (
                  <>
                    <div>
                      <span className="mb-1 block text-xs text-muted-foreground">
                        Your collections
                        {nftLoading === "collections" && " · loading…"}
                      </span>
                      <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
                        {nftCollections.map((c) => (
                          <button
                            key={c.collection}
                            onClick={() => setNftCollection(c.collection)}
                            className={`rounded border px-2 py-0.5 font-mono text-xs ${
                              c.collection === nftCollection
                                ? "border-primary bg-primary/10 text-primary"
                                : "border-border bg-background text-muted-foreground hover:text-foreground"
                            }`}
                            title={c.name}
                          >
                            {c.collection} ({c.assets})
                          </button>
                        ))}
                        {nftCollections.length === 0 && nftLoading === null && (
                          <span className="text-xs text-muted-foreground">
                            No NFTs found in this account.
                          </span>
                        )}
                      </div>
                    </div>
                    {nftCollection && (
                      <label className="block">
                        <span className="mb-1 block text-xs text-muted-foreground">
                          Template to airdrop (1 NFT per recipient)
                          {nftLoading === "templates" && " · loading…"}
                        </span>
                        <select
                          value={nftTemplateId ?? ""}
                          onChange={(e) =>
                            setNftTemplateId(e.target.value ? Number(e.target.value) : null)
                          }
                          className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm text-foreground"
                        >
                          <option value="">Select a template…</option>
                          {nftTemplates.map((t) => (
                            <option key={t.templateId} value={t.templateId}>
                              {t.name} · #{t.templateId} · own {t.count}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {nftTemplateId !== null && (
                      <p className="text-xs text-primary">
                        {nftLoading === "assets"
                          ? "Loading your NFTs…"
                          : `✓ ${nftPool.length.toLocaleString()} NFT${nftPool.length === 1 ? "" : "s"} available to drop`}
                      </p>
                    )}
                    {nftError && <p className="text-xs text-destructive">{nftError}</p>}
                  </>
                )}
              </div>
            ) : (
              <>
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
              </>
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
            {isNft ? (
              <p className="mb-3 rounded-md border border-border bg-background p-2 text-xs text-muted-foreground">
                Each selected recipient receives exactly 1 NFT of the chosen template, assigned in
                inventory order (lowest asset id first).
              </p>
            ) : (
              <>
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
              </>
            )}

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

            {/* CHEESE resource cost estimate + live prices */}
            <div className="mb-4 rounded-md border border-border bg-secondary/40 p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Resource cost in {CHEESE_SYMBOL} (estimate)
              </p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-xs text-muted-foreground">CPU/NET for this drop</dt>
                  <dd className="text-foreground">
                    {estCpuCheese !== null
                      ? `~${formatCheese(estCpuCheese)} ${CHEESE_SYMBOL}`
                      : "unavailable"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">RAM for this drop</dt>
                  <dd className="text-foreground">
                    {estRamCheese !== null
                      ? `~${formatCheese(estRamCheese)} ${CHEESE_SYMBOL}`
                      : "unavailable"}
                  </dd>
                  <dd className="text-xs text-muted-foreground">
                    {rowCheckLoading
                      ? "checking existing token rows…"
                      : rowStats.complete
                        ? `${estimate.maxNewRows} of ${recipients.length} need a new row (${((estimate.maxNewRows * RAM_BYTES_PER_ROW) / 1024).toFixed(2)} KB)`
                        : `upper bound: assumes all ${recipients.length} need a new row`}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">CPU price</dt>
                  <dd className="text-foreground">
                    {cheesePerCpuMs !== null
                      ? `${formatCheese(cheesePerCpuMs)} ${CHEESE_SYMBOL} / ms`
                      : "unavailable"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">RAM price</dt>
                  <dd className="text-foreground">
                    {cheesePerRamKb !== null
                      ? `${formatCheese(cheesePerRamKb)} ${CHEESE_SYMBOL} / KB`
                      : "unavailable"}
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-xs text-foreground">
                RAM purchase (required):{" "}
                {requiredRamCheese !== null
                  ? `${formatCheese(requiredRamCheese)} ${CHEESE_SYMBOL}`
                  : "unavailable"}{" "}
                — every airdrop buys at least {formatCheese(MIN_RAM_PURCHASE_CHEESE)}{" "}
                {CHEESE_SYMBOL} of RAM. Don't worry the excess RAM stays in your account
                and can be sold again afterwards.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                CPU/NET is topped up only if you are short
                {suggestedCpuCheese !== null
                  ? ` — about ${formatCheese(suggestedCpuCheese)} ${CHEESE_SYMBOL} right now.`
                  : " — your account currently has enough CPU and NET."}
                {requiredRamCheese !== null
                  ? ` Total to sign: ~${formatCheese(requiredRamCheese + (suggestedCpuCheese ?? 0))} ${CHEESE_SYMBOL}.`
                  : ""}
                {cheeseBalance !== null
                  ? ` Your balance: ${formatCheese(cheeseBalance)} ${CHEESE_SYMBOL}.`
                  : ""}
              </p>
            </div>

            {runError && <p className="mb-3 text-xs text-destructive">✕ {runError}</p>}

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
                Every airdrop starts with a RAM purchase of at least{" "}
                {formatCheese(MIN_RAM_PURCHASE_CHEESE)} {CHEESE_SYMBOL} (kept by your account, and
                sellable afterwards). CPU and NET are topped up with {CHEESE_SYMBOL} only when
                needed. You will be asked to sign these purchases before the first batch.
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
