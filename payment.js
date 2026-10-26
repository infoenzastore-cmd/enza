import { randomUUID } from 'node:crypto';
import { Networks, StrKey } from '@stellar/stellar-sdk';
import { PUBLIC_TESTNET_DEFAULTS } from './stellar-defaults.js';

export const HORIZON_URL = 'https://horizon-testnet.stellar.org';
export const NETWORK = Networks.TESTNET;
export const CATALOG = Object.freeze({
  bottle: { name: 'Reusable bottle (sample product)', kind: 'product', units: 50000000n },
  antidote: { name: 'ENZA-hosted sound healing session (demo ticket)', kind: 'event', units: 100000000n },
  // Showcase of a real, publicly listed enza.in catalog product (name, brand and
  // list price are public metadata served on the product page itself). The
  // Testnet amount stays a demo amount on purpose: this rail does not reserve
  // live inventory, does not create a live-store order, and does not convert
  // currency or settle in INR.
  khakhra: { name: 'Khapli Wheat Khakhra Organic Plain', kind: 'showcase', units: 50000000n }
});
export const LIVE_SHOWCASE = Object.freeze({
  slug: 'organic-plain-khapli-wheat-khakhra',
  url: 'https://enza.in/products/organic-plain-khapli-wheat-khakhra',
  title: 'Khapli Wheat Khakhra Organic Plain',
  brand: 'Satjeevan Organics',
  listPrice: '₹190 (public list price)',
  note: 'Public catalog facts as served by the live storefront page; re-verified 2026-10-26.'
});
export const unitsToAmount = units => `${units / 10000000n}.${(units % 10000000n).toString().padStart(7,'0')}`;
export function amountToUnits(value) {
  if (!/^(0|[1-9]\d*)(\.\d{1,7})?$/.test(value)) throw new Error('Invalid Stellar amount');
  const [whole, fraction=''] = value.split('.');
  return BigInt(whole)*10000000n + BigInt(fraction.padEnd(7,'0'));
}
export function configFromEnv(env=process.env) {
  const issuer=env.STELLAR_USDC_TESTNET_ISSUER || PUBLIC_TESTNET_DEFAULTS.issuer, merchant=env.STELLAR_MERCHANT_ADDRESS || PUBLIC_TESTNET_DEFAULTS.merchant;
  if (!StrKey.isValidEd25519PublicKey(issuer) || !StrKey.isValidEd25519PublicKey(merchant)) throw new Error('The issuer and merchant overrides must be valid Testnet public addresses');
  return {issuer,merchant};
}
export function createOrder(itemId) {
  const item=CATALOG[itemId]; if (!item) throw new Error('Unknown sample item');
  return {id:randomUUID(),itemId,kind:item.kind,amount:unitsToAmount(item.units),status:'pending',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+15*60_000).toISOString(),memo:randomUUID().replaceAll('-','').slice(0,28),hash:null,customer:null,ticket:null};
}
