# VouchPay

**AI does the work. You vouch for the money.**

Autonomous ad spend + creator performance bonuses, accountable by design.

Brands pay creators a monthly base, but the creators who drive results deserve more. VouchPay is an AI agent that watches campaign performance every day. It moves ad budget toward what's working and pays creators performance bonuses through Airwallex when they hit view milestones. Every action runs through guardrails a finance team would demand.

Built for the Airwallex Agentic Banking Hackathon 2026.

## What the agent does

| Daily loop | How it works |
| --- | --- |
| Rebalance ad spend | Ranks campaigns by ROAS and moves budget from the weakest to the strongest |
| Ask for more budget | When a campaign beats the boost ROAS, it requests new daily budget |
| Creator bonuses | When a creator crosses a tier (50K, 100K, 250K views), it queues an Airwallex payout |

## Guardrails

| Guardrail | Behavior |
| --- | --- |
| Daily spend cap | Total ad budget can never exceed the cap. Requests over it are blocked and logged |
| Max move per action | The agent can move at most 20% of a campaign's budget at once. Larger intents are clamped |
| Campaign floor | No campaign is starved below a minimum budget |
| Human approval | Budget moves at or above the threshold, and every payout, wait in an approval queue |
| Fraud check | A one-day view gain over 5x the creator's average holds the bonus for review. Spikes are kept out of the baseline |
| Idempotent payouts | Each Airwallex transfer has a unique `request_id`, so a retried approval can't double-pay |
| Audit log | Every action records who did it (agent, guardrail, human), why, the amount and the Airwallex transfer ID |
| Rollback | Any executed budget move can be undone in one click |

All guardrails are editable live in the dashboard and covered by `npm test`.

## Run it (Windows PowerShell)

Requires Node.js 18 or newer. There are no dependencies to install.

```powershell
cd vouchpay
npm test
npm start
```

Open http://localhost:3000.

### Connect the Airwallex sandbox

Without keys, payouts are simulated so the demo always runs. To send real sandbox transfers:

1. Log in to the sandbox web app at https://www.sandbox.airwallex.com/app/ and go to **Settings > Developer > API keys**. Copy the **Client ID**, then generate an **API key** and copy it right away (it is only shown once).
2. Create your `.env` file:
   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```
   Paste the values after `AIRWALLEX_CLIENT_ID=` and `AIRWALLEX_API_KEY=` with no quotes or spaces, then save.
3. Check the connection and list your beneficiaries:
   ```powershell
   npm run check
   ```
4. In the sandbox web app, create three payees (one per demo creator), run `npm run check` again and copy their IDs into `.env`:
   ```
   AIRWALLEX_BENEFICIARIES=cr1:<Maya's id>,cr2:<Jordan's id>,cr3:<Ava's id>
   ```
5. Restart with `npm start`. The header badge switches to **Airwallex sandbox**, approved bonuses call `POST /api/v1/transfers/create` and the returned transfer ID shows in the audit log.

Any creator without a beneficiary ID falls back to a simulated payout and is labeled that way in the log.

## Deploy (Render)

`render.yaml` is included. In Render choose **New > Blueprint**, pick this repo and enter the Airwallex values when asked. Then add a custom domain under the service's **Settings > Custom Domains** and point a `CNAME` record at the service's `onrender.com` address.

## Demo script (under 5 minutes)

1. **Run next day** a few times. The agent shifts budget from Retargeting to Glow Serum, and the log shows guardrails clamping moves.
2. Approve the **New budget** request. Approve the next one and watch the spend cap block the third.
3. Click **+10K organic** on Maya. Her Silver bonus is queued. **Approve & pay** sends the Airwallex transfer.
4. Click **Bot spike** on Jordan. The fraud check holds his bonus instead of paying it.
5. Click **Undo** on a budget move in the audit log.
6. Switch to **Creator view** to show what creators see: base pay, bonuses earned and how close they are to the next tier.

## Project layout

```
server.js           zero-dependency Node server + JSON API
src/engine.js       agent, guardrails, audit log (shared by server and browser)
src/airwallex.js    Airwallex auth + transfers, simulated fallback
src/env.js          .env loader
scripts/check-airwallex.js  npm run check: verifies keys, lists beneficiaries
render.yaml         one-click Render deploy
public/             dashboard UI
scripts/test.js     guardrail tests
scripts/build-demo.js  builds dist/demo.html, a single-file browser demo
```

## What's next

- Live ad platform connectors (Meta, TikTok, Google Ads) and verified creator view data
- Per-creator contracts and tier schedules, plus base-pay scheduling through Airwallex
- Airwallex Issuing cards per campaign so ad spend limits are enforced at the card level
- Multi-currency payouts with FX for global creators, and creator onboarding with KYC
- Forecast-based budget optimization instead of single-day ROAS
