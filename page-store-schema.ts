import { type DatabaseSync } from "node:sqlite";

const createPages = (name: string) => `CREATE TABLE ${name} (
  id TEXT PRIMARY KEY NOT NULL,
  page_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  access_key TEXT
) STRICT`;

/** Preserve promised legacy deadlines while allowing explicit permanent pages. */
export function migratePageStore(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
    if (version > 1) throw new Error("unsupported page store schema");
    const columns = database.prepare("PRAGMA table_info(pages)").all();
    if (!columns.length) {
      database.exec(createPages("pages"));
    } else if (version === 0) {
      const names = new Set(columns.map((column) => column.name));
      const legacyDeadline = "strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+1095 days')";
      const expiry = names.has("expires_at")
        ? `COALESCE(expires_at, ${legacyDeadline})`
        : legacyDeadline;
      const accessKey = names.has("access_key") ? "access_key" : "NULL";
      database.exec(createPages("pages_with_permanence"));
      database.exec(`INSERT INTO pages_with_permanence
        SELECT id, page_json, created_at, ${expiry}, ${accessKey} FROM pages`);
      const corrupt = database.prepare(`SELECT 1 FROM pages_with_permanence
        WHERE expires_at IS NULL OR julianday(expires_at) IS NULL LIMIT 1`).get();
      if (corrupt) throw new Error("stored page deadline is corrupt");
      database.exec("DROP TABLE pages; ALTER TABLE pages_with_permanence RENAME TO pages");
    }
    database.exec(`
      CREATE INDEX IF NOT EXISTS pages_expiry ON pages(expires_at);
      CREATE TABLE IF NOT EXISTS page_addresses (id TEXT PRIMARY KEY NOT NULL) STRICT;
      INSERT OR IGNORE INTO page_addresses (id) SELECT id FROM pages;
      PRAGMA user_version = 1;
    `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
