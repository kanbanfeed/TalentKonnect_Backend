# TalentKonnect Backend (Express + MongoDB + Stripe)

## Quick Start
```bash
npm i
cp .env.example .env  # fill MONGO_URI, Stripe keys, CORS_ORIGINS
npm run dev
# API -> http://localhost:3001
```

### Endpoints
- `GET  /api/health`
- `POST /api/qualify`                      -> { path: 'free' | 'paid', skill?, fun?, feedback? }
- `GET  /api/raffle/tickets/:userId`
- `POST /api/raffle/credit`                -> { userId, entries }
- `POST /api/payment/create-checkout`      -> { userId, entries }
- `POST /api/stripe/webhook`               -> (Stripe calls this; do not call from browser)

### Local Stripe Webhook
```bash
stripe listen --forward-to http://localhost:3001/api/stripe/webhook
```

### Frontend Config (Vite)
Set `.env` in your Vite app:
```
VITE_API_BASE=http://localhost:3001
```

Then call:
```ts
const API_BASE = import.meta.env.VITE_API_BASE;
await fetch(`${API_BASE}/api/raffle/tickets/demo-user-1`);
```

### Deploy
- Deploy on Render/Railway/Fly/EC2.
- Point DNS to `https://api.talentkonnect.com` (optional).
- Set env vars in your host dashboard.
- Stripe Dashboard → Webhooks: `https://<your-api-host>/api/stripe/webhook`
