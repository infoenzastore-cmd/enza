import { randomUUID } from 'node:crypto';
import { Asset, Horizon, Networks, Operation, TransactionBuilder, BASE_FEE, StrKey } from '@stellar/stellar-sdk';

export const HORIZON_URL = 'https://horizon-testnet.stellar.org';
export const NETWORK = Networks.TESTNET;
export const CATALOG = Object.freeze({
  bottle: { name: 'Reusable bottle (sample product)', kind: 'product', units: 50000000n },
  antidote: { name: 'ENZA-hosted sound healing session (demo ticket)', kind: 'event', units: 100000000n }
});
export const unitsToAmount = units => `${units / 10000000n}.${(units % 10000000n).toString().padStart(7,'0')}`;
export function amountToUnits(value) {
  if (!/^(0|[1-9]\d*)(\.\d{1,7})?$/.test(value)) throw new Error('Invalid Stellar amount');
  const [whole, fraction=''] = value.split('.');
  return BigInt(whole)*10000000n + BigInt(fraction.padEnd(7,'0'));
}
export function configFromEnv(env=process.env) {
  const issuer=env.STELLAR_USDC_TESTNET_ISSUER, merchant=env.STELLAR_MERCHANT_ADDRESS;
  if (!issuer || !merchant || !StrKey.isValidEd25519PublicKey(issuer) || !StrKey.isValidEd25519PublicKey(merchant)) throw new Error('Configure valid Testnet USDC issuer and merchant public address');
  return {issuer,merchant};
}
export function createOrder(itemId) {
  const item=CATALOG[itemId]; if (!item) throw new Error('Unknown sample item');
  return {id:randomUUID(),itemId,kind:item.kind,amount:unitsToAmount(item.units),status:'pending',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+15*60_000).toISOString(),memo:randomUUID().replaceAll('-','').slice(0,28),hash:null,ticket:null};
}
export async function buildPayment(order, source, config, horizon=new Horizon.Server(HORIZON_URL)) {
  if (!StrKey.isValidEd25519PublicKey(source)) throw new Error('Invalid wallet address');
  if (Date.now() >= Date.parse(order.expiresAt)) throw new Error('Order expired');
  const account=await horizon.loadAccount(source);
  const hasXlm=account.balances.some(b=>b.asset_type==='native' && amountToUnits(b.balance)>0n);
  const hasUsdc=account.balances.some(b=>b.asset_code==='USDC' && b.asset_issuer===config.issuer && amountToUnits(b.balance)>=amountToUnits(order.amount));
  if (!hasXlm || !hasUsdc) throw new Error('Wallet needs XLM for fees and a funded USDC trustline');
  const destination=await horizon.loadAccount(config.merchant);
  if (!destination.balances.some(b=>b.asset_code==='USDC' && b.asset_issuer===config.issuer)) throw new Error('Merchant needs a USDC trustline');
  return new TransactionBuilder(account,{fee:BASE_FEE,networkPassphrase:NETWORK})
    .addOperation(Operation.payment({destination:config.merchant,asset:new Asset('USDC',config.issuer),amount:order.amount}))
    .addMemo((await import('@stellar/stellar-sdk')).Memo.text(order.memo))
    .setTimeout(Math.max(1,Math.floor((Date.parse(order.expiresAt)-Date.now())/1000))).build().toXDR();
}
export function validateSignedPayment(tx, order, config) {
  if (tx.memo?.type !== 'text' || Buffer.from(tx.memo.value).toString('utf8') !== order.memo || tx.operations.length !== 1) throw new Error('Transaction does not match order');
  const op=tx.operations[0];
  if (op.type !== 'payment' || op.destination !== config.merchant || op.asset.code !== 'USDC' || op.asset.issuer !== config.issuer || amountToUnits(op.amount) !== amountToUnits(order.amount)) throw new Error('Payment details changed');
  if (!StrKey.isValidEd25519PublicKey(tx.source)) throw new Error('Invalid source');
}
export function verifyPayment(order, hash, transaction, operations, config, usedHashes) {
  if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error('Invalid transaction hash');
  if (order.status==='paid' && order.hash===hash) return order;
  if (order.status!=='pending') throw new Error('Order is not pending');
  if (usedHashes.has(hash)) throw new Error('Transaction already used');
  if (!transaction || transaction.hash?.toLowerCase()!==hash.toLowerCase() || transaction.successful!==true) throw new Error('Transaction not successful');
  if (transaction.network_passphrase && transaction.network_passphrase!==NETWORK) throw new Error('Wrong network');
  if (transaction.memo_type!=='text' || transaction.memo!==order.memo) throw new Error('Wrong order memo');
  const createdAt=Date.parse(transaction.created_at);
  const orderCreatedAt=Date.parse(order.createdAt);
  const expiresAt=Date.parse(order.expiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(orderCreatedAt) || !Number.isFinite(expiresAt)) throw new Error('Invalid transaction or order timestamp');
  if (createdAt < orderCreatedAt || createdAt > expiresAt) throw new Error('Payment outside order validity window');
  if (!Array.isArray(operations) || operations.length!==1) throw new Error('Expected exactly one operation');
  const matches=operations.filter(op=>op.type==='payment' && op.to===config.merchant && op.asset_code==='USDC' && op.asset_issuer===config.issuer && amountToUnits(op.amount)===amountToUnits(order.amount));
  if (matches.length!==1) throw new Error('Incorrect destination, asset, or amount');
  return {...order,status:'paid',hash,paidAt:transaction.created_at,ticket:order.kind==='event' ? `DEMO-${order.id.slice(0,8)}`:null};
}
