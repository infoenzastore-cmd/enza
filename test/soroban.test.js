import test from 'node:test';
import assert from 'node:assert/strict';
import { Account, Address, Asset, Keypair, Networks, Operation, StrKey, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import {
  amountToUnits, assertDeployment, checkoutConfigFromEnv, orderOnChainId,
  parseOnChainOrder, sacForIssuer, validateSignedCheckoutTx, verifySorobanSettlement
} from '../soroban.js';
import { createOrder } from '../payment.js';

const CONTRACT_ID = 'CA4BAJTVSEU7NRRABUXRE22DZ35IBHFMITB3OMVG7JBYN2DM5VYKYDRP';
const TOKEN_ID = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const MERCHANT = 'GDTOM5LLLQRUXHRJRU3ACK75IP7JDB7DS5LFX4AA6NHEDG6BKPTEEOX4';
const CUSTOMER_SK = process.env.ENZA_TEST_CUSTOMER_SK ?? Keypair.random().secret();
const CUSTOMER = Keypair.fromSecret(CUSTOMER_SK).publicKey();
const config = {contractId: CONTRACT_ID, issuer: ISSUER, merchant: MERCHANT};

function baseOrder() {
  const order = createOrder('antidote');
  order.customer = CUSTOMER;
  order.createdAt = new Date(Date.now() - 60_000).toISOString();
  order.soroban = {onChainId: orderOnChainId(order.id), contractId: CONTRACT_ID, token: TOKEN_ID, merchant: MERCHANT};
  return order;
}

function baseEvidence(order, overrides = {}) {
  return {
    hash: 'a'.repeat(64),
    txStatus: 'SUCCESS',
    onchain: {
      amount: amountToUnits(order.amount),
      customer: CUSTOMER,
      expiresAt: BigInt(Math.floor(Date.parse(order.expiresAt) / 1000)),
      paid: true,
      paidAt: BigInt(Math.floor(Date.now() / 1000))
    },
    ...overrides
  };
}

test('successful payment confirms once and replays idempotently', () => {
  const order = baseOrder();
  const paid = verifySorobanSettlement(order, baseEvidence(order), new Set());
  assert.equal(paid.status, 'paid');
  assert.equal(paid.hash, 'a'.repeat(64));
  assert.match(paid.ticket, /^DEMO-/);
  const replay = verifySorobanSettlement(paid, baseEvidence(paid), new Set());
  assert.deepEqual(replay, paid);
});

test('rejects a wrong on-chain amount', () => {
  const order = baseOrder();
  assert.throws(
    () => verifySorobanSettlement(order, baseEvidence(order, {onchain: {...baseEvidence(order).onchain, amount: 20000000n}}), new Set()),
    /amount does not match/
  );
});

test('rejects a payer that is not the authorized customer', () => {
  const order = baseOrder();
  const stranger = Keypair.random().publicKey();
  assert.throws(
    () => verifySorobanSettlement(order, baseEvidence(order, {onchain: {...baseEvidence(order).onchain, customer: stranger}}), new Set()),
    /payer does not match/
  );
});

test('rejects payments recorded before creation or after expiry', () => {
  const order = baseOrder();
  const evidence = baseEvidence(order);
  assert.throws(
    () => verifySorobanSettlement(order, baseEvidence(order, {onchain: {...evidence.onchain, paidAt: 0n}}), new Set()),
    /before the order was created/
  );
  assert.throws(
    () => verifySorobanSettlement(order, baseEvidence(order, {onchain: {...evidence.onchain, paidAt: evidence.onchain.expiresAt + 1n}}), new Set()),
    /after the order expired/
  );
});

test('rejects an on-chain order that is not paid or a failed transaction', () => {
  const order = baseOrder();
  const evidence = baseEvidence(order);
  assert.throws(
    () => verifySorobanSettlement(order, baseEvidence(order, {onchain: {...evidence.onchain, paid: false}}), new Set()),
    /not paid/
  );
  assert.throws(
    () => verifySorobanSettlement(order, baseEvidence(order, {txStatus: 'FAILED'}), new Set()),
    /Transaction not successful/
  );
});

test('rejects unknown transaction hashes and an order without an intent', () => {
  const order = baseOrder();
  assert.throws(() => verifySorobanSettlement(order, baseEvidence(order, {hash: 'zz'}), new Set()), /Invalid transaction hash/);
  const noIntent = {...baseOrder(), soroban: null};
  assert.throws(() => verifySorobanSettlement(noIntent, baseEvidence(noIntent), new Set()), /no on-chain intent/);
});

test('rejects duplicate transaction hashes across orders and double fulfillment', () => {
  const order = baseOrder();
  assert.throws(() => verifySorobanSettlement(order, baseEvidence(order), new Set(['a'.repeat(64)])), /Transaction already used/);
  const paid = verifySorobanSettlement(order, baseEvidence(order), new Set());
  assert.throws(
    () => verifySorobanSettlement({...paid, status: 'paid', hash: 'b'.repeat(64)}, baseEvidence(paid, {hash: 'a'.repeat(64)}), new Set()),
    /Order is not pending/
  );
});

test('network and RPC failures surface and payments cannot be fabricated', () => {
  const order = baseOrder();
  assert.throws(() => verifySorobanSettlement(order, null, new Set()), /Invalid transaction hash/);
  assert.equal(parseOnChainOrder(null), null);
  assert.equal(parseOnChainOrder({tag: 'err'}), null);
  // A missing get_order response (RPC error, expired retention) cannot confirm payment.
  assert.throws(
    () => verifySorobanSettlement(order, baseEvidence(order, {onchain: null}), new Set()),
    /On-chain order is not paid/
  );
});

test('deployment integrity ties the issuer, SAC and merchant together', () => {
  assert.deepEqual(assertDeployment({token: TOKEN_ID, merchant: MERCHANT}, config), {contractId: CONTRACT_ID, token: TOKEN_ID, merchant: MERCHANT});
  assert.throws(() => assertDeployment({token: 'CBAD'.padEnd(56, 'A'), merchant: MERCHANT}, config), /issuer does not match/);
  assert.throws(() => assertDeployment({token: TOKEN_ID, merchant: Keypair.random().publicKey()}, config), /merchant does not match/);
  // A different asset code for the same issuer derivers to a different SAC.
  const eurcSAC = new Asset('EURC', ISSUER).contractId(Networks.TESTNET);
  assert.notEqual(sacForIssuer(ISSUER), eurcSAC);
});

test('checkout config falls back to documented public defaults and refuses malformed overrides', () => {
  // A clean clone with no environment at all yields the verified deployment.
  assert.deepEqual(checkoutConfigFromEnv({}), {
    contractId: CONTRACT_ID,
    issuer: ISSUER,
    merchant: MERCHANT,
    rpcUrl: 'https://soroban-testnet.stellar.org',
    passphrase: Networks.TESTNET
  });
  assert.throws(() => checkoutConfigFromEnv({STELLAR_CHECKOUT_CONTRACT_ID: "invalid"}), /contract ID/);
  assert.throws(() => checkoutConfigFromEnv({STELLAR_USDC_TESTNET_ISSUER: 'nope'}), /public addresses/);
  assert.throws(() => checkoutConfigFromEnv({STELLAR_MERCHANT_ADDRESS: 'GAAAA'}), /public addresses/);
  const parsed = checkoutConfigFromEnv({
    STELLAR_CHECKOUT_CONTRACT_ID: CONTRACT_ID,
    STELLAR_USDC_TESTNET_ISSUER: ISSUER,
    STELLAR_MERCHANT_ADDRESS: MERCHANT
  });
  assert.deepEqual(parsed, {contractId: CONTRACT_ID, issuer: ISSUER, merchant: MERCHANT, rpcUrl: 'https://soroban-testnet.stellar.org', passphrase: Networks.TESTNET});
});

test('deterministic correlation id and exact amount arithmetic', () => {
  const hex = orderOnChainId('one-uuid');
  assert.match(hex, /^[a-f0-9]{64}$/);
  assert.equal(orderOnChainId('one-uuid'), hex);
  assert.notEqual(orderOnChainId('two-uuid'), hex);
  assert.equal(amountToUnits('10.0000000'), 100000000n);
  assert.throws(() => amountToUnits('0.00000001'), /Invalid Stellar amount/);
});

function buildSignedCheckoutTx({source = CUSTOMER, payer = CUSTOMER, contractId = CONTRACT_ID, functionName = 'pay_order', onChainId, signingKey = CUSTOMER_SK, extraOp = null}) {
  const serverSeq = new Account(source, '1');
  const args = [
    xdr.ScVal.scvBytes(Buffer.from(onChainId, 'hex')),
    Address.fromString(payer).toScVal()
  ];
  const builder = new TransactionBuilder(serverSeq, {fee: '100', networkPassphrase: Networks.TESTNET})
    .addOperation(Operation.invokeContractFunction({contract: contractId, function: functionName, args}));
  if (extraOp) builder.addOperation(extraOp);
  const raw = builder.setTimeout(30).build();
  raw.sign(Keypair.fromSecret(signingKey));
  return TransactionBuilder.fromXDR(raw.toXDR(), Networks.TESTNET);
}

const OTHER_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 1));

test('the wallet-signed invocation must match the stored intent exactly', () => {
  const order = baseOrder();
  const ctx = {order, customerAddress: CUSTOMER, contractId: CONTRACT_ID, onChainId: order.soroban.onChainId};
  assert.doesNotThrow(() => validateSignedCheckoutTx(buildSignedCheckoutTx({onChainId: order.soroban.onChainId}), ctx));

  assert.throws(
    () => validateSignedCheckoutTx(buildSignedCheckoutTx({onChainId: order.soroban.onChainId, source: Keypair.random().publicKey()}), ctx),
    /source is not the authorized customer/
  );
  // A forged signature by anyone other than the customer is rejected before submission.
  assert.throws(
    () => validateSignedCheckoutTx(buildSignedCheckoutTx({onChainId: order.soroban.onChainId, signingKey: Keypair.random().secret()}), ctx),
    /Signature does not verify/
  );
  assert.throws(
    () => validateSignedCheckoutTx(buildSignedCheckoutTx({onChainId: order.soroban.onChainId, contractId: OTHER_CONTRACT}), ctx),
    /wrong contract/
  );
  assert.throws(
    () => validateSignedCheckoutTx(buildSignedCheckoutTx({onChainId: order.soroban.onChainId, functionName: 'create_order'}), ctx),
    /wrong contract function/
  );
  assert.throws(
    () => validateSignedCheckoutTx(buildSignedCheckoutTx({onChainId: 'f'.repeat(64)}), ctx),
    /does not match the order intent/
  );
  assert.throws(
    () => validateSignedCheckoutTx(buildSignedCheckoutTx({onChainId: order.soroban.onChainId, payer: Keypair.random().publicKey()}), ctx),
    /payer does not match/
  );
  assert.throws(
    () => validateSignedCheckoutTx(buildSignedCheckoutTx({onChainId: order.soroban.onChainId, extraOp: Operation.payment({destination: MERCHANT, asset: Asset.native(), amount: '1'})}), ctx),
    /Expected exactly one contract invocation/
  );
});

test('created intent converts and parses consistently', () => {
  const onchain = parseOnChainOrder({tag: 'ok', value: {amount: 100000000n, customer: CUSTOMER, expires_at: 1792979592n, paid: true, paid_at: 1792976012n}});
  assert.equal(onchain.amount, 100000000n);
  assert.equal(onchain.paid, true);
  assert.equal(onchain.paidAt, 1792976012n);
});
