# Hosted Testnet preview architecture (Netlify Functions, stateless)

This document describes how the Soroban Testnet checkout runs on a hosted
Netlify deployment without weakening any payment invariant, and exactly which
environment variables an authorized operator must configure.

## Architectural decision

The local demo (`npm start` + `server.js`) keeps its stateful Server record as
the authoritative order store. A serverless host does not provide durable
shared state: `/tmp` and memory are instance-local and tenants are not shared.
Rebuilding the full persistence layer (external database, locking,
secret-managed credentials) is out of scope until the operator authorizes it.

What makes this deployment possible *safely* is that **the chain itself is the
durable store**:

- every order exists in the deployed contract (`get_order`: amount, customer,
  expiry, paid flag, paidAt);
- the browser retains only an untrusted *reference* — order id, item id,
  creation timestamp — which is display-only;
- every hosted endpoint re-derives the order from `get_order` and re-verifies
  all payment facts before acting (see `soroban-stateless.js`);
- `verifySorobanSettlement` (the same function used by the local server) runs
  in full on every confirmation;
- a claimed transaction hash is re-computed against the retrieved envelope
  (`sha256(envelope) === hash`) and the envelope must be a single
  `pay_order` invocation of the configured contract with exactly this order's
  on-chain id and exactly the on-chain customer's authorized signature
  (`validateSignedCheckoutTx`) — so cross-order hash reuse, forged payers and
  fabricated hashes fail closed;
- idempotency: every replay flows through the same full verification.

## What is different (documented, not hidden)

1. **Demo-wallet rail is unavailable** on the hosted deployment. The disposable
   in-process signing wallet is a local-server capability. Hosted deployments
   state this (`capabilities.demoWallet === false`), hide the panel, and
   require the customer's own wallet (Freighter) on Testnet.
2. **The pre-payment "one order ⇄ one assigned customer" lock is relaxed.**
   Without shared state the server cannot store the assignment between intents.
   This is payment-safe: the contract re-verifies every payment against its
   own stored order; whoever's verified signature pays first becomes the
   on-chain customer, double-pay of the same order is impossible
   (the contract itself reverts `AlreadyPaid`), and the order amount never
   changes.
3. **Rate limiting is per-instance** (no shared limiter without a store).
4. `create_order` may return `status: "staging"` if the ledger confirmation
   exceeds the invocation budget; the browser polls `GET /api/orders/:id`
   until the chain reports the order (idempotent: a repeated create is
   reconciled against the chain, never retried blind).

## Endpoints (hosted vs local)

| Route | Local (`server.js`) | Hosted (Netlify Functions) |
|---|---|---|
| `GET /api/config` | ✓ | ✓ (honest `configured:false` when setup is missing) |
| `GET /api/checkout` | ✓ | ✓ |
| `POST /api/orders` | ✓ | ✓ (operator-signed `create_order`) |
| `GET /api/orders/:id` | ✓ (server record) | ✓ (from `get_order`; display hints from the browser) |
| `POST /api/orders/:id/intent`, `/submit`, `/confirm` | ✓ | ✓ (same protocol, chain-verified) |
| `POST /api/pay`/`demo-wallet*` | ✓ | 501 (honest unavailability) |

Origin policy on the host: POSTs accept only the deployment's own origin
(same-origin browser calls). No CORS exposure, no public API surface.

## Required environment variables (Netlify)

Configure these in the Netlify site settings (Site configuration →
Environment variables), scoped to the intended context, before the preview can
run the live flow. All values must come from the recorded deployment in
`contracts/deployments/testnet-2026-10-26.md`.

Variable | Kind | Where from
---|---|---
`STELLAR_CHECKOUT_OPERATOR_SECRET` | **secret — the ONLY required variable** | contract admin Testnet key — configured as a Netlify server-side secret (serverless runtime variable). Never in the repository, logs or client bundle. Required only for on-chain order creation, because the contract enforces admin authorization for `create_order`.
`STELLAR_USDC_TESTNET_ISSUER` | optional override | defaults to the documented Testnet USDC SAC issuer; set only to point at a different verified deployment
`STELLAR_MERCHANT_ADDRESS` | optional override | defaults to the deployed merchant address
`STELLAR_CHECKOUT_CONTRACT_ID` | optional override | defaults to the deployed `CA4BAJT…YKYDRP`
`STELLAR_RPC_URL` *(optional)* | public config | `https://soroban-testnet.stellar.org` unless overridden

The public defaults come from the verified deployment record
(`stellar-defaults.js`, sourced from
`contracts/deployments/testnet-2026-10-26.md`) and are re-verified against the
live chain at every startup (`assertDeployment`) — a stale or malformed value
fails closed at boot, never at payment time.
  variables the runtime refuses to start (no mock, no silent fallback).
- Public values are read at runtime by functions; they are not build-time
  values in `netlify.toml` and never reach the client bundle.
- Fail-closed behavior: without `STELLAR_CHECKOUT_OPERATOR_SECRET`, order
  creation answers with an actionable setup message; without the other
  variables being well-formed (if overridden), the deployment refuses to serve
  checkout by reporting its real configuration state.
- The static client bundle never contains any of these variables; the browser
  code only calls same-origin `/api/…` endpoints.

## API contract note (hosted submit)

`POST /api/orders/:id/submit` accepts `{ signedXdr }` exactly like the local
server. The payer is **derived from the signed envelope's own source field** and
proven by its signature and the exact `pay_order(order_id, payer)` invocation
binding inside `validateSignedCheckoutTx` — a browser-supplied payer claim is
never trusted; if present, a mismatched claim rejects with a clear error.

## Verifying the operator configuration (what to do before testing)

Because the checkout contract enforces admin authorization for `create_order`,
the deployed functions must see `STELLAR_CHECKOUT_OPERATOR_SECRET` configured
as a Functions-scoped environment variable **and ship on a build created after
it was saved**. If `GET /api/config` still reports `operatorConfigured: false`
after the owner saved the variable:

1. Check the exact name (no typos) and the scopes: **environment variables for
   Functions**, site-wide scope (not only "deploy previews" or a branch
   context). The probe answers with `operatorEnvKeys` — the first (up to 5)
   `STELLAR_*OPERATOR*` variable NAMES the runtime can see, so a typo is
   visible without reading any value.
2. `bootstrapError` in the same answer reports a sanitized bootstrap reason
   when the deployment's configuration itself failed to load.
3. Trigger a redeploy after any variable change; the functions' environment is
   baked in at deploy time.
4. `GET /api/health` performs a bounded RPC reachability probe and returns the
   concrete failure class (DNS `ENOTFOUND`, connect `ECONNREFUSED`, timeout
   `UND_ERR_CONNECT_TIMEOUT`, proxy/egress blocks...) instead of an opaque
   "fetch failed" — use it to distinguish RPC downtime from function egress
   problems. No secrets or headers are ever included.

The frontend treats a deployed serverless backend that cannot process payments
as a BLOCKED state (payments disabled, exact reason shown): it never falls
back to presenting the static simulation as a checkout.

## Preview and production boundaries

- The site's PR previews build `dist` plus the functions; the Soroban flow runs
  only under the *deploy preview* URL of this branch after the variables are
  configured.
- The **production context of the site stays out of scope** until the
  maintainers authorize it explicitly. No production-domain change is planned
  or performed here.
- The static GitHub Pages preview remains a labelled paymentless page — the
  UI detects *hosting capabilities* by probing `/api/config` rather than by
  hostname.

## Some real environment considerations (current blockers)

| Blocker | Who unblocks it |
|---|---|
| The enzamx site has built deploy-preview-1 for PR #1 but, as verified 2026-10-26, has **not** created a deploy preview for PR #2 (`deploy-preview-2--enzamx.netlify.app` returns Netlify's "site not found" page even after the branch was pushed and PR #2 exists). A site owner should confirm "Deploy previews" are enabled for the enzamx site or trigger the build from the Netlify UI (e.g. open the PR in the Netlify app or comment `/netlify deploy` on PR #2 as an authorized member). | The authorized site owner. |
| Netlify environment variables must be configured by the account/site owner (any workspace access is restricted) | The authorized operator. |
| Customer-signed (Freighter) walkthrough on the hosted preview cannot be performed by the agent | The human demo operator. |
| Durable shared storage, cross-instance rate limiting and pooled metrics (if ever required beyond the pure post-pay flows) require runtime accounts (e.g. hosted KV): not available in the environment and not authorized | Maintainers. |
| Hosted CI stays blocked/unverified while the GitHub account has a billing lock (re-checked 2026-10-26 on the pushed head: `contract` job completed with zero executed steps) | The account owner. |

## Reference

The same Testnet assets/amounts/merchant from earlier verified phases remain
in force. No new transaction types. No Pubnet. Testnet banner and warning
labels remain everywhere.
