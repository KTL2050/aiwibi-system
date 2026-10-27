// supabase/functions/idea-trends/index.ts
//
// Runs once a week (Supabase Cron). For each country, Claude searches the web
// for what's working right now in short baby / motherhood / diaper videos on
// TikTok and Instagram Reels, and the summary is saved in idea_trend_briefs.
// The idea-assistant function reads the latest brief when writing scripts, so
// mothers' requests never pay for a web search themselves.
//
// Only the schedule may call it: it requires the x-cron-secret header to match
// the SNAPSHOT_CRON_SECRET function secret (same secret as daily-snapshot).
// It answers straight away and does the work in the background, so the cron
// call doesn't time out.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk@0.110.0'

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void }

const COUNTRIES: Record<string, { name: string; code: string }> = {
  uganda: { name: 'Uganda', code: 'UG' },
  kenya: { name: 'Kenya', code: 'KE' },
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const SYSTEM = `You research short-video trends for Aiwibi, a baby-care brand whose community of mothers posts TikTok and Instagram Reels videos.

Use web search to find what is getting the most views right now in short videos about babies, motherhood, baby care and baby products (especially diapers, wipes, baby lotion). Look at the global picture and at the given country specifically.

Write a brief that a scriptwriter will use next week. Plain text, these sections:
1. Formats that are working (for each: what it looks like, why it works, a typical length)
2. Hooks: 8-12 opening lines or first-3-second moments that grab attention
3. Trending sounds, challenges or hashtags worth using (say which platform)
4. What is working in the given country specifically (local language mixes, humour, settings)
5. Things to avoid (unsafe baby practices, medical claims, anything platforms take down)

Be concrete and practical. Describe formats in your own words; don't copy other creators' scripts. Keep it under 900 words.`

async function writeBrief(client: Anthropic, country: string) {
  const { name, code } = COUNTRIES[country]
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: 'user', content: `Country: ${name}. Write this week's trend brief.` },
  ]

  let response: Anthropic.Beta.BetaMessage | null = null
  // A long search turn can pause; resume it a few times at most.
  for (let i = 0; i < 4; i++) {
    response = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      // deno-lint-ignore no-explicit-any
      fallbacks: 'default' as any,
      output_config: { effort: 'medium' },
      system: SYSTEM,
      tools: [{
        type: 'web_search_20260209',
        name: 'web_search',
        max_uses: 8,
        user_location: { type: 'approximate', country: code },
      // deno-lint-ignore no-explicit-any
      } as any],
      messages,
    })
    if (response.stop_reason !== 'pause_turn') break
    messages.push({ role: 'assistant', content: response.content })
  }

  if (!response || response.stop_reason === 'refusal') {
    throw new Error(`No brief for ${country}: ${response?.stop_reason ?? 'no response'}`)
  }

  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim()

  // The pages it read, for reference.
  const sources: { url: string; title: string }[] = []
  for (const block of response.content) {
    // deno-lint-ignore no-explicit-any
    const b = block as any
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const r of b.content) if (r.url) sources.push({ url: r.url, title: r.title ?? '' })
    }
  }

  console.log(`[idea-trends] ${country}: ${text.length} chars, ${sources.length} sources, usage`, JSON.stringify(response.usage))
  return { brief: text, sources }
}

Deno.serve(async (req) => {
  const expected = Deno.env.get('SNAPSHOT_CRON_SECRET')
  if (!expected || req.headers.get('x-cron-secret') !== expected) {
    return json({ error: 'Not allowed' }, 401)
  }

  const SECRET = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')!)['default']
  const db = createClient(Deno.env.get('SUPABASE_URL')!, SECRET, { auth: { persistSession: false, autoRefreshToken: false } })
  const client = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') })

  const work = Promise.all(Object.keys(COUNTRIES).map(async (country) => {
    try {
      const { brief, sources } = await writeBrief(client, country)
      if (!brief) throw new Error('empty brief')
      const { error } = await db.from('idea_trend_briefs').insert({ country, brief, sources })
      if (error) throw new Error('save failed: ' + error.message)
      console.log(`[idea-trends] saved brief for ${country}`)
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) console.log(`[idea-trends] ${country}: rate limited`)
      else if (e instanceof Anthropic.APIError) console.log(`[idea-trends] ${country}: API error ${e.status}: ${e.message}`)
      else console.log(`[idea-trends] ${country}: failed:`, (e as Error).message)
    }
  }))

  EdgeRuntime.waitUntil(work)
  return json({ status: 'started', countries: Object.keys(COUNTRIES) }, 202)
})
