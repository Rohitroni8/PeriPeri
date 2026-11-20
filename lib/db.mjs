import { MongoClient } from 'mongodb';

export const COLLECTIONS = ['phone_numbers', 'contacts', 'conversations', 'messages', 'sessions', 'counters'];

export function requireDbSettings() {
  if (!process.env.MONGODB_URI) throw new Error('Missing required setting: MONGODB_URI (your MongoDB Atlas connection string).');
}

// Returns { client, db }. The database name comes from MONGODB_DB, otherwise
// from the connection string, otherwise "relaydesk".
export async function connect({ maxPoolSize = 10 } = {}) {
  requireDbSettings();
  const client = new MongoClient(process.env.MONGODB_URI, {
    maxPoolSize,
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    appName: 'relaydesk'
  });
  await client.connect();
  const fromUri = new URL(process.env.MONGODB_URI.replace(/^mongodb(\+srv)?:/, 'http:')).pathname.slice(1);
  const db = client.db(process.env.MONGODB_DB || decodeURIComponent(fromUri) || 'relaydesk');
  return { client, db };
}

export const INDEXES = {
  contacts: [{ key: { wa_id: 1 }, unique: true, name: 'contacts_wa_id' }],
  conversations: [
    { key: { phone_number_id: 1, contact_id: 1 }, unique: true, name: 'conversation_phone_contact' },
    { key: { state: 1, last_message_at: -1 }, name: 'conversations_recent' },
    { key: { last_message_at: -1 }, name: 'conversations_last_message' }
  ],
  messages: [
    // Outbound messages have no WhatsApp ID until Meta accepts them.
    { key: { wa_message_id: 1 }, unique: true, partialFilterExpression: { wa_message_id: { $type: 'string' } }, name: 'messages_wa_id' },
    { key: { conversation_id: 1, sent_at: -1, _id: -1 }, name: 'messages_conversation' },
    { key: { sent_at: 1 }, name: 'messages_sent_at' }
  ],
  // MongoDB removes expired sign-in sessions on its own.
  sessions: [{ key: { expire_at: 1 }, expireAfterSeconds: 0, name: 'sessions_ttl' }]
};

export async function createIndexes(db, name, target = name) {
  if (INDEXES[name]) await db.collection(target).createIndexes(INDEXES[name]);
}

// Idempotent: safe to run on every start.
export async function initializeDatabase(db) {
  for (const name of Object.keys(INDEXES)) await createIndexes(db, name);
  await db.command({ ping: 1 });
}

// Numeric IDs keep URLs short and the API unchanged (/api/conversations/12).
export async function nextId(db, name) {
  const doc = await db.collection('counters').findOneAndUpdate(
    { _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' }
  );
  return doc.seq;
}

export const isDuplicateKey = error => error?.code === 11000;
