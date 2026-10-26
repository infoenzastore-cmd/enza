// Local-only driver: simulates the browser wallet for the document's wallet rail.
// Secrets are read from env into memory; nothing is printed or transmitted.
import { Account, Address, Keypair, Networks, Operation, TransactionBuilder, Asset, Horizon, rpc } from '@stellar/stellar-sdk';

const BASE = 'http://127.0.0.1:3000';
const CONSUME = /secret|S[A-Z2-7]{55}/ig; // safety: redact key-like strings in reported output
const redact = s => String(s).replace(CONSUME, '<redacted>');

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const NETWORK = Networks.TESTNET;
const secret = process.env.STELLAR_SMOKE_SECRET;
if (!secret) throw new Error('Set STELLAR_SMOKE_SECRET for the stand-in wallet (not printed)');
const signer = Keypair.fromSecret(secret.trim());
const customer = signer.publicKey();
console.log('stand-in wallet (public):', customer);

const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');
// trustline for the stand-in wallet
const repo = async () => {
  let account;
  try { account = await horizon.loadAccount(customer); }
  catch { throw new Error('wallet not funded (stellar keys generate --fund first)'); }
  if (!account.balances.some(b => b.asset_code === 'USDC' && b.asset_issuer === ISSUER)) {
    const tx = new TransactionBuilder(account, {fee: '100', networkPassphrase: NETWORK})
      .addOperation(Operation.changeTrust({asset: new Asset('USDC', ISSUER), limit: '10000'}))
      .setTimeout(60).build();
    tx.sign(signer);
    await horizon.submitTransaction(tx);
    console.log('trustline added');
  }
};
await repo();

const api = async (path, body) => {
  const response = await fetch(BASE + '/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'origin': 'http://127.0.0.1:3000' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${redact(data.error || 'Request failed')}`);
  return data;
};

// 1. create order (bottle = 5 USDC)
const order = await api('/orders', { itemId: 'bottle' });
console.log('order created:', order.id, order.amount, 'onChainId:', order.soroban.onChainId);

// 2. stage intent (server builds unsigned tx)
const intent = await api(`/orders/${order.id}/intent`, { customer });
console.log('intent staged: xdr bytes', intent.xdr.length, 'passphrase matches:', intent.networkPassphrase === Networks.TESTNET);

// 3. customer signs in their wallet (stand-in) — building a XDR partially to inspect? no — sign directly
const unsigned = TransactionBuilder.fromXDR(intent.xdr, intent.networkPassphrase);
console.log('unsigned ops:', unsigned.operations.length, unsigned.operations[0].type, unsigned.operations[0].func?.invokeContract?.functionName);
unsigned.sign(signer);
const signedXdr = unsigned.toXDR();

// 4. duplicate submit guard: first (wrong!) submission attempt with a forged payer must fail BEFORE submission
const forged = TransactionBuilder.fromXDR(intent.xdr, intent.networkPassphrase);
forged.sign(Keypair.fromSecret(Keypair.random().secret()));
// (a different signer can't be the right customer by construction — server must reject)
try {
  await api(`/orders/${order.id}/submit`, { signedXdr: forged.toXDR() });
  console.log('UNEXPECTED: forged submission accepted!');
  process.exit(1);
} catch (e) {
  console.log('forged-signed submit rejected ✓ —', redact(e.message));
}

// 5. real submission
const submitted = await api(`/orders/${order.id}/submit`, { signedXdr });
console.log('submitted. hash:', submitted.hash);

// 6. duplicate submit of the SAME signed tx
const again = await api(`/orders/${order.id}/submit`, { signedXdr });
console.log('duplicate submit guard:', JSON.stringify(again));

// 7. confirmation (server verifies on-chain) + idempotent replay
const paid = await api(`/orders/${order.id}/confirm`, { hash: submitted.hash });
console.log('confirm #1:', paid.status, paid.paidAt, 'ticket:', paid.ticket);
const replay = await api(`/orders/${order.id}/confirm`, { hash: submitted.hash });
console.log('confirm #2 (idempotent):', replay.status, replay.hash === submitted.hash);

// 8. a fabricated hash must never confirm again
try {
  await api(`/orders/${order.id}/confirm`, { hash: 'f'.repeat(64) });
  console.log('UNEXPECTED: fabricated hash accepted!');
  process.exit(1);
} catch (e) {
  console.log('fabricated-hash confirm rejected ✓ —', redact(e.message));
}

console.log('explorer:', paid.explorer);
console.log('WALLET-RAIL SMOKE OK — paid tx:', submitted.hash);
