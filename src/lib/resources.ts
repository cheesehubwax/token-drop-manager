/**
 * Pure CHEESE ⇄ resource math. No network, no browser APIs.
 * Every figure produced here is an estimate: on-chain prices move between the
 * quote and the transaction, so purchases apply a safety margin and the UI
 * labels the numbers as approximate.
 */

import { CHEESE_PRECISION } from "./cheese";

export interface RamPricing {
  /** ram.chz buying enabled flag. */
  enabled: boolean;
  /** Per-purchase CHEESE limits enforced by the contract. */
  minCheese: number;
  maxCheese: number;
  /** Current WAX cost of one byte from the eosio RAM market. */
  waxPerByte: number;
  /** Spread/slippage/buffer basis points the contract keeps on a buy. */
  feeBps: number;
  /** Lifetime bytes-per-CHEESE from contract stats, for sanity display. */
  historicalBytesPerCheese: number | null;
}

export interface PowerupPricing {
  /** WAX price to power up 100% of chain weight for the powerup window. */
  cpuPriceWaxPerFullWeight: number;
  netPriceWaxPerFullWeight: number;
  /** Chain-wide powerup weight units (1e-8 WAX equivalents). */
  cpuWeightUnits: number;
  netWeightUnits: number;
  /** Powerup duration in days. */
  powerupDays: number;
}

export interface ResourcePricing {
  /** WAX per 1 CHEESE. */
  waxPerCheese: number;
  priceSource: "pool" | "reference";
  ram: RamPricing;
  powerup: PowerupPricing | null;
}

/** Calibration from the connected account: how much CPU/NET one weight unit buys. */
export interface WeightCalibration {
  /** Microseconds of CPU per weight unit. */
  cpuUsPerWeightUnit: number | null;
  /** NET bytes per weight unit. */
  netBytesPerWeightUnit: number | null;
}

/** Buy a bit more than strictly needed — prices and CPU decay move. */
export const RAM_MARGIN = 1.1;
export const CPU_MARGIN = 1.25;

export function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/** Round up to the CHEESE precision so a purchase never falls short. */
export function ceilCheese(value: number): number {
  const f = 10 ** CHEESE_PRECISION;
  return Math.ceil(value * f - 1e-9) / f;
}

export function formatCheese(value: number): string {
  return value.toFixed(CHEESE_PRECISION);
}

/** Derive the CPU/NET-per-weight-unit calibration from the account's own stake. */
export function weightCalibration(resources: {
  cpuMaxUs: number;
  netMaxBytes: number;
  cpuWeightUnits: number;
  netWeightUnits: number;
}): WeightCalibration {
  return {
    cpuUsPerWeightUnit:
      resources.cpuWeightUnits > 0 && resources.cpuMaxUs > 0
        ? resources.cpuMaxUs / resources.cpuWeightUnits
        : null,
    netBytesPerWeightUnit:
      resources.netWeightUnits > 0 && resources.netMaxBytes > 0
        ? resources.netMaxBytes / resources.netWeightUnits
        : null,
  };
}

// ---------------------------------------------------------------------------
// RAM
// ---------------------------------------------------------------------------

/** Bytes received per CHEESE, after contract spread/slippage. Null if unpriceable. */
export function bytesPerCheese(p: ResourcePricing): number | null {
  if (p.ram.waxPerByte <= 0 || p.waxPerCheese <= 0) return null;
  const gross = p.waxPerCheese / p.ram.waxPerByte;
  return gross * (1 - Math.min(0.5, Math.max(0, p.ram.feeBps / 10_000)));
}

/** CHEESE needed for a number of bytes, with margin, rounded up to precision. */
export function cheeseForBytes(bytes: number, p: ResourcePricing): number | null {
  const per = bytesPerCheese(p);
  if (!per || bytes <= 0) return null;
  return ceilCheese((bytes / per) * RAM_MARGIN);
}

// ---------------------------------------------------------------------------
// CPU / NET powerup
// ---------------------------------------------------------------------------

/** Microseconds of CPU expected from one CHEESE at the given CPU split. */
export function cpuUsPerCheese(
  p: ResourcePricing,
  calib: WeightCalibration,
  cpuPercent: number,
): number | null {
  const pu = p.powerup;
  if (!pu || calib.cpuUsPerWeightUnit === null) return null;
  if (pu.cpuPriceWaxPerFullWeight <= 0 || pu.cpuWeightUnits <= 0 || p.waxPerCheese <= 0) return null;
  const waxForCpu = p.waxPerCheese * (Math.max(0, Math.min(100, cpuPercent)) / 100);
  const fraction = waxForCpu / pu.cpuPriceWaxPerFullWeight;
  return fraction * pu.cpuWeightUnits * calib.cpuUsPerWeightUnit;
}

/** NET bytes expected from one CHEESE at the given CPU split (rest goes to NET). */
export function netBytesPerCheese(
  p: ResourcePricing,
  calib: WeightCalibration,
  cpuPercent: number,
): number | null {
  const pu = p.powerup;
  if (!pu || calib.netBytesPerWeightUnit === null) return null;
  if (pu.netPriceWaxPerFullWeight <= 0 || pu.netWeightUnits <= 0 || p.waxPerCheese <= 0) return null;
  const waxForNet = p.waxPerCheese * (1 - Math.max(0, Math.min(100, cpuPercent)) / 100);
  const fraction = waxForNet / pu.netPriceWaxPerFullWeight;
  return fraction * pu.netWeightUnits * calib.netBytesPerWeightUnit;
}

/** CHEESE needed to add a number of CPU microseconds, with margin. */
export function cheeseForCpuUs(
  us: number,
  p: ResourcePricing,
  calib: WeightCalibration,
  cpuPercent: number,
): number | null {
  const per = cpuUsPerCheese(p, calib, cpuPercent);
  if (!per || per <= 0 || us <= 0) return null;
  return ceilCheese((us / per) * CPU_MARGIN);
}

// ---------------------------------------------------------------------------
// Purchase splitting
// ---------------------------------------------------------------------------

/**
 * Split a CHEESE amount into purchases that respect the contract's per-transfer
 * min/max. Amounts below the minimum are raised to it (the contract rejects
 * anything smaller). Returns [] for non-positive input.
 */
export function splitPurchases(total: number, minCheese: number, maxCheese: number): number[] {
  if (!(total > 0)) return [];
  const max = maxCheese > 0 ? maxCheese : total;
  const min = minCheese > 0 ? minCheese : 0;
  let remaining = ceilCheese(Math.max(total, min));
  const out: number[] = [];
  while (remaining > 0 && out.length < 50) {
    let take = Math.min(remaining, max);
    const rest = ceilCheese(remaining - take);
    // Avoid leaving a final slice below the contract minimum.
    if (rest > 0 && rest < min) {
      take = ceilCheese(Math.max(min, remaining - max + (min - rest)));
      if (take > max) take = max;
    }
    take = ceilCheese(Math.max(take, Math.min(min, remaining)));
    out.push(take);
    remaining = ceilCheese(remaining - take);
    if (remaining > 0 && remaining < min) {
      out.push(min);
      remaining = 0;
    }
  }
  return out;
}

/** Total of a purchase plan. */
export function planTotal(plan: number[]): number {
  return round(
    plan.reduce((s, x) => s + x, 0),
    CHEESE_PRECISION,
  );
}
