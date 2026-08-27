# WAX Airdrop Tool — v1

A single-page tool for airdropping a WAX token to holders of another token or NFT collection, signed in the browser with WAX Cloud Wallet or Anchor. No keys ever leave the user's wallet.

## What the user does

1. Connect wallet (WAX Cloud Wallet or Anchor).
2. Pick the token to send: contract + symbol (balances for the connected account are listed automatically, and a custom contract/symbol can be typed in).
3. Choose the snapshot source:
   - Token holders: contract + symbol
   - NFT holders: AtomicAssets collection, optionally narrowed by schema or template
4. Load the holder list. Every holder is selected by default; each row shows account, balance (or NFT count), and the amount they'll receive.
5. Choose distribution: equal split of a total, fixed amount each, or pro-rata by holdings.
6. Filter and tune: minimum balance threshold, max recipients, exclude list (own account and common contracts excluded by default), deselect any row.
7. Review the summary: recipient count, total sent, per-transaction batching, and estimated CPU/NET/RAM cost against the account's current resources.
8. Press Airdrop. Transactions are signed and broadcast in batches, with live per-batch status, transaction IDs, retry of failed batches, and a downloadable CSV report.

## Resource and cost handling

- Read the sender's CPU/NET/RAM from the chain and show headroom before sending.
- Batch transfers (default ~15 actions per transaction, adjustable) so each transaction stays within CPU limits.
- Warn when: estimated CPU exceeds available, recipients have no matching token row (the sender pays RAM to create it), or the token balance is below the total.
- Estimate and display RAM cost for new recipient balance rows, priced from `rammarket`.
- Sequential batch sending with a small delay so blocks are not overrun.

## Correctness details

- Snapshot is paginated across all holders (no truncation) and timestamped so the list is reproducible.
- Amounts are computed in integer base units using the token's real precision; pro-rata remainders are distributed largest-remainder so the total sent matches the total entered exactly.
- Zero-amount recipients are dropped automatically.
- Memo field is user-set, per airdrop.
- Duplicate accounts merged; invalid/blacklisted account names filtered.

## Out of scope for v1

Scheduled/later airdrops (no backend, no stored keys). The UI is structured so scheduling can be added later.

## Technical notes

- New route at `/` replacing the placeholder, plus a dedicated head() with airdrop-specific title/description/OG tags.
- Wallet: `@wharfkit/session` with `@wharfkit/wallet-plugin-cloudwallet` and `@wharfkit/wallet-plugin-anchor`; session restored on load, client-side only (wallet code loaded after hydration so SSR is untouched).
- Chain reads via a `createServerFn` proxy so RPC/API endpoints and rate limits are server-side:
  - token holders: Hyperion `/v2/state/get_token_holders` with a `get_table_by_scope` fallback
  - NFT holders: AtomicAssets API `/atomicassets/v1/accounts`
  - token metadata (`stat`), sender balances, account resources, `rammarket`
  - endpoint failover across public WAX nodes
- Signing and broadcasting happen entirely in the browser from the WharfKit session; the server never touches transactions.
- Design: dark, technical "control panel" aesthetic with monospace numerics — semantic tokens in `src/styles.css`, no hardcoded colors.
