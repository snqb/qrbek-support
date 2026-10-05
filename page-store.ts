import { DatabaseSync, type StatementSync } from "node:sqlite";
import { dirname } from "node:path";
import { migratePageStore } from "./page-store-schema.ts";

export const PAGE_DAY_MS = 86_400_000;
export const DEFAULT_PAGE_LIFETIME_DAYS = null;
export const MAX_PAGE_LIFETIME_DAYS = 1095;
export const isValidPageLifetime = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isInteger(value) &&
    value >= 1 && value <= MAX_PAGE_LIFETIME_DAYS);

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
  expiresAt: string | null;
  accessKey: string | null;
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
  PAGE_ID_PATTERN.test(value.startsWith("@") ? value.slice(1) : value);

export type PageStoreOptions = {
  path: string;
  maxRecords?: number;
  now?: () => number;
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
  private readonly reserveAddressStatement: StatementSync;
  private readonly getStatement: StatementSync;
  private readonly countStatement: StatementSync;
  private readonly deleteExpiredStatement: StatementSync;
  private readonly nextExpiryStatement: StatementSync;
  private readonly now: () => number;
  private cleanupTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(options: PageStoreOptions) {
    if (!options.path) throw new Error("QRBEK_DB_PATH is required");
    this.path = options.path;
    this.maxRecords = options.maxRecords ?? 10_000;
    this.now = options.now ?? Date.now;
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
      PRAGMA secure_delete = ON;
    `);
    try {
      migratePageStore(this.database);
    } catch (error) {
      this.database.close();
      throw error;
    }
    this.reserveAddressStatement = this.database.prepare(
      "INSERT INTO page_addresses (id) VALUES (?) ON CONFLICT(id) DO NOTHING",
    );
    this.insertStatement = this.database.prepare(
      "INSERT INTO pages (id, page_json, created_at, expires_at, access_key) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    );
    this.getStatement = this.database.prepare(
      "SELECT id, page_json, created_at, expires_at, access_key FROM pages WHERE id = ?",
    );
    this.countStatement = this.database.prepare(
      "SELECT COUNT(*) AS count FROM pages WHERE expires_at IS NULL OR expires_at > ?",
    );
    this.deleteExpiredStatement = this.database.prepare(
      "DELETE FROM pages WHERE expires_at <= ?",
    );
    this.nextExpiryStatement = this.database.prepare(
      "SELECT MIN(expires_at) AS next FROM pages",
    );
    this.purgeExpired();
  }

  count(): number {
    this.ensureOpen();
    const row = this.countStatement.get(new Date(this.now()).toISOString()) as {
      count?: number | bigint;
    };
    return Number(row.count ?? 0);
  }

  create(
    page: PageV1,
    requestedId?: string,
    expiresInDays: number | null = DEFAULT_PAGE_LIFETIME_DAYS,
  ): StoredPage {
    this.ensureOpen();
    if (requestedId !== undefined && !PAGE_ID_PATTERN.test(requestedId)) {
      throw new Error("invalid page id");
    }
    if (!isValidPageLifetime(expiresInDays)) {
      throw new RangeError("page lifetime must be null or 1–1095 whole days");
    }
    this.purgeExpired();
    const serialized = JSON.stringify(page);
    const created = this.now();
    const createdAt = new Date(created).toISOString();
    const expiresAt = expiresInDays === null
      ? null
      : new Date(created + expiresInDays * PAGE_DAY_MS).toISOString();
    // Old finite custom links keep generation keys. Permanent addresses are
    // never reassigned, so new ones need no key in their public URL.
    const accessKey = requestedId !== undefined && expiresInDays !== null ? randomId() : null;
    const attempts = requestedId === undefined ? 8 : 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const id = requestedId === undefined
        ? randomId()
        : expiresInDays === null ? `@${requestedId}` : requestedId;
      let transactionOpen = false;
      try {
        // BEGIN IMMEDIATE makes the cap check and insert one atomic operation,
        // including when more than one process points at this database.
        this.database.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        if (this.count() >= this.maxRecords) {
          throw new PageStoreError("capacity");
        }
        if (this.reserveAddressStatement.run(id).changes === 0) {
          throw new PageStoreError("slug_taken");
        }
        if (this.insertStatement.run(id, serialized, createdAt, expiresAt, accessKey).changes === 0) {
          throw new PageStoreError("slug_taken");
        }
        this.database.exec("COMMIT");
        transactionOpen = false;
        this.scheduleCleanup();
        return { id, page, createdAt, expiresAt, accessKey };
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
      expires_at?: string | null;
      access_key?: string | null;
    } | undefined;
    if (!row) return null;
    if (
      typeof row.id !== "string" || typeof row.page_json !== "string" ||
      typeof row.created_at !== "string" ||
      (row.expires_at !== null && (typeof row.expires_at !== "string" ||
        !Number.isFinite(Date.parse(row.expires_at))))
    ) {
      throw new Error("stored page row is corrupt");
    }
    if (row.expires_at !== null && Date.parse(row.expires_at) <= this.now()) {
      this.purgeExpired();
      return null;
    }
    const page = JSON.parse(row.page_json) as PageV1;
    return {
      id: row.id, page, createdAt: row.created_at, expiresAt: row.expires_at,
      accessKey: row.access_key ?? null,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.cleanupTimer);
    this.database.close();
  }

  /** Remove payloads, including SQLite free-page and WAL copies. */
  purgeExpired(): number {
    this.ensureOpen();
    const result = this.deleteExpiredStatement.run(new Date(this.now()).toISOString());
    const removed = Number(result.changes);
    if (removed > 0) this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.scheduleCleanup();
    return removed;
  }

  private scheduleCleanup(): void {
    clearTimeout(this.cleanupTimer);
    const row = this.nextExpiryStatement.get() as { next: string | null };
    // The hourly bound also discovers inserts by another process. An expired
    // page is denied on every read, even if the event loop delayed this timer.
    const delay = row.next === null
      ? 3_600_000
      : Math.max(1, Math.min(Date.parse(row.next) - this.now(), 3_600_000));
    this.cleanupTimer = setTimeout(() => {
      try {
        this.purgeExpired();
      } catch {
        console.error("Payment page expiration cleanup failed");
        this.cleanupTimer = setTimeout(() => this.scheduleCleanup(), 60_000);
        Deno.unrefTimer(this.cleanupTimer);
      }
    }, delay);
    Deno.unrefTimer(this.cleanupTimer);
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("page store is closed");
  }
}
