import { createHandler } from "./server.ts";
import { PageStore, type PageV1 } from "./page-store.ts";

const test = globalThis.Deno?.test;
const assertEqual = (actual: unknown, expected: unknown, message: string) => {
  if (actual !== expected) {
    throw new Error(`${message}: ${String(actual)} !== ${String(expected)}`);
  }
};
const assertDeepEqual = (
  actual: unknown,
  expected: unknown,
  message: string,
) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
    );
  }
};

const syntheticQr =
  "00020101021226250009bakai.app0108345678905204000053034175802KG5909Test Name6304C613";
const page = (value = `https://bakai.app/#${syntheticQr}`): PageV1 => ({
  v: 1,
  title: "Demo",
  note: "",
  amount: "",
  currency: "KGS",
  methods: [{ kind: "qr", label: "Основной", value, bankId: "" }],
});
const post = (
  handler: (request: Request) => Promise<Response>,
  envelope: unknown,
  headers = {
    "content-type": "application/json",
  },
) =>
  handler(
    new Request("http://localhost/api/pages", {
      method: "POST",
      headers,
      body: typeof envelope === "string" ? envelope : JSON.stringify(envelope),
    }),
  );

if (test) {
  test("POST and GET preserve normalized QR data and custom alias", async () => {
    const store = new PageStore({ path: ":memory:" });
    const handler = createHandler({ store, rateLimit: 100 });
    const input = page();
    const created = await post(handler, { page: input, slug: "demo-pay" });
    assertEqual(created.status, 201, "create status");
    const createdBody = await created.json();
    assertEqual(createdBody.id, "demo-pay", "custom id");
    const fetched = await handler(
      new Request(`http://localhost${createdBody.path.replace("/p/", "/api/pages/")}`),
    );
    assertEqual(fetched.status, 200, "fetch status");
    const fetchedBody = await fetched.json();
    assertDeepEqual(fetchedBody, {
      ...input,
      methods: [{ ...input.methods[0], bankId: "bakai" }],
      expiresAt: createdBody.expiresAt,
    }, "stored page");
    store.close();
  });

  test("duplicate aliases are atomic and never overwrite the first page", async () => {
    const directory = await Deno.makeTempDir({ prefix: "qrbek-race-" });
    const path = `${directory}/pages.sqlite3`;
    const firstStore = new PageStore({ path });
    const competingStore = new PageStore({ path });
    const firstHandler = createHandler({ store: firstStore, rateLimit: 100 });
    const competingHandler = createHandler({
      store: competingStore,
      rateLimit: 100,
    });
    const firstResponse = await post(firstHandler, { page: page(), slug: "fixed-alias" });
    assertEqual(firstResponse.status, 201, "first create");
    const firstCreated = await firstResponse.json();
    const second = await post(competingHandler, {
      page: { ...page(), title: "Other page" },
      slug: "fixed-alias",
    });
    assertEqual(second.status, 409, "duplicate status");
    const stored = await firstHandler(
      new Request(`http://localhost${firstCreated.path.replace("/p/", "/api/pages/")}`),
    );
    const body = await stored.json();
    assertEqual(body.title, "Demo", "first page remains");
    assertEqual(
      body.methods[0].value,
      page().methods[0].value,
      "first QR remains",
    );
    firstStore.close();
    competingStore.close();
    await Deno.remove(directory, { recursive: true });
  });

  test("reopening the SQLite store retains pages", async () => {
    const directory = await Deno.makeTempDir({ prefix: "qrbek-store-" });
    const path = `${directory}/pages.sqlite3`;
    const first = new PageStore({ path });
    const normalized = page();
    const created = first.create(normalized, "persisted");
    first.close();
    const reopened = new PageStore({ path });
    const loaded = reopened.get(created.id);
    if (!loaded) throw new Error("reopened page should exist");
    assertDeepEqual(loaded.page, normalized, "reopened page");
    assertEqual(loaded.createdAt, created.createdAt, "creation timestamp");
    reopened.close();
    await Deno.remove(directory, { recursive: true });
  });

  test("malformed, oversized, unsafe, and private requests fail closed", async () => {
    const store = new PageStore({ path: ":memory:" });
    const handler = createHandler({ store, maxBodyBytes: 512, rateLimit: 100 });
    const malformed = await post(handler, "{", {
      "content-type": "application/json",
    });
    assertEqual(malformed.status, 400, "malformed JSON status");
    const wrongType = await post(handler, { page: page() }, {
      "content-type": "text/plain",
    });
    assertEqual(wrongType.status, 415, "content type status");
    assertEqual(
      (await post(handler, { page: page(), slug: "a" })).status,
      400,
      "one-character alias",
    );
    assertEqual(
      (await post(handler, { page: page(), slug: "ab" })).status,
      400,
      "two-character alias",
    );
    assertEqual(
      (await post(handler, { page: page(), slug: "a".repeat(33) })).status,
      400,
      "overlong alias",
    );
    const oversized = await post(handler, "x".repeat(513), {
      "content-type": "application/json",
    });
    assertEqual(oversized.status, 413, "oversized status");
    const unsafe = await post(handler, {
      page: page(
        `https://bakai.app/#${syntheticQr.replace("Test Name", "Tampered")}`,
      ),
    });
    assertEqual(unsafe.status, 400, "unsafe QR status");
    const privateServer = await handler(
      new Request("http://localhost/server.ts"),
    );
    assertEqual(privateServer.status, 404, "server source must stay private");
    const privateStore = await handler(
      new Request("http://localhost/page-store.ts"),
    );
    assertEqual(privateStore.status, 404, "store source must stay private");
    store.close();
  });

  test("legacy page navigation moves to the canonical host without redirecting APIs or assets", async () => {
    const store = new PageStore({ path: ":memory:" });
    const handler = createHandler({ store, publicOrigin: "https://qrbek.xyz" });
    try {
      for (
        const path of [
          "/",
          "/p/kept-page?from=qr",
          "/pay.html",
          "/create.html",
          "/interface-design/",
        ]
      ) {
        const response = await handler(
          new Request(`https://qrbek.esen.works${path}`),
        );
        assertEqual(response.status, 308, "legacy navigation redirects");
        assertEqual(
          response.headers.get("location"),
          `https://qrbek.xyz${path}`,
          "path and query survive",
        );
      }
      const current = await handler(new Request("https://qrbek.xyz/"));
      assertEqual(current.status, 200, "canonical host does not redirect");
      const asset = await handler(
        new Request("https://qrbek.esen.works/app.js"),
      );
      assertEqual(
        asset.status,
        200,
        "open legacy tabs can still load same-origin assets",
      );
      const api = await handler(
        new Request("https://qrbek.esen.works/api/pages/missing"),
      );
      assertEqual(api.status, 404, "legacy API stays same-origin");
      assertEqual(
        (await api.json()).error,
        "not_found",
        "legacy API still returns JSON",
      );
    } finally {
      store.close();
    }
  });

  test("open legacy creators and native clients can publish without allowing foreign origins", async () => {
    const store = new PageStore({ path: ":memory:" });
    const handler = createHandler({
      store,
      publicOrigin: "https://qrbek.xyz",
      rateLimit: 100,
    });
    const publish = (host: string, origin?: string) =>
      handler(
        new Request(`${host}/api/pages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(origin ? { origin } : {}),
          },
          body: JSON.stringify({ page: page() }),
        }),
      );
    try {
      const legacy = await publish(
        "https://qrbek.esen.works",
        "https://qrbek.esen.works",
      );
      assertEqual(
        legacy.status,
        201,
        "already-open legacy creator can publish",
      );
      const created = await legacy.json();
      const loaded = await handler(
        new Request(`https://qrbek.xyz/api/pages/${created.id}`),
      );
      assertEqual(
        loaded.status,
        200,
        "legacy create is available at the new host",
      );
      assertEqual(
        (await loaded.json()).methods[0].value,
        page().methods[0].value,
        "QR is unchanged",
      );
      assertEqual(
        (await publish("https://qrbek.xyz", "https://qrbek.xyz")).status,
        201,
        "canonical browser can publish",
      );
      assertEqual(
        (await publish("https://qrbek.xyz")).status,
        201,
        "native client can publish",
      );
      assertEqual(
        (await publish("https://qrbek.xyz", "https://qrbek.esen.works")).status,
        403,
        "legacy exception is scoped to legacy host",
      );
      assertEqual(
        (await publish("https://qrbek.esen.works", "https://foreign.example"))
          .status,
        403,
        "foreign browser remains forbidden",
      );
    } finally {
      store.close();
    }
  });
}
