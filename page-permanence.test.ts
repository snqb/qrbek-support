import { DatabaseSync } from "node:sqlite";
import { createHandler } from "./server.ts";
import { PAGE_DAY_MS, PageStore, type PageV1 } from "./page-store.ts";

const page: PageV1 = {
  v: 1, title: "Permanent fixture", note: "", amount: "", currency: "KGS",
  methods: [{
    kind: "qr", label: "Demo", bankId: "bakai",
    value: "https://bakai.app/#00020101021226250009bakai.app0108345678905204000053034175802KG5909Test Name6304C613",
  }],
};
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const publish = (handler: (request: Request) => Promise<Response>, envelope: unknown) =>
  handler(new Request("http://localhost/api/pages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  }));

Deno.test("permanent links survive time and restart while quick requests expire", async () => {
  const directory = await Deno.makeTempDir({ prefix: "qrbek-permanent-" });
  const path = `${directory}/pages.sqlite3`;
  let now = Date.UTC(2026, 9, 6);
  let store = new PageStore({ path, now: () => now });
  try {
    const handler = createHandler({ store });
    const namedResponse = await publish(handler, { page, slug: "my-shop", expiresInDays: null });
    assert(namedResponse.status === 201, "permanent alias rejected");
    const named = await namedResponse.json();
    const generated = await (await publish(handler, { page })).json();
    const request = await (await publish(handler, { page, expiresInDays: 7 })).json();
    assert(named.path === "/@my-shop" && named.id === "@my-shop", "wrong permanent namespace");
    assert(named.expiresAt === null && generated.expiresAt === null, "permanent link has a deadline");
    assert(Date.parse(request.expiresAt) === now + 7 * PAGE_DAY_MS, "quick request lost its deadline");
    now += 7 * PAGE_DAY_MS;
    assert(store.get(request.id) === null, "quick request survived its deadline");
    store.close();
    now += 100 * 366 * PAGE_DAY_MS;
    store = new PageStore({ path, now: () => now });
    assert(store.get(named.id)?.page.methods[0].value === page.methods[0].value, "permanent QR lost on restart");
    assert(store.get(generated.id)?.expiresAt === null, "restart converted permanence into expiry");
    assert(store.count() === 2, "capacity excludes permanent pages or includes expired requests");
    const reopened = createHandler({ store });
    assert((await publish(reopened, { page, slug: "my-shop" })).status === 409, "permanent alias overwritten");
    assert((await reopened(new Request("http://localhost/@my-shop"))).status === 200, "permalink document missing");
    assert((await reopened(new Request("http://localhost/api/pages/@my-shop?key=wrong"))).status === 404, "wrong key accepted");
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("new aliases cannot revive old keyless named or random links", async () => {
  const store = new PageStore({ path: ":memory:" });
  try {
    const handler = createHandler({ store });
    for (const slug of ["former-name", "ba3258da6f58c6c50dca194973889139"]) {
      const response = await publish(handler, { page, slug });
      assert(response.status === 201, "new namespace rejected a valid alias");
      const created = await response.json();
      assert(created.path === `/@${slug}`, "alias used legacy namespace");
      assert((await handler(new Request(`http://localhost/api/pages/${slug}`))).status === 404,
        "an old keyless URL now resolves to a different recipient");
      const current = await handler(new Request(`http://localhost/api/pages/@${slug}`));
      assert(current.status === 200 && (await current.json()).title === page.title, "new recipient inaccessible");
    }
  } finally { store.close(); }
});

Deno.test("nullable-expiry migration preserves legacy keys and promised deadlines", async () => {
  const directory = await Deno.makeTempDir({ prefix: "qrbek-upgrade-" });
  const path = `${directory}/pages.sqlite3`;
  const now = Date.UTC(2026, 9, 6);
  const deadline = new Date(now + PAGE_DAY_MS).toISOString();
  const key = "a".repeat(32);
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE pages (
    id TEXT PRIMARY KEY NOT NULL, page_json TEXT NOT NULL, created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL, access_key TEXT
  ) STRICT`);
  legacy.prepare("INSERT INTO pages VALUES (?, ?, ?, ?, ?)").run(
    "legacy-shop", JSON.stringify(page), new Date(now).toISOString(), deadline, key,
  );
  legacy.close();
  const store = new PageStore({ path, now: () => now });
  try {
    assert(store.get("legacy-shop")?.expiresAt === deadline, "migration changed a promised deadline");
    const handler = createHandler({ store });
    const read = (suffix: string) => handler(new Request(`http://localhost/api/pages/legacy-shop${suffix}`));
    assert((await read(`?key=${key}`)).status === 200, "old full link broke");
    assert((await read("")).status === 404 && (await read(`?key=${"b".repeat(32)}`)).status === 404,
      "migration bypassed the old generation key");
    assert((await publish(handler, { page, slug: "new-shop" })).status === 201,
      "migrated NOT NULL schema rejects permanent links");
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("deleting permanent content does not free its address for another recipient", async () => {
  const directory = await Deno.makeTempDir({ prefix: "qrbek-retired-" });
  const path = `${directory}/pages.sqlite3`;
  let store = new PageStore({ path });
  try {
    const created = store.create(page, "retired-name");
    store.close();
    const admin = new DatabaseSync(path);
    admin.prepare("DELETE FROM pages WHERE id = ?").run(created.id);
    admin.close();
    store = new PageStore({ path });
    const handler = createHandler({ store });
    assert((await handler(new Request("http://localhost/api/pages/@retired-name"))).status === 404,
      "deleted content remains public");
    assert((await publish(handler, { page: { ...page, title: "Other recipient" }, slug: "retired-name" })).status === 409,
      "deletion reassigned a permanent address");
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});
