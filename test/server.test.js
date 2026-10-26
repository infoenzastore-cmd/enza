import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep test writes out of the operator's real demo store.
process.env.ENZA_DATA_DIR = mkdtempSync(join(tmpdir(), 'enza-server-tests-'));
const { handleRequest, loadOrders } = await import('../server.js');

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const MERCHANT = 'GDTOM5LLLQRUXHRJRU3ACK75IP7JDB7DS5LFX4AA6NHEDG6BKPTEEOX4';
const CONTRACT = 'CA4BAJTVSEU7NRRABUXRE22DZ35IBHFMITB3OMVG7JBYN2DM5VYKYDRP';

function response() {
  let code, payload;
  return {
    get code() { return code; },
    get payload() { return payload; },
    writeHead(status) { code = status; },
    end(body) { payload = body; }
  };
}

function withEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  Object.assign(process.env, env);
  return Promise.resolve(fn()).finally(() => {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

test('public demo config exposes exact Testnet payment details and checkout config', async () => {
  await withEnv({
    STELLAR_USDC_TESTNET_ISSUER: ISSUER,
    STELLAR_MERCHANT_ADDRESS: MERCHANT,
    STELLAR_CHECKOUT_CONTRACT_ID: CONTRACT,
    STELLAR_CHECKOUT_OPERATOR_SECRET: 'SBDEMOKEYPLACEHOLDER000000000000000000000000000000000000000'
  }, async () => {
    const res = response();
    await handleRequest({method: 'GET', url: '/api/config'}, res);
    const config = JSON.parse(res.payload);
    assert.equal(res.code, 200);
    assert.equal(config.network, 'Testnet');
    assert.equal(config.configured, true);
    assert.equal(config.issuer, ISSUER);
    assert.equal(config.merchant, MERCHANT);
    assert.equal(config.operatorConfigured, true);
    assert.equal(config.checkout.contractId, CONTRACT);
    assert.deepEqual(config.checkout.networkPassphrase, 'Test SDF Network ; September 2015');
    assert.deepEqual(config.items.map(item => item.id), ['bottle', 'antidote', 'khakhra']);
    // No secret material may ever appear in the public config.
    assert.ok(!res.payload.toLowerCase().includes('secret'));
  });
});

test('order creation refuses to run without the operator key and never half-creates an order', async () => {
  const res = response();
  // The deployment-integrity-aware service runs fine without the secret;
  // only order creation requires it, so the checkout object pretends exactly
  // that state and the route must fail BEFORE any store write.
  await handleRequest(
    {method: 'POST', url: '/api/orders', headers: {}, async *[Symbol.asyncIterator]() {}},
    res,
    {getCheckout: async () => ({config: {issuer: ISSUER, merchant: MERCHANT}, deployment: {}, service: null, operatorKeypair: null})}
  );
  assert.equal(res.code, 400);
  assert.match(JSON.parse(res.payload).error, /operator/i);
  assert.equal(Object.keys(loadOrders()).length, 0);
});

test('clean clone with an empty environment: public config verified, operator still absent', async () => {
  await withEnv({
    STELLAR_USDC_TESTNET_ISSUER: '',
    STELLAR_MERCHANT_ADDRESS: '',
    STELLAR_CHECKOUT_CONTRACT_ID: '',
    STELLAR_CHECKOUT_RPC_URL: '',
    STELLAR_RPC_URL: '',
    STELLAR_CHECKOUT_OPERATOR_SECRET: ''
  }, async () => {
    const res = response();
    await handleRequest({method: 'GET', url: '/api/config'}, res);
    const config = JSON.parse(res.payload);
    assert.equal(res.code, 200);
    // The documented public Testnet identity is served without configuration…
    assert.equal(config.configured, true);
    assert.equal(config.issuer, ISSUER);
    assert.equal(config.merchant, MERCHANT);
    assert.equal(config.checkout.contractId, CONTRACT);
    // …but creating orders still honestly requires the operator secret.
    assert.equal(config.operatorConfigured, false);
    // No secret material may ever appear in the public config.
    assert.ok(!res.payload.toLowerCase().includes('secret'));
  });
});
