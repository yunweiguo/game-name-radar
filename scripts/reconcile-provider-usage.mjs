import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const serperUsagePath = path.join(dataDir, 'serper-usage.json');
const SERPER_API_KEY = String(process.env.SERPER_API_KEY || '').trim();
const SERPER_TOTAL_LIMIT = Math.max(1, Number(process.env.SERPER_TOTAL_LIMIT || 2400));
const SERPER_DAILY_LIMIT = Math.max(1, Number(process.env.SERPER_DAILY_LIMIT || SERPER_TOTAL_LIMIT));
const SERPAPI_MONTHLY_LIMIT = Math.max(1, Number(process.env.SERPAPI_MONTHLY_LIMIT || 220));
const SERPAPI_DAILY_LIMIT = Math.max(1, Number(process.env.SERPAPI_DAILY_LIMIT || 8));
const TIMEOUT_MS = Math.max(5000, Number(process.env.SERPAPI_ACCOUNT_TIMEOUT_MS || 15000));
const SERPAPI_SLOTS = [
  ['1', 'SERPAPI_API_KEY'],
  ['2', 'SERPAPI_API_KEY_2'],
  ['3', 'SERPAPI_API_KEY_3'],
  ['4', 'SERPAPI_API_KEY_4'],
  ['5', 'SERPAPI_API_KEY_5'],
];

async function readJson(file, fallback = {}) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

function fingerprint(value = '') {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function period() {
  const now = new Date();
  return { month: now.toISOString().slice(0, 7), day: now.toISOString().slice(0, 10), now: now.toISOString() };
}

async function reconcileSerper() {
  if (!SERPER_API_KEY) {
    console.log('Serper quota reconcile: SERPER_API_KEY is not configured; skipped.');
    return;
  }

  const { day, now } = period();
  const keyFingerprint = fingerprint(SERPER_API_KEY);
  const stored = await readJson(serperUsagePath, {});
  const sameKey = stored.keyFingerprint === keyFingerprint;
  const sameDay = sameKey && stored.day === day;

  const usage = {
    keyFingerprint,
    totalUsed: sameKey ? Number(stored.totalUsed || 0) : 0,
    day,
    dayUsed: sameDay ? Number(stored.dayUsed || 0) : 0,
    totalLimit: SERPER_TOTAL_LIMIT,
    dailyLimit: SERPER_DAILY_LIMIT,
    updatedAt: now,
    lastError: sameKey ? stored.lastError || null : null,
  };

  if (!sameKey) usage.resetReason = stored.keyFingerprint ? 'api-key-changed' : 'untrusted-inherited-state';
  else if (stored.resetReason) usage.resetReason = stored.resetReason;

  await writeJson(serperUsagePath, usage);
  console.log(`Serper quota reconcile: ${sameKey ? 'kept current key usage' : 'reset stale usage for current key'}; ${usage.totalUsed}/${usage.totalLimit} total.`);
}

async function fetchSerpApiAccount(key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = new URL('https://serpapi.com/account.json');
    url.searchParams.set('api_key', key);
    const response = await fetch(url, { signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw new Error(payload.error || `SerpApi Account API returned ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function reconcileSerpApiSlot(id, envName, key) {
  if (!key) return;
  const usagePath = id === '1' ? path.join(dataDir, 'serpapi-usage.json') : path.join(dataDir, `serpapi-usage-${id}.json`);
  const keyFingerprint = fingerprint(key);
  const stored = await readJson(usagePath, {});

  try {
    const account = await fetchSerpApiAccount(key);
    const { month, day, now } = period();
    const sameKey = stored.keyFingerprint === keyFingerprint;
    const sameDay = sameKey && stored.day === day;
    const providerMonthUsed = Number(account.this_month_usage || 0);
    const usage = {
      keyFingerprint,
      accountFingerprint: fingerprint(account.account_id || ''),
      month,
      monthUsed: providerMonthUsed,
      day,
      dayUsed: sameDay ? Math.min(Number(stored.dayUsed || 0), providerMonthUsed) : 0,
      monthlyLimit: SERPAPI_MONTHLY_LIMIT,
      dailyLimit: SERPAPI_DAILY_LIMIT,
      providerSearchesPerMonth: Number(account.searches_per_month || 0),
      providerSearchesLeft: Number(account.total_searches_left ?? account.plan_searches_left ?? 0),
      providerPlan: account.plan_name || account.plan_id || null,
      reconciledAt: now,
      updatedAt: now,
    };
    if (!sameKey) usage.resetReason = stored.keyFingerprint ? 'api-key-changed' : 'untrusted-inherited-state';
    await writeJson(usagePath, usage);
    console.log(`SerpApi quota reconcile ${envName}: provider usage ${usage.monthUsed}/${usage.providerSearchesPerMonth || '?'}; local safety limit ${usage.monthlyLimit}.`);
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'account check timed out' : String(error?.message || error);
    console.log(`SerpApi quota reconcile ${envName}: ${message}; kept existing local usage.`);
  }
}

await reconcileSerper();
for (const [id, envName] of SERPAPI_SLOTS) {
  const key = String(process.env[envName] || '').trim();
  await reconcileSerpApiSlot(id, envName, key);
}
