// 活動雷達：前端。資料從 /api/events 來，收藏存在本機，開啟通知後同步到伺服器。

const CATEGORIES = ['免費', '表演', '展覽', '講座課程', '親子', '親子館', '節慶市集', '體驗', '運動', '電影', '其他'];
const CITIES = ['臺北市', '新北市', '桃園市', '臺中市', '臺南市', '高雄市', '基隆市', '新竹市', '嘉義市', '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣', '臺東縣', '澎湖縣', '金門縣', '連江縣'];
const REMIND_OPTIONS = [[1440, '1 天前'], [180, '3 小時前'], [60, '1 小時前'], [30, '30 分鐘前'], [10, '10 分鐘前'], [5, '5 分鐘前']];
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;

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
  starred: new Set(store.get('starred', [])),
  subId: store.get('subId', null),
  prefs: store.get('prefs', null),
  view: 'list',
  when: 'all',
  quick: new Set(),
  // 鈴鐺：baseline 之後新增、而且還沒讀過的活動算未讀
  baseline: store.get('baseline', null),
  // 舊版的「已讀＝從清單移除」轉成「刪除」
  opened: new Set(store.get('opened', [])),
  deleted: new Set([...store.get('deleted', []), ...store.get('read', [])]),
  starMeta: store.get('starMeta', {}),
  syncCode: store.get('syncCode', null),
  sites: null,
};

// ---------- 時間（一律以台北時間顯示） ----------
const isDateOnly = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '');
const ms = (s) => (!s ? NaN : isDateOnly(s) ? Date.parse(`${s}T00:00:00+08:00`) : Date.parse(s));
function tp(t) {
  const d = new Date(t + 8 * 3600000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), w: d.getUTCDay(), hh: d.getUTCHours(), mi: d.getUTCMinutes() };
}
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (t) => { const x = tp(t); return `${x.y}-${pad(x.m)}-${pad(x.d)}`; };
const todayKey = () => dayKey(Date.now());
const hasTime = (s) => s && !isDateOnly(s) && fmtTime(s) !== '00:00';

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
const fmtDT = (s) => (s ? `${fmtDate(s)}${hasTime(s) ? ` ${fmtTime(s)}` : ''}` : '');
function fmtRange(a, b) {
  if (!a) return '';
  if (!b || b === a) return fmtDT(a);
  if (dayKey(ms(a)) === dayKey(ms(b))) {
    const t2 = fmtTime(b);
    return `${fmtDT(a)}${hasTime(b) && t2 !== fmtTime(a) ? `–${t2}` : ''}`;
  }
  return `${fmtDate(a)} ～ ${fmtDate(b)}`;
}
function countdown(target) {
  const diff = ms(target) - Date.now();
  if (diff <= 0) return '已開放';
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m} 分鐘後`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} 小時${m % 60 ? ` ${m % 60} 分` : ''}後`;
  return `${Math.floor(h / 24)} 天後`;
}
function relDay(key) {
  if (key === todayKey()) return '今天';
  if (key === dayKey(Date.now() + 86400000)) return '明天';
  if (key === dayKey(Date.now() + 2 * 86400000)) return '後天';
  return '';
}

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
const catsOf = (e) => (e.categories?.length ? e.categories : [e.category, ...(e.free ? ['免費'] : [])]);
const cityOf = (e) => e.city ?? '桃園市';
// 地區：台北市和新北市算同一區
const REGIONS = [['桃園', ['桃園市']], ['台北・新北', ['臺北市', '新北市']]];
// 卡片上的地區：桃園只寫區名；台北、新北前面加縣市（例如「新北板橋區」）
const areaOf = (e) => {
  const c = cityOf(e);
  if (c === '桃園市') return e.district || null;
  const short = c.replace(/^臺/, '台').replace(/市$/, '');
  return e.district ? `${short}${e.district}` : short;
};
const regionOf = (e) => REGIONS.find(([, cs]) => cs.includes(cityOf(e)))?.[0] ?? cityOf(e);
// 收藏時把提醒需要的欄位一起送到伺服器（伺服器不用每分鐘讀整份活動資料）
const snapshotOf = (e) => ({ id: e.id, title: e.title, start: e.start, end: e.end, regStart: e.regStart, regEnd: e.regEnd, url: e.url, venue: e.venue, district: e.district });
const starredSnapshots = () => [...S.starred].map((id) => S.byId.get(id)).filter(Boolean).map(snapshotOf);
const isFull = (e) => /額滿/.test(e.extra?.status ?? '') || e.extra?.seatsLeft === 0;

// ---------- 資料 ----------
async function loadEvents() {
  try {
    const data = await api('/api/events');
    // Cloudflare 版回傳 { status, data: { updatedAt, events } }；舊版是 { updatedAt, events, status }
    const body = data.data ?? data;
    S.events = body.events ?? [];
    S.status = data.status;
    S.updatedAt = body.updatedAt;
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
  fillCitySelect();
}

// ---------- 活動卡片 ----------
function regTag(e, mode) {
  const now = Date.now();
  if (isFull(e)) return '<span class="tag full">已額滿</span>';
  // 搶報名頁左邊方塊已經是開放日期，標籤只顯示倒數
  if (e.regStart && ms(e.regStart) > now && mode === 'reg') return `<span class="tag reg">${countdown(e.regStart)}開放報名</span>`;
  if (e.regStart && ms(e.regStart) > now) return `<span class="tag reg">${esc(fmtDate(e.regStart))}${hasTime(e.regStart) ? ` ${fmtTime(e.regStart)}` : ''} 開放報名</span>`;
  if (e.regStart && (!e.regEnd || ms(e.regEnd) > now) && ms(e.end ?? e.start) > now) return `<span class="tag reg now">報名中${e.regEnd ? `・${esc(fmtDate(e.regEnd))}截止` : ''}</span>`;
  return '';
}

/** 活動是哪個單位辦的（主辦、局處、場館，最後才用資料來源）。 */
function unitOf(e) {
  const org = e.extra?.organizer || e.extra?.office;
  if (org && !/^(桃園市政府)$/.test(org)) return org;
  return e.venue || org || e.sourceName;
}

/** 小小的時間狀態：今天、明天、N 天後、進行中・剩 N 天、今天結束。 */
function whenLabel(e) {
  const today = ms(todayKey());
  const s = ms(dayKey(ms(e.start)));
  const end = ms(dayKey(ms(e.end ?? e.start)));
  const days = (a, b) => Math.round((a - b) / 86400000);
  if (s > today) {
    const n = days(s, today);
    if (n === 1) return '<span class="when soon">明天</span>';
    return `<span class="when ${n <= 3 ? 'soon' : ''}">${n} 天後</span>`;
  }
  if (end === today) return s === today ? '<span class="when today">今天</span>' : '<span class="when ending">今天結束</span>';
  if (end > today && s <= today) {
    const left = days(end, today);
    return `<span class="when ${left <= 3 ? 'ending' : ''}">進行中・剩 ${left} 天</span>`;
  }
  return '';
}

/** 卡片上的時間（小字）。mode=time 時已經依日期分組，只顯示幾點或展期。 */
function timeText(e, mode) {
  if (mode === 'reg') return `報名 ${fmtDT(e.regStart)}`;
  const multi = e.end && dayKey(ms(e.end)) !== dayKey(ms(e.start));
  if (mode === 'time') {
    if (multi) return `${fmtDate(e.start)} ～ ${fmtDate(e.end)}`;
    if (hasTime(e.start)) return `${fmtTime(e.start)}${hasTime(e.end) && e.end !== e.start ? `–${fmtTime(e.end)}` : ''}`;
    return '全天';
  }
  return fmtRange(e.start, e.end);
}

function card(e, mode = 'time') {
  const isNew = isUnread(e);
  const cats = catsOf(e);
  const unit = unitOf(e);
  const place = [e.venue && e.venue !== unit ? e.venue : null, areaOf(e)].filter(Boolean).join('・');
  const seats = e.extra?.seatsLeft != null && e.extra.seatsLeft > 0 ? `<span class="tag">剩 ${e.extra.seatsLeft} 位</span>` : '';
  const thumb = e.image ? `<img class="thumb" src="${esc(e.image)}" alt="" loading="lazy" onerror="this.closest('.ev').classList.remove('has-thumb');this.remove()">` : '';
  return `
    <article class="ev ${e.image ? 'has-thumb' : ''}" data-id="${esc(e.id)}" tabindex="0">
      <div class="ev-body">
        <div class="unit">${icon('building')}<span>${esc(unit)}</span></div>
        <div class="t">${esc(e.title)}</div>
        <div class="line">${whenLabel(e)}<span>${icon('clock')}${esc(timeText(e, mode))}</span>${place ? `<span class="place">${icon('pin')}${esc(place)}</span>` : ''}</div>
        <div class="tags">
          ${isNew ? '<span class="tag new">NEW</span>' : ''}
          ${regTag(e, mode)}
          ${cats.includes('免費') ? '<span class="tag free">免費</span>' : ''}
          ${cats.filter((c) => c !== '免費').slice(0, 2).map((c) => `<span class="tag cat">${esc(c)}</span>`).join('')}
          ${seats}
        </div>
      </div>
      ${thumb}
      <button class="star-btn ${S.starred.has(e.id) ? 'on' : ''}" data-star="${esc(e.id)}" aria-label="收藏">${icon(S.starred.has(e.id) ? 'star-fill' : 'star')}</button>
    </article>`;
}

// ---------- 鈴鐺：未讀的新活動 ----------
/** 第一次使用時，把最近 24 小時新增的活動算成未讀；之後新增的也都算。 */
function ensureBaseline() {
  if (!S.baseline) {
    S.baseline = new Date(Date.now() - 86400000).toISOString();
    store.set('baseline', S.baseline);
  }
}
// 通知頁：基準時間之後新增的活動都會列出來，要自己按 ✕ 刪掉才會消失；點開看過的只是變成「已讀」
const inInbox = (e) => Boolean(S.baseline && e.firstSeen && e.firstSeen > S.baseline && !S.deleted.has(e.id) && e.category !== '親子館');
const isUnread = (e) => inInbox(e) && !S.opened.has(e.id);
const inboxList = () => S.events.filter(inInbox).sort((a, b) => (b.firstSeen > a.firstSeen ? 1 : -1));
const unreadList = () => inboxList().filter((e) => !S.opened.has(e.id));

function saveInboxState() {
  // 只保留還存在的活動，避免越存越大
  const alive = new Set(S.events.map((e) => e.id));
  if (alive.size) {
    S.opened = new Set([...S.opened].filter((id) => alive.has(id)));
    S.deleted = new Set([...S.deleted].filter((id) => alive.has(id)));
  }
  store.set('opened', [...S.opened]);
  store.set('deleted', [...S.deleted]);
  pushSync();
}
function markOpened(ids) {
  for (const id of ids) S.opened.add(id);
  saveInboxState();
  renderBell();
}
function deleteFromInbox(ids) {
  for (const id of ids) S.deleted.add(id);
  saveInboxState();
  renderBell();
}

function renderBell() {
  const n = unreadList().length;
  const badge = $('#bellBadge');
  badge.hidden = n === 0;
  badge.textContent = n > 99 ? '99+' : String(n);
  $('#bellBtn').setAttribute('aria-label', n ? `${n} 個未讀新活動` : '新活動');
  if (S.view === 'inbox') renderInbox();
}

/** 通知頁標示的縣市（加上行政區）：「台北市・大安區」 */
const cityLabel = (e) => [cityOf(e).replace(/^臺/, '台'), e.district].filter(Boolean).join('・');

function renderInbox() {
  const list = inboxList();
  const unread = list.filter((e) => !S.opened.has(e.id)).length;
  $('#inboxHint').textContent = list.length ? `${list.length} 個新活動，${unread} 個未讀。看過的會留著，按 ✕ 才會刪掉。` : '';
  $('#inboxTools').hidden = !list.length;
  $('#inboxList').innerHTML = list.length
    ? list
        .map((e) => {
          const read = S.opened.has(e.id);
          return `<div class="inbox-item ${read ? 'read' : ''}" data-inbox="${esc(e.id)}">
            <span class="dot" aria-hidden="true"></span>
            <div class="body"><div class="t">${esc(e.title)}</div><div class="s">${esc(unitOf(e))}・${esc(fmtRange(e.start, e.end))}</div><div class="tags" style="margin-top:5px"><span class="tag city">${icon('pin')}${esc(cityLabel(e))}</span>${regTag(e)}${catsOf(e).slice(0, 3).map((c) => `<span class="tag ${c === '免費' ? 'free' : 'cat'}">${esc(c)}</span>`).join('')}</div></div>
            <button class="x" data-dismiss="${esc(e.id)}" aria-label="刪除這則">${icon('x')}</button>
          </div>`;
        })
        .join('')
    : '<div class="empty"><b>🔔</b>沒有新活動<br>有新活動時會出現在這裡</div>';
}

// 通知頁往右滑：畫面跟著手指移動，滑超過四分之一就回主畫面
function bindInboxSwipe() {
  const el = $('#view-inbox');
  let x0 = 0, y0 = 0, dx = 0, mode = null;
  el.addEventListener('touchstart', (ev) => {
    if (ev.touches.length !== 1) return;
    x0 = ev.touches[0].clientX; y0 = ev.touches[0].clientY; dx = 0; mode = null;
    el.classList.remove('swipe-back');
  }, { passive: true });
  el.addEventListener('touchmove', (ev) => {
    const t = ev.touches[0];
    const mx = t.clientX - x0, my = t.clientY - y0;
    if (!mode && (Math.abs(mx) > 10 || Math.abs(my) > 10)) mode = mx > 0 && Math.abs(mx) > Math.abs(my) * 1.3 ? 'h' : 'v';
    if (mode !== 'h') return;
    if (ev.cancelable) ev.preventDefault();
    dx = Math.max(0, mx);
    el.classList.add('swiping');
    el.style.transform = `translateX(${dx}px)`;
    el.style.opacity = String(1 - Math.min(dx / innerWidth, 1) * 0.5);
  }, { passive: false });
  const end = () => {
    if (mode !== 'h') return;
    el.classList.remove('swiping');
    el.classList.add('swipe-back');
    if (dx > innerWidth * 0.25) {
      el.style.transform = `translateX(${innerWidth}px)`; el.style.opacity = '0';
      setTimeout(() => { el.classList.remove('swipe-back'); go('list'); }, 200);
    } else {
      el.style.transform = ''; el.style.opacity = '';
    }
    mode = null;
  };
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', end);
}

let viewBeforeInbox = 'list';
function openInbox() {
  if (S.view !== 'inbox') viewBeforeInbox = S.view;
  go('inbox');
}
function closeInbox() {
  go(viewBeforeInbox || 'list');
}

// ---------- 配對碼同步：已讀、刪除、收藏在手機和電腦之間同步 ----------
function syncPayload() {
  return { opened: [...S.opened], deleted: [...S.deleted], stars: S.starMeta, baseline: S.baseline };
}
function applySync(data) {
  if (!data) return;
  let changed = false;
  for (const id of data.opened ?? []) if (!S.opened.has(id)) { S.opened.add(id); changed = true; }
  for (const id of data.deleted ?? []) if (!S.deleted.has(id)) { S.deleted.add(id); changed = true; }
  if (data.baseline && (!S.baseline || data.baseline < S.baseline)) { S.baseline = data.baseline; store.set('baseline', S.baseline); changed = true; }
  const starChanges = [];
  for (const [id, v] of Object.entries(data.stars ?? {})) {
    const mine = S.starMeta[id];
    if (!mine || v[1] > mine[1]) {
      S.starMeta[id] = v;
      const on = Boolean(v[0]);
      if (on !== S.starred.has(id)) { on ? S.starred.add(id) : S.starred.delete(id); starChanges.push([id, on]); }
    }
  }
  store.set('opened', [...S.opened]);
  store.set('deleted', [...S.deleted]);
  store.set('starMeta', S.starMeta);
  store.set('starred', [...S.starred]);
  // 收藏變了，通知伺服器（提醒才會跟著改）
  if (S.subId) for (const [id, on] of starChanges) {
    const e = S.byId.get(id);
    api('/api/star', { method: 'POST', body: { id: S.subId, eventId: id, on, ev: e ? snapshotOf(e) : undefined } }).catch(() => {});
  }
  if (changed || starChanges.length) { renderBell(); renderList(); renderStar(); if (S.view === 'reg') renderReg(); }
}
let syncTimer = null;
function pushSync() {
  if (!S.syncCode) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      const r = await api(`/api/sync/${S.syncCode}`, { method: 'PUT', body: { data: syncPayload() } });
      applySync(r.data);
    } catch (err) {
      if (err.status === 404) { S.syncCode = null; store.set('syncCode', null); renderSyncCard(); }
    }
  }, 1200);
}
async function pullSync() {
  if (!S.syncCode) return;
  try {
    const r = await api(`/api/sync/${S.syncCode}`);
    applySync(r.data);
    pushSync(); // 把這台的變更也送上去
  } catch (err) {
    if (err.status === 404) { S.syncCode = null; store.set('syncCode', null); renderSyncCard(); toast('配對碼已失效'); }
  }
}
function renderSyncCard() {
  const on = Boolean(S.syncCode);
  $('#syncOff').hidden = on;
  $('#syncOn').hidden = !on;
  if (on) $('#syncCode').textContent = `${S.syncCode.slice(0, 4)} ${S.syncCode.slice(4)}`;
}
async function createSyncCode() {
  try {
    const r = await api('/api/sync', { method: 'POST', body: { data: syncPayload() } });
    S.syncCode = r.code;
    store.set('syncCode', r.code);
    renderSyncCard();
    toast('配對碼已產生，在另一台裝置輸入這組碼');
  } catch (err) {
    toast(`產生失敗：${err.message}`);
  }
}
async function joinSyncCode() {
  const code = $('#syncInput').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 8) return toast('配對碼是 8 個英數字');
  try {
    const r = await api(`/api/sync/${code}`);
    S.syncCode = code;
    store.set('syncCode', code);
    applySync(r.data);
    pushSync();
    $('#syncInput').value = '';
    renderSyncCard();
    toast('配對成功，已讀和收藏會在兩台裝置同步');
  } catch (err) {
    toast(err.status === 404 ? '找不到這個配對碼' : `配對失敗：${err.message}`);
  }
}

// ---------- 外部連結：iPhone 加入主畫面後，改用 Safari 開（不然會開在 App 裡的小視窗） ----------
function openExternal(url) {
  if (isIOS() && isStandalone() && /^https?:\/\//.test(url)) {
    // iOS 17 以上支援 x-safari-https://，直接跳到 Safari；舊版沒反應時改用一般方式開
    // 跳到 Safari 時 App 會被切到背景；只要發生過一次，就記住這台手機可以直接跳，之後不再用備援方式開（避免 App 裡也跳出網頁）
    let left = false;
    const t0 = Date.now();
    const mark = () => { if (left || Date.now() - t0 > 2400) return; left = true; store.set('safariJumpOK', true); };
    window.addEventListener('blur', mark, { once: true });
    window.addEventListener('pagehide', mark, { once: true });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') mark(); }, { once: true });
    location.href = url.replace(/^http(s?):\/\//, 'x-safari-http$1://');
    if (store.get('safariJumpOK', false)) return;
    // 第一次、而且 2.5 秒內 App 都沒有被切走，才當作這支手機不支援，改用一般方式開
    setTimeout(() => { if (!left && document.visibilityState === 'visible') window.open(url, '_blank'); }, 2500);
    return;
  }
  window.open(url, '_blank', 'noopener');
}

// ---------- 網站頁 ----------
async function loadSites() {
  if (S.sites) return S.sites;
  try {
    S.sites = (await (await fetch('/sites.json')).json()).sites;
  } catch {
    S.sites = [];
  }
  return S.sites;
}
async function renderSites() {
  const sites = await loadSites();
  const q = $('#siteQ').value.trim().toLowerCase();
  const region = $('#regionChips .chip.on')?.dataset.region ?? '';
  const REGION_NAME = { 桃園: '桃園', 台北: '台北・新北', 全台: '全台平台' };
  const inRegion = sites.filter((s) => !region || s.region === region);
  const list = inRegion.filter((s) => !q || `${s.name} ${s.category} ${s.url}`.toLowerCase().includes(q));
  const groups = new Map();
  for (const s of list) {
    const g = region ? s.category : `${REGION_NAME[s.region] ?? s.region}・${s.category}`;
    (groups.get(g) ?? groups.set(g, []).get(g)).push(s);
  }
  const autoN = inRegion.filter((s) => s.auto).length;
  const viaN = inRegion.filter((s) => !s.auto && s.via).length;
  $('#sitesHint').textContent = `${region ? REGION_NAME[region] : '全部'}共 ${inRegion.length} 個網站：${autoN} 個「自動收錄」（直接抓它的網站），${viaN} 個「間接收錄」（它的活動透過其他平台抓進來），其他 ${inRegion.length - autoN - viaN} 個要自己上網站看。`;
  $('#siteList').innerHTML =
    [...groups]
      .map(([cat, items]) => `<div class="site-group"><h3>${esc(cat)} <small>${items.length}</small></h3><div class="site-card">${items
        .map((s) => {
          const host = new URL(s.url).hostname.replace(/^www\./, '');
          return `<a class="site" href="${esc(s.url)}" target="_blank" rel="noopener"><img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64" alt="" loading="lazy" onerror="this.style.visibility='hidden'"><span class="n"><b>${esc(s.name)}</b><small>${s.via && !s.auto ? `經由 ${esc(s.via.join('、'))}` : esc(host)}</small></span>${s.auto ? '<span class="tag free">自動收錄</span>' : s.via ? '<span class="tag via">間接收錄</span>' : ''}</a>`;
        })
        .join('')}</div></div>`)
      .join('') || '<div class="empty">找不到符合的網站</div>';
}

// ---------- 主題 ----------
const THEMES = [
  // id, 名稱, 主色, 副色, 淺色背景, 深色背景
  ['peach', '蜜桃', '#e0475f', '#f08a5d', '#fbefec', '#1b1214'],
  ['ocean', '海洋', '#1f74d1', '#1fb5c9', '#e8f2fb', '#0c1522'],
  ['forest', '森林', '#2f8a4c', '#98bd36', '#ecf4e8', '#0e1810'],
  ['lavender', '薰衣草', '#7a55d6', '#d26fc0', '#f2edfb', '#15111f'],
  ['sunset', '夕陽', '#e8641e', '#f2b33d', '#fdf1e4', '#1c130b'],
  ['mono', '黑白', '#262626', '#8a8a8a', '#f2f2f2', '#0f0f0f'],
];
const isDark = () => document.documentElement.dataset.mode === 'dark' || (document.documentElement.dataset.mode !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
function applyTheme(theme, mode) {
  const root = document.documentElement;
  if (theme) { root.dataset.theme = theme; store.set('theme', theme); }
  if (mode) { root.dataset.mode = mode; store.set('mode', mode); }
  $$('.theme-opt').forEach((b) => b.classList.toggle('on', b.dataset.theme === root.dataset.theme));
  $$('#modePick button').forEach((b) => b.classList.toggle('on', b.dataset.mode === root.dataset.mode));
  // 手機狀態列顏色跟著背景
  const t = THEMES.find((x) => x[0] === root.dataset.theme) ?? THEMES[0];
  $$('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', isDark() ? t[5] : t[4]));
}
function buildThemePicker() {
  $('#themePick').innerHTML = THEMES.map(([id, name, a, b, light, dark]) => {
    const bg = isDark() ? dark : light;
    return `<button type="button" class="theme-opt" data-theme="${id}" style="background:${bg};color:${isDark() ? '#f3eee9' : '#1f1b18'}"><span class="sw" style="background:radial-gradient(circle at 85% 15%, ${b}, transparent 60%), linear-gradient(135deg, ${a}, ${b})"></span>${name}</button>`;
  }).join('');
  applyTheme();
}

// ---------- 活動列表 ----------
function inWhen(e, when) {
  if (when === 'all') return true;
  const start = ms(e.start);
  const end = ms(e.end ?? e.start) || start;
  const today0 = ms(todayKey());
  let from = today0;
  let to;
  if (when === 'today') to = today0 + 86400000;
  if (when === 'week') to = today0 + 7 * 86400000;
  if (when === 'month') to = today0 + 30 * 86400000;
  if (when === 'weekend') {
    const w = tp(Date.now()).w;
    if (w === 0) { from = today0; to = today0 + 86400000; }
    else { from = today0 + (6 - w) * 86400000; to = from + 2 * 86400000; }
  }
  return start < to && end >= from;
}

function filtered() {
  const q = $('#q').value.trim().toLowerCase();
  const cat = $('#catSel').value;
  const city = $('#citySel').value;
  const hideBaby = $('#hideBaby').checked;
  const quick = [...S.quick];
  return S.events.filter((e) => {
    if (hideBaby && e.category === '親子館' && cat !== '親子館') return false;
    if (cat && !catsOf(e).includes(cat)) return false;
    if (quick.length && !quick.every((c) => catsOf(e).includes(c))) return false;
    if (city && regionOf(e) !== city) return false;
    if (!inWhen(e, S.when)) return false;
    if (q && !`${e.title} ${e.venue ?? ''} ${e.district ?? ''} ${cityOf(e)} ${e.sourceName} ${e.summary ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderList() {
  const list = filtered();
  const today = todayKey();
  const ongoing = [];
  const groups = new Map();
  for (const e of list) {
    const k = dayKey(ms(e.start));
    if (k < today) ongoing.push(e);
    else (groups.get(k) ?? groups.set(k, []).get(k)).push(e);
  }
  let html = '';
  for (const k of [...groups.keys()].sort()) {
    const items = groups.get(k);
    html += `<div class="day-head">${esc(fmtDate(k))}${relDay(k) ? `<span class="rel">${relDay(k)}</span>` : ''}<span class="sub">${items.length} 個</span></div>`;
    html += items.map((e) => card(e, 'time')).join('');
  }
  if (ongoing.length) {
    ongoing.sort((a, b) => ms(a.end) - ms(b.end));
    html += `<div class="day-head">進行中<span class="sub">${ongoing.length} 個・依結束日排序</span></div>` + ongoing.map((e) => card(e, 'time')).join('');
  }
  $('#list').innerHTML = html || '<div class="empty"><b>🔍</b>沒有符合條件的活動</div>';
  const newCount = unreadList().length;
  $('#listMeta').textContent = `共 ${list.length} 個活動${newCount ? `・${newCount} 個新活動未讀` : ''}${S.updatedAt ? `・更新於 ${fmtDT(S.updatedAt)}` : ''}`;
}

function renderReg() {
  const now = Date.now();
  const hideBaby = $('#regHideBaby').checked;
  const freeOnly = $('#regFreeOnly').checked;
  const items = S.events.filter((e) => {
    if (!e.regStart || isFull(e)) return false;
    if (hideBaby && e.category === '親子館') return false;
    if (freeOnly && !catsOf(e).includes('免費')) return false;
    if (ms(e.regStart) > now) return true;
    return (!e.regEnd || ms(e.regEnd) > now) && ms(e.end ?? e.start) > now;
  });
  const upcoming = items.filter((e) => ms(e.regStart) > now).sort((a, b) => ms(a.regStart) - ms(b.regStart));
  const open = items.filter((e) => ms(e.regStart) <= now).sort((a, b) => (ms(a.regEnd) || ms(a.start)) - (ms(b.regEnd) || ms(b.start)));
  let html = '';
  if (upcoming.length) html += `<div class="day-head">即將開放<span class="sub">${upcoming.length} 個</span></div>` + upcoming.map((e) => card(e, 'reg')).join('');
  if (open.length) html += `<div class="day-head">報名中<span class="sub">${open.length} 個</span></div>` + open.map((e) => card(e, 'date')).join('');
  $('#regList').innerHTML = html || '<div class="empty"><b>⏰</b>目前沒有需要搶報名的活動</div>';
}

function renderStar() {
  const key = (e) => (e.regStart && ms(e.regStart) > Date.now() ? ms(e.regStart) : ms(e.start));
  const items = [...S.starred].map((id) => S.byId.get(id)).filter(Boolean).sort((a, b) => key(a) - key(b));
  const missing = S.starred.size - items.length;
  $('#starHint').textContent = S.subId
    ? '收藏的活動會在開放報名前、以及活動前一天提醒你。'
    : '要到「設定」開啟通知，收藏的活動才會提醒你。也可以在活動裡按「加入行事曆」。';
  $('#starList').innerHTML =
    (items.map((e) => card(e, e.regStart && ms(e.regStart) > Date.now() ? 'reg' : 'date')).join('') || '<div class="empty"><b>☆</b>還沒有收藏<br>在活動上按星號就會出現在這裡</div>') +
    (missing > 0 ? `<p class="meta">另有 ${missing} 個收藏的活動已經結束</p>` : '');
}

function renderSources() {
  const st = S.status;
  $('#srcUpdated').textContent = st ? `上次抓取：${fmtDT(st.updatedAt)}，共 ${st.total} 個活動` : '還沒有抓取紀錄';
  $('#srcList').innerHTML = (st?.sources ?? [])
    .map((s) => `<li><span>${esc(s.name)}</span><span class="${s.ok ? 'ok' : 'bad'}">${s.ok ? `${s.kept} 個` : `失敗：${esc(s.error ?? '')}`}</span></li>`)
    .join('');
}

function fillCitySelect() {
  const sel = $('#citySel');
  const cur = sel.value || store.get('filters', {})?.city || '';
  const order = REGIONS.map(([r]) => r);
  const present = [...new Set(S.events.map(regionOf))].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  sel.innerHTML = '<option value="">所有地區</option>' + present.map((c) => `<option>${c}</option>`).join('');
  if (present.includes(cur)) sel.value = cur;
}

function renderAll() {
  renderList();
  renderReg();
  renderStar();
  renderSources();
  renderBell();
}

// ---------- 活動詳情 ----------
let lockedY = 0;
function lockScroll() {
  lockedY = document.body.scrollTop;
  document.body.classList.add('locked');
}
function unlockScroll() {
  if (!document.body.classList.contains('locked')) return;
  document.body.classList.remove('locked');
  document.body.scrollTop = lockedY;
}

function openDetail(id) {
  const e = S.byId.get(id);
  if (!e) return;
  const mapQ = encodeURIComponent(e.address || [e.venue, e.district, cityOf(e)].filter(Boolean).join(' '));
  const cats = catsOf(e);
  const starred = S.starred.has(e.id);
  const priceText = e.free === true ? '免費' : e.free === false ? (e.extra?.prices?.join('、') || '需付費') : '';
  if (isUnread(e)) markOpened([e.id]);
  const rows = [
    ['building', '單位', esc(unitOf(e))],
    ['clock', '時間', esc(fmtRange(e.start, e.end) + (e.extra?.note ? `（${e.extra.note}）` : ''))],
    e.regStart ? ['ticket', '開放報名', `${esc(fmtDT(e.regStart))}${ms(e.regStart) > Date.now() ? ` <span class="countdown">${countdown(e.regStart)}</span>` : ''}${e.regEnd ? `<br><span class="k">截止 ${esc(fmtDT(e.regEnd))}</span>` : ''}`] : null,
    e.venue || e.address ? ['pin', '地點', `${esc(e.venue ?? e.address)}${e.address && e.address !== e.venue ? `<br><span class="k">${esc(e.address)}</span>` : ''}<br><a href="https://www.google.com/maps/search/?api=1&query=${mapQ}" target="_blank" rel="noopener">在地圖上看</a>`] : null,
    priceText || e.extra?.entry ? ['coin', '費用', esc(e.extra?.entry || priceText)] : null,
    e.extra?.ages ? ['info', '年齡', esc(e.extra.ages)] : null,
    e.extra?.seatsLeft != null ? ['info', '名額', `線上剩 ${e.extra.seatsLeft} / ${e.extra.seats} 位<span class="k">（抓取當下）</span>`] : null,
    e.extra?.status ? ['info', '狀態', esc(e.extra.status)] : null,
    ['link', '來源', esc([e.sourceName, ...(e.alsoIn ?? [])].join('、'))],
  ].filter(Boolean);

  $('#detailBody').innerHTML = `
    <div class="hero ${e.image ? '' : 'noimg'}">
      ${e.image ? `<img src="${esc(e.image)}" alt="" onerror="this.parentElement.classList.add('noimg');this.remove()">` : ''}
      <div class="grab"></div>
      <div class="hero-btns">
        <button class="round" data-close aria-label="關閉">${icon('x')}</button>
        <button class="round ${starred ? 'on' : ''}" data-star-detail="${esc(e.id)}" aria-label="收藏">${icon(starred ? 'star-fill' : 'star')}</button>
      </div>
    </div>
    <div class="d-body">
      <div class="tags">${regTag(e)}${cats.includes('免費') ? '<span class="tag free">免費</span>' : ''}${cats.filter((c) => c !== '免費').map((c) => `<span class="tag cat">${esc(c)}</span>`).join('')}</div>
      <h2>${esc(e.title)}</h2>
      <div class="info">
        ${rows.map(([ic, k, v]) => `<div class="info-row">${icon(ic)}<div><div class="k">${k}</div><div class="v">${v}</div></div></div>`).join('')}
      </div>
      <div class="d-more">
        ${e.regStart ? `<a class="btn ghost small" href="/api/ics/${encodeURIComponent(e.id)}.ics?kind=reg">${icon('cal')}報名時間加入行事曆</a>` : ''}
        ${e.start ? `<a class="btn ghost small" href="/api/ics/${encodeURIComponent(e.id)}.ics?kind=event">${icon('cal')}活動加入行事曆</a>` : ''}
        ${navigator.share ? `<button class="btn ghost small" data-share="${esc(e.id)}">${icon('share')}分享</button>` : ''}
      </div>
      ${e.summary ? `<div class="d-sec"><h3>介紹</h3><p class="summary">${esc(e.summary)}</p></div>` : ''}
    </div>
    <div class="d-actions">
      <button class="btn ghost ${starred ? 'on' : ''}" data-star-detail="${esc(e.id)}">${icon(starred ? 'star-fill' : 'star')}${starred ? '已收藏' : '收藏提醒'}</button>
      ${e.url ? `<a class="btn" href="${esc(e.url)}" target="_blank" rel="noopener">${icon(e.regStart ? 'ticket' : 'link')}${e.regStart ? '前往報名' : '看詳情'}</a>` : ''}
    </div>`;
  const dlg = $('#detail');
  if (!dlg.open) {
    lockScroll();
    dlg.showModal();
  }
  $('#detailBody').scrollTop = 0;
  history.replaceState(null, '', `#event=${encodeURIComponent(e.id)}`);
}
function closeDetail() {
  const dlg = $('#detail');
  if (dlg.open) dlg.close();
  unlockScroll();
}

// ---------- 收藏 ----------
async function toggleStar(id) {
  const on = !S.starred.has(id);
  on ? S.starred.add(id) : S.starred.delete(id);
  store.set('starred', [...S.starred]);
  S.starMeta[id] = [on, Date.now()];
  store.set('starMeta', S.starMeta);
  pushSync();
  $$(`[data-star="${CSS.escape(id)}"]`).forEach((b) => { b.classList.toggle('on', on); b.innerHTML = icon(on ? 'star-fill' : 'star'); });
  if ($('#detail').open) {
    const y = $('#detailBody').scrollTop;
    openDetail(id);
    $('#detailBody').scrollTop = y;
  }
  renderStar();
  const e = S.byId.get(id);
  if (S.subId) {
    try {
      await api('/api/star', { method: 'POST', body: { id: S.subId, eventId: id, on, ev: e ? snapshotOf(e) : undefined } });
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
  const p = S.prefs ?? {};
  return { notifyNew: true, categories: [], cities: [], keywords: [], includeBabycare: false, remindMinutes: [1440, 30, 5], remindEventDayBefore: true, ...p };
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
    status.textContent = '通知被封鎖了。請到瀏覽器設定（iPhone：設定 → 通知 → 活動雷達）重新允許。';
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
    const r = await api('/api/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), prefs: currentPrefs(), starred: starredSnapshots() } });
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
  const r = await api('/api/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), prefs: currentPrefs(), starred: starredSnapshots() } });
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
const pickHtml = (name, items) => items.map(([v, t]) => `<label><input type="checkbox" name="${name}" value="${v}"><span>${t}</span></label>`).join('');
function buildPrefsForm() {
  $('#prefCats').innerHTML = pickHtml('cat', CATEGORIES.filter((c) => c !== '親子館').map((c) => [c, c]));
  $('#prefCities').innerHTML = pickHtml('city', REGIONS.map(([r, cs]) => [cs.join(','), r]));
  $('#prefRemind').innerHTML = pickHtml('remind', REMIND_OPTIONS);
}
function fillPrefs() {
  const p = currentPrefs();
  const f = $('#prefsForm');
  f.notifyNew.checked = p.notifyNew;
  f.includeBabycare.checked = p.includeBabycare;
  f.remindEventDayBefore.checked = p.remindEventDayBefore;
  f.keywords.value = (p.keywords ?? []).join(', ');
  $$('input[name="cat"]', f).forEach((i) => (i.checked = p.categories.includes(i.value)));
  $$('input[name="city"]', f).forEach((i) => (i.checked = i.value.split(',').some((c) => (p.cities ?? []).includes(c))));
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
    cities: $$('input[name="city"]:checked', f).flatMap((i) => i.value.split(',')),
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
  toast('設定已儲存');
}

// ---------- 搜尋 ----------
let qTimer;
function onSearchInput() {
  $('#qClear').hidden = !$('#q').value;
  clearTimeout(qTimer);
  qTimer = setTimeout(renderList, 150);
}
function clearSearch() {
  const q = $('#q');
  q.value = '';
  q.blur(); // 收起鍵盤
  $('#qClear').hidden = true;
  renderList();
}

// ---------- 頁面切換 ----------
function go(view) {
  S.view = view;
  $$('.view').forEach((v) => (v.hidden = v.dataset.view !== view));
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.go === view));
  $('#searchWrap').hidden = view !== 'list';
  if (view === 'set') renderPush();
  if (view === 'sites') renderSites();
  if (view === 'inbox') renderInbox();
  $('#bellBtn').classList.toggle('on', view === 'inbox');
  document.body.scrollTop = 0;
  $('#toTop').classList.remove('show');
  const iv = $('#view-inbox'); iv.style.transform = iv.style.opacity = '';
}

function saveFilters() {
  store.set('filters', { cat: $('#catSel').value, city: $('#citySel').value, hideBaby: $('#hideBaby').checked });
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
  $('#q').addEventListener('input', onSearchInput);
  $('#q').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ev.target.blur(); });
  // 用 pointerdown 避免輸入框先失焦造成按鈕位移
  $('#qClear').addEventListener('pointerdown', (ev) => ev.preventDefault());
  $('#qClear').addEventListener('click', clearSearch);
  for (const id of ['#catSel', '#citySel', '#hideBaby']) $(id).addEventListener('change', () => { saveFilters(); renderList(); });
  $('#regHideBaby').addEventListener('change', renderReg);
  $('#regFreeOnly').addEventListener('change', renderReg);
  $('#regionChips').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-region]');
    if (!b) return;
    $$('#regionChips .chip').forEach((x) => x.classList.toggle('on', x === b));
    renderSites();
  });
  bindInboxSwipe();
  // 往下滑超過一個畫面高就出現「回到最上面」按鈕
  const toTop = $('#toTop');
  const onScroll = () => toTop.classList.toggle('show', document.body.scrollTop > innerHeight * 0.8);
  document.body.addEventListener('scroll', onScroll, { passive: true });
  toTop.addEventListener('click', () => document.body.scrollTo({ top: 0, behavior: 'smooth' }));
  $('#siteQ').addEventListener('input', () => renderSites());
  $('#siteQ').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ev.target.blur(); });
  $('#themePick').addEventListener('click', (ev) => { const b = ev.target.closest('[data-theme]'); if (b) applyTheme(b.dataset.theme); });
  $('#modePick').addEventListener('click', (ev) => { const b = ev.target.closest('[data-mode]'); if (b) { applyTheme(null, b.dataset.mode); buildThemePicker(); } });

  // 鈴鐺與通知頁
  $('#bellBtn').addEventListener('click', () => (S.view === 'inbox' ? closeInbox() : openInbox()));
  $('#inboxBack').addEventListener('click', closeInbox);
  $('#readAll').addEventListener('click', () => { markOpened(inboxList().map((e) => e.id)); renderInbox(); renderList(); toast('已全部標為已讀'); });
  $('#deleteAll').addEventListener('click', () => {
    if (!confirm('刪除通知頁上全部的新活動？（活動本身不會刪除，只是不再出現在這裡）')) return;
    deleteFromInbox(inboxList().map((e) => e.id)); renderInbox(); renderList(); toast('已清空');
  });
  $('#inboxList').addEventListener('click', (ev) => {
    const x = ev.target.closest('[data-dismiss]');
    if (x) { ev.stopPropagation(); deleteFromInbox([x.dataset.dismiss]); renderInbox(); renderList(); return; }
    const item = ev.target.closest('[data-inbox]');
    if (item) { openDetail(item.dataset.inbox); renderInbox(); renderList(); }
  });
  // 配對碼同步
  $('#syncCreate').addEventListener('click', createSyncCode);
  $('#syncJoin').addEventListener('click', joinSyncCode);
  $('#syncInput').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') joinSyncCode(); });
  $('#syncCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(S.syncCode); toast('已複製'); } catch { toast(S.syncCode); } });
  $('#syncLeave').addEventListener('click', () => {
    if (!confirm('解除配對？這台裝置之後不會再同步（已同步的資料會保留）。')) return;
    S.syncCode = null; store.set('syncCode', null); renderSyncCard(); toast('已解除配對');
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pullSync(); });
  // 外部連結（網站頁、活動頁的報名連結）
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[target="_blank"]');
    if (!a || !/^https?:/.test(a.href) || new URL(a.href).origin === location.origin) return;
    ev.preventDefault();
    openExternal(a.href);
  }, true);

  document.addEventListener('click', (ev) => {
    const star = ev.target.closest('[data-star],[data-star-detail]');
    if (star) { ev.stopPropagation(); return toggleStar(star.dataset.star ?? star.dataset.starDetail); }
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
  const dlg = $('#detail');
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg) closeDetail(); });
  dlg.addEventListener('close', () => {
    unlockScroll();
    if (location.hash.startsWith('#event=')) history.replaceState(null, '', location.pathname);
  });

  $('#refreshBtn').addEventListener('click', async () => {
    const b = $('#refreshBtn');
    b.classList.add('spin');
    await loadEvents();
    renderAll();
    b.classList.remove('spin');
    toast('已更新');
  });
  $('#enablePush').addEventListener('click', enablePush);
  $('#disablePush').addEventListener('click', disablePush);
  $('#testPush').addEventListener('click', async () => {
    try { await api('/api/test-push', { method: 'POST', body: { id: S.subId } }); toast('已送出，幾秒內會收到'); }
    catch (err) { toast(`失敗：${err.message}`); if (err.status === 404) { await resubscribe(); renderPush(); } }
  });
  $('#prefsForm').addEventListener('submit', savePrefs);
  navigator.serviceWorker?.addEventListener('message', (ev) => { if (ev.data?.type === 'open') handleHash(ev.data.url); });
  window.addEventListener('hashchange', () => handleHash(location.hash));
}

function handleHash(hash) {
  const h = String(hash ?? '').replace(/^.*#/, '#');
  const m = h.match(/^#event=(.+)$/);
  if (m) { go('list'); openDetail(decodeURIComponent(m[1])); }
  if (h === '#new') openInbox();
}

async function init() {
  $('#catSel').innerHTML += CATEGORIES.map((c) => `<option>${c}</option>`).join('');
  const f = store.get('filters', null);
  if (f) { $('#catSel').value = CATEGORIES.includes(f.cat) ? f.cat : ''; $('#hideBaby').checked = f.hideBaby ?? true; }
  buildPrefsForm();
  buildThemePicker();
  fillPrefs();
  bind();
  registerSW().then(() => renderPush());
  await loadEvents();
  ensureBaseline();
  // 舊的收藏沒有時間記錄，補上（同步時以「最後動作」為準）
  for (const id of S.starred) if (!S.starMeta[id]) S.starMeta[id] = [true, 1];
  renderAll();
  if (unreadList().length) $('#bellBtn').classList.add('ring');
  renderSyncCard();
  pullSync();
  setInterval(() => { if (document.visibilityState === 'visible') pullSync(); }, 60000);
  handleHash(location.hash);
  // 同步伺服器上的收藏和設定
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
  setInterval(() => { if (S.view === 'reg') renderReg(); }, 60000);
}

init();
