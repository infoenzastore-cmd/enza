# EnZa Soroban checkout (Testnet only)

This contract is an experimental on-chain payment-intent registry and checkout. It is deployed on Stellar Testnet only (see `contracts/deployments/testnet-2026-10-26.md` for the verified deployment), has not been audited, and must not be used with mainnet assets.

## Behavior

- The constructor pins an operator/admin, one token contract address and one merchant address.
- The operator creates a unique 32-byte order ID, exact positive token amount in the token's smallest units, and a ledger-timestamp expiry.
- A customer explicitly authorizes pay_order. The contract transfers the exact amount from that customer to the configured merchant and records settlement in the same transaction.
- Repeated payment attempts fail after the first successful settlement.
- Persistent order records use TTL extension; monitor and maintain storage TTLs for long-lived deployments.
- Events expose order creation and payment confirmation for indexers/UI.

This first contract does not implement vendor split payouts, refunds, disputes, real-store integration, inventory, fiat conversion, or production authorization operations. The configured token address must be the verified Soroban token contract for the intended Testnet USDC asset. Never trust the display symbol alone.

## Build and test

Use a Rust toolchain compatible with the current Stellar CLI and Soroban SDK. Follow the official [contract lifecycle](https://developers.stellar.org/docs/learn/fundamentals/contract-development/contract-lifecycle) and [smart contract skill](https://github.com/stellar/stellar-dev-skill/tree/main/skills/smart-contracts).

    cd contracts/enza-checkout
    cargo test
    stellar contract build

The deployable WASM target must be wasm32v1-none; use stellar contract build, not plain cargo build.

## Deployment gates

Do not deploy until tests and review pass. On Testnet:
1. Confirm the network's supported protocol/SDK version.
2. Generate a dedicated Testnet deployer identity and fund it with test XLM.
3. Verify the exact USDC asset issuer and corresponding Soroban token/SAC address using official Stellar/Circle sources.
4. Build the optimized WASM and inspect it.
5. Deploy with the admin, token contract and merchant addresses as constructor arguments.
6. Save the contract ID, WASM hash, source commit, network, and deployment transaction hash.
7. Invoke order creation and payment with funded test accounts; independently verify balances, events, and the resulting ledger transaction.
8. Keep deployment secrets out of GitHub and the browser. Do not deploy to Pubnet/mainnet as part of this work.

The current Netlify site is static and does not execute the existing Node payment API. The next integration must use a wallet-supported signing flow and Soroban RPC/client path; never expose a customer secret key to the backend.
