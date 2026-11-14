/* VouchPay dashboard. Talks to the Node server when it's running, otherwise runs the engine in the browser (demo mode). */
(function () {
  'use strict';
  var E = window.VouchEngine;
  var money = E.fmt.money, views = E.fmt.views;
  var STORE = 'vouchpay_state_v1';
  var remote = false, data = null, busy = false, localTimer = null;
  var auditFilter = 'all', selectedCreator = 'cr1';

  // ---------- data layer ----------
  function localView(state) {
    return { state: state, summary: E.summary(state), mode: 'Demo mode: simulated payouts', autopilot: Boolean(localTimer) };
  }
  function saveLocal() { try { localStorage.setItem(STORE, JSON.stringify(data.state)); } catch (e) { /* storage unavailable, keep in memory */ } }
  function loadLocal() {
    try { var raw = localStorage.getItem(STORE); if (raw) return E.migrate(JSON.parse(raw)); } catch (e) { /* ignore */ }
    return E.createInitialState();
  }
  function simulatedPayout() {
    return new Promise(function (r) { setTimeout(r, 700); }).then(function () {
      return { transferId: 'sim_' + Math.random().toString(16).slice(2, 10), status: 'SIMULATED', mode: 'demo' };
    });
  }

  var local = {
    tick: function () { E.tick(data.state); },
    views: function (b) { E.addViews(data.state, b.creatorId, b.gain); },
    approve: function (b) { return E.approve(data.state, b.id, simulatedPayout); },
    reject: function (b) { E.reject(data.state, b.id); },
    rollback: function (b) { E.rollback(data.state, b.id); },
    policy: function (b) { E.updatePolicy(data.state, b); },
    reset: function () { data.state = E.createInitialState(); },
    autopilot: function (b) {
      if (b.on && !localTimer) localTimer = setInterval(function () { E.tick(data.state); data = localView(data.state); saveLocal(); render(); }, 3500);
      if (!b.on && localTimer) { clearInterval(localTimer); localTimer = null; }
    }
  };

  async function act(name, body) {
    if (busy) return;
    busy = true; setBusy(true);
    try {
      if (remote) {
        var res = await fetch('api/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
        var out = await res.json();
        if (!res.ok) throw new Error(out.error || 'Request failed');
        data = out;
      } else {
        await local[name](body || {});
        data = localView(data.state);
        saveLocal();
      }
      render();
    } catch (err) {
      toast(err.message || String(err));
    } finally {
      busy = false; setBusy(false);
    }
  }

  function setBusy(on) { document.querySelectorAll('button[data-act]').forEach(function (b) { b.disabled = on; }); }

  async function poll() {
    if (!remote || busy || !data) return;
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#policy')) return;
    try { var r = await fetch('api/state'); data = await r.json(); render(); } catch (e) { /* ignore */ }
  }

  // ---------- render ----------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function $(id) { return document.getElementById(id); }
  function find(arr, id) { for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i]; return null; }

  function render() {
    var s = data.state, sum = data.summary;
    var live = /sandbox/i.test(data.mode);
    $('mode').textContent = data.mode;
    $('mode').className = 'badge' + (live ? ' live' : '');
    $('day').textContent = 'Day ' + s.day;
    var sv = $('serv');
    if (data.serv && data.serv.enabled) { sv.textContent = 'SERV Reasoning on'; sv.className = 'badge serv'; }
    else sv.className = 'hidden';
    var auto = $('auto');
    auto.textContent = 'Autopilot: ' + (data.autopilot ? 'on' : 'off');
    auto.classList.toggle('on', !!data.autopilot);
    renderKpis(s, sum);
    renderQueue(s);
    renderCampaigns(s);
    renderPolicy(s);
    renderDemo(s);
    renderAudit(s);
    renderCreator(s);
  }

  function renderKpis(s, sum) {
    var pct = Math.min(100, Math.round(sum.totalBudget / s.policy.dailySpendCap * 100));
    var holds = s.pending.filter(function (p) { return p.status === 'held'; }).length;
    $('kpis').innerHTML =
      kpi('Daily ad budget', money(sum.totalBudget), 'of ' + money(s.policy.dailySpendCap) + ' cap', '<div class="meter' + (pct >= 90 ? ' hot' : '') + '"><i style="width:' + pct + '%"></i></div>') +
      kpi('Blended ROAS', sum.blendedRoas ? sum.blendedRoas + 'x' : 'n/a', sum.blendedRoas ? 'across ' + (s.day - 1) + ' day' + (s.day - 1 === 1 ? '' : 's') + ' of spend' : 'run a day to see results') +
      kpi(s.treasury.label, money(s.treasury.balance), money(sum.bonusesPaid) + ' in bonuses paid') +
      kpi('Needs your approval', String(sum.pendingCount), holds ? holds + ' fraud hold' + (holds > 1 ? 's' : '') : 'nothing flagged');
  }
  function kpi(label, value, sub, extra) {
    return '<div class="kpi"><div class="label">' + esc(label) + '</div><div class="value num">' + esc(value) + '</div><div class="sub">' + esc(sub) + '</div>' + (extra || '') + '</div>';
  }

  var TYPE_LABEL = { payout: 'Creator bonus', shift: 'Budget move', boost: 'New budget' };

  function renderQueue(s) {
    var items = s.pending.filter(function (p) { return p.status === 'pending' || p.status === 'held' || p.status === 'processing'; });
    if (!items.length) { $('queue').innerHTML = '<div class="empty">Nothing waiting. The agent is operating inside its guardrails.</div>'; return; }
    $('queue').innerHTML = items.map(function (p) {
      var held = p.status === 'held';
      var primary = held ? 'Release &amp; pay' : p.type === 'payout' ? 'Approve &amp; pay' : 'Approve';
      var pill = held ? '<span class="pill held">Fraud hold</span>' : '<span class="pill ' + p.type + '">' + TYPE_LABEL[p.type] + '</span>';
      return '<div class="req' + (held ? ' held' : '') + '">' +
        '<div class="req-top"><div>' + pill + '<div class="req-title">' + esc(p.title) + '</div></div><div class="req-amt num">' + money(p.amount) + '</div></div>' +
        (held ? '<div class="req-flag">' + esc(p.flag) + '</div>' : '') +
        '<div class="req-why">' + esc(p.reasoning) + '</div>' + reviewBlock(p) +
        '<div class="req-actions">' +
        (p.status === 'processing' ? '<span class="hint">Sending to Airwallex...</span>' :
          '<button class="btn sm ' + (held ? '' : 'good') + '" data-act="approve" data-id="' + p.id + '">' + primary + '</button>' +
          '<button class="btn sm bad" data-act="reject" data-id="' + p.id + '">' + (held ? 'Decline' : 'Reject') + '</button>') +
        '</div></div>';
    }).join('');
  }

  function reviewBlock(p) {
    var r = p.review;
    if (!r) return '';
    if (r.status === 'running') return '<div class="serv-box running"><span class="serv-tag">SERV Reasoning</span> Reviewing this decision\u2026</div>';
    if (r.status === 'error') return '<div class="serv-box"><span class="serv-tag">SERV Reasoning</span> Review unavailable. Guardrails still apply.</div>';
    var label = { approve: 'Recommends approve', hold: 'Recommends hold', reject: 'Recommends reject' }[r.verdict];
    return '<div class="serv-box v-' + r.verdict + '"><div class="serv-head"><span class="serv-tag">SERV Reasoning</span><strong>' + label + '</strong><span class="serv-conf">' + Math.round(r.confidence * 100) + '% confidence</span></div>' +
      (r.summary ? '<div class="serv-sum">' + esc(r.summary) + '</div>' : '') +
      (r.reasons.length ? '<ul>' + r.reasons.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') +
      (r.riskFlags && r.riskFlags.length ? '<div class="serv-flags">' + r.riskFlags.map(function (x) { return '<span>' + esc(x) + '</span>'; }).join('') + '</div>' : '') +
      '<div class="serv-meta">' + esc(r.model) + ' \u00b7 ' + (r.ms / 1000).toFixed(1) + 's</div></div>';
  }

  function spark(hist) {
    if (!hist || hist.length < 2) return '<svg class="spark"></svg>';
    var w = 90, h = 28, max = Math.max.apply(null, hist), min = Math.min.apply(null, hist), span = max - min || 1;
    var pts = hist.map(function (v, i) { return (i / (hist.length - 1) * (w - 4) + 2).toFixed(1) + ',' + (h - 3 - (v - min) / span * (h - 6)).toFixed(1); });
    var last = pts[pts.length - 1].split(',');
    return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '"><polyline points="' + pts.join(' ') + '" fill="none" stroke="#16171b" stroke-width="1.6" stroke-linejoin="round"/><circle cx="' + last[0] + '" cy="' + last[1] + '" r="2.5" fill="#4f35e8"/></svg>';
  }

  function renderCampaigns(s) {
    var max = Math.max.apply(null, s.campaigns.map(function (c) { return c.budget; }));
    var sorted = s.campaigns.slice().sort(function (a, b) { return b.lastRoas - a.lastRoas; });
    $('campaigns').innerHTML = sorted.map(function (c, i) {
      var cls = i === 0 ? 'up' : i === sorted.length - 1 ? 'down' : '';
      return '<div class="camp"><div><div class="camp-name">' + esc(c.name) + '</div><div class="camp-plat">' + esc(c.platform) + '</div></div>' +
        '<div class="bar-cell"><div class="bar"><i style="width:' + Math.round(c.budget / max * 100) + '%"></i></div><div class="camp-budget num">' + money(c.budget) + '/day</div></div>' +
        '<div class="roas num ' + cls + '">' + c.lastRoas.toFixed(2) + 'x</div>' + spark(c.history) + '</div>';
    }).join('');
  }

  var POLICY_FIELDS = [
    ['dailySpendCap', 'Daily spend cap ($)', 1, 100],
    ['approvalThreshold', 'Approval needed at ($)', 1, 50],
    ['maxShiftPct', 'Max move per action (%)', 100, 5],
    ['minCampaignBudget', 'Campaign floor ($)', 1, 50],
    ['spikeMultiplier', 'Fraud hold at view spike (x avg)', 1, 1],
    ['boostRoas', 'Ask for more budget at ROAS', 1, 0.1],
    ['autoPayMax', 'SERV auto-pay up to ($, 0 = off)', 1, 50],
    ['autoPayMinConfidence', 'SERV auto-pay confidence (%)', 100, 1]
  ];
  function renderPolicy(s) {
    var form = $('policy');
    if (form.contains(document.activeElement)) return; // don't clobber typing
    form.innerHTML = POLICY_FIELDS.map(function (f) {
      var v = s.policy[f[0]] * f[2];
      return '<label>' + f[1] + '<input type="number" name="' + f[0] + '" value="' + Math.round(v * 100) / 100 + '" step="' + f[3] + '" min="0"></label>';
    }).join('');
  }

  function renderDemo(s) {
    $('demo').innerHTML = s.creators.map(function (cr) {
      return '<div class="demo-row"><div class="who">' + esc(cr.name) + '<small>' + esc(cr.handle) + ' · ' + views(cr.views) + ' views · ~' + views(cr.avgDaily) + '/day</small></div>' +
        '<div class="acts"><button class="btn sm" data-act="views" data-id="' + cr.id + '" data-gain="10000">+10K organic</button>' +
        '<button class="btn sm bad" data-act="views" data-id="' + cr.id + '" data-gain="' + Math.max(30000, cr.avgDaily * 12) + '">Bot spike</button></div></div>';
    }).join('');
  }

  var FILTERS = [['all', 'All'], ['agent', 'Agent'], ['serv', 'SERV'], ['policy', 'Guardrails'], ['human', 'Human'], ['paid', 'Payouts']];
  function renderAudit(s) {
    $('filters').innerHTML = FILTERS.map(function (f) { return '<button class="chip' + (auditFilter === f[0] ? ' active' : '') + '" data-filter="' + f[0] + '">' + f[1] + '</button>'; }).join('');
    var rows = s.audit.filter(function (a) {
      if (auditFilter === 'all') return true;
      if (auditFilter === 'paid') return a.type === 'paid';
      return a.actor === auditFilter;
    });
    if (!rows.length) { $('audit').innerHTML = '<li class="empty">No entries yet. Hit "Run next day" to let the agent work.</li>'; return; }
    $('audit').innerHTML = rows.slice(0, 120).map(function (a) {
      var chg = a.rollback ? find(s.changes, a.ref) : null;
      var meta = ['Day ' + a.day];
      if (a.amount) meta.push(money(a.amount));
      var extra = '';
      if (a.txId) extra += '<span class="tx">' + esc(a.txId) + '</span>';
      if (chg && !chg.rolledBack) extra += '<button class="btn sm" data-act="rollback" data-id="' + chg.id + '">Undo</button>';
      if (chg && chg.rolledBack) extra += '<span>Rolled back</span>';
      var label = a.actor === 'policy' ? 'Guard' : a.actor === 'serv' ? 'SERV' : a.actor;
      return '<li class="entry"><span class="actor actor-' + a.actor + '">' + label + '</span><div>' +
        '<div class="entry-title' + (chg && chg.rolledBack ? ' undone' : '') + '">' + esc(a.title) + '</div>' +
        (a.detail ? '<div class="entry-detail">' + esc(a.detail) + '</div>' : '') +
        '<div class="entry-meta"><span>' + meta.join(' · ') + '</span>' + extra + '</div></div></li>';
    }).join('');
  }

  function renderCreator(s) {
    $('creatorPick').innerHTML = s.creators.map(function (cr) {
      return '<button class="chip' + (cr.id === selectedCreator ? ' active' : '') + '" data-creator="' + cr.id + '">' + esc(cr.name) + '</button>';
    }).join('');
    var cr = find(s.creators, selectedCreator) || s.creators[0];
    var p = E.creatorProgress(s, cr);
    var top = s.tiers[s.tiers.length - 1].views;
    var pct = Math.min(100, cr.views / top * 100);
    var initials = cr.name.split(' ').map(function (w) { return w[0]; }).join('');
    var note = p.next
      ? views(p.toNext) + ' more views unlocks your ' + p.next.name + ' bonus (' + money(p.next.bonus) + ').' + (p.daysToNext ? ' At your current pace that’s about ' + p.daysToNext + ' day' + (p.daysToNext === 1 ? '' : 's') + '.' : '')
      : 'You’ve unlocked every tier this month.';
    var rows = s.tiers.map(function (t) {
      var st, label;
      var req = s.pending.filter(function (x) { return x.creatorId === cr.id && x.tierViews === t.views; })[0];
      if (cr.paidTiers.indexOf(t.views) !== -1) { st = 'paid'; label = 'Paid'; }
      else if (req && req.status === 'held') { st = 'review'; label = 'Under review'; }
      else if (req && (req.status === 'pending' || req.status === 'processing')) { st = 'pending'; label = 'Approval pending'; }
      else if (cr.declinedTiers.indexOf(t.views) !== -1) { st = 'review'; label = 'Declined'; }
      else { st = 'locked'; label = views(t.views) + ' views'; }
      return '<tr><td><strong>' + t.name + '</strong><div class="hint">' + views(t.views) + ' views</div></td><td class="num">' + money(t.bonus) + '</td><td><span class="status ' + st + '">' + label + '</span></td></tr>';
    }).join('');
    $('creatorCard').innerHTML =
      '<div class="card ccard"><div class="c-head"><div class="avatar">' + esc(initials) + '</div><div><h2>' + esc(cr.name) + '</h2><p>' + esc(cr.handle) + ' · ' + esc(cr.niche) + '</p></div></div>' +
      '<div class="earn">' + kpi('Base pay', money(cr.basePay), 'per month') + kpi('Bonuses earned', money(p.earned), 'of ' + money(p.potential) + ' possible') + kpi('In progress', money(p.pending), p.pending ? 'awaiting approval' : 'nothing pending') + '</div>' +
      '<div class="next-note">' + esc(note) + '</div>' +
      '<div class="hint">' + views(cr.views) + ' total views</div>' +
      '<div class="progress-wrap"><div class="progress"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
      s.tiers.map(function (t) { return '<span class="mark' + (cr.views >= t.views ? ' hit' : '') + '" style="left:' + Math.min(97, t.views / top * 100) + '%">' + t.name + '</span>'; }).join('') + '</div>' +
      '<table class="tiers">' + rows + '</table></div>';
  }

  var toastTimer;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2800);
  }

  // ---------- events ----------
  document.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'approve') return act('approve', { id: b.dataset.id }).then(function () { toast('Approved'); });
    if (b.dataset.act === 'reject') return act('reject', { id: b.dataset.id });
    if (b.dataset.act === 'rollback') return act('rollback', { id: b.dataset.id }).then(function () { toast('Change rolled back'); });
    if (b.dataset.act === 'views') return act('views', { creatorId: b.dataset.id, gain: Number(b.dataset.gain) });
    if (b.dataset.filter) { auditFilter = b.dataset.filter; return renderAudit(data.state); }
    if (b.dataset.creator) { selectedCreator = b.dataset.creator; return renderCreator(data.state); }
    if (b.dataset.view) {
      document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t === b); });
      document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('hidden', v.id !== b.dataset.view); });
    }
  });
  $('tick').addEventListener('click', function () { act('tick'); });
  $('auto').addEventListener('click', function () { act('autopilot', { on: !data.autopilot }); });
  $('reset').addEventListener('click', function () { if (confirmReset()) act('reset'); });
  $('policy').addEventListener('change', function (e) {
    var f = POLICY_FIELDS.filter(function (x) { return x[0] === e.target.name; })[0];
    if (!f) return;
    var patch = {}; patch[f[0]] = Number(e.target.value) / f[2];
    e.target.blur();
    act('policy', patch).then(function () { toast('Guardrail updated'); });
  });
  var resetArmed = false;
  function confirmReset() {
    // no blocking dialogs: second click within 3s confirms
    if (resetArmed) { resetArmed = false; $('reset').textContent = 'Reset'; return true; }
    resetArmed = true; $('reset').textContent = 'Click again to reset';
    setTimeout(function () { resetArmed = false; $('reset').textContent = 'Reset'; }, 3000);
    return false;
  }

  // ---------- boot ----------
  (async function boot() {
    try {
      if (location.protocol === 'file:') throw new Error('no server');
      var r = await fetch('api/state', { cache: 'no-store' });
      if (!r.ok) throw new Error('no server');
      data = await r.json();
      if (!data || !data.state) throw new Error('no server');
      remote = true;
      setInterval(poll, 2500);
    } catch (e) {
      remote = false;
      data = localView(loadLocal());
    }
    render();
  })();
})();
