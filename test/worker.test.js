import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

function makeCache() {
  const store = new Map();
  return {
    default: {
      async match(req) {
        const r = store.get(req.url);
        return r ? r.clone() : undefined;
      },
      async put(req, res) {
        store.set(req.url, res.clone());
      },
    },
  };
}

function installGlobals({ fetchImpl, cache }) {
  const prevFetch = globalThis.fetch;
  const prevCaches = globalThis.caches;
  globalThis.fetch = fetchImpl;
  globalThis.caches = cache;
  return () => {
    if (prevFetch) globalThis.fetch = prevFetch;
    else delete globalThis.fetch;
    if (prevCaches) globalThis.caches = prevCaches;
    else delete globalThis.caches;
  };
}

function makeCtx() {
  return { pending: [], waitUntil(p) { this.pending.push(p); } };
}

const DOC = "https://api.test/api/v2/doc/doc";

test("health endpoint returns ok", async () => {
  const restore = installGlobals({ fetchImpl: () => { throw new Error("must not fetch"); }, cache: makeCache() });
  try {
    const res = await worker.fetch(new Request("https://api.test/health"), {}, makeCtx());
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "ok");
  } finally {
    restore();
  }
});

test("missing query -> 400", async () => {
  const restore = installGlobals({ fetchImpl: () => { throw new Error("must not fetch"); }, cache: makeCache() });
  try {
    const res = await worker.fetch(new Request(DOC + "?mode=artlist"), {}, makeCtx());
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "missing_query");
  } finally {
    restore();
  }
});

test("disallowed param -> 400", async () => {
  const restore = installGlobals({ fetchImpl: () => { throw new Error("must not fetch"); }, cache: makeCache() });
  try {
    const res = await worker.fetch(new Request(DOC + "?query=x&evil=1"), {}, makeCtx());
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "param_not_allowed");
  } finally {
    restore();
  }
});

test("non-GET -> 405", async () => {
  const restore = installGlobals({ fetchImpl: () => { throw new Error("must not fetch"); }, cache: makeCache() });
  try {
    const res = await worker.fetch(new Request(DOC + "?query=x", { method: "POST" }), {}, makeCtx());
    assert.equal(res.status, 405);
  } finally {
    restore();
  }
});

test("proxy caches 200 JSON: MISS then HIT with a single upstream fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(JSON.stringify({ articles: [{ url: "https://e/1" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const restore = installGlobals({ fetchImpl, cache: makeCache() });
  try {
    const url = DOC + "?query=sourcelang:english&mode=artlist&format=json&maxrecords=5&sort=datedesc";
    const ctx = makeCtx();

    const r1 = await worker.fetch(new Request(url), {}, ctx);
    await Promise.all(ctx.pending);
    assert.equal(r1.headers.get("X-Cache"), "MISS");
    assert.equal((await r1.json()).articles.length, 1);

    const r2 = await worker.fetch(new Request(url), {}, makeCtx());
    assert.equal(r2.headers.get("X-Cache"), "HIT");
    assert.equal((await r2.json()).articles.length, 1);

    assert.equal(calls, 1, "upstream must be fetched only once");
  } finally {
    restore();
  }
});

test("does not cache non-JSON / 429 responses", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response("Please limit requests to one every 5 seconds", { status: 429 });
  };
  const restore = installGlobals({ fetchImpl, cache: makeCache() });
  try {
    const url = DOC + "?query=sourcelang:english&mode=artlist&format=json&maxrecords=5&sort=datedesc";
    const ctx = makeCtx();
    const r1 = await worker.fetch(new Request(url), {}, ctx);
    await Promise.all(ctx.pending);
    assert.equal(r1.status, 429);
    assert.equal(r1.headers.get("X-Cache"), "MISS");

    const r2 = await worker.fetch(new Request(url), {}, makeCtx());
    assert.equal(r2.headers.get("X-Cache"), "MISS");
    assert.equal(calls, 2, "429 must not be served from cache");
  } finally {
    restore();
  }
});
