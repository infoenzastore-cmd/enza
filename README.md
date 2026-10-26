# ENZA Movement

ENZA Movement is a human-facing concept site for two connected experiences: **Shop EnZa**, the existing conscious-commerce business at [enza.in](https://enza.in/), and **Experience Antidote**, the proposed music and cultural programme. This repository also contains a separate, clearly labelled Stellar **Testnet** USDC checkout demo for one sample product and one sample ENZA-hosted experience.

The live EnZa store, its real products, cart, accounts, Cashfree checkout and other payment methods are **not** implemented or changed here. The repository does not have access to the store's source or private APIs. The Antidote event and ticket are samples; Axess.Zone is not connected. See [the audit and implementation plan](docs/IMPLEMENTATION_PLAN.md) before extending either integration.

Coding agents must read [AGENTS.md](AGENTS.md) and [thesis.md](thesis.md). This isolated demo settles through a verified Soroban checkout contract on Stellar Testnet. The primary flow is customer-controlled: a browser wallet (Freighter) signs the exact payment and ENZA never receives a secret key. A clearly labelled disposable server-held demo wallet remains available as an extensionless fallback for the hackathon demo.

## Pages

- `index.html` — ENZA Movement site, with paths to the live EnZa shop, Antidote concept, and Testnet demo.
- `demo.html` — sample product and experience checkout using the same local payment API.
- `blueprint.html` — preserved strategy presentation from this repository's earlier homepage.

## Hosted static previews (Netlify and GitHub Pages)

Netlify builds the static site from `dist/` using `netlify.toml`. The hosted checkout on [enzamx.netlify.app](https://enzamx.netlify.app/) and the [GitHub Pages preview](https://infoenzastore-cmd.github.io/enza/) are explicitly labelled **simulations**: visitors can select a sample and see a preview ticket, but no payment is submitted and no on-chain confirmation is claimed. The frontend detects these static hosts and does not call the local payment API. Netlify's static deployment does not run `server.js`; real Testnet settlement remains local-only until a separately designed, durable serverless backend is implemented.

Do not configure the current server-held demo wallet for public deployment. Its signing key and order state are process-local, and serverless cold starts or concurrent instances would break the flow.

## Local Testnet demo

Use Node.js 22 or newer. The demo is local only; do not expose the API publicly.

1. Run `npm ci`, `npm test`, and `npm run build`.
2. Before moving real value around Testnet, verify the current Stellar Testnet USDC issuer against an [official Circle address list](https://developers.circle.com/stablecoins/usdc-contract-addresses) and the contract against [`contracts/deployments/testnet-2026-10-26.md`](contracts/deployments/testnet-2026-10-26.md). The public Testnet identity (contract ID, issuer, merchant) defaults to that verified deployment — the server re-verifies it against the live chain at every startup and refuses to start on any mismatch. Copy `.env.example` to the ignored `.env` and set exactly one variable: `STELLAR_CHECKOUT_OPERATOR_SECRET` (the contract admin's Testnet key, e.g. from `stellar keys show <identity>`) — it is a server-only secret and the only variable required, because the contract enforces admin authorization for on-chain order creation. The merchant must have an authorized trustline to that exact USDC asset. Overrides (`STELLAR_CHECKOUT_CONTRACT_ID`, `STELLAR_USDC_TESTNET_ISSUER`, `STELLAR_MERCHANT_ADDRESS`, `STELLAR_RPC_URL`) remain optional in `.env` for pointing at a different verified deployment.
3. In one terminal, run `set -a; source .env; set +a; npm start`. This command builds the pages and starts the API and website together at `http://127.0.0.1:3000/`. `npm run dev` is an alias for the same full demo; port 5173 is not used. At startup the server verifies the deployed contract against the configured issuer (derived USDC SAC) and merchant, and refuses non-Testnet networks.
4. Open `http://127.0.0.1:3000/demo.html`.

**With your wallet (primary):** click **Connect Freighter**, keep the wallet on Testnet, select a sample, review network, token contract, destination, payer, amount and the on-chain order id, then sign the staged `pay_order` invocation in the wallet popup. The server never sees your secret key; it validates the signed invocation against the stored intent and verifies settlement on-chain before the order becomes paid. Cancellations and failures leave the pending order unfulfilled until expiry.

**Without an extension (fallback):** click **Prepare demo wallet**. The server creates a disposable account in memory, requests Testnet XLM from Friendbot, and adds the configured USDC trustline. Send at least 15 test USDC to its **public** address (Circle faucet with Stellar Testnet selected, or a transfer from an existing Testnet holder), refresh the balance, then authorize the demo payment — the server signs the same validated invocation with its disposable key.

The operator and demo signing keys exist only in process memory. Restarting the server creates a new demo wallet address; do not fund more than needed, and keep the process running through both payments. The API binds to `127.0.0.1` and must not be exposed publicly. A successful build or test suite does not prove a payment succeeded. See [Stellar integration notes](docs/STELLAR_INTEGRATION.md), the [deployment & smoke record](contracts/deployments/testnet-2026-10-26.md) and the [demo script](docs/HACKATHON_DEMO.md) for details.
