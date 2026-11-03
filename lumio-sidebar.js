/* ═══════════════════════════════════════════════════════════════════════════
   LUMIO — SIDEBAR
   The live parts of the sidebar. Its look lives in lumio-tracker.css.

     · Profile menu: tapping the name pill shows / hides Logout.
     · Mother: a points card with her balance and tier (same sums as Rewards).
     · Admin: a red count on Rewards for redemptions not yet delivered.

   Each page passes in the Supabase client it already has, so no keys live here:

       import('./lumio-sidebar.js').then(m => m.initSidebar(supabase))
   ═══════════════════════════════════════════════════════════════════════════ */

const POINTS_PER_LINK = 100;
const DEFAULT_TIERS = [
  { name: 'Bronze', min: 1000 },
  { name: 'Silver', min: 2500 },
  { name: 'Gold',   min: 5000 }
];

// Same rule as the Rewards page, so the card always matches it.
function normalizeUrl(u) {
  if (!u) return '';
  return u.split('?')[0].replace(/\/$/, '').toLowerCase();
}

function setupProfileMenu() {
  const bottom = document.querySelector('.sidebar .sidebar-bottom');
  const pill = bottom && bottom.querySelector('.user-pill');
  if (!pill || pill.querySelector('.sb-chev')) return;
  const chev = document.createElement('i');
  chev.className = 'ti ti-chevron-up sb-chev';
  pill.appendChild(chev);
  pill.addEventListener('click', () => bottom.classList.toggle('menu-open'));
}

async function loadMotherPoints(supabase, userId) {
  const [content, redemptions, tiers] = await Promise.all([
    supabase.from('submitted_content').select('video_url').eq('user_id', userId),
    supabase.from('reward_redemptions').select('points_cost').eq('user_id', userId).neq('status', 'Cancelled'),
    supabase.from('tiers').select('name, min_points').order('sort_order', { ascending: true })
  ]);
  if (content.error || redemptions.error) return;

  const links = new Set((content.data || []).map(r => normalizeUrl(r.video_url))).size;
  const spent = (redemptions.data || []).reduce((s, r) => s + (r.points_cost || 0), 0);
  const points = links * POINTS_PER_LINK - spent;

  const list = (tiers.data && tiers.data.length)
    ? tiers.data.map(t => ({ name: t.name, min: t.min_points }))
    : DEFAULT_TIERS;
  let tier = null;
  for (const t of list) if (points >= t.min) tier = t;

  const bottom = document.querySelector('.sidebar .sidebar-bottom');
  if (!bottom) return;
  let card = bottom.querySelector('.sb-points');
  if (!card) {
    card = document.createElement('a');
    card.className = 'sb-points';
    card.href = 'motherreward.html';
    bottom.insertBefore(card, bottom.firstChild);
  }
  card.innerHTML =
    '<div class="sb-points-label">Your points</div>' +
    '<div class="sb-points-value"><i class="ti ti-star"></i>' + points.toLocaleString() + ' pts' +
    (tier ? '<span class="sb-points-tier">' + tier.name + '</span>' : '') + '</div>';

  // The old level badge in the name pill is replaced by the card.
  bottom.querySelectorAll('.user-level').forEach(el => { el.style.display = 'none'; });
}

async function loadAdminPending(supabase) {
  const { data, error } = await supabase
    .from('reward_redemptions')
    .select('status')
    .neq('status', 'Cancelled');
  if (error) return;
  const pending = (data || []).filter(r => r.status !== 'Delivered').length;
  const link = document.querySelector('.sidebar a.nav-item[href="adminreward.html"]');
  if (!link) return;
  let badge = link.querySelector('.badge');
  if (!pending) { if (badge) badge.remove(); return; }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'badge';
    link.appendChild(badge);
  }
  badge.textContent = pending;
  badge.title = pending + ' redemption' + (pending === 1 ? '' : 's') + ' waiting for delivery';
}

export async function initSidebar(supabase) {
  setupProfileMenu();

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return;
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', session.user.id)
    .maybeSingle();
  const role = profile && profile.role;

  try {
    if (role === 'mother') await loadMotherPoints(supabase, session.user.id);
    else if (role === 'admin' || role === 'superadmin') await loadAdminPending(supabase);
  } catch (e) {
    console.error('Sidebar:', e);
  }
}
