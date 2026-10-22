import { constants } from 'node:sqlite';
import { ConfigError } from '../gcp/errors.js';

// Read-only SQL for query_history_sql. SQLite's authorizer is the real guard: it refuses every operation
// that isn't reading (writes, PRAGMA, ATTACH, DDL), wherever it hides in the statement. The text checks
// only give a clearer message for the common mistakes.

export const MAX_SQL_ROWS = 500;
const MAX_CELL_CHARS = 4000;
const MAX_RESULT_CHARS = 1_000_000;

const READ_OPS = new Set([constants.SQLITE_SELECT, constants.SQLITE_READ, constants.SQLITE_FUNCTION, constants.SQLITE_RECURSIVE]);

export function checkStatement(sql) {
  const text = String(sql).trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(text)) throw new ConfigError('Only a single SELECT (or WITH ... SELECT) statement is allowed.');
  if (text.includes(';')) throw new ConfigError('Only one statement is allowed (no ";").');
  return text;
}

// Runs `text` on `db` with only read operations allowed; returns at most `limit` rows. The authorizer is
// removed afterwards, so the same connection can be used normally again (tests share one).
export function runReadOnly(db, text, limit) {
  if (typeof db.setAuthorizer !== 'function') {
    throw new ConfigError('query_history_sql needs Node.js 24.9 or newer (SQLite authorizer support).');
  }
  db.setAuthorizer((op) => (READ_OPS.has(op) ? constants.SQLITE_OK : constants.SQLITE_DENY));
  try {
    let stmt;
    try {
      stmt = db.prepare(text);
    } catch (err) {
      if (/not authorized/i.test(err.message)) {
        throw new ConfigError('The query may only read: writes, PRAGMA, ATTACH and schema changes are refused.');
      }
      throw new ConfigError(`SQL error: ${err.message}`);
    }
    const rows = [];
    let size = 0;
    for (const row of stmt.iterate()) {
      if (rows.length === limit) return { rows, returned: rows.length, truncated: true };
      const out = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, clip(v)]));
      size += JSON.stringify(out).length;
      if (size > MAX_RESULT_CHARS) return { rows, returned: rows.length, truncated: true, note: 'Result too large; select fewer columns or rows.' };
      rows.push(out);
    }
    return { rows, returned: rows.length, truncated: false };
  } finally {
    db.setAuthorizer(null);
  }
}

function clip(v) {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v.length > MAX_CELL_CHARS) return `${v.slice(0, MAX_CELL_CHARS)}… (${v.length} chars)`;
  if (v instanceof Uint8Array) return `(blob, ${v.length} bytes)`;
  return v;
}
