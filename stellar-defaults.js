/**
 * PUBLIC, documented Testnet checkout identity — the verified deployment
 * recorded in contracts/deployments/testnet-2026-10-26.md.
 *
 * These are NOT secrets: the contract ID and both addresses are visible on the
 * public Testnet. The service still re-verifies the identity against the live
 * chain at every startup (assertDeployment: the deployed token contract must
 * equal the SAC derived from this issuer, and the on-chain merchant must equal
 * this address) and fails closed on any mismatch — so a stale default is a
 * refused startup, never a wrong payment.
 *
 * Environment overrides (STELLAR_CHECKOUT_CONTRACT_ID /
 * STELLAR_USDC_TESTNET_ISSUER / STELLAR_MERCHANT_ADDRESS / STELLAR_RPC_URL)
 * remain available for operators pointing at a different verified deployment.
 */
export const PUBLIC_TESTNET_DEFAULTS = Object.freeze({
  contractId: 'CA4BAJTVSEU7NRRABUXRE22DZ35IBHFMITB3OMVG7JBYN2DM5VYKYDRP',
  issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  merchant: 'GDTOM5LLLQRUXHRJRU3ACK75IP7JDB7DS5LFX4AA6NHEDG6BKPTEEOX4',
  rpcUrl: 'https://soroban-testnet.stellar.org'
});
