import test from 'node:test';
import assert from 'node:assert/strict';
import { Account, Address, Asset, Keypair, Networks, Operation, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Route tests must never touch the operator's real demo store: point the
// server module at a throwaway directory imported for this process only.
process.env.ENZA_DATA_DIR = mkdtempSync(join(tmpdir(), 'enza-route-tests-'));
const { handleRequest, loadOrders } = await import('../server.js');
const { validateSignedCheckoutTx, verifySorobanSettlement } = await import('../soroban.js');

const CONTRACT_ID = 'CA4BAJTVSEU7NRRABUXRE22DZ35IBHFMITB3OMVG7JBYN2DM5VYKYDRP';
const TOKEN_ID = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const MERCHANT = 'GDTOM5LLLQRUXHRJRU3ACK75IP7JDB7DS5LFX4AA6NHEDG6BKPTEEOX4';

const CUSTOMER_SK = Keypair.random().secret();
const CUSTOMER = Keypair.fromSecret(CUSTOMER_SK).publicKey();
const OTHER_SK = Keypair.random().secret();

function fakeRequest(method, url, body, headers = {}) {
  const payload = body === undefined || body === null ? null : String(body);
  return {
    method, url,
    headers: { origin: 'http://127.0.0.1:3000', ...headers },
    async *[Symbol.asyncIterator]() { if (payload) yield payload; }
  };
}

function fakeResponse() {
  const state = { code: undefined, payload: undefined };
  return { state, writeHead(c) { state.code = c; }, end(b) { state.payload = b; } };
}

async function call(server, req) {
  const res = fakeResponse();
  const deps = {getCheckout: server.getCheckoutForDeps ?? (async () => server), demoWallet: server.demoWallet};
  await handleRequest(req, res, deps);
  return { code: res.state.code, json: res.state.payload ? JSON.parse(res.state.payload) : null };
}

const deployedCheckout = () => ({
  config: {contractId: CONTRACT_ID, issuer: ISSUER, merchant: MERCHANT, rpcUrl: 'https://soroban-testnet.stellar.org', passphrase: Networks.TESTNET},
  deployment: {contractId: CONTRACT_ID, token: TOKEN_ID, merchant: MERCHANT},
  service: null, // set per-test
  operatorKeypair: Keypair.random()
});

// Real-intent signature helpers so route tests exercise the actual validation path.
function unsignedIntent({source = CUSTOMER, payer = CUSTOMER, contractId = CONTRACT_ID, functionName = 'pay_order', onChainId, signWith = CUSTOMER_SK}) {
  const args = [xdr.ScVal.scvBytes(Buffer.from(onChainId, 'hex')), Address.fromString(payer).toScVal()];
  const tx = new TransactionBuilder(new Account(source, '1'), {fee: '100', networkPassphrase: Networks.TESTNET})
    .addOperation(Operation.invokeContractFunction({contract: contractId, function: functionName, args}))
    .setTimeout(30).build();
  tx.sign(Keypair.fromSecret(signWith));
  return tx.toXDR();
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

test('order creation persists intent, then the on-chain write, and never half-creates on failure', async () => {
  const service = {
    count: 0,
    async createOnChainOrder(order) { this.count++; assert.match(order.soroban.onChainId, /^[a-f0-9]{64}$/); }
  };
  const server = deployedCheckout(); server.service = service;
  const created = await call(server, fakeRequest('POST', '/api/orders', JSON.stringify({itemId: 'bottle'})));
  assert.equal(created.code, 201);
  assert.equal(created.json.status, 'pending');
  assert.equal(service.count, 1);
  const fetched = await call(server, fakeRequest('GET', `/api/orders/${created.json.id}`));
  assert.equal(fetched.json.amount, '5.0000000');

  const bad = await call(server, fakeRequest('POST', '/api/orders', JSON.stringify({itemId: 'nope'})));
  assert.equal(bad.code, 400);
  assert.match(bad.json.error, /Unknown sample item/);
  assert.equal(service.count, 1, 'no on-chain order for an unsupported product');

  const failing = deployedCheckout();
  failing.service = {async createOnChainOrder(order) { throw new Error('ledger rejected'); }};
  const failed = await call(failing, fakeRequest('POST', '/api/orders', JSON.stringify({itemId: 'bottle'})));
  assert.equal(failed.code, 400);
  const storedFailed = await call(failing, fakeRequest('GET', `/api/orders/${failed.json.id}`));
  assert.equal(storedFailed.json.status, 'failed');
  assert.match(storedFailed.json.failureReason, /ledger rejected/);
  // A failed order can never be resurrected by a stray confirmation.
  const resurrect = await call(failing, fakeRequest('POST', `/api/orders/${failed.json.id}/confirm`, JSON.stringify({hash: 'a'.repeat(64)})));
  assert.equal(resurrect.code, 400, 'a failed order cannot be confirmed into paid');
  const stillFailed = await call(failing, fakeRequest('GET', `/api/orders/${failed.json.id}`));
  assert.equal(stillFailed.json.status, 'failed');
});

test('malformed and oversized requests are rejected without touching the chain', async () => {
  let touched = false;
  const server = deployedCheckout();
  server.service = {async createOnChainOrder() { touched = true; }};
  const malformed = await call(server, fakeRequest('POST', '/api/orders', '{not-json'));
  assert.equal(malformed.code, 400);
  assert.ok(malformed.json.error && !touched);
  const oversized = await call(server, fakeRequest('POST', '/api/orders', 'x'.repeat(21000)));
  assert.match(oversized.json.error, /Request too large/);
  const unknown = await call(server, fakeRequest('GET', '/api/orders/not-a-uuid'));
  assert.equal(unknown.code, 404);
});

test('exact protocol: intent -> valid submission -> paid -> idempotent replay -> fabricated hash rejected', async () => {
  const server = deployedCheckout();
  server.service = {
    async createOnChainOrder() {},
    async buildUnsignedPayment(order, customer) {
      return {xdr: unsignedIntent({onChainId: order.soroban.onChainId, payer: customer}), networkPassphrase: Networks.TESTNET};
    },
    // Mirrors the real service contract: parse, hash-reuse check, intent validation.
    async submitSignedPayment({order, customerAddress, signedXdr, usedHashes}) {
      const tx = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
      const hash = Buffer.from(tx.hash()).toString('hex');
      if (usedHashes.has(hash)) throw new Error('Transaction already used');
      validateSignedCheckoutTx(tx, {order, customerAddress, contractId: CONTRACT_ID, onChainId: order.soroban.onChainId});
      return {hash, txStatus: 'SUCCESS'};
    },
    async readOrder(onChainId) {
      return {amount: 50000000n, customer: CUSTOMER, expiresAt: BigInt(nowSeconds() + 900), paid: true, paidAt: BigInt(nowSeconds())};
    },
    async getTransaction(hash) { return {status: 'SUCCESS'}; }
  };
  const created = await call(server, fakeRequest('POST', '/api/orders', JSON.stringify({itemId: 'bottle'})));
  const id = created.json.id;
  const onChainId = created.json.soroban.onChainId;

  const intent = await call(server, fakeRequest('POST', `/api/orders/${id}/intent`, JSON.stringify({customer: CUSTOMER})));
  assert.equal(intent.code, 200);
  // once assigned to a customer, no other payer can take the order over
  const hijack = await call(server, fakeRequest('POST', `/api/orders/${id}/intent`, JSON.stringify({customer: Keypair.random().publicKey()})));
  assert.equal(hijack.code, 400);
  assert.match(hijack.json.error, /already assigned/);

  const forged = await call(server, fakeRequest('POST', `/api/orders/${id}/submit`, JSON.stringify({signedXdr: unsignedIntent({onChainId, signWith: OTHER_SK})})));
  assert.match(forged.json.error, /Signature does not verify/);
  const wrongOrder = await call(server, fakeRequest('POST', `/api/orders/${id}/submit`, JSON.stringify({signedXdr: unsignedIntent({onChainId: 'f'.repeat(64)})})));
  assert.match(wrongOrder.json.error, /does not match the order intent/);

  const submitted = await call(server, fakeRequest('POST', `/api/orders/${id}/submit`, JSON.stringify({signedXdr: intent.json.xdr})));
  assert.equal(submitted.code, 200);
  const again = await call(server, fakeRequest('POST', `/api/orders/${id}/submit`, JSON.stringify({signedXdr: intent.json.xdr})));
  assert.deepEqual(again.json, {alreadySubmitted: true, hash: submitted.json.hash});

  // submission alone never fulfills: the order is still pending before on-chain verification
  const afterSubmit = await call(server, fakeRequest('GET', `/api/orders/${id}`));
  assert.equal(afterSubmit.json.status, 'pending', 'a submitted tx does not mark the order paid by itself');

  const paid = await call(server, fakeRequest('POST', `/api/orders/${id}/confirm`, JSON.stringify({hash: submitted.json.hash})));
  assert.equal(paid.json.status, 'paid');
  assert.match(paid.json.explorer, /stellar\.expert\/explorer\/testnet\/tx\//);
  const replay = await call(server, fakeRequest('POST', `/api/orders/${id}/confirm`, JSON.stringify({hash: submitted.json.hash})));
  assert.equal(replay.json.status, 'paid', 'confirmation replay stays idempotent');
  const fabricated = await call(server, fakeRequest('POST', `/api/orders/${id}/confirm`, JSON.stringify({hash: 'b'.repeat(64)})));
  assert.match(fabricated.json.error, /Hash does not match this order/);
});

test('no fulfillment before verified settlement: unpaid contract state or failed tx cannot pay', async () => {
  const server = deployedCheckout();
  let paidUp = false;
  server.service = {
    async createOnChainOrder() {},
    async buildUnsignedPayment(order, customer) { return {xdr: unsignedIntent({onChainId: order.soroban.onChainId, payer: customer}), networkPassphrase: Networks.TESTNET}; },
    async submitSignedPayment() { return {hash: 'c'.repeat(64), txStatus: paidUp ? 'SUCCESS' : 'FAILED'}; },
    async readOrder(onChainId) { return {amount: 50000000n, customer: CUSTOMER, expiresAt: BigInt(nowSeconds() + 900), paid: paidUp, paidAt: BigInt(nowSeconds())}; },
    async getTransaction(hash) { return {status: paidUp ? 'SUCCESS' : 'FAILED'}; }
  };
  const created = await call(server, fakeRequest('POST', '/api/orders', JSON.stringify({itemId: 'bottle'})));
  const id = created.json.id;
  await call(server, fakeRequest('POST', `/api/orders/${id}/intent`, JSON.stringify({customer: CUSTOMER})));
  const failedSubmit = await call(server, fakeRequest('POST', `/api/orders/${id}/submit`, JSON.stringify({signedXdr: unsignedIntent({onChainId: created.json.soroban.onChainId})})));
  assert.match(failedSubmit.json.error, /No payment was recorded/);
  const after = await call(server, fakeRequest('GET', `/api/orders/${id}`));
  assert.equal(after.json.status, 'pending', 'failed transaction never marks paid');

  // transaction succeeded but the on-chain order is not yet paid (ledger race / reversed read)
  const confirmedWhileUnpaid = await (async () => {
    try { return await call(server, fakeRequest('POST', `/api/orders/${id}/confirm`, JSON.stringify({hash: 'c'.repeat(64)}))); }
    catch (e) { return {code: 400, json: {error: e.message}}; }
  })();
  assert.match(String(confirmedWhileUnpaid.json?.error || ''), /On-chain order is not paid|does not match this order/);
  const finalState = await call(server, fakeRequest('GET', `/api/orders/${id}`));
  assert.equal(finalState.json.status, 'pending');
});

test('two simultaneous demo-rail payments share one submission and cannot double-charge', async () => {
  const server = deployedCheckout();
  let submits = 0;
  server.service = {
    async createOnChainOrder() {},
    async buildUnsignedPayment(order, customer) {
      await new Promise(r => setTimeout(r, 25));
      return {xdr: unsignedIntent({onChainId: order.soroban.onChainId, payer: customer}), networkPassphrase: Networks.TESTNET};
    },
    async submitSignedPayment(a) { submits++; await new Promise(r => setTimeout(r, 40)); return {hash: 'd'.repeat(64), txStatus: 'SUCCESS'}; },
    async readOrder(onChainId) { return {amount: 50000000n, customer: CUSTOMER, expiresAt: BigInt(nowSeconds() + 900), paid: true, paidAt: BigInt(nowSeconds())}; },
    async getTransaction(hash) { return {status: 'SUCCESS'}; }
  };
  const created = await call(server, fakeRequest('POST', '/api/orders', JSON.stringify({itemId: 'bottle'})));
  const id = created.json.id;
  const fakeWallet = {
    address: CUSTOMER,
    async setup() {}, async ensureFunds() {}, async balances() { return {ready: true, usdc: '15.0000000', xlm: '10.0000000'}; },
    signTransaction(xdr, passphrase) {
      const tx = TransactionBuilder.fromXDR(xdr, passphrase); tx.sign(Keypair.fromSecret(CUSTOMER_SK)); return tx.toXDR();
    }
  };
  server.demoWallet = fakeWallet;
  const one = call(server, fakeRequest('POST', `/api/orders/${id}/pay`, '{}'));
  const two = call(server, fakeRequest('POST', `/api/orders/${id}/pay`, '{}'));
  const [a, b] = await Promise.all([one, two]);
  assert.equal(a.json.hash, 'd'.repeat(64));
  assert.deepEqual(b.json, a.json);
  assert.equal(submits, 1, 'the same order was submitted exactly once');
  const paid = await call(server, fakeRequest('POST', `/api/orders/${id}/confirm`, JSON.stringify({hash: 'd'.repeat(64)})));
  assert.equal(paid.json.status, 'paid');
  const final = await call(server, fakeRequest('GET', `/api/orders/${id}`));
  assert.equal(final.json.status, 'paid');
  // a second /pay cannot charge again
  const repaid = await call(server, fakeRequest('POST', `/api/orders/${id}/pay`, '{}'));
  assert.equal(repaid.json.hash, 'd'.repeat(64));
  assert.equal(submits, 1, 'no second submission after the order has a hash');
});

test('a successful transaction may never settle two different orders (hash reuse)', () => {
  const build = () => { const o = {id: randomUUID(), amount: '5.0000000', status: 'pending', createdAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 900000).toISOString(), customer: CUSTOMER, hash: null, soroban: {onChainId: 'e'.repeat(64)}}; return o; };
  const first = verifySorobanSettlement(build(), {hash: 'a'.repeat(64), txStatus: 'SUCCESS', onchain: {amount: 50000000n, customer: CUSTOMER, expiresAt: BigInt(nowSeconds() + 900), paid: true, paidAt: BigInt(nowSeconds())}}, new Set());
  assert.equal(first.status, 'paid');
  assert.throws(
    () => verifySorobanSettlement(build(), {hash: 'a'.repeat(64), txStatus: 'SUCCESS', onchain: {amount: 50000000n, customer: CUSTOMER, expiresAt: BigInt(nowSeconds() + 900), paid: true, paidAt: BigInt(nowSeconds())}}, new Set(['a'.repeat(64)])),
    /Transaction already used/
  );
});

test('corrupt or missing order storage quarantines instead of crashing', () => {
  const corrupt = { exists: () => true, read: () => '{orders:[broken' };
  const missing = { exists: () => false };
  const arrayStore = { exists: () => true, read: () => '[1,2,3]' };
  assert.deepEqual(loadOrders('file:///tmp/orders1.json', corrupt), {});
  assert.deepEqual(loadOrders('file:///tmp/orders2.json', missing), {});
  assert.deepEqual(loadOrders('file:///tmp/orders3.json', arrayStore), {}, 'non-object stores are treated as empty');
});

test('origin shield allows loopback aliases and rejects foreign origins; it is not authentication', async () => {
  const server = deployedCheckout();
  server.service = {async createOnChainOrder() {}};
  const localhost = await call(server, fakeRequest('POST', '/api/orders', JSON.stringify({itemId: 'bottle'}), {origin: 'http://localhost:3000'}));
  assert.equal(localhost.code, 201, 'localhost aliases the loopback origin');
  const foreign = await call(server, fakeRequest('POST', '/api/orders', JSON.stringify({itemId: 'bottle'}), {origin: 'https://evil.example'}));
  assert.equal(foreign.code, 400);
  const noOrigin = await call(server, fakeRequest('POST', '/api/orders', JSON.stringify({itemId: 'bottle'}), {origin: undefined}));
  assert.equal(noOrigin.code, 201, 'loopback tools without browser origins stay usable');
});
