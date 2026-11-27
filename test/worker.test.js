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

function makeKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

const DOC_URL = DOC + "?query=sourcelang:english&mode=artlist&format=json&maxrecords=5&sort=datedesc";

test("health reports kv backend when FEED_KV is bound", async () => {
  const restore = installGlobals({ fetchImpl: () => { throw new Error("no fetch"); }, cache: makeCache() });
  try {
    const res = await worker.fetch(new Request("https://api.test/health"), { FEED_KV: makeKV() }, makeCtx());
    assert.equal((await res.json()).cache, "kv");
  } finally {
    restore();
  }
});

test("KV path caches 200: MISS stores, then KV-HIT without a second upstream fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(JSON.stringify({ articles: [{ url: "https://e/1" }] }), { status: 200 });
  };
  const restore = installGlobals({ fetchImpl, cache: makeCache() });
  try {
    const env = { FEED_KV: makeKV() };
    const ctx = makeCtx();
    const r1 = await worker.fetch(new Request(DOC_URL), env, ctx);
    await Promise.all(ctx.pending);
    assert.equal(r1.headers.get("X-Cache"), "MISS");
    assert.equal((await r1.json()).articles.length, 1);

    const r2 = await worker.fetch(new Request(DOC_URL), env, makeCtx());
    assert.equal(r2.headers.get("X-Cache"), "KV-HIT");
    assert.equal((await r2.json()).articles.length, 1);
    assert.equal(calls, 1, "second request must come from KV");
  } finally {
    restore();
  }
});

test("KV path does not store 429", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response("Please limit requests", { status: 429 });
  };
  const restore = installGlobals({ fetchImpl, cache: makeCache() });
  try {
    const env = { FEED_KV: makeKV() };
    const ctx = makeCtx();
    const r1 = await worker.fetch(new Request(DOC_URL), env, ctx);
    await Promise.all(ctx.pending);
    assert.equal(r1.status, 429);
    assert.equal(env.FEED_KV.store.size, 0, "429 must not be written to KV");

    await worker.fetch(new Request(DOC_URL), env, makeCtx());
    assert.equal(calls, 2);
  } finally {
    restore();
  }
});

test("cron warmer stores a 200 response in KV", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ articles: [{ url: "https://e/1" }] }), { status: 200 });
  const restore = installGlobals({ fetchImpl, cache: makeCache() });
  try {
    const kv = makeKV();
    await worker.scheduled({ scheduledTime: 0 }, { FEED_KV: kv }, makeCtx());
    assert.equal(kv.store.size, 1, "cron should warm one query into KV");
  } finally {
    restore();
  }
});

