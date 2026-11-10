/*
 * VouchPay agent engine
 * Autonomous ad spend + creator bonus agent with guardrails.
 * Pure state machine: runs in Node (server) and in the browser (demo mode).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VouchEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- helpers ----------
  function rand(s) {
    // mulberry32, state kept in s.rngState so the whole state stays JSON-serializable
    var a = (s.rngState = (s.rngState + 0x6d2b79f5) | 0);
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function nextId(s, prefix) { s.seq += 1; return prefix + '_' + s.seq; }
  function r2(n) { return Math.round(n * 100) / 100; }
  function money(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function fmtViews(n) { return n >= 1000 ? (Math.round(n / 100) / 10) + 'K' : String(n); }
  function totalBudget(s) { return s.campaigns.reduce(function (t, c) { return t + c.budget; }, 0); }
  function find(arr, id) { for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i]; return null; }

  function audit(s, entry) {
    var e = Object.assign({ id: nextId(s, 'log'), day: s.day, ts: new Date().toISOString() }, entry);
    s.audit.unshift(e);
    if (s.audit.length > 250) s.audit.length = 250;
    return e;
  }

  // ---------- initial state ----------
  function createInitialState(seed) {
    return {
      version: 1,
      day: 1,
      seq: 0,
      rngState: seed || 20261113,
      policy: {
        dailySpendCap: 6000,        // total daily ad budget can never exceed this
        maxShiftPct: 0.2,           // agent can move at most 20% of a campaign's budget per action
        minCampaignBudget: 300,     // agent never starves a campaign below this
        approvalThreshold: 500,     // any budget move >= this waits for a human
        payoutsRequireApproval: true,
        spikeMultiplier: 5,         // daily view gain > 5x the creator's average = fraud hold
        minRoasGap: 0.6,            // only rebalance when the gap is meaningful
        boostRoas: 3.0              // agent asks for new money when a campaign is this strong
      },
      treasury: { label: 'Creator payout wallet', currency: 'USD', balance: 15000 },
      campaigns: [
        { id: 'c1', name: 'Glow Serum Launch', platform: 'TikTok', budget: 1500, quality: 3.3, lastRoas: 3.1, totalSpend: 0, totalRevenue: 0, history: [3.1] },
        { id: 'c2', name: 'Weekend Getaway Promo', platform: 'Instagram', budget: 1500, quality: 1.4, lastRoas: 1.5, totalSpend: 0, totalRevenue: 0, history: [1.5] },
        { id: 'c3', name: 'Maker Kit Holiday', platform: 'YouTube', budget: 1000, quality: 2.4, lastRoas: 2.3, totalSpend: 0, totalRevenue: 0, history: [2.3] },
        { id: 'c4', name: 'Retargeting Always-On', platform: 'Meta', budget: 1000, quality: 1.0, lastRoas: 1.1, totalSpend: 0, totalRevenue: 0, history: [1.1] }
      ],
      creators: [
        { id: 'cr1', name: 'Maya Chen', handle: '@mayamakes', niche: 'Maker space', campaignId: 'c3', basePay: 1500, views: 84000, avgDaily: 6000, lastGain: 0, paidTiers: [50000], declinedTiers: [] },
        { id: 'cr2', name: 'Jordan Reyes', handle: '@jordantravels', niche: 'Travel', campaignId: 'c2', basePay: 1200, views: 41000, avgDaily: 4000, lastGain: 0, paidTiers: [], declinedTiers: [] },
        { id: 'cr3', name: 'Ava Brooks', handle: '@avawellness', niche: 'Wellness', campaignId: 'c1', basePay: 1000, views: 93000, avgDaily: 3000, lastGain: 0, paidTiers: [50000], declinedTiers: [] }
      ],
      tiers: [
        { name: 'Bronze', views: 50000, bonus: 250 },
        { name: 'Silver', views: 100000, bonus: 500 },
        { name: 'Gold', views: 250000, bonus: 1500 }
      ],
      pending: [],   // items waiting on a human (budget moves, payouts, fraud holds)
      changes: [],   // executed budget changes, kept for rollback
      audit: []
    };
  }

  // ---------- simulation ----------
  function simulateDay(s) {
    s.day += 1;
    var spend = 0;
    s.campaigns.forEach(function (c) {
      var roas = r2(c.quality * (0.75 + rand(s) * 0.5));
      c.lastRoas = roas;
      c.totalSpend += c.budget;
      c.totalRevenue += c.budget * roas;
      c.history.push(roas);
      if (c.history.length > 14) c.history.shift();
      spend += c.budget;
    });
    audit(s, { actor: 'system', type: 'day', title: 'Day ' + s.day + ' results in', detail: money(spend) + ' ad spend across ' + s.campaigns.length + ' campaigns' });
    s.creators.forEach(function (cr) {
      var gain = Math.round(cr.avgDaily * (0.6 + rand(s) * 0.8));
      recordViews(s, cr, gain);
    });
  }

  function recordViews(s, cr, gain) {
    cr.views += gain;
    cr.lastGain = gain;
    var spike = gain > s.policy.spikeMultiplier * cr.avgDaily;
    // keep spikes out of the baseline so a bot burst can't poison future checks
    if (!spike) cr.avgDaily = Math.round(cr.avgDaily * 0.8 + gain * 0.2);
    return spike;
  }

  // ---------- the agent ----------
  function hasPending(s, pred) { return s.pending.some(function (p) { return p.status === 'pending' || p.status === 'held' ? pred(p) : false; }); }

  function runAgent(s) {
    var p = s.policy;
    var ranked = s.campaigns.slice().sort(function (a, b) { return b.lastRoas - a.lastRoas; });
    var best = ranked[0], worst = ranked[ranked.length - 1];

    // 1) Rebalance budget from weakest to strongest campaign
    var gap = r2(best.lastRoas - worst.lastRoas);
    if (gap >= p.minRoasGap && !hasPending(s, function (x) { return x.type === 'shift'; })) {
      var wanted = Math.round(worst.budget * 0.35 / 10) * 10;
      var byPct = Math.floor(worst.budget * p.maxShiftPct / 10) * 10;
      var byFloor = worst.budget - p.minCampaignBudget;
      var amount = Math.max(0, Math.min(wanted, byPct, byFloor));
      var reasoning = best.name + ' returned ' + best.lastRoas + 'x ROAS vs ' + worst.lastRoas + 'x for ' + worst.name + ' (gap ' + gap + 'x).';
      if (amount < wanted) {
        audit(s, { actor: 'policy', type: 'clamp', title: 'Guardrail clamped a budget move', detail: 'Agent wanted to move ' + money(wanted) + ', policy allows ' + money(amount) + (byFloor <= byPct ? ' (campaign floor ' + money(p.minCampaignBudget) + ')' : ' (max ' + Math.round(p.maxShiftPct * 100) + '% per move)'), amount: amount });
      }
      if (amount >= 10) {
        proposeChange(s, { type: 'shift', from: worst.id, to: best.id, amount: amount, reasoning: reasoning, title: 'Move ' + money(amount) + ' from ' + worst.name + ' to ' + best.name });
      } else {
        audit(s, { actor: 'policy', type: 'blocked', title: 'Budget move blocked', detail: worst.name + ' is already at its minimum budget' });
      }
    }

    // 2) Ask for new money when a campaign is crushing it (spend cap guardrail)
    if (best.lastRoas >= p.boostRoas && !hasPending(s, function (x) { return x.type === 'boost'; })) {
      var boost = 500;
      var total = totalBudget(s);
      if (total + boost > p.dailySpendCap) {
        audit(s, { actor: 'policy', type: 'blocked', title: 'Blocked by daily spend cap', detail: 'Agent wanted +' + money(boost) + ' for ' + best.name + ' but total would hit ' + money(total + boost) + ' (cap ' + money(p.dailySpendCap) + ')', amount: boost });
      } else {
        proposeChange(s, { type: 'boost', to: best.id, amount: boost, reasoning: best.name + ' is at ' + best.lastRoas + 'x ROAS, above the ' + p.boostRoas + 'x boost threshold. Daily total stays under the ' + money(p.dailySpendCap) + ' cap.', title: 'Add ' + money(boost) + '/day to ' + best.name });
      }
    }

    // 3) Creator performance bonuses
    s.creators.forEach(function (cr) { checkCreator(s, cr); });
  }

  function proposeChange(s, change) {
    var needsHuman = change.amount >= s.policy.approvalThreshold;
    if (needsHuman) {
      var item = Object.assign({ id: nextId(s, 'req'), status: 'pending', createdDay: s.day }, change);
      s.pending.unshift(item);
      audit(s, { actor: 'agent', type: 'proposed', title: change.title, detail: 'Needs approval (' + money(change.amount) + ' >= ' + money(s.policy.approvalThreshold) + ' threshold). ' + change.reasoning, amount: change.amount, ref: item.id });
    } else {
      var rec = applyChange(s, change);
      audit(s, { actor: 'agent', type: 'executed', title: change.title, detail: 'Auto-executed under ' + money(s.policy.approvalThreshold) + ' threshold. ' + change.reasoning, amount: change.amount, ref: rec.id, rollback: true });
    }
  }

  function applyChange(s, change) {
    var before = {};
    s.campaigns.forEach(function (c) { before[c.id] = c.budget; });
    if (change.type === 'shift') {
      find(s.campaigns, change.from).budget -= change.amount;
      find(s.campaigns, change.to).budget += change.amount;
    } else if (change.type === 'boost') {
      find(s.campaigns, change.to).budget += change.amount;
    }
    var rec = { id: nextId(s, 'chg'), type: change.type, from: change.from, to: change.to, title: change.title, amount: change.amount, before: before, day: s.day, rolledBack: false };
    s.changes.unshift(rec);
    return rec;
  }

  function checkCreator(s, cr) {
    s.tiers.forEach(function (tier) {
      if (cr.views < tier.views) return;
      if (cr.paidTiers.indexOf(tier.views) !== -1 || cr.declinedTiers.indexOf(tier.views) !== -1) return;
      if (hasPending(s, function (x) { return x.type === 'payout' && x.creatorId === cr.id && x.tierViews === tier.views; })) return;

      var spike = cr.lastGain > s.policy.spikeMultiplier * cr.avgDaily;
      var base = { type: 'payout', creatorId: cr.id, creatorName: cr.name, tierName: tier.name, tierViews: tier.views, amount: tier.bonus, createdDay: s.day };

      if (spike) {
        var held = Object.assign({ id: nextId(s, 'req'), status: 'held', flag: 'View spike: +' + fmtViews(cr.lastGain) + ' in one day vs ' + fmtViews(cr.avgDaily) + '/day average (' + Math.round(cr.lastGain / cr.avgDaily) + 'x)', title: 'Hold ' + tier.name + ' bonus for ' + cr.name }, base);
        held.reasoning = held.flag + '. Over the ' + s.policy.spikeMultiplier + 'x fraud threshold, so the bonus is held for review.';
        s.pending.unshift(held);
        audit(s, { actor: 'policy', type: 'fraud', title: 'Fraud check held a payout', detail: cr.name + ' ' + tier.name + ' bonus (' + money(tier.bonus) + '). ' + held.flag, amount: tier.bonus, ref: held.id });
        return;
      }
      if (s.treasury.balance < tier.bonus) {
        audit(s, { actor: 'policy', type: 'blocked', title: 'Insufficient payout balance', detail: cr.name + ' earned ' + money(tier.bonus) + ' but the wallet only has ' + money(s.treasury.balance), amount: tier.bonus });
        return;
      }
      var item = Object.assign({ id: nextId(s, 'req'), status: 'pending', title: 'Pay ' + cr.name + ' ' + money(tier.bonus) + ' ' + tier.name + ' bonus' }, base);
      item.reasoning = cr.handle + ' crossed ' + fmtViews(tier.views) + ' views (now ' + fmtViews(cr.views) + '). Organic growth looks normal (+' + fmtViews(cr.lastGain) + ' today vs ' + fmtViews(cr.avgDaily) + '/day avg).';
      s.pending.unshift(item);
      audit(s, { actor: 'agent', type: 'proposed', title: item.title, detail: 'Payouts always need approval. ' + item.reasoning, amount: tier.bonus, ref: item.id });
    });
  }

  // ---------- public actions ----------
  function tick(s) { simulateDay(s); runAgent(s); return s; }

  function addViews(s, creatorId, gain) {
    var cr = find(s.creators, creatorId);
    if (!cr) throw new Error('Unknown creator');
    var spike = recordViews(s, cr, gain);
    audit(s, { actor: 'system', type: 'views', title: cr.name + ' +' + fmtViews(gain) + ' views', detail: spike ? 'Unusual spike detected' : 'Now at ' + fmtViews(cr.views) });
    checkCreator(s, cr);
    return s;
  }

  // payoutFn(item, creator) -> Promise<{ transferId, status, mode }>
  async function approve(s, id, payoutFn, who) {
    var item = find(s.pending, id);
    if (!item || (item.status !== 'pending' && item.status !== 'held')) throw new Error('Nothing to approve');
    who = who || 'You';
    if (item.type === 'payout') {
      var cr = find(s.creators, item.creatorId);
      if (s.treasury.balance < item.amount) {
        item.status = 'failed';
        audit(s, { actor: 'policy', type: 'blocked', title: 'Payout blocked', detail: 'Wallet balance too low for ' + money(item.amount), amount: item.amount, ref: item.id });
        return s;
      }
      var wasHeld = item.status === 'held';
      item.status = 'processing';
      try {
        var res = await payoutFn(item, cr);
        item.status = 'paid';
        item.transferId = res.transferId;
        item.mode = res.mode;
        cr.paidTiers.push(item.tierViews);
        s.treasury.balance -= item.amount;
        audit(s, { actor: 'human', type: 'paid', title: item.title.replace(/^Hold/, 'Released') , detail: (wasHeld ? who + ' reviewed the spike and released it. ' : 'Approved by ' + who + '. ') + 'Airwallex transfer ' + res.transferId + ' (' + res.status + ', ' + res.mode + ')', amount: item.amount, ref: item.id, txId: res.transferId });
      } catch (err) {
        item.status = wasHeld ? 'held' : 'pending';
        audit(s, { actor: 'system', type: 'error', title: 'Payout failed', detail: String(err && err.message || err), amount: item.amount, ref: item.id });
      }
      return s;
    }
    if (item.type === 'boost' && totalBudget(s) + item.amount > s.policy.dailySpendCap) {
      item.status = 'failed';
      audit(s, { actor: 'policy', type: 'blocked', title: 'Blocked by daily spend cap', detail: 'Approval came too late: total would be ' + money(totalBudget(s) + item.amount) + ' vs ' + money(s.policy.dailySpendCap) + ' cap', amount: item.amount, ref: item.id });
      return s;
    }
    if (item.type === 'shift' && find(s.campaigns, item.from).budget - item.amount < s.policy.minCampaignBudget) {
      item.status = 'failed';
      audit(s, { actor: 'policy', type: 'blocked', title: 'Budget move blocked', detail: 'Would push ' + find(s.campaigns, item.from).name + ' below its ' + money(s.policy.minCampaignBudget) + ' floor', amount: item.amount, ref: item.id });
      return s;
    }
    var rec = applyChange(s, item);
    item.status = 'approved';
    audit(s, { actor: 'human', type: 'executed', title: item.title, detail: 'Approved by ' + who + '. ' + item.reasoning, amount: item.amount, ref: rec.id, rollback: true });
    return s;
  }

  function reject(s, id, who) {
    var item = find(s.pending, id);
    if (!item || (item.status !== 'pending' && item.status !== 'held')) throw new Error('Nothing to reject');
    item.status = 'rejected';
    if (item.type === 'payout') find(s.creators, item.creatorId).declinedTiers.push(item.tierViews);
    audit(s, { actor: 'human', type: 'rejected', title: 'Rejected: ' + item.title, detail: 'Declined by ' + (who || 'You'), amount: item.amount, ref: item.id });
    return s;
  }

  function rollback(s, changeId, who) {
    var rec = find(s.changes, changeId);
    if (!rec || rec.rolledBack) throw new Error('Nothing to roll back');
    // undo just this change by applying its inverse, leaving later changes intact
    var to = find(s.campaigns, rec.to);
    var take = Math.min(rec.amount, Math.max(0, to.budget - s.policy.minCampaignBudget));
    to.budget -= take;
    if (rec.type === 'shift') find(s.campaigns, rec.from).budget += take;
    rec.rolledBack = true;
    audit(s, { actor: 'human', type: 'rollback', title: 'Rolled back: ' + rec.title, detail: money(take) + (rec.type === 'shift' ? ' returned to ' + find(s.campaigns, rec.from).name : ' removed from ' + to.name) + ' by ' + (who || 'You'), amount: take, ref: rec.id });
    return s;
  }

  function updatePolicy(s, patch) {
    var changed = [];
    Object.keys(patch || {}).forEach(function (k) {
      if (!(k in s.policy)) return;
      var v = typeof s.policy[k] === 'boolean' ? !!patch[k] : Number(patch[k]);
      if (typeof v === 'number' && !isFinite(v)) return;
      if (s.policy[k] !== v) { changed.push(k + ': ' + s.policy[k] + ' -> ' + v); s.policy[k] = v; }
    });
    if (changed.length) audit(s, { actor: 'human', type: 'policy', title: 'Guardrails updated', detail: changed.join(', ') });
    return s;
  }

  function summary(s) {
    var spend = 0, rev = 0;
    s.campaigns.forEach(function (c) { spend += c.totalSpend; rev += c.totalRevenue; });
    return {
      totalBudget: totalBudget(s),
      blendedRoas: spend ? r2(rev / spend) : null,
      pendingCount: s.pending.filter(function (p) { return p.status === 'pending' || p.status === 'held'; }).length,
      bonusesPaid: s.pending.filter(function (p) { return p.status === 'paid'; }).reduce(function (t, p) { return t + p.amount; }, 0)
    };
  }

  function creatorProgress(s, cr) {
    var next = null;
    for (var i = 0; i < s.tiers.length; i++) if (cr.views < s.tiers[i].views) { next = s.tiers[i]; break; }
    var earned = s.tiers.filter(function (t) { return cr.paidTiers.indexOf(t.views) !== -1; }).reduce(function (t, x) { return t + x.bonus; }, 0);
    var pending = s.pending.filter(function (p) { return p.creatorId === cr.id && (p.status === 'pending' || p.status === 'held'); }).reduce(function (t, x) { return t + x.amount; }, 0);
    var potential = s.tiers.reduce(function (t, x) { return t + x.bonus; }, 0);
    return { next: next, toNext: next ? next.views - cr.views : 0, earned: earned, pending: pending, potential: potential, daysToNext: next && cr.avgDaily ? Math.ceil((next.views - cr.views) / cr.avgDaily) : null };
  }

  return {
    createInitialState: createInitialState,
    tick: tick,
    runAgent: runAgent,
    addViews: addViews,
    approve: approve,
    reject: reject,
    rollback: rollback,
    updatePolicy: updatePolicy,
    summary: summary,
    creatorProgress: creatorProgress,
    totalBudget: totalBudget,
    fmt: { money: money, views: fmtViews }
  };
});
