#!/usr/bin/env node
// DEVELOPMENT ONLY. Completes (or fails) a SIMULATED payment so a booking can be tried end to end on a phone.
//
// The backend exposes this only while it runs with PAYMENT_PROVIDER=mock outside production (otherwise the route answers 404). No money
// moves, and everything it creates is flagged simulated. It signs in as an administrator, finds the customer's open simulated payment on
// the booking, and sends the chosen outcome through the backend's own dev route; the backend then confirms the booking exactly as it
// would after a verified provider event.
//
//   API_BASE_URL=http://localhost:3001/api/v1 ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=... \
//     node docs/dev/simulate-payment.mjs <bookingId> [succeeded|failed|cancelled|expired]
//
// The password is read from the environment and never printed. Only run it against a development / test backend.

const base = (process.env.API_BASE_URL ?? '').replace(/\/$/, '');
const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
const [bookingId, outcome = 'succeeded'] = process.argv.slice(2);

if (!base || !email || !password || !bookingId) {
  console.error('Usage: API_BASE_URL=... ADMIN_EMAIL=... ADMIN_PASSWORD=... node simulate-payment.mjs <bookingId> [succeeded|failed|cancelled|expired]');
  process.exit(2);
}
if (!['succeeded', 'failed', 'cancelled', 'expired'].includes(outcome)) {
  console.error(`Unknown outcome "${outcome}"`);
  process.exit(2);
}

async function call(method, path, token, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json.code ?? ''} ${typeof json.message === 'string' ? json.message : ''}`.trim());
  return json;
}

const login = await call('POST', '/auth/admin/login', null, { email, password });
const token = login.accessToken ?? login.tokens?.accessToken;
if (!token) throw new Error('Sign-in did not return an access token (an administrator who must change their password first cannot use this).');

const list = await call('GET', `/admin/payments?bookingId=${encodeURIComponent(bookingId)}&simulated=true&limit=20`, token);
const open = (list.items ?? []).find((p) => p.status === 'PROCESSING' || p.status === 'INITIATED');
if (!open) throw new Error('No open simulated payment on that booking. Press "Pay now" in the customer app first (backend needs PAYMENT_PROVIDER=mock).');

const result = await call('POST', `/dev/payments/${open.id}/simulate`, token, { outcome });
console.log(`payment ${open.id}: ${open.status} -> ${result.status ?? outcome}`);
