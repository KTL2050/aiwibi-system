/* ═══════════════════════════════════════════════════════════════════════════
   LUMIO — NOTIFICATION BELL
   Turns the element with id="notif-bell" into a working bell: real unread
   count, a drop-down list, mark-as-read, and live updates (Supabase Realtime).

   Each page passes in the Supabase client it already has, so no keys live here:

       import('./lumio-notify.js').then(m => m.initNotifications(supabase))

   Notifications are created only by database triggers
   (see supabase/notifications.sql). This file just reads them and sets read_at.
   ═══════════════════════════════════════════════════════════════════════════ */

const LIMIT = 20;

const STYLES = `
  #notif-bell{position:relative;cursor:pointer;}
  .ln-badge{
    position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;padding:0 5px;
    border-radius:9px;background:#d0361c;color:#fff;border:2px solid #fff;
    font:600 10.5px/14px 'Inter',system-ui,sans-serif;text-align:center;box-sizing:border-box;
    display:none;pointer-events:none;
  }
  .ln-panel{
    position:fixed;z-index:3000;width:360px;max-width:calc(100vw - 24px);
    background:#fff;border:1px solid #e6e8ec;border-radius:12px;
    box-shadow:0 10px 30px rgba(16,24,40,.12);
    font-family:'Inter',system-ui,sans-serif;color:#121720;
    display:none;overflow:hidden;
  }
  .ln-panel.open{display:block;}
  .ln-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #e6e8ec;}
  .ln-head-title{font-size:14px;font-weight:600;}
  .ln-mark-all{background:none;border:none;color:#2563eb;font:500 12.5px 'Inter',system-ui,sans-serif;cursor:pointer;padding:0;}
  .ln-mark-all:disabled{color:#98a2b3;cursor:default;}
  .ln-list{max-height:380px;overflow-y:auto;}
  .ln-item{display:flex;gap:10px;padding:12px 16px;border-bottom:1px solid #eef0f3;cursor:pointer;text-decoration:none;color:inherit;}
  .ln-item:last-child{border-bottom:none;}
  .ln-item:hover{background:#f6f7f9;}
  .ln-dot{flex:0 0 8px;height:8px;margin-top:6px;border-radius:50%;background:transparent;}
  .ln-item.unread .ln-dot{background:#2563eb;}
  .ln-text{flex:1;min-width:0;}
  .ln-title{font-size:13px;font-weight:500;line-height:1.35;}
  .ln-item.unread .ln-title{font-weight:600;}
  .ln-body{font-size:12.5px;color:#667085;line-height:1.4;margin-top:2px;}
  .ln-time{font-size:11px;color:#98a2b3;margin-top:4px;}
  .ln-empty{padding:28px 16px;text-align:center;font-size:13px;color:#667085;}
`;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function timeAgo(iso) {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'Just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// Only follow links to pages of this app (e.g. "motherreward.html").
function safeLink(link) {
  return /^[a-z0-9-]+\.html(\?[\w=&-]*)?$/i.test(link || '') ? link : null;
}

export async function initNotifications(supabase) {
  const bell = document.getElementById('notif-bell');
  if (!bell || bell.dataset.lnReady) return;
  bell.dataset.lnReady = '1';

  if (!document.getElementById('ln-styles')) {
    const style = document.createElement('style');
    style.id = 'ln-styles';
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  // Old static badges ("3") are replaced by the live one.
  bell.querySelectorAll('.count, .dot').forEach(el => el.remove());
  bell.setAttribute('role', 'button');
  bell.setAttribute('aria-label', 'Notifications');
  bell.tabIndex = 0;

  const badge = document.createElement('span');
  badge.className = 'ln-badge';
  bell.appendChild(badge);

  const panel = document.createElement('div');
  panel.className = 'ln-panel';
  panel.innerHTML = `
    <div class="ln-head">
      <span class="ln-head-title">Notifications</span>
      <button type="button" class="ln-mark-all" disabled>Mark all as read</button>
    </div>
    <div class="ln-list"><div class="ln-empty">Loading…</div></div>`;
  document.body.appendChild(panel);
  const listEl = panel.querySelector('.ln-list');
  const markAllBtn = panel.querySelector('.ln-mark-all');

  let items = [];
  let userId = null;
  let setupError = false;

  function render() {
    const unread = items.filter(n => !n.read_at).length;
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.style.display = unread ? 'block' : 'none';
    markAllBtn.disabled = !unread;

    if (setupError) {
      listEl.innerHTML = '<div class="ln-empty">Notifications aren’t available right now.</div>';
      return;
    }
    if (!userId) {
      listEl.innerHTML = '<div class="ln-empty">Sign in to see your notifications.</div>';
      return;
    }
    if (!items.length) {
      listEl.innerHTML = '<div class="ln-empty">You’re all caught up — no notifications yet.</div>';
      return;
    }
    listEl.innerHTML = items.map(n => `
      <div class="ln-item${n.read_at ? '' : ' unread'}" data-id="${escapeHtml(n.id)}">
        <span class="ln-dot"></span>
        <div class="ln-text">
          <div class="ln-title">${escapeHtml(n.title)}</div>
          ${n.body ? `<div class="ln-body">${escapeHtml(n.body)}</div>` : ''}
          <div class="ln-time">${escapeHtml(timeAgo(n.created_at))}</div>
        </div>
      </div>`).join('');
  }

  function place() {
    const r = bell.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 24);
    const left = Math.max(12, Math.min(r.right - width, window.innerWidth - width - 12));
    panel.style.top = `${r.bottom + 8}px`;
    panel.style.left = `${left}px`;
  }

  function open() { place(); panel.classList.add('open'); }
  function close() { panel.classList.remove('open'); }

  bell.addEventListener('click', e => {
    e.stopPropagation();
    panel.classList.contains('open') ? close() : open();
  });
  bell.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bell.click(); }
  });
  document.addEventListener('click', e => {
    if (!panel.contains(e.target)) close();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  window.addEventListener('resize', () => { if (panel.classList.contains('open')) place(); });

  async function markRead(ids) {
    if (!ids.length) return;
    const now = new Date().toISOString();
    const { error } = await supabase.from('notifications').update({ read_at: now }).in('id', ids);
    if (error) { console.error('Mark notifications read failed:', error); return; }
    items.forEach(n => { if (ids.includes(n.id)) n.read_at = now; });
    render();
  }

  listEl.addEventListener('click', async e => {
    const row = e.target.closest('.ln-item');
    if (!row) return;
    e.stopPropagation();
    const n = items.find(x => x.id === row.dataset.id);
    if (!n) return;
    if (!n.read_at) await markRead([n.id]);
    const link = safeLink(n.link);
    if (link) window.location.href = link;
  });

  markAllBtn.addEventListener('click', e => {
    e.stopPropagation();
    markRead(items.filter(n => !n.read_at).map(n => n.id));
  });

  const { data: { session } } = await supabase.auth.getSession();
  userId = session?.user?.id || null;
  if (!userId) { render(); return; }

  const { data, error } = await supabase
    .from('notifications')
    .select('id, title, body, link, read_at, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(LIMIT);

  if (error) {
    console.warn('Notifications not available:', error.message);
    setupError = true;
    render();
    return;
  }
  items = data || [];
  render();

  // Live: new notifications appear without a page refresh.
  supabase
    .channel(`notifications-${userId}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
      payload => {
        const n = payload.new;
        if (!n || items.some(x => x.id === n.id)) return;
        items = [n, ...items].slice(0, LIMIT);
        render();
      })
    .subscribe();
}
