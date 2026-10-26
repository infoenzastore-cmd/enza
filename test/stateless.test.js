// Offline unit tests for the stateless checkout core (soroban-stateless.js)
// and the hosted HTTP glue (netlify/functions/lib/host.mjs).
//
// Everything runs without network or real secrets: the service and chain
// reads are injected fakes mirroring the exact shapes the real ones produce,
// and tx envelopes are genuinely signed offline by throwaway keypairs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Account, Address, Keypair, Networks, Operation, StrKey, TransactionBuilder, nativeToScVal } from '@stellar/stellar-sdk';

import { orderOnChainId } from '../soroban.js';
import {
  UUID_PATTERN,
  publicOrder,
  statelessConfirm,
  orderFromChain,
  plannedOrder
} from '../soroban-stateless.js';
import { handleApiRequest, resetRuntime } from '../netlify/functions/lib/host.mjs';

const CONTRACT_ID = 'CA4BAJTVSEU7NRRABUXRE22DZ35IBHFMITB3OMVG7JBYN2DM5VYKYDRP';
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const MERCHANT = 'GDTOM5LLLQRUXHRJRU3ACK75IP7JDB7DS5LFX4AA6NHEDG6BKPTEEOX4';

const customer = Keypair.random();
const other = Keypair.random();

// Normalises the SDK's raw Uint8Array hash to the canonical lowercase hex
// form used by RPC responses, receipts and explorer links.
const txHashHex = tx => Buffer.from(tx.hash()).toString('hex');

// Builds a real, correctly signed pay_order invocation envelope offline so
// validation paths are exercised against genuine transaction structures.
function signedPaymentTx(payer, onChainIdHex, { contract = CONTRACT_ID } = {}) {
  const args = [
    nativeToScVal(Buffer.from(onChainIdHex, 'hex'), { type: 'bytes' }),
    new Address(payer.publicKey()).toScVal()
  ];
  const tx = new TransactionBuilder(
    new Account(payer.publicKey(), '100'),
    { fee: '100', networkPassphrase: Networks.TESTNET }
  ).addOperation(Operation.invokeContractFunction({ contract, function: 'pay_order', args }))
    .setTimeout(60)
    .build();
  tx.sign(payer);
  return tx;
}

const future = seconds => BigInt(Math.floor(Date.now() / 1000) + seconds);
const onChainPaid = { amount: 50000000n, customer: customer.publicKey(), expiresAt: future(600), paid: true, paidAt: future(-30) };
const onChainPending = { ...onChainPaid, paid: false, paidAt: 0n, customer: '' };

test('planned orders bind the catalog amount and derive the on-chain id', () => {
  const order = plannedOrder('bottle', { contractId: CONTRACT_ID, merchant: MERCHANT });
  assert.equal(order.amount, '5.0000000');
  assert.equal(order.status, 'pending');
  assert.equal(order.customer, null);
  assert.match(order.soroban.onChainId, /^[0-9a-f]{64}$/);
  assert.equal(order.soroban.onChainId, orderOnChainId(order.id));
  assert.match(order.id, UUID_PATTERN);
  assert.throws(() => plannedOrder('nope', {}), /Unknown sample item/);
});

test('orderFromChain rebuilds from the chain and rejects tampered references', () => {
  const planned = plannedOrder('bottle', { contractId: CONTRACT_ID, merchant: MERCHANT });
  const ref = { itemId: 'bottle', amount: planned.amount, createdAt: planned.createdAt, customer: null };

  const rebuilt = orderFromChain(planned.id, onChainPending, ref, { contractId: CONTRACT_ID, merchant: MERCHANT });
  assert.equal(rebuilt.amount, '5.0000000');
  assert.equal(rebuilt.status, 'pending');
  assert.equal(rebuilt.itemId, 'bottle');
  assert.equal(rebuilt.soroban.onChainId, orderOnChainId(planned.id));

  // Unknown item in the reference -> reject.
  assert.throws(() =>
    orderFromChain(planned.id, onChainPending, { ...ref, itemId: 'nope' }, { contractId: CONTRACT_ID }),
    /unknown item/);

  // A different item amount cannot be claimed against this record.
  assert.throws(() =>
    orderFromChain(planned.id, { ...onChainPending, amount: 100000000n }, ref, { contractId: CONTRACT_ID }),
    /does not match the referenced item amount/);

  // Tampered reference price (claiming a different price on a bottle record).
  assert.throws(() =>
    orderFromChain(planned.id, onChainPending, { ...ref, amount: '10.0000000' }, { contractId: CONTRACT_ID }),
    /reference amount does not match the catalog item/);

  // An invalid order id cannot derive an on-chain intent.
  assert.throws(() =>
    orderFromChain('not-a-uuid', onChainPending, null, { contractId: CONTRACT_ID }),
    /not a valid order reference/);

  // Missing on-chain record is a not-found, never settleable data.
  assert.throws(() => orderFromChain(planned.id, null, ref, { contractId: CONTRACT_ID }), /not found/);
});

test('paid orders reconstruct with the authoritative on-chain payer and paidAt', () => {
  const planned = plannedOrder('bottle', { contractId: CONTRACT_ID, merchant: MERCHANT });
  const rebuilt = orderFromChain(planned.id, onChainPaid, null, { contractId: CONTRACT_ID, merchant: MERCHANT });
  assert.equal(rebuilt.status, 'paid');
  assert.equal(rebuilt.customer, customer.publicKey());
  assert.notStrictEqual(rebuilt.paidAt, null);
  // A tampered claim that someone else paid cannot override the chain.
  const claimed = orderFromChain(planned.id, onChainPaid, { itemId: 'bottle', customer: other.publicKey() }, { contractId: CONTRACT_ID, merchant: MERCHANT });
  assert.equal(claimed.customer, customer.publicKey());
});

test('statelessConfirm verifies a genuine signed invocation and is idempotent', () => {
  const planned = plannedOrder('bottle', { contractId: CONTRACT_ID, merchant: MERCHANT });
  const tx = signedPaymentTx(customer, planned.soroban.onChainId);
  const order = orderFromChain(planned.id, onChainPaid, { itemId: 'bottle', createdAt: planned.createdAt }, { contractId: CONTRACT_ID, merchant: MERCHANT });
  const evidence = { hash: txHashHex(tx), txStatus: 'SUCCESS', onchain: onChainPaid, envelopeXdr: tx.toXDR() };

  const paid = statelessConfirm(order, evidence, { contractId: CONTRACT_ID });
  assert.equal(paid.status, 'paid');
  assert.equal(paid.hash, evidence.hash);
  assert.equal(paid.customer, customer.publicKey());
  assert.equal(paid.ticket, null, 'sample products carry no demo ticket');

  // An event order mints the demo ticket.
  const eventPlanned = plannedOrder('antidote', { contractId: CONTRACT_ID, merchant: MERCHANT });
  const eventTx = signedPaymentTx(customer, eventPlanned.soroban.onChainId);
  const eventChain = { ...onChainPaid, amount: 100000000n };
  const eventOrder = orderFromChain(eventPlanned.id, eventChain, { itemId: 'antidote', createdAt: eventPlanned.createdAt }, { contractId: CONTRACT_ID, merchant: MERCHANT });
  const eventPaid = statelessConfirm(eventOrder, { hash: txHashHex(eventTx), txStatus: 'SUCCESS', onchain: eventChain, envelopeXdr: eventTx.toXDR() }, { contractId: CONTRACT_ID });
  assert.match(eventPaid.ticket, /^DEMO-/);

  // Idempotent replay: the same evidence re-verified returns the same record.
  const replay = statelessConfirm(order, evidence, { contractId: CONTRACT_ID });
  assert.equal(replay.hash, paid.hash);
  assert.equal(replay.status, 'paid');
});

test('statelessConfirm rejects forged, foreign and consumed payment evidence', () => {
  const planned = plannedOrder('bottle', { contractId: CONTRACT_ID, merchant: MERCHANT });
  const order = orderFromChain(planned.id, onChainPaid, { itemId: 'bottle' }, { contractId: CONTRACT_ID, merchant: MERCHANT });

  // Fabricated hash cannot settle: the parsed envelope must bind to it.
  const tx = signedPaymentTx(customer, planned.soroban.onChainId);
  assert.throws(() => statelessConfirm(order, { hash: 'f'.repeat(64), txStatus: 'SUCCESS', onchain: onChainPaid, envelopeXdr: tx.toXDR() }, { contractId: CONTRACT_ID }),
    /hash does not match/);

  // A different order's tx (different on-chain id) cannot settle this order.
  const foreignTx = signedPaymentTx(customer, 'b'.repeat(64));
  assert.throws(() => statelessConfirm(order, { hash: txHashHex(foreignTx), txStatus: 'SUCCESS', onchain: onChainPaid, envelopeXdr: foreignTx.toXDR() }, { contractId: CONTRACT_ID }),
    /not match the order intent/);

  // Paid-by-another envelope cannot settle under this order's payer identity.
  const wrongPayerTx = signedPaymentTx(other, planned.soroban.onChainId);
  assert.throws(() => statelessConfirm(order, { hash: txHashHex(wrongPayerTx), txStatus: 'SUCCESS', onchain: { ...onChainPaid, customer: other.publicKey() }, envelopeXdr: wrongPayerTx.toXDR() }, { contractId: CONTRACT_ID }),
    /not the authorized customer/);

  // Wrong-contract invocation is rejected (a different, valid contract id).
  const offContractTx = signedPaymentTx(customer, planned.soroban.onChainId, { contract: StrKey.encodeContract(Keypair.random().rawPublicKey()) });
  assert.throws(() => statelessConfirm(order, { hash: txHashHex(offContractTx), txStatus: 'SUCCESS', onchain: onChainPaid, envelopeXdr: offContractTx.toXDR() }, { contractId: CONTRACT_ID }),
    /wrong contract/);

  // Unpaid on-chain order: no fee without ledger truth.
  assert.throws(() => statelessConfirm(order, { hash: txHashHex(tx), txStatus: 'SUCCESS', onchain: onChainPending, envelopeXdr: tx.toXDR() }, { contractId: CONTRACT_ID }),
    /not paid/);

  // A SUCCESS claim without a parsable envelope fails closed.
  assert.throws(() => statelessConfirm(order, { hash: txHashHex(tx), txStatus: 'SUCCESS', onchain: onChainPaid, envelopeXdr: 'not-an-envelope' }, { contractId: CONTRACT_ID }),
    /parsable payment envelope/);
});

// ---- hosted HTTP glue (injected runtime; no network, no real secrets) ----

function fakeRuntime({ env = {}, service, withKeypair = false } = {}) {
  return {
    config: { contractId: env.STELLAR_CHECKOUT_CONTRACT_ID ?? CONTRACT_ID, passphrase: Networks.TESTNET, issuer: env.STELLAR_USDC_TESTNET_ISSUER ?? ISSUER, merchant: env.STELLAR_MERCHANT_ADDRESS ?? MERCHANT },
    operatorKeypair: withKeypair ? Keypair.random() : null,
    servicePromise: Promise.resolve(service),
    deploymentPromise: Promise.resolve({ contractId: CONTRACT_ID, token: `USDC:${ISSUER}`, merchant: MERCHANT })
  };
}

test('host glue: config exposes hosted capabilities', async () => {
  resetRuntime();
  const result = await handleApiRequest({
    url: 'https://enza.test/api/config', method: 'GET', headers: {}, env: {},
    runtime: fakeRuntime({})
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.network, 'Testnet');
  assert.equal(result.payload.configured, true);
  assert.equal(result.payload.capabilities.demoWallet, false);
  assert.equal(result.payload.operatorConfigured, false);
  assert.ok(result.payload.items.some(i => i.id === 'khakhra'));
});

test('host glue: origin mismatch on POST is rejected', async () => {
  resetRuntime();
  const result = await handleApiRequest({
    url: 'https://enza.test/api/orders', method: 'POST',
    headers: { origin: 'https://evil.example', host: 'enza.test' },
    env: {} , runtime: fakeRuntime({})
  });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /demo page hosted at this deployment/);
});

test('host glue: create requires the operator secret and fails closed without it', async () => {
  resetRuntime();
  const result = await handleApiRequest({
    url: 'https://enza.test/api/orders', method: 'POST',
    headers: { origin: 'https://enza.test', host: 'enza.test' },
    body: JSON.stringify({ itemId: 'bottle' }), env: {} , runtime: fakeRuntime({})
  });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /STELLAR_CHECKOUT_OPERATOR_SECRET/);
});

test('host glue: full create -> get -> confirm round trip on fake chain data', async () => {
  resetRuntime();
  const planned = plannedOrder('bottle', { contractId: CONTRACT_ID, merchant: MERCHANT });
  const tx = signedPaymentTx(customer, planned.soroban.onChainId);
  const hash = txHashHex(tx);
  let chainRecord = onChainPending;
  const service = {
    readOrder: async () => chainRecord,
    createOnChainOrder: async () => ({ hash: null }),
    getTransaction: async () => ({ status: 'SUCCESS', envelopeXdr: tx.toXDR() })
  };
  const headers = { origin: 'https://enza.test', host: 'enza.test' };

  const create = await handleApiRequest({
    url: 'https://enza.test/api/orders', method: 'POST', headers,
    body: JSON.stringify({ itemId: 'bottle' }),
    env: {} , runtime: fakeRuntime({ service, withKeypair: true })
  });
  assert.equal(create.status, 201);
  assert.equal(create.payload.status, 'pending');
  assert.equal(create.payload.amount, '5.0000000');
  assert.match(create.payload.soroban.onChainId, /^[0-9a-f]{64}$/);

  // Staged (creation pending) resolves honestly from the chain.
  chainRecord = onChainPending;
  const stagedService = {
    ...service,
    createOnChainOrder: async () => { throw new Error('On-chain order creation still pending'); }
  };
  const staged = await handleApiRequest({
    url: 'https://enza.test/api/orders', method: 'POST', headers,
    body: JSON.stringify({ itemId: 'bottle' }),
    env: {} , runtime: fakeRuntime({ service: stagedService, withKeypair: true })
  });
  assert.equal(staged.status, 201);
  assert.equal(staged.payload.status, 'staging');

  const got = await handleApiRequest({
    url: `https://enza.test/api/orders/${planned.id}`, method: 'GET',
    headers: {}, env: {} , runtime: fakeRuntime({ service })
  });
  assert.equal(got.status, 200);
  assert.equal(got.payload.status, 'pending');
  assert.equal(got.payload.itemId, null, 'bare GET carries display hints only from the browser');

  // Confirm against a paid chain record requires the real tx binding.
  chainRecord = onChainPaid;
  const confirmed = await handleApiRequest({
    url: `https://enza.test/api/orders/${planned.id}/confirm`, method: 'POST', headers,
    body: JSON.stringify({ hash, ref: { itemId: 'bottle', amount: '5.0000000', createdAt: planned.createdAt } }),
    env: {} , runtime: fakeRuntime({ service })
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.payload.status, 'paid');
  assert.equal(confirmed.payload.hash, hash);
  assert.equal(confirmed.payload.ticket, null, 'bottle orders carry no demo ticket');

  // Confirming with a fabricated hash fails.
  const forged = await handleApiRequest({
    url: `https://enza.test/api/orders/${planned.id}/confirm`, method: 'POST', headers,
    body: JSON.stringify({ hash: 'f'.repeat(64), ref: { itemId: 'bottle' } }),
    env: {} , runtime: fakeRuntime({ service })
  });
  assert.equal(forged.status, 400);
  assert.match(forged.payload.error, /hash does not match/);
});

test('host glue: demo wallet endpoints honestly unavailable and setups 501', async () => {
  resetRuntime();
  const result = await handleApiRequest({
    url: 'https://enza.test/api/demo-wallet/setup', method: 'POST',
    headers: {}, env: {} , runtime: fakeRuntime({})
  });
  assert.equal(result.status, 501);
  assert.match(result.payload.error, /local-server capability/);
});

test('host glue: unknown paths 404', async () => {
  resetRuntime();
  const result = await handleApiRequest({
    url: 'https://enza.test/api/nope', method: 'GET', headers: {}, env: {} , runtime: fakeRuntime({})
  });
  assert.equal(result.status, 404);
});

test('publicOrder mirrors the local server payload shape', () => {
  const planned = plannedOrder('bottle', { contractId: CONTRACT_ID, merchant: MERCHANT });
  const payload = publicOrder({ ...planned, status: 'pending' });
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['amount', 'createdAt', 'customer', 'explorer', 'expiresAt', 'failureReason', 'hash', 'id', 'itemId', 'kind', 'paidAt', 'soroban', 'status', 'ticket'].sort());
  assert.equal(payload.explorer, null);
});

test('randomUUID ids are valid order references', () => {
  assert.match(randomUUID(), UUID_PATTERN);
});


// ---- full hosted submit contract against a REAL service over a fake RPC ----
// The browser's exact payload is {signedXdr} only (demo.js payWithWallet);
// the payer identity must come from the verified signed envelope itself.
import { createCheckoutService, sacForIssuer } from '../soroban.js';

// Unsigned envelope: same structure but no signature (failure-path tests).
const unsignedEnvelope = (payerPubKey, onChainIdHex, contract = CONTRACT_ID) => {
  const args = [
    nativeToScVal(Buffer.from(onChainIdHex, 'hex'), { type: 'bytes' }),
    new Address(payerPubKey).toScVal()
  ];
  return new TransactionBuilder(new Account(payerPubKey, '123'), { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeContractFunction({ contract, function: 'pay_order', args }))
    .setTimeout(60)
    .build();
};

function fakeChainRuntime({ paidReadsFrom = null, txRecordFor = null, noOperator = false } = {}) {
  let reads = 0;
  // Keys mirror the contract's get_order fields exactly (expires_at, paid_at).
  const pending = { amount: 50000000n, customer: '', expires_at: future(600), paid: false, paid_at: 0n };
  const paidRecordFactory = payerKey => ({ amount: 50000000n, customer: payerKey, expires_at: future(600), paid: true, paid_at: future(-30) });
  const sends = [];
  const rpc = {
    getNetwork: async () => ({ passphrase: Networks.TESTNET }),
    getAccount: async pk => ({ accountId: pk, sequence: '123' }),
    sendTransaction: async tx => {
      const hash = Buffer.from(tx.hash()).toString('hex');
      sends.push(hash);
      return { status: 'PENDING', hash };
    },
    getTransaction: async hash => (txRecordFor && txRecordFor[hash]) || { status: 'PENDING' }
  };
  const client = {
    // First read is typically the pre-submit check; `paidReadsFrom` flips the
    // record to its paid variant for later reads (duplicate-submission tests).
    get_order: async () => {
      reads += 1;
      const usePaid = paidReadsFrom !== null && reads > paidReadsFrom;
      return { result: { tag: 'ok', value: usePaid ? paidRecordFactory(customer.publicKey()) : pending } };
    },
    token: async () => ({ result: { value: sacForIssuer(ISSUER) } }),
    merchant: async () => ({ result: { value: MERCHANT } }),
    admin: async () => ({ result: { value: other.publicKey() } }),
    create_order: async () => ({ signAndSend: async () => ({ getTransactionResponse: { status: 'SUCCESS', txHash: 'c'.repeat(64) } }) }),
    pay_order: async args => {
      const idHex = Buffer.from(args.order_id.value ?? args.order_id).toString('hex');
      return { built: { toXDR: () => unsignedEnvelope(args.customer, idHex).toXDR() } };
    }
  };
  const config = { contractId: CONTRACT_ID, issuer: ISSUER, merchant: MERCHANT, rpcUrl: 'https://fake.test', passphrase: Networks.TESTNET };
  const servicePromise = createCheckoutService(config, { rpcServer: rpc, client });
  return {
    config,
    operatorKeypair: noOperator ? null : Keypair.random(),
    servicePromise,
    deploymentPromise: servicePromise.then(s => s.assertDeployment()),
    sends
  };
}

test('host submit: exact browser payload {signedXdr} only — payer derived from the signed envelope', async () => {
  resetRuntime();
  const ID = '10111111-1111-4111-8111-111111111111';
  const tx = signedPaymentTx(customer, orderOnChainId(ID));
  const runtime = fakeChainRuntime({ txRecordFor: { [txHashHex(tx)]: { status: 'SUCCESS', envelopeXdr: tx.toXDR() } } });
  const result = await handleApiRequest({
    url: `https://enza.test/api/orders/${ID}/submit`, method: 'POST',
    headers: { origin: 'https://enza.test', host: 'enza.test' },
    body: JSON.stringify({ signedXdr: tx.toXDR() }), // exactly what demo.js payWithWallet sends
    env: {}, runtime
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.hash, txHashHex(tx));
  assert.equal(runtime.sends.length, 1);
});

test('host submit: missing envelope fails closed', async () => {
  resetRuntime();
  const ID = '20111111-1111-4111-8111-111111111111';
  const runtime = fakeChainRuntime();
  const result = await handleApiRequest({
    url: `https://enza.test/api/orders/${ID}/submit`, method: 'POST',
    headers: { origin: 'https://enza.test', host: 'enza.test' },
    body: JSON.stringify({ signedXdr: '' }), env: {}, runtime
  });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /Malformed signed payment envelope/);
});

test('host submit: browser payer claim that mismatches theSigned envelope fails closed', async () => {
  resetRuntime();
  const ID = '30111111-1111-4111-8111-111111111111';
  const tx = signedPaymentTx(other, orderOnChainId(ID));
  const result = await handleApiRequest({
    url: `https://enza.test/api/orders/${ID}/submit`, method: 'POST',
    headers: { origin: 'https://enza.test', host: 'enza.test' },
    body: JSON.stringify({ signedXdr: tx.toXDR(), customer: customer.publicKey() }), env: {}, runtime: fakeChainRuntime()
  });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /does not match the claimed customer/);
});

test('host submit: envelope for a different order id is rejected inside validation', async () => {
  resetRuntime();
  const OTHER_ORDER = '40111111-1111-4111-8111-111111111111';
  const claimedOrder = '50111111-1111-4111-8111-111111111111';
  const tx = signedPaymentTx(customer, orderOnChainId(OTHER_ORDER));
  const result = await handleApiRequest({
    url: `https://enza.test/api/orders/${claimedOrder}/submit`, method: 'POST',
    headers: { origin: 'https://enza.test', host: 'enza.test' },
    body: JSON.stringify({ signedXdr: tx.toXDR() }), env: {}, runtime: fakeChainRuntime()
  });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /not match the order intent/);
});

test('host submit: garbage signer bytes fail closed (signature does not verify)', async () => {
  resetRuntime();
  const ID = '60111111-1111-4111-8111-111111111111';
  const tx = unsignedEnvelope(customer.publicKey(), orderOnChainId(ID)); // built but UNsigned
  const result = await handleApiRequest({
    url: `https://enza.test/api/orders/${ID}/submit`, method: 'POST',
    headers: { origin: 'https://enza.test', host: 'enza.test' },
    body: JSON.stringify({ signedXdr: tx.toXDR() }), env: {}, runtime: fakeChainRuntime()
  });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /Signature does not verify|not the authorized/);
});

test('host submit: chain already paid short-circuits duplicate submission without sending', async () => {
  resetRuntime();
  const ID = '70111111-1111-4111-8111-111111111111';
  // get_order flips to paid after the first read: the first submit went
  // through, the second call must return alreadyPaid without a 2nd send.
  const tx = signedPaymentTx(customer, orderOnChainId(ID));
  const runtime = fakeChainRuntime({ paidReadsFrom: 1, txRecordFor: { [txHashHex(tx)]: { status: 'SUCCESS', envelopeXdr: tx.toXDR() } } });
  const first = await handleApiRequest({
    url: `https://enza.test/api/orders/${ID}/submit`, method: 'POST',
    headers: { origin: 'https://enza.test', host: 'enza.test' },
    body: JSON.stringify({ signedXdr: tx.toXDR() }), env: {}, runtime
  });
  assert.equal(first.status, 200);
  const second = await handleApiRequest({
    url: `https://enza.test/api/orders/${ID}/submit`, method: 'POST',
    headers: { origin: 'https://enza.test', host: 'enza.test' },
    body: JSON.stringify({ signedXdr: tx.toXDR() }), env: {}, runtime
  });
  assert.equal(second.status, 200);
  assert.equal(second.payload.alreadyPaid, true);
  assert.equal(runtime.sends.length, 1, 'no double submission');
});

test('host submit: failed transaction never marks paid and returns honest 400', async () => {
  resetRuntime();
  const ID = '80111111-1111-4111-8111-111111111111';
  const tx = signedPaymentTx(customer, orderOnChainId(ID));
  const runtime = fakeChainRuntime({ txRecordFor: { [txHashHex(tx)]: { status: 'FAILED', envelopeXdr: tx.toXDR() } } });
  const result = await handleApiRequest({
    url: `https://enza.test/api/orders/${ID}/submit`, method: 'POST',
    headers: { origin: 'https://enza.test', host: 'enza.test' },
    body: JSON.stringify({ signedXdr: tx.toXDR() }), env: {}, runtime
  });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /Transaction failed on-chain. No payment was recorded/);
});

test('host intent: staged envelope is built for exactly the requested customer address', async () => {
  resetRuntime();
  const ID = '90111111-1111-4111-8111-111111111111';
  const result = await handleApiRequest({
    url: `https://enza.test/api/orders/${ID}/intent`, method: 'POST',
    headers: { origin: 'https://enza.test', host: 'enza.test' },
    body: JSON.stringify({ customer: customer.publicKey() }), env: {}, runtime: fakeChainRuntime()
  });
  assert.equal(result.status, 200);
  const tx = TransactionBuilder.fromXDR(result.payload.xdr, Networks.TESTNET);
  assert.equal(tx.source, customer.publicKey(), 'envelope source is the requested customer');
  assert.equal(String(tx.operations[0].func.invokeContract.functionName), 'pay_order');
  assert.equal(result.payload.networkPassphrase, Networks.TESTNET);
});

test('host glue: intent and submit work WITHOUT an operator key on existing on-chain orders', async () => {
  resetRuntime();
  const ID = 'a0111111-1111-4111-8111-111111111111';
  const tx = signedPaymentTx(customer, orderOnChainId(ID));
  const runtime = fakeChainRuntime({
    noOperator: true,
    txRecordFor: { [txHashHex(tx)]: { status: 'SUCCESS', envelopeXdr: tx.toXDR() } }
  });
  // Purchase steps never sign with the admin key: intent staging builds the
  // envelope for the customer, and submit is the customer's own signature.
  const intent = await handleApiRequest({
    url: `https://enza.test/api/orders/${ID}/intent`, method: 'POST',
    headers: { origin: 'https://enza.test', host: 'enza.test' },
    body: JSON.stringify({ customer: customer.publicKey() }), env: {}, runtime
  });
  assert.equal(intent.status, 200);
  assert.equal(TransactionBuilder.fromXDR(intent.payload.xdr, Networks.TESTNET).source, customer.publicKey());
  const submitted = await handleApiRequest({
    url: `https://enza.test/api/orders/${ID}/submit`, method: 'POST',
    headers: { origin: 'https://enza.test', host: 'enza.test' },
    body: JSON.stringify({ signedXdr: tx.toXDR() }), env: {}, runtime
  });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.payload.hash, txHashHex(tx));
});

test('host glue: creating an order without an operator key fails explicitly before any write', async () => {
  resetRuntime();
  const runtime = fakeChainRuntime({ noOperator: true });
  const result = await handleApiRequest({
    url: 'https://enza.test/api/orders', method: 'POST',
    headers: { origin: 'https://enza.test', host: 'enza.test' },
    body: JSON.stringify({ itemId: 'bottle' }), env: {}, runtime
  });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /STELLAR_CHECKOUT_OPERATOR_SECRET/);
});

// ---- hosted diagnostics: honest bootstrap errors, names-only operator env
// keys, and a real bounded RPC reachability probe on /api/health ----
import { describeNetworkedError } from '../netlify/functions/lib/host.mjs';

test('host config: a bad contract-id override fails closed with a sanitized actionable bootstrapError', async () => {
  resetRuntime();
  const result = await handleApiRequest({
    url: 'https://enza.test/api/config', method: 'GET',
    headers: { origin: 'https://enza.test', host: 'enza.test' },
    env: { STELLAR_CHECKOUT_CONTRACT_ID: 'invalid-override' }, runtime: null
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.configured, false);
  assert.match(result.payload.bootstrapError, /STELLAR_CHECKOUT_CONTRACT_ID/);
  assert.equal(result.payload.hostedMode, 'serverless-stateless');
});

test('host config: operator env variable NAMES are reported (values never) so typos are spottable', async () => {
  resetRuntime();
  const result = await handleApiRequest({
    url: 'https://enza.test/api/config', method: 'GET',
    headers: { origin: 'https://enza.test', host: 'enza.test' },
    env: { STELLAR_CHECKOUT_OPERATOR_SECERT: 'SAAAA', COMMIT_REF: 'deadbeef' }, // typo on purpose
    runtime: fakeChainRuntime({ noOperator: true })
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.operatorEnvKeys, ['STELLAR_CHECKOUT_OPERATOR_SECERT']);
  assert.equal(result.payload.operatorConfigured, false);
  const serialized = JSON.stringify(result.payload);
  assert.ok(!serialized.includes('SAAAA'), 'no variable value may leak into the probe');
});

test('host health: bounded RPC probe classifies the real network failure without log access', async () => {
  resetRuntime();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  };
  try {
    const result = await handleApiRequest({
      url: 'https://enza.test/api/health', method: 'GET',
      headers: { origin: 'https://enza.test', host: 'enza.test' },
      env: {}, runtime: fakeChainRuntime()
    });
    assert.equal(result.status, 200);
    assert.equal(result.payload.rpc.reachable, false);
    assert.match(result.payload.rpc.error, /ENOTFOUND/);
    assert.match(result.payload.rpc.error, /outbound network failure/);
  } finally { globalThis.fetch = originalFetch; }
});

test('host health: reachable RPC answers honestly and operator state is included', async () => {
  resetRuntime();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true });
  try {
    const result = await handleApiRequest({
      url: 'https://enza.test/api/health', method: 'GET',
      headers: { origin: 'https://enza.test', host: 'enza.test' },
      env: {}, runtime: fakeChainRuntime()
    });
    assert.equal(result.payload.rpc.reachable, true);
    const blocked = await handleApiRequest({
      url: 'https://enza.test/api/health', method: 'GET',
      headers: { origin: 'https://enza.test', host: 'enza.test' },
      env: {}, runtime: fakeChainRuntime({ noOperator: true })
    });
    assert.equal(blocked.payload.operatorConfigured, false);
  } finally { globalThis.fetch = originalFetch; }
});

test('network diagnostics never echo key-shaped material from error messages', () => {
  const secret = 'S' + 'A'.repeat(55);
  const described = describeNetworkedError(new Error(`bad key ${secret} pair`));
  assert.ok(!described.includes(secret));
  assert.match(described, /\[redacted\]/);
  const chained = Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT', cause: { code: 'ECONNRESET' } } });
  assert.match(describeNetworkedError(chained), /UND_ERR_CONNECT_TIMEOUT > ECONNRESET/);
});
