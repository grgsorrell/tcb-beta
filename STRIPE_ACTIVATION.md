# Stripe Activation Checklist

## Current Status: INACTIVE
`STRIPE_ACTIVE = false` — all billing is hidden and no-op.

## Pricing
| Plan | Monthly | Annual (2 months free) |
|------|---------|----------------------|
| Starter | $39 | $390 |
| Campaign | $79 | $790 |
| Pro | $149 | $1,490 |
| Consultant | $299 | $2,990 |

## Plan Limits
| Plan | Users | Campaigns |
|------|-------|-----------|
| Starter | 1 | 1 |
| Campaign | 3 | 3 |
| Pro | 10 | 10 |
| Consultant | Unlimited | Unlimited |
| Beta | Unlimited | Unlimited |

## Before Activating
- [ ] Create Stripe products and prices in Stripe Dashboard
- [ ] Save price IDs as secrets: `wrangler secret put STRIPE_STARTER_MONTHLY` etc.
- [ ] Save `STRIPE_SECRET_KEY` as secret
- [ ] Save `STRIPE_WEBHOOK_SECRET` as secret
- [ ] Register webhook endpoint in Stripe: `https://candidate-toolbox-secretary2.grgsorrell.workers.dev/api/billing/webhook`
- [ ] Test checkout flow end-to-end in test mode
- [ ] Test webhook events via `stripe listen --forward-to`
- [ ] Test subscription cancellation
- [ ] Test plan upgrade/downgrade
- [ ] Verify invoice recording in D1
- [ ] Test trial expiry flow
- [ ] Uncomment trial UI in worker.js and index.html (search "BETA:")
- [ ] Change new account default plan from 'beta' to 'trial' in worker.js
- [ ] Test on mobile

## Activation
- [ ] `wrangler secret put STRIPE_ACTIVE` → set to `true`
- [ ] `wrangler deploy`
- [ ] `wrangler deploy --name tcb-beta --assets .`
- [ ] Verify trial countdown appears for trial users
- [ ] Verify upgrade flow works
- [ ] Create test subscription
- [ ] Verify D1 updated correctly
- [ ] Monitor Stripe dashboard for first hour

## After Activation
- [ ] Send announcement to beta users (they keep beta plan, no change)
- [ ] Monitor for payment failures
- [ ] Check error logs
- [ ] Celebrate

## Rollback
If anything goes wrong:
```
wrangler secret put STRIPE_ACTIVE → set to 'false'
wrangler deploy
```
All billing UI immediately disappears. No user impact.
