// GlobalNews API — a small, cached, rate-limit-friendly proxy for the GDELT DOC 2.0 API.
//
// The Android app points its GDELT base URL here. GDELT is very slow (measured 13-27s per
// call) and rate-limits shared IPs with 429s, so we cache responses at the edge: many users
// share one upstream fetch, and repeat loads are served from cache in milliseconds.
//
// Security posture:
//  - GET only, one fixed upstream origin (no open proxy).
//  - Only known GDELT DOC query params are accepted.
//  - CORS enabled so the web prototype / browsers can call it too.

const GDELT_ORIGIN = "https://api.gdeltproject.org";
const DOC_PATH = "/api/v2/doc/doc";
const CACHE_TTL_SECONDS = 600; // 10 minutes

// shortcut: Cache API (caches.default) is per-colo, so caching is regional rather than truly
// global. Move to a KV namespace (read-heavy, globally replicated) if you need one upstream
// fetch shared across all Cloudflare colos.
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

  const upstream = new URL(GDELT_ORIGIN + DOC_PATH);
  url.searchParams.forEach((value, key) => upstream.searchParams.set(key, value));
  const upstreamUrl = upstream.toString();

  const cache = caches.default;
  const cacheKey = new Request(upstreamUrl, { method: "GET" });

  const cached = await cache.match(cacheKey);
  if (cached) {
    return finalize(cached, "HIT");
  }

  let upstreamResp;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      headers: {
        "User-Agent": "globalnews-api/1.0 (Cloudflare Worker)",
        Accept: "application/json",
      },
    });
  } catch (err) {
    return jsonResponse(
      { error: "upstream_unreachable", detail: String((err && err.message) || err) },
      502
    );
  }

  const body = await upstreamResp.text();
  const cacheable = upstreamResp.status === 200 && body.trimStart().startsWith("{");

  const response = new Response(body, {
    status: upstreamResp.status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheable
        ? `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`
        : "no-store",
    },
  });

  if (cacheable) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }

  return finalize(response, "MISS");
}

export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),
};
