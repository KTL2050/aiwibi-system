// supabase/functions/daily-snapshot/index.ts
//
// Runs once a day (Supabase Cron, 00:10 UTC). For every connected account it
// gets the day's PostPeer numbers through the SAME shared daily cache the
// dashboards use (analytics_cache, account:<id>:<date>) — so the dashboards
// reuse this fetch instead of paying again — and saves one row per video in
// post_daily_stats.
//
// It also turns any earlier daily cache copies into snapshots (backfill), so
// history starts from the first day the cache was saving, not from today.
//
// Only the schedule may call it: it requires the x-cron-secret header to match
// the SNAPSHOT_CRON_SECRET function secret.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

async function pMap<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++
        out[i] = await fn(items[i], i)
      }
    })
  )
  return out
}

// Same rule as the analytics functions.
function extractPostId(u: string | null) {
  if (!u) return ''
  const tiktokMatch = u.match(/\/(?:video|photo)\/(\d+)/)
  if (tiktokMatch) return tiktokMatch[1]
  const igMatch = u.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/)
  if (igMatch) return igMatch[2]
  return u.split('?')[0].replace(/\/$/, '').toLowerCase()
}

// ── Per-account daily cache — identical to postpeer-get-(all-)analytics ──
async function getAccountAnalytics(db: any, account: any, today: string, POSTPEER_KEY: string) {
  const id = account.postpeer_account_id
  const KEY = `account:${id}:${today}`

  const { data: cached, error: readError } = await db
    .from('analytics_cache').select('payload').eq('cache_key', KEY).maybeSingle()
  if (readError) console.log(`[snapshot] cache READ failed for ${KEY}:`, readError.message)
  if (cached?.payload && cached.payload.__pending !== true) {
    console.log(`[token-audit] CACHE HIT — no PostPeer call for account ${id}`)
    return cached.payload
  }

  const { error: claimError } = await db.from('analytics_cache')
    .insert({ cache_key: KEY, payload: { __pending: true }, fetched_at: new Date().toISOString() })
  if (claimError) {
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 300))
      const { data: retry } = await db.from('analytics_cache').select('payload').eq('cache_key', KEY).maybeSingle()
      if (retry?.payload && retry.payload.__pending !== true) return retry.payload
    }
    console.log(`[token-audit] Gave up waiting on concurrent fetch — account ${id}`)
  } else {
    console.log(`[token-audit] CACHE MISS — calling PostPeer for account ${id} (${account.platform})`)
  }

  let data: any
  try {
    const res = await fetch(
      `https://api.postpeer.dev/v1/analytics?source=platform&accountId=${id}&platform=${account.platform}&limit=50`,
      { headers: { 'x-access-key': POSTPEER_KEY }, signal: AbortSignal.timeout(20000) }
    )
    data = await res.json()
  } catch (e) {
    data = { success: false, error: String(e) }
  }

  if (data?.success) {
    const now = new Date().toISOString()
    const { error: saveError } = await db.from('analytics_cache').upsert([
      { cache_key: KEY, payload: data, fetched_at: now },
      { cache_key: `account:${id}:latest`, payload: data, fetched_at: now },
    ], { onConflict: 'cache_key' })
    if (saveError) console.log(`[token-audit] cache SAVE failed for ${KEY}:`, saveError.message)
    return data
  }

  // Failed (credits out, timeout…): release the claim. No snapshot is written
  // for a day without real numbers — gaps are better than wrong numbers.
  await db.from('analytics_cache').delete().eq('cache_key', KEY).eq('payload->>__pending', 'true')
  console.log(`[snapshot] PostPeer failed for ${id} (${account.platform}):`, JSON.stringify(data).slice(0, 300))
  return null
}

// One PostPeer payload → snapshot rows for a given day.
function rowsFrom(payload: any, account: any, day: string) {
  if (!payload?.success || !Array.isArray(payload.posts)) return []
  const rows: any[] = []
  for (const post of payload.posts) {
    const url = post.platforms?.[0]?.platformPostUrl ?? null
    const postId = extractPostId(url)
    if (!postId) continue
    rows.push({
      snapshot_date: day,
      platform: account.platform,
      post_id: postId,
      user_id: account.user_id,
      account_id: account.postpeer_account_id,
      url,
      views: post.aggregated?.views ?? null,
      likes: post.aggregated?.likes ?? null,
      comments: post.aggregated?.comments ?? null,
      shares: post.aggregated?.shares ?? null,
      published_at: post.publishedAt ?? null,
    })
  }
  return rows
}

Deno.serve(async (req) => {
  const expected = Deno.env.get('SNAPSHOT_CRON_SECRET')
  if (!expected || req.headers.get('x-cron-secret') !== expected) {
    return json({ error: 'Unauthorized' }, 401)
  }

  const t0 = Date.now()
  const SECRET = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')!)['default']
  const db = createClient(Deno.env.get('SUPABASE_URL')!, SECRET, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const POSTPEER_KEY = Deno.env.get('POSTPEER_API_KEY')!
  const today = new Date().toISOString().split('T')[0]

  const { data: accounts, error: accountsError } = await db
    .from('social_accounts').select('user_id, platform, postpeer_account_id')
  if (accountsError) return json({ error: accountsError.message }, 500)
  const list = (accounts || []).filter((a: any) => a.postpeer_account_id)
  const byAccountId = new Map(list.map((a: any) => [String(a.postpeer_account_id), a]))

  // 1) Today: one (shared, cached) fetch per account → snapshot rows.
  let todayRows = 0, failed = 0
  const payloads = await pMap(list, 6, (a: any) => getAccountAnalytics(db, a, today, POSTPEER_KEY))
  const rows: any[] = []
  list.forEach((a: any, i: number) => {
    if (!payloads[i]) { failed++; return }
    rows.push(...rowsFrom(payloads[i], a, today))
  })
  for (const part of chunk(rows, 500)) {
    const { error } = await db.from('post_daily_stats')
      .upsert(part, { onConflict: 'snapshot_date,platform,post_id' })
    if (error) console.log('[snapshot] save failed:', error.message)
    else todayRows += part.length
  }

  // 2) Backfill: earlier daily cache copies (account:<id>:<YYYY-MM-DD>) that
  //    aren't snapshots yet. Never overwrites an existing day.
  let backfilled = 0
  const { data: cachedDays } = await db.from('analytics_cache')
    .select('cache_key, payload')
    .like('cache_key', 'account:%:____-__-__') // dated copies only (not :latest)
  for (const row of cachedDays || []) {
    const m = String(row.cache_key).match(/^account:(.+):(\d{4}-\d{2}-\d{2})$/)
    if (!m || m[2] === today) continue
    const account = byAccountId.get(m[1])
    if (!account) continue
    const back = rowsFrom(row.payload, account, m[2])
    for (const part of chunk(back, 500)) {
      const { error } = await db.from('post_daily_stats')
        .upsert(part, { onConflict: 'snapshot_date,platform,post_id', ignoreDuplicates: true })
      if (error) console.log('[snapshot] backfill save failed:', error.message)
      else backfilled += part.length
    }
  }

  const summary = { day: today, accounts: list.length, failedAccounts: failed, todayRows, backfilledRows: backfilled, ms: Date.now() - t0 }
  console.log('[snapshot] done', JSON.stringify(summary))
  return json(summary)
})
