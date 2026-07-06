/* =====================================================================
 * 3000词 · 高考拔高  —  单页学习应用
 * 学习法：自查(秒认+校验) → 强语境 → 英译中考核 → 进阶中译英
 * 反馈：遗忘曲线复习调度、错题本、打卡streak、掌握率、TTS
 * 组织：每天100词 = 5组×20词
 * 账户：本地多用户 + 「学习码」云同步（离线优先），家长凭码看只读进度
 *
 * 云后端可插拔：CLOUD.backend = 'supabase'（当前，真云端同步，见 README）
 *              或 'mock'（本地模拟云，用于演示/离线）
 * ===================================================================== */
(function () {
  'use strict';

  // ---------- 常量 ----------
  const DAY_KEY = 'eng3000_day';
  const GROUP_SIZE = 20;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const BOX_INTERVALS = [10 * 60 * 1000, 1 * DAY_MS, 2 * DAY_MS, 4 * DAY_MS, 7 * DAY_MS, 15 * DAY_MS, 30 * DAY_MS];
  const MASTER_BOX = 4;
  const LEVEL_NAME = ['基础', '必修', '选修'];

  // ---------- 云配置（已接入 Supabase；如需离线演示可改为 mock） ----------
  const CLOUD = {
    backend: 'supabase',    // 'mock' | 'supabase'
    supabaseUrl: 'https://hxgukspkuekgrqaouwjd.supabase.co',
    supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh4Z3Vrc3BrdWVrZ3JxYW91d2pkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwNzg3NTUsImV4cCI6MjA5ODY1NDc1NX0.xX1iURjjChqaDczsz1KbFEIKsIUT5Fk2SrESkSDH1os'
  };

  // ---------- 数据 ----------
  let DAY = 1;
  let DAYDATA = { words: [], title: '' };
  let WORDS = [];
  let byId = {};
  let GROUP_COUNT = 1;

  function availableDays() {
    const days = (window.VOCAB_DATA && window.VOCAB_DATA.days) || {};
    return Object.keys(days).map(Number).filter(Boolean).sort((a, b) => a - b);
  }
  function setActiveDay(day) {
    const days = availableDays();
    const target = days.includes(day) ? day : (days[0] || 1);
    DAY = target;
    DAYDATA = (window.VOCAB_DATA && window.VOCAB_DATA.days[DAY]) || { words: [], title: '' };
    WORDS = DAYDATA.words || [];
    byId = {};
    WORDS.forEach((w, i) => { w.id = 'd' + DAY + '-' + w.no; w.group = Math.floor(i / GROUP_SIZE) + 1; byId[w.id] = w; });
    GROUP_COUNT = Math.max(1, Math.ceil(WORDS.length / GROUP_SIZE));
    try { localStorage.setItem(DAY_KEY, String(DAY)); } catch (e) {}
  }
  function loadSavedDay() {
    const n = parseInt(localStorage.getItem(DAY_KEY) || '1', 10);
    setActiveDay(Number.isFinite(n) ? n : 1);
  }

  // =====================================================================
  //  云同步层（可插拔）
  // =====================================================================
  const CloudMock = {
    label: '本地演示',
    available() { return true; },                 // 本地模拟：始终可用
    async pull(code) { try { return JSON.parse(localStorage.getItem('eng3000_cloud_' + code)); } catch (e) { return null; } },
    async push(code, payload) { localStorage.setItem('eng3000_cloud_' + code, JSON.stringify(payload)); return true; }
  };
  const CloudSupabase = {
    label: '云端', _c: null,
    available() { return !!(CLOUD.supabaseUrl && CLOUD.supabaseAnonKey && window.supabase); },
    client() {
      if (!this._c && this.available()) {
        // 自定义 fetch 强制 no-store，避免读到 CDN/浏览器缓存的旧结果（读后写一致性）
        this._c = window.supabase.createClient(CLOUD.supabaseUrl, CLOUD.supabaseAnonKey, {
          auth: { persistSession: false },
          global: { fetch: (u, o) => fetch(u, Object.assign({}, o || {}, { cache: 'no-store' })) }
        });
      }
      return this._c;
    },
    missingRpc(error) {
      return error && (error.code === 'PGRST202' || /Could not find the function/i.test(error.message || ''));
    },
    normalizeRow(data) {
      return Array.isArray(data) ? data[0] : data;
    },
    async pull(code) {
      const c = this.client(); if (!c) return null;
      const rpc = await c.rpc('learner_get', { p_code: code });
      if (rpc.error && !this.missingRpc(rpc.error)) throw rpc.error;
      if (!rpc.error) {
        const row = this.normalizeRow(rpc.data);
        return row ? { state: row.data, name: row.name, updatedAt: new Date(row.updated_at).getTime() } : null;
      }
      const { data, error } = await c.from('learners').select('code,name,updated_at,data').eq('code', code).maybeSingle();
      if (error) throw error;
      return data ? { state: data.data, name: data.name, updatedAt: new Date(data.updated_at).getTime() } : null;
    },
    async push(code, payload) {
      const c = this.client(); if (!c) return false;
      const rpc = await c.rpc('learner_upsert', {
        p_code: code,
        p_name: payload.name,
        p_data: payload.state,
        p_updated: new Date(payload.updatedAt).toISOString()
      });
      if (rpc.error && !this.missingRpc(rpc.error)) throw rpc.error;
      if (rpc.error) {
        const { error } = await c.from('learners').upsert({ code, data: payload.state, name: payload.name, updated_at: new Date(payload.updatedAt).toISOString() });
        if (error) throw error;
      }
      return true;
    }
  };
  function cloud() { return CLOUD.backend === 'supabase' ? CloudSupabase : CloudMock; }
  function cloudReady() { return cloud().available() && (CLOUD.backend === 'mock' || navigator.onLine); }

  let syncState = 'idle';   // idle | syncing | synced | offline | error
  function setSyncStatus(s) { syncState = s; updateSyncBadge(); }
  function syncLabel() {
    const demo = CLOUD.backend === 'mock';
    const map = {
      syncing: '☁️ 同步中…',
      synced: demo ? '✅ 已保存（本地演示 · 未接云端）' : '☁️ 已同步到云端',
      offline: '⚠️ 离线，联网后自动同步',
      error: '❌ 同步失败，稍后重试',
      idle: demo ? '☁️ 本地演示同步' : '☁️ 待同步'
    };
    return map[syncState] || '';
  }
  function updateSyncBadge() { const e = document.getElementById('syncBadge'); if (e) e.textContent = syncLabel(); }

  let syncTimer = null;
  function scheduleSync() { if (!currentUser || !currentUser.code) return; clearTimeout(syncTimer); syncTimer = setTimeout(pushNow, 700); }
  async function pushNow() {
    if (!currentUser || !currentUser.code || !state) return;
    if (!cloudReady()) { setSyncStatus('offline'); return; }
    setSyncStatus('syncing');
    try { await cloud().push(currentUser.code, { state, name: currentUser.name, updatedAt: state.meta.updatedAt }); setSyncStatus('synced'); }
    catch (e) { setSyncStatus('error'); }
  }
  async function pullMerge() {
    if (!currentUser || !currentUser.code || !state) return;
    if (!cloudReady()) { setSyncStatus('offline'); return; }
    try {
      const remote = await cloud().pull(currentUser.code);
      if (remote && remote.state && (remote.updatedAt || 0) > (state.meta.updatedAt || 0)) {
        state = normalizeState(remote.state);          // 云端更新 → 采用（整体后写胜出）
        save(); setSyncStatus('synced');
        if (currentUser) go(currentNav || 'home');
      } else {
        pushNow();                                     // 本地更新（或云端还没有）→ 推上去
      }
    } catch (e) { setSyncStatus('error'); }
  }

  // =====================================================================
  //  用户层（本地多用户 + 学习码）
  // =====================================================================
  const USERS_KEY = 'eng3000_users_v1';
  function loadUsers() {
    let u; try { u = JSON.parse(localStorage.getItem(USERS_KEY)); } catch (e) { u = null; }
    if (!u || !Array.isArray(u.users)) u = { users: [], currentId: null };
    return u;
  }
  function saveUsers() { localStorage.setItem(USERS_KEY, JSON.stringify(USERS)); }
  let USERS = loadUsers();
  let currentUser = null;

  function genCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // 去掉易混的 I/O
    let p = ''; for (let i = 0; i < 2; i++) p += A[Math.floor(Math.random() * A.length)];
    return p + '-' + String(1000 + Math.floor(Math.random() * 9000));
  }

  const userKey = id => 'eng3000_user_' + id;
  function normalizeState(s) {
    s = s || {};
    s.progress = s.progress || {};
    s.history = Array.isArray(s.history) ? s.history : [];
    s.stats = s.stats || { streak: 0, lastStudy: null, dates: [], reviews: 0 };
    s.meta = s.meta || { updatedAt: 0, name: '' };
    return s;
  }
  function loadUserState(id) {
    let s; try { s = JSON.parse(localStorage.getItem(userKey(id))); } catch (e) { s = null; }
    return normalizeState(s);
  }
  let state = null;
  function save() { if (currentUser) localStorage.setItem(userKey(currentUser.id), JSON.stringify(state)); }
  function persistLocalState() { if (currentUser && state) save(); }
  function touch() {  // 本地写入 + 打时间戳 + 触发同步
    if (!state) return;
    state.meta = state.meta || {};
    state.meta.updatedAt = Date.now();
    if (currentUser) state.meta.name = currentUser.name;
    save(); scheduleSync();
  }

  function createUser(name) {
    const id = 'u' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    USERS.users.push({ id, name, code: genCode(), created: Date.now() });
    saveUsers();
    enterUser(id);
  }
  function enterUser(id) {
    USERS.currentId = id; saveUsers();
    currentUser = USERS.users.find(u => u.id === id);
    state = loadUserState(id);
    if (!state.meta.name) state.meta.name = currentUser.name;
    setChrome(true);
    setSyncStatus('idle');
    go('home');
    pullMerge();   // 进入即尝试拉云端（离线则跳过）
  }
  function switchUser() {
    USERS.currentId = null; saveUsers();
    currentUser = null; state = null;
    setChrome(false); renderProfileGate();
  }
  function deleteCurrentUser() {
    if (!currentUser) return;
    localStorage.removeItem(userKey(currentUser.id));
    USERS.users = USERS.users.filter(u => u.id !== currentUser.id);
    USERS.currentId = null; saveUsers();
    currentUser = null; state = null;
    $('#sheet').hidden = true; setChrome(false); renderProfileGate();
  }
  // 学生换设备：用学习码把云端进度拉到本设备
  async function loginByCode(code, onErr) {
    code = (code || '').trim().toUpperCase();
    if (!/^[A-Z]{2}-\d{4}$/.test(code)) { onErr('学习码格式应为 两个字母-四位数字，如 XD-4821'); return; }
    if (!cloudReady()) { onErr('当前离线，无法用学习码登录（需要联网拉取云端进度）'); return; }
    let remote; try { remote = await cloud().pull(code); } catch (e) { remote = null; }
    if (!remote || !remote.state) { onErr('没找到这个学习码的数据（可能学生端还没同步过，或码输错了）'); return; }
    let u = USERS.users.find(x => x.code === code);
    if (!u) { u = { id: 'u' + Date.now().toString(36), name: remote.name || (remote.state.meta && remote.state.meta.name) || '学生', code, created: Date.now() }; USERS.users.push(u); }
    USERS.currentId = u.id; saveUsers();
    localStorage.setItem(userKey(u.id), JSON.stringify(remote.state));
    enterUser(u.id);
  }

  // ---------- 进度/SRS ----------
  function todayStr(t) { const d = t ? new Date(t) : new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function prog(id) {
    if (!state.progress[id]) state.progress[id] = { box: -1, due: 0, reps: 0, lapses: 0, seen: false, wrong: false, status: 'new' };
    return state.progress[id];
  }
  function rate(id, quality) {
    const p = prog(id); const now = Date.now();
    p.seen = true;
    if (quality === 'skip-known') { p.box = Math.max(p.box, 3); p.reps++; p.wrong = false; }
    else if (quality === 'good') { p.box = Math.min(Math.max(p.box, 0) + 1, BOX_INTERVALS.length - 1); p.reps++; p.wrong = false; }
    else { if (p.box >= 1) p.lapses++; p.box = 0; p.wrong = true; }
    p.status = p.box < 0 ? 'new' : (p.box === 0 ? 'learning' : (p.box >= MASTER_BOX ? 'mastered' : 'review'));
    p.due = now + BOX_INTERVALS[Math.max(0, p.box)];
    bumpStreak();
    state.stats.reviews++;
    touch();
  }
  function logAttempt(mode, wordId, result, extra) {
    if (!state) return;
    state.history = Array.isArray(state.history) ? state.history : [];
    state.history.push(Object.assign({
      ts: Date.now(),
      day: DAY,
      mode,
      wordId,
      result
    }, extra || {}));
    if (state.history.length > 1500) state.history = state.history.slice(-1500);
  }
  function bumpStreak() {
    const t = todayStr(); const st = state.stats;
    if (st.lastStudy === t) return;
    if (st.lastStudy === todayStr(Date.now() - DAY_MS)) st.streak++; else st.streak = 1;
    st.lastStudy = t;
    if (!st.dates.includes(t)) st.dates.push(t);
  }

  // ---------- 查询 ----------
  function countsAsMastered(p) {
    return !!(p && p.seen && !p.wrong && p.box > 0);
  }
  function statusOf(id) {
    const p = state.progress[id];
    if (!p || !p.seen) return 'new';
    if (countsAsMastered(p)) return 'mastered';
    if (p.box === 0) return 'learning';
    return 'review';
  }
  function dueList() {
    const now = Date.now();
    return WORDS.filter(w => { const p = state.progress[w.id]; return p && p.seen && p.box < MASTER_BOX && p.due <= now; });
  }
  function wrongList() { return WORDS.filter(w => { const p = state.progress[w.id]; return p && p.wrong; }); }
  function masteredCount() { return WORDS.filter(w => statusOf(w.id) === 'mastered').length; }
  function groupWords(g) { return WORDS.filter(w => w.group === g); }
  function groupStats(g) {
    const gw = groupWords(g); const now = Date.now();
    let seen = 0, mastered = 0, due = 0, unseen = 0;
    gw.forEach(w => {
      const p = state.progress[w.id];
      if (p && p.seen) { seen++; if (countsAsMastered(p)) mastered++; if (p.box < MASTER_BOX && p.due <= now) due++; }
      else unseen++;
    });
    return { g, gw, total: gw.length, seen, mastered, due, unseen };
  }
  // 给「家长看板」用：对任意 state 计算报告（只读）
  function computeReport(st) {
    const prog = st.progress || {}; const total = WORDS.length; let mastered = 0, seen = 0;
    const groups = {};
    WORDS.forEach(w => {
      const g = w.group; groups[g] = groups[g] || { g, total: 0, seen: 0, mastered: 0 }; groups[g].total++;
      const p = prog[w.id];
      if (p && p.seen) { seen++; groups[g].seen++; if (countsAsMastered(p)) { mastered++; groups[g].mastered++; } }
    });
    const weak = WORDS.filter(w => { const p = prog[w.id]; return p && p.wrong; });
    return {
      total, mastered, seen, pct: Math.round(mastered / total * 100),
      groups: Object.values(groups).sort((a, b) => a.g - b.g),
      streak: (st.stats && st.stats.streak) || 0, reviews: (st.stats && st.stats.reviews) || 0,
      weak, updatedAt: (st.meta && st.meta.updatedAt) || 0
    };
  }
  function recentHistory(days) {
    const since = Date.now() - days * DAY_MS;
    return ((state && state.history) || []).filter(x => x.day === DAY && x.ts >= since);
  }
  function modeLabel(mode) {
    return { learn: '学习', test: '考核', produce: '进阶' }[mode] || mode;
  }
  function modePassed(x) {
    return x.result === 'exact' || x.result === 'ok' || x.result === 'correct';
  }
  function summarizeHistory(items) {
    const modes = {
      learn: { total: 0, pass: 0, wrong: 0 },
      test: { total: 0, pass: 0, wrong: 0 },
      produce: { total: 0, pass: 0, wrong: 0, exact: 0, ok: 0 }
    };
    items.forEach(x => {
      const m = modes[x.mode] || (modes[x.mode] = { total: 0, pass: 0, wrong: 0 });
      m.total++;
      if (modePassed(x)) m.pass++; else m.wrong++;
      if (x.result === 'exact') m.exact = (m.exact || 0) + 1;
      if (x.result === 'ok') m.ok = (m.ok || 0) + 1;
    });
    return modes;
  }
  function pct(n, d) { return d ? Math.round(n / d * 100) : 0; }

  // ---------- 工具 ----------
  const $ = (sel, el) => (el || document).querySelector(sel);
  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
  function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function fmtDate(ts) { if (!ts) return '还没同步过'; const d = new Date(ts); const p = n => (n < 10 ? '0' : '') + n; return d.getMonth() + 1 + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  function parseSentence(w) {
    const m = w.en.match(/\(([^)]+)\)/);
    const target = m ? m[1] : w.word;
    return { target, before: m ? w.en.slice(0, m.index) : w.en, after: m ? w.en.slice(m.index + m[0].length) : '' };
  }
  function fullEn(w) { const s = parseSentence(w); return s.before + s.target + s.after; }
  function sentenceHTML(w, mode) {
    const s = parseSentence(w);
    let mid = mode === 'gap' ? '<span class="gap">' + esc(s.target) + '</span>'
      : mode === 'hl' ? '<span class="hl">' + esc(s.target) + '</span>' : esc(s.target);
    return esc(s.before) + mid + esc(s.after);
  }
  function zhHTML(w) {
    const raw = w.zh || '';
    if (/[（(][^（）()]+[）)]/.test(raw)) {
      return esc(raw).replace(/([（(])([^（）()]+)([）)])/g, '$1<span class="zh-target">$2</span>$3');
    }
    const candidates = (w.gloss || '').split(/[；;，,、/]/)
      .map(s => s.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
    for (const term of candidates) {
      const i = raw.indexOf(term);
      if (i >= 0) {
        return esc(raw.slice(0, i)) + '<span class="zh-target">' + esc(term) + '</span>' + esc(raw.slice(i + term.length));
      }
    }
    return esc(raw);
  }

  // ---------- 语音 ----------
  let voice = null;
  let ttsAudio = null;
  let speechTimer = null;
  function pickVoice() {
    if (!('speechSynthesis' in window)) return;
    const vs = speechSynthesis.getVoices();
    voice = vs.find(v => /en[-_]US/i.test(v.lang) && /female|Samantha|Google US/i.test(v.name)) ||
      vs.find(v => /en[-_]US/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang)) || null;
  }
  if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  function audioTtsSources(text) {
    const q = encodeURIComponent(text || '');
    return [
      'https://fanyi.baidu.com/gettts?lan=en&text=' + q + '&spd=3&source=web',
      'https://dict.youdao.com/dictvoice?type=2&audio=' + q,
      'https://dict.youdao.com/dictvoice?type=1&audio=' + q
    ];
  }
  function prefersAudioTts() {
    return /harmony|huawei|honor|arkweb|huaweibrowser/i.test(navigator.userAgent || '') || !voice;
  }
  function stopSpeech() {
    clearTimeout(speechTimer);
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (ttsAudio) { ttsAudio.pause(); ttsAudio = null; }
  }
  function showAudioFallback(url) {
    let tip = $('#audioFallback');
    if (!tip) {
      tip = el('<div id="audioFallback" class="audio-fallback"><span>朗读被系统拦截</span><button type="button">打开音频</button></div>');
      document.body.appendChild(tip);
    }
    $('button', tip).onclick = () => window.open(url, '_blank', 'noopener');
    tip.hidden = false;
    clearTimeout(tip._timer);
    tip._timer = setTimeout(() => { tip.hidden = true; }, 6000);
  }
  function playAudioTts(text, fallback) {
    if (!text) return false;
    const sources = audioTtsSources(text);
    let i = 0;
    const tryNext = () => {
      const url = sources[i++];
      if (!url) {
        if (fallback) {
          const ok = nativeSpeak(text, false);
          if (!ok) showAudioFallback(sources[0]);
        } else {
          showAudioFallback(sources[0]);
        }
        return;
      }
      try {
        if (ttsAudio) ttsAudio.pause();
        ttsAudio = new Audio(url);
        ttsAudio.preload = 'auto';
        ttsAudio.playsInline = true;
        ttsAudio.onerror = tryNext;
        const p = ttsAudio.play();
        if (p && p.catch) p.catch(tryNext);
      } catch (e) {
        tryNext();
      }
    };
    try {
      tryNext();
      return true;
    } catch (e) {
      if (fallback) nativeSpeak(text, false);
      return false;
    }
  }
  function nativeSpeak(text, fallback) {
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
      return fallback ? playAudioTts(text, false) : false;
    }
    try {
      const u = new SpeechSynthesisUtterance(text);
      let started = false;
      u.lang = 'en-US'; u.rate = .92; if (voice) u.voice = voice;
      u.onstart = () => { started = true; };
      u.onerror = () => { if (fallback) playAudioTts(text, false); };
      speechSynthesis.speak(u);
      speechTimer = setTimeout(() => {
        if (!started && fallback) {
          speechSynthesis.cancel();
          playAudioTts(text, false);
        }
      }, 700);
      return true;
    } catch (e) {
      return fallback ? playAudioTts(text, false) : false;
    }
  }
  function speak(text) {
    stopSpeech();
    if (prefersAudioTts()) playAudioTts(text, true);
    else nativeSpeak(text, true);
  }

  // ---------- 路由 / 外壳 ----------
  const app = $('#app');
  const backBtn = $('#backBtn');
  const menuBtn = $('#menuBtn');
  let currentNav = 'home';
  let sessionStack = [];

  function setChrome(loggedIn) { $('#tabbar').hidden = !loggedIn; menuBtn.hidden = !loggedIn; if (!loggedIn) backBtn.hidden = true; }
  function setTab(nav) { document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.nav === nav)); }
  function go(nav, opts) {
    currentNav = nav; setTab(nav); backBtn.hidden = true; app.innerHTML = '';
    ({ home: viewHome, learn: viewLearnStart, test: viewTestStart, produce: viewProduceStart, assess: viewAssess, review: viewReview, help: viewHelp }[nav])(opts || {});
    app.classList.remove('fade'); void app.offsetWidth; app.classList.add('fade');
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => go(t.dataset.nav)));
  backBtn.addEventListener('click', () => { const f = sessionStack.pop(); if (f) f(); else go(currentNav); });
  function showBack(fn) { backBtn.hidden = false; sessionStack = [fn]; }

  // =====================================================================
  //  用户选择页（学生登录 / 换设备用码登录 / 家长看进度）
  // =====================================================================
  function renderProfileGate() {
    $('#topTitle').textContent = '选择用户';
    backBtn.hidden = true; menuBtn.hidden = true; $('#tabbar').hidden = true;
    app.innerHTML = '';
    const c = el('<div></div>');
    c.appendChild(el(`<div class="card hero"><h1>3000词 · 高考拔高</h1>
      <div class="sub">选择用户开始；换设备用「学习码」登录；家长可凭码查看进度</div></div>`));

    if (USERS.users.length) {
      const list = el('<div class="card"></div>');
      list.appendChild(el('<div class="section-title">本机用户</div>'));
      USERS.users.forEach(u => {
        const st = loadUserState(u.id);
        const m = WORDS.filter(w => { const p = st.progress[w.id]; return p && p.box >= MASTER_BOX; }).length;
        const item = el(`<button class="action-btn"><span class="emoji">👤</span>
          <span class="txt"><b>${esc(u.name)}</b><span>学习码 ${esc(u.code || '—')} · 已掌握 ${m}/${WORDS.length}</span></span>
          <span class="cnt">进入</span></button>`);
        item.addEventListener('click', () => enterUser(u.id));
        list.appendChild(item);
      });
      c.appendChild(list);
    }

    const add = el(`<div class="card"><div class="section-title">新建用户（学生）</div>
      <input class="answer-input" id="newName" placeholder="输入名字，如：小兜" style="min-height:auto" maxlength="12"/>
      <button class="btn full" id="createBtn" style="margin-top:10px">创建并进入</button>
      <p class="muted" style="font-size:.76rem;margin:10px 2px 0">创建后会自动生成一个学习码，用于换设备同步、和给家长查看。</p></div>`);
    c.appendChild(add);

    const codeLogin = el(`<div class="card"><div class="section-title">换了设备？用学习码登录</div>
      <input class="answer-input" id="codeIn" placeholder="输入学习码，如 XD-4821" style="min-height:auto;text-transform:uppercase" maxlength="7"/>
      <button class="btn outline full" id="codeBtn" style="margin-top:10px">拉取我的进度</button>
      <div class="muted" id="codeMsg" style="font-size:.78rem;margin-top:8px"></div></div>`);
    c.appendChild(codeLogin);

    const parent = el(`<div class="card"><div class="section-title">家长 · 查看孩子进度</div>
      <input class="answer-input" id="pcodeIn" placeholder="输入孩子的学习码" style="min-height:auto;text-transform:uppercase" maxlength="7"/>
      <button class="btn ghost full" id="pcodeBtn" style="margin-top:10px">查看进度（只读）</button>
      <div class="muted" id="pcodeMsg" style="font-size:.78rem;margin-top:8px"></div></div>`);
    c.appendChild(parent);

    app.appendChild(c);

    const create = () => { const v = $('#newName', add).value.trim(); if (!v) { $('#newName', add).focus(); return; } createUser(v); };
    $('#createBtn', add).addEventListener('click', create);
    $('#newName', add).addEventListener('keydown', e => { if (e.key === 'Enter') create(); });
    $('#codeBtn', codeLogin).addEventListener('click', () => loginByCode($('#codeIn', codeLogin).value, m => { $('#codeMsg', codeLogin).textContent = m; }));
    $('#pcodeBtn', parent).addEventListener('click', () => {
      const code = ($('#pcodeIn', parent).value || '').trim().toUpperCase();
      if (!/^[A-Z]{2}-\d{4}$/.test(code)) { $('#pcodeMsg', parent).textContent = '学习码格式应为 XD-4821'; return; }
      renderParentView(code);
    });
  }

  // =====================================================================
  //  家长看板（只读）
  // =====================================================================
  async function renderParentView(code) {
    $('#topTitle').textContent = '家长 · 查看进度';
    $('#tabbar').hidden = true; menuBtn.hidden = true;
    backBtn.hidden = false; sessionStack = [() => { setChrome(false); renderProfileGate(); }];
    app.innerHTML = '<div class="empty"><div class="big">☁️</div><p>正在读取「' + esc(code) + '」的进度…</p></div>';
    let remote; try { remote = cloudReady() ? await cloud().pull(code) : null; } catch (e) { remote = null; }
    if (!cloudReady()) { renderEmpty('当前离线', '家长查看进度需要联网。', '返回', () => { setChrome(false); renderProfileGate(); }); backBtn.hidden = false; return; }
    if (!remote || !remote.state) { renderEmpty('没找到这个学习码', '请确认码正确，且孩子那端至少联网同步过一次。', '返回', () => { setChrome(false); renderProfileGate(); }); backBtn.hidden = false; return; }
    const st = normalizeState(remote.state);
    const name = remote.name || st.meta.name || '学生';
    const r = computeReport(st);
    app.innerHTML = '';
    app.appendChild(el(`<div class="card hero"><h1>${esc(name)} 的学习进度</h1>
      <div class="sub">Day ${DAY} · 学习码 ${esc(code)} · 更新于 ${fmtDate(r.updatedAt)}</div>
      <div class="streak-pill">🔥 连续打卡 ${r.streak} 天</div></div>`));
    app.appendChild(el(`<div class="stat-grid" style="margin-bottom:14px">
      <div class="stat"><div class="num green">${r.pct}%</div><div class="lab">掌握率</div></div>
      <div class="stat"><div class="num blue">${r.mastered}/${r.total}</div><div class="lab">已掌握</div></div>
      <div class="stat"><div class="num amber">${r.weak.length}</div><div class="lab">薄弱词</div></div></div>`));
    const gcard = el('<div class="card"><div class="section-title">分组掌握情况</div></div>');
    r.groups.forEach(g => {
      const first = (g.g - 1) * GROUP_SIZE + 1, last = Math.min(g.g * GROUP_SIZE, r.total);
      const pct = Math.round(g.mastered / g.total * 100);
      gcard.appendChild(el(`<div style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;font-size:.85rem;margin-bottom:5px">
          <span>组 ${g.g} · 第 ${first}–${last} 词</span><span class="muted">掌握 ${g.mastered}/${g.total} · 已学 ${g.seen}</span></div>
        <div class="bar"><i style="width:${pct}%"></i></div></div>`));
    });
    app.appendChild(gcard);
    if (r.weak.length) {
      const wc = el(`<div class="card"><div class="section-title">薄弱词（孩子答错/猜错）</div></div>`);
      r.weak.forEach(w => wc.appendChild(el(`<div class="wlist-item"><div><div class="w">${esc(w.word)}</div><div class="g">${esc(w.gloss)}</div></div><div class="meta"><span class="badge l${w.level}">${LEVEL_NAME[w.level]}</span></div></div>`)));
      app.appendChild(wc);
    }
    const refresh = mkBtn('🔄 刷新', 'btn ghost full', () => renderParentView(code));
    app.appendChild(refresh);
  }

  // =====================================================================
  //  首页 / 仪表盘（分组学习）
  // =====================================================================
  function viewHome() {
    $('#topTitle').textContent = currentUser ? currentUser.name + ' · Day ' + DAY : '3000词 · Day ' + DAY;
    const due = dueList();
    const mastered = masteredCount(); const total = WORDS.length; const pct = Math.round(mastered / total * 100);
    const wrong = wrongList();

    app.appendChild(el(`<div class="card hero">
      <h1>Day ${DAY} · ${esc(DAYDATA.title)}</h1>
      <div class="sub">每天 100 词 · 分 5 组 × 20 词</div>
      <div class="streak-pill">🔥 连续打卡 ${state.stats.streak} 天</div>
      <div id="syncBadge" class="sync-badge">${syncLabel()}</div></div>`));

    app.appendChild(el(`<div class="stat-grid" style="margin-bottom:14px">
      <div class="stat"><div class="num amber">${due.length}</div><div class="lab">待复习</div></div>
      <div class="stat"><div class="num green">${pct}%</div><div class="lab">掌握率</div></div>
      <div class="stat"><div class="num blue">${mastered}</div><div class="lab">已掌握</div></div></div>`));

    if (due.length) {
      const rb = el(`<button class="action-btn"><span class="emoji">🔁</span>
        <span class="txt"><b>复习到期词</b><span>遗忘曲线安排的复习，优先做</span></span><span class="cnt">${due.length}</span></button>`);
      rb.addEventListener('click', () => runLearn(shuffle(due))); app.appendChild(rb);
    }
    if (wrong.length) {
      const eb = el(`<button class="action-btn"><span class="emoji">📕</span>
        <span class="txt"><b>错题本</b><span>集中攻克猜错/答错的词</span></span><span class="cnt">${wrong.length}</span></button>`);
      eb.addEventListener('click', () => go('review')); app.appendChild(eb);
    }

    app.appendChild(el('<div class="section-title" style="margin-top:6px">分组学习（每组 20 词）</div>'));
    for (let g = 1; g <= GROUP_COUNT; g++) app.appendChild(groupCard(g));

    const heat = WORDS.map(w => {
      const s = statusOf(w.id); const si = s === 'new' ? 0 : s === 'learning' ? 1 : s === 'review' ? 2 : 3;
      const p = state.progress[w.id];
      return `<i class="s${si}${p && p.wrong ? ' wrong' : ''}" data-id="${w.id}" title="${esc(w.word)}">${w.no}</i>`;
    }).join('');
    const heatCard = el(`<div class="card"><div class="section-title"><span>掌握进度</span><span class="muted">${mastered}/${total}</span></div>
      <div class="bar" style="margin-bottom:12px"><i style="width:${pct}%"></i></div>
      <div class="heat">${heat}</div>
      <div class="legend">
        <span><b style="background:#e5e9f0"></b>未学</span><span><b style="background:#fde68a"></b>学习中</span>
        <span><b style="background:#86efac"></b>复习中</span><span><b style="background:#16a34a"></b>已掌握</span>
        <span><b style="box-shadow:inset 0 0 0 2px #dc2626;background:#fff"></b>错题</span></div></div>`);
    heatCard.querySelectorAll('.heat i').forEach(cell => cell.addEventListener('click', () => showWordSheet(byId[cell.dataset.id])));
    app.appendChild(heatCard);
    updateSyncBadge();
  }

  function groupCard(g) {
    const s = groupStats(g);
    const first = s.gw[0].no, last = s.gw[s.gw.length - 1].no;
    const pct = Math.round(s.mastered / s.total * 100);
    let statusTxt, btnTxt, doneCls = '';
    if (s.unseen === s.total) { statusTxt = '未开始'; btnTxt = '开始'; }
    else if (s.unseen > 0) { statusTxt = '学习中 · 已学 ' + s.seen + '/' + s.total; btnTxt = '继续'; }
    else if (s.mastered < s.total || s.due) { statusTxt = '复习中 · 掌握 ' + s.mastered + '/' + s.total + (s.due ? ' · ' + s.due + ' 待复习' : ''); btnTxt = '复习'; }
    else { statusTxt = '已全部掌握 ✅'; btnTxt = '重温'; doneCls = ' done'; }
    const card = el(`<button class="group-item${doneCls}">
      <div class="gi-top"><div><div class="gi-title">组 ${g} · 第 ${first}–${last} 词</div><div class="gi-sub">${statusTxt}</div></div>
        <span class="gi-btn">${btnTxt}</span></div>
      <div class="bar"><i style="width:${pct}%"></i></div></button>`);
    card.addEventListener('click', () => learnGroup(g));
    return card;
  }

  // ---------- 学习 tab = 分组选择 ----------
  function viewLearnStart() {
    $('#topTitle').textContent = 'Day ' + DAY + ' · 选择分组';
    const due = dueList();
    if (due.length) {
      const rb = el(`<button class="action-btn"><span class="emoji">🔁</span>
        <span class="txt"><b>先复习到期词</b><span>遗忘曲线安排的复习</span></span><span class="cnt">${due.length}</span></button>`);
      rb.addEventListener('click', () => runLearn(shuffle(due))); app.appendChild(rb);
    }
    app.appendChild(el('<div class="section-title">分组学习（每组 20 词，共 100 词）</div>'));
    for (let g = 1; g <= GROUP_COUNT; g++) app.appendChild(groupCard(g));
    app.appendChild(el('<p class="muted" style="font-size:.8rem;text-align:center;margin-top:8px">每组：先自查秒认 → 剩余词强语境猜词 → 对照中文自评</p>'));
  }

  function learnGroup(g) {
    const s = groupStats(g);
    const unseen = s.gw.filter(w => !(state.progress[w.id] && state.progress[w.id].seen));
    if (unseen.length) {
      runSelfCheck(unseen, unsure => {
        const q = shuffle(unsure);
        if (!q.length) renderDone('本组自查完成', unseen.length + ' 个词你都秒认并核对通过了 👀', '它们已按遗忘曲线排入复习。');
        else runLearn(q);
      });
    } else {
      const target = s.due ? s.gw.filter(w => { const p = state.progress[w.id]; return p.due <= Date.now(); }) : s.gw;
      runLearn(shuffle(target));
    }
  }

  // ---------- 第1步：自查（秒认→核对） ----------
  function runSelfCheck(list, done) {
    showBack(() => go('home'));
    const order = shuffle(list);
    let i = 0; const total = order.length; const unsure = [];
    function next() {
      if (i >= total) { done(unsure); return; }
      const w = order[i];
      renderSelfCheckCard(w, i, total,
        () => { logAttempt('learn', w.id, 'exact', { stage: 'selfcheck' }); rate(w.id, 'skip-known'); i++; next(); },
        () => { unsure.push(w); i++; next(); });
    }
    next();
  }
  function renderSelfCheckCard(w, idx, total, onKnow, onUnsure) {
    $('#topTitle').textContent = '自查 ' + (idx + 1) + '/' + total;
    app.innerHTML = '';
    const wrap = el('<div class="study-wrap"></div>'); wrap.appendChild(progressHead(idx, total));
    const card = el(`<div class="qcard check-card">
      <div class="top-meta"><span class="badge l${w.level}">${LEVEL_NAME[w.level]}</span><button class="speak-btn" title="朗读">🔊</button></div>
      <div class="hint-line center" id="scHint">第1步·自查：只要有一点犹豫、卡壳，就选「不确定」</div>
      <div class="check-word">${esc(w.word)}</div>
      <div class="zh reveal-hint" id="scAnswer" hidden></div>
      <div class="spacer"></div>
      <div class="rate-bar" id="scControls"></div></div>`);
    $('.speak-btn', card).addEventListener('click', () => speak(w.word));
    const controls = $('#scControls', card), answer = $('#scAnswer', card), hint = $('#scHint', card);
    controls.appendChild(mkBtn('🤔 不确定', 'btn outline', onUnsure));
    controls.appendChild(mkBtn('✅ 秒认', 'btn green', () => {
      speak(w.word);
      answer.hidden = false; answer.className = 'zh'; answer.innerHTML = '正确意思：<b>' + esc(w.gloss) + '</b>';
      hint.textContent = '核对一下——你刚才认的意思对吗？';
      controls.innerHTML = '';
      controls.appendChild(mkBtn('✗ 其实没认对', 'btn red', onUnsure));
      controls.appendChild(mkBtn('✓ 确认认对', 'btn green', onKnow));
    }));
    wrap.appendChild(card); app.appendChild(wrap);
  }

  // ---------- 强语境（第2-3步） ----------
  function runLearn(queue) {
    if (!queue.length) { renderEmpty('没有需要学习的词', '换一组，或去首页看看复习安排。'); return; }
    showBack(() => go('home'));
    let i = 0; const total = queue.length;
    function next() {
      if (i >= total) return renderDone('学习完成', total + ' 个词已过一遍', '这些词已按遗忘曲线排入复习。');
      renderLearnCard(queue[i], i, total, () => { i++; next(); });
    }
    next();
  }
  function renderLearnCard(w, idx, total, done) {
    $('#topTitle').textContent = '学习 ' + (idx + 1) + '/' + total;
    app.innerHTML = '';
    const wrap = el('<div class="study-wrap"></div>'); wrap.appendChild(progressHead(idx, total));
    const card = el(`<div class="qcard">
      <div class="top-meta"><span class="badge l${w.level}">${LEVEL_NAME[w.level]}</span><button class="speak-btn" title="朗读">🔊</button></div>
      <div class="hint-line">第2步：先别看中文，靠上下文猜括号里的词</div>
      <div class="sentence" id="sent">${sentenceHTML(w, 'gap')}</div>
      <div class="zh reveal-hint" id="zhbox">点下方「显示单词」，先猜再核对</div>
      <div class="spacer"></div><div class="rate-bar" id="controls"></div></div>`);
    $('.speak-btn', card).addEventListener('click', () => speak(fullEn(w)));
    const controls = $('#controls', card), sent = $('#sent', card), zhbox = $('#zhbox', card);
    controls.appendChild(mkBtn('显示单词', 'btn full', () => {
      sent.innerHTML = sentenceHTML(w, 'hl'); speak(fullEn(w));
      controls.innerHTML = ''; zhbox.className = 'zh'; zhbox.textContent = '（点「对照中文」核对你的猜测）';
      controls.appendChild(mkBtn('对照中文', 'btn full', () => {
        zhbox.innerHTML = zhHTML(w);
        card.querySelector('.hint-line').textContent = '第3步：给自己讲一遍——这个词在这里是什么意思、什么用法';
        controls.innerHTML = '';
        controls.appendChild(mkBtn('✗ 没猜对', 'btn red', () => { logAttempt('learn', w.id, 'wrong', { stage: 'context' }); rate(w.id, 'again'); done(); }));
        controls.appendChild(mkBtn('✓ 猜对了', 'btn green', () => { logAttempt('learn', w.id, 'ok', { stage: 'context' }); rate(w.id, 'good'); done(); }));
      }));
    }));
    wrap.appendChild(card); app.appendChild(wrap);
  }

  // ---------- 考核（英译中） ----------
  function viewTestStart() {
    $('#topTitle').textContent = '考核 · 英译中';
    const active = getActiveTestSession();
    if (active) return runTestSession(active);
    let pool = dueList();
    if (!pool.length) pool = WORDS.filter(w => { const p = state.progress[w.id]; return p && p.seen; });
    if (!pool.length) { renderEmpty('还没有可考核的词', '先到「学习」页选一组过一遍，再来检验。', '去学习', () => go('learn')); return; }
    runTest(shuffle(pool), '考核');
  }

  function getActiveTestSession() {
    const s = state && state.meta && state.meta.activeTest;
    if (!s || s.mode !== 'test' || s.day !== DAY || !Array.isArray(s.queue)) return null;
    const queue = s.queue.map(id => byId[id]).filter(Boolean);
    if (queue.length !== s.queue.length || s.index >= queue.length) { clearActiveTestSession(); return null; }
    return {
      mode: 'test',
      title: s.title || '考核',
      day: DAY,
      queue,
      index: Math.max(0, s.index || 0),
      correct: Math.max(0, s.correct || 0)
    };
  }
  function saveActiveTestSession(session) {
    if (!state) return;
    state.meta = state.meta || {};
    state.meta.activeTest = {
      mode: 'test',
      title: session.title || '考核',
      day: DAY,
      queue: session.queue.map(w => w.id),
      index: session.index,
      correct: session.correct,
      updatedAt: Date.now()
    };
    persistLocalState();
  }
  function clearActiveTestSession() {
    if (state && state.meta && state.meta.activeTest) {
      delete state.meta.activeTest;
      persistLocalState();
    }
  }
  function runTest(queue, title) {
    runTestSession({ mode: 'test', title: title || '考核', day: DAY, queue, index: 0, correct: 0 });
  }
  function runTestSession(session) {
    showBack(() => go('home'));
    const total = session.queue.length;
    saveActiveTestSession(session);
    function next() {
      if (session.index >= total) {
        clearActiveTestSession();
        return renderDone('考核完成', '答对 ' + session.correct + '/' + total, session.correct === total ? '全对！继续保持 🎯' : '答错的已进错题本，可去「错题本」强化。');
      }
      renderTestCard(session.queue[session.index], session.index, total, ok => {
        if (ok) session.correct++;
        session.index++;
        saveActiveTestSession(session);
      }, next);
    }
    next();
  }
  function renderTestCard(w, idx, total, onAnswered, onNext) {
    $('#topTitle').textContent = '考核 ' + (idx + 1) + '/' + total;
    app.innerHTML = '';
    const wrap = el('<div class="study-wrap"></div>'); wrap.appendChild(progressHead(idx, total));
    const distract = shuffle(WORDS.filter(x => x.id !== w.id)).slice(0, 3).map(x => x.gloss);
    const opts = shuffle([w.gloss].concat(distract));
    const card = el(`<div class="qcard">
      <div class="top-meta"><span class="badge l${w.level}">${LEVEL_NAME[w.level]}</span><button class="speak-btn">🔊</button></div>
      <div class="center"><div class="word-big">${esc(w.word)}</div></div>
      <div class="sentence" style="font-size:1rem;color:#6b7280;margin-top:10px">${sentenceHTML(w, 'hl')}</div>
      <div class="hint-line center">选择正确的中文意思</div>
      <div class="options" id="opts"></div><div class="spacer"></div></div>`);
    $('.speak-btn', card).addEventListener('click', () => speak(w.word));
    const optBox = $('#opts', card);
    let selected = null;
    const confirm = mkBtn('确认答案', 'btn full', () => {
      if (!selected || optBox.dataset.locked) return;
      optBox.dataset.locked = '1';
      const ok = selected.gloss === w.gloss;
      optBox.querySelectorAll('.opt').forEach(o => {
        if (o.textContent === w.gloss) o.classList.add('correct');
        else if (o === selected.button) o.classList.add('wrong');
        else o.classList.add('dim');
      });
      logAttempt('test', w.id, ok ? 'correct' : 'wrong');
      rate(w.id, ok ? 'good' : 'again'); if (ok) speak(w.word);
      onAnswered(ok);
      const nb = mkBtn(idx + 1 >= total ? '完成' : '下一题', 'btn full', onNext);
      confirm.replaceWith(nb);
    });
    confirm.disabled = true;
    confirm.style.marginTop = '14px';
    opts.forEach(g => {
      const b = el('<button class="opt">' + esc(g) + '</button>');
      b.addEventListener('click', () => {
        if (optBox.dataset.locked) return;
        selected = { gloss: g, button: b };
        optBox.querySelectorAll('.opt').forEach(o => o.classList.toggle('selected', o === b));
        confirm.disabled = false;
      });
      optBox.appendChild(b);
    });
    card.appendChild(confirm);
    wrap.appendChild(card); app.appendChild(wrap);
  }

  // ---------- 进阶（中译英） ----------
  function viewProduceStart() {
    $('#topTitle').textContent = '进阶 · 中译英';
    const active = getActiveProduceSession();
    if (active) return runProduceSession(active);
    let pool = WORDS.filter(w => { const p = state.progress[w.id]; return p && p.seen; });
    if (!pool.length) { renderEmpty('还没有可进阶的词', '先到「学习」页选一组过一遍，再来做中译英输出。', '去学习', () => go('learn')); return; }
    renderProduceIntro(shuffle(pool).slice(0, Math.min(pool.length, 15)));
  }
  function renderProduceIntro(queue) {
    app.innerHTML = '';
    showBack(() => go('home'));
    const total = queue.length;
    const intro = el(`<div class="help-page">
      <div class="card hero help-hero">
        <h1>进阶 · 中译英</h1>
        <div class="sub">目标：把“认得出”推进到“能主动写出来”。</div>
      </div>
      <div class="card">
        <div class="section-title">怎么操作</div>
        <ol class="help-steps">
          <li><b>只看中文</b><span>先不要看英文原句，尝试完整写出英文句。</span></li>
          <li><b>必须用目标词</b><span>每题会显示目标词，句子里要正确使用这个词。</span></li>
          <li><b>对照原句后判读</b><span>点“对照原句”，再按下面三档给自己判分。</span></li>
        </ol>
      </div>
      <div class="card">
        <div class="section-title">判读标准</div>
        <div class="rubric">
          <div><b>1 完全一样</b><span>与原句逐词一致，大小写和标点可不苛求。</span></div>
          <div><b>2 含目标词，语义一致，语法无误</b><span>表达可以不同，但意思对、目标词用对、语法通顺。</span></div>
          <div><b>3 有错误</b><span>目标词缺失/用错、语义偏离，或存在明显语法错误。</span></div>
        </div>
      </div>
    </div>`);
    intro.appendChild(mkBtn('开始进阶 · 共 ' + total + ' 题', 'btn full', () => runProduce(queue)));
    app.appendChild(intro);
  }
  function getActiveProduceSession() {
    const s = state && state.meta && state.meta.activeProduce;
    if (!s || s.mode !== 'produce' || s.day !== DAY || !Array.isArray(s.queue)) return null;
    const queue = s.queue.map(id => byId[id]).filter(Boolean);
    if (queue.length !== s.queue.length || s.index >= queue.length) { clearActiveProduceSession(); return null; }
    const result = Object.assign({ exact: 0, ok: 0, wrong: 0 }, s.result || {});
    return {
      mode: 'produce',
      day: DAY,
      queue,
      index: Math.max(0, s.index || 0),
      result
    };
  }
  function saveActiveProduceSession(session) {
    if (!state) return;
    state.meta = state.meta || {};
    state.meta.activeProduce = {
      mode: 'produce',
      day: DAY,
      queue: session.queue.map(w => w.id),
      index: session.index,
      result: session.result,
      updatedAt: Date.now()
    };
    persistLocalState();
  }
  function clearActiveProduceSession() {
    if (state && state.meta && state.meta.activeProduce) {
      delete state.meta.activeProduce;
      persistLocalState();
    }
  }
  function runProduce(queue) {
    runProduceSession({ mode: 'produce', day: DAY, queue, index: 0, result: { exact: 0, ok: 0, wrong: 0 } });
  }
  function runProduceSession(session) {
    showBack(() => go('home'));
    const total = session.queue.length;
    saveActiveProduceSession(session);
    function next() {
      if (session.index >= total) {
        clearActiveProduceSession();
        return renderProduceDone(session.result, total);
      }
      renderProduceCard(session.queue[session.index], session.index, total, grade => {
        session.result[grade]++;
        session.index++;
        saveActiveProduceSession(session);
        next();
      });
    }
    next();
  }
  function normalizedAnswer(s) {
    return (s || '').toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[^a-z0-9']+/g, ' ').trim();
  }
  function renderProduceDone(result, total) {
    const passed = result.exact + result.ok;
    const note = result.wrong ? '第 3 档已进入错题本，建议回到错题本专项攻克。' : '本轮全部达到进阶要求。';
    renderDone('进阶完成', '通过 ' + passed + '/' + total, note);
    app.insertBefore(el(`<div class="stat-grid" style="margin:0 0 14px">
      <div class="stat"><div class="num green">${result.exact}</div><div class="lab">完全一样</div></div>
      <div class="stat"><div class="num blue">${result.ok}</div><div class="lab">语义语法正确</div></div>
      <div class="stat"><div class="num amber">${result.wrong}</div><div class="lab">需订正</div></div>
    </div>`), app.firstChild);
  }
  function renderProduceCard(w, idx, total, done) {
    $('#topTitle').textContent = '进阶 ' + (idx + 1) + '/' + total;
    app.innerHTML = '';
    const wrap = el('<div class="study-wrap"></div>'); wrap.appendChild(progressHead(idx, total));
    const card = el(`<div class="qcard">
      <div class="top-meta"><span class="badge l${w.level}">${LEVEL_NAME[w.level]}</span><span class="muted" style="font-size:.8rem">目标词：${esc(w.word)}</span></div>
      <div class="hint-line">只看中文，动手写出英文句（写不出先说出来也行）</div>
      <div class="zh" style="font-size:1.1rem">${esc(w.zh)}</div>
      <textarea class="answer-input" id="ans" placeholder="在此写出英文…"></textarea>
      <div id="revealArea"></div><div class="spacer"></div><div class="rate-bar" id="controls"></div></div>`);
    const controls = $('#controls', card), revealArea = $('#revealArea', card);
    controls.appendChild(mkBtn('对照原句', 'btn full', () => {
      const typed = $('#ans', card).value || '';
      const exact = normalizedAnswer(typed) === normalizedAnswer(fullEn(w));
      revealArea.innerHTML = '';
      const box = el(`<div class="reveal-box">
        <div class="judge-pill ${exact ? 'ok' : ''}">${exact ? '系统提示：接近第 1 档' : '系统提示：请按目标词、语义、语法自评'}</div>
        <div class="en">${sentenceHTML(w, 'hl')}</div>
      </div>`);
      const sp = el('<button class="btn ghost sm" style="margin-top:10px">🔊 朗读</button>');
      sp.addEventListener('click', () => speak(fullEn(w))); box.appendChild(sp); revealArea.appendChild(box);
      controls.innerHTML = '';
      controls.classList.add('vertical');
      controls.appendChild(mkBtn('1 完全一样', 'btn green full', () => { logAttempt('produce', w.id, 'exact'); rate(w.id, 'skip-known'); done('exact'); }));
      controls.appendChild(mkBtn('2 含目标词，语义一致，语法无误', 'btn full', () => { logAttempt('produce', w.id, 'ok'); rate(w.id, 'good'); done('ok'); }));
      controls.appendChild(mkBtn('3 单词、语义或语法错误', 'btn red full', () => { logAttempt('produce', w.id, 'wrong'); rate(w.id, 'again'); done('wrong'); }));
    }));
    wrap.appendChild(card); app.appendChild(wrap);
    setTimeout(() => { const a = $('#ans', card); if (a) a.focus(); }, 100);
  }

  // ---------- 评估 ----------
  function viewAssess() {
    $('#topTitle').textContent = '评估 · 学习报告';
    const today = recentHistory(1);
    const week = recentHistory(7);
    const modes = summarizeHistory(week);
    const mastered = masteredCount();
    const total = WORDS.length;
    const wrong = wrongList();
    const due = dueList();
    const weakIds = {};
    week.forEach(x => { if (!modePassed(x)) weakIds[x.wordId] = (weakIds[x.wordId] || 0) + 1; });
    const repeatedWeak = Object.keys(weakIds).sort((a, b) => weakIds[b] - weakIds[a]).slice(0, 8).map(id => byId[id]).filter(Boolean);
    const weakestGroup = Array.from({ length: GROUP_COUNT }, (_, i) => groupStats(i + 1))
      .sort((a, b) => (a.mastered / a.total) - (b.mastered / b.total))[0];
    const weekPass = Object.values(modes).reduce((n, m) => n + m.pass, 0);
    const weekTotal = Object.values(modes).reduce((n, m) => n + m.total, 0);
    const advice = [];
    if (due.length) advice.push('先完成 ' + due.length + ' 个到期复习词。');
    if (wrong.length) advice.push('错题本还有 ' + wrong.length + ' 个薄弱词，建议先专项攻克。');
    if (modes.produce.total && pct(modes.produce.pass, modes.produce.total) < 70) advice.push('进阶输出通过率偏低，先降低速度，确保目标词、语义、语法三项都过关。');
    if (modes.test.total && pct(modes.test.pass, modes.test.total) < 80) advice.push('考核识别还不稳，建议回到强语境再过一轮。');
    if (!advice.length) advice.push('当前节奏良好，可以继续推进下一组，并保持进阶输出。');

    app.appendChild(el(`<div class="card hero">
      <h1>Day ${DAY} · 学习评估</h1>
      <div class="sub">基于学习、考核、进阶记录生成</div>
      <div class="streak-pill">最近 7 天通过率 ${pct(weekPass, weekTotal)}%</div>
    </div>`));
    app.appendChild(el(`<div class="stat-grid" style="margin-bottom:14px">
      <div class="stat"><div class="num green">${pct(mastered, total)}%</div><div class="lab">当前掌握</div></div>
      <div class="stat"><div class="num blue">${today.length}</div><div class="lab">今日记录</div></div>
      <div class="stat"><div class="num amber">${wrong.length}</div><div class="lab">薄弱词</div></div>
    </div>`));

    const modeCard = el('<div class="card"><div class="section-title">近 7 天表现</div></div>');
    ['learn', 'test', 'produce'].forEach(mode => {
      const m = modes[mode];
      const sub = mode === 'produce' && m.total ? ' · 完全一样 ' + (m.exact || 0) + ' · 语义语法正确 ' + (m.ok || 0) : '';
      modeCard.appendChild(el(`<div class="report-row">
        <div><b>${modeLabel(mode)}</b><span>${m.total ? '通过 ' + m.pass + '/' + m.total + sub : '暂无记录'}</span></div>
        <strong>${pct(m.pass, m.total)}%</strong>
      </div>`));
    });
    app.appendChild(modeCard);

    const groupCard = el('<div class="card"><div class="section-title">分组诊断</div></div>');
    for (let g = 1; g <= GROUP_COUNT; g++) {
      const s = groupStats(g);
      groupCard.appendChild(el(`<div class="report-row">
        <div><b>组 ${g}</b><span>掌握 ${s.mastered}/${s.total} · 已学 ${s.seen} · 待复习 ${s.due}</span></div>
        <strong>${pct(s.mastered, s.total)}%</strong>
      </div>`));
    }
    if (weakestGroup) groupCard.appendChild(el(`<p class="muted" style="font-size:.82rem;margin:10px 2px 0">优先关注：组 ${weakestGroup.g}。</p>`));
    app.appendChild(groupCard);

    const weakCard = el('<div class="card"><div class="section-title">反复薄弱词</div></div>');
    const weakWords = repeatedWeak.length ? repeatedWeak : wrong.slice(0, 8);
    if (!weakWords.length) weakCard.appendChild(el('<p class="muted" style="margin:0">暂无明显薄弱词。</p>'));
    weakWords.forEach(w => weakCard.appendChild(el(`<div class="wlist-item"><div><div class="w">${esc(w.word)}</div><div class="g">${esc(w.gloss)}</div></div><div class="meta"><span class="badge l${w.level}">${LEVEL_NAME[w.level]}</span></div></div>`)));
    app.appendChild(weakCard);

    app.appendChild(el(`<div class="card"><div class="section-title">下一步建议</div>
      <ul class="help-list">${advice.map(x => '<li>' + esc(x) + '</li>').join('')}</ul></div>`));
  }

  // ---------- 错题本 ----------
  function viewReview() {
    $('#topTitle').textContent = '错题本 · 薄弱词';
    const list = wrongList();
    if (!list.length) { renderEmpty('错题本是空的 👍', '猜错或答错的词会自动收集到这里。'); return; }
    app.appendChild(el(`<div class="card"><div class="section-title"><span>共 ${list.length} 个薄弱词</span></div>
      <p class="muted" style="font-size:.82rem;margin:0 2px 4px">答对一次即移出错题本。</p></div>`));
    const listCard = el('<div class="card"></div>');
    list.forEach(w => {
      const item = el(`<div class="wlist-item"><div><div class="w">${esc(w.word)}</div><div class="g">${esc(w.gloss)}</div></div>
        <div class="meta"><span class="badge l${w.level}">${LEVEL_NAME[w.level]}</span></div></div>`);
      item.addEventListener('click', () => showWordSheet(w)); listCard.appendChild(item);
    });
    app.appendChild(listCard);
    app.appendChild(mkBtn('开始专项攻克（英译中）', 'btn full', () => runTest(shuffle(list))));
  }

  // ---------- 使用说明 ----------
  function viewHelp(opts) {
    const from = opts && opts.from ? opts.from : 'home';
    $('#topTitle').textContent = '使用说明';
    setTab('help');
    showBack(() => go(from));
    app.innerHTML = '';

    const wrap = el('<div class="help-page"></div>');
    wrap.appendChild(el(`<div class="card hero help-hero">
      <h1>怎么用这套 3000 词</h1>
      <div class="sub">先学习，再考核，再进阶输出；进度会自动同步到云端。</div>
    </div>`));

    wrap.appendChild(el(`<div class="card">
      <div class="section-title">学生开始学习</div>
      <ol class="help-steps">
        <li><b>新建用户</b><span>第一次打开时输入名字，系统会自动生成一个学习码。</span></li>
        <li><b>按组学习</b><span>每天 100 词分成 5 组，每组 20 词。先做自查，再进入强语境学习。</span></li>
        <li><b>完成考核</b><span>「考核」检查是否认得出词义，「进阶」训练看中文写英文。</span></li>
        <li><b>处理错题</b><span>猜错、答错、写错的词会自动进入错题本，答对后自动移出。</span></li>
      </ol>
    </div>`));

    wrap.appendChild(el(`<div class="card">
      <div class="section-title">学习码怎么用</div>
      <div class="help-callout">
        <div class="help-code">${esc(currentUser && currentUser.code ? currentUser.code : 'XD-4821')}</div>
        <div class="muted">右上角菜单里可以查看和复制学习码。</div>
      </div>
      <ul class="help-list">
        <li>换手机或换电脑时，在登录页输入学习码即可拉取进度。</li>
        <li>家长在自己的手机输入孩子的学习码，可以只读查看学习情况。</li>
        <li>学习码相当于家庭内部通行码，不要发到公开群里。</li>
      </ul>
    </div>`));

    wrap.appendChild(el(`<div class="card">
      <div class="section-title">同步状态</div>
      <ul class="help-list">
        <li>显示「已同步到云端」说明当前进度已经保存到 Supabase。</li>
        <li>离线时也能继续学，进度先存在本机；恢复联网后会自动同步。</li>
        <li>如果换设备前不确定是否同步，打开右上角菜单，点「立即同步」。</li>
      </ul>
    </div>`));

    wrap.appendChild(el(`<div class="card">
      <div class="section-title">添加到手机主屏幕</div>
      <ul class="help-list">
        <li>iPhone：用 Safari 打开网址，点分享按钮，再选「添加到主屏幕」。</li>
        <li>安卓：用 Chrome 打开网址，点右上角菜单，再选「添加到主屏幕」或「安装应用」。</li>
        <li>添加后可以像普通 App 一样打开，复习提醒仍以应用内首页为准。</li>
      </ul>
    </div>`));

    app.appendChild(wrap);
  }

  // ---------- 公共 ----------
  function progressHead(idx, total) {
    const pct = Math.round(idx / total * 100);
    return el(`<div class="progress-head"><div class="bar"><i style="width:${pct}%"></i></div><div class="pct">${idx}/${total}</div></div>`);
  }
  function mkBtn(label, cls, fn) { const b = el('<button class="' + cls + '">' + label + '</button>'); b.addEventListener('click', fn); return b; }
  function renderDone(title, sub, note) {
    backBtn.hidden = true; sessionStack = []; app.innerHTML = '';
    const d = el(`<div class="done"><div class="big">🎉</div><h2>${esc(title)}</h2><p class="muted">${esc(sub)}</p><p style="margin:6px 0 22px">${esc(note || '')}</p></div>`);
    d.appendChild(mkBtn('返回首页', 'btn full', () => go('home'))); app.appendChild(d);
  }
  function renderEmpty(title, sub, btnLabel, btnFn) {
    app.innerHTML = '';
    const e = el(`<div class="empty"><div class="big">✨</div><h3 style="margin:0 0 6px">${esc(title)}</h3><p>${esc(sub || '')}</p></div>`);
    if (btnLabel) e.appendChild(mkBtn(btnLabel, 'btn', btnFn)); app.appendChild(e);
  }
  function showWordSheet(w) {
    const sheet = $('#sheet'), body = $('#sheetBody');
    const smap = { new: '未学', learning: '学习中', review: '复习中', mastered: '已掌握' };
    const s = statusOf(w.id), p = state.progress[w.id];
    body.innerHTML = `<h3 style="display:flex;align-items:center;gap:10px">${esc(w.word)}<span class="badge l${w.level}">${LEVEL_NAME[w.level]}</span></h3>
      <p class="muted" style="margin:2px 0 12px">${esc(w.gloss)} · 状态：${smap[s]}${p && p.wrong ? ' · <span style="color:#dc2626">错题</span>' : ''}</p>
      <div class="sentence" style="font-size:1.05rem">${sentenceHTML(w, 'hl')}</div><div class="zh">${zhHTML(w)}</div>`;
    const sp = el('<button class="btn ghost sm" style="margin-top:10px">🔊 朗读例句</button>');
    sp.addEventListener('click', () => speak(fullEn(w))); body.appendChild(sp); sheet.hidden = false;
  }
  $('#sheetClose').addEventListener('click', () => { $('#sheet').hidden = true; });
  $('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') $('#sheet').hidden = true; });

  // ---------- 设置菜单 ----------
  menuBtn.addEventListener('click', () => {
    if (!currentUser) return;
    const body = $('#sheetBody');
    body.innerHTML = `<h3>设置</h3>
      <div class="card" style="box-shadow:none;background:var(--gray-soft);margin-bottom:12px">
        <div style="font-size:.8rem;color:var(--ink-soft)">当前用户</div>
        <div style="font-weight:700;font-size:1.05rem">${esc(currentUser.name)}</div>
        <div style="font-size:.8rem;color:var(--ink-soft);margin-top:8px">当前学习日</div>
        <div style="font-weight:800;font-size:1.1rem">Day ${DAY} · ${esc(DAYDATA.title)}</div>
        <div style="font-size:.8rem;color:var(--ink-soft);margin-top:8px">学习码（换设备/给家长看用）</div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:2px">
          <span style="font-weight:800;font-size:1.25rem;letter-spacing:1px">${esc(currentUser.code || '—')}</span>
          <button class="btn sm ghost" id="copyCode">复制</button></div>
        <div class="muted" style="font-size:.76rem;margin-top:8px">${syncLabel()}</div>
      </div>`;
    $('#copyCode', body).addEventListener('click', () => {
      const t = currentUser.code || '';
      if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => { $('#copyCode', body).textContent = '已复制'; }, () => {});
      else { $('#copyCode', body).textContent = t; }
    });
    const helpBtn = mkBtn('使用说明', 'btn full', () => { const from = currentNav === 'help' ? 'home' : currentNav; $('#sheet').hidden = true; go('help', { from }); });
    body.appendChild(helpBtn);
    const dayBox = el('<div class="day-picker"></div>');
    availableDays().forEach(d => {
      const b = el('<button class="day-chip' + (d === DAY ? ' active' : '') + '">Day ' + d + '</button>');
      b.addEventListener('click', () => { setActiveDay(d); $('#sheet').hidden = true; go('home'); });
      dayBox.appendChild(b);
    });
    const dayWrap = el('<div class="card menu-card"><div class="section-title">切换学习日</div></div>');
    dayWrap.appendChild(dayBox);
    body.appendChild(dayWrap);
    const syncBtn = mkBtn('☁️ 立即同步', 'btn ghost full', () => { pullMerge(); $('#sheet').hidden = true; });
    syncBtn.style.marginTop = '10px'; body.appendChild(syncBtn);
    const sw = mkBtn('切换 / 新增用户', 'btn ghost full', () => { $('#sheet').hidden = true; switchUser(); }); sw.style.marginTop = '10px'; body.appendChild(sw);
    const clr = mkBtn('清空当前用户进度', 'btn ghost full', () => {
      if (confirm('确定清空「' + currentUser.name + '」的全部学习进度？')) {
        state = normalizeState({ meta: { updatedAt: Date.now(), name: currentUser.name } });
        touch(); $('#sheet').hidden = true; go('home');
      }
    }); clr.style.marginTop = '10px'; body.appendChild(clr);
    const del = mkBtn('删除当前用户（本机）', 'btn red full', () => { if (confirm('确定删除本机用户「' + currentUser.name + '」？云端进度不受影响，用学习码可再登录。')) deleteCurrentUser(); });
    del.style.marginTop = '10px'; body.appendChild(del);
    $('#sheet').hidden = false;
  });

  // ---------- 联网状态 ----------
  window.addEventListener('online', () => { setSyncStatus('idle'); pullMerge(); });
  window.addEventListener('offline', () => setSyncStatus('offline'));

  // ---------- 启动 ----------
  function boot() {
    loadSavedDay();
    // 迁移旧单用户数据
    if (!USERS.users.length && localStorage.getItem('eng3000_v1')) {
      const id = 'u' + Date.now().toString(36);
      USERS.users.push({ id, name: '我', code: genCode(), created: Date.now() });
      USERS.currentId = id; saveUsers();
      try { localStorage.setItem(userKey(id), localStorage.getItem('eng3000_v1')); } catch (e) {}
      localStorage.removeItem('eng3000_v1');
    }
    // 给早期没有学习码的用户补一个
    let changed = false;
    USERS.users.forEach(u => { if (!u.code) { u.code = genCode(); changed = true; } });
    if (changed) saveUsers();

    const u = USERS.currentId && USERS.users.find(x => x.id === USERS.currentId);
    if (u) enterUser(u.id); else { setChrome(false); renderProfileGate(); }
  }

  loadSavedDay();
  if (!WORDS.length) app.innerHTML = '<div class="empty"><div class="big">⚠️</div><p>数据未加载，请检查 data/dayN.js</p></div>';
  else boot();
})();
