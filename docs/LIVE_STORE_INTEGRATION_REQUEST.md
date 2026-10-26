# Request to the live-store operator: authorized integration prerequisites

**Status: draft request. Nothing below is implemented, and no store behavior has been changed.** The Soroban/Testnet checkout in this repository runs only against the local demo server. This document lists the minimum authorization and interfaces required before any of it could ever touch the official `enza.in` storefront, which is Aasaan-hosted (its source and private checkout APIs are not part of this repository and have not been accessed).

## What we are asking for

1. **Checkout extension point** — the supported Aasaan mechanism (app, plugin, or hosted-checkout hook) that lets a payment alternative be offered alongside the existing methods, without modifying Cashfree or any current payment method.
2. **Order lifecycle documentation and API scope** — how the store creates orders externally: API endpoints, order states, idempotency expectations, and who can advance them.
3. **Webhook/callback authorization** — an HTTPS callback channel plus a signing secret so a verified payment can update exactly one order, with replay protection.
4. **Cart and inventory access** — read scope for products and stock levels (the public catalog metadata is visible without authentication, but usable integration needs an authorized scope; no inventory is reserved today).
5. **Authentication material** — store-scoped API credentials issued for this integration only, with least privilege, stored outside the repository (never committed).
6. **Sandbox/staging environment** — where a Testnet-shaped integration can be exercised end to end before production is ever touched.
7. **Fulfillment contract** — who fulfills, when, and what proof of payment fulfillment requires (our rule: no fulfillment before server-verified settlement).

## What we explicitly do not request

- No access to customer payment data, existing gateway credentials (Cashfree), or financial accounts.
- No permission to change the live store's source, theme, DNS, or hosting.
- No automatic vendor payouts or refunds (explicit non-goal of the current product scope; would require separate authorization and design).

## Current, honest state

- Testnet-only Soroban checkout: implemented and locally verified (see `contracts/deployments/testnet-2026-10-26.md`).
- Live-store integration: **not started**; requires items 1–7 above plus maintainer approval (upstream PR #1 and the follow-up Soroban PR must be merged first).
- Public catalog facts used in the local demo are labelled as a **showcase**: no live-store order is created.
