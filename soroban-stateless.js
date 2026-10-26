// Stateless checkout core for hosted (Netlify Functions) deployments.
//
// The chain is the durable store: every order lives in the deployed Soroban
// contract (`get_order`) beyond any function instance's lifetime, and every
// HTTP request re-derives and re-verifies state from the chain instead of
// trusting a process-local file or a browser-held reference. The browser may
// hold an untrusted reference (item id, timestamps) purely so the UI can label
// the order; nothing it sends authorizes anything:
//
// - amounts are bound to the catalog AND to the on-chain record;
// - the payer is bound to the wallet signature AND to the contract's stored
//   customer after payment;
// - a claimed transaction hash is re-parsed and must be THE invocation that
//   pays exactly this order id, by the exact on-chain customer, before any
//   payment evidence is accepted;
// - verifySorobanSettlement re-runs in full for every confirmation, so
//   replays are idempotent and fabricated hashes/expiries fail closed.
//
// Known semantic difference from the local (stateful) server, documented on
// purpose: the leaderless store cannot enforce "one order = one assigned
// customer" between intent and submit; whoever's verified signature pays
// first becomes the on-chain customer, and the contract itself prevents
// double-pay of the same order. Payment amounts never change.
import { TransactionBuilder } from '@stellar/stellar-sdk';
import { CATALOG, createOrder, unitsToAmount } from './payment.js';
import {
  TESTNET_PASSPHRASE,
  amountToUnits,
  orderOnChainId,
  validateSignedCheckoutTx,
  verifySorobanSettlement
} from './soroban.js';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Plans a fresh server-side order and its on-chain intent. No persistence:
// the on-chain create_order write is the record of record.
export function plannedOrder(itemId, { contractId, merchant }) {
  const item = CATALOG[itemId];
  if (!item) throw new Error('Unknown sample item');
  const order = createOrder(itemId);
  order.customer = null;
  order.soroban = { onChainId: orderOnChainId(order.id), contractId, merchant };
  return order;
}

// Mirrors the local server's publicOrder payload shape so the browser code is
// drop-in compatible between hosts.
export function publicOrder(order, { explorerBase = 'https://stellar.expert/explorer/testnet/tx' } = {}) {
  return {
    id: order.id,
    itemId: order.itemId ?? null,
    kind: order.kind ?? null,
    amount: order.amount,
    status: order.status,
    createdAt: order.createdAt ?? null,
    expiresAt: order.expiresAt,
    hash: order.hash ?? null,
    customer: order.customer ?? null,
    paidAt: order.paidAt ?? null,
    ticket: order.ticket ?? null,
    failureReason: order.failureReason ?? null,
    soroban: order.soroban ? { onChainId: order.soroban.onChainId, contractId: order.soroban.contractId, merchant: order.soroban.merchant } : null,
    explorer: order.hash ? `${explorerBase}/${order.hash}` : null
  };
}

const isoFromSeconds = seconds => new Date(Number(seconds) * 1000).toISOString();

// Extracts the payer identity from a wallet-signed envelope, or null when the
// envelope is malformed. The browser never gets to TELL the server who paid:
// the payer is the envelope's source, and the transaction's own signature
// decides whether that claim is true.
export function payerFromSignedEnvelope(signedXdr) {
  try {
    const tx = TransactionBuilder.fromXDR(String(signedXdr ?? ''), TESTNET_PASSPHRASE);
    return tx.source || null;
  } catch { return null; }
}

// Rebuilds the order from an untrusted browser reference and the authoritative
// on-chain record. Display hints (item, price, timestamps) are only accepted
// when they agree with the catalog and the chain; disagreement fails closed.
export function orderFromChain(id, onchain, ref, { contractId, merchant } = {}) {
  if (!UUID_PATTERN.test(String(id ?? ''))) throw new Error('Order id is not a valid order reference');
  if (!onchain || onchain.amount === undefined) throw new Error('On-chain order not found');
  const onChainId = orderOnChainId(String(id));
  const itemId = ref?.itemId ?? null;
  if (itemId !== null) {
    if (!CATALOG[itemId]) throw new Error('Order reference names an unknown item');
    if (onchain.amount !== CATALOG[itemId].units) throw new Error('On-chain order does not match the referenced item amount');
    if (ref?.amount) {
      let refUnits = null;
      try { refUnits = amountToUnits(String(ref.amount)); } catch { refUnits = null; }
      if (refUnits !== null && refUnits !== CATALOG[itemId].units) throw new Error('Order reference amount does not match the catalog item');
    }
  }
  const createdAt = typeof ref?.createdAt === 'string' && Number.isFinite(Date.parse(ref.createdAt))
    ? ref.createdAt
    : (onchain.paid ? isoFromSeconds(onchain.paidAt) : null);
  return {
    id: String(id),
    itemId,
    kind: itemId !== null ? CATALOG[itemId].kind : null,
    amount: unitsToAmount(onchain.amount),
    status: onchain.paid ? 'paid' : 'pending',
    createdAt,
    expiresAt: isoFromSeconds(onchain.expiresAt),
    customer: onchain.customer || ref?.customer || null,
    hash: null,
    paidAt: onchain.paid ? isoFromSeconds(onchain.paidAt) : null,
    ticket: null,
    failureReason: null,
    soroban: { onChainId, contractId, merchant }
  };
}

// Full settlement verification with no local order store:
// 1. the claimed transaction hash is parsed and re-bound to THIS order — the
//    envelope must be a single pay_order invocation of the configured
//    contract, with exactly this order's on-chain id and the exact on-chain
//    customer as the authorized signer (validateSignedCheckoutTx);
// 2. verifySorobanSettlement re-runs completely on fresh evidence — network,
//    tx status, on-chain paid flag, amount, payer, creation/expiry timing.
// Idempotent because every replay passes through the same checks and every
// cross-order hash reuse fails the invocation-id binding. An empty
// usedHashes set is correct here: uniqueness across orders is enforced by
// the contract itself (one pay_order invocation pays exactly one order).
export function statelessConfirm(order, evidence, { contractId } = {}) {
  const { txStatus, envelopeXdr } = evidence ?? {};
  if (txStatus === 'SUCCESS') {
    let tx = null;
    try { tx = TransactionBuilder.fromXDR(String(envelopeXdr ?? ''), TESTNET_PASSPHRASE); } catch { tx = null; }
    if (!tx) throw new Error('Retrieved transaction does not carry a parsable payment envelope');
    // Defense-in-depth: the claimed hash must be exactly this envelope. The
    // authoritative RPC already returns only the requested transaction, but
    // the verifier never relies on the caller having used it correctly.
    const computed = Buffer.from(tx.hash()).toString('hex');
    if (computed !== String(evidence.hash ?? '')) {
      throw new Error('Transaction hash does not match the retrieved envelope');
    }
    validateSignedCheckoutTx(tx, { order, customerAddress: order.customer, contractId, onChainId: order.soroban.onChainId });
  }
  return verifySorobanSettlement({ ...order, status: 'pending', hash: null, ticket: null }, evidence, new Set());
}
