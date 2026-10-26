# Stellar Testnet demo (Soroban checkout)

This repository contains a separate sample checkout, not an integration with the production EnZa store. It uses Node.js 22+, Vite, `@stellar/stellar-sdk` (v17) and `@stellar/freighter-api` against the verified Soroban checkout contract on Stellar Testnet. No secret material ever reaches the browser, repository or logs; Pubnet endpoints are refused at startup.

## Configuration (local only, never commit)

Create `.env` (already git-ignored) mirroring `.env.example`:

1. `STELLAR_USDC_TESTNET_ISSUER` — the currently verified official Testnet USDC issuer from Circle/Stellar asset documentation (`GBBD47IF6…FLA5` at the time of writing). Verify it yourself against current official sources; do not copy an example issuer.
2. `STELLAR_MERCHANT_ADDRESS` — a Testnet account that holds the USDC trustline (the contract's payout destination).
3. `STELLAR_CHECKOUT_CONTRACT_ID` — the verified deployed checkout contract, recorded in `contracts/deployments/testnet-2026-10-26.md` (`CA4BAJTV…YKYDRP`).
4. `STELLAR_CHECKOUT_OPERATOR_SECRET` — the contract admin's Testnet signing key (deployer identity from `stellar keys show`). Server memory only; used to sign `create_order` on-chain. This is the one server-held key, and it is an operator key, never a customer key.
5. `STELLAR_RPC_URL` — optional; the default is the official Testnet RPC `https://soroban-testnet.stellar.org`, and the server refuses to run against a network whose passphrase is not the Testnet passphrase.

At startup the server verifies deployment integrity on-chain: the contract's `token()` must equal the SAC derived from the configured issuer on Testnet, and `merchant()` must equal the configured merchant address. Asset identity is checked by issuer plus derived contract ID — never by the "USDC" symbol alone.

## Run the checkout

```bash
set -a; source .env; set +a
npm ci --cache /tmp/enza-npm
npm run build && node server.js
```

Open `http://127.0.0.1:3000/demo.html`.

### Paying with your own wallet (primary flow)

1. Click **Connect Freighter** and make sure the wallet is set to **Testnet**. ENZA receives only your public address.
2. Select a sample. The server creates the ecommerce order, derives its on-chain correlation id (SHA-256 of the order UUID), signs `create_order` as the operator, and returns the pending order with its expiry.
3. Review the exact network, token contract (verified USDC SAC), destination, payer and on-chain order id.
4. Click **Sign payment with my wallet**. The server builds the *unsigned* `pay_order` invocation (after simulation fills the authorization entries) and hands it to the browser; your wallet signs it; the server validates it against the stored intent (source, payer, contract, function, correlation id, signature) before submitting, then verifies settlement on-chain before the order becomes `paid`.
5. Wallet cancellations, wrong networks, insufficient balances and on-chain failures are surfaced as errors; a pending order can be retried until expiry and confirmation is idempotent. Reloading the page resumes a pending order.

### Paying with the disposable demo wallet (extensionless fallback)

1. Click **Prepare demo wallet** (Friendbot XLM + USDC trustline), then fund the shown public address with test USDC from Circle's Testnet faucet (or transfer from an existing Testnet holder).
2. The rest of the flow is identical, except the server signs the same validated envelope with its own disposable in-memory key. This key exists only in the server process and is clearly labelled as demo tooling, not a customer wallet.

## What the server verifies before an order is paid

- the transaction is final and successful on Stellar Testnet (RPC `getTransaction`);
- the on-chain order for the stored correlation id exists, was paid for the exact authorised amount in stroops, by the customer recorded at intent time, inside the order window (and no earlier than order creation);
- the signed transaction was not previously used by any other order (hash reuse is rejected);
- the deployed contract still matches the configured issuer/merchant at server start.

No automatic vendor payouts or refunds are implemented: payouts (`settlement.js` allocation engine) remain a deterministic preview and would need a separately reviewed authorisation and accounting design before execution.

### Manual Freighter walkthrough (operator checklist)

Environment note: this project's automated environment has no browser extension host, so the wallet flow was verified with a stand-in signer driving the identical server↔wallet protocol, plus live on-chain settlements. To execute the real-extension walkthrough, run the checklist below on a machine where the Freighter extension is installed and set to Testnet:

1. `npm start` (or `node server.js`) with `.env` configured; confirm the startup line prints the verified contract and `Testnet`.
2. Open `http://localhost:3000/demo.html`; confirm the *Testnet only — test USDC has no monetary value* banner.
3. Click **Connect Freighter**; approve the popup; confirm the shown address matches the wallet's account and that Freighter reports **Stellar Testnet** (if it offers a network switch, accept it; the page refuses Pubnet).
4. Fund the wallet address if needed (Circle Testnet faucet at `https://faucet.circle.com/` — chosen network: Stellar Testnet — or transfer test USDC from any holder).
5. Select the **sample product** card (the primary path). Check the review panel shows: item name, 5.00 USDC, Stellar Testnet, the verified USDC SAC token (`CBIELTK6…QDAMA`), merchant destination (`GDTOM5L…EOX4`), your payer address, expiry, and the on-chain order id.
6. Press **Sign payment with my wallet**; in the Freighter popup confirm the decoded operation is exactly one `pay_order` invocation of the verified contract (`CA4BAJT…YDRP`) with your address as payer and no other operations, then approve.
7. The page submits, verifies `getTransaction` success and on-chain `get_order` state, and only then displays *Paid* with the transaction hash, a Stellar Explorer Testnet link, and the order correlation id.
8. Reload the page: the paid status persists. Re-clicking pay/confirm must never double-charge (contract rejects a second `pay_order` and the server replays idempotently).
9. Record the order id and transaction hash in `contracts/deployments/testnet-2026-10-26.md`.

If any popup differs from the pre-sign review panel, stop and retry: never sign a transaction you cannot match to the review facts.

## Local order storage (single process, demo only)

Orders live in `.data/orders.json` next to `server.js` (created on demand; a git-ignored directory). The file is written atomically (write-then-rename) and is quarantined at startup when unreadable — a corrupt store never blocks the server: it logs the quarantine, starts with an empty in-memory store, and on-chain Testnet state remains authoritative for anything already settled. This is single-process demo storage, NOT a multi-instance backend: no two server processes may share a data directory, and horizontal scaling is explicitly out of scope. Tests never touch your real demo store — they run against their own throwaway directory (`ENZA_DATA_DIR`, documented in `.env.example`).

## Mocks vs on-chain evidence

- `npm test` — 24 deterministic unit tests with no network access (settlement matrix, signed-invocation validation, demo wallet, order/config primitives).
- `scripts/wallet-smoke.mjs` — live Testnet driver that stages an order, signs as a stand-in wallet, and exercises duplicate-submit/forged-signature/idempotent-confirm guards. Set the stand-in key via a local env var, e.g. `STELLAR_SMOKE_SECRET=$(stellar keys show knot-flat-404) node scripts/wallet-smoke.mjs` with your own funded Testnet identity. It never prints secret material.
- Assumption: Stellar RPC retains recent transactions for about a week on public endpoints. Initial confirmation uses `getTransaction` for freshness; the contract's `get_order` state (persistent storage) and the Horizon/Explorer transaction links provide the durable record afterwards. An already-paid order replays idempotently from the stored record without fabricating an on-chain verification.

Every Testnet screen and receipt states that test assets have no monetary value and that network fees are not zero.
