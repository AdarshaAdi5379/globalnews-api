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

The app already supports this. It exposes a single switch, `ServiceLocator.PROXY_BASE_URL`. Set
it to this worker's DOC endpoint and the feed is fetched through the proxy **first**, with
direct GDELT as an automatic fallback (so a slow/down backend never breaks the feed):

```kotlin
private const val PROXY_BASE_URL = "https://<worker-host>/api/v2/doc/doc"
```

Leave it blank (`""`) to call GDELT directly. No other app code changes are needed — query
building, parsing, throttling and the on-device cache fallback all keep working.

> **Privacy:** once `PROXY_BASE_URL` is set, the user's country and interest-derived search
> terms are sent to this worker (and thus through Cloudflare). Update the privacy policy and the
> Play Data Safety form to disclose this before shipping with the proxy enabled.

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

### Enable the global KV cache + cron warmer (recommended)

Without KV the worker still runs on the per-colo Cache API. To get one **global** cache and
an always-warm feed:

```bash
npx wrangler kv namespace create FEED_KV        # prints an id
```

Paste the id into `wrangler.toml` (uncomment the `[[kv_namespaces]]` block), then:

```bash
npx wrangler deploy
```

The `[triggers]` cron (`* * * * *`) pre-fetches one query per minute in rotation from
`WARM_QUERIES` in `src/index.js`, so default-query users always hit a warm cache. Edit that
list to match the countries/heavy queries you actually serve.

## Security notes

- **GET only**, single fixed upstream origin — not an open proxy.
- Query params are whitelisted; unknown params are rejected with `400`.
- CORS is open (`*`) so the web prototype / browsers can also use it.

## Limitations / next steps

- Only **200 JSON** is cached; 429s and errors are never cached (so a rate-limited upstream is
  retried, not memoized).
- The cron warmer only helps queries it can predict (default / no-interest users). Personalized
  queries carry interest terms and get their own cache entry per unique tuple, so cross-user
  sharing is limited to identical (country, language, interests) combinations.
- No per-client rate limiting yet (add KV or Durable Objects if abuse becomes a concern).
- GDELT attribution ("GDELT Project" + link) must be preserved wherever the data is shown.
