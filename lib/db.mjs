import mysql from 'mysql2/promise';

export const TABLES = ['phone_numbers', 'contacts', 'conversations', 'messages', 'sessions'];

export function requireDbSettings() {
  const missing = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].filter(key => !process.env[key]);
  if (missing.length) throw new Error(`Missing required MySQL settings: ${missing.join(', ')}`);
}

export function createPool({ connectionLimit = 10, queueLimit = 50 } = {}) {
  requireDbSettings();
  return mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit,
    queueLimit,
    charset: 'utf8mb4',
    enableKeepAlive: true,
    connectTimeout: 10000,
    supportBigNumbers: true,
    dateStrings: true
  });
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS phone_numbers (
    phone_number_id VARCHAR(64) NOT NULL PRIMARY KEY,
    display_phone_number VARCHAR(32) NULL,
    verified_name VARCHAR(255) NULL,
    quality_rating VARCHAR(32) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'connected',
    updated_at VARCHAR(32) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS contacts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    wa_id VARCHAR(64) NOT NULL UNIQUE,
    profile_name VARCHAR(255) NULL,
    updated_at VARCHAR(32) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    phone_number_id VARCHAR(64) NOT NULL,
    contact_id BIGINT UNSIGNED NOT NULL,
    last_message_at VARCHAR(32) NULL,
    last_inbound_at VARCHAR(32) NULL,
    last_message_preview VARCHAR(500) NOT NULL DEFAULT '',
    unread_count INT UNSIGNED NOT NULL DEFAULT 0,
    state VARCHAR(10) NOT NULL DEFAULT 'open',
    created_at VARCHAR(32) NOT NULL,
    updated_at VARCHAR(32) NOT NULL,
    UNIQUE KEY conversation_phone_contact (phone_number_id, contact_id),
    KEY conversations_recent (state, last_message_at),
    CONSTRAINT conversations_phone_fk FOREIGN KEY (phone_number_id) REFERENCES phone_numbers(phone_number_id),
    CONSTRAINT conversations_contact_fk FOREIGN KEY (contact_id) REFERENCES contacts(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS messages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    conversation_id BIGINT UNSIGNED NOT NULL,
    wa_message_id VARCHAR(255) NULL UNIQUE,
    direction ENUM('inbound','outbound') NOT NULL,
    message_type VARCHAR(32) NOT NULL,
    body TEXT NOT NULL,
    media_id VARCHAR(128) NULL,
    media_mime VARCHAR(128) NULL,
    media_filename VARCHAR(255) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'received',
    error_code VARCHAR(64) NULL,
    error_title VARCHAR(255) NULL,
    sent_at VARCHAR(32) NOT NULL,
    created_at VARCHAR(32) NOT NULL,
    KEY messages_conversation (conversation_id, sent_at),
    KEY messages_sent_at (sent_at),
    CONSTRAINT messages_conversation_fk FOREIGN KEY (conversation_id) REFERENCES conversations(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) NOT NULL PRIMARY KEY,
    expires_at BIGINT UNSIGNED NOT NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    KEY sessions_expiration (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];

// Columns added after the first MVP schema. CREATE TABLE IF NOT EXISTS does not
// add columns to a table that already exists, so add any that are missing.
const ADDED_COLUMNS = [
  ['conversations', 'last_inbound_at', 'VARCHAR(32) NULL AFTER last_message_at'],
  ['messages', 'media_id', 'VARCHAR(128) NULL AFTER body'],
  ['messages', 'media_mime', 'VARCHAR(128) NULL AFTER media_id'],
  ['messages', 'media_filename', 'VARCHAR(255) NULL AFTER media_mime'],
  ['messages', 'error_title', 'VARCHAR(255) NULL AFTER error_code']
];

export async function initializeDatabase(db) {
  for (const statement of SCHEMA) await db.query(statement);
  const [columns] = await db.query(
    'SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()'
  );
  const present = new Set(columns.map(row => `${row.t}.${row.c}`));
  for (const [table, column, definition] of ADDED_COLUMNS) {
    if (!present.has(`${table}.${column}`)) await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
  const [indexes] = await db.query(
    "SELECT INDEX_NAME AS i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages'"
  );
  if (!indexes.some(row => row.i === 'messages_sent_at')) await db.query('ALTER TABLE messages ADD KEY messages_sent_at (sent_at)');
  await db.query('SELECT 1');
}

export async function withTransaction(db, work) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
