// supabase/functions/oembed-preview/index.ts
import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

async function persistThumbnail(supabase: any, remoteUrl: string | null, ownerId: string): Promise<string | null> {
  if (!remoteUrl) return null
  try {
    const imgRes = await fetch(remoteUrl)
    if (!imgRes.ok) throw new Error(`Fetch failed: ${imgRes.status}`)
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg'
    const ext = contentType.includes('png') ? 'png' : 'jpg'
    const bytes = new Uint8Array(await imgRes.arrayBuffer())
    const path = `${ownerId}/${crypto.randomUUID()}.${ext}`

    const { error: uploadErr } = await supabase.storage
      .from('content-thumbnails')
      .upload(path, bytes, { contentType, upsert: false })
    if (uploadErr) throw uploadErr

    const { data: pub } = supabase.storage.from('content-thumbnails').getPublicUrl(path)
    return pub.publicUrl
  } catch (e) {
    console.log('Thumbnail persist failed, falling back to remote URL:', e.message)
    return remoteUrl
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const { url, platform } = await req.json()
  if (!url || !platform) {
    return new Response(JSON.stringify({ error: 'Missing url or platform' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  try {
    if (platform === 'tiktok') {
      const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`)
      if (!res.ok) throw new Error(`TikTok oEmbed returned ${res.status}`)
      const data = await res.json()

      const authHeaderTT = req.headers.get('Authorization')!
      const SECRET_KEYS_TT = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')!)
      const supabaseTT = createClient(
        Deno.env.get('SUPABASE_URL')!,
        SECRET_KEYS_TT['default'],
        { global: { headers: { Authorization: authHeaderTT } } }
      )
      const { data: { user: ttUser } } = await supabaseTT.auth.getUser()
      const hostedThumbTT = await persistThumbnail(supabaseTT, data.thumbnail_url ?? null, ttUser?.id ?? 'anon')

      return new Response(JSON.stringify({
        success: true,
        thumbnail_url: hostedThumbTT,
        author_name: data.author_name ?? null,
        caption: data.title ?? null,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

   if (platform === 'instagram') {
      const authHeader = req.headers.get('Authorization')!
      const SUPABASE_SECRET_KEYS = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')!)

      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        SUPABASE_SECRET_KEYS['default'],
        { global: { headers: { Authorization: authHeader } } }
      )

      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Not authenticated')

      const { data: account, error: acctErr } = await supabase
        .from('social_accounts')
        .select('postpeer_account_id')
        .eq('user_id', user.id)
        .eq('platform', 'instagram')
        .single()

      if (acctErr || !account) throw new Error('No connected Instagram account found for this user')

      function extractIgId(u: string | null): string {
        if (!u) return ''
        const igMatch = u.match(/\/(p|reels?)\/([A-Za-z0-9_-]+)/)
        const raw = igMatch ? igMatch[2] : u.split('?')[0].replace(/\/$/, '')
        return raw.toLowerCase()
      }

      const targetId = extractIgId(url)
      console.log('Looking for Instagram post ID:', targetId)

      const findPost = (payload: any) =>
        payload?.success && Array.isArray(payload.posts)
          ? payload.posts.find((post: any) => extractIgId(post.platforms?.[0]?.platformPostUrl) === targetId)
          : null

      // ── Reuse the shared analytics cache before spending a PostPeer credit ──
      // Same keys as postpeer-get-analytics / postpeer-get-all-analytics:
      // today's copy for this account first, then the rolling "latest" copy.
      // Only if the post isn't in either (e.g. it was published after today's
      // fetch) do we call PostPeer — and then save the result back, so the
      // dashboards reuse it instead of paying again.
      const accountId = account.postpeer_account_id
      const today = new Date().toISOString().split('T')[0]
      const todayKey = `account:${accountId}:${today}`
      const latestKey = `account:${accountId}:latest`

      // Secret key only (no user token) for the shared cache — with the user's
      // token attached, row-level security blocks reading/writing it.
      const db = createClient(
        Deno.env.get('SUPABASE_URL')!,
        SUPABASE_SECRET_KEYS['default'],
        { auth: { persistSession: false, autoRefreshToken: false } }
      )

      const { data: cachedRows, error: readError } = await db
        .from('analytics_cache')
        .select('cache_key, payload')
        .in('cache_key', [todayKey, latestKey])
      if (readError) console.log('[token-audit] cache READ failed:', readError.message)

      const cachedToday = cachedRows?.find((r: any) => r.cache_key === todayKey)?.payload
      const cachedLatest = cachedRows?.find((r: any) => r.cache_key === latestKey)?.payload
      let match = findPost(cachedToday) || findPost(cachedLatest)

      if (match) {
        console.log(`[token-audit] CACHE HIT — Instagram thumbnail from cached analytics for account ${accountId}`)
      } else {
        console.log(`[token-audit] CACHE MISS — calling PostPeer for Instagram thumbnail, account ${accountId}`)
        const POSTPEER_KEY = Deno.env.get('POSTPEER_API_KEY')!
        const analyticsUrl = `https://api.postpeer.dev/v1/analytics?source=platform&accountId=${accountId}&platform=instagram&limit=50`
        const res = await fetch(analyticsUrl, { headers: { 'x-access-key': POSTPEER_KEY } })
        const data = await res.json()

        if (!data.success || !data.posts) {
          console.log('PostPeer analytics failed:', JSON.stringify(data).slice(0, 300))
          throw new Error('Could not fetch Instagram media from PostPeer')
        }

        // Paid for — share it with the dashboards for the rest of the day.
        const now = new Date().toISOString()
        const { error: saveError } = await db.from('analytics_cache').upsert([
          { cache_key: todayKey, payload: data, fetched_at: now },
          { cache_key: latestKey, payload: data, fetched_at: now },
        ], { onConflict: 'cache_key' })
        if (saveError) console.log('[token-audit] cache SAVE failed:', saveError.message)

        console.log('Available post URLs:', JSON.stringify(data.posts.map((p: any) => p.platforms?.[0]?.platformPostUrl)))
        match = findPost(data)
      }

      if (!match) throw new Error('Could not find this post among the connected account\'s recent media')

     // TEMPORARY: log the full matched post object once so we can find the thumbnail field name
      console.log('Full matched post object:', JSON.stringify(match))

      const rawThumbIG = match.thumbnailUrl ?? match.thumbnail_url ?? match.mediaUrl ?? null
      const hostedThumbIG = await persistThumbnail(supabase, rawThumbIG, user.id)

      return new Response(JSON.stringify({
        success: true,
        thumbnail_url: hostedThumbIG,
        caption: match.content ?? null,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ error: 'Unknown platform' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } catch (err) {
    console.log('oEmbed fetch failed:', err.message)
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
