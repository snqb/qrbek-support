import { DatabaseSync } from "node:sqlite";
import { createHandler } from "./server.ts";
import { MAX_PAGE_LIFETIME_DAYS, PAGE_DAY_MS, PageStore, type PageV1 } from "./page-store.ts";

const page: PageV1 = {
  v: 1, title: "Retention fixture", note: "", amount: "", currency: "KGS",
  methods: [{
    kind: "qr", label: "Demo", bankId: "bakai",
    value: "https://bakai.app/#00020101021226250009bakai.app0108345678905204000053034175802KG5909Test Name6304C613",
  }],
};
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const post = (handler: (request: Request) => Promise<Response>, envelope: unknown) =>
  handler(new Request("http://localhost/api/pages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  }));

Deno.test("expiry bounds reject invalid requests without storing a page", async () => {
  const store = new PageStore({ path: ":memory:" });
  const handler = createHandler({ store, rateLimit: 100 });
  try {
    for (const expiresInDays of [0, -1, 1.5, 1096, "365", null, true]) {
      const response = await post(handler, { page, expiresInDays });
      assert(response.status === 400, `accepted invalid duration ${expiresInDays}`);
      assert((await response.json()).error === "invalid_lifetime", "wrong validation error");
    }
    assert(store.count() === 0, "invalid requests persisted data");
  } finally { store.close(); }
});

Deno.test("server publishes authoritative expiry and denies the exact deadline", async () => {
  let now = Date.UTC(2026, 8, 26, 12);
  const store = new PageStore({ path: ":memory:", now: () => now });
  const handler = createHandler({ store, rateLimit: 100 });
  try {
    const response = await post(handler, { page, expiresInDays: 1, slug: "short-lived" });
    assert(response.status === 201, "minimum duration rejected");
    const created = await response.json();
    const apiURL = `http://localhost${created.path.replace("/p/", "/api/pages/")}`;
    const deadline = now + PAGE_DAY_MS;
    assert(Date.parse(created.expiresAt) === deadline, "deadline differs from chosen duration");
    now = deadline - 1;
    const before = await handler(new Request(apiURL));
    const visible = await before.json();
    assert(before.status === 200 && visible.expiresAt === created.expiresAt, "early expiry");
    assert(visible.methods[0].value === page.methods[0].value, "QR changed");
    now = deadline;
    const expired = await handler(new Request(apiURL));
    assert(expired.status === 404, "expired QR remains accessible");
    assert(store.count() === 0, "expired page consumes capacity");
  } finally { store.close(); }
});

Deno.test("old clients receive one year and maximum retention is 1095 days", async () => {
  const now = Date.UTC(2028, 1, 29, 12);
  const store = new PageStore({ path: ":memory:", now: () => now });
  const handler = createHandler({ store, rateLimit: 100 });
  try {
    const oldClient = await (await post(handler, { page })).json();
    assert(Date.parse(oldClient.expiresAt) === now + 365 * PAGE_DAY_MS, "old client has no bounded default");
    const maximum = await post(handler, { page, expiresInDays: MAX_PAGE_LIFETIME_DAYS });
    assert(maximum.status === 201, "maximum rejected");
    assert(Date.parse((await maximum.json()).expiresAt) === now + 1095 * PAGE_DAY_MS, "maximum extended");
  } finally { store.close(); }
});

Deno.test("legacy migration uses original creation time and physically deletes overdue payloads", async () => {
  const directory = await Deno.makeTempDir({ prefix: "qrbek-retention-" });
  const path = `${directory}/pages.sqlite3`;
  const now = Date.UTC(2026, 8, 26, 12);
  const marker = "EXPIRED_PRIVATE_PAYLOAD_72bce12c";
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE pages (id TEXT PRIMARY KEY NOT NULL, page_json TEXT NOT NULL, created_at TEXT NOT NULL) STRICT");
  const insert = legacy.prepare("INSERT INTO pages VALUES (?, ?, ?)");
  insert.run("expired", JSON.stringify({ ...page, title: marker }), new Date(now - 1095 * PAGE_DAY_MS).toISOString());
  insert.run("retained", JSON.stringify(page), new Date(now - 100 * PAGE_DAY_MS).toISOString());
  legacy.close();
  const store = new PageStore({ path, now: () => now });
  try {
    assert(store.get("expired") === null, "legacy overdue page survived startup");
    const retained = store.get("retained");
    assert(retained !== null, "young legacy page was removed");
    assert(Date.parse(retained.expiresAt) === now + 995 * PAGE_DAY_MS, "migration extended old page lifetime");
    store.close();
    const reopened = new PageStore({ path, now: () => now + PAGE_DAY_MS });
    try {
      assert(reopened.get("retained")?.expiresAt === retained.expiresAt, "restart renewed expiration");
    } finally { reopened.close(); }
    const bytes = new TextDecoder().decode(await Deno.readFile(path));
    assert(!bytes.includes(marker), "expired personal data remains in SQLite pages");
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("expired custom links never resolve to a later recipient using the same alias", async () => {
  let now = Date.UTC(2026, 8, 26);
  const store = new PageStore({ path: ":memory:", now: () => now });
  const handler = createHandler({ store, rateLimit: 100 });
  const lookup = (path: string) =>
    handler(new Request(`http://localhost${path.replace("/p/", "/api/pages/")}`));
  try {
    const first = await (await post(handler, { page, slug: "shop", expiresInDays: 1 })).json();
    assert((await lookup(first.path)).status === 200, "new custom link is unavailable");
    now += PAGE_DAY_MS;
    const replacement = await (await post(handler, {
      page: { ...page, title: "Different recipient" }, slug: "shop", expiresInDays: 1,
    })).json();
    assert(first.path !== replacement.path, "alias recycling reused original URL");
    assert((await lookup(first.path)).status === 404, "old link revived");
    assert((await lookup("/p/shop")).status === 404, "legacy unkeyed link revived");
    assert((await (await lookup(replacement.path)).json()).title === "Different recipient", "replacement unavailable");
  } finally { store.close(); }
});
