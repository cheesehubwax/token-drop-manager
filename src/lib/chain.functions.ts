import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  getAccountResources,
  getCheeseBalance,
  getExistingTokenRows,
  getInventoryAssets,
  getInventoryCollections,
  getInventoryTemplates,
  getNftHolders,
  getRamPrice,
  getResourcePricing,
  getTokenHolders,
  getTokenStat,
  getWalletTokens,
} from "./chain.server";

export const fetchTokenHolders = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        code: z.string().min(1).max(13),
        symbol: z.string().min(1).max(7),
      })
      .parse(input),
  )
  .handler(async ({ data }) => getTokenHolders(data.code, data.symbol));

export const fetchNftHolders = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        collection: z.string().min(1).max(13),
        schema: z.string().max(64).optional(),
        templateId: z.number().int().positive().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => getNftHolders(data.collection, data.schema, data.templateId));

export const fetchTokenStat = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        code: z.string().min(1).max(13),
        symbol: z.string().min(1).max(7),
      })
      .parse(input),
  )
  .handler(async ({ data }) => getTokenStat(data.code, data.symbol));

export const fetchWalletTokens = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ account: z.string().min(1).max(13) }).parse(input))
  .handler(async ({ data }) => getWalletTokens(data.account));

export const fetchAccountResources = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ account: z.string().min(1).max(13) }).parse(input))
  .handler(async ({ data }) => getAccountResources(data.account));

export const fetchRamPrice = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => input)
  .handler(async () => getRamPrice());

export const fetchCheeseBalance = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ account: z.string().min(1).max(13) }).parse(input))
  .handler(async ({ data }) => getCheeseBalance(data.account));

export const fetchResourcePricing = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => input)
  .handler(async () => getResourcePricing());

export const fetchExistingTokenRows = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        code: z.string().min(1).max(13),
        symbol: z.string().min(1).max(7),
        accounts: z.array(z.string().min(1).max(13)).max(5000),
      })
      .parse(input),
  )
  .handler(async ({ data }) => getExistingTokenRows(data.code, data.symbol, data.accounts));

export const fetchInventoryCollections = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ account: z.string().min(1).max(13) }).parse(input))
  .handler(async ({ data }) => getInventoryCollections(data.account));

export const fetchInventoryTemplates = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        account: z.string().min(1).max(13),
        collection: z.string().min(1).max(13),
      })
      .parse(input),
  )
  .handler(async ({ data }) => getInventoryTemplates(data.account, data.collection));

export const fetchInventoryAssets = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        account: z.string().min(1).max(13),
        collection: z.string().min(1).max(13),
        templateId: z.number().int().positive(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => getInventoryAssets(data.account, data.collection, data.templateId));
