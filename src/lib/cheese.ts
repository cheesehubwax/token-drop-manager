/**
 * CHEESE resource-purchase constants.
 * Single audit point for the contracts, token and memo formats used to buy
 * CPU/NET and RAM with CHEESE. Verified against live WAX mainnet traffic.
 */

/** CHEESE token contract and symbol. */
export const CHEESE_CONTRACT = "cheeseburger";
export const CHEESE_SYMBOL = "CHEESE";
export const CHEESE_PRECISION = 4;

/** CPU/NET powerup contract — pays for an eosio powerup with CHEESE. */
export const CHEESE_CPU_CONTRACT = "cheesepowerz";
/** RAM purchase contract — buys RAM with CHEESE. */
export const CHEESE_RAM_CONTRACT = "ram.chz";

/** Default CPU/NET split for a powerup. */
export const DEFAULT_CPU_PERCENT = 80;

/**
 * Minimum CHEESE spent on RAM for every airdrop. The RAM stays in the
 * dropper's account (and can be sold again afterwards); this minimum is the
 * tool's fee. Larger amounts are bought when the drop needs more.
 */
export const MIN_RAM_PURCHASE_CHEESE = 10;


/**
 * Memo for a CPU/NET powerup.
 * `<account>` uses the contract default split; `cpu:<n>,net:<m>:<account>`
 * sets an explicit split. Both formats are accepted by cheesepowerz.
 */
export function powerupMemo(account: string, cpuPercent?: number): string {
  if (cpuPercent === undefined) return account;
  const cpu = Math.max(0, Math.min(100, Math.round(cpuPercent)));
  return `cpu:${cpu},net:${100 - cpu}:${account}`;
}

/** Memo for a RAM purchase. Empty means "RAM for the sender". */
export function ramMemo(account: string, self: boolean): string {
  return self ? "" : account;
}

/** Explorer link for a transaction id. */
export function txLink(txId: string): string {
  return `https://waxblock.io/transaction/${txId}`;
}
