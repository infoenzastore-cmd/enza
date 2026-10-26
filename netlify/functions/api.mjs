// ENZA Testnet checkout — hosted Netlify Function (Functions v2).
// All Soroban settlement logic lives in ../lib/host.mjs and the shared
// modules it re-uses; this file is only the platform adapter.
import { handleApiRequest } from './lib/host.mjs';

const respond = (status, payload) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

export default async req => {
  try {
    const url = req.url;
    const method = req.method;
    const rawBody = method === 'POST' || method === 'PUT' ? await req.text() : '';
    const { status, payload } = await handleApiRequest({
      url,
      method,
      headers: Object.fromEntries(req.headers.entries()),
      body: rawBody,
      env: process.env
    });
    return respond(status, payload);
  } catch (error) {
    return respond(400, { error: String(error?.message || error).slice(0, 300) });
  }
};

export const config = {
  path: [
    '/api/config',
    '/api/health',
    '/api/checkout',
    '/api/orders',
    '/api/orders/:id',
    '/api/orders/:id/intent',
    '/api/orders/:id/pay',
    '/api/orders/:id/submit',
    '/api/orders/:id/confirm',
    '/api/demo-wallet',
    '/api/demo-wallet/setup'
  ]
};
