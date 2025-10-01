const express = require('express');
const Stripe = require('stripe');
const { getDb } = require('../db.cjs');
const { config } = require('../config.cjs');

const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey, { timeout: 120000 }) : null;

// --- Create Checkout (normal JSON route) ---
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
          product_data: { name: 'Raffle Entry' },
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

// --- Stripe Webhook (RAW BODY) ---
// Return a router so server.cjs can mount it as webhookRouter()
function webhookRouter() {
  const router = express.Router();

  router.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
      if (!stripe) return res.status(501).json({ error: 'Stripe not configured' });

      const sig = req.headers['stripe-signature'];
      if (!sig || !config.stripeWebhookSecret) {
        return res.status(400).json({ error: 'Missing stripe signature/secret' });
      }

      const event = stripe.webhooks.constructEvent(req.body, sig, config.stripeWebhookSecret);

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.metadata?.userId || '';
        const total = Number(session.amount_total || 0);
        const price = Number(config.pricePerEntry || 700);
        let entries = Number(session.metadata?.entriesPurchased || 0);
        if (!entries) entries = total ? Math.max(1, Math.round(total / price)) : 1;

        if (userId && entries > 0) {
          const db = getDb();
          const paymentId = session.id; // idempotency key

          await db.collection('tickets').updateOne(
            { userId },
            { $inc: { tickets: entries } },
            { upsert: true }
          );

          // Idempotent insert
          try {
            await db.collection('payments').insertOne({
              paymentId,
              userId,
              entries,
              amount: total,
              timestamp: new Date(),
              source: 'stripe',
              eventId: event.id
            });
          } catch (_) { /* duplicate, ignore */ }
        }
      }

      res.status(200).json({ received: true });
    } catch (err) {
      console.error('[stripe/webhook]', err);
      res.status(400).json({ error: 'Webhook error', message: err.message || String(err) });
    }
  });

  return router;
}

module.exports = { checkoutRouter, webhookRouter };
