// Checks your Airwallex sandbox connection: npm run check
'use strict';
require('../src/env');
const awx = require('../src/airwallex');

// Finds name-like fields anywhere in a payee record, whatever the API version nests them under.
function collect(obj, out) {
  out = out || {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') collect(v, out);
    else if (v != null && v !== '' && out[k] == null) out[k] = v;
  }
  return out;
}

async function checkServ() {
  const serv = require('../src/serv');
  if (!serv.enabled) { console.log('\n  SERV Reasoning: off (no SERV_API_KEY)'); return; }
  console.log('\n  Checking SERV Reasoning (' + serv.model + ') ...');
  try {
    const r = await serv.review(require('../src/engine').createInitialState(), { type: 'payout', title: 'Test payout', amount: 250, status: 'pending', reasoning: 'Connection test', creatorId: 'cr2', tierName: 'Bronze', tierViews: 50000 });
    console.log('  SERV OK: ' + r.verdict + ' (' + (r.confidence == null ? 'no confidence' : Math.round(r.confidence * 100) + '%') + ', ' + (r.ms / 1000).toFixed(1) + 's)');
  } catch (e) {
    console.log('  SERV failed: ' + e.message);
  }
}

(async () => {
  await checkServ();
  if (!awx.live) {
    console.log('\n  No keys found. Add AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY to your .env file first.\n');
    process.exit(1);
  }
  console.log('\n  Connecting to ' + awx.base + ' ...');
  const balances = await awx.call('/api/v1/balances/current');
  console.log('  Login OK\n\n  Balances:');
  (Array.isArray(balances) ? balances : balances.items || []).forEach((b) => {
    console.log('    ' + b.currency + '  ' + (b.available_amount ?? b.total_amount ?? 0));
  });
  const list = await awx.call('/api/v1/beneficiaries?page_size=100');
  const items = (list.items || []).slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  if (process.argv.includes('--raw')) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  console.log('\n  Beneficiaries (' + items.length + ', newest first):');
  if (!items.length) console.log('    none yet. Create one in the sandbox web app, then run this again.');
  items.forEach((b, i) => {
    const f = collect(b);
    const person = [f.first_name, f.last_name].filter(Boolean).join(' ');
    const name = f.nickname || f.account_name || person || f.company_name || f.name || '(no name found, run: npm run check -- --raw)';
    const acct = f.account_number ? '...' + String(f.account_number).slice(-4) : '';
    console.log('\n    ' + (i + 1) + '. ' + name);
    console.log('       ID:       ' + (b.beneficiary_id || b.id));
    console.log('       Details:  ' + [f.account_currency, f.bank_country_code, acct].filter(Boolean).join(' · '));
    if (b.created_at) console.log('       Created:  ' + String(b.created_at).slice(0, 16).replace('T', ' '));
  });
  console.log('\n  Copy the IDs into AIRWALLEX_BENEFICIARIES, for example:');
  console.log('    AIRWALLEX_BENEFICIARIES=cr1:<id>,cr2:<id>,cr3:<id>\n');
})().catch((e) => {
  console.error('\n  Connection failed: ' + e.message);
  console.error('  If this says 401, check the keys. If it cannot reach the host, try AIRWALLEX_BASE_URL=https://api.sandbox.airwallex.com\n');
  process.exit(1);
});
