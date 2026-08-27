# CHEESE-powered resources for the airdrop tool

Add a Resources panel that buys the CPU/NET and RAM an airdrop needs, paid in CHEESE, through the CHEESE resource contracts only. No other rental provider is used.

## How both purchases actually work (verified on chain)

Both contracts are driven by CHEESE token transfers (`cheeseburger`, `CHEESE`, 4 decimals) — there is no public buy action:

- CPU/NET: transfer CHEESE to `cheesepowerz`.
  - memo `<account>` powers up that account with the contract's default CPU/NET split
  - memo `cpu:80,net:20:<account>` sets an explicit split (both formats seen in live traffic)
- RAM: transfer CHEESE to `ram.chz`.
  - memo empty = RAM for the sender, memo `<account>` = RAM for that account
  - contract config today: min 1.0000, max 100.0000 CHEESE per purchase, buying enabled

Because the purchase happens in its own transaction, it must be signed and confirmed *before* the airdrop batches, not bundled with them.

## What the user sees

A "Resources" section above the Airdrop button, live for the connected account:

- Current CPU (ms), NET (KB), free RAM (bytes) versus the airdrop's estimate, each shown as OK / short by X.
- CHEESE balance of the connected account.
- Two purchase rows, only enabled when the wallet is connected:
  - Buy CPU/NET with CHEESE — CHEESE amount input plus a CPU/NET split (default 80/20), prefilled with a suggested amount when CPU is short.
  - Buy RAM with CHEESE — CHEESE amount input, prefilled with the amount that covers the estimated new token rows, clamped to the contract's min/max.
- Each row shows an estimated return ("≈ X ms CPU" / "≈ Y KB RAM") from live on-chain pricing, clearly labelled as an estimate, plus the min/max limits.
- Buy button signs a single CHEESE transfer through the connected wallet, shows the transaction link, then re-reads resources after a short delay so the panel and warnings update.
- If the requested RAM amount exceeds the contract's max per purchase, it is split into sequential purchases.
- Existing resource warnings gain a "Buy with CHEESE" shortcut that scrolls to and prefills the matching row. An optional "top up resources before sending" checkbox runs the needed purchases first, waits for them to confirm, refreshes resources, then starts the batches. It is off by default and never runs silently.

## Pricing

Quotes are computed server-side and are advisory, never treated as exact:

- CHEESE/WAX price from the Alcor pool referenced by `ram.chz` config (pool 1252, CHEESE/WAX reserves).
- RAM: `eosio` `rammarket` gives WAX per byte; combined with the CHEESE/WAX price and the contract's buy spread/slippage settings to give bytes-per-CHEESE, then a safety margin is applied.
- CPU/NET: derived from the CHEESE→WAX equivalent the powerup contract records in its own stats, applied to the current powerup pricing; shown as an approximate ms figure with a margin.
- If any pricing read fails, the estimate is hidden and the inputs still work — the panel says pricing is unavailable rather than guessing.

## Technical notes

- `src/lib/chain.server.ts`: add readers for CHEESE balance, `ram.chz` config and stats, `cheesepowerz` stats, the Alcor pool row, and `eosio` `rammarket`; reuse existing endpoint failover and timeouts.
- `src/lib/chain.functions.ts`: add `fetchCheeseBalance` and `fetchResourcePricing` server functions with zod-validated input.
- `src/lib/resources.ts` (new, pure): CHEESE↔bytes and CHEESE↔CPU conversions, min/max clamping, purchase splitting, and the suggested top-up amount from the existing `ResourceEstimate` — unit-testable, no network.
- `src/lib/wallet.ts`: add a `transferCheese(session, { to, quantity, memo })` helper that signs one `cheeseburger::transfer`; all signing stays in the browser.
- `src/routes/index.tsx`: the Resources panel, purchase state/transaction links, and the optional pre-send top-up step.
- Contract accounts, the CHEESE symbol, and memo formats live in one constants block so they are easy to audit.
- All colors come from existing semantic tokens in `src/styles.css`; no new hardcoded colors.
