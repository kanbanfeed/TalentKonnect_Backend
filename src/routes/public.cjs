const express = require('express');
const { getDb } = require('../db.cjs');
const { config } = require('../config.cjs');

const router = express.Router();

// Health
router.get('/health', (_req, res) => {
  res.json({ ok: true, env: config.env });
});

// Qualification
router.post('/qualify', async (req, res) => {
  try {
    const db = getDb();
    const { path: userPath, skill, fun, feedback } = req.body || {};

    if (!userPath) return res.status(400).json({ error: 'Path is required' });
    if (userPath === 'paid' && (!skill || !fun || !feedback)) {
      return res.status(400).json({ error: 'All quiz fields required' });
    }

    const token = `ticket_${Math.random().toString(36).slice(2, 10)}`;

    await db.collection('qualifications').insertOne({
      token,
      tier: userPath === 'paid' ? 'paid' : 'free',
      createdAt: new Date()
    });

    res.json({ message: 'Qualification submitted', token, tier: userPath === 'paid' ? 'paid' : 'free' });
  } catch (err) {
    console.error('/api/qualify error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Raffle tickets - read
router.get('/raffle/tickets/:userId', async (req, res) => {
  try {
    const db = getDb();
    const uid = String(req.params.userId || '').trim();
    if (!uid) return res.status(400).json({ error: 'userId required' });

    const ticketDoc = await db.collection('tickets').findOne({ userId: uid }) || { userId: uid, tickets: 0 };
    res.json({ userId: uid, tickets: ticketDoc.tickets });
  } catch (err) {
    console.error('/api/raffle/tickets error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Raffle tickets - credit (manual)
router.post('/raffle/credit', async (req, res) => {
  try {
    const db = getDb();
    const { userId, entries } = req.body || {};
    const n = Number(entries || 0);
    if (!userId || n < 1) return res.status(400).json({ error: 'userId and entries required' });

    const ticketDoc = await db.collection('tickets').findOne({ userId }) || { userId, tickets: 0 };
    const newTickets = (ticketDoc.tickets || 0) + n;

    await db.collection('tickets').updateOne({ userId }, { $set: { tickets: newTickets } }, { upsert: true });
    await db.collection('payments').insertOne({
      paymentId: `pay_${Math.random().toString(36).slice(2, 10)}`,
      userId,
      entries: n,
      amount: n * config.pricePerEntry,
      timestamp: new Date(),
      source: 'manual'
    });

    res.json({ ok: true, userId, entries: n, totalTickets: newTickets });
  } catch (err) {
    console.error('/api/raffle/credit error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = { publicRouter: router };
