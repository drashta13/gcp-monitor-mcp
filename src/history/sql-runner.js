// Child process for query_history_sql: runs one read-only query and sends the rows back. It lives in its
// own process because a SQLite query can't be interrupted from JavaScript; the server kills this process
// when the query runs too long, instead of freezing every other tool.
import { DatabaseSync } from 'node:sqlite';
import { runReadOnly } from './sqlsafe.js';
import { ConfigError } from '../gcp/errors.js';

process.once('message', ({ path, text, limit }) => {
  let reply;
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    reply = { ok: true, result: runReadOnly(db, text, limit) };
    db.close();
  } catch (err) {
    reply = { ok: false, error: err.message, config: err instanceof ConfigError };
  }
  process.send(reply, () => process.exit(0));
});
