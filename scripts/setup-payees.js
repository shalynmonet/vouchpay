// Creates the three demo creators as Airwallex sandbox payees and writes their IDs into .env.
// Usage: npm run setup-payees
'use strict';
require('../src/env');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const awx = require('../src/airwallex');

// Sandbox only: sample US bank details from Airwallex's docs. No real money moves.
const CREATORS = [
  { id: 'cr1', first: 'Maya', last: 'Chen' },
  { id: 'cr2', first: 'Jordan', last: 'Reyes' },
  { id: 'cr3', first: 'Ava', last: 'Brooks' }
];
const BANK = { account_number: '50001121', account_routing_type1: 'aba', account_routing_value1: '021000021' };
const ADDRESS = { country_code: 'US', state: 'NY', city: 'New York', postcode: '10018', street_address: '412 5th Avenue' };

function body(c, asCompany) {
  const name = c.first + ' ' + c.last;
  const beneficiary = {
    type: 'BANK_ACCOUNT',
    entity_type: asCompany ? 'COMPANY' : 'PERSONAL',
    address: ADDRESS,
    bank_details: Object.assign({ account_currency: 'USD', account_name: name, bank_country_code: 'US', local_clearing_system: 'ACH' }, BANK)
  };
  if (asCompany) beneficiary.company_name = name;
  else { beneficiary.first_name = c.first; beneficiary.last_name = c.last; }
  return { request_id: crypto.randomUUID(), nickname: 'VouchPay ' + name, beneficiary, payer_entity_type: 'COMPANY', transfer_methods: ['LOCAL'] };
}

(async () => {
  if (!awx.live) {
    console.log('\n  No keys found. Add AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY to your .env file first.\n');
    process.exit(1);
  }
  // reuse payees from an earlier run instead of making duplicates
  const existing = (await awx.call('/api/v1/beneficiaries?page_size=100')).items || [];
  const ids = {};
  for (const c of CREATORS) {
    const nick = 'VouchPay ' + c.first + ' ' + c.last;
    const found = existing.find((b) => b.nickname === nick);
    if (found) {
      ids[c.id] = found.beneficiary_id || found.id;
      console.log('  Found   ' + nick + '  ' + ids[c.id]);
      continue;
    }
    let res;
    try {
      res = await awx.call('/api/v1/beneficiaries/create', { method: 'POST', body: body(c, false) });
    } catch (e) {
      console.log('  Personal payee rejected (' + e.message + '), retrying as business payee...');
      res = await awx.call('/api/v1/beneficiaries/create', { method: 'POST', body: body(c, true) });
    }
    ids[c.id] = res.beneficiary_id || res.id;
    console.log('  Created ' + nick + '  ' + ids[c.id]);
  }

  const line = 'AIRWALLEX_BENEFICIARIES=' + CREATORS.map((c) => c.id + ':' + ids[c.id]).join(',');
  const envPath = path.join(__dirname, '..', '.env');
  let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  env = /^AIRWALLEX_BENEFICIARIES=.*$/m.test(env) ? env.replace(/^AIRWALLEX_BENEFICIARIES=.*$/m, line) : env.replace(/\s*$/, '\n') + line + '\n';
  fs.writeFileSync(envPath, env);
  console.log('\n  Saved to .env:\n    ' + line);
  console.log('\n  Done. Restart with: npm start\n');
})().catch((e) => {
  console.error('\n  Setup failed: ' + e.message + '\n  Paste this message to Claude.\n');
  process.exit(1);
});
