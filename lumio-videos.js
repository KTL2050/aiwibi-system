/* ═══════════════════════════════════════════════════════════════════════════
   LUMIO — VIDEO STRIP
   A horizontally scrolling row of video cards: mother's initials + name +
   country flag, the video, a date badge, a views pill and an engagements pill.

   · TikTok: the video ID and a picture come from TikTok's free public oEmbed
     (no PostPeer credits, nothing stored). Short links are expanded first via
     the page's resolveUrl (resolve-short-urls). The video then auto-plays —
     muted, looping — while the card is on screen, at most MAX_PLAYING at once.
   · Instagram: the saved thumbnail if there is one; otherwise Instagram's
     embed, cropped to just the picture. Clicking opens the post on Instagram.

   Used by mothersdas.html (her own videos) and admindash.html (top 10):

       import('./lumio-videos.js').then(m => m.renderVideoStrip(el, cards, opts))

   card = { name, country, platform, url, thumbnail, date, views, engagements,
            likes, comments, shares }
   (numbers may be null while PostPeer hasn't synced the post — the pills are
    then left out; Instagram cards
    show likes/comments/shares in a TikTok-style side column)
   opts = { emptyHtml?, resolveUrl?: (shortUrl) => Promise<fullUrl|null> }
   ═══════════════════════════════════════════════════════════════════════════ */

const MAX_PLAYING = 3;

const STYLES = `
  .lv-strip{display:flex;gap:18px;overflow-x:auto;scroll-snap-type:x mandatory;
    padding:4px 2px 14px;-webkit-overflow-scrolling:touch;
    width:100%;contain:inline-size;} /* scroll inside the panel instead of widening the page */
  .lv-card{flex:0 0 260px;scroll-snap-align:start;background:#fff;border:1px solid #e6e8ec;
    border-radius:16px;overflow:hidden;display:flex;flex-direction:column;}
  .lv-head{display:flex;align-items:center;gap:12px;padding:14px 16px;min-width:0;}
  .lv-av{position:relative;flex:0 0 42px;height:42px;border-radius:50%;background:#eaf1ff;color:#2563eb;
    font:700 14px/42px 'Inter',system-ui,sans-serif;text-align:center;}
  .lv-flag{position:absolute;right:-4px;bottom:-4px;width:19px;height:19px;border-radius:50%;
    border:2px solid #fff;object-fit:cover;background:#fff;}
  .lv-name{font:600 15.5px 'Inter',system-ui,sans-serif;color:#121720;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis;}
  .lv-media{position:relative;aspect-ratio:3/4;background:#101113;overflow:hidden;cursor:pointer;}
  .lv-media img.lv-thumb{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}
  .lv-media iframe{position:absolute;inset:0;width:100%;height:100%;border:0;}
  /* TikTok is 9:16: keep that shape, anchored to the bottom, so the shorter card
     trims the top (TikTok's account bar) and its ♥/💬/↗ column stays fully visible */
  .lv-media iframe.lv-tt{inset:auto 0 0 0;height:auto;aspect-ratio:9/16;}
  .lv-media iframe.lv-ig-crop{height:300%;transform-origin:50% 0;
    transform:translateY(-72px) scale(1.34);pointer-events:none;} /* 1.34: just enough for square posts to fill the 3:4 card */
  .lv-placeholder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    color:rgba(255,255,255,.3);font-size:46px;}
  .lv-media.ig .lv-placeholder{background:linear-gradient(160deg,#f09433,#dc2743 55%,#bc1888);color:rgba(255,255,255,.8);}
  .lv-play{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:54px;height:54px;
    border-radius:50%;border:none;background:rgba(255,255,255,.92);color:#121720;font-size:22px;
    display:none;align-items:center;justify-content:center;cursor:pointer;padding-left:3px;}
  .lv-media.needs-click .lv-play{display:flex;}
  .lv-media.playing .lv-play,.lv-media.playing .lv-thumb,.lv-media.playing .lv-placeholder{display:none;}
  .lv-badge{position:absolute;top:12px;right:12px;padding:6px 13px;border-radius:999px;
    background:rgba(90,90,90,.55);color:#fff;font:600 12.5px 'Inter',system-ui,sans-serif;
    backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);pointer-events:none;}
  .lv-pills{position:absolute;left:14px;right:14px;bottom:14px;display:flex;flex-direction:column;
    align-items:flex-start;gap:8px;pointer-events:none;}
  .lv-pill{display:inline-flex;align-items:center;gap:8px;border-radius:999px;white-space:nowrap;
    font:700 17px 'Inter',system-ui,sans-serif;letter-spacing:-.01em;}
  .lv-pill small{font-size:13px;font-weight:500;letter-spacing:0;}
  .lv-views{background:#fff;color:#121720;padding:6px 16px 6px 6px;}
  .lv-icon{width:30px;height:30px;border-radius:50%;background:#121720;color:#fff;
    display:inline-flex;align-items:center;justify-content:center;font-size:16px;}
  .lv-icon.ig{background:linear-gradient(45deg,#f09433,#dc2743,#bc1888);}
  .lv-eng{background:#86efac;color:#064e3b;padding:9px 16px;}
  .lv-plat{position:absolute;top:12px;left:12px;width:32px;height:32px;border-radius:50%;
    background:#121720;color:#fff;display:flex;align-items:center;justify-content:center;
    font-size:17px;box-shadow:0 2px 6px rgba(0,0,0,.25);pointer-events:none;}
  .lv-plat.ig{background:linear-gradient(45deg,#f09433,#dc2743,#bc1888);}
  .lv-side{position:absolute;right:10px;bottom:135px;display:flex;flex-direction:column;align-items:center;
    gap:14px;pointer-events:none;color:#fff;font:600 13px 'Inter',system-ui,sans-serif;
    text-shadow:0 1px 3px rgba(0,0,0,.6);}
  .lv-side span{display:flex;flex-direction:column;align-items:center;gap:2px;}
  .lv-side i{font-size:27px;filter:drop-shadow(0 1px 3px rgba(0,0,0,.5));}
  .lv-empty{padding:28px 16px;text-align:center;font:400 13px 'Inter',system-ui,sans-serif;color:#667085;}
  .lv-empty a{color:#2563eb;font-weight:500;}
  @media(max-width:600px){
    .lv-card{flex-basis:200px;}
    .lv-pill{font-size:15px;}
  }
  .lv-strip.lv-drifting{scroll-snap-type:none;}
  /* Grid layout (opts.grid): rows of cards, no scrolling or drifting */
  .lv-strip.lv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));
    overflow:visible;contain:none;scroll-snap-type:none;padding:4px 0 8px;}
  .lv-grid .lv-card{flex:none;min-width:0;}
  @media(max-width:600px){.lv-strip.lv-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}}
`;

const FLAGS = { uganda: 'ug', kenya: 'ke' };
const CACHE_KEY = 'lv-tiktok-cache-v1';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Only http(s) links ever become href/src values.
function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

function compact(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

// Side-column number; "–" until PostPeer has the post (e.g. Instagram not connected).
function stat(n) {
  return n == null ? '–' : compact(n);
}

function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function initials(name) {
  return String(name || '?').trim().split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase() || '?';
}

/** Same key for the same video however the link was pasted. */
export function videoKey(u) {
  try {
    const url = new URL(String(u).trim());
    return (url.host.replace(/^www\./, '') + url.pathname).replace(/\/+$/, '').toLowerCase();
  } catch {
    return String(u || '').trim().split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase();
  }
}

/**
 * The post's own ID — TikTok video number or Instagram code — so a short link
 * (once expanded) and PostPeer's full link match. Same rule as the Reports
 * page's extractPostId.
 */
export function postId(u) {
  if (!u) return '';
  const tiktok = String(u).match(/\/(?:video|photo)\/(\d+)/); // videos and photo slideshows
  if (tiktok) return tiktok[1];
  const ig = String(u).match(/\/(p|reels?|tv)\/([A-Za-z0-9_-]+)/);
  if (ig) return ig[2];
  return videoKey(u);
}

/** True when the link already carries the post ID (no expanding needed). */
export function isCanonicalUrl(u) {
  return /\/(?:video|photo)\/\d+/.test(u || '') || /\/(p|reels?|tv)\//.test(u || '');
}

/** likes + comments + shares — the same "engagements" the dashboards use. */
export function engagementsOf(post) {
  if (!post) return null;
  if (post.engagement != null) return post.engagement;
  return (post.likes || 0) + (post.comments || 0) + (post.shares || 0);
}

function tiktokIdFromUrl(u) {
  const m = String(u || '').match(/tiktok\.com\/.*\/video\/(\d+)/i);
  return m ? m[1] : null;
}

function tiktokPlayer(id) {
  const p = new URLSearchParams({
    autoplay: 1, loop: 1, muted: 1, controls: 0, progress_bar: 0, play_button: 0,
    volume_control: 1, fullscreen_button: 0, timestamp: 0, music_info: 0,
    description: 0, rel: 0, native_context_menu: 0, closed_caption: 0,
  });
  return `https://www.tiktok.com/player/v1/${id}?${p}`;
}

function instagramEmbed(u) {
  const m = String(u || '').match(/instagram\.com\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  if (!m) return null;
  const kind = m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase();
  return `https://www.instagram.com/${kind}/${m[2]}/embed`;
}

// ── TikTok public oEmbed (free) with a per-browser-session cache ────────────
function readCache() {
  try { return JSON.parse(sessionStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; }
}
function writeCache(cache) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
}
export async function tiktokInfo(url, resolveUrl) {
  const cache = readCache();
  if (cache[url] && 'title' in cache[url]) return cache[url];

  let full = url;
  if (!tiktokIdFromUrl(full) && typeof resolveUrl === 'function') {
    try { full = (await resolveUrl(url)) || url; } catch { full = url; }
  }
  let id = tiktokIdFromUrl(full);
  let thumbnail = null;
  let title = null;
  try {
    const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(full)}`);
    if (res.ok) {
      const data = await res.json();
      id = id || (/^\d+$/.test(String(data.embed_product_id || '')) ? String(data.embed_product_id) : null);
      thumbnail = safeUrl(data.thumbnail_url);
      title = typeof data.title === 'string' ? data.title : null;
    }
  } catch { /* offline / blocked: keep what we have */ }

  const info = { id, thumbnail, title, full: full !== url ? full : null };
  if (id || thumbnail) { cache[url] = info; writeCache(cache); }
  return info;
}

function ensureStyles() {
  if (document.getElementById('lv-styles')) return;
  const style = document.createElement('style');
  style.id = 'lv-styles';
  style.textContent = STYLES;
  document.head.appendChild(style);
}

function cardHtml(c, i) {
  const ig = c.platform === 'instagram';
  const flag = FLAGS[String(c.country || '').toLowerCase()];
  const thumb = safeUrl(c.thumbnail);
  const synced = c.views != null;
  const date = shortDate(c.date);
  return `
    <div class="lv-card">
      <div class="lv-head">
        <span class="lv-av">${escapeHtml(initials(c.name))}${flag
          ? `<img class="lv-flag" src="https://flagcdn.com/w40/${flag}.png" alt="${escapeHtml(c.country)}">` : ''}</span>
        <span class="lv-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name || 'Mother')}</span>
      </div>
      <div class="lv-media${ig ? ' ig' : ''}" data-i="${i}">
        ${thumb ? `<img class="lv-thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy">`
                : `<div class="lv-placeholder"><i class="ti ti-brand-${ig ? 'instagram' : 'tiktok'}"></i></div>`}
        <button type="button" class="lv-play" aria-label="Open video"><i class="ti ti-player-play-filled"></i></button>
        <span class="lv-plat${ig ? ' ig' : ''}" title="${ig ? 'Instagram' : 'TikTok'}"><i class="ti ti-brand-${ig ? 'instagram' : 'tiktok'}"></i></span>
        ${date ? `<span class="lv-badge">${escapeHtml(date)}</span>` : ''}
        ${ig ? `<div class="lv-side">
          <span title="Likes"><i class="ti ti-heart-filled"></i>${stat(c.likes)}</span>
          <span title="Comments"><i class="ti ti-message-circle"></i>${stat(c.comments)}</span>
          <span title="Shares"><i class="ti ti-share-3"></i>${stat(c.shares)}</span>
        </div>` : ''}
        <div class="lv-pills">
          ${synced ? `<span class="lv-pill lv-views"><span class="lv-icon${ig ? ' ig' : ''}"><i class="ti ti-brand-${ig ? 'instagram' : 'tiktok'}"></i></span>${compact(c.views)} <small>views</small></span>
          <span class="lv-pill lv-eng">${compact(c.engagements)} <small>engagements</small></span>` : ''}
        </div>
      </div>
    </div>`;
}

/**
 * Slow continuous drift to the left, looping forever without duplicating
 * cards: once a card has slid fully off the left edge it is moved to the end
 * of the row (it is off screen, so its video is already unloaded).
 * Only runs when the cards don't all fit. Pauses while the mouse is over the
 * strip or a finger is on it. Returns a stop function.
 */
const DRIFT_PX_PER_SEC = 30;
function startDrift(strip) {
  let raf = 0, last = 0, pos = 0, paused = false, resumeTimer = 0;
  const gap = () => parseFloat(getComputedStyle(strip).columnGap) || 0;

  function tick(t) {
    raf = requestAnimationFrame(tick);
    const dt = last ? Math.min(t - last, 100) : 0;
    last = t;
    if (paused || strip.scrollWidth <= strip.clientWidth + 1) {
      strip.classList.remove('lv-drifting');
      return;
    }
    strip.classList.add('lv-drifting');
    pos += DRIFT_PX_PER_SEC * dt / 1000;
    const first = strip.firstElementChild;
    const step = first ? first.offsetWidth + gap() : 0;
    if (first && pos >= step) {
      strip.appendChild(first);
      pos -= step;
    }
    strip.scrollLeft = pos;
  }

  const pause = () => { clearTimeout(resumeTimer); paused = true; };
  // After the user lets go, carry on from wherever they left it.
  const resume = (delay = 0) => {
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { pos = strip.scrollLeft; last = 0; paused = false; }, delay);
  };
  strip.addEventListener('mouseenter', pause);
  strip.addEventListener('mouseleave', () => resume());
  strip.addEventListener('touchstart', pause, { passive: true });
  strip.addEventListener('touchend', () => resume(1500), { passive: true });

  raf = requestAnimationFrame(tick);
  return () => { cancelAnimationFrame(raf); clearTimeout(resumeTimer); };
}

/**
 * Draws the strip into `container`.
 * @param {HTMLElement} container
 * @param {Array} cards
 * @param {{ emptyHtml?: string, resolveUrl?: (url: string) => Promise<string|null>, grid?: boolean, drift?: boolean }} [opts]
 *   grid: show the cards in rows (no horizontal scrolling or drifting).
 *   drift: false — horizontal strip you scroll yourself, without the automatic motion.
 */
export function renderVideoStrip(container, cards, opts = {}) {
  if (!container) return;
  ensureStyles();

  if (container._lvObserver) container._lvObserver.disconnect();
  if (container._lvStopDrift) container._lvStopDrift();

  if (!cards || !cards.length) {
    container.innerHTML = `<div class="lv-empty">${opts.emptyHtml || 'No videos yet.'}</div>`;
    return;
  }

  container.innerHTML = `<div class="lv-strip${opts.grid ? ' lv-grid' : ''}">${cards.map(cardHtml).join('')}</div>`;
  const strip = container.querySelector('.lv-strip');
  const medias = [...strip.querySelectorAll('.lv-media')];
  const cardOf = m => cards[Number(m.dataset.i)];
  const visible = new Set();

  function showPlaceholder(media) {
    media.querySelector('.lv-thumb')?.remove();
    if (!media.querySelector('.lv-placeholder')) {
      const c = cardOf(media);
      const ph = document.createElement('div');
      ph.className = 'lv-placeholder';
      ph.innerHTML = `<i class="ti ti-brand-${c.platform === 'instagram' ? 'instagram' : 'tiktok'}"></i>`;
      media.insertBefore(ph, media.firstChild);
    }
  }

  function setThumb(media, src) {
    const url = safeUrl(src);
    if (!url) return;
    media.querySelector('.lv-thumb')?.remove();
    const img = document.createElement('img');
    img.className = 'lv-thumb';
    img.alt = '';
    img.addEventListener('load', () => media.querySelector('.lv-placeholder')?.remove());
    img.addEventListener('error', () => onImgError(media));
    img.src = url;
    media.insertBefore(img, media.firstChild);
  }

  function frame(src, cls) {
    const f = document.createElement('iframe');
    f.src = src;
    if (cls) { f.className = cls; f.setAttribute('scrolling', 'no'); f.tabIndex = -1; }
    f.allow = 'autoplay; encrypted-media; picture-in-picture';
    f.loading = 'lazy';
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    return f;
  }

  // Videos load ONCE: scrolling away only pauses them; coming back resumes the
  // same player instantly instead of reloading it.
  function play(media) {
    const c = cardOf(media);
    const loaded = media.querySelector('iframe');
    if (loaded) {
      if (c._ttId && loaded._ttPaused) { loaded._ttSend?.('play'); loaded._ttPaused = false; }
      return;
    }
    let f = null;
    if (c._ttId) f = frame(tiktokPlayer(c._ttId), 'lv-tt');
    else if (media.dataset.igCrop === '1') f = frame(instagramEmbed(c.url), 'lv-ig-crop');
    if (!f) return;
    media.insertBefore(f, media.firstChild);
    media.classList.add('playing');
    if (c._ttId) startMuted(f);
  }

  // TikTok's player starts WITH sound, which Chrome refuses to auto-play. Once
  // it reports ready, tell it to mute and play — muted video may always
  // auto-play. (Also sent a moment after load, in case "ready" was missed.)
  function startMuted(f) {
    const send = type => {
      try { f.contentWindow?.postMessage({ type, value: null, 'x-tiktok-player': true }, '*'); } catch {}
    };
    f._ttSend = send; // used to pause / resume later without reloading
    const kick = () => { send('mute'); if (!f._ttPaused) send('play'); };
    const onMessage = e => {
      if (e.source !== f.contentWindow) return;
      let d = e.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
      if (d && d['x-tiktok-player'] && d.type === 'onPlayerReady') kick();
    };
    window.addEventListener('message', onMessage);
    f.addEventListener('load', () => setTimeout(kick, 1500));
    // Stop listening once the card's video is removed.
    const watch = new MutationObserver(() => {
      if (!f.isConnected) { window.removeEventListener('message', onMessage); watch.disconnect(); }
    });
    watch.observe(f.parentNode, { childList: true });
  }

  // Off screen: pause (TikTok) and keep the player; Instagram pictures just stay.
  function stop(media) {
    const f = media.querySelector('iframe');
    if (f && f._ttSend && !f._ttPaused) { f._ttSend('pause'); f._ttPaused = true; }
  }

  function refresh() {
    let playing = 0;
    for (const m of medias) {
      const c = cardOf(m);
      const wants = c._ttId || m.dataset.igCrop === '1';
      if (!wants) continue;
      if (visible.has(m) && (!c._ttId || playing < MAX_PLAYING)) { play(m); if (c._ttId) playing++; }
      else stop(m);
    }
  }

  // A picture failed: TikTok tries the oEmbed picture once; otherwise placeholder.
  function onImgError(media) {
    const c = cardOf(media);
    if (c.platform !== 'instagram' && c._ttThumb && !media.dataset.ttThumbTried) {
      media.dataset.ttThumbTried = '1';
      setThumb(media, c._ttThumb);
      return;
    }
    showPlaceholder(media);
    onNoThumb(media);
  }

  // No usable picture: Instagram → cropped embed; TikTok without an ID → ▶ opens it.
  function onNoThumb(media) {
    const c = cardOf(media);
    if (c.platform === 'instagram') {
      if (instagramEmbed(c.url)) { media.dataset.igCrop = '1'; refresh(); }
      else media.classList.add('needs-click');
    } else if (!c._ttId) {
      media.classList.add('needs-click');
    }
  }

  // Clicking a card opens the video on TikTok / Instagram.
  strip.addEventListener('click', e => {
    const media = e.target.closest('.lv-media');
    if (!media) return;
    const link = safeUrl(cardOf(media)._fullUrl || cardOf(media).url);
    if (link) window.open(link, '_blank', 'noopener');
  });

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => (en.isIntersecting ? visible.add(en.target) : visible.delete(en.target)));
      refresh();
    }, { threshold: 0, rootMargin: '300px' }); // load 300px before it's on screen; unload only when far away
    medias.forEach(m => io.observe(m));
    container._lvObserver = io;
  }

  container._lvStopDrift = (opts.grid || opts.drift === false) ? null : startDrift(strip);

  medias.forEach(async media => {
    const c = cardOf(media);
    const img = media.querySelector('.lv-thumb');
    if (img) img.addEventListener('error', () => onImgError(media));

    if (c.platform === 'instagram') {
      if (!img) onNoThumb(media);
      return;
    }

    // TikTok: video ID (+ picture if ours is missing/broken) from the free oEmbed.
    c._ttId = tiktokIdFromUrl(c.url);
    const info = await tiktokInfo(c.url, opts.resolveUrl);
    c._ttId = c._ttId || info.id;
    c._ttThumb = info.thumbnail;
    if (info.full) c._fullUrl = info.full;
    // Keep a saved picture that is fine (or still loading); fill in only if missing/broken.
    const cur = media.querySelector('.lv-thumb');
    const broken = !cur || (cur.complete && cur.naturalWidth === 0);
    if (broken && info.thumbnail && !media.dataset.ttThumbTried) {
      media.dataset.ttThumbTried = '1';
      setThumb(media, info.thumbnail);
    }
    if (!c._ttId && !info.thumbnail) media.classList.add('needs-click');
    refresh();
  });
}
