import { fileURLToPath } from "node:url";
import { BANKS, inspectQr, normalizePage, paymentTarget } from "./payment.js";
import {
  isValidPageId,
  PageStore,
  PageStoreError,
  type PageV1,
} from "./page-store.ts";

const textEncoder = new TextEncoder();
const DEFAULT_BODY_LIMIT = 24_000;
const NORMALIZED_PAGE_LIMIT = 20_000;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT = 30;
const DEFAULT_MAX_RECORDS = 10_000;
const LEGACY_ORIGIN = new URL("https://qrbek.esen.works");
const DEFAULT_DB_PATH = fileURLToPath(
  new URL("../qrbek-pages.sqlite3", import.meta.url),
);
const bankIds = new Set(BANKS.map((bank) => bank.id));

const MIME_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  png: "image/png",
};

// Explicitly list shipping files. In particular, do not turn URL paths into
// filesystem paths: this keeps server, store, tests, and database files private.
const ASSETS: Record<string, true> = {
  "index.html": true,
  "pay.html": true,
  "app.js": true,
  "payment.js": true,
  "styles.css": true,
  "redirect.js": true,
  "create.html": true,
  "compare.html": true,
  "support.html": true,
  "privacy.html": true,
  "interface-design/index.html": true,
  "interface-design/pay.html": true,
  "opendesign/index.html": true,
  "opendesign/pay.html": true,
  "assets/create-qr.png": true,
  "assets/mark.png": true,
  "assets/banks/bakai.png": true,
  "assets/banks/dantepay.png": true,
  "assets/banks/demir.png": true,
  "assets/banks/megapay.png": true,
  "assets/banks/optima.png": true,
  "assets/banks/ab24.png": true,
  "assets/banks/balance.png": true,
  "assets/banks/eldik.png": true,
  "assets/banks/finik.png": true,
  "assets/banks/kicb.png": true,
  "assets/banks/nambaone.png": true,
  "assets/banks/odengi.png": true,
  "assets/banks/simbank.png": true,
  "assets/banks/bankasia.png": true,
  "assets/banks/kompanion.png": true,
  "assets/banks/mbank.png": true,
  "vendor/qrcode.js": true,
  "vendor/jsqr.js": true,
};

export type ServerOptions = {
  root?: URL;
  store: PageStore;
  publicOrigin?: string;
  maxBodyBytes?: number;
  rateLimit?: number;
  rateWindowMs?: number;
  now?: () => number;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

class RateWindow {
  private readonly events: number[] = [];
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  allow(): boolean {
    const cutoff = this.now() - this.windowMs;
    while (this.events.length && this.events[0] <= cutoff) this.events.shift();
    if (this.events.length >= this.limit) return false;
    this.events.push(this.now());
    return true;
  }
}

const securityHeaders = (contentType?: string): Record<string, string> => ({
  ...(contentType ? { "Content-Type": contentType } : {}),
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cache-Control": "no-store",
});

const jsonResponse = (
  value: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      ...securityHeaders("application/json; charset=utf-8"),
      ...extraHeaders,
    },
  });

const notFound = (): Response =>
  new Response("Not found", { status: 404, headers: securityHeaders() });

const methodNotAllowed = (allow: string): Response =>
  new Response("Method not allowed", {
    status: 405,
    headers: { ...securityHeaders(), Allow: allow },
  });

const errorResponse = (error: HttpError): Response =>
  jsonResponse(
    { error: error.code, message: error.message },
    error.status,
    error.headers,
  );

const configuredInteger = (
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const value = Deno.env.get(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
};

const normalizeOrigin = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_ORIGIN must be an absolute URL");
  }
  if (
    !/^https?:$/.test(url.protocol) || url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash
  ) {
    throw new Error("PUBLIC_ORIGIN must be an HTTP(S) origin");
  }
  return url.origin;
};

const readBoundedBody = async (
  request: Request,
  maxBytes: number,
): Promise<string> => {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new HttpError(
        400,
        "invalid_request",
        "Некорректная длина запроса.",
      );
    }
    if (length > maxBytes) {
      throw new HttpError(413, "request_too_large", "Запрос слишком большой.");
    }
  }
  if (!request.body) {
    throw new HttpError(400, "invalid_json", "Некорректный JSON.");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HttpError(
          413,
          "request_too_large",
          "Запрос слишком большой.",
        );
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new HttpError(400, "invalid_json", "Некорректный JSON.");
  }
};

const assertEnvelope = (value: unknown): { page: unknown; slug?: string } => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "Некорректный запрос.");
  }
  const envelope = value as Record<string, unknown>;
  const unknown = Object.keys(envelope).filter((key) =>
    key !== "page" && key !== "slug"
  );
  if (unknown.length || !("page" in envelope)) {
    throw new HttpError(400, "invalid_request", "Некорректный запрос.");
  }
  if ("slug" in envelope && typeof envelope.slug !== "string") {
    throw new HttpError(400, "invalid_slug", "Адрес должен быть строкой.");
  }
  return { page: envelope.page, slug: envelope.slug as string | undefined };
};

const validateSlug = (slug: string | undefined): string | undefined => {
  if (slug === undefined || slug === "") return undefined;
  if (!isValidPageId(slug)) {
    throw new HttpError(
      400,
      "invalid_slug",
      "Адрес: 3–32 строчных латинских букв, цифр и дефисов; без дефиса в начале и конце.",
    );
  }
  return slug;
};

const validatePage = async (input: unknown): Promise<PageV1> => {
  try {
    const page = normalizePage(input) as PageV1;
    for (const method of page.methods) {
      const inspected = await inspectQr(method.value);
      if (inspected.kind === "sbp" && page.amount) {
        throw new Error("SBP amount");
      }
      // The browser derives bankId from the validated QR. Canonicalizing it here
      // prevents a caller from persisting a bank label unrelated to its payload.
      method.bankId = inspected.bankId && bankIds.has(inspected.bankId)
        ? inspected.bankId
        : "";
      await paymentTarget(method.value, page.amount, "");
    }
    if (
      textEncoder.encode(JSON.stringify(page)).byteLength >
        NORMALIZED_PAGE_LIMIT
    ) {
      throw new Error("page too large");
    }
    return page;
  } catch {
    throw new HttpError(
      400,
      "invalid_page",
      "Страница оплаты не прошла проверку.",
    );
  }
};

const readPageId = (pathname: string, prefix: string): string | null => {
  if (!pathname.startsWith(prefix)) return null;
  const id = pathname.slice(prefix.length);
  return id && isValidPageId(id) ? id : null;
};

const serveAsset = async (
  request: Request,
  pathname: string,
  root: URL,
): Promise<Response> => {
  const name = pathname === "/"
    ? "index.html"
    : pathname.endsWith("/")
    ? `${pathname.slice(1)}index.html`
    : pathname.slice(1);
  if (!Object.hasOwn(ASSETS, name)) return notFound();
  try {
    const body = await Deno.readFile(new URL(name, root));
    const extension = name.split(".").pop() || "";
    const headers = securityHeaders(
      MIME_TYPES[extension] || "application/octet-stream",
    );
    return new Response(request.method === "HEAD" ? null : body, { headers });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return notFound();
    throw error;
  }
};

export const createHandler = (
  options: ServerOptions,
): (request: Request) => Promise<Response> => {
  const root = options.root ?? new URL("./", import.meta.url);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_BODY_LIMIT;
  const rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  const rateWindowMs = options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error("maxBodyBytes must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(rateLimit) || rateLimit < 1 ||
    !Number.isSafeInteger(rateWindowMs) || rateWindowMs < 1
  ) {
    throw new Error("rate settings must be positive safe integers");
  }
  const publicOrigin = options.publicOrigin === undefined
    ? undefined
    : normalizeOrigin(options.publicOrigin);
  const limiter = new RateWindow(rateLimit, rateWindowMs, now);

  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const isLegacyHost = url.host === LEGACY_ORIGIN.host;
      if (pathname === "/health") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return methodNotAllowed("GET, HEAD");
        }
        return jsonResponse({ ok: true });
      }
      if (pathname === "/api/pages") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const origin = request.headers.get("origin");
        const expectedOrigin = publicOrigin ?? url.origin;
        if (
          origin !== null && origin !== expectedOrigin &&
          !(isLegacyHost && origin === LEGACY_ORIGIN.origin)
        ) {
          throw new HttpError(
            403,
            "origin_forbidden",
            "Источник запроса не разрешён.",
          );
        }
        if (!limiter.allow()) {
          throw new HttpError(
            429,
            "rate_limited",
            "Слишком много запросов. Попробуйте позже.",
            { "Retry-After": String(Math.ceil(rateWindowMs / 1000)) },
          );
        }
        const contentType = request.headers.get("content-type")?.split(
          ";",
          1,
        )[0].trim().toLowerCase();
        if (contentType !== "application/json") {
          throw new HttpError(
            415,
            "invalid_content_type",
            "Ожидается Content-Type application/json.",
          );
        }
        const body = await readBoundedBody(request, maxBodyBytes);
        let envelope: unknown;
        try {
          envelope = JSON.parse(body);
        } catch {
          throw new HttpError(400, "invalid_json", "Некорректный JSON.");
        }
        const parsed = assertEnvelope(envelope);
        const slug = validateSlug(parsed.slug);
        const page = await validatePage(parsed.page);
        let record;
        try {
          record = options.store.create(page, slug);
        } catch (error) {
          if (error instanceof PageStoreError && error.code === "slug_taken") {
            throw new HttpError(409, "slug_taken", "Такой адрес уже занят.");
          }
          if (error instanceof PageStoreError && error.code === "capacity") {
            throw new HttpError(
              503,
              "capacity_reached",
              "Создание ссылок временно недоступно.",
            );
          }
          throw error;
        }
        return jsonResponse({ id: record.id, path: `/p/${record.id}` }, 201);
      }
      if (pathname.startsWith("/api/pages/") && pathname !== "/api/pages/") {
        const rawId = pathname.slice("/api/pages/".length);
        if (!isValidPageId(rawId)) {
          throw new HttpError(
            400,
            "invalid_id",
            "Некорректный идентификатор страницы.",
          );
        }
      }
      if (pathname.startsWith("/p/") && pathname !== "/p/") {
        const rawId = pathname.slice("/p/".length);
        if (!isValidPageId(rawId)) {
          throw new HttpError(
            400,
            "invalid_id",
            "Некорректный идентификатор страницы.",
          );
        }
      }
      const apiId = readPageId(pathname, "/api/pages/");
      if (apiId !== null) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return methodNotAllowed("GET, HEAD");
        }
        const record = options.store.get(apiId);
        if (!record) {
          throw new HttpError(
            404,
            "not_found",
            "Ссылка не найдена. Проверьте адрес.",
          );
        }
        return jsonResponse(record.page);
      }
      // Redirect documents only: already-open legacy tabs still need their
      // same-origin API and assets. Omitting a fragment preserves #p and #draft.
      if (
        publicOrigin && publicOrigin !== LEGACY_ORIGIN.origin && isLegacyHost &&
        (request.method === "GET" || request.method === "HEAD") &&
        (pathname.endsWith("/") || pathname.endsWith(".html") ||
          pathname.startsWith("/p/"))
      ) {
        return new Response(null, {
          status: 308,
          headers: {
            ...securityHeaders(),
            Location: `${publicOrigin}${pathname}${url.search}`,
          },
        });
      }
      const pageId = readPageId(pathname, "/p/");
      if (pageId !== null) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return methodNotAllowed("GET, HEAD");
        }
        return serveAsset(request, "/pay.html", root);
      }
      if (pathname === "/api/pages/" || pathname === "/p/") return notFound();
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed("GET, HEAD");
      }
      return serveAsset(request, pathname, root);
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error);
      // Never put SQLite paths, SQL, stack traces, or submitted page data in a
      // response. The process can still surface the error through its supervisor.
      return jsonResponse({
        error: "internal_error",
        message: "Внутренняя ошибка сервера.",
      }, 500);
    }
  };
};

const start = (): void => {
  // Configuration: PORT, PUBLIC_ORIGIN, QRBEK_DB_PATH, QRBEK_MAX_RECORDS,
  // QRBEK_CREATE_RATE_LIMIT, and QRBEK_CREATE_RATE_WINDOW_MS. The database
  // default is next to (not inside) web/, and rate limiting is process-local.
  const port = configuredInteger("PORT", 4317, 1, 65_535);
  const publicOrigin = Deno.env.get("PUBLIC_ORIGIN");
  const store = new PageStore({
    path: Deno.env.get("QRBEK_DB_PATH") || DEFAULT_DB_PATH,
    maxRecords: configuredInteger(
      "QRBEK_MAX_RECORDS",
      DEFAULT_MAX_RECORDS,
      1,
      1_000_000,
    ),
  });
  const handler = createHandler({
    store,
    publicOrigin: publicOrigin ? normalizeOrigin(publicOrigin) : undefined,
    rateLimit: configuredInteger(
      "QRBEK_CREATE_RATE_LIMIT",
      DEFAULT_RATE_LIMIT,
      1,
      10_000,
    ),
    rateWindowMs: configuredInteger(
      "QRBEK_CREATE_RATE_WINDOW_MS",
      DEFAULT_RATE_WINDOW_MS,
      1_000,
      86_400_000,
    ),
  });
  Deno.serve({ port, hostname: "0.0.0.0" }, handler);
};

if (import.meta.main) start();
