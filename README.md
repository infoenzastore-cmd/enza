# ENZA Movement

ENZA Movement is a human-facing concept site for two connected experiences: **Shop EnZa**, the existing conscious-commerce business at [enza.in](https://enza.in/), and **Experience Antidote**, the proposed music and cultural programme. This repository also contains a separate, clearly labelled Stellar **Testnet** USDC checkout demo for one sample product and one sample ENZA-hosted experience.

The live EnZa store, its real products, cart, accounts, Cashfree checkout and other payment methods are **not** implemented or changed here. The repository does not have access to the store's source or private APIs. The Antidote event and ticket are samples; Axess.Zone is not connected. See [the audit and implementation plan](docs/IMPLEMENTATION_PLAN.md) before extending either integration.

Coding agents must read [AGENTS.md](AGENTS.md) and [thesis.md](thesis.md). This isolated demo uses a disposable server-held Testnet wallet so visitors can authorize sample payments without installing a wallet extension. A production customer checkout still needs a customer-controlled signing flow.

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
2. Verify the current Stellar Testnet USDC issuer against an [official Circle address list](https://developers.circle.com/stablecoins/usdc-contract-addresses). Copy `.env.example` to ignored `.env`, then set `STELLAR_USDC_TESTNET_ISSUER` and `STELLAR_MERCHANT_ADDRESS` to public Testnet addresses. The merchant must have an authorized trustline to that exact USDC asset. Never put a secret key in `.env`.
3. In one terminal, run `set -a; source .env; set +a; npm start`. This command builds the pages and starts the API and website together at `http://127.0.0.1:3000/`. `npm run dev` is an alias for the same full demo; port 5173 is not used.
4. Open `http://127.0.0.1:3000/` for the site or `http://127.0.0.1:3000/demo.html` for the sample checkout. Click **Prepare demo wallet**. The server creates a disposable account in memory, requests Testnet XLM from Friendbot, and adds the configured USDC trustline. Copy its **public** address into the [Circle faucet](https://faucet.circle.com/) with Stellar Testnet selected, then refresh the balance. One current 20 USDC faucet claim covers the two samples, priced at 5 and 10 test USDC.
5. Select a sample, review the network, issuer, destination, payer, amount and memo, then click **Authorize demo Testnet payment**. The local server signs with its demo wallet and checks the resulting transaction on Horizon before marking the order paid or issuing the demo ticket. No browser extension or visitor secret key is needed.

The server-held signing key exists only in process memory. Restarting the server creates a new wallet address; do not fund more than needed, and keep the process running through both payments. The API binds to `127.0.0.1` and must not be exposed publicly. A successful build or test suite does not prove a payment succeeded. See [Stellar integration notes](docs/STELLAR_INTEGRATION.md) and the [demo script](docs/HACKATHON_DEMO.md) for details.
