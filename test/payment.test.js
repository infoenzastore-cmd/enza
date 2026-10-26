import test from 'node:test';
import assert from 'node:assert/strict';
import { Account, Asset, Keypair, Memo, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { createOrder, verifyPayment, amountToUnits, validateSignedPayment } from '../payment.js';

const hash = 'a'.repeat(64);
const issuer = 'GISSUER';
const merchant = 'GMERCHANT';

function fixture() {
  const order = createOrder('antidote');
  const tx = {
    hash,
    successful: true,
    memo_type: 'text',
    memo: order.memo,
    created_at: new Date().toISOString()
  };
  const ops = [{
    type: 'payment',
    to: merchant,
    asset_code: 'USDC',
    asset_issuer: issuer,
    amount: order.amount
  }];
  return { order, tx, ops };
}

test('exact payment creates one demo ticket and repeated confirmation is stable', () => {
  const { order, tx, ops } = fixture();
  const paid = verifyPayment(order, hash, tx, ops, { issuer, merchant }, new Set());
  assert.equal(paid.status, 'paid');
  assert.match(paid.ticket, /^DEMO-/);
  assert.deepEqual(verifyPayment(paid, hash, tx, ops, { issuer, merchant }, new Set([hash])), paid);
});

test('rejects wrong asset, amount, destination, memo, failed and duplicate transaction', () => {
  for (const changed of [
    { ops: [{ asset_issuer: 'other' }] },
    { ops: [{ amount: '1.0000000' }] },
    { ops: [{ to: 'other' }] },
    { tx: { memo: 'other' } },
    { tx: { successful: false } },
    { used: new Set([hash]) }
  ]) {
    const { order, tx, ops } = fixture();
    Object.assign(tx, changed.tx);
    if (changed.ops) Object.assign(ops[0], changed.ops[0]);
    assert.throws(() => verifyPayment(order, hash, tx, ops, { issuer, merchant }, changed.used || new Set()));
  }
});

test('rejects transactions outside the order validity window', () => {
  const { order, tx, ops } = fixture();
  tx.created_at = new Date(Date.parse(order.createdAt) - 1000).toISOString();
  assert.throws(() => verifyPayment(order, hash, tx, ops, { issuer, merchant }, new Set()));
  tx.created_at = new Date(Date.parse(order.expiresAt) + 1000).toISOString();
  assert.throws(() => verifyPayment(order, hash, tx, ops, { issuer, merchant }, new Set()));
});

test('rejects multiple operations even when one payment matches', () => {
  const { order, tx, ops } = fixture();
  assert.throws(() => verifyPayment(order, hash, tx, [...ops, { type: 'payment', to: 'GOTHER' }], { issuer, merchant }, new Set()));
});

test('rejects malformed timestamps', () => {
  const { order, tx, ops } = fixture();
  tx.created_at = 'not-a-date';
  assert.throws(() => verifyPayment(order, hash, tx, ops, { issuer, merchant }, new Set()));
});

test('rejects expired order and non-pending order', () => {
  const { order, tx, ops } = fixture();
  order.expiresAt = '2020-01-01T00:00:00Z';
  assert.throws(() => verifyPayment(order, hash, tx, ops, { issuer, merchant }, new Set()));
  const paid = { ...order, status: 'paid', hash: 'b'.repeat(64) };
  assert.throws(() => verifyPayment(paid, hash, tx, ops, { issuer, merchant }, new Set()));
});

test('amounts use integer stroops', () => {
  assert.equal(amountToUnits('12.5000000'), 125000000n);
  assert.throws(() => amountToUnits('0.00000001'));
});

test('parsed Stellar XDR preserves payment details and decodes memo bytes', () => {
 const order=createOrder('bottle');
 const source=Keypair.random().publicKey(),destination=Keypair.random().publicKey(),assetIssuer=Keypair.random().publicKey();
 const config={merchant:destination,issuer:assetIssuer};
 const account=new Account(source,'1');
 const makeXdr=(amount,memo)=>new TransactionBuilder(account,{fee:'100',networkPassphrase:Networks.TESTNET})
  .addOperation(Operation.payment({destination,asset:new Asset('USDC',assetIssuer),amount}))
  .addMemo(Memo.text(memo)).setTimeout(60).build().toXDR();
 const parse=xdr=>TransactionBuilder.fromXDR(xdr,Networks.TESTNET);
 assert.doesNotThrow(()=>validateSignedPayment(parse(makeXdr(order.amount,order.memo)),order,config));
 assert.throws(()=>validateSignedPayment(parse(makeXdr('11.0000000',order.memo)),order,config),/details changed/);
 assert.throws(()=>validateSignedPayment(parse(makeXdr(order.amount,'wrong')),order,config),/does not match/);
});
