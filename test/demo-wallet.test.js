import test from 'node:test';
import assert from 'node:assert/strict';
import { Account, Address, Account as _A, Keypair, Networks, Operation, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { createDemoWallet } from '../demo-wallet.js';
import { createOrder } from '../payment.js';
import { orderOnChainId, validateSignedCheckoutTx } from '../soroban.js';

const CONTRACT_ID = 'CA4BAJTVSEU7NRRABUXRE22DZ35IBHFMITB3OMVG7JBYN2DM5VYKYDRP';

function stagedIntentXdr(customer, onChainId) {
  const account = new Account(customer, '1');
  const tx = new TransactionBuilder(account, {fee: '100', networkPassphrase: Networks.TESTNET})
    .addOperation(Operation.invokeContractFunction({
      contract: CONTRACT_ID, function: 'pay_order',
      args: [xdr.ScVal.scvBytes(Buffer.from(onChainId, 'hex')), Address.fromString(customer).toScVal()]
    }))
    .setTimeout(30).build();
  return tx.toXDR();
}

test('disposable demo wallet funds, trusts USDC, and signs the exact staged intent', async () => {
  const issuer = Keypair.random().publicKey();
  const CONTRACT_ID_LOCAL = CONTRACT_ID;
  let funded = false, trusted = false, friendbotCalls = 0, trustSubmissions = 0;
  const account = (address, balances) => Object.assign(new Account(address, '1'), {balances});
  const horizon = {
    async loadAccount(address) {
      if (!funded) throw Error('Account not found');
      return account(address, [
        {asset_type: 'native', balance: '100.0000000'},
        ...(trusted ? [{asset_code: 'USDC', asset_issuer: issuer, balance: '15.0000000'}] : [])
      ]);
    },
    async submitTransaction(tx) {
      assert.equal(tx.operations[0].type, 'changeTrust');
      assert.equal(tx.operations[0].line.issuer, issuer);
      trustSubmissions++;
      trusted = true;
      return {hash: 'a'.repeat(64)};
    }
  };
  const wallet = createDemoWallet({horizon, async fund(address) { assert.equal(address, wallet.address); friendbotCalls++; funded = true; }});
  assert.equal((await wallet.balances(issuer)).ready, false);
  await Promise.all([wallet.setup(issuer), wallet.setup(issuer)]);
  assert.equal(friendbotCalls, 1);
  assert.equal(trustSubmissions, 1);
  assert.equal((await wallet.balances(issuer)).usdc, '15.0000000');

  const order = createOrder('bottle');
  order.soroban = {onChainId: orderOnChainId(order.id), contractId: CONTRACT_ID_LOCAL};
  await wallet.ensureFunds(order, issuer);
  const stagedXdr = stagedIntentXdr(wallet.address, order.soroban.onChainId);
  const signedXdr = wallet.signTransaction(stagedXdr, Networks.TESTNET);
  const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
  assert.equal(signed.source, wallet.address);
  assert.equal(signed.signatures.length, 1);
  assert.doesNotThrow(() => validateSignedCheckoutTx(signed, {order, customerAddress: wallet.address, contractId: CONTRACT_ID_LOCAL, onChainId: order.soroban.onChainId}));
  // Serialization cannot leak the signing key: only public members survive.
  assert.deepEqual(JSON.parse(JSON.stringify(wallet)), {address: wallet.address, isReady: true});
});

test('demo wallet refuses payment without funds and refuses to sign before setup', async () => {
  const issuer = Keypair.random().publicKey();
  const wallet = createDemoWallet({horizon: {
    async loadAccount(address) {
      return Object.assign(new Account(address, '1'), {balances: [
        {asset_type: 'native', balance: '1.0000000'},
        {asset_code: 'USDC', asset_issuer: issuer, balance: '0.0000000'}
      ]});
    },
    async submitTransaction() { throw new Error('unexpected submission'); }
  }});
  const order = createOrder('antidote');
  await assert.rejects(async () => wallet.signTransaction(stagedIntentXdr(wallet.address, orderOnChainId(order.id)), Networks.TESTNET), /Prepare the demo wallet first/);
  await wallet.setup(issuer);
  await assert.rejects(() => wallet.ensureFunds(order, issuer), /needs 10.0000000 Testnet USDC/);
});
