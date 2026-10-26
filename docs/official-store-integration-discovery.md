# Official EnZa storefront — integration discovery

Updated: 2026-10-26. Scope: public, verifiable facts only. No access-controls
bypass, no undocumented private-endpoint use, no order creation against the
live store. Authorized-access request: see `LIVE_STORE_INTEGRATION_REQUEST.md`.

## 1. Evidence checked (public surface)

| Item | Result |
|---|---|
| `https://enza.in/` | Live storefront. Aasaan-hosted (assets from `assets.aasaan.app`; store environment carries `channelId` etc.). Not built from this repository. No public developer/API docs linked in the storefront footer/nav. |
| Product page `https://enza.in/products/organic-plain-khapli-wheat-khakhra` (fetched 2026-10-26, single polite request) | ✅ exists. Canonical URL confirmed by `rel=canonical`; `<title>` = "Khapli Wheat Khakhra Organic Plain". |
| Embedded product JSON (first-party page payload read from the public HTML) | `regularPrice: 190`, `salePrice: 190` — list price re-verified at ₹190 (INR display, store default). `stock_status: "instock"`, `purchasable: true`, `maxAvailableQuantity: 99`, `status: "publish"`, `type: "simple"`, `rating_count: 0`, `date_created: 2026-09-26`. Brand label: **Satjeevan Organics** (`satjeevan-organics`). |
| Integration surface | No documented public checkout/webhook/partner API visible on the public site. Aasaan is a hosted SaaS commercial platform; any API access would be through Aasaan with store-operator authorization. |

The repository's showcase card (`Khakhra` in `payment.js`, PR #2) matches
these public facts (title, brand, list price ₹190, product URL) — re-verified.

## 2. Verified facts vs assumptions

**Verified:** product existence, canonical URL, current list/price (₹190 as
displayed), availability status (instock, purchasable), brand, platform
(Aasaan), absence of a *documented* public integration on the storefront
surface.

**Assumptions (unverified):** the store charges INR settlement (currency is
implied by display, not by an explicit currency field in the read payload);
that Aasaan's vendor dashboard/API exposure can be enabled for this store at
all; store operator identity is unconfirmed (no operator contact has been
established).

## 3. Platform capability note

Aasaan storefronts provide an operator dashboard; private catalog/order APIs
exist behind store authentication. Nothing about them is public, documented in
this repo, or used here. If the operator authorizes access, the first step is
reading Aasaan's operator documentation together (operator-led), not
probing endpoints.

## 4. Missing access / credentials

- Any operator-authorized API credentials, tokens or documentation.
- Confirmation whether the operator uses Aasaan-supplied APIs or expects a
  manual CSV/webhook bridge.
- A decision on who pays for and holds the Testnet demo equipment (contract
  admin key etc.) — already staged in `.env` locally.

## 5. Recommended integration path (staged)

### 5.1 General boundary (provider abstraction, design proposal)

A small provider interface keeps catalog/order/payment decoupled from rails:

```text
catalogProvider.get(productId)  -> {source: verified-cached | configured-data | synthetic, price, currency, stock, url}
quote/order: public checkout -> authorized order API (needs credentials)
paymentStatus: verified from contract + tx, independent of store bridge
reconciliation: on-chain receipt -> commercial order (needs edges the operator must provide)
```

`source` is first-class: verified official data can never look identical to
cached/synthetic data; the UI shows the badge (`TESTNET ONLY` vs `PREVIEW`).
The current codebase already separates these (CATALOG `product`/`event`/
`showcase` kinds + `LIVE_SHOWCASE`), so this is a naming boundary, not a
rewriting need.

### 5.2 Commercial lifecycle before real purchases (documented, not enabled)

1. Retrieve product → validate current price/variant (`regularPrice` vs
   `salePrice`, `purchasable`, `maxAvailableQuantity`).
2. Authorized quote/order creation through Aasaan (only after credentials).
3. Bind the exact amount to the payment intent (contract `create_order`
   amount = the authorized order's total).
4. Human customer signs the Testnet (or, after operators decide, mainnet) tx.
5. Verify settlement on-chain (already implemented).
6. Reconcile verified payment ↔ commercial order (operator confirmation).
7. Handle expiry/blinding/currency/inventory-availability/failed-order/funding
   failure/precise edge cases per operator policy.

### 5.3 Current checkout status

- The public showcase book is a **labelled demonstration**: Testnet-only
  amount, no inventory reservation, no live order, no currency conversion.
- For a genuine end-to-end journey, the minimal next steps are: (1) operator
  authorizes API access (or provides webhooks); (2) catalog provider is
  configured with authorized read credentials; (3) an order-binding layer
  maps verified on-chain payment → live order objects; (4) the fulfillment
  workflow (operator-approved) is added only then.

## 6. Required authorizations (from the store operator)

- Read-visible catalog + inventory (level T1 in the request doc).
- Order creation + fulfillment notification (level T2/T3).
- Explicit policy for funding, packaging, refunds and manual review.
- Agreement on network stage (Testnet demo → authorized pilot).

## 7. What this repo must NOT pretend

- The showcase card cannot reserve inventory or create an enza.in order.
- No price/currency conversion is performed.
- No claim of a live integration exists anywhere in the repo or in the PR.
