# Minimum 10 CHEESE RAM purchase on every airdrop

Every airdrop buys at least 10 CHEESE of RAM through `ram.chz` before the first batch, whether or not the account needs RAM. This acts as the tool's fee: the user keeps the RAM and can sell it later if unused. If the drop needs more than 10 CHEESE of RAM, the larger amount is bought instead.

## Behaviour

- The RAM purchase is now unconditional: amount = max(10 CHEESE, estimated shortfall, contract minimum).
- It is still one or more signed CHEESE transfers to `ram.chz`, split to respect the contract's per-transfer min/max.
- CPU/NET top-up logic stays exactly as it is today (shortfall only).
- If the connected account's CHEESE balance is known and below the required RAM amount, the airdrop stops before signing anything with a clear message ("Airdrop requires 10.0000 CHEESE of RAM; your balance is X"), instead of proceeding to a run that would fail.
- If the RAM purchase transaction fails or is rejected in the wallet, the airdrop does not start (existing behaviour).
- If `ram.chz` reports buying disabled, the airdrop stops with that reason rather than skipping the fee.

## What the user sees

- Summary gains a line stating the minimum: "RAM purchase (required): 10.0000 CHEESE minimum — kept by your account, sellable afterwards", showing the actual amount when the estimate is higher.
- The existing note under the Airdrop button is reworded so it's clear a RAM purchase is always signed first, not only when short.
- Purchase log and transaction links behave as they do now.

## Technical notes

- New constant `MIN_RAM_PURCHASE_CHEESE = 10` in `src/lib/cheese.ts` alongside the other CHEESE constants.
- `src/routes/index.tsx`: `suggestedRamCheese` becomes `requiredRamCheese`, computed as `ceilCheese(max(MIN_RAM_PURCHASE_CHEESE, cheeseForBytes(shortfall), pricing.ram.minCheese))` and no longer returns null when there is no shortfall (still null if pricing is unavailable).
- `runAirdrop`: RAM branch runs unconditionally via `splitPurchases(requiredRamCheese, ...)`; add the balance/`ram.enabled` pre-checks that abort with an error message shown in the summary area.
- No changes to airdrop math, batching, or `src/lib/resources.ts`.
