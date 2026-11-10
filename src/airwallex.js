// Minimal Airwallex client for creator bonus payouts.
// Uses the sandbox by default. With no keys set, payouts are simulated so the demo always works.
'use strict';
const crypto = require('crypto');

const BASE = (process.env.AIRWALLEX_BASE_URL || 'https://api-demo.airwallex.com').replace(/\/$/, '');
const CLIENT_ID = process.env.AIRWALLEX_CLIENT_ID || '';
const API_KEY = process.env.AIRWALLEX_API_KEY || '';
const CURRENCY = process.env.PAYOUT_CURRENCY || 'USD';

// Map creators to saved Airwallex beneficiaries, e.g. AIRWALLEX_BENEFICIARIES=cr1:ben_abc,cr2:ben_def
const BENEFICIARIES = Object.fromEntries(
  (process.env.AIRWALLEX_BENEFICIARIES || '')
    .split(',').map((p) => p.trim()).filter(Boolean)
    .map((p) => p.split(':').map((x) => x.trim()))
);

const live = Boolean(CLIENT_ID && API_KEY);
let token = null;
let tokenExpires = 0;

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = 'Bearer ' + (await getToken());
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data.message || data.code || res.statusText;
    throw new Error(`Airwallex ${res.status} on ${path}: ${msg}`);
  }
  return data;
}

async function getToken() {
  if (token && Date.now() < tokenExpires - 60_000) return token;
  const res = await fetch(BASE + '/api/v1/authentication/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-client-id': CLIENT_ID, 'x-api-key': API_KEY }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) throw new Error('Airwallex login failed: ' + (data.message || res.status));
  token = data.token;
  tokenExpires = data.expires_at ? Date.parse(data.expires_at) : Date.now() + 25 * 60_000;
  return token;
}

async function getBalances() {
  if (!live) return null;
  return call('/api/v1/balances/current');
}

// Pays a creator bonus. Returns { transferId, status, mode }.
async function payCreator(item, creator) {
  const beneficiaryId = BENEFICIARIES[creator.id];
  if (!live || !beneficiaryId) {
    await new Promise((r) => setTimeout(r, 600));
    return {
      transferId: 'sim_' + crypto.randomBytes(4).toString('hex'),
      status: 'SIMULATED',
      mode: !live ? 'simulated: no API keys' : 'simulated: no beneficiary for ' + creator.id
    };
  }
  const transfer = await call('/api/v1/transfers/create', {
    method: 'POST',
    body: {
      request_id: crypto.randomUUID(), // idempotency key: a retried approval can never double-pay
      beneficiary_id: beneficiaryId,
      source_currency: CURRENCY,
      transfer_currency: CURRENCY,
      transfer_amount: item.amount,
      transfer_method: 'LOCAL',
      reason: 'professional_business_services',
      reference: (`${item.tierName} bonus ${creator.handle}`).slice(0, 35)
    }
  });
  return { transferId: transfer.id || transfer.short_reference_id, status: transfer.status || 'CREATED', mode: 'Airwallex sandbox' };
}

module.exports = { live, base: BASE, getBalances, payCreator, beneficiaryCount: Object.keys(BENEFICIARIES).length };
