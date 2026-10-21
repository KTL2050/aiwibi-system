// supabase/functions/postpeer-get-analytics/index.ts
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
  return { totalViews: 0, totalEngagements: 0, totalPosts: 0 }
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
    console.log(`[token-audit] CACHE HIT — no PostPeer call for account ${id} (${account.platform})`)
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
      if (retry?.payload && retry.payload.__pending !== true) {
        console.log(`[token-audit] CACHE HIT (waited on concurrent fetch) — account ${id} (${account.platform})`)
        return retry.payload
      }
    }
    console.log(`[token-audit] Gave up waiting on concurrent fetch, fetching anyway — account ${id} (${account.platform})`)
  } else {
    console.log(`[token-audit] CACHE MISS — calling PostPeer for account ${id} (${account.platform})`)
  }

  // 3) Call PostPeer.
  const url = `https://api.postpeer.dev/v1/analytics?source=platform&accountId=${id}&platform=${account.platform}&limit=50`
  let data: any
  try {
    const res = await fetch(url, {
      headers: { 'x-access-key': POSTPEER_KEY },
      signal: AbortSignal.timeout(20000),
    })
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

// ── URL helpers ─────────────────────────────────────────────────
// TikTok posts can be videos (/video/<id>) OR photo slideshows
// (/photo/<id>) — both carry the same kind of numeric ID.
function extractPostId(u: string | null) {
  if (!u) return ''
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

// Short links (vt.tiktok.com / vm.tiktok.com) don't carry the post ID —
// follow the redirect to the canonical URL. A resolved link never changes,
// so successful resolutions are stored in `resolved_urls` (the same table
// the admin function uses) and never looked up again. A resolution that
// does NOT land on a real post URL is treated as a failure and not cached.
async function resolveShortUrl(supabase: any, u: string) {
  if (!u || isCanonical(u)) return u

  const { data: hit } = await supabase
    .from('resolved_urls')
    .select('resolved_url')
    .eq('raw_url', u)
    .maybeSingle()
  if (hit?.resolved_url && isCanonical(hit.resolved_url)) return hit.resolved_url

  try {
    // GET with a browser User-Agent: TikTok often answers bare HEAD
    // requests from servers with a redirect to its homepage instead.
    const res = await fetch(u, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(8000),
    })
    await res.body?.cancel()
    const finalUrl = res.url || u

    if (isCanonical(finalUrl)) {
      const { error: saveError } = await supabase
        .from('resolved_urls')
        .upsert({ raw_url: u, resolved_url: finalUrl, resolved_at: new Date().toISOString() }, { onConflict: 'raw_url' })
      if (saveError) console.log('[resolve] save failed:', saveError.message)
      return finalUrl
    }
    console.log('[resolve] short URL did not land on a post URL:', u, '→', finalUrl)
  } catch (e) {
    console.log('[resolve] failed to resolve short URL:', u, String(e))
  }
  return u
}

// ── Handler ─────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const authHeader = req.headers.get('Authorization')!
  const SUPABASE_SECRET_KEYS = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')!)

  // Acts AS the signed-in user (row-level security applies) — used to find
  // out who is calling and to read their own rows.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    SUPABASE_SECRET_KEYS['default'],
    { global: { headers: { Authorization: authHeader } } }
  )

  // Secret key only, no user token — for the shared cache tables
  // (analytics_cache, resolved_urls). With the user's token attached, row-level
  // security silently blocked every cache read/write, so nothing was ever
  // saved and every page load paid PostPeer again.
  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    SUPABASE_SECRET_KEYS['default'],
    { auth: { persistSession: false, autoRefreshToken: false } }
  )

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders })
  }

  const { data: accounts, error } = await supabase
    .from('social_accounts')
    .select('platform, postpeer_account_id')
    .eq('user_id', user.id)

  if (error || !accounts || accounts.length === 0) {
    return jsonResponse({ posts: [], platforms: [], summary: emptySummary(), stale: false, lastUpdated: null })
  }

  const today = new Date().toISOString().split('T')[0] // e.g. '2026-07-21'
  const CACHE_KEY = `user:${user.id}:${today}`

  // Today's fresh result already built? Serve it.
  const { data: cached } = await db
    .from('analytics_cache')
    .select('payload')
    .eq('cache_key', CACHE_KEY)
    .maybeSingle()

  if (cached) {
    console.log(`Serving today's cached analytics for ${CACHE_KEY}`)
    return jsonResponse(cached.payload)
  }

  const POSTPEER_KEY = Deno.env.get('POSTPEER_API_KEY')!
  const allPosts: any[] = []
  let postpeerFailed = false
  let usedStale = false
  let lastUpdated: string | null = null

  for (const account of accounts) {
    const data = await getAccountAnalytics(db, account, today, POSTPEER_KEY)

    console.log(`Analytics for ${account.platform}:`, JSON.stringify(data).slice(0, 500))

    if (data?.__stale) {
      usedStale = true
      if (!lastUpdated || data.__asOf < lastUpdated) lastUpdated = data.__asOf
    }

    if (data?.success && data.posts) {
      for (const post of data.posts) {
        allPosts.push({
          platform: account.platform,
          content: post.content,
          publishedAt: post.publishedAt,
          views: post.aggregated?.views ?? 0,
          likes: post.aggregated?.likes ?? 0,
          comments: post.aggregated?.comments ?? 0,
          shares: post.aggregated?.shares ?? 0,
          url: post.platforms?.[0]?.platformPostUrl ?? null,
        })
      }
    } else {
      console.log(`PostPeer call failed for ${account.platform} and no earlier data exists:`, JSON.stringify(data).slice(0, 300))
      postpeerFailed = true
    }
  }

  // ── Only keep posts the mother actually submitted through Submit Content ──
  const { data: submitted } = await supabase
    .from('submitted_content')
    .select('video_url, platform')
    .eq('user_id', user.id)

  const submittedIds = new Set(
    await Promise.all((submitted || []).map(async (s: any) => extractPostId(await resolveShortUrl(db, s.video_url))))
  )

  console.log('Submitted IDs:', JSON.stringify([...submittedIds]))
  console.log('PostPeer post URLs:', JSON.stringify(allPosts.map(p => ({ url: p.url, id: extractPostId(p.url) }))))

  const matchedPosts = allPosts.filter(p => submittedIds.has(extractPostId(p.url)))

  // Diagnostics: submitted links that didn't match any post PostPeer returned.
  const postpeerIds = new Set(allPosts.map(p => extractPostId(p.url)))
  const unmatched = [...submittedIds].filter(id => !postpeerIds.has(id))
  if (unmatched.length) console.log('[match] submitted but NOT found in PostPeer data:', JSON.stringify(unmatched))

  // Summary totals for the dashboard cards
  const summary = matchedPosts.reduce((acc, p) => {
    acc.totalViews += p.views || 0
    acc.totalEngagements += (p.likes || 0) + (p.comments || 0) + (p.shares || 0)
    return acc
  }, { totalViews: 0, totalEngagements: 0, totalPosts: matchedPosts.length })

  const responseBody = { posts: matchedPosts, summary, stale: usedStale, lastUpdated }

  // Only cache genuinely fresh results as "today's". Stale results are
  // never locked in, so live numbers come back right after renewal.
  if (!usedStale && (!postpeerFailed || allPosts.length > 0)) {
    const { error: saveError } = await db
      .from('analytics_cache')
      .upsert({ cache_key: CACHE_KEY, payload: responseBody, fetched_at: new Date().toISOString() }, { onConflict: 'cache_key' })
    if (saveError) console.log(`[token-audit] cache SAVE failed for ${CACHE_KEY}:`, saveError.message)
  }

  return jsonResponse(responseBody)
})
