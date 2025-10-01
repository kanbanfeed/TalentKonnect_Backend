const { MongoClient } = require('mongodb');
const { config } = require('./config.cjs');


let client;
let db;


async function connectDb() {
if (db) return db;
client = new MongoClient(config.mongoUri, { maxPoolSize: 20 });
await client.connect();
db = client.db('talentkonnect');
console.log('✅ Connected to MongoDB');


// Helpful indexes + idempotency
await db.collection('tickets').createIndex({ userId: 1 });
await db.collection('payments').createIndex({ paymentId: 1 }, { unique: true });
await db.collection('qualifications').createIndex({ token: 1 }, { unique: true });


return db;
}


function getDb() {
if (!db) throw new Error('DB not connected yet');
return db;
}


module.exports = { connectDb, getDb };