import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrder, amountToUnits, unitsToAmount, configFromEnv } from '../payment.js';

test('orders are server-authoritative: deterministic catalog amount, unique memo, 15-minute window', () => {
  const order = createOrder('bottle');
  assert.equal(order.itemId, 'bottle');
  assert.equal(order.amount, '5.0000000');
  assert.equal(amountToUnits(order.amount), 50000000n);
  assert.equal(order.status, 'pending');
  assert.match(order.memo, /^[0-9a-f]{28}$/);
  assert.ok(Math.abs(Date.parse(order.expiresAt) - Date.parse(order.createdAt) - 15 * 60_000) <= 2, '15-minute expiry window');
  assert.throws(() => createOrder('nope'), /Unknown sample item/);
  const second = createOrder('bottle');
  assert.notEqual(second.id, order.id);
  assert.notEqual(second.memo, order.memo);
});

test('amounts round-trip in integer stroops without floating point', () => {
  for (const amount of ['0.0000001', '1.0000000', '12.5000000', '12345678.9012345']) {
    assert.equal(unitsToAmount(amountToUnits(amount)), amount);
  }
  assert.equal(amountToUnits('12.5'), 125000000n);
  assert.throws(() => amountToUnits('0.00000001'), /Invalid Stellar amount/);
});

test('demo configuration defaults to the verified Testnet identity and refuses malformed overrides', () => {
  const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  const MERCHANT = 'GDTOM5LLLQRUXHRJRU3ACK75IP7JDB7DS5LFX4AA6NHEDG6BKPTEEOX4';
  const good = {STELLAR_USDC_TESTNET_ISSUER: ISSUER, STELLAR_MERCHANT_ADDRESS: MERCHANT};
  assert.deepEqual(configFromEnv(good), {issuer: ISSUER, merchant: MERCHANT});
  // A clean clone with no environment yields the same verified identity.
  assert.deepEqual(configFromEnv({}), {issuer: ISSUER, merchant: MERCHANT});
  assert.throws(() => configFromEnv({STELLAR_USDC_TESTNET_ISSUER: 'nope', STELLAR_MERCHANT_ADDRESS: MERCHANT}), /public addresses/);
  assert.throws(() => configFromEnv({STELLAR_MERCHANT_ADDRESS: 'GAAAA'}), /public addresses/);
});
