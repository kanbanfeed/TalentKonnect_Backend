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

        // fallback to email if no metadata.userId
        let userId = session.metadata?.userId || '';
        if (!userId) {
          const email = (session.customer_details?.email || '').trim().toLowerCase();
          if (email) userId = email;
        }

        const total = Number(session.amount_total || 0);
        const price = Number(config.pricePerEntry || 700);
        let entries = Number(session.metadata?.entriesPurchased || 0);
        if (!entries) entries = total ? Math.max(1, Math.round(total / price)) : 1;

        if (userId && entries > 0) {
          const paymentId = session.id; // idempotency key

          // Upsert payment FIRST (idempotent)
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

          // Only on first time, increment tickets
          if (up.upsertedCount === 1) {
            await db.collection('tickets').updateOne(
              { userId },
              { $inc: { tickets: entries } },
              { upsert: true }
            );
          }

          // Audit trail (safe on replay)
          try {
            await db.collection('webhook_events').insertOne({
              eventId: event.id,
              type: event.type,
              sessionId: session.id,
              userId,
              amount: total,
              entries,
              via: 'webhook',
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

  // Helper for admin routes (token check)
  function requireAdmin(req, res) {
    const token = req.headers['x-admin-token'] || req.query.token;
    const expected = process.env.ADMIN_TOKEN || config.adminToken;
    if (!expected || token !== expected) {
      res.status(401).json({ error: 'unauthorized' });
      return false;
    }
    return true;
  }

  // --- Admin: manual ticket credit (ONE-OFF backfill) ---
  router.post('/admin/tickets/credit', express.json(), async (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;

      const { userId, entries } = req.body || {};
      const n = Number(entries);
      if (!userId || !Number.isFinite(n) || n < 1) {
        return res.status(400).json({ error: 'userId and positive entries required' });
      }

      const db = getDb();

      // Update tickets
      const existing = await db.collection('tickets').findOne({ userId });
      const newTotal = (existing?.tickets || 0) + n;
      await db.collection('tickets').updateOne(
        { userId },
        { $set: { tickets: newTotal } },
        { upsert: true }
      );

      // Add a "manual" payment record for audit
      const paymentId = `manual_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
      await db.collection('payments').insertOne({
        paymentId,
        userId,
        entries: n,
        amount: n * Number(config.pricePerEntry || 700),
        timestamp: new Date(),
        source: 'manual',
      });

      // Audit row (shows in /admin/webhooks/recent)
      try {
        await db.collection('webhook_events').insertOne({
          eventId: paymentId,
          type: 'manual.credit',
          sessionId: null,
          userId,
          amount: n * Number(config.pricePerEntry || 700),
          entries: n,
          via: 'admin',
          receivedAt: new Date(),
        });
      } catch (_) {}

      res.json({ ok: true, userId, added: n, totalTickets: newTotal, paymentId });
    } catch (err) {
      console.error('/api/admin/tickets/credit error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /* =========================
     Admin Stripe utilities
     ========================= */

  // Small local helper so we don't touch your webhook logic
  async function creditFromSession(session, eventId = null, via = 'admin-replay') {
    const db = getDb();

    // same fallback as webhook
    let userId = session?.metadata?.userId || '';
    if (!userId) {
      const email = (session?.customer_details?.email || '').trim().toLowerCase();
      if (email) userId = email;
    }

    const total = Number(session?.amount_total || 0);
    const price = Number(config.pricePerEntry || 700);
    let entries = Number(session?.metadata?.entriesPurchased || 0);
    if (!entries) entries = total ? Math.max(1, Math.round(total / price)) : 1;

    if (!userId || !entries) {
      return { ok: false, reason: 'missing userId or entries', userId, entries, sessionId: session?.id };
    }

    const paymentId = session.id;

    const up = await db.collection('payments').updateOne(
      { paymentId },
      {
        $setOnInsert: {
          paymentId,
          userId,
          entries,
          amount: total,
          timestamp: new Date(),
          source: 'admin-replay',
          eventId: eventId || null,
        }
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

    try {
      await db.collection('webhook_events').insertOne({
        eventId: eventId || `admin_${paymentId}`,
        type: 'checkout.session.completed',
        sessionId: session.id,
        userId,
        amount: total,
        entries,
        via,
        receivedAt: new Date(),
      });
    } catch (_) {}

    return { ok: true, userId, entries, amount: total, sessionId: session.id, firstTime: up.upsertedCount === 1, via };
  }

  // Admin: replay one known session by id (cs_live_...)
  router.post('/admin/stripe/replay-session', express.json(), async (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;
      if (!stripe) return res.status(501).json({ error: 'Stripe not configured' });

      const { sessionId } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const result = await creditFromSession(session, `admin_${sessionId}`, 'admin-replay');
      res.json(result);
    } catch (err) {
      console.error('/api/admin/stripe/replay-session error:', err);
      res.status(500).json({ error: 'Internal server error', message: err.message || String(err) });
    }
  });

  // Admin: reconcile recent events (pulls recent checkout.session.completed)
  router.post('/admin/stripe/reconcile-recent', express.json(), async (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;
      if (!stripe) return res.status(501).json({ error: 'Stripe not configured' });

      const hours = Math.max(1, Math.min(168, Number(req.query.hours) || 72));
      const since = Math.floor(Date.now() / 1000) - hours * 3600;

      const processed = [];
      let startingAfter;

      for (let page = 0; page < 5; page++) {
        const events = await stripe.events.list({
          types: ['checkout.session.completed'],
          created: { gte: since },
          limit: 50,
          starting_after: startingAfter
        });

        for (const ev of events.data) {
          const session = ev.data.object;
          const r = await creditFromSession(session, ev.id, 'admin-replay');
          processed.push(r);
        }

        if (!events.has_more) break;
        startingAfter = events.data[events.data.length - 1]?.id;
      }

      res.json({ ok: true, processedCount: processed.length, processed });
    } catch (err) {
      console.error('/api/admin/stripe/reconcile-recent error:', err);
      res.status(500).json({ error: 'Internal server error', message: err.message || String(err) });
    }
  });

  return router;
}

module.exports = { checkoutRouter, webhookRouter };
