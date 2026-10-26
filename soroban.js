import { createHash } from 'node:crypto';
import { Asset, Keypair, Networks, StrKey, TransactionBuilder, contract as contractNs, rpc } from '@stellar/stellar-sdk';
import { PUBLIC_TESTNET_DEFAULTS } from './stellar-defaults.js';

// Soroban Testnet rail for the ENZA checkout, bound to the verified deployment
// recorded in contracts/deployments/testnet-2026-10-26.md.
// Pubnet is never configurable: the network passphrase below refuses anything else.
export const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org';
export const TESTNET_PASSPHRASE = Networks.TESTNET;
export const USDC_TESTNET_CODE = 'USDC';

const CONTRACT_ID_PATTERN = /^C[ABCDEFGHIJKLMNOPQRSTUVWXYZ234567]{55}$/;

// Deterministic correlation value between the ecommerce order UUID and the
// contract's bytes32 order id (SHA-256 of the UUID, rendered as hex).
export function orderOnChainId(orderId) {
  return createHash('sha256').update(orderId).digest('hex');
}

export const onChainIdBytes = hex => Buffer.from(hex, 'hex');

export function sacForIssuer(issuer) {
  // The USDC Testnet asset's deterministic Stellar Asset Contract id.
  return new Asset(USDC_TESTNET_CODE, issuer).contractId(TESTNET_PASSPHRASE);
}

// Public Testnet identity defaults to the verified deployment record; an env
// override must still be well-formed. Whatever identity is in effect is
// re-verified against the live chain at every startup (assertDeployment) —
// a malformed or stale public value fails closed, never a wrong payment.
export function checkoutConfigFromEnv(env=process.env) {
  const contractId=env.STELLAR_CHECKOUT_CONTRACT_ID || PUBLIC_TESTNET_DEFAULTS.contractId;
  if (!CONTRACT_ID_PATTERN.test(contractId)) throw new Error('The STELLAR_CHECKOUT_CONTRACT_ID override is not a valid Soroban contract ID');
  const issuer=env.STELLAR_USDC_TESTNET_ISSUER || PUBLIC_TESTNET_DEFAULTS.issuer, merchant=env.STELLAR_MERCHANT_ADDRESS || PUBLIC_TESTNET_DEFAULTS.merchant;
  if (!StrKey.isValidEd25519PublicKey(issuer) || !StrKey.isValidEd25519PublicKey(merchant)) throw new Error('The issuer and merchant overrides must be valid Testnet public addresses');
  const rpcUrl=env.STELLAR_RPC_URL || TESTNET_RPC_URL;
  return {contractId, issuer, merchant, rpcUrl, passphrase: TESTNET_PASSPHRASE};
}

// Deployment integrity: the on-chain token contract must be exactly the SAC
// derived from the configured USDC issuer on this network, and the merchant
// must match the configured address. Asset identity is checked by issuer, never
// by the "USDC" symbol alone.
export function assertDeployment(onChain, config) {
  const expectedToken = sacForIssuer(config.issuer);
  if (onChain.token !== expectedToken) throw new Error(`Configured issuer does not match the deployed checkout token (${expectedToken} != ${onChain.token})`);
  if (onChain.merchant !== config.merchant) throw new Error(`Configured merchant does not match the deployed checkout merchant (${config.merchant} != ${onChain.merchant})`);
  return {contractId: config.contractId, token: onChain.token, merchant: onChain.merchant};
}

// Pure settlement verification: an order only becomes paid when the on-chain
// order (read by its correlation id) shows the exact expected amount paid by the
// authorized customer inside the order window, backed by a successful final
// transaction whose hash has not been used before.
export function verifySorobanSettlement(order, evidence, usedHashes) {
  const {hash, txStatus, onchain} = evidence || {};
  if (!/^[a-f0-9]{64}$/i.test(hash ?? '')) throw new Error('Invalid transaction hash');
  if (order.status==='paid' && order.hash===hash) return order; // idempotent replay
  if (order.status!=='pending') throw new Error('Order is not pending');
  if (usedHashes.has(hash)) throw new Error('Transaction already used');
  if (!order.soroban?.onChainId || order.soroban.onChainId.length!==64) throw new Error('Order has no on-chain intent');
  if (txStatus!=='SUCCESS') throw new Error('Transaction not successful');
  if (!onchain || !onchain.paid) throw new Error('On-chain order is not paid');
  if (onchain.amount !== amountToUnits(order.amount)) throw new Error('On-chain amount does not match the order');
  if (onchain.customer !== order.customer) throw new Error('On-chain payer does not match the authorized customer');
  const paidAt=Number(onchain.paidAt), expiresAt=Number(onchain.expiresAt), createdAt=Date.parse(order.createdAt);
  if (!Number.isFinite(paidAt) || !Number.isFinite(expiresAt) || !Number.isFinite(createdAt)) throw new Error('Invalid on-chain timestamps');
  if (paidAt < Math.floor(createdAt/1000) - 60) throw new Error('Payment recorded before the order was created');
  if (paidAt > expiresAt) throw new Error('Payment recorded after the order expired');
  return {...order, status:'paid', hash, paidAt: new Date(paidAt*1000).toISOString(), ticket: order.kind==='event' ? `DEMO-${order.id.slice(0,8)}` : null};
}

// Validates a wallet-signed transaction against the stored intent before the
// server will submit it. The sender must be the customer recorded at intent
// time, and the invocation must target the configured contract's pay_order with
// exactly the intended correlation id and customer.
export function validateSignedCheckoutTx(tx, {order, customerAddress, contractId, onChainId: expectedId}) {
  if (tx.source !== customerAddress) throw new Error('Transaction source is not the authorized customer');
  if (!hasAuthorizedSignature(tx, customerAddress)) throw new Error('Signature does not verify for the authorized customer');
  const ops=tx.operations;
  if (!Array.isArray(ops) || ops.length!==1 || ops[0].type!=='invokeHostFunction') throw new Error('Expected exactly one contract invocation');
  const invocation=ops[0].func?.invokeContract;
  if (!invocation) throw new Error('Expected exactly one contract invocation');
  const targetId=StrKey.encodeContract(Buffer.from(invocation.contractAddress?.contractId?.value ?? Buffer.alloc(0)));
  if (targetId !== contractId) throw new Error('Invocation targets the wrong contract');
  if (String(invocation.functionName) !== 'pay_order') throw new Error('Invocation calls the wrong contract function');
  const args=invocation.args ?? [];
  const idHex=args[0]?.value?.value ? Buffer.from(args[0].value.value).toString('hex') : '';
  if (idHex !== expectedId) throw new Error('Invocation does not match the order intent');
  const payer=args[1]?.value?.accountId?.ed25519?.value ? StrKey.encodeEd25519PublicKey(Buffer.from(args[1].value.accountId.ed25519.value)) : '';
  if (payer !== customerAddress) throw new Error('Invocation payer does not match the authorized customer');
  return true;
}

// Verifies that the envelope carries a valid signature by the authorized
// customer before the server will relay it onward.
export function hasAuthorizedSignature(tx, customerAddress) {
  const signer = Keypair.fromPublicKey(customerAddress);
  const raw = Buffer.from(signer.rawPublicKey());
  const hash = Buffer.from(tx.hash());
  return tx.signatures.some(wrapper => {
    try {
      const hint = Buffer.from(wrapper.hint?.value ?? wrapper.hint);
      const sig = Buffer.from(wrapper.signature?.value ?? wrapper.signature);
      return hint.equals(raw.subarray(raw.length - 4)) && signer.verify(hash, sig);
    } catch { return false; }
  });
}

export function amountToUnits(value) {
  if (!/^(0|[1-9]\d*)(\.\d{1,7})?$/.test(String(value))) throw new Error('Invalid Stellar amount');
  const [whole, fraction=''] = String(value).split('.');
  return BigInt(whole)*10000000n + BigInt(fraction.padEnd(7,'0'));
}

export function parseOnChainOrder(result) {
  if (!result) return null;
  const isOk = result?.tag === 'ok' || result?.constructor?.name === 'Ok';
  const value = result?.value;
  if (!isOk || !value || value.amount === undefined) return null;
  return {
    amount: BigInt(value.amount),
    customer: value.customer,
    expiresAt: BigInt(value.expires_at),
    paid: Boolean(value.paid),
    paidAt: BigInt(value.paid_at ?? 0n)
  };
}

export async function createCheckoutService(config, {rpcServer = new rpc.Server(config.rpcUrl), client: injectedClient, log = () => {}} = {}) {
  const net = await rpcServer.getNetwork();
  if (net.passphrase !== TESTNET_PASSPHRASE) throw new Error(`Refusing non-Testnet RPC endpoint (passphrase: ${net.passphrase})`);

  const client = injectedClient ?? await contractNs.Client.from({
    contractId: config.contractId, rpcUrl: config.rpcUrl, networkPassphrase: TESTNET_PASSPHRASE
  });

  const call = async (fn, args = {}, opts = {}) => {
    const tx = await client[fn](args, opts);
    return tx?.result;
  };

  const readOrder = async onChainId => parseOnChainOrder(await call('get_order', {order_id: onChainIdBytes(onChainId)}));

  const service = {
    networkPassphrase: TESTNET_PASSPHRASE,
    readOrder,
    async assertDeployment() {
      const token = await call('token');
      const merchant = await call('merchant');
      const admin = await call('admin');
      const deployment = assertDeployment({token: token.value ?? token, merchant: merchant.value ?? merchant}, config);
      log(`checkout contract ${deployment.contractId} token ${deployment.token} merchant ${deployment.merchant} (admin ${admin.value ?? admin})`);
      return deployment;
    },
    // Operator-signed order creation on-chain. The operator key never persists
    // in the service; the caller holds it in process memory only.
    async createOnChainOrder(order, operatorKeypair) {
      const expiresAt = Math.floor(Date.parse(order.expiresAt)/1000);
      try {
        const tx = await client.create_order({
          order_id: onChainIdBytes(order.soroban.onChainId),
          amount: amountToUnits(order.amount),
          expires_at: BigInt(expiresAt)
        }, {signTransaction: contractNs.basicNodeSigner(operatorKeypair, TESTNET_PASSPHRASE), publicKey: operatorKeypair.publicKey()});
        const sent = await tx.signAndSend();
        const status = sent?.getTransactionResponse?.status;
        if (status && status !== 'SUCCESS') throw new Error(`On-chain order creation failed (${status})`);
        return {hash: sent?.getTransactionResponse?.txHash ?? null};
      } catch (error) {
        const SentErrors = contractNs.SentTransaction?.Errors;
        if (SentErrors && error instanceof SentErrors.TransactionStillPending) throw new Error('On-chain order creation still pending');
        if (SentErrors && error instanceof SentErrors.SendFailed) throw new Error(`On-chain order creation failed: ${error.message}`);
        const message=String(error.message || error);
        if (message.includes('Error(Contract,')) throw new Error(`On-chain order creation rejected by contract: ${message.split('Error(Contract,')[1]?.slice(0,80) ?? message}`);
        throw error;
      }
    },
    // Builds the exact intended payment transaction without any signature.
    // The customer only ever sees their own wallet sign this envelope.
    async buildUnsignedPayment(order, customerAddress) {
      if (!StrKey.isValidEd25519PublicKey(customerAddress)) throw new Error('Invalid wallet address');
      if (Date.now() >= Date.parse(order.expiresAt)) throw new Error('Order expired. Select the sample again.');
      await rpcServer.getAccount(customerAddress);
      const tx = await client.pay_order({
        order_id: onChainIdBytes(order.soroban.onChainId),
        customer: customerAddress
      }, {publicKey: customerAddress, simulate: true});
      return {xdr: tx.built.toXDR(), networkPassphrase: TESTNET_PASSPHRASE};
    },
    // Submits a wallet-signed payment after validating it against the intent.
    // timeoutMs lets serverless hosts bound the confirmation poll inside their
    // execution budget; the local server keeps the original 60s behavior.
    async submitSignedPayment({order, customerAddress, signedXdr, usedHashes, timeoutMs = 60_000}) {
      const tx = TransactionBuilder.fromXDR(signedXdr, TESTNET_PASSPHRASE); // rejects other networks
      // tx.hash() returns a raw Uint8Array on this SDK version; normalise it
      // to the hex form used everywhere else (RPC hashes, receipts, explorer
      // links) so duplicate-submission checks actually compare like with like.
      const txHash = Buffer.from(tx.hash()).toString('hex');
      if (usedHashes.has(txHash)) throw new Error('Transaction already used');
      validateSignedCheckoutTx(tx, {order, customerAddress, contractId: config.contractId, onChainId: order.soroban.onChainId});
      const response = await rpcServer.sendTransaction(tx);
      if (response.status === 'ERROR') throw new Error(`Submission failed: ${response.errorResult}`);
      const hash = response.hash;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const result = await rpcServer.getTransaction(hash);
        if (result.status === 'SUCCESS') return {hash, txStatus: result.status};
        if (result.status === 'FAILED') return {hash, txStatus: result.status};
        await new Promise(r => setTimeout(r, 1000));
      }
      throw new Error(`Transaction still pending after ${Math.round(timeoutMs/1000)}s. Confirmation is idempotent — re-run it from the transaction receipt.`);
    },
    async getTransaction(hash) {
      return rpcServer.getTransaction(hash);
    }
  };
  return service;
}
