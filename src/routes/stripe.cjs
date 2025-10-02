const express = require('express');
const Stripe = require('stripe');
const { getDb } = require('../db.cjs');
const { config } = require('../config.cjs');

const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey, { timeout: 120000 }) : null;

/* --- Create Checkout (normal JSON route) --- */
const checkoutRouter = express.Router();

checkoutRouter.post('/payment/create-checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(501).json({ error: 'Stripe not configured' });
    const { userId, entries } = req.body || {};
    const n = Number(entries || 0);
    if (!userId || n < 1) return res.status(400).json({ error: 'userId and entries required' });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      success_url: `${config.siteUrl}/payment-success/index.html?session_id={CHECKOUT_SESSION_ID}&success=1`,
      cancel_url: `${config.siteUrl}/modules/raffle/?canceled=1`,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'Talent Credits' }, // renamed from "Raffle Entry"
          unit_amount: config.pricePerEntry
        },
        quantity: n
      }],
      metadata: { userId, entriesPurchased: String(n) }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('/api/payment/create-checkout error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* --- Stripe Webhook (RAW BODY) --- */
/* Return a router so server.cjs can mount it as webhookRouter() */
function webhookRouter() {
  const router = express.Router();

  router.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    // Early hit log so you SEE requests in Render logs even if signature fails
    const sig = req.headers['stripe-signature'];
    console.log(`[webhook] HIT /api/stripe/webhook sigPresent=${!!sig} rawLen=${req.body?.length || 0}`);

    try {
      if (!stripe) return res.status(501).json({ error: 'Stripe not configured' });
      if (!sig || !config.stripeWebhookSecret) {
        return res.status(400).json({ error: 'Missing stripe signature/secret' });
      }

      const event = stripe.webhooks.constructEvent(req.body, sig, config.stripeWebhookSecret);

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const db = getDb();

        const userId = session.metadata?.userId || '';
        const total = Number(session.amount_total || 0);
        const price = Number(config.pricePerEntry || 700);
        let entries = Number(session.metadata?.entriesPurchased || 0);
        if (!entries) entries = total ? Math.max(1, Math.round(total / price)) : 1;

        if (userId && entries > 0) {
          const paymentId = session.id; // idempotency key

          /* >>> IDPOTENT FLOW: upsert payment FIRST, then increment tickets ONLY if newly inserted */
          const up = await db.collection('payments').updateOne(
            { paymentId },
            {
              $setOnInsert: {
                paymentId,
                userId,
                entries,
                amount: total,
                timestamp: new Date(),
                source: 'stripe',
                eventId: event.id,
              },
            },
            { upsert: true }
          );

          if (up.upsertedCount === 1) {
            await db.collection('tickets').updateOne(
              { userId },
              { $inc: { tickets: entries } },
              { upsert: true }
            );
          }

          /* Proof-of-reception / audit trail (safe on replay) */
          try {
            await db.collection('webhook_events').insertOne({
              eventId: event.id,
              type: event.type,
              sessionId: session.id,
              userId,
              amount: total,
              entries,
              receivedAt: new Date(),
            });
          } catch (_) { /* duplicate on replay, ignore */ }

          console.log(
            `[webhook] checkout.session.completed eventId=${event.id} sessionId=${session.id} userId=${userId} amount=${total} entries=${entries} firstTime=${up.upsertedCount === 1}`
          );
        }
      }

      res.status(200).json({ received: true });
    } catch (err) {
      console.error('[stripe/webhook]', err);
      res.status(400).json({ error: 'Webhook error', message: err.message || String(err) });
    }
  });

  /* Admin: list recent webhook events (read-only, protected by token) */
  router.get('/admin/webhooks/recent', async (req, res) => {
    try {
      const token = req.headers['x-admin-token'] || req.query.token;
      const expected = process.env.ADMIN_TOKEN || config.adminToken;
      if (!expected || token !== expected) {
        return res.status(401).json({ error: 'unauthorized' });
      }

      const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10));
      const db = getDb();
      const docs = await db.collection('webhook_events')
        .find()
        .sort({ _id: -1 })
        .limit(limit)
        .toArray();

      res.json({ events: docs });
    } catch (err) {
      console.error('/api/admin/webhooks/recent error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { checkoutRouter, webhookRouter };
