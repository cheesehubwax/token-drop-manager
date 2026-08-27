/**
 * Server-side WAX chain readers with endpoint failover.
 * All functions are plain async helpers — call them from createServerFn handlers only.
 */

export const CHAIN_ENDPOINTS = [
  "https://wax.greymass.com",
  "https://wax.eosphere.io",
  "https://wax.eosusa.io",
  "https://api.wax.alohaeos.com",
];

export const HYPERION_ENDPOINTS = [
  "https://api.waxsweden.org",
  "https://wax.eosphere.io",
  "https://wax.eosusa.io",
  "https://hyperion-wax-mainnet.wecan.dev",
];

export const ATOMIC_ENDPOINTS = [
  "https://wax.api.atomicassets.io",
  "https://atomic3.hivebp.io",
  "https://aa-wax-public1.neftyblocks.com",
  "https://aa.dapplica.io",
];

const FETCH_TIMEOUT_MS = 15_000;
/** AtomicAssets holder queries can be slow on first touch — allow longer. */
const AA_TIMEOUT_MS = 30_000;

async function fetchJson(url: string, init?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Try each endpoint in order until one succeeds. Returns [result, endpointUsed]. */
async function withFailover<T>(
  endpoints: string[],
  fn: (base: string) => Promise<T>,
): Promise<[T, string]> {
  let lastError: unknown = new Error("No endpoints configured");
  for (const base of endpoints) {
    try {
      return [await fn(base), base];
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function chainPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const [result] = await withFailover(CHAIN_ENDPOINTS, (base) =>
    fetchJson(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return result as T;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Holder {
  account: string;
  /** Whole-token balance as float for weighting (tokens), or asset count (NFTs). */
  weight: number;
  /** Formatted balance as reported (e.g. "123.4567 TOKEN") or asset count as string. */
  raw: string;
}

export interface HolderSnapshot {
  holders: Holder[];
  truncated: boolean;
  source: "hyperion" | "atomicassets" | "chain-fallback";
  /** False when balances are unknown (fallback path) — pro-rata unavailable. */
  hasBalances: boolean;
}

export interface TokenStat {
  supply: string;
  maxSupply: string;
  precision: number;
  symbol: string;
}

export interface WalletToken {
  contract: string;
  symbol: string;
  amount: number;
  precision: number;
}

export interface AccountResources {
  account: string;
  cpuUsedUs: number;
  cpuAvailableUs: number;
  cpuMaxUs: number;
  netUsedBytes: number;
  netAvailableBytes: number;
  netMaxBytes: number;
  ramUsedBytes: number;
  ramQuotaBytes: number;
  ramAvailableBytes: number;
  refundCpuUs: number;
  refundNetBytes: number;
}

export interface RamPrice {
  waxPerKb: number;
  /** WAX cost to open one token balance row (~276 bytes). */
  waxPerNewRow: number;
}

// ---------------------------------------------------------------------------
// Token holders (Hyperion, paginated, with get_table_by_scope fallback)
// ---------------------------------------------------------------------------

const HYPERION_PAGE = 1000;
const MAX_HOLDERS = 20_000;

interface HyperionHoldersResponse {
  holders?: Array<{ account?: string; amount?: number; balance?: string }>;
  total?: number;
}

export async function getTokenHolders(code: string, symbol: string): Promise<HolderSnapshot> {
  try {
    const [holders, source] = await fetchHyperionHolders(code, symbol);
    return { holders, truncated: holders.length >= MAX_HOLDERS, source, hasBalances: true };
  } catch {
    // Hyperion unavailable everywhere — fall back to scope listing (no balances).
    const holders = await fetchScopeHolders(code);
    return { holders, truncated: holders.length >= MAX_HOLDERS, source: "chain-fallback", hasBalances: false };
  }
}

async function fetchHyperionHolders(code: string, symbol: string): Promise<[Holder[], "hyperion"]> {
  const [result] = await withFailover(HYPERION_ENDPOINTS, async (base) => {
    const out: Holder[] = [];
    for (let skip = 0; skip < MAX_HOLDERS; skip += HYPERION_PAGE) {
      const url =
        `${base}/v2/state/get_token_holders?code=${encodeURIComponent(code)}` +
        `&symbol=${encodeURIComponent(symbol)}&limit=${HYPERION_PAGE}&skip=${skip}`;
      const data = (await fetchJson(url)) as HyperionHoldersResponse;
      const page = data.holders ?? [];
      if (page.length === 0) break;
      for (const h of page) {
        const account = h.account ?? "";
        const amount = typeof h.amount === "number" ? h.amount : parseFloat(h.balance ?? "0");
        if (account && amount > 0) {
          out.push({ account, weight: amount, raw: h.balance ?? String(amount) });
        }
      }
      if (page.length < HYPERION_PAGE) break;
    }
    if (out.length === 0) throw new Error(`No holders of ${symbol}@${code} found`);
    return out;
  });
  return [result, "hyperion"];
}

async function fetchScopeHolders(code: string): Promise<Holder[]> {
  const holders: Holder[] = [];
  let lower = "";
  while (holders.length < MAX_HOLDERS) {
    const data = await chainPost<{
      rows?: Array<{ scope?: string; balance?: string }>;
      more?: string | boolean;
    }>("/v1/chain/get_table_by_scope", {
      code,
      table: "accounts",
      lower_bound: lower,
      limit: 1000,
    });
    const rows = data.rows ?? [];
    if (rows.length === 0) break;
    for (const row of rows) {
      const account = row.scope ?? "";
      const amount = parseFloat(row.balance ?? "0");
      if (account && amount > 0) holders.push({ account, weight: amount, raw: row.balance ?? "0" });
    }
    const more = data.more;
    if (!more || typeof more !== "string") break;
    lower = more;
  }
  if (holders.length === 0) throw new Error(`No holders found for ${code}`);
  // Scopes give balances per row on most nodes; treat as having balances if raw parsed.
  return holders;
}

// ---------------------------------------------------------------------------
// NFT holders (AtomicAssets, paginated)
// ---------------------------------------------------------------------------

const AA_PAGE = 1000;

interface AaAccountsResponse {
  success?: boolean;
  data?: Array<{ account?: string; assets?: string }>;
}

export async function getNftHolders(
  collection: string,
  schema?: string,
  templateId?: number,
): Promise<HolderSnapshot> {
  const [holders] = await withFailover(ATOMIC_ENDPOINTS, async (base) => {
    const out: Holder[] = [];
    for (let page = 1; ; page++) {
      const params = new URLSearchParams({
        collection_name: collection,
        page: String(page),
        limit: String(AA_PAGE),
      });
      if (schema) params.set("schema_name", schema);
      if (templateId !== undefined) params.set("template_id", String(templateId));
      const data = (await fetchJson(
        `${base}/atomicassets/v1/accounts?${params}`,
        undefined,
        AA_TIMEOUT_MS,
      )) as AaAccountsResponse;
      const rows = data.data ?? [];
      if (rows.length === 0) break;
      for (const r of rows) {
        const account = r.account ?? "";
        const assets = parseInt(r.assets ?? "0", 10);
        if (account && assets > 0) out.push({ account, weight: assets, raw: String(assets) });
      }
      if (rows.length < AA_PAGE || out.length >= MAX_HOLDERS) break;
    }
    if (out.length === 0) throw new Error(`No holders found for collection ${collection}`);
    return out;
  });
  return { holders, truncated: holders.length >= MAX_HOLDERS, source: "atomicassets", hasBalances: true };
}

// ---------------------------------------------------------------------------
// Token stat, balances, account resources, RAM price
// ---------------------------------------------------------------------------

export async function getTokenStat(code: string, symbol: string): Promise<TokenStat> {
  const data = await chainPost<{ rows?: Array<{ supply?: string; max_supply?: string }> }>(
    "/v1/chain/get_table_rows",
    { code, scope: symbol, table: "stat", json: true, limit: 1 },
  );
  const stat = data.rows?.[0];
  if (!stat?.supply) throw new Error(`Token ${symbol} not found on contract ${code}`);
  const amountPart = stat.supply.split(" ")[0] ?? "0";
  const precision = amountPart.includes(".") ? (amountPart.split(".")[1] ?? "").length : 0;
  return { supply: stat.supply, maxSupply: stat.max_supply ?? "", precision, symbol };
}

interface HyperionTokensResponse {
  tokens?: Array<{ symbol?: string; contract?: string; amount?: number; precision?: number }>;
}

export async function getWalletTokens(account: string): Promise<WalletToken[]> {
  try {
    const [tokens] = await withFailover(HYPERION_ENDPOINTS, async (base) => {
      const data = (await fetchJson(
        `${base}/v2/state/get_tokens?account=${encodeURIComponent(account)}&limit=500`,
      )) as HyperionTokensResponse;
      return (data.tokens ?? [])
        .filter((t) => t.symbol && t.contract && typeof t.amount === "number")
        .map((t) => ({
          contract: t.contract as string,
          symbol: t.symbol as string,
          amount: t.amount as number,
          precision: t.precision ?? 4,
        }));
    });
    if (tokens.length > 0) return tokens;
  } catch {
    // fall through to core balance
  }
  const balances = await chainPost<string[]>("/v1/chain/get_currency_balance", {
    code: "eosio.token",
    account,
  });
  return balances.map((b) => {
    const parts = b.split(" ");
    const amountStr = parts[0] ?? "0";
    const symbol = parts[1] ?? "WAX";
    const precision = amountStr.includes(".") ? (amountStr.split(".")[1] ?? "").length : 0;
    return { contract: "eosio.token", symbol, amount: parseFloat(amountStr), precision };
  });
}

export async function getAccountResources(account: string): Promise<AccountResources> {
  const data = await chainPost<{
    cpu_limit?: { used?: number; available?: number; max?: number };
    net_limit?: { used?: number; available?: number; max?: number };
    ram_usage?: number;
    ram_quota?: number;
    refund_request?: { cpu_amount?: string; net_amount?: string };
  }>("/v1/chain/get_account", { account_name: account });

  const cpu = data.cpu_limit ?? {};
  const net = data.net_limit ?? {};
  const ramQuota = data.ram_quota ?? 0;
  const ramUsed = data.ram_usage ?? 0;
  const refund = data.refund_request ?? {};
  return {
    account,
    cpuUsedUs: cpu.used ?? 0,
    cpuAvailableUs: cpu.available ?? 0,
    cpuMaxUs: cpu.max ?? 0,
    netUsedBytes: net.used ?? 0,
    netAvailableBytes: net.available ?? 0,
    netMaxBytes: net.max ?? 0,
    ramUsedBytes: ramUsed,
    ramQuotaBytes: ramQuota,
    ramAvailableBytes: Math.max(0, ramQuota - ramUsed),
    refundCpuUs: 0,
    refundNetBytes: 0,
    ...(refund.cpu_amount ? {} : {}),
  };
}

export async function getRamPrice(): Promise<RamPrice> {
  const data = await chainPost<{
    rows?: Array<{ base?: { balance?: string }; quote?: { balance?: string } }>;
  }>("/v1/chain/get_table_rows", {
    code: "eosio",
    scope: "eosio",
    table: "rammarket",
    json: true,
    limit: 1,
  });
  const row = data.rows?.[0];
  const base = parseFloat(row?.base?.balance ?? "0"); // RAMCORE
  const quote = parseFloat(row?.quote?.balance ?? "0"); // WAX
  if (!base || !quote) throw new Error("Could not read RAM market");
  const waxPerByte = quote / base;
  return { waxPerKb: waxPerByte * 1024, waxPerNewRow: waxPerByte * 276 };
}
