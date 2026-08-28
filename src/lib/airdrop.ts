/** Pure airdrop math: integer base-unit amounts, batching, cost estimates. */

export type DistributionMode = "equal" | "fixed" | "prorata";

export interface AirdropRecipient {
  account: string;
  weight: number;
  /** Integer base units (10^precision scaled). */
  units: bigint;
}

/** Format integer base units as a chain-ready quantity string, e.g. 12345n,4 -> "1.2345 WAX". */
export function formatQuantity(units: bigint, precision: number, symbol: string): string {
  const base = 10n ** BigInt(precision);
  const whole = units / base;
  const frac = (units % base).toString().padStart(precision, "0");
  return precision > 0 ? `${whole}.${frac} ${symbol}` : `${whole} ${symbol}`;
}

export function formatUnits(units: bigint, precision: number): string {
  const base = 10n ** BigInt(precision);
  const whole = units / base;
  const frac = (units % base).toString().padStart(precision, "0");
  return precision > 0 ? `${whole}.${frac}` : `${whole}`;
}

/** Parse a decimal string into integer base units. Throws on malformed input. */
export function parseUnits(text: string, precision: number): bigint {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Invalid amount: ${text}`);
  const parts = trimmed.split(".");
  const whole = parts[0] ?? "0";
  const frac = parts[1] ?? "";
  if (frac.length > precision) throw new Error(`Too many decimals (max ${precision})`);
  return BigInt(whole) * 10n ** BigInt(precision) + BigInt(frac.padEnd(precision, "0") || "0");
}

/**
 * Compute per-recipient amounts with largest-remainder rounding so the
 * distributed total matches the entered total exactly (equal / prorata).
 * Recipients whose computed amount is zero are dropped.
 */
export function computeAmounts(
  holders: Array<{ account: string; weight: number }>,
  mode: DistributionMode,
  amountText: string,
  precision: number,
): AirdropRecipient[] {
  if (holders.length === 0) return [];

  if (mode === "fixed") {
    const each = parseUnits(amountText, precision);
    if (each <= 0n) throw new Error("Amount per holder must be greater than zero");
    return holders.map((h) => ({ account: h.account, weight: h.weight, units: each }));
  }

  const total = parseUnits(amountText, precision);
  if (total <= 0n) throw new Error("Total amount must be greater than zero");

  const n = BigInt(holders.length);
  // Exact rational shares: share_i = total * num_i / den.
  // equal -> num_i = 1, den = n. prorata -> num_i = weight_i scaled, den = sum.
  const SCALE = 1_000_000n;
  let shares: Array<{ account: string; weight: number; num: bigint }> = [];
  let den: bigint;
  if (mode === "equal") {
    den = n;
    shares = holders.map((h) => ({ account: h.account, weight: h.weight, num: 1n }));
  } else {
    const totalWeight = holders.reduce((s, h) => s + h.weight, 0);
    if (totalWeight <= 0) throw new Error("Holder weights sum to zero");
    den = SCALE;
    shares = holders.map((h) => ({
      account: h.account,
      weight: h.weight,
      num: BigInt(Math.round((h.weight / totalWeight) * Number(SCALE))),
    }));
    // Ensure numerators sum to the denominator for exact conservation.
    const numSum = shares.reduce((s, x) => s + x.num, 0n);
    const drift = den - numSum;
    if (drift !== 0n) {
      // apply drift to the largest holder
      const maxIdx = shares.reduce((mi, x, i, a) => (x.weight > (a[mi]?.weight ?? 0) ? i : mi), 0);
      const target = shares[maxIdx];
      if (target) target.num += drift;
    }
  }

  // Largest remainder allocation in base units.
  const alloc = shares.map((s) => {
    const exact = total * s.num;
    const floor = exact / den;
    return { account: s.account, weight: s.weight, floor, rem: exact - floor * den };
  });
  let remainder = total - alloc.reduce((s, a) => s + a.floor, 0n);
  const byRem = [...alloc].sort((a, b) => {
    if (a.rem === b.rem) return b.weight - a.weight;
    return a.rem > b.rem ? -1 : 1;
  });
  for (const a of byRem) {
    if (remainder <= 0n) break;
    a.floor += 1n;
    remainder -= 1n;
  }
  return alloc
    .filter((a) => a.floor > 0n)
    .map((a) => ({ account: a.account, weight: a.weight, units: a.floor }));
}

export function totalUnits(recipients: AirdropRecipient[]): bigint {
  return recipients.reduce((s, r) => s + r.units, 0n);
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Cost estimates
// ---------------------------------------------------------------------------

export interface ResourceEstimate {
  /** Estimated CPU per transaction in microseconds. */
  cpuPerTxUs: number;
  /** Estimated NET per transaction in bytes. */
  netPerTxBytes: number;
  /** Estimated total CPU for all batches. */
  totalCpuUs: number;
  /** Worst-case new RAM rows (recipients who may not hold the token yet). */
  maxNewRows: number;
  /** WAX cost if every recipient needs a new balance row. */
  maxRamCostWax: number;
  txCount: number;
}

const CPU_US_PER_TRANSFER = 1800; // ~1.8ms per transfer action, conservative
const CPU_US_TX_OVERHEAD = 900;
const NET_BYTES_PER_TRANSFER = 160;
const NET_BYTES_TX_OVERHEAD = 220;

export function estimateResources(
  recipientCount: number,
  batchSize: number,
  waxPerNewRow: number,
  /**
   * Recipients that actually need a new balance row. Omit (or pass null) while
   * the on-chain check is pending to keep the conservative worst case.
   */
  newRowCount?: number | null,
): ResourceEstimate {
  const txCount = Math.max(1, Math.ceil(recipientCount / batchSize));
  const cpuPerTxUs = batchSize * CPU_US_PER_TRANSFER + CPU_US_TX_OVERHEAD;
  const netPerTxBytes = batchSize * NET_BYTES_PER_TRANSFER + NET_BYTES_TX_OVERHEAD;
  const rows =
    typeof newRowCount === "number"
      ? Math.max(0, Math.min(recipientCount, Math.round(newRowCount)))
      : recipientCount;
  return {
    cpuPerTxUs,
    netPerTxBytes,
    totalCpuUs: cpuPerTxUs * txCount,
    maxNewRows: rows,
    maxRamCostWax: rows * waxPerNewRow,
    txCount,
  };
}

export interface ResourceWarning {
  level: "warn" | "error";
  message: string;
}

export function resourceWarnings(
  est: ResourceEstimate,
  resources: {
    cpuAvailableUs: number;
    netAvailableBytes: number;
    ramAvailableBytes: number;
  } | null,
  senderBalanceUnits: bigint | null,
  neededUnits: bigint,
  precision: number,
  symbol: string,
): ResourceWarning[] {
  const warnings: ResourceWarning[] = [];
  if (senderBalanceUnits !== null && senderBalanceUnits < neededUnits) {
    warnings.push({
      level: "error",
      message: `Balance too low: you need ${formatUnits(neededUnits, precision)} ${symbol} but hold ${formatUnits(senderBalanceUnits, precision)} ${symbol}.`,
    });
  }
  if (resources) {
    if (est.cpuPerTxUs > resources.cpuAvailableUs) {
      warnings.push({
        level: "error",
        message: `Estimated CPU per transaction (~${(est.cpuPerTxUs / 1000).toFixed(1)}ms) exceeds your available CPU (${(resources.cpuAvailableUs / 1000).toFixed(1)}ms). Reduce the batch size or stake more WAX to CPU.`,
      });
    } else if (est.totalCpuUs > resources.cpuAvailableUs * 3) {
      warnings.push({
        level: "warn",
        message: `Total CPU (~${(est.totalCpuUs / 1000).toFixed(0)}ms) is large relative to your available CPU (${(resources.cpuAvailableUs / 1000).toFixed(1)}ms). CPU regenerates between batches, but later batches may need retries.`,
      });
    }
    if (est.netPerTxBytes > resources.netAvailableBytes) {
      warnings.push({
        level: "error",
        message: `Estimated NET per transaction exceeds your available NET. Stake more WAX to NET.`,
      });
    }
    const ramForRows = est.maxNewRows * 276;
    if (ramForRows > resources.ramAvailableBytes) {
      warnings.push({
        level: "warn",
        message: `If every recipient needs a new token row you would pay ~${(ramForRows / 1024).toFixed(1)} KB of RAM (~${est.maxRamCostWax.toFixed(2)} WAX), more than your free RAM (${(resources.ramAvailableBytes / 1024).toFixed(1)} KB). Holders of the token already have rows.`,
      });
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// NFT airdrops (one asset per recipient)
// ---------------------------------------------------------------------------

export interface NftAssignment {
  account: string;
  assetId: string;
}

/**
 * Assign one asset from the pool to each account, in pool order.
 * `shortfall` is how many more assets are needed to cover every account.
 */
export function assignAssets(
  pool: string[],
  accounts: string[],
): { assignments: NftAssignment[]; shortfall: number } {
  const assignments: NftAssignment[] = [];
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const assetId = pool[i];
    if (account === undefined || assetId === undefined) break;
    assignments.push({ account, assetId });
  }
  return { assignments, shortfall: Math.max(0, accounts.length - pool.length) };
}

/** RAM bytes an incoming NFT costs the sender (AtomicAssets asset row, conservative). */
export const RAM_BYTES_PER_NFT = 200;
const CPU_US_PER_NFT_TRANSFER = 2600;
const NET_BYTES_PER_NFT_TRANSFER = 180;

/** Resource estimate for an NFT airdrop: one transfer action per recipient. */
export function estimateNftResources(
  recipientCount: number,
  batchSize: number,
  waxPerKb: number,
): ResourceEstimate {
  const txCount = Math.max(1, Math.ceil(recipientCount / batchSize));
  const cpuPerTxUs = batchSize * CPU_US_PER_NFT_TRANSFER + CPU_US_TX_OVERHEAD;
  const netPerTxBytes = batchSize * NET_BYTES_PER_NFT_TRANSFER + NET_BYTES_TX_OVERHEAD;
  return {
    cpuPerTxUs,
    netPerTxBytes,
    totalCpuUs: cpuPerTxUs * txCount,
    maxNewRows: recipientCount,
    maxRamCostWax: ((recipientCount * RAM_BYTES_PER_NFT) / 1024) * waxPerKb,
    txCount,
  };
}
