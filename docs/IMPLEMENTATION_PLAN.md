# ENZA Movement implementation plan

## Phase 1 audit — 25 October 2026

The repository's `main` commit `e41ae363` contains a static strategy page (`index.html`), a separate two-item Testnet sample (`demo.html`, `demo.js`), a Node/Horizon API (`server.js`, `payment.js`), a JSON order file under ignored `.data/`, and four payment-verification tests. Vite builds the two static pages. There is no production catalogue, shared cart, user authentication, inventory, shipping, vendor ledger, payout service, CI, or deployment configuration in this repository. The sample API creates one-item pending orders and checks Testnet settlement; it is not connected to the live store.

The public `https://enza.in/` site is an existing EnZa store. Its page exposes `assets.aasaan.app` Next.js assets, collection, account and cart links, and a Cashfree browser SDK. This establishes an Aasaan-hosted storefront and a Cashfree client integration, but does not reveal its private database, product/order APIs, payment configuration, checkout lifecycle, or source code. Those features cannot be safely modified or reused from this repository. Axess.Zone APIs and authorization have not been verified. Preserve the live store and its existing payment choices by linking to it, without claiming an integration.

The current repository's brand page is a presentation, not a customer website. Its content and links should be retained as an accessible blueprint while the repository root becomes a clear ENZA Movement entry point.

## Smallest site slice

1. Copy the current `index.html` to `blueprint.html` so the presentation remains available.
2. Build a responsive `index.html` for the ENZA Movement umbrella, with distinct **Shop EnZa** and **Experience Antidote** paths, links to the actual EnZa store, and a visibly labelled sample Testnet checkout. Keep the live store's warm, editorial visual cues. Do not invent a live Antidote inventory, booking API, or Axess.Zone connection.
3. Keep the separate `demo.html` and existing backend as the sample checkout. Link to it from the new site. Continue showing both sample product and sample ENZA-hosted sound-healing ticket using the same payment code.
4. Update `README.md` and the demo script to distinguish the live store, new site, and Testnet sample. No additional dependency is needed.

## Payment and data risks

- Circle's current official Testnet USDC issuer must be checked before configuration. Testnet assets have no monetary value. A merchant account needs an authorized trustline, and a payer needs the same asset, sufficient test USDC and XLM for reserves and fees.
- The local JSON order file is single-process demo storage. It has no customer identity, durable multi-process locks, live inventory, production fulfillment, or authenticated payout approval. Keep it local and Testnet only.
- A transaction hash is not enough to pay an order. The server must continue checking success, Testnet, destination, exact code and issuer, amount, memo, expiry and hash reuse before issuing a demo ticket.
- The current merchant Testnet address is a receive-only demonstration account: its temporary signing key was discarded after creating the trustline, so it cannot perform vendor payouts. A future payout requires a new managed signing account, verified vendor address and trustline, an auditable ledger and explicit operator authorization.
- Integrating optional USDC into the live Aasaan checkout requires store administration/API access and an approved extension point. Existing Cashfree and other payment methods must remain enabled.

## MVP acceptance for this repository

- ENZA Movement opens at the root with working Shop EnZa and Experience Antidote paths on desktop and mobile.
- The live EnZa store remains reachable and unchanged; the former strategy page remains reachable as `blueprint.html`.
- Sample Testnet product and experience checkout remain clearly labelled, settle through the verified Soroban checkout contract, and make no claim of production integration or live-store extension.
- `npm ci`, `npm test`, and `npm run build` pass on Node 22+.
- An order becomes paid only after: the payer signs the exact `pay_order` invocation (customer wallet, or the clearly labelled disposable demo wallet fallback), the server validates the signed invocation against the stored intent, the transaction succeeds on Testnet, and independent on-chain verification (`get_order`, contract events) matches amount, payer, asset, merchant and correlation id. Wallet UI was integration-tested with a stand-in signer driving the same server protocol; a browser-with-extension walkthrough remains a manual step.
- Hosted static previews (Netlify/GitHub Pages) remain preview-only and never submit payments or mark orders paid.

## Beyond this repository

Obtain the live Aasaan store's supported checkout extension/API documentation and authorized access. Map its real products, customer account, cart, order, tax, shipping, inventory, and Cashfree state transitions before adding USDC beside existing methods. Verify Axess.Zone capabilities separately before using its ticket inventory or fulfillment. Design vendor allocations and payouts only after the payment and order reconciliation path is proven.
