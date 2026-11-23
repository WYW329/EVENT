// 桃園活動雷達：前端。資料從 /api/events 來，收藏存在本機，開啟通知後同步到伺服器。

const CATEGORIES = ['表演', '展覽', '講座課程', '親子', '親子館', '節慶市集', '體驗', '運動', '電影', '報名', '其他'];
const DISTRICTS = ['桃園區', '中壢區', '平鎮區', '八德區', '楊梅區', '蘆竹區', '龜山區', '大園區', '觀音區', '新屋區', '龍潭區', '大溪區', '復興區'];
const REMIND_OPTIONS = [[1440, '1 天前'], [180, '3 小時前'], [60, '1 小時前'], [30, '30 分鐘前'], [10, '10 分鐘前'], [5, '5 分鐘前']];
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------- 本機儲存（無痕模式等情況會失敗，要包起來） ----------
const store = {
  get(k, fallback) {
    try {
      const v = localStorage.getItem(`tyev.${k}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`tyev.${k}`, JSON.stringify(v));
    } catch {}
  },
};

const S = {
  events: [],
  byId: new Map(),
  status: null,
  updatedAt: null,
  manualNeedsKey: false,
  starred: new Set(store.get('starred', [])),
  subId: store.get('subId', null),
  prefs: store.get('prefs', null),
  lastVisit: store.get('lastVisit', null),
  view: 'list',
  when: 'all',
};

// ---------- 時間 ----------
const isDateOnly = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '');
const ms = (s) => (!s ? NaN : isDateOnly(s) ? Date.parse(`${s}T00:00:00+08:00`) : Date.parse(s));
/** 台北時間的各欄位 */
function tp(t) {
  const d = new Date(t + 8 * 3600000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), w: d.getUTCDay(), hh: d.getUTCHours(), mi: d.getUTCMinutes() };
}
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (t) => { const x = tp(t); return `${x.y}-${pad(x.m)}-${pad(x.d)}`; };
const todayKey = () => dayKey(Date.now());

function fmtDate(s, withYear = false) {
  const t = ms(s);
  if (Number.isNaN(t)) return '';
  const x = tp(t);
  const y = withYear || x.y !== tp(Date.now()).y ? `${x.y}/` : '';
  return `${y}${x.m}/${x.d}（${WEEK[x.w]}）`;
}
function fmtTime(s) {
  if (!s || isDateOnly(s)) return '';
  const x = tp(ms(s));
  return `${pad(x.hh)}:${pad(x.mi)}`;
}
function fmtDT(s) {
  if (!s) return '';
  const time = fmtTime(s);
  return `${fmtDate(s)}${time && time !== '00:00' ? ` ${time}` : ''}`;
}
function fmtRange(a, b) {
  if (!a) return '';
  if (!b || b === a) return fmtDT(a);
  if (dayKey(ms(a)) === dayKey(ms(b))) {
    const t2 = fmtTime(b);
    return `${fmtDT(a)}${t2 && t2 !== fmtTime(a) ? `–${t2}` : ''}`;
  }
  return `${fmtDate(a)} ～ ${fmtDate(b)}`;
}
function countdown(target) {
  const diff = ms(target) - Date.now();
  if (diff <= 0) return '已開放';
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m} 分鐘後`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} 小時 ${m % 60} 分後`;
  return `${Math.floor(h / 24)} 天後`;
}
function relDay(key) {
  const today = todayKey();
  if (key === today) return '今天';
  const tomorrow = dayKey(Date.now() + 86400000);
  if (key === tomorrow) return '明天';
  return '';
}
/** 轉成 <input type="datetime-local"> 用的格式（台北時間） */
function toLocalInput(s) {
  if (!s) return '';
  const t = ms(s);
  if (Number.isNaN(t)) return '';
  const x = tp(t);
  return `${x.y}-${pad(x.m)}-${pad(x.d)}T${pad(isDateOnly(s) ? 0 : x.hh)}:${pad(isDateOnly(s) ? 0 : x.mi)}`;
}
const fromLocalInput = (v) => (v ? `${v}:00+08:00` : null);

// ---------- 小工具 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ---------- 資料 ----------
async function loadEvents() {
  try {
    const data = await api('/api/events');
    S.events = data.events ?? [];
    S.status = data.status;
    S.updatedAt = data.updatedAt;
    S.manualNeedsKey = data.manualNeedsKey;
    store.set('cache', { events: S.events, status: S.status, updatedAt: S.updatedAt });
  } catch (err) {
    const cached = store.get('cache', null);
    if (cached) {
      Object.assign(S, cached);
      toast('目前離線，顯示上次的資料');
    } else {
      toast(`讀取活動失敗：${err.message}`);
    }
  }
  S.byId = new Map(S.events.map((e) => [e.id, e]));
}

// ---------- 活動卡片 ----------
function regBadge(e) {
  const now = Date.now();
  if (/額滿/.test(e.extra?.status ?? '')) return '<span class="tag">已額滿</span>';
  if (e.regStart && ms(e.regStart) > now) return `<span class="tag reg">${esc(fmtDT(e.regStart))} 開放報名・${countdown(e.regStart)}</span>`;
  if (e.regStart && (!e.regEnd || ms(e.regEnd) > now)) return `<span class="tag reg now">報名中${e.regEnd ? `・${esc(fmtDT(e.regEnd))} 截止` : ''}</span>`;
  return '';
}
function card(e, { showDate = false } = {}) {
  const isNew = S.lastVisit && e.firstSeen && e.firstSeen > S.lastVisit && e.source !== 'manual';
  const seats = e.extra?.seatsLeft != null ? `<span class="tag">剩 ${e.extra.seatsLeft}/${e.extra.seats} 位</span>` : '';
  const when = showDate ? fmtRange(e.start, e.end) : (e.end && dayKey(ms(e.end)) !== dayKey(ms(e.start)) ? `到 ${fmtDate(e.end)}` : fmtTime(e.start) && fmtTime(e.start) !== '00:00' ? fmtTime(e.start) : '');
  return `
    <article class="ev" data-id="${esc(e.id)}" tabindex="0">
      <div class="t">${esc(e.title)}</div>
      <button class="star-btn ${S.starred.has(e.id) ? 'on' : ''}" data-star="${esc(e.id)}" aria-label="收藏">${S.starred.has(e.id) ? '★' : '☆'}</button>
      <div class="sub">
        ${when ? `<span>🕘 ${esc(when)}</span>` : ''}
        ${e.venue || e.district ? `<span>📍 ${esc([e.venue, e.district].filter(Boolean).join('・'))}</span>` : ''}
      </div>
      <div class="tags">
        ${isNew ? '<span class="tag new">新</span>' : ''}
        ${regBadge(e)}
        <span class="tag cat">${esc(e.category)}</span>
        ${e.free ? '<span class="tag free">免費</span>' : ''}
        ${seats}
        <span class="tag">${esc(e.sourceName)}</span>
      </div>
    </article>`;
}

// ---------- 活動列表 ----------
function inWhen(e, when) {
  if (when === 'all') return true;
  const now = Date.now();
  const start = ms(e.start);
  const end = ms(e.end ?? e.start) || start;
  const today0 = ms(todayKey());
  let from = today0;
  let to;
  if (when === 'today') to = today0 + 86400000;
  if (when === 'week') to = today0 + 7 * 86400000;
  if (when === 'month') to = today0 + 30 * 86400000;
  if (when === 'weekend') {
    const w = tp(now).w;
    const toSat = w === 6 ? 0 : w === 0 ? -1 : 6 - w;
    from = today0 + toSat * 86400000;
    to = from + (w === 0 ? 1 : 2) * 86400000;
    if (w === 0) from = today0;
  }
  return start < to && (end >= from || dayKey(end) === dayKey(from));
}

function filtered() {
  const q = $('#q').value.trim().toLowerCase();
  const cat = $('#catSel').value;
  const dist = $('#distSel').value;
  const hideBaby = $('#hideBaby').checked;
  return S.events.filter((e) => {
    if (hideBaby && e.category === '親子館' && cat !== '親子館') return false;
    if (cat && e.category !== cat) return false;
    if (dist && e.district !== dist) return false;
    if (!inWhen(e, S.when)) return false;
    if (q && !`${e.title} ${e.venue ?? ''} ${e.district ?? ''} ${e.sourceName} ${e.summary ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderList() {
  const list = filtered();
  const today = todayKey();
  // 已經開始的長期活動排在「進行中」，其他依開始日分組
  const ongoing = [];
  const groups = new Map();
  for (const e of list) {
    const k = dayKey(ms(e.start));
    if (k < today) ongoing.push(e);
    else (groups.get(k) ?? groups.set(k, []).get(k)).push(e);
  }
  let html = '';
  const keys = [...groups.keys()].sort();
  for (const k of keys) {
    html += `<div class="day-head">${esc(fmtDate(k))}${relDay(k) ? `<span class="rel">${relDay(k)}</span>` : ''}</div>`;
    html += groups.get(k).map((e) => card(e)).join('');
  }
  if (ongoing.length) {
    ongoing.sort((a, b) => ms(a.end) - ms(b.end));
    html += `<div class="day-head">進行中（依結束日排序）</div>` + ongoing.map((e) => card(e, { showDate: true })).join('');
  }
  $('#list').innerHTML = html || '<div class="empty">沒有符合條件的活動</div>';
  const newCount = S.lastVisit ? S.events.filter((e) => e.firstSeen > S.lastVisit && e.source !== 'manual').length : 0;
  $('#listMeta').textContent = `共 ${list.length} 個活動${newCount ? `・上次來之後新增 ${newCount} 個` : ''}${S.updatedAt ? `・資料更新於 ${fmtDT(S.updatedAt)}` : ''}`;
}

function renderReg() {
  const now = Date.now();
  const hideBaby = $('#regHideBaby').checked;
  const items = S.events
    .filter((e) => e.regStart && (!hideBaby || e.category !== '親子館') && !/額滿/.test(e.extra?.status ?? '') && e.extra?.seatsLeft !== 0)
    .filter((e) => ms(e.regStart) > now || !e.regEnd || ms(e.regEnd) > now)
    .filter((e) => ms(e.regStart) > now || ms(e.end ?? e.start) > now);
  const upcoming = items.filter((e) => ms(e.regStart) > now).sort((a, b) => ms(a.regStart) - ms(b.regStart));
  const open = items.filter((e) => ms(e.regStart) <= now).sort((a, b) => (ms(a.regEnd) || Infinity) - (ms(b.regEnd) || Infinity));
  let html = '';
  if (upcoming.length) html += `<div class="day-head">即將開放報名</div>` + upcoming.map((e) => card(e, { showDate: true })).join('');
  if (open.length) html += `<div class="day-head">報名中</div>` + open.map((e) => card(e, { showDate: true })).join('');
  $('#regList').innerHTML = html || '<div class="empty">目前沒有需要搶報名的活動</div>';
}

function renderStar() {
  const items = [...S.starred].map((id) => S.byId.get(id)).filter(Boolean).sort((a, b) => ms(a.regStart && ms(a.regStart) > Date.now() ? a.regStart : a.start) - ms(b.regStart && ms(b.regStart) > Date.now() ? b.regStart : b.start));
  const missing = S.starred.size - items.length;
  $('#starHint').textContent = S.subId
    ? '收藏的活動會在開放報名前、以及活動前一天提醒你。'
    : '收藏的活動要「開啟通知」後才會提醒你（到設定頁開啟）。也可以在活動裡按「加入行事曆」用手機行事曆提醒。';
  $('#starList').innerHTML = (items.map((e) => card(e, { showDate: true })).join('') || '<div class="empty">還沒有收藏。在活動上按 ☆ 就會出現在這裡</div>') + (missing > 0 ? `<p class="meta">另有 ${missing} 個收藏的活動已經結束</p>` : '');
}

function renderManualList() {
  const items = S.events.filter((e) => e.source === 'manual');
  $('#manualList').innerHTML = items.length
    ? items.map((e) => `<div class="ev" data-id="${esc(e.id)}"><div class="t">${esc(e.title)}</div><button class="btn ghost small" data-del="${esc(e.id)}">刪除</button><div class="sub"><span>${esc(fmtRange(e.start, e.end))}</span>${e.regStart ? `<span>報名 ${esc(fmtDT(e.regStart))}</span>` : ''}</div></div>`).join('')
    : '<div class="empty">還沒有手動加入的活動</div>';
}

function renderSources() {
  const st = S.status;
  $('#srcUpdated').textContent = st ? `上次抓取：${fmtDT(st.updatedAt)}，共 ${st.total} 個活動` : '還沒有抓取紀錄';
  $('#srcList').innerHTML = (st?.sources ?? [])
    .map((s) => `<li><span>${esc(s.name)}</span><span class="${s.ok ? '' : 'bad'}">${s.ok ? `${s.kept} 個` : `失敗：${esc(s.error ?? '')}`}</span></li>`)
    .join('');
}

function renderAll() {
  renderList();
  renderReg();
  renderStar();
  renderManualList();
  renderSources();
}

// ---------- 活動詳情 ----------
function openDetail(id) {
  const e = S.byId.get(id);
  if (!e) return;
  const mapQ = encodeURIComponent(e.address || [e.venue, e.district, '桃園市'].filter(Boolean).join(' '));
  const rows = [
    ['時間', fmtRange(e.start, e.end) + (e.extra?.note ? `（${e.extra.note}）` : '')],
    e.regStart ? ['開放報名', `${fmtDT(e.regStart)}${ms(e.regStart) > Date.now() ? `・<span class="countdown">${countdown(e.regStart)}</span>` : ''}`] : null,
    e.regEnd ? ['報名截止', fmtDT(e.regEnd)] : null,
    e.venue || e.address ? ['地點', `${esc(e.venue ?? '')}${e.address && e.address !== e.venue ? `<br><span class="meta">${esc(e.address)}</span>` : ''}`] : null,
    e.district ? ['行政區', esc(e.district)] : null,
    e.extra?.ages ? ['年齡', esc(e.extra.ages)] : null,
    e.extra?.seatsLeft != null ? ['名額', `線上剩 ${e.extra.seatsLeft} / ${e.extra.seats} 位（抓取當下）`] : null,
    e.extra?.status ? ['狀態', esc(e.extra.status)] : null,
    ['來源', esc([e.sourceName, ...(e.alsoIn ?? [])].join('、'))],
  ].filter(Boolean);
  const starred = S.starred.has(e.id);
  $('#detailBody').innerHTML = `
    <button class="icon-btn sheet-close" data-close aria-label="關閉">✕</button>
    ${e.image ? `<img class="cover" src="${esc(e.image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
    <h2>${esc(e.title)}</h2>
    <div class="tags" style="display:flex;gap:6px;flex-wrap:wrap">${regBadge(e)}<span class="tag cat">${esc(e.category)}</span>${e.free ? '<span class="tag free">免費</span>' : ''}</div>
    <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${k === '時間' ? esc(v) : v}</dd>`).join('')}</dl>
    ${e.summary ? `<p class="summary">${esc(e.summary)}</p>` : ''}
    <div class="row-btns">
      <button class="btn" data-star-detail="${esc(e.id)}">${starred ? '★ 已收藏（取消）' : '☆ 收藏並提醒我'}</button>
      ${e.url ? `<a class="btn ghost" href="${esc(e.url)}" target="_blank" rel="noopener">${e.regStart ? '前往報名頁' : '看詳情'}</a>` : ''}
    </div>
    <div class="row-btns">
      ${e.regStart ? `<a class="btn ghost small" href="/api/ics/${encodeURIComponent(e.id)}.ics?kind=reg">📅 報名時間加入行事曆</a>` : ''}
      ${e.start ? `<a class="btn ghost small" href="/api/ics/${encodeURIComponent(e.id)}.ics?kind=event">📅 活動加入行事曆</a>` : ''}
      <a class="btn ghost small" href="https://www.google.com/maps/search/?api=1&query=${mapQ}" target="_blank" rel="noopener">🗺 地圖</a>
      ${navigator.share ? `<button class="btn ghost small" data-share="${esc(e.id)}">分享</button>` : ''}
    </div>`;
  const dlg = $('#detail');
  if (!dlg.open) dlg.showModal();
  history.replaceState(null, '', `#event=${encodeURIComponent(e.id)}`);
}
function closeDetail() {
  const dlg = $('#detail');
  if (dlg.open) dlg.close();
  if (location.hash.startsWith('#event=')) history.replaceState(null, '', location.pathname);
}

// ---------- 收藏 ----------
async function toggleStar(id) {
  const on = !S.starred.has(id);
  on ? S.starred.add(id) : S.starred.delete(id);
  store.set('starred', [...S.starred]);
  $$(`[data-star="${CSS.escape(id)}"]`).forEach((b) => { b.classList.toggle('on', on); b.textContent = on ? '★' : '☆'; });
  if ($('#detail').open) openDetail(id);
  renderStar();
  const e = S.byId.get(id);
  if (S.subId) {
    try {
      await api('/api/star', { method: 'POST', body: { id: S.subId, eventId: id, on } });
    } catch (err) {
      if (err.status === 404) await resubscribe();
    }
    if (on) toast(e?.regStart && ms(e.regStart) > Date.now() ? '已收藏，開放報名前會提醒你' : '已收藏，活動前一天會提醒你');
  } else if (on) {
    toast('已收藏。到「設定」開啟通知才會提醒你');
  }
}

// ---------- 推播通知 ----------
let swReg = null;
async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    swReg = await navigator.serviceWorker.register('/sw.js');
    return swReg;
  } catch (err) {
    console.warn('service worker', err);
    return null;
  }
}
function urlB64ToUint8(b64) {
  const p = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
function currentPrefs() {
  return S.prefs ?? { notifyNew: true, categories: [], districts: [], keywords: [], includeBabycare: false, remindMinutes: [1440, 30, 5], remindEventDayBefore: true };
}

async function renderPush() {
  const status = $('#pushStatus');
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  $('#iosHelp').hidden = !(isIOS() && !isStandalone());
  let sub = null;
  if (supported && swReg) sub = await swReg.pushManager.getSubscription().catch(() => null);
  const on = Boolean(sub && S.subId);
  $('#enablePush').hidden = on;
  $('#testPush').hidden = !on;
  $('#disablePush').hidden = !on;
  if (!supported) {
    status.textContent = isIOS() && !isStandalone() ? '這個瀏覽器還不能收通知，請照下面步驟加入主畫面。' : '這個瀏覽器不支援網頁通知。';
    $('#enablePush').disabled = true;
    return;
  }
  $('#enablePush').disabled = false;
  if (Notification.permission === 'denied') {
    status.textContent = '通知被封鎖了。請到瀏覽器（或 iPhone 設定 → 通知 → 活動雷達）重新允許。';
  } else {
    status.textContent = on ? '✅ 通知已開啟。這台裝置會收到新活動和收藏活動的提醒。' : '還沒開啟。開啟後，有新活動、收藏的活動快開放報名時會跳通知。';
  }
}

async function enablePush() {
  try {
    if (!swReg) await registerSW();
    const { publicKey, ready } = await api('/api/vapid');
    if (!ready || !publicKey) throw new Error('伺服器還沒設定推播金鑰');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('沒有允許通知');
    let sub = await swReg.pushManager.getSubscription();
    if (!sub) sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(publicKey) });
    const r = await api('/api/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), prefs: currentPrefs(), starred: [...S.starred] } });
    S.subId = r.id;
    S.prefs = r.prefs;
    r.starred.forEach((id) => S.starred.add(id));
    store.set('subId', S.subId);
    store.set('prefs', S.prefs);
    store.set('starred', [...S.starred]);
    fillPrefs();
    toast('通知已開啟');
  } catch (err) {
    toast(`開啟通知失敗：${err.message}`);
  }
  renderPush();
  renderStar();
}

async function resubscribe() {
  if (!swReg) return;
  const sub = await swReg.pushManager.getSubscription().catch(() => null);
  if (!sub) { S.subId = null; store.set('subId', null); return; }
  const r = await api('/api/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), prefs: currentPrefs(), starred: [...S.starred] } });
  S.subId = r.id;
  store.set('subId', S.subId);
}

async function disablePush() {
  try {
    const sub = await swReg?.pushManager.getSubscription();
    if (S.subId) await api('/api/unsubscribe', { method: 'POST', body: { id: S.subId } }).catch(() => {});
    await sub?.unsubscribe();
  } finally {
    S.subId = null;
    store.set('subId', null);
    toast('通知已關閉');
    renderPush();
  }
}

// ---------- 設定 ----------
function buildPrefsForm() {
  $('#prefCats').innerHTML = CATEGORIES.filter((c) => c !== '親子館').map((c) => `<label class="check"><input type="checkbox" name="cat" value="${c}"> ${c}</label>`).join('');
  $('#prefDists').innerHTML = DISTRICTS.map((d) => `<label class="check"><input type="checkbox" name="dist" value="${d}"> ${d.replace('區', '')}</label>`).join('');
  $('#prefRemind').innerHTML = REMIND_OPTIONS.map(([v, t]) => `<label class="check"><input type="checkbox" name="remind" value="${v}"> ${t}</label>`).join('');
}
function fillPrefs() {
  const p = currentPrefs();
  const f = $('#prefsForm');
  f.notifyNew.checked = p.notifyNew;
  f.includeBabycare.checked = p.includeBabycare;
  f.remindEventDayBefore.checked = p.remindEventDayBefore;
  f.keywords.value = (p.keywords ?? []).join(', ');
  $$('input[name="cat"]', f).forEach((i) => (i.checked = p.categories.includes(i.value)));
  $$('input[name="dist"]', f).forEach((i) => (i.checked = p.districts.includes(i.value)));
  $$('input[name="remind"]', f).forEach((i) => (i.checked = p.remindMinutes.includes(Number(i.value))));
}
async function savePrefs(ev) {
  ev.preventDefault();
  const f = ev.target;
  const prefs = {
    notifyNew: f.notifyNew.checked,
    includeBabycare: f.includeBabycare.checked,
    remindEventDayBefore: f.remindEventDayBefore.checked,
    keywords: f.keywords.value.split(/[,，、\s]+/).filter(Boolean),
    categories: $$('input[name="cat"]:checked', f).map((i) => i.value),
    districts: $$('input[name="dist"]:checked', f).map((i) => i.value),
    remindMinutes: $$('input[name="remind"]:checked', f).map((i) => Number(i.value)),
  };
  S.prefs = prefs;
  store.set('prefs', prefs);
  if (S.subId) {
    try {
      const r = await api('/api/prefs', { method: 'POST', body: { id: S.subId, prefs } });
      S.prefs = r.prefs;
      store.set('prefs', S.prefs);
      $('#prefsMsg').textContent = '已儲存';
    } catch (err) {
      $('#prefsMsg').textContent = `儲存失敗：${err.message}`;
    }
  } else {
    $('#prefsMsg').textContent = '已存在這台裝置。開啟通知後會一起生效。';
  }
}

// ---------- 手動加入 ----------
function buildManualForm() {
  const f = $('#manualForm');
  f.category.innerHTML = CATEGORIES.filter((c) => c !== '親子館').map((c) => `<option>${c}</option>`).join('');
  f.district.innerHTML = '<option value="">不確定</option>' + DISTRICTS.map((d) => `<option>${d}</option>`).join('');
}
async function parsePaste() {
  const text = $('#pasteText').value.trim();
  const url = $('#pasteUrl').value.trim();
  if (!text && !url) return toast('先貼上活動文字');
  try {
    const d = await api('/api/parse', { method: 'POST', body: { text, url } });
    const f = $('#manualForm');
    f.hidden = false;
    f.title.value = d.title ?? '';
    f.start.value = toLocalInput(d.start);
    f.end.value = toLocalInput(d.end);
    f.regStart.value = toLocalInput(d.regStart);
    f.regEnd.value = toLocalInput(d.regEnd);
    f.venue.value = d.venue ?? '';
    f.url.value = d.url ?? url;
    const dist = DISTRICTS.find((x) => `${text}${d.venue ?? ''}`.includes(x));
    f.district.value = dist ?? '';
    if (d.category && CATEGORIES.includes(d.category) && d.category !== '親子館') f.category.value = d.category;
    f.note.value = d.announce ? `公布結果：${fmtDT(d.announce)}` : '';
    $('#keyRow').hidden = !S.manualNeedsKey;
    $('#foundDates').textContent = d.found?.length ? `找到的時間：${d.found.map((x) => `${fmtDT(x.iso)}（${{ event: '活動', eventEnd: '活動結束', regStart: '開放報名', regEnd: '截止', announce: '公布' }[x.kind]}）`).join('、')}` : '沒有找到日期，請自己填。';
    f.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    toast(`讀取失敗：${err.message}`);
  }
}
async function saveManual(ev) {
  ev.preventDefault();
  const f = ev.target;
  const body = {
    title: f.title.value.trim(),
    start: fromLocalInput(f.start.value),
    end: fromLocalInput(f.end.value),
    regStart: fromLocalInput(f.regStart.value),
    regEnd: fromLocalInput(f.regEnd.value),
    venue: f.venue.value.trim(),
    category: f.category.value,
    district: f.district.value || null,
    url: f.url.value.trim(),
    note: f.note.value.trim(),
    key: f.key.value,
  };
  try {
    const e = await api('/api/manual', { method: 'POST', body });
    S.events.unshift(e);
    S.byId.set(e.id, e);
    if (f.star.checked) await toggleStar(e.id);
    f.reset();
    f.hidden = true;
    $('#pasteText').value = '';
    $('#pasteUrl').value = '';
    renderAll();
    toast('已加入');
  } catch (err) {
    toast(err.message);
  }
}
async function deleteManual(id) {
  if (!confirm('確定刪除這個手動加入的活動？')) return;
  const key = S.manualNeedsKey ? prompt('手動加入密碼') ?? '' : '';
  try {
    await api(`/api/manual/${encodeURIComponent(id)}?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
    S.events = S.events.filter((e) => e.id !== id);
    S.byId.delete(id);
    renderAll();
    toast('已刪除');
  } catch (err) {
    toast(err.message);
  }
}

// ---------- 頁面切換 ----------
function go(view) {
  S.view = view;
  $$('.view').forEach((v) => (v.hidden = v.dataset.view !== view));
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.go === view));
  if (view === 'set') renderPush();
  window.scrollTo({ top: 0 });
}

function bind() {
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
  $('#whenChips').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-when]');
    if (!b) return;
    S.when = b.dataset.when;
    $$('#whenChips button').forEach((x) => x.classList.toggle('on', x === b));
    renderList();
  });
  let qTimer;
  $('#q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(renderList, 150); });
  for (const id of ['#catSel', '#distSel', '#hideBaby']) $(id).addEventListener('change', () => { store.set('filters', { cat: $('#catSel').value, dist: $('#distSel').value, hideBaby: $('#hideBaby').checked }); renderList(); });
  $('#regHideBaby').addEventListener('change', renderReg);

  document.addEventListener('click', (ev) => {
    const star = ev.target.closest('[data-star],[data-star-detail]');
    if (star) { ev.stopPropagation(); return toggleStar(star.dataset.star ?? star.dataset.starDetail); }
    const del = ev.target.closest('[data-del]');
    if (del) { ev.stopPropagation(); return deleteManual(del.dataset.del); }
    if (ev.target.closest('[data-close]')) return closeDetail();
    const share = ev.target.closest('[data-share]');
    if (share) {
      const e = S.byId.get(share.dataset.share);
      return navigator.share?.({ title: e.title, text: `${e.title}｜${fmtRange(e.start, e.end)}${e.venue ? `｜${e.venue}` : ''}`, url: e.url || location.href }).catch(() => {});
    }
    const evCard = ev.target.closest('.ev[data-id]');
    if (evCard && !ev.target.closest('a,button')) openDetail(evCard.dataset.id);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.matches?.('.ev[data-id]')) openDetail(ev.target.dataset.id);
  });
  $('#detail').addEventListener('click', (ev) => { if (ev.target.id === 'detail') closeDetail(); });
  $('#detail').addEventListener('close', () => { if (location.hash.startsWith('#event=')) history.replaceState(null, '', location.pathname); });

  $('#refreshBtn').addEventListener('click', async () => { await loadEvents(); renderAll(); toast('已更新'); });
  $('#enablePush').addEventListener('click', enablePush);
  $('#disablePush').addEventListener('click', disablePush);
  $('#testPush').addEventListener('click', async () => {
    try { await api('/api/test-push', { method: 'POST', body: { id: S.subId } }); toast('已送出，幾秒內會收到'); }
    catch (err) { toast(`失敗：${err.message}`); if (err.status === 404) { await resubscribe(); renderPush(); } }
  });
  $('#prefsForm').addEventListener('submit', savePrefs);
  $('#parseBtn').addEventListener('click', parsePaste);
  $('#manualForm').addEventListener('submit', saveManual);
  $('#cancelManual').addEventListener('click', () => { $('#manualForm').hidden = true; });
  navigator.serviceWorker?.addEventListener('message', (ev) => { if (ev.data?.type === 'open') handleHash(ev.data.url); });
  window.addEventListener('hashchange', () => handleHash(location.hash));
}

function handleHash(hash) {
  const h = String(hash ?? '').replace(/^.*#/, '#');
  const m = h.match(/^#event=(.+)$/);
  if (m) { go('list'); openDetail(decodeURIComponent(m[1])); }
  if (h === '#new') go('list');
}

async function init() {
  $('#catSel').innerHTML += CATEGORIES.map((c) => `<option>${c}</option>`).join('');
  $('#distSel').innerHTML += DISTRICTS.map((d) => `<option>${d}</option>`).join('');
  const f = store.get('filters', null);
  if (f) { $('#catSel').value = f.cat ?? ''; $('#distSel').value = f.dist ?? ''; $('#hideBaby').checked = f.hideBaby ?? true; }
  buildPrefsForm();
  buildManualForm();
  fillPrefs();
  bind();
  registerSW().then(() => renderPush());
  await loadEvents();
  renderAll();
  handleHash(location.hash);
  // 這次看到的時間，下次用來標「新」
  setTimeout(() => store.set('lastVisit', new Date().toISOString()), 1500);
  // 同步伺服器上的收藏和設定（另一台裝置也可能改過）
  if (S.subId) {
    api(`/api/me?id=${S.subId}`).then((r) => {
      r.starred.forEach((id) => S.starred.add(id));
      store.set('starred', [...S.starred]);
      S.prefs = r.prefs;
      store.set('prefs', r.prefs);
      fillPrefs();
      renderStar();
    }).catch((err) => { if (err.status === 404) resubscribe().catch(() => {}); });
  }
  // 倒數每分鐘更新
  setInterval(() => { if (S.view === 'reg') renderReg(); }, 60000);
}

init();
