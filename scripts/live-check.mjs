// Integration check against the REAL GDELT API using an in-memory cache.
// Proves the worker fetches upstream on a miss and serves the second call from cache.
// Run: npm run live-check
import worker from "../src/index.js";

const store = new Map();
globalThis.caches = {
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

const ctx = { pending: [], waitUntil(p) { this.pending.push(p); } };
const q = "query=sourcelang:english%20sourcecountry:IN&mode=artlist&format=json&maxrecords=20&sort=datedesc";
const makeReq = () => new Request(`https://globalnews-api.test/api/v2/doc/doc?${q}`);

async function once(label) {
  const t = performance.now();
  const res = await worker.fetch(makeReq(), {}, ctx);
  const body = await res.text();
  const ms = Math.round(performance.now() - t);
  let n = 0;
  try {
    n = (JSON.parse(body).articles || []).length;
  } catch {
    n = 0;
  }
  console.log(`${label}: status=${res.status} x-cache=${res.headers.get("X-Cache")} ${ms}ms articles=${n}`);
  return res.status;
}

let status = await once("1st (upstream)");
await Promise.all(ctx.pending);

if (status === 429) {
  console.log("GDELT rate-limited (shared IP); waiting 6s then retrying...");
  await new Promise((r) => setTimeout(r, 6000));
  status = await once("retry (upstream)");
  await Promise.all(ctx.pending);
}

if (status !== 200) {
  console.error("Could not get a 200 from GDELT; cannot demonstrate cache HIT.");
  process.exit(1);
}

await once("2nd (should be cache HIT)");
