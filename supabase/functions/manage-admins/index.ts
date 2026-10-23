// supabase/functions/manage-admins/index.ts
//
// Superadmin-only management of admin accounts (Settings → Team).
//
//   POST { action: 'invite',      email, country, full_name? }
//        → new person: creates the account and returns a one-time invite link
//          (send it yourself); they open it, set a password, and are an admin
//          of that country.
//        → existing account (e.g. signed up as a mother): made an admin of
//          that country straight away.
//   POST { action: 'set_country', userId, country }  → move an admin
//   POST { action: 'revoke',      userId }           → admin back to a normal account
//
// Only a signed-in superadmin may call it. The secret key never leaves the server.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

const COUNTRIES = ['uganda', 'kenya']
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Where the invite link lands: the app's own set-password page, on the site
// the superadmin is using (live site or local testing only).
function redirectFor(req: Request) {
  const origin = req.headers.get('origin') || ''
  const allowed = /^https:\/\/(www\.)?lumio\.ug$/.test(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin)
  return `${allowed ? origin : 'https://lumio.ug'}/reset-password.html`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const SECRET = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')!)['default']
  const URL_ = Deno.env.get('SUPABASE_URL')!

  // Acts as the caller — only used to find out who they are.
  const asCaller = createClient(URL_, SECRET, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
  // Secret key only — for the account changes themselves.
  const db = createClient(URL_, SECRET, { auth: { persistSession: false, autoRefreshToken: false } })

  const { data: { user } } = await asCaller.auth.getUser()
  if (!user) return json({ error: 'Please sign in again.' }, 401)

  const { data: me } = await db.from('profiles').select('role').eq('id', user.id).maybeSingle()
  if (me?.role !== 'superadmin') {
    console.log('[manage-admins] refused non-superadmin', user.id)
    return json({ error: 'Only the superadmin can manage admins.' }, 403)
  }

  let body: any
  try { body = await req.json() } catch { return json({ error: 'Invalid request.' }, 400) }
  const action = body?.action

  // ── invite / promote ──────────────────────────────────────────────────
  if (action === 'invite') {
    const email = String(body.email || '').trim().toLowerCase()
    const country = String(body.country || '').toLowerCase()
    const fullName = String(body.full_name || '').trim() || null
    if (!EMAIL_RE.test(email)) return json({ error: 'Please enter a valid email address.' }, 400)
    if (!COUNTRIES.includes(country)) return json({ error: 'Please choose Uganda or Kenya.' }, 400)

    // Already has an account? Promote it.
    const { data: existing } = await db.from('profiles')
      .select('id, role').ilike('email', email).maybeSingle()
    if (existing) {
      if (existing.role === 'superadmin') return json({ error: 'That person is the superadmin.' }, 400)
      const { error } = await db.from('profiles').update({ role: 'admin', country }).eq('id', existing.id)
      if (error) { console.log('[manage-admins] promote failed', error.message); return json({ error: 'Could not update that account.' }, 500) }
      console.log(`[manage-admins] ${user.id} promoted ${existing.id} to admin (${country})`)
      return json({ status: 'promoted', userId: existing.id })
    }

    // New person: create the account and a one-time invite link.
    const { data: link, error: linkError } = await db.auth.admin.generateLink({
      type: 'invite',
      email,
      options: { redirectTo: redirectFor(req), data: fullName ? { full_name: fullName } : {} },
    })
    if (linkError || !link?.user) {
      console.log('[manage-admins] invite failed', linkError?.message)
      return json({ error: linkError?.message || 'Could not create the invitation.' }, 500)
    }
    const newId = link.user.id

    // Make sure the profile exists (signup trigger may already have made it),
    // then make it an admin of the chosen country.
    await db.from('profiles')
      .upsert({ id: newId, email, full_name: fullName }, { onConflict: 'id', ignoreDuplicates: true })
    const { error: roleError } = await db.from('profiles')
      .update({ role: 'admin', country, ...(fullName ? { full_name: fullName } : {}) })
      .eq('id', newId)
    if (roleError) {
      console.log('[manage-admins] could not set admin role', roleError.message)
      return json({ error: 'Account created, but could not make it an admin: ' + roleError.message }, 500)
    }

    console.log(`[manage-admins] ${user.id} invited ${newId} as admin (${country})`)
    return json({ status: 'invited', userId: newId, link: link.properties?.action_link ?? null })
  }

  // ── change an admin's country / revoke admin access ───────────────────
  if (action === 'set_country' || action === 'revoke') {
    const targetId = String(body.userId || '')
    if (!targetId) return json({ error: 'Missing account.' }, 400)
    if (targetId === user.id) return json({ error: 'You cannot change your own access here.' }, 400)

    const { data: target } = await db.from('profiles').select('role').eq('id', targetId).maybeSingle()
    if (!target || target.role !== 'admin') return json({ error: 'That account is not an admin.' }, 400)

    if (action === 'set_country') {
      const country = String(body.country || '').toLowerCase()
      if (!COUNTRIES.includes(country)) return json({ error: 'Please choose Uganda or Kenya.' }, 400)
      const { error } = await db.from('profiles').update({ country }).eq('id', targetId)
      if (error) return json({ error: 'Could not change the country.' }, 500)
      console.log(`[manage-admins] ${user.id} moved admin ${targetId} to ${country}`)
      return json({ status: 'updated' })
    }

    const { error } = await db.from('profiles').update({ role: 'mother' }).eq('id', targetId)
    if (error) return json({ error: 'Could not remove admin access.' }, 500)
    console.log(`[manage-admins] ${user.id} revoked admin ${targetId}`)
    return json({ status: 'revoked' })
  }

  return json({ error: 'Unknown action.' }, 400)
})
