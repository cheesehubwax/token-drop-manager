# Why the RAM estimate was too high — and how to fix it

## What the current estimate does

The estimate is deliberately worst-case. In `src/lib/airdrop.ts`, `estimateResources()` sets
`maxNewRows = recipientCount` — i.e. it assumes **every** recipient needs a brand-new token
balance row — and the warning path prices that at 276 bytes per row. For ~20 recipients that is
~5.4 KB, which is exactly the number you saw. In reality most of those accounts already had a
row for the token being sent (or had held it before), so almost no new rows were created and the
real RAM spend was a fraction of the quote.

The CPU/NET figures are fixed per-action constants (1.8 ms and 160 bytes per transfer, plus
per-transaction overhead), also chosen conservatively.

## The fix: count rows that actually need creating

Instead of assuming worst case, check on chain which selected recipients already hold a row for
the token being airdropped, and estimate RAM only for the ones that don't.

1. Add a server-side reader that, for the send token's contract + symbol, fetches the existing
   `accounts` rows for a list of recipient accounts (one `get_table_rows` per account scope,
   run in concurrent batches with the existing endpoint failover and timeout handling).
2. Expose it as a server function `fetchExistingTokenRows({ contract, symbol, accounts })`
   returning the set of accounts that already have a row.
3. In the page, run this check whenever the send token or the selected recipient set changes
   (debounced, and skipped while the list is still loading). Cache results per
   contract/symbol/account so re-checks are cheap.
4. Feed the real count into the estimate: `estimateResources()` gains an explicit
   `newRowCount` input rather than deriving it from `recipientCount`. Warnings and the RAM
   figure use that count.
5. While the check is pending or if it fails, keep the current worst-case number and label it as
   an upper bound ("assumes all N recipients need a new row") so the quote is never
   optimistically low.

## Summary panel changes

- RAM line shows "new rows: X of Y recipients" plus bytes and the CHEESE equivalent.
- When the number is still the worst case, it is labelled as such.
- The automatic CHEESE RAM top-up before the airdrop then buys against the real shortfall
  instead of the inflated worst case, so less CHEESE is spent.

## Technical notes

- Row size: keep 276 bytes per row as the safety figure (a WAX token `accounts` row plus table
  overhead is a bit under this); it stays a slight over-estimate on purpose.
- Note the residual uncertainty: an account can lose its row between the check and the send,
  and the pre-send RAM top-up already applies a margin, so a small over-buy is retained.
- Files touched: `src/lib/chain.server.ts`, `src/lib/chain.functions.ts`, `src/lib/airdrop.ts`,
  `src/routes/index.tsx`. No new colors or tokens.
