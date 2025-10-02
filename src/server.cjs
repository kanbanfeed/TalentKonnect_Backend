const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { connectDb } = require('./db.cjs');
const { config } = require('./config.cjs');
const { publicRouter } = require('./routes/public.cjs');
const { checkoutRouter, webhookRouter } = require('./routes/stripe.cjs');

const app = express();

/* >>> trust proxy first (fixes X-Forwarded-For warning on Render) */
app.set('trust proxy', 1);

/* Security & logging */
app.use(helmet());
app.use(morgan('combined'));
app.use(rateLimit({ windowMs: 60 * 1000, max: 120 }));

/* CORS */
const allowed = new Set(config.corsOrigins);
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // curl/mobile/postman
    if (allowed.has(origin)) return cb(null, true);
    return cb(new Error('CORS blocked'), false);
  },
  credentials: true,
};
/* handle preflight cleanly to avoid 500s */
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

/* Stripe webhook FIRST (raw body) */
app.use('/api', webhookRouter());

/* Body parser for normal routes */
app.use(express.json());

/* Routes */
app.use('/api', publicRouter);
app.use('/api', checkoutRouter);

/* 404 fallback */
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));

/* Start */
connectDb()
  .then(() => {
    app.listen(config.port, () => {
      console.log(`✅ API running on port ${config.port}`);
      console.log(`Allowed CORS origins: ${config.corsOrigins.join(', ')}`);
      console.log(`Stripe enabled: ${Boolean(process.env.STRIPE_SECRET_KEY)}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
