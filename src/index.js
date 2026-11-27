// GlobalNews API — a small, cached, rate-limit-friendly proxy for the GDELT DOC 2.0 API.
//
// The Android app points its GDELT base URL here. GDELT is very slow (measured 13-27s per
// call) and rate-limits shared IPs with 429s, so we cache responses: many users share one
// upstream fetch, and repeat loads are served from cache in milliseconds.
//
// Two cache layers, chosen at runtime:
//  - If a KV namespace is bound (env.FEED_KV), it is the global cache (replicated across
//    colos) and a cron job pre-warms the most common queries so cold loads stay fast.
//  - Otherwise we fall back to the per-colo Cache API (caches.default).
// In both cases only 200 JSON bodies are cached; 429s/errors are never cached.
//
// Security posture:
//  - GET only, one fixed upstream origin (no open proxy).
//  - Only known GDELT DOC query params are accepted.

const GDELT_ORIGIN = "https://api.gdeltproject.org";
const DOC_PATH = "/api/v2/doc/doc";
const CACHE_TTL_SECONDS = 600; // 10 minutes
const KV_TTL_SECONDS = 600;

// Cron pre-warms one query per minute (rotating), well under GDELT's 1-req/5s limit.
// Default-query users (no interest terms) share these exact cache keys. Personalized
// queries carry interest terms and cannot be pre-warmed, but are still cached per tuple.
const WARM_QUERIES = [
  { query: "sourcelang:english" },
  { query: "sourcelang:english sourcecountry:US" },
  { query: "sourcelang:english sourcecountry:GB" },
  { query: "sourcelang:english sourcecountry:IN" },
  { query: "sourcelang:english sourcecountry:CA" },
  { query: "sourcelang:english sourcecountry:AU" },
].map((q) => ({ ...q, mode: "artlist", format: "json", maxrecords: "50", sort: "datedesc" }));

const ALLOWED_PARAMS = new Set([
  "query",
  "mode",
  "format",
  "maxrecords",
  "sort",
  "timespan",
  "sourcelang",
  "sourcecountry",
  "near",
  "domain",
  "theme",
]);

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "X-Cache",
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

function finalize(response, cacheState) {
  const headers = new Headers(response.headers);
  headers.set("X-Cache", cacheState);
  for (const [key, value] of Object.entries(corsHeaders())) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Builds the outgoing GDELT response. Only 200 JSON is marked cacheable (so 429s and error
// bodies are never cached, by us or by Cloudflare's CDN).
function bodyResponse(body, status, cacheState) {
  const cacheable = status === 200 && String(body).trimStart().startsWith("{");
  return finalize(
    new Response(body, {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": cacheable
          ? `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`
          : "no-store",
      },
    }),
    cacheState
  );
}

function buildUpstreamUrl(searchParams) {
  const upstream = new URL(GDELT_ORIGIN + DOC_PATH);
  searchParams.forEach((value, key) => upstream.searchParams.set(key, value));
  return upstream.toString();
}

async function safeFetch(upstreamUrl) {
  try {
    const resp = await fetch(upstreamUrl, {
      headers: {
        "User-Agent": "globalnews-api/1.0 (Cloudflare Worker)",
        Accept: "application/json",
      },
    });
    return { status: resp.status, body: await resp.text() };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

function kvKey(upstreamUrl) {
  return "doc:" + upstreamUrl;
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  if (url.pathname === "/" || url.pathname === "/health") {
    return jsonResponse({
      status: "ok",
      service: "globalnews-api",
      cache_ttl_seconds: CACHE_TTL_SECONDS,
      cache: env.FEED_KV ? "kv" : "cache-api",
    });
  }

  const upstreamPath = url.pathname === "/doc" ? DOC_PATH : url.pathname;
  if (upstreamPath !== DOC_PATH) {
    return jsonResponse({ error: "not_found" }, 404);
  }

  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_PARAMS.has(key)) {
      return jsonResponse({ error: "param_not_allowed", param: key }, 400);
    }
  }
  if (!url.searchParams.has("query")) {
    return jsonResponse({ error: "missing_query" }, 400);
  }

  const upstreamUrl = buildUpstreamUrl(url.searchParams);

  if (env.FEED_KV) {
    const key = kvKey(upstreamUrl);
    const entry = await env.FEED_KV.get(key, "json");
    if (entry && Date.now() - entry.storedAt < KV_TTL_SECONDS * 1000) {
      return bodyResponse(entry.body, 200, "KV-HIT");
    }
    const up = await safeFetch(upstreamUrl);
    if (up.error) return jsonResponse({ error: "upstream_unreachable", detail: up.error }, 502);
    if (up.status === 200 && String(up.body).trimStart().startsWith("{")) {
      ctx.waitUntil(
        env.FEED_KV.put(key, JSON.stringify({ storedAt: Date.now(), body: up.body }), {
          expirationTtl: KV_TTL_SECONDS,
        })
      );
    }
    return bodyResponse(up.body, up.status, "MISS");
  }

  const cache = caches.default;
  const cacheKey = new Request(upstreamUrl, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) {
    return finalize(cached, "HIT");
  }

  const up = await safeFetch(upstreamUrl);
  if (up.error) return jsonResponse({ error: "upstream_unreachable", detail: up.error }, 502);

  const response = bodyResponse(up.body, up.status, "MISS");
  if (up.status === 200 && String(up.body).trimStart().startsWith("{")) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}

// Cron warmer: pre-fetch the next query in rotation into KV so real users hit a warm cache.
async function scheduled(controller, env) {
  if (!env.FEED_KV || WARM_QUERIES.length === 0) return;
  const minute = Math.floor((controller.scheduledTime || Date.now()) / 60_000);
  const spec = WARM_QUERIES[minute % WARM_QUERIES.length];
  const upstreamUrl = buildUpstreamUrl(new URLSearchParams(spec));
  const up = await safeFetch(upstreamUrl);
  if (!up.error && up.status === 200 && String(up.body).trimStart().startsWith("{")) {
    await env.FEED_KV.put(
      kvKey(upstreamUrl),
      JSON.stringify({ storedAt: Date.now(), body: up.body }),
      { expirationTtl: KV_TTL_SECONDS }
    );
  }
}

export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),
  scheduled: (controller, env, ctx) => scheduled(controller, env, ctx),
};
