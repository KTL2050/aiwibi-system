// supabase/functions/postpeer-get-all-analytics/index.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function emptySummary() {
  return { totalViews: 0, totalEngagements: 0, totalPosts: 0, totalMothers: 0 }
}

// ── Small utilities ─────────────────────────────────────────────
function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

// Bounded-concurrency map. Results keep the input order, so aggregation
// stays deterministic even though the work runs in parallel.
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

// A hung third-party request must never be able to burn the whole
// function budget.
async function fetchWithTimeout(url: string, opts: RequestInit = {}, ms = 8000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

function extractPostId(u: string | null) {
  if (!u) return ''
  // TikTok videos (/video/<id>) and photo slideshows (/photo/<id>)
  const tiktokMatch = u.match(/\/(?:video|photo)\/(\d+)/)
  if (tiktokMatch) return tiktokMatch[1]

  const igMatch = u.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/)
  if (igMatch) return igMatch[2]

  return u.split('?')[0].replace(/\/$/, '').toLowerCase()
}

function isCanonical(u: string) {
  return /\/(?:video|photo)\/\d+/.test(u) || /\/(p|reel)\//.test(u)
}

const BROWSER_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36'

// ── Short-URL resolution ────────────────────────────────────────
// A short link's destination never changes, so it is resolved once,
// stored in `resolved_urls`, and read back in bulk afterwards. Anything
// genuinely new is resolved in parallel with a hard timeout.
async function resolveAllUrls(supabase: any, rawUrls: string[]) {
  const unique = [...new Set(rawUrls.filter(Boolean))]
  const resolved = new Map<string, string>()
  const needsNetwork: string[] = []

  for (const u of unique) {
    if (isCanonical(u)) resolved.set(u, u)
    else needsNetwork.push(u)
  }

  if (needsNetwork.length === 0) return resolved

  // 1) Anything we resolved on a previous run.
  for (const part of chunk(needsNetwork, 200)) {
    const { data } = await supabase
      .from('resolved_urls')
      .select('raw_url, resolved_url')
      .in('raw_url', part)
    // Ignore any old cached row that didn't land on a real post URL.
    ;(data || []).forEach((r: any) => { if (isCanonical(r.resolved_url)) resolved.set(r.raw_url, r.resolved_url) })
  }

  // 2) Whatever is left, resolved in parallel rather than one by one.
  const missing = needsNetwork.filter(u => !resolved.has(u))
  if (missing.length) {
    console.log(`[perf] resolving ${missing.length} new short URLs (of ${unique.length} total)`)
    const results = await pMap(missing, 10, async (u) => {
      try {
        // GET with a browser User-Agent: TikTok often answers bare HEAD
        // requests from servers with a redirect to its homepage instead.
        const res = await fetchWithTimeout(u, {
          method: 'GET',
          redirect: 'follow',
          headers: { 'User-Agent': BROWSER_UA },
        }, 8000)
        await res.body?.cancel()
        const finalUrl = res.url || u
        const ok = isCanonical(finalUrl)
        if (!ok) console.log('[resolve] short URL did not land on a post URL:', u, '→', finalUrl)
        return { raw_url: u, resolved_url: finalUrl, ok }
      } catch (_e) {
        // Fall back to the raw URL for this run, but don't cache a failure.
        return { raw_url: u, resolved_url: u, ok: false }
      }
    })

    results.forEach(r => resolved.set(r.raw_url, r.resolved_url))

    const cacheable = results
      .filter(r => r.ok)
      .map(r => ({ raw_url: r.raw_url, resolved_url: r.resolved_url, resolved_at: new Date().toISOString() }))
    for (const part of chunk(cacheable, 200)) {
      const { error: saveError } = await supabase.from('resolved_urls').upsert(part, { onConflict: 'raw_url' })
      if (saveError) console.log('[resolve] save failed:', saveError.message)
    }
  }

  return resolved
}

// ── Last good data (used when PostPeer fails, e.g. credits expired) ──
// Every successful PostPeer response is also saved under
// `account:<id>:latest`. If PostPeer fails, we serve that snapshot
// (or, for older data, the most recent successful daily row) instead
// of showing zeros.
async function getLastGoodAccountData(supabase: any, account: any) {
  const id = account.postpeer_account_id

  const { data: latest } = await supabase
    .from('analytics_cache')
    .select('payload, fetched_at')
    .eq('cache_key', `account:${id}:latest`)
    .maybeSingle()

  let row = latest
  if (!row?.payload?.success) {
    const { data: older } = await supabase
      .from('analytics_cache')
      .select('payload, fetched_at')
      .like('cache_key', `account:${id}:%`)
      .eq('payload->>success', 'true')
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    row = older
  }

  if (!row?.payload?.success) return null
  return { ...row.payload, __stale: true, __asOf: row.fetched_at }
}

// ── Per-account daily cache ─────────────────────────────────────
// Shared across BOTH the mother's own dashboard and the admin's
// all-analytics dashboard. Whichever one asks for a given connected
// account first each day pays the PostPeer token; every other call
// for that same account that day reuses the cached response.
async function getAccountAnalytics(supabase: any, account: any, today: string, POSTPEER_KEY: string) {
  const id = account.postpeer_account_id
  const ACCOUNT_CACHE_KEY = `account:${id}:${today}`

  // 1) Already have a real (non-placeholder) result for today? Use it.
  const { data: cachedAccount, error: readError } = await supabase
    .from('analytics_cache')
    .select('payload')
    .eq('cache_key', ACCOUNT_CACHE_KEY)
    .maybeSingle()
  if (readError) console.log(`[token-audit] cache READ failed for ${ACCOUNT_CACHE_KEY}:`, readError.message)

  if (cachedAccount?.payload && cachedAccount.payload.__pending !== true) {
    return cachedAccount.payload
  }

  // 2) Atomically CLAIM this account before calling PostPeer so a concurrent
  // request can't duplicate the call. A plain insert fails if someone else
  // claimed it first, since cache_key is unique.
  const { error: claimError } = await supabase
    .from('analytics_cache')
    .insert({ cache_key: ACCOUNT_CACHE_KEY, payload: { __pending: true }, fetched_at: new Date().toISOString() })

  if (claimError) {
    console.log(`[token-audit] claim not taken for ${ACCOUNT_CACHE_KEY} (${claimError.code}): ${claimError.message}`)
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 300))
      const { data: retry } = await supabase
        .from('analytics_cache')
        .select('payload')
        .eq('cache_key', ACCOUNT_CACHE_KEY)
        .maybeSingle()
      if (retry?.payload && retry.payload.__pending !== true) return retry.payload
    }
    console.log(`[token-audit] Gave up waiting on concurrent fetch — account ${id}`)
  } else {
    console.log(`[token-audit] CACHE MISS — calling PostPeer for account ${id} (${account.platform})`)
  }

  // 3) Call PostPeer.
  const url = `https://api.postpeer.dev/v1/analytics?source=platform&accountId=${id}&platform=${account.platform}&limit=50`
  let data: any
  try {
    const res = await fetchWithTimeout(url, { headers: { 'x-access-key': POSTPEER_KEY } }, 20000)
    data = await res.json()
  } catch (e) {
    data = { success: false, error: String(e) }
  }

  // 4) Success: save today's copy AND the rolling "latest" snapshot.
  if (data?.success) {
    const now = new Date().toISOString()
    const { error: saveError } = await supabase.from('analytics_cache').upsert([
      { cache_key: ACCOUNT_CACHE_KEY, payload: data, fetched_at: now },
      { cache_key: `account:${id}:latest`, payload: data, fetched_at: now },
    ], { onConflict: 'cache_key' })
    if (saveError) console.log(`[token-audit] cache SAVE failed for ${ACCOUNT_CACHE_KEY}:`, saveError.message)
    return data
  }

  // 5) Failure (credits expired, timeout, etc.): release the claim so a
  // retry works after renewal, and serve the last good data instead.
  // Stale data is NOT written to today's key, so fresh data returns
  // as soon as PostPeer works again.
  await supabase
    .from('analytics_cache')
    .delete()
    .eq('cache_key', ACCOUNT_CACHE_KEY)
    .eq('payload->>__pending', 'true')

  console.log(`[token-audit] PostPeer failed for ${id} (${account.platform}), using last good data:`, JSON.stringify(data).slice(0, 300))
  const lastGood = await getLastGoodAccountData(supabase, account)
  return lastGood ?? data
}

// ── Handler ─────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const t0 = Date.now()
  const authHeader = req.headers.get('Authorization')!
  const SUPABASE_SECRET_KEYS = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')!)

  // Acts AS the signed-in user (row-level security applies) — used to find
  // out who is calling and to check they are an admin.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    SUPABASE_SECRET_KEYS['default'],
    { global: { headers: { Authorization: authHeader } } }
  )

  // Secret key only, no user token — for the shared cache tables
  // (analytics_cache, resolved_urls). With the user's token attached, row-level
  // security silently blocked every cache read/write, so nothing was ever
  // saved and every page load paid PostPeer again for every account.
  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    SUPABASE_SECRET_KEYS['default'],
    { auth: { persistSession: false, autoRefreshToken: false } }
  )

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders })
  }

  const { data: callerProfile } = await supabase
    .from('profiles')
    .select('role, country')
    .eq('id', user.id)
    .maybeSingle()

  if (!callerProfile || (callerProfile.role !== 'admin' && callerProfile.role !== 'superadmin')) {
    console.log('Non-admin tried to access all-analytics:', user.id)
    return jsonResponse({ error: 'Forbidden' }, 403)
  }

  // ── Country scoping ──────────────────────────────────────────────
  // A country-scoped admin is ALWAYS locked to that country, enforced
  // server-side so it can't be bypassed from the URL. A superadmin
  // (country is null) may request 'all', 'uganda' or 'kenya'.
  const reqUrl = new URL(req.url)
  const requestedCountry = (reqUrl.searchParams.get('country') || 'all').toLowerCase()
  const effectiveCountry = callerProfile.country || requestedCountry

  const emptyBody = {
    mothers: [], allPosts: [], summary: emptySummary(),
    country: effectiveCountry, stale: false, lastUpdated: null,
  }

  const { data: accountsRaw, error: accountsError } = await supabase
    .from('social_accounts')
    .select('user_id, platform, postpeer_account_id')

  if (accountsError || !accountsRaw || accountsRaw.length === 0) {
    return jsonResponse(emptyBody)
  }

  let accounts = accountsRaw
  if (effectiveCountry !== 'all') {
    const { data: countryMothers } = await supabase
      .from('profiles')
      .select('id')
      .eq('role', 'mother')
      .eq('country', effectiveCountry)
    const allowedIds = new Set((countryMothers || []).map((p: any) => p.id))
    accounts = accountsRaw.filter((a: any) => allowedIds.has(a.user_id))
  }

  if (accounts.length === 0) {
    return jsonResponse(emptyBody)
  }

  const today = new Date().toISOString().split('T')[0]
  const CACHE_KEY = `admin:all:${effectiveCountry}:${today}`

  // Today's fresh result already built? Serve it.
  const { data: cached } = await db
    .from('analytics_cache')
    .select('payload')
    .eq('cache_key', CACHE_KEY)
    .maybeSingle()

  if (cached) {
    console.log(`Serving today's cached admin analytics for ${CACHE_KEY} (${Date.now() - t0}ms)`)
    return jsonResponse(cached.payload)
  }

  const userIds = [...new Set(accounts.map((a: any) => a.user_id))]
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, full_name, email, country')
    .in('id', userIds)

  const profileMap = Object.fromEntries((profiles || []).map((p: any) => [p.id, p]))

  // ── Submitted content ────────────────────────────────────────────
  // Paged, because a plain select caps at 1,000 rows and silently drops
  // whoever falls past the limit.
  const allSubmitted: any[] = []
  for (const part of chunk(userIds, 100)) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('submitted_content')
        .select('user_id, video_url')
        .in('user_id', part)
        .range(from, from + 999)
      if (error || !data || data.length === 0) break
      allSubmitted.push(...data)
      if (data.length < 1000) break
    }
  }
  console.log(`[perf] ${allSubmitted.length} submitted rows loaded (${Date.now() - t0}ms)`)

  const resolvedMap = await resolveAllUrls(db, allSubmitted.map(s => s.video_url))
  console.log(`[perf] URLs resolved (${Date.now() - t0}ms)`)

  // A video ID from one mother must not count toward another's totals.
  const submittedIdsByUser: Record<string, Set<string>> = {}
  for (const s of allSubmitted) {
    const resolved = resolvedMap.get(s.video_url) || s.video_url
    const id = extractPostId(resolved)
    if (!submittedIdsByUser[s.user_id]) submittedIdsByUser[s.user_id] = new Set()
    submittedIdsByUser[s.user_id].add(id)
  }

  // ── PostPeer, in parallel ────────────────────────────────────────
  const POSTPEER_KEY = Deno.env.get('POSTPEER_API_KEY')!
  const accountResults = await pMap(accounts, 6, (account: any) =>
    getAccountAnalytics(db, account, today, POSTPEER_KEY)
  )
  console.log(`[perf] ${accounts.length} accounts fetched (${Date.now() - t0}ms)`)

  // Were any accounts served from older data?
  const staleResults = accountResults.filter((d: any) => d?.__stale)
  const usedStale = staleResults.length > 0
  const lastUpdated: string | null = usedStale
    ? staleResults.map((d: any) => d.__asOf).sort()[0]
    : null

  const perMother: Record<string, any> = {}
  const allPosts: any[] = []
  let postpeerFailed = false

  accounts.forEach((account: any, idx: number) => {
    const data = accountResults[idx]

    if (!perMother[account.user_id]) {
      perMother[account.user_id] = {
        userId: account.user_id,
        name: profileMap[account.user_id]?.full_name || 'Unknown',
        email: profileMap[account.user_id]?.email || '',
        country: profileMap[account.user_id]?.country || null,
        totalViews: 0,
        totalEngagements: 0,
        totalPosts: 0,
        platforms: {},
      }
    }

    if (data?.success && data.posts) {
      const submittedIds = submittedIdsByUser[account.user_id] || new Set()

      for (const post of data.posts) {
        const postUrl = post.platforms?.[0]?.platformPostUrl ?? null
        const postId = extractPostId(postUrl)

        // Skip anything the mother didn't submit — same rule as her own dashboard
        if (!submittedIds.has(postId)) continue

        // Instagram often returns null for views (Insights access may not be
        // granted) — keep null distinct from a genuine zero.
        const views = post.aggregated?.views ?? null
        const likes = post.aggregated?.likes ?? 0
        const comments = post.aggregated?.comments ?? 0
        const shares = post.aggregated?.shares ?? 0
        const engagement = likes + comments + shares

        perMother[account.user_id].totalViews += views ?? 0
        perMother[account.user_id].totalEngagements += engagement
        perMother[account.user_id].totalPosts += 1
        perMother[account.user_id].platforms[account.platform] =
          (perMother[account.user_id].platforms[account.platform] || 0) + (views ?? 0)

        allPosts.push({
          userId: account.user_id,
          motherName: profileMap[account.user_id]?.full_name || 'Unknown',
          country: profileMap[account.user_id]?.country || null,
          platform: account.platform,
          content: post.content,
          publishedAt: post.publishedAt,
          views,
          likes,
          comments,
          shares,
          engagement,
          url: postUrl,
        })
      }
    } else {
      console.log(`PostPeer call failed for account ${account.postpeer_account_id} (${account.platform}) and no earlier data exists`)
      postpeerFailed = true
    }
  })

  const mothers = Object.values(perMother).sort((a: any, b: any) => b.totalViews - a.totalViews)

  const summary = mothers.reduce((acc: any, m: any) => {
    acc.totalViews += m.totalViews
    acc.totalEngagements += m.totalEngagements
    acc.totalPosts += m.totalPosts
    return acc
  }, { totalViews: 0, totalEngagements: 0, totalPosts: 0, totalMothers: mothers.length })

  console.log('Admin analytics summary:', JSON.stringify(summary), 'country:', effectiveCountry,
    `stale: ${usedStale}`, `total ${Date.now() - t0}ms`)

  const responseBody = { mothers, allPosts, summary, country: effectiveCountry, stale: usedStale, lastUpdated }

  // Only cache genuinely fresh results as "today's". Stale results are
  // never locked in, so live numbers come back right after renewal.
  if (!usedStale && (!postpeerFailed || summary.totalPosts > 0)) {
    const { error: saveError } = await db
      .from('analytics_cache')
      .upsert({ cache_key: CACHE_KEY, payload: responseBody, fetched_at: new Date().toISOString() }, { onConflict: 'cache_key' })
    if (saveError) console.log(`[token-audit] cache SAVE failed for ${CACHE_KEY}:`, saveError.message)
  }

  return jsonResponse(responseBody)
})
