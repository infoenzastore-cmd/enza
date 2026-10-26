// Hosted Netlify Functions runtime for the ENZA Testnet checkout.
//
// Responsibilities, kept deliberately thin over the existing local service:
// - bootstrap the same createCheckoutService used by server.js (one cached
//   instance per function instance; Testnet-only, fails closed without config);
// - HTTP glue: routing, JSON bodies, response and error mapping;
// - a same-origin guard on POSTs (no CORS exposure, mirrors loopback rule);
// - the stateless semantics from soroban-stateless.js.
//
// There is NO durable shared storage here and NO demo-wallet rail: the local
// JSON store and the disposable in-process signing wallet are local-server
// capabilities and are reported as unavailable on this host.
import { Keypair } from '@stellar/stellar-sdk';
import { CATALOG } from '../../../payment.js';
import {
  checkoutConfigFromEnv,
  createCheckoutService,
  orderOnChainId
} from '../../../soroban.js';
import {
  orderFromChain,
  payerFromSignedEnvelope,
  plannedOrder,
  publicOrder,
  statelessConfirm,
  UUID_PATTERN
} from '../../../soroban-stateless.js';

const DEPOSIT_WINDOW_MS = 15 * 60_000; // information only; the chain enforces expiry

export function getRuntime(env, deps = {}) {
  if (!globalThis.__ENZA_CHECKOUT_RUNTIME__) {
    const config = checkoutConfigFromEnv(env); // throws when Testnet config is missing -> fail closed
    let operatorKeypair = null;
    // The operator secret stays in the server-side environment only.
    const secret = env.STELLAR_CHECKOUT_OPERATOR_SECRET;
    if (secret) {
      try { operatorKeypair = Keypair.fromSecret(secret); } catch (error) {
        throw new Error(`The configured operator key is not valid: ${error.message}`);
      }
    }
    const servicePromise = deps.createService ? deps.createService(config) : createCheckoutService(config);
    globalThis.__ENZA_CHECKOUT_RUNTIME__ = {
      config,
      servicePromise,
      deploymentPromise: servicePromise.then(service => service.assertDeployment()),
      operatorKeypair
    };
  }
  return globalThis.__ENZA_CHECKOUT_RUNTIME__;
}

export function resetRuntime() {
  delete globalThis.__ENZA_CHECKOUT_RUNTIME__;
}

function checkoutContext(runtime) {
  return runtime.deploymentPromise.then(deployment => runtime.servicePromise.then(service => ({ service, deployment })));
}

const OPERATOR_REQUIRED = 'Configure the Testnet operator key (STELLAR_CHECKOUT_OPERATOR_SECRET) to create checkout orders';

// Diagnostics helpers. They surface WHY a networked or bootstrap operation
// failed without ever exposing secret material: only error classes/codes and
// public configuration identities. Anything that remotely looks like a Stellar
// key (base32 alphabet, 55 chars, typical key prefixes) is redacted.
function netCauseCodes(error) {
  const codes = [];
  let err = error;
  for (let depth = 0; err && depth < 5; depth += 1, err = err.cause) {
    if (err.code) codes.push(String(err.code));
  }
  return codes;
}

function sanitizeDiagnostics(text) {
  return String(text ?? '').replace(/[SCGXM][A-Z2-7]{55}/g, '[redacted]').slice(0, 300);
}

function describeNetworkedError(error) {
  const base = String(error?.message || error);
  const causes = netCauseCodes(error);
  const networkCodes = /^(ENOTFOUND|ECONNREFUSED|ECONNRESET|ECONNABORTED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|UND_ERR_|ABORT_ERR|CERT_|ERR_TLS)/;
  if (causes.some(code => networkCodes.test(code))) {
    return `${base} — outbound network failure to the Stellar Testnet RPC (cause chain: ${causes.join(' > ')}). Check this deployment's network egress; the configured Testnet endpoint must be reachable from the serverless runtime.`;
  }
  return sanitizeDiagnostics(base);
}

function sameOriginGuard(method, headers) {
  if (method !== 'POST') return;
  const origin = headers?.origin;
  if (!origin) return; // server-to-server calls without a browser origin
  let host = headers?.host;
  if (!host) throw new Error('Use the ENZA demo page hosted at this deployment to authorize a payment');
  const sameOrigin = /^https:\/\//.test(origin) && origin.startsWith(`https://${host}`);
  if (!sameOrigin) throw new Error('Use the ENZA demo page hosted at this deployment to authorize a payment');
}

function parseBody(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw) ?? {}; } catch { throw new Error('Request body must be JSON'); }
}

class RouteError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export async function handleApiRequest({ url, method, headers = {}, body: rawBody = '', env = {}, runtime } = {}) {
  // Runtime bootstrap is lazy: /api/config answers honestly even when the
  // deployment has no payment configuration yet, all other routes fail closed.
  let runtimeUsed = null;
  const needRuntime = () => {
    if (!runtimeUsed) runtimeUsed = runtime ?? getRuntime(env);
    return runtimeUsed;
  };
  const send = (status, payload) => ({ status, payload });
  const notFound = () => send(404, { error: 'Not found' });
  let path;
  try {
    path = new URL(url).pathname.replace(/^\/\.(?:netlify\/functions\/[a-z0-9-]+)/i, '') .replace(/\/+$/, '') || '/';
  } catch {
    return notFound();
  }
  if (!path.startsWith('/api/')) return notFound();
  try {
    sameOriginGuard(method, headers);

    if (method === 'GET' && path === '/api/config') {
      let paymentConfig = null;
      let operatorConfigured = false;
      let bootstrapError = null;
      try {
        const rt = needRuntime();
        paymentConfig = rt.config;
        operatorConfigured = Boolean(rt.operatorKeypair);
      } catch (error) {
        // Report the gap honestly instead of failing the probe outright, and
        // include the (sanitized) reason so the deployment's configuration
        // problem is actionable without shell or dashboard access.
        bootstrapError = sanitizeDiagnostics(error?.message || error);
      }
      return send(200, {
        network: 'Testnet', networkPassphrase: (paymentConfig?.passphrase) ?? null,
        configured: paymentConfig !== null,
        issuer: paymentConfig?.issuer ?? null,
        merchant: paymentConfig?.merchant ?? null,
        checkout: paymentConfig ? { contractId: paymentConfig.contractId, rpcUrl: paymentConfig.rpcUrl } : null,
        operatorConfigured,
        // The configured operator variable is a server-side secret: only its
        // (first) environment NAME is reported, never a value, so an operator
        // can spot a typo or a mis-scoped variable from the page probe.
        operatorEnvKeys: Object.keys(env).filter(key => /STELLAR/i.test(key) && /OPERATOR/i.test(key)).slice(0, 5),
        bootstrapError,
        items: Object.entries(CATALOG).map(([id, v]) => ({ id, name: v.name, kind: v.kind, amount: (Number(v.units) / 1e7).toFixed(2) })),
        capabilities: { demoWallet: false },
        hostedMode: 'serverless-stateless',
        commit: env.COMMIT_REF ?? null
      });
    }

    if (method === 'GET' && path === '/api/health') {
      // Real, bounded RPC reachability probe for the deployed runtime. This is
      // the safe way to obtain the concrete network failure that generic
      // "fetch failed" errors hide, without shell/log access.
      let rpcProbe = { url: null, reachable: false, error: null };
      try { rpcProbe.url = needRuntime().config.rpcUrl; } catch {}
      if (rpcProbe.url) {
        try {
          const res = await fetch(rpcProbe.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getNetwork' }),
            signal: AbortSignal.timeout(5000)
          });
          rpcProbe.reachable = res.ok;
          if (!res.ok) rpcProbe.error = `RPC answered HTTP ${res.status}`;
        } catch (error) { rpcProbe.error = describeNetworkedError(error); }
      } else {
        rpcProbe.error = 'checkout configuration failed to bootstrap; see /api/config bootstrapError';
      }
      let operatorConfigured = false;
      try { operatorConfigured = Boolean(needRuntime().operatorKeypair); } catch {}
      return send(200, { status: 'ok-check', network: 'Testnet', rpc: rpcProbe, operatorConfigured, commit: env.COMMIT_REF ?? null });
    }

    if (method === 'GET' && path === '/api/checkout') {
      const { deployment } = await checkoutContext(needRuntime());
      return send(200, { network: 'Testnet', ...deployment });
    }

    if (method === 'POST' && path === '/api/orders') {
      if (!needRuntime().operatorKeypair) throw new RouteError(OPERATOR_REQUIRED);
      const { service, deployment } = await checkoutContext(needRuntime());
      const requestedItem = parseBody(rawBody)?.itemId;
      const order = plannedOrder(String(requestedItem ?? ''), { contractId: deployment.contractId, merchant: deployment.merchant });
      let created = null;
      try {
        created = await service.createOnChainOrder(order, needRuntime().operatorKeypair);
      } catch (error) {
        const message = String(error?.message || error);
        // Idempotent recovery: a still-pending or already-created order is
        // resolved by reading it back from the chain, never by trusting the
        // local attempt. Repeating the POST with the same id stays safe.
        try {
          const existing = await service.readOrder(order.soroban.onChainId);
          if (existing?.paid === false && existing?.amount > 0n) created = { hash: null, staged: true };
        } catch {}
        if (!created) throw new Error(`On-chain order creation failed. ${message.slice(0, 200)}`);
      }
      const payload = publicOrder({ ...order, status: 'pending', hash: created?.hash ?? null });
      if (created?.staged) payload.status = 'staging';
      return send(201, payload);
    }

    const orderRoute = path.match(/^\/api\/orders\/([0-9a-f-]{36})(\/(intent|pay|confirm|submit))?$/i);
    if (orderRoute) {
      const id = orderRoute[1].toLowerCase();
      const action = orderRoute[3] ?? null;
      const { service, deployment } = await checkoutContext(needRuntime());
      const shared = { contractId: deployment.contractId, merchant: deployment.merchant };

      if (method === 'GET' && !action) {
        const onchain = await service.readOrder(orderOnChainId(id));
        if (!onchain) throw new RouteError('On-chain order not found', 404);
        return send(200, publicOrder(orderFromChain(id, onchain, null, shared)));
      }
      if (method !== 'POST') return notFound();
      const data = parseBody(rawBody);
      const ref = (data && typeof data.ref === 'object' && data.ref) || {};
      const onchain = await service.readOrder(orderOnChainId(id));
      if (!onchain) throw new RouteError('On-chain order not found', 404);
      // Fail fast on expiry; the contract re-enforces this at pay time.
      if (Number(onchain.expiresAt) * 1000 <= Date.now()) throw new Error('Order expired. Select the sample again.');

      if (action === 'intent') {
        if (onchain.paid) return send(200, { alreadyPaid: true, hash: null });
        const customer = String(data?.customer ?? '');
        if (!/^[G][ABCDEFGHIJKLMNOPQRSTUVWXYZ234567]{55}$/.test(customer)) throw new Error('Invalid wallet address');
        const order = orderFromChain(id, onchain, ref, shared);
        const intent = await service.buildUnsignedPayment(order, customer);
        return send(200, { xdr: intent.xdr, networkPassphrase: intent.networkPassphrase });
      }

      if (action === 'submit') {
        if (onchain.paid) return send(200, { alreadyPaid: true, hash: null });
        // THE API CONTRACT: the browser sends only an envelope
        // ({signedXdr}), exactly like the local server flow. The payer is
        // derived from the signed envelope itself and proven by its own
        // signature inside submitSignedPayment's validation — a browser-
        // supplied payer claim is never trusted. If the browser does send a
        // customer claim (e.g. an older client), a mismatch with the
        // envelope fails closed instead of silently re-binding the order.
        const signedXdr = String(data?.signedXdr || '');
        const payer = payerFromSignedEnvelope(signedXdr);
        if (!payer) throw new Error('Malformed signed payment envelope. Reconnect your wallet and sign the staged payment again.');
        if (data?.customer && String(data.customer) !== payer) throw new Error('Signed envelope does not match the claimed customer');
        const order = orderFromChain(id, onchain, { ...ref, customer: payer }, shared);
        const { hash, txStatus } = await service.submitSignedPayment({
          order, customerAddress: payer, signedXdr, usedHashes: new Set(), timeoutMs: 20_000
        });
        if (txStatus !== 'SUCCESS') throw new Error('Transaction failed on-chain. No payment was recorded; start a new order.');
        return send(200, { hash });
      }

      if (action === 'confirm') {
        const hash = String(data?.hash ?? '');
        if (!onchain.paid) throw new Error('Payment not yet recorded on-chain; retry from the transaction receipt');
        const txInfo = await service.getTransaction(hash);
        const envelope = typeof txInfo?.envelopeXdr === 'string'
          ? txInfo.envelopeXdr
          : (typeof txInfo?.envelopeXdr?.toXDR === 'function' ? txInfo.envelopeXdr.toXDR('base64') : null);
        const order = orderFromChain(id, onchain, ref, shared);
        const paid = statelessConfirm(order, { hash, txStatus: txInfo?.status ?? null, onchain, envelopeXdr: envelope }, { contractId: deployment.contractId });
        return send(200, publicOrder(paid));
      }

      if (action === 'pay') {
        throw new RouteError('The disposable demo wallet is a local-server capability and is not available in this hosted preview: use your own Testnet wallet (Freighter).', 501);
      }
    }

    // Demo-wallet rail: local-only by design on this host.
    if (path === '/api/demo-wallet' || path === '/api/demo-wallet/setup') {
      throw new RouteError('The disposable demo wallet is a local-server capability and is not available in this hosted preview: use your own Testnet wallet (Freighter).', 501);
    }

    return notFound();
  } catch (error) {
    if (error instanceof RouteError) return send(error.status, { error: error.message });
    return send(400, { error: describeNetworkedError(error) });
  }
}

export const ROUTE_DEPOSIT_WINDOW_MS = DEPOSIT_WINDOW_MS;
export { UUID_PATTERN, describeNetworkedError, sanitizeDiagnostics };
