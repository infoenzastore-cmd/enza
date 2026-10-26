const $ = id => document.getElementById(id);
// Netlify and GitHub Pages publish only the static preview. Real Testnet payments remain local-only.
const staticPreview = location.hostname.endsWith('.github.io') || location.hostname.endsWith('.netlify.app');
const previewConfig = {
  issuer: 'No asset used in this preview',
  merchant: 'No destination in this preview',
  items: [
    { id: 'bottle', name: 'Reusable bottle (sample product)', kind: 'product', amount: '5.00' },
    { id: 'antidote', name: 'ENZA-hosted sound healing session (demo ticket)', kind: 'event', amount: '10.00' }
  ]
};
let order;
let config;
let wallet;
let submittedHash;
let processing = false;

async function api(path, body) {
  const response = await fetch('/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

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
  document.getElementById('retry-confirm')?.remove();
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
  $('wallet-setup').hidden = data.ready;
  $('wallet-refresh').hidden = !data.ready;
  $('faucet-link').hidden = !data.ready;
  $('wallet-address').hidden = !data.ready;
  $('wallet-balances').hidden = !data.ready;
  if (data.ready) {
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
    status('Checking Testnet ledger confirmation…');
    const paid = await api(`/orders/${order.id}/confirm`, { hash });
    status(`Confirmed order ${paid.id}${paid.ticket ? ' · demo ticket ' + paid.ticket : ''}`, paid.explorer);
    $('pay').disabled = true;
  } catch (error) {
    status(`${error.message}\nTransaction hash: ${hash}\nConfirmation can be retried without paying again.`, `https://stellar.expert/explorer/testnet/tx/${hash}`);
    offerConfirmationRetry(hash);
  } finally {
    processing = false;
  }
}

function itemCard(item) {
  const card = document.createElement('article');
  card.className = `sample-card ${item.kind === 'event' ? 'event' : 'product'}`;
  card.id = item.kind === 'event' ? 'event' : 'product';
  const art = document.createElement('div');
  art.className = 'sample-art';
  const artText = document.createElement('span');
  artText.textContent = item.kind === 'event' ? 'Feel the moment.' : 'Live thoughtfully.';
  art.append(artText);
  const body = document.createElement('div');
  body.className = 'sample-card-body';
  const kind = document.createElement('div');
  kind.className = 'sample-kind';
  kind.textContent = item.kind === 'event' ? 'ANTIDOTE · SAMPLE EXPERIENCE' : 'SHOP ENZA · SAMPLE PRODUCT';
  const heading = document.createElement('h3');
  heading.textContent = item.name;
  const description = document.createElement('p');
  description.textContent = item.kind === 'event'
    ? staticPreview
      ? 'A fictional ENZA-hosted sound-healing session. This hosted preview creates a sample ticket without a blockchain payment.'
      : 'A fictional ENZA-hosted sound-healing session. A demo ticket appears only after verified Testnet payment.'
    : 'A sample reusable bottle for testing checkout. This is not live EnZa stock or a shippable order.';
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
        const currentWallet = await refreshWallet();
        if (!currentWallet.ready) throw new Error('Prepare the Testnet demo wallet first.');
        if (Number(currentWallet.usdc) < Number(item.amount)) throw new Error(`Fund the demo wallet with at least ${item.amount} Testnet USDC and refresh its balance first.`);
        order = await api('/orders', { itemId: item.id });
      }
      submittedHash = undefined;
      $('pay').disabled = false;
      $('checkout').hidden = false;
      $('details').textContent = `${item.name} · ${order.amount} USDC ${staticPreview ? 'preview price' : 'Testnet payment'} · expires ${new Date(order.expiresAt).toLocaleTimeString()}`;
      $('issuer').textContent = config.issuer || 'Not configured';
      $('merchant').textContent = config.merchant || 'Not configured';
      $('payer').textContent = staticPreview ? 'No wallet used in this preview' : wallet.address;
      $('memo').textContent = order.memo;
      $('pay').textContent = staticPreview ? 'Complete simulated checkout ↗' : 'Authorize demo Testnet payment ↗';
      status(staticPreview
        ? `Preview order ${order.id}. This hosted version will not submit a transaction or mark a real order paid.`
        : `Pending order ${order.id}. Review the Testnet payment, then authorize it with the button below.`);
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

try {
  config = staticPreview ? previewConfig : await api('/config');
  config.items.forEach(item => $('items').append(itemCard(item)));
  if (staticPreview) {
    $('wallet-panel').hidden = true;
    $('demo-intro').textContent = 'Choose a sample to preview the checkout flow. This hosted preview does not require a wallet and does not submit a payment.';
    $('review-network').textContent = 'Static preview · no network';
    $('review-asset').textContent = 'Illustrative USDC price';
    $('checkout-note').textContent = 'This hosted static preview does not use a wallet, submit a Testnet transaction, or fulfill a real order. The ticket shown is illustrative only.';
    status('Hosted static preview: choose a sample to explore checkout. No Testnet payment or on-chain order confirmation occurs here.');
  } else {
    await refreshWallet();
    status(config.configured
      ? 'Choose a sample to create a pending Testnet order.'
      : 'The merchant address and verified Testnet USDC issuer must be configured before checkout.');
  }
  if (location.hash === '#event') $('event')?.scrollIntoView();
} catch (error) {
  status(`Could not reach the local demo API: ${error.message}`);
}

$('pay').onclick = async () => {
  if (processing) return;
  if (staticPreview) {
    if (!order) return status('Select a sample first.');
    const ticket = order.kind === 'event' ? ` · preview ticket PREVIEW-${order.id.slice(0,8)}` : '';
    status(`Simulated checkout complete for sample ${order.id}${ticket}. No payment was sent or confirmed on-chain.${order.kind === 'event' ? ' This ticket is only a preview.' : ''}`);
    $('pay').disabled = true;
    return;
  }
  if (submittedHash) return confirmOrder(submittedHash);
  processing = true;
  try {
    if (!order) throw new Error('Select a sample first');
    status('Signing and submitting the authorized demo payment on Stellar Testnet…');
    const result = await api(`/orders/${order.id}/pay`, {});
    submittedHash = result.hash;
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
  if (submittedHash) confirmOrder(submittedHash);
};
