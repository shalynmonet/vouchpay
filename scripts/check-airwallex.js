// Checks your Airwallex sandbox connection: npm run check
'use strict';
require('../src/env');
const awx = require('../src/airwallex');

(async () => {
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
  const list = await awx.call('/api/v1/beneficiaries?page_size=50');
  const items = list.items || [];
  console.log('\n  Beneficiaries (' + items.length + '):');
  if (!items.length) console.log('    none yet. Create one in the sandbox web app, then run this again.');
  items.forEach((b) => {
    const bd = (b.beneficiary && (b.beneficiary.bank_details || b.beneficiary.digital_wallet)) || {};
    const name = b.nickname || bd.account_name || (b.beneficiary && b.beneficiary.company_name) || '(no name)';
    console.log('    ' + (b.id || b.beneficiary_id) + '   ' + name);
  });
  console.log('\n  Copy the IDs into AIRWALLEX_BENEFICIARIES, for example:');
  console.log('    AIRWALLEX_BENEFICIARIES=cr1:<id>,cr2:<id>,cr3:<id>\n');
})().catch((e) => {
  console.error('\n  Connection failed: ' + e.message);
  console.error('  If this says 401, check the keys. If it cannot reach the host, try AIRWALLEX_BASE_URL=https://api.sandbox.airwallex.com\n');
  process.exit(1);
});
