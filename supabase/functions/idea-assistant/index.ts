// supabase/functions/idea-assistant/index.ts
//
// The mother's "Idea Assistant": a short chat in which Claude asks a few
// questions (product, platform, mood, length, language) and then writes a
// ready-to-film script, based on this week's trend brief (idea-trends) and the
// most-viewed Lumio videos in her country (from the shared analytics cache —
// no PostPeer credits).
//
//   POST { action: 'start' }            → new conversation (counts toward 3 a day)
//   POST { action: 'reply', id, text }  → her answer; returns the next question
//                                         or the finished script
//
// Every reply is { kind: 'question' | 'script' | 'off_topic', message, choices, script }.
// Conversations are saved in idea_scripts; only this function writes them.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk@0.110.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

const DAILY_LIMIT = 3
const WRAP_UP_AFTER = 6       // her answers; after this, write the script with what we have
const MAX_ANSWER_CHARS = 500
const COUNTRY_NAMES: Record<string, string> = { uganda: 'Uganda', kenya: 'Kenya' }

// Start of "today" in East Africa Time (UTC+3), the day the 3-a-day limit counts.
function startOfTodayEAT() {
  const eat = new Date(Date.now() + 3 * 3600_000)
  eat.setUTCHours(0, 0, 0, 0)
  return new Date(eat.getTime() - 3 * 3600_000).toISOString()
}

const REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'message', 'choices', 'script'],
  properties: {
    kind: { type: 'string', enum: ['question', 'script', 'off_topic'] },
    message: { type: 'string' },
    choices: { type: 'array', items: { type: 'string' } },
    script: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'platform', 'language', 'length_seconds', 'hook', 'scenes', 'caption', 'hashtags', 'tips'],
      properties: {
        title: { type: 'string' },
        platform: { type: 'string' },
        language: { type: 'string' },
        length_seconds: { type: 'integer' },
        hook: { type: 'string' },
        scenes: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['time', 'shot', 'say'],
            properties: {
              time: { type: 'string' },
              shot: { type: 'string' },
              say: { type: 'string' },
            },
          },
        },
        caption: { type: 'string' },
        hashtags: { type: 'array', items: { type: 'string' } },
        tips: { type: 'array', items: { type: 'string' } },
      },
    },
  },
}

const INSTRUCTIONS = `You are the Idea Assistant inside Lumio, the community app of Aiwibi, a baby-care brand. You help mothers plan short videos for TikTok and Instagram Reels about their babies, motherhood and baby products, then write a script they can film at home with a phone.

How the chat goes:
- Ask ONE short, friendly question at a time, and offer 2-5 tap-able answers in "choices".
- You need: the product or topic she wants to feature (she types it, so leave "choices" empty for that question, or give a few examples), the platform (TikTok or Instagram Reels), the mood or style (e.g. funny, emotional, tutorial, day-in-my-life), the length, and the language (English, Luganda, Swahili, or a mix).
- Skip anything she has already told you. Ask at most 5 questions, then write the script.
- If she asks for something unrelated to baby/mum videos, reply with kind "off_topic" and a short, kind message bringing her back.

The script:
- A hook for the first 3 seconds that stops the scroll.
- Scenes she can film easily at home: for each, the time range, what to film, and what to say, in her chosen language (natural, the way mothers really talk; mixes like English + Luganda are fine).
- Feature her product naturally, not like an advert. No medical claims; no unsafe baby practices (e.g. unsafe sleep positions, leaving the baby alone on a high surface).
- A caption in the same language and 5-8 hashtags mixing popular and niche ones.
- 2-4 quick filming tips.
- Base the format and hook on the trend brief and the top Lumio videos below: adapt what works, never copy anyone's words.

Always answer in the JSON format. When kind is "question" or "off_topic", fill "script" with empty strings, empty lists and 0. When kind is "script", "message" is one short encouraging line and "choices" is empty.`

async function buildContext(db: any, country: string | null, firstName: string) {
  const c = country && COUNTRY_NAMES[country] ? country : 'uganda'

  const { data: brief } = await db.from('idea_trend_briefs')
    .select('brief, created_at').eq('country', c)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()

  // Most-viewed Lumio videos in her country, from the latest shared dashboard cache.
  const { data: cached } = await db.from('analytics_cache')
    .select('payload').like('cache_key', `admin:all:${c}:%`)
    .order('fetched_at', { ascending: false }).limit(1).maybeSingle()
  const posts = (cached?.payload?.allPosts ?? []) as any[]
  const top = posts
    .filter(p => p.content)
    .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
    .slice(0, 10)
    .map((p, i) => `${i + 1}. ${p.platform}, ${p.views ?? 0} views, ${p.likes ?? 0} likes: "${String(p.content).replace(/\s+/g, ' ').slice(0, 220)}"`)
    .join('\n')

  return `Mother: ${firstName || 'a Lumio mother'}, in ${COUNTRY_NAMES[c]}.

This week's trend brief:
${brief?.brief ?? '(No brief yet — rely on what generally works in baby and mum videos.)'}

Most-viewed Lumio videos in ${COUNTRY_NAMES[c]} (captions):
${top || '(None yet.)'}`
}

function parseReply(response: Anthropic.Beta.BetaMessage) {
  if (response.stop_reason === 'refusal') {
    return { kind: 'off_topic', message: "Sorry, I can't help with that one. Let's plan a baby or mum video instead!", choices: [], script: null }
  }
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map(b => b.text).join('')
  const reply = JSON.parse(text)
  if (reply.kind !== 'script') reply.script = null
  return reply
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const SECRET = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')!)['default']
  const URL_ = Deno.env.get('SUPABASE_URL')!
  // Acts as the caller — only used to find out who she is.
  const asCaller = createClient(URL_, SECRET, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
  // Secret key only — for reads/writes (row-level security would block them otherwise).
  const db = createClient(URL_, SECRET, { auth: { persistSession: false, autoRefreshToken: false } })

  const { data: { user } } = await asCaller.auth.getUser()
  if (!user) return json({ error: 'Please sign in again.' }, 401)

  let body: any
  try { body = await req.json() } catch { return json({ error: 'Invalid request.' }, 400) }

  const { data: profile } = await db.from('profiles')
    .select('full_name, country').eq('id', user.id).maybeSingle()
  const firstName = String(profile?.full_name || '').trim().split(/\s+/)[0] || ''

  const { count: usedToday } = await db.from('idea_scripts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id).gte('created_at', startOfTodayEAT())

  let row: any
  if (body?.action === 'start') {
    if ((usedToday ?? 0) >= DAILY_LIMIT) {
      return json({ error: `You've used your ${DAILY_LIMIT} video ideas for today. Come back tomorrow!`, remaining: 0 }, 429)
    }
    const { data, error } = await db.from('idea_scripts')
      .insert({ user_id: user.id, country: profile?.country ?? null, messages: [{ role: 'user', content: 'Hi! I need a video idea.' }] })
      .select().single()
    if (error) { console.log('[idea-assistant] create failed', error.message); return json({ error: 'Could not start. Please try again.' }, 500) }
    row = data
  } else if (body?.action === 'reply') {
    const text = String(body.text || '').trim().slice(0, MAX_ANSWER_CHARS)
    if (!text) return json({ error: 'Please type an answer.' }, 400)
    const { data } = await db.from('idea_scripts')
      .select('*').eq('id', body.id).eq('user_id', user.id).maybeSingle()
    if (!data) return json({ error: 'That chat was not found. Start a new one.' }, 404)
    if (data.status === 'done') return json({ error: 'This script is finished. Start a new idea.' }, 400)
    row = { ...data, messages: [...data.messages, { role: 'user', content: text }] }
  } else {
    return json({ error: 'Unknown action.' }, 400)
  }

  const answers = row.messages.filter((m: any) => m.role === 'user').length - 1
  const messages: any[] = [...row.messages]
  if (answers >= WRAP_UP_AFTER) {
    messages.push({ role: 'system', content: 'Write the script now with what you know; make sensible choices for anything missing.' })
  }

  let reply: any
  let response: Anthropic.Beta.BetaMessage
  try {
    const context = await buildContext(db, row.country, firstName)
    response = await new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') }).beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      // deno-lint-ignore no-explicit-any
      fallbacks: 'default' as any,
      // deno-lint-ignore no-explicit-any
      cache_control: { type: 'ephemeral' } as any,
      output_config: {
        effort: 'medium',
        // deno-lint-ignore no-explicit-any
        format: { type: 'json_schema', schema: REPLY_SCHEMA } as any,
      },
      system: [
        { type: 'text', text: INSTRUCTIONS },
        { type: 'text', text: context },
      ],
      messages,
    })
    reply = parseReply(response)
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) console.log('[idea-assistant] rate limited')
    else if (e instanceof Anthropic.APIError) console.log(`[idea-assistant] API error ${e.status}: ${e.message}`)
    else console.log('[idea-assistant] failed:', (e as Error).message)
    // A new chat that never got going shouldn't use up one of her 3.
    if (body.action === 'start') await db.from('idea_scripts').delete().eq('id', row.id)
    return json({ error: 'The assistant is busy right now. Please try again in a minute.' }, 502)
  }

  const done = reply.kind === 'script'
  const { error: saveError } = await db.from('idea_scripts').update({
    messages: [...row.messages, { role: 'assistant', content: response.content }],
    ...(done ? { status: 'done', script: reply.script, completed_at: new Date().toISOString() } : {}),
  }).eq('id', row.id)
  if (saveError) console.log('[idea-assistant] save failed', saveError.message)

  console.log(`[idea-assistant] ${user.id} chat ${row.id}: ${reply.kind}, usage`, JSON.stringify(response.usage))
  const used = (usedToday ?? 0) + (body.action === 'start' ? 1 : 0)
  return json({ id: row.id, reply, remaining: Math.max(0, DAILY_LIMIT - used) })
})
