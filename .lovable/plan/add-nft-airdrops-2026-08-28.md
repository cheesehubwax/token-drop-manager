# Add NFT airdrops

Extend the tool so a drop can send NFTs from your own inventory instead of a token, reusing the existing holder snapshot, selection, batching, and automatic CHEESE resource handling.

## What you'll see

**Section 1 becomes "What to send"** with a Token / NFTs toggle.

In NFTs mode:
- Your wallet's AtomicAssets inventory loads after connecting (collection, schema, template, name, count).
- Pick one collection, then one template — that template's assets in your wallet are the pool.
- A live pool counter: "142 NFTs of this template in your wallet".

**Section 3 (Distribution) in NFT mode** replaces the token amount with a fixed rule: every recipient gets exactly one NFT of the chosen template, assigned in inventory order. Memo works exactly as today. (Multiple NFTs per person and randomized assignment can come later.)

**Pool must cover everyone.** If you hold fewer NFTs of that template than there are selected recipients, the Airdrop button stays disabled with a clear message telling you how many NFTs short you are, so you can deselect recipients or pick another template. Nothing is ever partially sent.

**Sections 2, 4, 5 unchanged**: same holder sources (token holders or NFT collection holders), Top 10/50/100, exclusions, min-weight filter, summary, CHEESE cost lines, and the required 10 CHEESE minimum RAM purchase before the first batch.

**Assignment preview** in the recipients list: each selected account shows the asset ID it will receive, and the CSV report gains an `asset_id` column.


## Technical notes

Chain layer (`src/lib/chain.server.ts` + `src/lib/chain.functions.ts`)
- `getInventoryAssets(account, { collection?, schema?, templateId? })` — paginates `/atomicassets/v1/assets?owner=...` through the existing `ATOMIC_ENDPOINTS` failover helper, returning `{ assetId, collection, schema, templateId, name }[]` plus a truncation flag.
- `getInventoryCollections(account)` — derived from `/atomicassets/v1/accounts/{account}` for the collection/schema/template dropdowns.
- Exposed as `fetchInventoryAssets` / `fetchInventoryCollections` server functions with Zod validation, matching the existing pattern.

Allocation (`src/lib/airdrop.ts`)
- New `assignAssets(pool, accounts)` returning `{ account, assetId }[]` and a `shortfall` count — one asset per account, taken in pool order.
- `estimateResources` gains an NFT branch: one `atomicassets::transfer` action per recipient, conservative per-asset CPU/NET constants, and RAM sized per transferred asset instead of per token balance row. The existing token-row lookup is skipped in NFT mode.


Wallet (`src/lib/wallet.ts`)
- `transactNftTransfers(session, groups)` builds `atomicassets::transfer` actions with `{ from, to, asset_ids, memo }`, one action per recipient, batched by the existing batch-size control. Same signing, transaction-link, and retry surface as token transfers.

Page (`src/routes/index.tsx`)
- New `assetKind: "token" | "nft"` state driving sections 1 and 3; token path untouched.
- NFT pool/filter/assignment state, `canRun` extended with the pool-coverage rule, `runAirdrop` branching to the NFT transfer path after the same CHEESE resource step.

No smart contract, no schema changes, no scheduling.
