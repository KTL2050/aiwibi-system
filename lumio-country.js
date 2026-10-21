/* ═══════════════════════════════════════════════════════════════════════════
   LUMIO — COUNTRY SCOPE FOR ADMIN PAGES
   Uganda and Kenya are run separately. Every admin page shows one country:

   · Superadmin: a 🇺🇬 Uganda / 🇰🇪 Kenya / All selector in the top bar. The
     choice is shared by all admin pages (same saved setting as the dashboard's
     selector) and changing it reloads the page in that country.
   · Admin: locked to their own country (a fixed chip). If they have no
     country assigned they see nothing.

   The database rules (supabase/country_separation.sql) enforce the same
   thing server-side; this file keeps the pages in step with them.

       const { initCountry, motherIdsIn, inCountry } = await import('./lumio-country.js')
       const scope = await initCountry(supabase)   // { role, country, isSuper }
       // scope.country: 'all' | 'uganda' | 'kenya' | 'none'
   ═══════════════════════════════════════════════════════════════════════════ */

const STORAGE_KEY = 'aiwibi_admin_country_filter';
const LABELS = { all: 'All Countries', uganda: '🇺🇬 Uganda', kenya: '🇰🇪 Kenya', none: 'No country assigned' };

const STYLES = `
  .lc-chip{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;
    background:var(--brand-bg,#f3ecfb);color:var(--brand-dark,#6c3fa0);
    font:600 12px 'Inter',system-ui,sans-serif;white-space:nowrap;}
  .lc-chip select{border:none;background:transparent;font:inherit;color:inherit;cursor:pointer;outline:none;}
  .lc-chip select:disabled{cursor:default;-webkit-appearance:none;appearance:none;}
`;

function readSaved() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}
function save(value) {
  try { localStorage.setItem(STORAGE_KEY, value); } catch {}
}

function renderChip(scope) {
  const right = document.querySelector('.topbar-right');
  if (!right || document.getElementById('lc-chip')) return;
  if (!document.getElementById('lc-styles')) {
    const style = document.createElement('style');
    style.id = 'lc-styles';
    style.textContent = STYLES;
    document.head.appendChild(style);
  }
  const chip = document.createElement('div');
  chip.className = 'lc-chip';
  chip.id = 'lc-chip';
  const options = scope.isSuper ? ['uganda', 'kenya', 'all'] : [scope.country];
  chip.innerHTML = `<i class="ti ti-map-pin" style="font-size:13px"></i>
    <select aria-label="Country"${scope.isSuper ? '' : ' disabled'}>
      ${options.map(c => `<option value="${c}"${c === scope.country ? ' selected' : ''}>${LABELS[c] || c}</option>`).join('')}
    </select>`;
  if (scope.isSuper) {
    chip.querySelector('select').addEventListener('change', e => {
      save(e.target.value);
      window.location.reload();
    });
  }
  right.insertBefore(chip, right.firstChild);
}

/**
 * Works out which country this page shows and draws the selector/chip.
 * @returns {Promise<{ role: string|null, country: 'all'|'uganda'|'kenya'|'none', isSuper: boolean }>}
 */
export async function initCountry(supabase) {
  const { data: { session } } = await supabase.auth.getSession();
  let role = null, own = null;
  if (session) {
    const { data } = await supabase.from('profiles').select('role, country').eq('id', session.user.id).maybeSingle();
    role = data?.role || null;
    own = data?.country || null;
  }
  const isSuper = role === 'superadmin';
  let country;
  if (isSuper) {
    const saved = readSaved();
    country = ['all', 'uganda', 'kenya'].includes(saved) ? saved : 'all';
  } else {
    country = own || 'none';
  }
  const scope = { role, country, isSuper };
  renderChip(scope);
  return scope;
}

/** Display name, e.g. for empty states: "No mothers in 🇰🇪 Kenya yet". */
export function countryLabel(country) {
  return LABELS[country] || country;
}

/**
 * IDs of the mothers in a country — for filtering tables that only store
 * user_id (submitted_content, reward_redemptions, social_accounts).
 * Returns null for 'all' (no filter), [] for 'none'.
 */
export async function motherIdsIn(supabase, country) {
  if (country === 'all') return null;
  if (country === 'none') return [];
  const { data, error } = await supabase.from('profiles').select('id').eq('role', 'mother').eq('country', country);
  if (error) { console.error('Failed to load mothers for country:', error); return []; }
  return (data || []).map(p => p.id);
}

/** Adds .eq('country', …) to a catalog query unless showing all countries. */
export function inCountry(query, country) {
  return country === 'all' ? query : query.eq('country', country);
}

/** Adds .in('user_id', ids) unless ids is null (all countries). */
export function forMothers(query, ids, column = 'user_id') {
  if (ids === null) return query;
  // An empty list must match nothing (not everything).
  return query.in(column, ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
}
