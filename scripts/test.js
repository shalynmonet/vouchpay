// Guardrail tests: node scripts/test.js
'use strict';
const assert = require('assert');
const E = require('../src/engine');
const pay = async () => ({ transferId: 'sim_test', status: 'SIMULATED', mode: 'test' });

(async () => {
  let s = E.createInitialState();
  for (let i = 0; i < 5; i++) E.tick(s);

  // 1. Spend cap: total budget never exceeds the cap, even after approving every boost
  for (let i = 0; i < 6; i++) {
    for (const p of s.pending.filter((x) => x.type === 'boost' && x.status === 'pending')) await E.approve(s, p.id, pay);
    E.tick(s);
  }
  assert(E.totalBudget(s) <= s.policy.dailySpendCap, 'spend cap breached');
  assert(s.audit.some((a) => a.title.includes('spend cap')), 'cap block never logged');

  // 2. Floor + max shift: no campaign below the floor
  assert(s.campaigns.every((c) => c.budget >= s.policy.minCampaignBudget), 'campaign below floor');

  // 3. Payouts never auto-execute
  assert(s.audit.filter((a) => a.type === 'paid' && a.actor !== 'human').length === 0, 'payout without human');

  // 4. Fraud: a bot spike holds the bonus instead of paying it
  s = E.createInitialState();
  E.addViews(s, 'cr2', 60000);
  const held = s.pending.find((p) => p.creatorId === 'cr2' && p.status === 'held');
  assert(held, 'spike not held');
  const before = s.treasury.balance;
  E.reject(s, held.id);
  assert.strictEqual(s.treasury.balance, before, 'declined hold moved money');

  // 5. Approval + payout updates wallet and creator
  E.addViews(s, 'cr1', 17000);
  const p = s.pending.find((x) => x.creatorId === 'cr1' && x.status === 'pending');
  await E.approve(s, p.id, pay);
  assert.strictEqual(s.treasury.balance, before - p.amount);
  assert(s.creators[0].paidTiers.includes(100000));
  await assert.rejects(() => E.approve(s, p.id, pay), 'double approval allowed');

  // 6. Rollback restores budgets
  s = E.createInitialState();
  E.tick(s);
  const chg = s.changes.find((c) => c.type === 'shift');
  if (chg) {
    const from = s.campaigns.find((c) => c.id === chg.from).budget;
    E.rollback(s, chg.id);
    assert.strictEqual(s.campaigns.find((c) => c.id === chg.from).budget, from + chg.amount);
  }

  console.log('All guardrail tests passed');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
