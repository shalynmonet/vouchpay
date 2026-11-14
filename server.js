// VouchPay server: zero dependencies, Node 18+.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

require('./src/env');

const Engine = require('./src/engine');
const airwallex = require('./src/airwallex');
const serv = require('./src/serv');

const PORT = Number(process.env.PORT || 3000);
const DATA = path.join(__dirname, 'data', 'state.json');

let state = load();
function load() {
  try { return Engine.migrate(JSON.parse(fs.readFileSync(DATA, 'utf8'))); } catch { return Engine.createInitialState(); }
}
function save() {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(DATA, JSON.stringify(state, null, 2));
}

let autopilot = null;

// SERV Reasoning reviews every queued money decision, one at a time, in the background.
let reviewing = false;
async function runReviews() {
  if (!serv.enabled || reviewing) return;
  reviewing = true;
  try {
    for (;;) {
      const s = state;
      const item = s.pending.find((p) => (p.status === 'pending' || p.status === 'held') && !p.review);
      if (!item) break;
      item.review = { status: 'running' };
      save();
      try {
        const r = await serv.review(s, item);
        item.review = Object.assign({ status: 'done' }, r);
        const label = { approve: 'Approve', hold: 'Hold', reject: 'Reject' }[r.verdict];
        Engine.addAudit(s, {
          actor: 'serv', type: 'serv', ref: item.id, amount: item.amount,
          title: 'SERV review: ' + label + ' \u00b7 ' + item.title,
          detail: (r.summary ? r.summary + ' ' : '') + r.reasons.map((x) => x.replace(/\.?\s*$/, '.')).join(' ') + ' (' + Math.round(r.confidence * 100) + '% confidence, ' + r.model + ', ' + (r.ms / 1000).toFixed(1) + 's)'
        });
        // SERV-earned autonomy: small, clean bonuses pay out without waiting for a human
        const p = s.policy;
        if (item.type === 'payout' && item.status === 'pending' && r.verdict === 'approve' &&
            p.autoPayMax > 0 && item.amount <= p.autoPayMax && r.confidence >= p.autoPayMinConfidence) {
          Engine.addAudit(s, { actor: 'agent', type: 'auto', ref: item.id, amount: item.amount, title: 'Auto-paying ' + item.creatorName + ' $' + item.amount,
            detail: 'SERV approved at ' + Math.round(r.confidence * 100) + '% confidence (needs ' + Math.round(p.autoPayMinConfidence * 100) + '%) and the bonus is within the $' + p.autoPayMax + ' auto-pay limit. Larger or flagged payouts still wait for a human.' });
          item.autoPaid = true;
          await Engine.approve(s, item.id, airwallex.payCreator, 'Auto-paid by the agent after SERV review', 'agent');
        }
      } catch (err) {
        item.review = { status: 'error', message: err.message };
        Engine.addAudit(s, { actor: 'system', type: 'error', ref: item.id, title: 'SERV review unavailable', detail: err.message + '. The guardrails and human approval still apply.' });
      }
      save();
    }
  } finally {
    reviewing = false;
  }
}

function view() {
  return {
    state,
    summary: Engine.summary(state),
    mode: airwallex.live ? 'Airwallex sandbox' : 'Simulated payouts',
    beneficiaries: airwallex.beneficiaryCount,
    autopilot: Boolean(autopilot),
    serv: { enabled: serv.enabled, model: serv.model }
  };
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const routes = {
  'GET /api/state': () => view(),
  'POST /api/tick': () => { Engine.tick(state); return view(); },
  'POST /api/views': (b) => { Engine.addViews(state, b.creatorId, Number(b.gain)); return view(); },
  'POST /api/approve': async (b) => { await Engine.approve(state, b.id, airwallex.payCreator, b.who); return view(); },
  'POST /api/reject': (b) => { Engine.reject(state, b.id, b.who); return view(); },
  'POST /api/rollback': (b) => { Engine.rollback(state, b.id, b.who); return view(); },
  'POST /api/policy': (b) => { Engine.updatePolicy(state, b); return view(); },
  'POST /api/reset': () => { state = Engine.createInitialState(); return view(); },
  'POST /api/autopilot': (b) => {
    if (b.on && !autopilot) autopilot = setInterval(() => { Engine.tick(state); save(); runReviews(); }, Number(b.everyMs) || 4000);
    if (!b.on && autopilot) { clearInterval(autopilot); autopilot = null; }
    return view();
  },
  'GET /api/balances': async () => ({ balances: await airwallex.getBalances() })
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const key = req.method + ' ' + url.pathname;
  if (routes[key]) {
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const out = await routes[key](body);
      save();
      if (req.method === 'POST') runReviews();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  // static files: /engine.js comes from src so browser and server share one engine
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const fp = file === '/engine.js' ? path.join(__dirname, 'src', 'engine.js') : path.join(__dirname, 'public', path.normalize(file));
  if (!fp.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`\n  VouchPay running at http://localhost:${PORT}`);
  console.log(`  SERV Reasoning: ${serv.enabled ? 'on (' + serv.model + ')' : 'off (add SERV_API_KEY to turn on)'}`);
  console.log(`  Payout mode: ${airwallex.live ? 'Airwallex sandbox (' + airwallex.base + ')' : 'simulated (add keys to .env for sandbox)'}\n`);
});
