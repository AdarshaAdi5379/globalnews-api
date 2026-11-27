# GlobalNews API

A tiny, cached proxy for the [GDELT DOC 2.0 API](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/),
built as a **Cloudflare Worker**. It powers the GlobalNews Android app's news feed.

## Why

GDELT is keyless and free but **slow (measured 13–27 s per call)** and rate-limits shared IPs
with `429`s. A single warm cache changes that: many users share one upstream fetch, and repeat
loads are served from the edge cache in **milliseconds**.

Local proof (real GDELT):

```
1st (upstream): status=200 x-cache=MISS 15696ms articles=20
2nd (cache HIT): status=200 x-cache=HIT      2ms articles=20
```

## Endpoints

Base: `https://<worker-host>`

| Method | Path | Description |
|---|---|---|
| `GET` | `/` or `/health` | Service health / metadata |
| `GET` | `/api/v2/doc/doc?...` or `/doc?...` | Cached proxy to GDELT DOC 2.0 |

Accepted query params (whitelisted, forwarded to GDELT):
`query` (required), `mode`, `format`, `maxrecords`, `sort`, `timespan`,
`sourcelang`, `sourcecountry`, `near`, `domain`, `theme`.

Responses carry `X-Cache: HIT | MISS`. `200` JSON responses are cached for `CACHE_TTL_SECONDS`
(600 s). Errors and non-JSON bodies (e.g. `429` plain text) are **not** cached.

Example:

```bash
curl "https://<worker-host>/api/v2/doc/doc?query=sourcelang:english%20sourcecountry:IN&mode=artlist&format=json&maxrecords=20&sort=datedesc"
```

## Use from the Android app

The app builds GDELT URLs in `GdeltQueryBuilder.BASE_URL`. To route through this proxy, point
that constant at the worker origin, e.g.:

```kotlin
const val BASE_URL = "https://<worker-host>/api/v2/doc/doc"
```

Everything else (query building, parsing, throttle, cache fallback) keeps working unchanged.

## Develop / test

```bash
npm install          # first time only
npm test             # unit tests (node --test)
npm run live-check   # integration: real GDELT, demonstrates cache HIT
npm run dev          # local worker at http://localhost:8787
```

## Deploy

Requires a Cloudflare account login (`wrangler login`) or `CLOUDFLARE_API_TOKEN`.

```bash
npx wrangler deploy                 # permanent workers.dev deploy
npx wrangler deploy --temporary     # throwaway preview URL (no login, expires)
```

## Security notes

- **GET only**, single fixed upstream origin — not an open proxy.
- Query params are whitelisted; unknown params are rejected with `400`.
- CORS is open (`*`) so the web prototype / browsers can also use it.

## Limitations / next steps

- Cache is per-colo (`caches.default`), so it is regional rather than globally shared. For a
  single global fetch per query, back it with a KV namespace.
- No per-client rate limiting yet (add KV or Durable Objects if abuse becomes a concern).
- GDELT attribution ("GDELT Project" + link) must be preserved wherever the data is shown.
