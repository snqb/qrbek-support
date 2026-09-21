import { DatabaseSync, type StatementSync } from "node:sqlite";
import { dirname } from "node:path";

export type PageV1 = {
  v: 1;
  title: string;
  note: string;
  amount: string;
  currency: "KGS";
  methods: Array<{
    kind: "qr";
    label: string;
    value: string;
    bankId: string;
  }>;
};

export type StoredPage = {
  id: string;
  page: PageV1;
  createdAt: string;
};

export type PageStoreErrorCode = "slug_taken" | "capacity";

export class PageStoreError extends Error {
  readonly code: PageStoreErrorCode;

  constructor(code: PageStoreErrorCode) {
    super(
      code === "slug_taken"
        ? "Такой адрес уже занят."
        : "Лимит страниц исчерпан.",
    );
    this.name = "PageStoreError";
    this.code = code;
  }
}

// Both random IDs and user aliases use this conservative path-safe alphabet.
export const PAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
export const isValidPageId = (value: string): boolean =>
  PAGE_ID_PATTERN.test(value);

export type PageStoreOptions = {
  path: string;
  maxRecords?: number;
};

const randomId = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
};

export class PageStore {
  readonly path: string;
  readonly maxRecords: number;
  private readonly database: DatabaseSync;
  private readonly insertStatement: StatementSync;
  private readonly getStatement: StatementSync;
  private readonly countStatement: StatementSync;
  private closed = false;

  constructor(options: PageStoreOptions) {
    if (!options.path) throw new Error("QRBEK_DB_PATH is required");
    this.path = options.path;
    this.maxRecords = options.maxRecords ?? 10_000;
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1) {
      throw new Error("maxRecords must be a positive safe integer");
    }
    if (this.path !== ":memory:") {
      Deno.mkdirSync(dirname(this.path), { recursive: true });
    }
    // A busy timeout lets independent server processes serialize their short
    // insert transactions instead of treating a transient writer lock as data loss.
    this.database = new DatabaseSync(this.path, { timeout: 5_000 });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY NOT NULL,
        page_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `);
    this.insertStatement = this.database.prepare(
      "INSERT INTO pages (id, page_json, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
    );
    this.getStatement = this.database.prepare(
      "SELECT id, page_json, created_at FROM pages WHERE id = ?",
    );
    this.countStatement = this.database.prepare(
      "SELECT COUNT(*) AS count FROM pages",
    );
  }

  count(): number {
    this.ensureOpen();
    const row = this.countStatement.get() as { count?: number | bigint };
    return Number(row.count ?? 0);
  }

  create(page: PageV1, requestedId?: string): StoredPage {
    this.ensureOpen();
    if (requestedId !== undefined && !isValidPageId(requestedId)) {
      throw new Error("invalid page id");
    }
    const serialized = JSON.stringify(page);
    const createdAt = new Date().toISOString();
    const attempts = requestedId === undefined ? 8 : 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const id = requestedId ?? randomId();
      let transactionOpen = false;
      try {
        // BEGIN IMMEDIATE makes the cap check and insert one atomic operation,
        // including when more than one process points at this database.
        this.database.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        if (this.count() >= this.maxRecords) {
          throw new PageStoreError("capacity");
        }
        if (this.insertStatement.run(id, serialized, createdAt).changes === 0) {
          throw new PageStoreError("slug_taken");
        }
        this.database.exec("COMMIT");
        transactionOpen = false;
        return { id, page, createdAt };
      } catch (error) {
        if (transactionOpen) {
          try {
            this.database.exec("ROLLBACK");
          } catch {
            // Preserve the original database error; never replace a damaged
            // transaction with a silent overwrite or reset.
          }
        }
        if (
          requestedId === undefined && error instanceof PageStoreError &&
          error.code === "slug_taken"
        ) continue;
        throw error;
      }
    }
    throw new Error("could not allocate page id");
  }

  get(id: string): StoredPage | null {
    this.ensureOpen();
    if (!isValidPageId(id)) return null;
    const row = this.getStatement.get(id) as {
      id?: string;
      page_json?: string;
      created_at?: string;
    } | undefined;
    if (!row) return null;
    if (
      typeof row.id !== "string" || typeof row.page_json !== "string" ||
      typeof row.created_at !== "string"
    ) {
      throw new Error("stored page row is corrupt");
    }
    const page = JSON.parse(row.page_json) as PageV1;
    return { id: row.id, page, createdAt: row.created_at };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("page store is closed");
  }
}
