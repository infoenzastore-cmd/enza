import { isConnected as freighterIsConnected, getAddress as freighterGetAddress, requestAccess as freighterRequestAccess, signTransaction as freighterSign, getNetwork as freighterNetwork } from '@stellar/freighter-api';

const $ = id => document.getElementById(id);
// Netlify and GitHub Pages publish a static preview first. Live checkout on a
// hosted deployment (serverless functions) activates only when the probed API
// proves full Testnet configuration; GitHub Pages stays a labelled preview.
// Hosted capability detection: decide live vs static from the probed API
// configuration, not from hostname alone. A serverless deployment reports
// configured + operatorConfigured and switches out of preview mode; a static
// host (GitHub Pages / Netlify without functions) falls back to the preview.
let staticPreview = location.hostname.endsWith('.github.io') || location.hostname.endsWith('.netlify.app');
// When a deployed serverless backend exists but cannot process payments
// (missing operator secret, RPC unreachable, bootstrap error), this holds the
// actionable reason and payments are BLOCKED — the static simulation is never
// silently presented again as a checkout fallback.
let hostedBlocked = null;
const previewConfig = {
  issuer: 'No asset used in this preview',
  merchant: 'No destination in this preview',
  wallet: 'No wallet used in this preview',
  items: [
    { id: 'bottle', name: 'Reusable bottle (sample product)', kind: 'product', amount: '5.00' },
    { id: 'antidote', name: 'ENZA-hosted sound healing session (demo ticket)', kind: 'event', amount: '10.00' },
    { id: 'khakhra', name: 'Khapli Wheat Khakhra Organic Plain (enza.in showcase)', kind: 'showcase', amount: '5.00' }
  ]
};
const TESTNET = 'TESTNET';
// True for the .netlify.app host itself, independent of whether the hosted
// functions are configured; used only to point configuration-error messages
// at the right audience (hosted deployments vs the local demo).
const hostedHostName = location.hostname.endsWith('.netlify.app');
// Public catalog facts for the labelled live-store showcase card. Facts as
// served on the public product page; re-verified 2026-10-26. Text and link
// only, no store imagery (copyright stays with the store).
const LIVE_SHOWCASE = Object.freeze({
  url: 'https://enza.in/products/organic-plain-khapli-wheat-khakhra',
  title: 'Khapli Wheat Khakhra Organic Plain',
  brand: 'Satjeevan Organics',
  listPrice: '₹190 (public list price)',
  note: 'public catalog facts as served by enza.in; re-verified 2026-10-26'
});
let order;
let config;
let wallet;
let submittedHash;
let processing = false;
let freighter = null; // { address }
let lastRail; // 'wallet' | 'demo'

async function api(path, body) {
  const response = await fetch('/api' + path, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

const withTimeout = (promise, ms, message) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(message)), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); },
    error => { clearTimeout(timer); reject(error); });
});

const shorten = hex => hex ? `${hex.slice(0, 8)}…${hex.slice(-8)}` : '—';

function status(message, explorer) {
  const target = $('status');
  target.textContent = message;
  if (explorer) {
    target.append(document.createElement('br'));
    const link = document.createElement('a');
    link.href = explorer;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'View Testnet transaction ↗';
    target.append(link);
  }
  $('retry-confirm')?.remove();
}

function offerConfirmationRetry(hash) {
  const retry = document.createElement('button');
  retry.id = 'retry-confirm';
  retry.type = 'button';
  retry.textContent = 'Retry confirmation';
  retry.onclick = () => confirmOrder(hash);
  $('status').parentElement.append(retry);
}

function showWallet(data) {
  wallet = data;
  const demoWalletUsed = !freighter;
  $('wallet-setup').hidden = data.ready || !demoWalletUsed;
  $('wallet-refresh').hidden = !data.ready || !demoWalletUsed;
  $('faucet-link').hidden = !data.ready || !demoWalletUsed;
  $('wallet-address').hidden = !data.ready || !demoWalletUsed;
  $('wallet-balances').hidden = !data.ready || !demoWalletUsed;
  if (freighter) {
    $('wallet-status').textContent = 'Testnet wallet connected via Freighter. The disposable demo wallet below is optional.';
  } else if (data.ready) {
    $('wallet-address').textContent = `Demo wallet public address: ${data.address}`;
    $('wallet-balances').textContent = `Balance: ${data.usdc} Testnet USDC · ${data.xlm} Testnet XLM`;
    $('wallet-status').textContent = Number(data.usdc) >= 15
      ? 'Funded for both sample payments. Choose a sample below.'
      : 'Ready on Testnet. Use Circle’s faucet to send at least 15 test USDC for both samples, then refresh.';
  } else {
    $('wallet-status').textContent = 'Prepare a disposable Testnet wallet to continue.';
  }
}

async function refreshWallet() {
  showWallet(await api('/demo-wallet'));
  return wallet;
}

async function connectFreighter() {
  if (processing) return;
  processing = true;
  try {
    const { isConnected: installed, error } = await withTimeout(freighterIsConnected(), 4000, 'Freighter did not respond. Install the extension and reload.');
    if (error || !installed) throw new Error('Freighter not installed. Use the disposable demo wallet below, or install the wallet and reload.');
    const { address, error: accessError } = await withTimeout(freighterRequestAccess(), 60000, 'Wallet approval timed out or was rejected.');
    if (accessError) throw new Error(accessError.message || 'Wallet request rejected.');
    if (!address) throw new Error('No address was granted by the wallet.');
    const { network, error: networkError } = await withTimeout(freighterNetwork(), 4000, 'Freighter did not report its network.');
    if (networkError) throw new Error(networkError.message || 'Wallet network check failed.');
    if (network !== TESTNET && !network.includes('Test SDF Network')) throw new Error(`Your wallet is on ${network}. Switch Freighter to Testnet and reconnect.`);
    freighter = { address };
    $('freighter-connect').hidden = true;
    $('freighter-status').hidden = false;
    $('freighter-status').textContent = `Connected Testnet wallet: ${address} — your wallet signs each payment; ENZA never receives your secret key.`;
    status('Testnet wallet connected. Choose a sample to start a 15-minute pending order.');
    await refreshWallet();
  } catch (error) {
    freighter = null;
    $('freighter-status').hidden = false;
    $('freighter-status').textContent = `Wallet not available: ${error.message} Use the disposable demo wallet below.`;
  } finally {
    processing = false;
  }
}

$('freighter-connect').onclick = connectFreighter;

$('wallet-setup').onclick = async () => {
  if (processing) return;
  processing = true;
  $('wallet-setup').disabled = true;
  $('wallet-status').textContent = 'Requesting Testnet XLM and creating the USDC trustline…';
  try {
    showWallet(await api('/demo-wallet/setup', {}));
    status('Demo wallet ready. Fund its public address with Testnet USDC from Circle, then refresh the balance.');
  } catch (error) {
    $('wallet-status').textContent = `Setup failed: ${error.message}`;
  } finally {
    processing = false;
    $('wallet-setup').disabled = false;
  }
};

$('wallet-refresh').onclick = async () => {
  try { await refreshWallet(); }
  catch (error) { $('wallet-status').textContent = `Balance check failed: ${error.message}`; }
};

async function confirmOrder(hash) {
  if (processing) return;
  processing = true;
  try {
    status('Verifying settlement on-chain and on the Testnet ledger…');
    // The reference travels along so the server can re-derive display facts
    // it cannot store; every payment fact is re-verified from the chain.
    const paid = await api(`/orders/${order.id}/confirm`, { hash, ref: {
      itemId: order.itemId, amount: order.amount, createdAt: order.createdAt, customer: order.customer
    } });
    status(`Payment verified. Order ${paid.id} is paid${paid.ticket ? ' · demo ticket ' + paid.ticket : ''}. Paid at ${paid.paidAt} · tx ${paid.hash} · contract order ${shorten(paid.soroban.onChainId)}`, paid.explorer);
    $('pay').disabled = true;
    localStorage.setItem('enza-last-order', JSON.stringify({ id: paid.id, status: 'paid', hash }));
  } catch (error) {
    status(`${error.message}\nTransaction hash: ${hash}\nConfirmation is idempotent and can be retried without paying again.`, `https://stellar.expert/explorer/testnet/tx/${hash}`);
    offerConfirmationRetry(hash);
  } finally {
    processing = false;
  }
}

function showReview(order, item) {
  $('pay').disabled = order.status === 'paid' || false;
  $('checkout').hidden = false;
  $('details').textContent = `${item.name} · ${order.amount} USDC ${staticPreview ? 'preview price' : 'Testnet payment'} · expires ${new Date(order.expiresAt).toLocaleTimeString()}`;
  $('review-network').textContent = staticPreview ? 'Static preview · no network' : 'Stellar Testnet · Soroban';
  $('review-asset').textContent = staticPreview ? 'Illustrative USDC price' : 'Testnet USDC settled by the checkout contract';
  $('issuer').textContent = staticPreview ? config.issuer : (order.soroban?.token ? 'Verified USDC SAC ' + shorten(order.soroban.token) : (config.issuer || 'Not configured'));
  $('merchant').textContent = staticPreview ? config.merchant : (order.soroban?.merchant ? shorten(order.soroban.merchant) : 'Not configured');
  $('payer').textContent = staticPreview ? config.wallet : (order.customer ? order.customer : (lastRail === 'wallet' ? freighter?.address : wallet?.address) || 'Not selected');
  $('memo').textContent = staticPreview ? (order.memo || '—') : (order.soroban?.onChainId ? shorten(order.soroban.onChainId) + ' (on-chain bytes32 order id)' : '—');
  $('pay').textContent = staticPreview ? 'Complete simulated checkout ↗' : (lastRail === 'wallet' ? 'Sign payment with my wallet ↗' : 'Authorize demo Testnet payment ↗');
}

function itemCard(item) {
  const card = document.createElement('article');
  card.className = `sample-card ${item.kind === 'event' ? 'event' : item.kind === 'showcase' ? 'showcase' : 'product'}`;
  card.id = item.kind === 'event' ? 'event' : item.kind === 'showcase' ? 'showcase' : 'product';
  const art = document.createElement('div');
  art.className = 'sample-art';
  const artText = document.createElement('span');
  artText.textContent = item.kind === 'event' ? 'Feel the moment.' : item.kind === 'showcase' ? 'From the live store.' : 'Live thoughtfully.';
  art.append(artText);
  const body = document.createElement('div');
  body.className = 'sample-card-body';
  const kind = document.createElement('div');
  kind.className = 'sample-kind';
  kind.textContent = item.kind === 'event' ? 'ANTIDOTE · SAMPLE EXPERIENCE' : item.kind === 'showcase' ? 'SHOP ENZA · LIVE SHOWCASE' : 'SHOP ENZA · SAMPLE PRODUCT';
  const heading = document.createElement('h3');
  heading.textContent = item.name;
  const description = document.createElement('p');
  description.textContent = item.kind === 'event'
    ? staticPreview
      ? 'A fictional ENZA-hosted sound-healing session. This hosted preview creates a sample ticket without a blockchain payment.'
      : 'A fictional ENZA-hosted sound-healing session. A demo ticket appears only after verified Testnet settlement on the Soroban checkout contract.'
    : item.kind === 'showcase'
      ? 'A real product publicly listed on the live enza.in storefront. This checkout is still a Testnet demo: it does not reserve live inventory, does not create a live-store order, and the demo amount is not a currency conversion of the live price.'
      : 'A sample reusable bottle for testing checkout. This is not live EnZa stock or a shippable order.';
  if (item.kind === 'showcase' && LIVE_SHOWCASE) {
    const link = document.createElement('a');
    link.href = LIVE_SHOWCASE.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = `${LIVE_SHOWCASE.title} — ${LIVE_SHOWCASE.brand}, live price ${LIVE_SHOWCASE.listPrice} (opens enza.in)`;
    description.append(document.createElement('br'), link, document.createElement('br'), ` (${LIVE_SHOWCASE.note})`);
  }
  const bottom = document.createElement('div');
  bottom.className = 'sample-card-bottom';
  const price = document.createElement('div');
  price.className = 'sample-price';
  price.textContent = `${item.amount} USDC`;
  const priceNote = document.createElement('small');
  priceNote.textContent = staticPreview ? 'PREVIEW PRICE · NO PAYMENT' : 'TESTNET ONLY';
  price.append(priceNote);
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Select sample ↗';
  button.onclick = async () => {
    if (processing) return;
    processing = true;
    try {
      if (staticPreview) {
        const id = crypto.randomUUID();
        order = { id, itemId: item.id, kind: item.kind, amount: item.amount,
          memo: `preview-${id.slice(0,8)}`, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
      } else {
        if (hostedBlocked) throw new Error(hostedBlocked);
        if (freighter) lastRail = 'wallet';
        else if (config.capabilities?.demoWallet === false) {
          throw new Error('This hosted deployment requires your own wallet: install the Stellar Testnet Freighter extension, connect it, and choose a sample again.');
        } else {
          const currentWallet = await refreshWallet();
          if (!currentWallet.ready) throw new Error('Connect your Stellar wallet, or prepare the disposable demo wallet, before paying.');
          if (Number(currentWallet.usdc) < Number(item.amount)) throw new Error(`Fund the demo wallet with at least ${item.amount} Testnet USDC and refresh its balance, or connect Freighter.`);
          lastRail = 'demo';
        }
        order = await api('/orders', { itemId: item.id });
        submittedHash = undefined;
        if (order.status === 'staging') {
          status('On-chain order staged. Waiting for the Testnet ledger confirmation…');
          order = await waitForOrder(order.id) ?? order;
        }
        localStorage.setItem('enza-last-order', JSON.stringify({
          id: order.id, status: order.status, itemId: order.itemId, kind: order.kind,
          amount: order.amount, createdAt: order.createdAt, customer: order.customer
        }));
      }
      showReview(order, item);
      status(staticPreview
        ? `Preview order ${order.id}. This hosted version will not submit a transaction or mark a real order paid.`
        : `Pending order ${order.id}. Review the payment destination, asset and amount, then authorize with your wallet.`);
      $('checkout').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      status(error.message);
    } finally {
      processing = false;
    }
  };
  bottom.append(price, button);
  body.append(kind, heading, description, bottom);
  card.append(art, body);
  return card;
}

async function payWithWallet() {
  status('Staging the exact payment. Your wallet will review the transaction…');
  let intent;
  try {
    intent = await api(`/orders/${order.id}/intent`, { customer: freighter.address });
  } catch (error) {
    if (error.message.includes('already assigned')) throw error;
    status(`Could not stage the payment: ${error.message}`);
    return;
  }
  if (intent.alreadyPaid) { submittedHash = intent.hash || order.hash; return confirmOrder(submittedHash); }
  if (intent.alreadySubmitted) { submittedHash = intent.hash || order.hash; return confirmOrder(submittedHash); }
  let signedXdr;
  try {
    const signed = await freighterSign(intent.xdr, { networkPassphrase: intent.networkPassphrase });
    if (signed.error) throw new Error(signed.error.message || 'The wallet refused to sign. Payment cancelled — the order stays pending.');
    signedXdr = signed.signedTxXdr;
  } catch (error) {
    status(`Payment cancelled: ${error.message}\nThe pending order was neither submitted nor paid.`);
    return;
  }
  status('Submitting the signed payment to Stellar Testnet…');
  let result;
  try {
    result = await api(`/orders/${order.id}/submit`, { signedXdr });
  } catch (error) {
    status(`${error.message}\nNo payment has been recorded by this order. You can start a new order or retry.`);
    return;
  }
  submittedHash = result.hash;
  await confirmOrder(submittedHash);
}

async function payWithDemoWallet() {
  status('Signing and submitting the authorized demo payment on Stellar Testnet…');
  const result = await api(`/orders/${order.id}/pay`, {});
  submittedHash = result.hash;
  await confirmOrder(submittedHash);
}

try {
  // Probe the API once. Modes:
  //  1. `static` — no /api at all (pure static host): labelled paymentless
  //     preview;
  //  2. `blocked` — a serverless backend IS deployed but cannot process
  //     payments (operator secret invisible, RPC unreachable, bootstrap
  //     error): actionable error, payments disabled;
  //  3. `live` — real Testnet checkout (localhost server or hosted
  //     serverless functions), Freighter enabled.
  // Configuration is never faked: configuration problems do NOT fall back to
  // the simulation — the blocked mode keeps the failure visible.
  let hostedConfig = null;
  try { hostedConfig = await api('/config'); } catch (probeError) {
    if (!staticPreview) throw probeError;
  }
  const serverlessPresent = Boolean(hostedConfig && hostedConfig.hostedMode === 'serverless-stateless');
  if (serverlessPresent) {
    config = hostedConfig;
    staticPreview = false;
    if (!(hostedConfig.configured && hostedConfig.operatorConfigured && hostedConfig.checkout)) {
      hostedBlocked = hostedConfig.bootstrapError
        ? `Hosted checkout is blocked by a deployment configuration problem — ${hostedConfig.bootstrapError}`
        : 'Hosted checkout is blocked: STELLAR_CHECKOUT_OPERATOR_SECRET is not visible to the deployed functions. The site owner must add it as a server-side Netlify Functions environment variable and trigger a redeploy.';
    }
  } else if (hostedConfig?.configured && hostedConfig?.operatorConfigured && hostedConfig?.checkout) {
    config = hostedConfig;
    staticPreview = false;
  } else {
    config = staticPreview ? previewConfig : hostedConfig;
  }
  config.items.forEach(item => $('items').append(itemCard(item)));
  if (staticPreview) {
    $('freighter-panel').hidden = true;
    $('wallet-panel').hidden = true;
    $('demo-intro').textContent = 'Choose a sample to preview the checkout flow. This hosted preview does not require a wallet and does not submit a payment.';
    $('review-network').textContent = 'Static preview · no network';
    $('review-asset').textContent = 'Illustrative USDC price';
    $('checkout-note').textContent = 'This hosted static preview does not use a wallet, submit a Testnet transaction, or fulfill a real order. The ticket shown is illustrative only.';
    status(hostedConfig && hostedHostName
      ? 'Hosted preview: the deployment is reachable, but Testnet checkout variables are not configured yet, so payments are disabled. The site operator must complete docs/NETLIFY_PREVIEW.md setup.'
      : 'Hosted static preview: choose a sample to explore checkout. No Testnet payment or on-chain order confirmation occurs here.');
  } else {
    $('freighter-panel').hidden = Boolean(hostedBlocked);
    try {
      const checkout = await api('/checkout');
      $('freighter-status').hidden = false;
      $('freighter-status').textContent = `Verified Testnet checkout contract: ${shorten(checkout.contractId)} (USDC SAC settled on Testnet)`;
    } catch {}
    // The disposable demo wallet is a local-server capability; hosted
    // serverless deployments state this explicitly and hide its panel.
    if (config.capabilities?.demoWallet === false) {
      $('wallet-panel').hidden = true;
      $('demo-intro').textContent = 'Connect your Stellar Testnet wallet (Freighter), then select the sample product below. The disposable demo wallet is only available when running the local server demo.';
    }
    if (!freighter && config.capabilities?.demoWallet !== false) await refreshWallet();
    if (config.capabilities?.demoWallet === false && !freighter) {
      $('freighter-status').hidden = false;
      $('freighter-status').textContent = 'Connect your wallet to enable the real Testnet flow on this hosted deployment.';
    }
    if (config.configured && config.checkout) {
      status(config.capabilities?.demoWallet === false
        ? 'Connect your Testnet wallet (Freighter), then choose a sample.'
        : config.operatorConfigured
          ? 'Connect your wallet or prepare the demo wallet, then choose a sample.'
          : 'The server operator key must be configured (STELLAR_CHECKOUT_OPERATOR_SECRET) before creating orders.');
    } else {
      status('The checkout contract, merchant address and verified Testnet USDC issuer must be configured before checkout.');
    }
    await resumeLastOrder();
    if (location.hash === '#event') $('event')?.scrollIntoView();
  }
} catch (error) {
  status(`Could not reach the local demo API: ${error.message}`);
}

// Polls a staged order until the ledger confirms the create_order write.
// The hosted deployment answers 'staging' when creation reached the chain
// but did not settle within the serverless invocation budget.
async function waitForOrder(id, attempts = 4) {
  for (let tries = 0; tries < attempts; tries++) {
    await new Promise(r => setTimeout(r, 2500));
    try {
      const latest = await api(`/orders/${id}`);
      if (latest?.status === 'pending' || latest?.status === 'paid') return latest;
    } catch {}
  }
  return null;
}

async function resumeLastOrder() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem('enza-last-order') || 'null'); } catch { return; }
  if (!saved?.id) return;
  let latest;
  try { latest = await api(`/orders/${saved.id}`); } catch { localStorage.removeItem('enza-last-order'); return; }
  if (!latest || latest.status !== 'pending') return;
  // Reconcile the chain-backed payload with the browser-held reference:
  // on-chain values are authoritative, the reference only restores display
  // hints (item identity, creation time) that the ledger does not store.
  order = {
    ...latest,
    itemId: saved.itemId ?? latest.itemId,
    kind: saved.kind ?? latest.kind,
    amount: latest.amount ?? saved.amount,
    createdAt: saved.createdAt ?? latest.createdAt,
    customer: saved.customer ?? latest.customer
  };
  submittedHash = latest.hash || undefined;
  const item = config.items.find(candidate => candidate.id === latest.itemId);
  if (item) showReview(order, item);
  if (latest.hash) {
    $('pay').disabled = true;
    confirmOrder(latest.hash);
  } else {
    status(`Reconnected to pending order ${latest.id}. Review and authorize the payment.`);
  }
}

$('pay').onclick = async () => {
  if (processing) return;
  if (hostedBlocked) return status(hostedBlocked);
  if (staticPreview) {
    if (!order) return status('Select a sample first.');
    const ticket = order.kind === 'event' ? ` · preview ticket PREVIEW-${order.id.slice(0,8)}` : '';
    status(`Simulated checkout complete for sample ${order.id}${ticket}. No payment was sent or confirmed on-chain.${order.kind === 'event' ? ' This ticket is only a preview.' : ''}`);
    $('pay').disabled = true;
    return;
  }
  processing = true;
  if (!order) { status('Select a sample first.'); processing = false; return; }
  if (submittedHash) { processing = false; return confirmOrder(submittedHash); }
  try {
    if (lastRail === 'wallet') await payWithWallet();
    else await payWithDemoWallet();
  } catch (error) {
    try {
      const latest = await api(`/orders/${order.id}`);
      submittedHash = latest.hash || undefined;
    } catch {}
    if (submittedHash) {
      status(`${error.message}\nTransaction hash: ${submittedHash}\nCheck the network result before attempting another payment.`, `https://stellar.expert/explorer/testnet/tx/${submittedHash}`);
      offerConfirmationRetry(submittedHash);
    } else status(error.message);
  } finally {
    processing = false;
  }
};
