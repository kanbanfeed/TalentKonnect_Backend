const dotenv = require('dotenv');
dotenv.config();


function parseOrigins(list) {
if (!list) return [];
return list.split(',').map(s => s.trim()).filter(Boolean);
}


const config = {
env: process.env.NODE_ENV || 'development',
port: Number(process.env.PORT || 3000),
siteUrl: process.env.SITE_URL || 'http://localhost:5173',
corsOrigins: parseOrigins(process.env.CORS_ORIGINS) || ['http://localhost:5173'],
mongoUri: process.env.MONGO_URI,
stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
pricePerEntry: Number(process.env.PRICE_PER_ENTRY || 700),
};


if (!config.mongoUri) {
console.error('❌ MONGO_URI not set');
process.exit(1);
}


module.exports = { config };