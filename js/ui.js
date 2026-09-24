/* 展示積木：只負責畫面與收集輸入；規則都問 TripLogic，連線都經過 TripSync。
 * 一律用 textContent 放文字，不用 innerHTML。 */
(function () {
  'use strict';
  var L = window.TripLogic, S = window.TripSync;
  var KEY_TRIPS = 'quicktrip.trips.v1';
  var KEY_DRAFT = 'quicktrip.draft.v1';
  var KEY_WISH = 'quicktrip.wishes.v1';
  var KEY_HOME = 'quicktrip.home.v1';
  var KEY_CHECKS = 'quicktrip.checks.v1';
  var KEY_GROUPS = 'quicktrip.groups.v1';
  var KEY_SPACE = 'quicktrip.space.v1';
  var KEY_NICK = 'quicktrip.nick.v1';
  var KEY_GC = 'quicktrip.gc.';          // + groupId：雲端資料的本機快取（群組或自己的空間）
  var KEY_AUTH = 'quicktrip.auth.v1';    // 登入狀態（只有登入憑證，不存密碼）
  var POLL_MS = 20000;
  var state = {
    form: null, plan: null, tripId: null, tripSpace: '', dirty: false, editing: false, day: 0,
    picked: {}, otext: {}, otype: 'station', space: '', syncing: false, lastSync: 0, pendingJoin: null, view: 'plan'
  };

  function $(id) { return document.getElementById(id); }
  function each(list, fn) { Array.prototype.forEach.call(list, fn); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null && text !== '') n.textContent = String(text);
    return n;
  }
  function link(text, href) {
    var a = el('a', '', text);
    a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
    return a;
  }
  function button(text, cls, fn) {
    var b = el('button', cls || '', text); b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }
  // 要按兩次才執行（刪除、離開）
  function armed(b, confirmText, fn) {
    b.addEventListener('click', function () {
      if (b.getAttribute('data-armed') !== '1') { b.setAttribute('data-armed', '1'); b.textContent = confirmText; return; }
      fn();
    });
    return b;
  }
  function msg(id, text, kind) {
    var m = $(id); m.textContent = text || ''; m.className = m.className.replace(/\s*\b(ok|err)\b/g, '') + (kind ? ' ' + kind : '');
  }
  function store(key, val) {
    try {
      if (val === undefined) { var s = localStorage.getItem(key); return s ? JSON.parse(s) : null; }
      if (val === null) { localStorage.removeItem(key); return true; }
      localStorage.setItem(key, JSON.stringify(val)); return true;
    } catch (e) { return val === undefined ? null : false; }
  }
  function todayYmd() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function hhmm(ms) { var d = new Date(ms); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function money(n) { return 'NT$' + Number(n || 0).toLocaleString('zh-TW'); }
  function newId(prefix) { return prefix + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }

  /* ================= 帳號、群組與空間 ================= */
  function auth() { return L.cleanAuth(store(KEY_AUTH)); }
  function groups() { return L.cleanGroups(store(KEY_GROUPS)); }
  function group(id) { return id ? groups().filter(function (g) { return g.groupId === id; })[0] || null : null; }
  function saveGroups(list) { return store(KEY_GROUPS, L.cleanGroups(list)); }
  function upsertGroup(g) {
    var list = groups().filter(function (x) { return x.groupId !== g.groupId; });
    list.unshift(g); saveGroups(list);
  }
  function patchGroup(id, fields) {
    saveGroups(groups().map(function (g) {
      if (g.groupId !== id) return g;
      var c = {}; Object.keys(g).forEach(function (k) { c[k] = g[k]; });
      Object.keys(fields).forEach(function (k) { c[k] = fields[k]; });
      return c;
    }));
  }
  function spaceName(id) { var g = group(id); return g ? g.name : '我自己'; }
  function myNick(spaceId) { var g = group(spaceId), a = auth(); return g ? g.nick : a ? a.name : (L.cleanNick(store(KEY_NICK)) || '我'); }
  // 權限：建立者或「我自己」可以全部改；旅伴只能加點、改刪自己的點、拖曳行程順序、打勾認領
  function isOwnerOf(sp) { var g = group(sp); return !sp || !!(g && g.role === 'owner'); }
  function guest() { return L.isGuestDevice(groups()); }
  function myId(sp) { var g = group(sp); return g ? g.memberId : ''; }
  function canEditWish(w) { return isOwnerOf(state.space) || (!!w.addedBy && w.addedBy === myId(state.space)); }
  function membersIn(sp) { return sp ? L.cleanMembers(gcache(sp).members) : []; }
  function who(sp, id) { return sp ? L.memberLabel(membersIn(sp), id) : id; }
  // 資料實際放在哪：群組 → 群組編號；「我自己」→ 登入後是帳號的雲端空間，沒登入就只在這支手機（回傳 ''）
  function cloudId(sp) { if (sp) return sp; var a = auth(); return a ? a.personalId : ''; }
  // 帶著登入憑證呼叫後端
  function call(action, sp, extra) {
    var a = auth();
    if (!a) return Promise.reject(new Error('請先到「旅伴」頁登入'));
    var p = { token: a.token }; if (sp !== null) p.groupId = cloudId(sp);
    Object.keys(extra || {}).forEach(function (k) { p[k] = extra[k]; });
    return S.call(action, p).then(null, function (e) { if (/重新登入/.test(e.message)) expired(); throw e; });
  }
  function applyGuest() {
    var gu = guest();
    $('tab-plan').classList.toggle('hidden', gu);
    $('ng-card').classList.toggle('hidden', gu);
  }
  function gcache(id) { var c = store(KEY_GC + id); return c && c.items && typeof c.items === 'object' ? c : { since: 0, items: {} }; }
  function setGcache(id, c) { store(KEY_GC + id, { since: c.since, items: c.items, members: c.members || gcache(id).members || [] }); }

  /* ================= 資料層：同一套呼叫；登入後全部在雲端，沒登入的「我自己」先放手機 ================= */
  function listIn(sp, kind) { return L.listKind(gcache(cloudId(sp)), kind).map(function (x) { return x.obj; }); }
  function wishesIn(sp) { return L.cleanWishes(cloudId(sp) ? listIn(sp, 'wish') : store(KEY_WISH)); }
  function wishByMap(sp) {
    var m = {};
    if (sp) L.listKind(gcache(sp), 'wish').forEach(function (x) { m[x.obj.id] = x.by; });
    return m;
  }
  function tripsIn(sp) { return L.cleanTrips(cloudId(sp) ? listIn(sp, 'trip') : store(KEY_TRIPS)); }
  function checksIn(sp, tripId) { return L.checksForTrip(cloudId(sp) ? listIn(sp, 'check') : store(KEY_CHECKS), tripId); }
  function wishes() { return wishesIn(state.space); }
  function trips() { return tripsIn(state.space); }

  function localList(kind) {
    return kind === 'wish' ? L.cleanWishes(store(KEY_WISH)) : kind === 'trip' ? L.cleanTrips(store(KEY_TRIPS)) : (store(KEY_CHECKS) || []);
  }
  function localKey(kind) { return kind === 'wish' ? KEY_WISH : kind === 'trip' ? KEY_TRIPS : KEY_CHECKS; }
  function localMax(kind) { return kind === 'wish' ? L.WISH_MAX : kind === 'trip' ? 30 : 2000; }

  // 寫入一筆。雲端：帶版本號送後端，衝突就換成最新內容並回報
  function putItem(sp, kind, id, obj) {
    var cid = cloudId(sp);
    if (!cid) {
      var o = {}; Object.keys(obj).forEach(function (k) { o[k] = obj[k]; }); o.id = id;
      var list = localList(kind), idx = -1;
      list.forEach(function (x, i) { if (x && x.id === id) idx = i; });
      if (idx !== -1) list[idx] = o; else list = L.upsertTrip(list, o, localMax(kind));
      if (!store(localKey(kind), list)) return Promise.reject(new Error('存不進去（瀏覽器空間不足或無痕模式）'));
      return Promise.resolve();
    }
    if (sp && !group(sp)) return Promise.reject(new Error('找不到這個群組'));
    var body = {}; Object.keys(obj).forEach(function (k) { if (k !== 'id') body[k] = obj[k]; });
    return call('put', sp, { kind: kind, itemId: id, json: JSON.stringify(body), baseVer: L.itemVer(gcache(cid), kind, id) })
      .then(function (d) { return afterWrite(cid, d); });
  }
  function delItem(sp, kind, id) {
    var cid = cloudId(sp);
    if (!cid) {
      store(localKey(kind), L.removeTrip(localList(kind), id));
      return Promise.resolve();
    }
    if (sp && !group(sp)) return Promise.reject(new Error('找不到這個群組'));
    return call('del', sp, { kind: kind, itemId: id, baseVer: L.itemVer(gcache(cid), kind, id) })
      .then(function (d) { return afterWrite(cid, d); });
  }
  function afterWrite(cid, d) {
    setGcache(cid, L.mergeRows(gcache(cid), d && d.item ? [d.item] : []));
    if (d && d.conflict) {
      refreshViews();
      throw new Error('剛剛有人（或你在別的瀏覽器）改過這一筆，已換成最新內容，請再改一次');
    }
  }

  /* ================= 同步 ================= */
  function setStatus(text, isErr) {
    var s = $('space-status'); s.textContent = text || ''; s.classList.toggle('err', !!isErr);
  }
  function statusIdle() {
    if (!cloudId(state.space)) setStatus('只存在這支手機');
    else setStatus(state.lastSync ? '已同步 ' + hhmm(state.lastSync) : '');
  }
  function pullNow() {
    var sp = state.space, cid = cloudId(sp);
    if (!cid || !S.configured() || state.syncing || !auth()) return Promise.resolve();
    if (sp && !group(sp)) return Promise.resolve();
    state.syncing = true; setStatus('同步中…');
    return call('pull', sp, { since: gcache(cid).since }).then(function (d) {
      state.syncing = false;
      if (cloudId(sp) !== cid || (sp && !group(sp))) return;   // 同步途中登出或離開了：不要把快取寫回來
      var c2 = L.mergeRows(gcache(cid), d.items);
      if (sp) {
        var mem = L.cleanMembers(d.members);
        if (JSON.stringify(mem) !== JSON.stringify(membersIn(sp))) c2.changed = true;
        c2.members = mem;
      }
      setGcache(cid, c2);
      if (sp) {
        var g = group(sp), fix = {};
        if (d.name && d.name !== g.name) fix.name = L.cleanGroupName(d.name);
        if (d.me && d.me.nick && d.me.nick !== g.nick) fix.nick = L.cleanNick(d.me.nick);   // 暱稱以後端為準
        if (d.me && d.me.role && d.me.role !== g.role) fix.role = d.me.role;
        if (typeof d.inviteKey === 'string' && d.inviteKey !== g.inviteKey) fix.inviteKey = d.inviteKey;
        if (Object.keys(fix).length) { patchGroup(sp, fix); c2.changed = true; }
      }
      state.lastSync = Date.now();
      statusIdle();
      if (c2.changed && state.space === sp) refreshViews();
      renderSpaceBar();
    }, function (e) {
      state.syncing = false;
      if (sp && /不在這個群組|被移出|已經離開|找不到這個群組/.test(e.message)) {   // 已經不在群組裡：從清單拿掉
        dropGroup(sp);
        msg('msg-ng', '「' + spaceName(sp) + '」：' + e.message, 'err');
        setStatus(e.message, true);
        return;
      }
      setStatus(e.message, true);
    });
  }
  function dropGroup(id) {
    saveGroups(groups().filter(function (x) { return x.groupId !== id; }));
    store(KEY_GC + id, null);
    if (state.space === id) switchSpace('');
    if (state.view === 'group') renderGroups();
  }
  // 登入後：群組清單以後端為準（換瀏覽器登入就拿得回來）
  function refreshMe() {
    return call('me', null, {}).then(function (d) {
      var old = {}; groups().forEach(function (g) { old[g.groupId] = g; });
      saveGroups(d.groups.map(function (g) { return { groupId: g.groupId, name: g.name, memberId: g.memberId, nick: g.nick, role: g.role, inviteKey: g.inviteKey || (old[g.groupId] && old[g.groupId].inviteKey) || '' }; }));
      var gone = Object.keys(old).filter(function (id) { return !old[id].legacy && !group(id); });
      gone.forEach(function (id) { store(KEY_GC + id, null); });
      if (gone.length) msg('msg-ng', '你已經不在「' + gone.map(function (id) { return old[id].name; }).join('」「') + '」裡了（可能被建立者移出，或群組已經刪除）。', 'err');
      var a = auth(); if (a && a.name !== d.name) { a.name = d.name; store(KEY_AUTH, a); }
      if (state.space && !group(state.space)) switchSpace('');
      renderSpaceBar(); refreshViews();
    });
  }
  function expired() {
    if (!auth()) return;
    logoutLocal();
    state.skipLogin = false; renderAccount();
    msg('msg-login', '登入已過期或在別的地方改過密碼，請重新登入。', 'err');
  }
  // 別人改了資料：重畫目前看到的畫面（正在編輯行程時不動，免得打字打到一半被洗掉）
  function refreshViews() {
    updateCount();
    if (state.view === 'wish') renderWishes();
    if (state.view === 'saved') renderSaved();
    if (state.view === 'plan') renderPicks();
    // 旅伴頁有按鈕正在等「確定？」時先不重畫，免得確認鈕被洗掉
    if (state.view === 'group' && !document.querySelector('#view-group [data-armed="1"]')) renderGroups();
    if (state.view === 'result' && state.plan && !state.editing && !state.dragging) {
      if (state.tripId && !state.dirty) {
        var t = tripsIn(state.tripSpace).filter(function (x) { return x.id === state.tripId; })[0];
        if (t) state.plan = t.plan;
      }
      renderPlan();
    }
  }
  function switchSpace(id) {
    state.space = group(id) ? id : '';
    store(KEY_SPACE, state.space);
    state.picked = {}; state.lastSync = 0;
    renderSpaceBar(); statusIdle(); refreshViews();
    pullNow();
  }

  /* ================= 選單 ================= */
  function fillCitySelect(sel, placeholder) {
    sel.textContent = '';
    var o0 = el('option', '', placeholder); o0.value = ''; sel.appendChild(o0);
    L.TW_REGIONS.forEach(function (r) {
      var g = document.createElement('optgroup'); g.label = r.region;
      r.cities.forEach(function (c) { var o = el('option', '', c); o.value = c; g.appendChild(o); });
      sel.appendChild(g);
    });
  }
  function buildMenus() {
    fillCitySelect($('f-city'), '請選擇縣市');
    fillCitySelect($('w-city'), '請選擇縣市');
    L.STATIONS.forEach(function (s) { var o = document.createElement('option'); o.value = s; $('station-list').appendChild(o); });
    L.TRANSPORTS.forEach(function (t) {
      var b = el('button', 'chip', t); b.type = 'button'; b.setAttribute('aria-pressed', 'false');
      $('f-transport').appendChild(b);
    });
  }

  /* ================= 分頁 ================= */
  function show(view) {
    if (view === 'plan' && guest()) view = 'saved';   // 旅伴不開放 AI 規劃
    state.view = view;
    applyGuest();
    ['plan', 'wish', 'result', 'saved', 'group'].forEach(function (v) { $('view-' + v).classList.toggle('hidden', v !== view); });
    $('hero').classList.toggle('hidden', view !== 'plan');
    renderAccount();   // 大標只在規劃頁，其他頁直接看內容
    var tab = view === 'result' ? 'plan' : view;
    ['plan', 'wish', 'saved', 'group'].forEach(function (t) { $('tab-' + t).setAttribute('aria-selected', String(t === tab)); });
    if (view === 'saved') { renderSaved(); checkStorage(); }
    if (view === 'wish') renderWishes();
    if (view === 'plan') renderPicks();
    if (view === 'group') renderGroups();
    window.scrollTo(0, 0);
  }
  function renderSpaceBar() {
    var g = group(state.space);
    var a = auth();
    $('space-name').textContent = g ? '👥 ' + g.name + ' · 你是 ' + g.nick : '📱 我自己' + (a ? ' · ' + a.name : '');
    $('space-bar').classList.toggle('hidden', !groups().length && !S.configured());
    applyGuest();
    renderAccount();
  }

  /* ================= 共用切換 ================= */
  function segValue(id) {
    var b = $(id).querySelector('[aria-pressed="true"]');
    return b ? b.getAttribute('data-v') : '';
  }
  function setSeg(id, v) {
    each($(id).querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === String(v)));
    });
  }
  function pressedTexts(id) {
    var out = [];
    each($(id).querySelectorAll('[aria-pressed="true"]'), function (b) { out.push(b.textContent); });
    return out;
  }
  function setPressedTexts(id, list) {
    each($(id).querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', String(list.indexOf(b.textContent) !== -1));
    });
  }

  /* ================= 出發地 ================= */
  var OTYPE_UI = {
    home: { ph: '家裡地址，例：新竹市東區○○路○號', hint: '地址只存在這支手機，下次選「自家」會自動帶入；分享給旅伴時不會帶出去。' },
    station: { ph: '例：高鐵新竹站', hint: '' },
    hotel: { ph: '飯店名稱，例：○○飯店 高雄', hint: '適合兩天一夜第二天、或人已經在外地時。' },
    other: { ph: '例：公司、朋友家、某個路口', hint: '' }
  };
  function setOtype(type, keepText) {
    if (!keepText) state.otext[state.otype] = $('f-otext').value;
    state.otype = L.ORIGIN_TYPES[type] ? type : 'other';
    setSeg('f-otype', state.otype);
    var inp = $('f-otext');
    if (!keepText) {
      var v = state.otext[state.otype];
      if (v == null) v = state.otype === 'home' ? (store(KEY_HOME) || '') : state.otype === 'station' ? '高鐵新竹站' : '';
      inp.value = v;
    }
    inp.placeholder = OTYPE_UI[state.otype].ph;
    if (state.otype === 'station') inp.setAttribute('list', 'station-list'); else inp.removeAttribute('list');
    $('otext-hint').textContent = OTYPE_UI[state.otype].hint;
  }

  /* ================= 規劃表單 ================= */
  function readForm() {
    var city = $('f-city').value;
    var picks = L.wishesForCity(wishes(), city).filter(function (w) { return state.picked[w.id]; })
      .map(function (w) { return w.name + (w.note ? '（' + w.note + '）' : ''); });
    return {
      scope: 'domestic', city: city,
      destination: $('f-destination').value, mustDo: $('f-mustDo').value, wishPicks: picks,
      date: $('f-date').value, days: Number(segValue('f-days')) || 1,
      origin: { type: state.otype, text: $('f-otext').value },
      transport: pressedTexts('f-transport'),
      leaveAt: $('f-leaveAt').value, backBy: $('f-backBy').value,
      people: Number($('f-people').value), who: $('f-who').value,
      pace: segValue('f-pace'), food: pressedTexts('f-food').join('、'),
      budget: $('f-budget').value, extra: $('f-extra').value
    };
  }
  function fillForm(f) {
    ['destination', 'mustDo', 'date', 'leaveAt', 'backBy', 'people', 'budget', 'extra'].forEach(function (k) {
      if (f[k] != null) $('f-' + k).value = f[k];
    });
    // 舊版草稿沒有 city：從目的地字串猜
    var city = L.isTwCity(f.city) ? f.city : L.guessCity(f.destination);
    if (city) $('f-city').value = city;
    if (f.who != null) $('f-who').value = f.who;
    if (f.days) setSeg('f-days', f.days);
    if (f.pace) setSeg('f-pace', f.pace);
    if (f.transport != null) setPressedTexts('f-transport', L.normTransport(f.transport));
    if (f.food != null) setPressedTexts('f-food', String(f.food).split('、'));
    if (f.origin != null) {
      var o = L.normOrigin(f.origin);
      state.otext[o.type] = o.text;
      state.otype = o.type;
      $('f-otext').value = o.text;
      setOtype(o.type, true);
    }
    renderQuick();
  }
  function defaults() {
    fillForm({
      date: L.nextSaturday(todayYmd()), days: 1, origin: { type: 'station', text: '高鐵新竹站' },
      transport: ['高鐵', '捷運／公車'], leaveAt: '08:00', backBy: '21:30', people: 2, who: '',
      pace: '剛好，景點與休息平衡', food: '在地小吃'
    });
  }

  /* ================= 精簡表單：交通二選一、膠囊 ================= */
  // 主畫面只放「公共交通／自駕」；細項（混合搭配）在「更多選項」，兩邊同步
  var MODE_PRESET = { transit: ['高鐵', '捷運／公車'], driving: ['自行開車'] };
  var BUDGETS = [0, 1500, 3000, 6000];
  var PACE_SHORT = { '悠閒，景點少一點、多留休息時間': '輕鬆', '剛好，景點與休息平衡': '剛好', '塞滿，能去的都去': '塞滿' };
  function renderQuick() {
    var t = pressedTexts('f-transport');
    var mode = t.length ? L.travelMode(t) : '';
    setSeg('f-mode', mode);
    var preset = mode && MODE_PRESET[mode].join() === t.join();
    $('mode-note').textContent = !t.length ? '請選一種交通方式' : preset ? '' : L.transportText(t) + '（細項在「更多選項」）';
    $('pill-days').textContent = segValue('f-days') === '2' ? '兩天一夜' : '一日來回';
    $('pill-pace').textContent = '節奏 ' + (PACE_SHORT[segValue('f-pace')] || '剛好');
    var bud = Number($('f-budget').value) || 0;
    $('pill-budget').textContent = '預算 ' + (bud ? money(bud) : '不限');
  }
  function cycleSeg(id) {
    var bs = $(id).querySelectorAll('button'), i = 0;
    each(bs, function (b, k) { if (b.getAttribute('aria-pressed') === 'true') i = k; });
    setSeg(id, bs[(i + 1) % bs.length].getAttribute('data-v'));
    renderQuick();
  }
  function cycleBudget() {
    var v = Number($('f-budget').value) || 0, next = 0;
    for (var i = 1; i < BUDGETS.length; i++) if (BUDGETS[i] > v) { next = BUDGETS[i]; break; }
    $('f-budget').value = next ? String(next) : '';
    renderQuick();
  }
  // 沒選縣市時從「想去的點」猜（猜得到就帶入，願望清單才對得上）
  function autoCity() {
    if ($('f-city').value) return;
    var c = L.guessCity($('f-destination').value);
    if (c) { $('f-city').value = c; state.picked = {}; renderPicks(); }
  }

  function onPrompt() {
    autoCity();
    var f = readForm();
    var errs = L.validateForm(f);
    if (errs.length) {
      msg('msg-form', errs.join('；'), 'err');
      // 錯的欄位收在「更多選項」裡 → 自動打開，才看得到要改哪裡
      if (/縣市|日期|人數|時間/.test(errs.join())) $('more-opts').open = true;
      return;
    }
    msg('msg-form', '');
    state.form = f;
    store(KEY_DRAFT, f);
    if (f.origin.type === 'home') store(KEY_HOME, L.normOrigin(f.origin).text);
    var text = L.buildPrompt(f);
    $('prompt-out').value = text;
    $('card-copy').classList.remove('locked', 'hidden');
    $('card-paste').classList.remove('locked');
    msg('msg-copy', '');
    // 按「生成行程」就先把提示詞複製好（同一次點擊內才允許寫剪貼簿）
    copyText(text, $('prompt-out')).then(function (ok) {
      if (ok) msg('msg-copy', '提示詞已複製，按「開啟 Claude」貼上送出。', 'ok');
      else { $('prompt-box').open = true; msg('msg-copy', '自動複製失敗，請在下面的提示詞長按全選後複製。', 'err'); }
    });
    $('card-copy').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function copyText(text, fallbackInput) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text, fallbackInput); });
    }
    return Promise.resolve(legacyCopy(text, fallbackInput));
  }
  function legacyCopy(text, t) {
    var d = t.closest('details'); if (d) d.open = true;   // 收合中的文字框選不到
    t.value = text; t.focus(); t.select(); t.setSelectionRange(0, text.length);
    try { return document.execCommand('copy'); } catch (e) { return false; }
  }
  function onCopy(open) {
    var text = $('prompt-out').value;
    if (!text) return;
    // 先開視窗（要在使用者點擊的同一拍，否則會被擋）
    if (open) window.open('https://claude.ai/new', '_blank', 'noopener');
    copyText(text, $('prompt-out')).then(function (ok) {
      if (ok) msg('msg-copy', open ? '已複製，到 Claude 貼上送出，再把回答貼回下面。' : '已複製。', 'ok');
      else { $('prompt-box').open = true; msg('msg-copy', '自動複製失敗，請在下面的提示詞長按全選後複製。', 'err'); }
    });
  }

  function onParse() {
    var r = L.parsePlan($('paste-in').value);
    if (!r.ok) { msg('msg-parse', r.error, 'err'); return; }
    msg('msg-parse', '');
    state.plan = r.plan;
    state.form = state.form || readForm();
    state.tripId = null; state.tripSpace = state.space; state.tripSavedDate = ''; state.dirty = true; state.editing = false;
    state.day = 0;
    openResult();
  }

  /* ================= 願望清單（規劃頁的勾選） ================= */
  function renderPicks() {
    var city = $('f-city').value, box = $('wish-picks');
    var list = L.wishesForCity(wishes(), city);
    box.textContent = '';
    $('wish-picks-box').classList.toggle('hidden', !list.length);
    if (!list.length) return;
    $('wish-picks-title').textContent = (state.space ? '「' + spaceName(state.space) + '」' : '') + '願望清單裡的' + city + '（點選要排進去的）';
    list.forEach(function (w) {
      var b = el('button', 'chip ' + (w.kind === 'eat' ? 'kind-eat' : 'kind-play'), (w.kind === 'eat' ? '吃・' : '玩・') + w.name);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(!!state.picked[w.id]));
      b.addEventListener('click', function () {
        state.picked[w.id] = !state.picked[w.id];
        b.setAttribute('aria-pressed', String(state.picked[w.id]));
      });
      box.appendChild(b);
    });
  }

  /* ================= 願望清單頁 ================= */
  function syncWishScope() {
    var abroad = segValue('w-scope') === 'abroad';
    $('w-city-wrap').classList.toggle('hidden', abroad);
    $('w-abroad-wrap').classList.toggle('hidden', !abroad);
  }
  function onWishAdd() {
    var scope = segValue('w-scope');
    var input = {
      name: $('w-name').value, scope: scope, kind: segValue('w-kind'),
      city: scope === 'abroad' ? $('w-abroad').value : $('w-city').value,
      note: $('w-note').value, url: $('w-url').value
    };
    var r = L.normalizeWish(input, newId('w'), todayYmd());
    if (!r.ok) { msg('msg-wish', r.error, 'err'); return; }
    if (wishes().length >= L.WISH_MAX) { msg('msg-wish', '願望清單滿了（' + L.WISH_MAX + ' 筆），先刪掉一些去過的吧', 'err'); return; }
    var btn = $('btn-wish-add'); btn.disabled = true;
    msg('msg-wish', state.space ? '儲存中…' : '');
    putItem(state.space, 'wish', r.wish.id, r.wish).then(function () {
      msg('msg-wish', '已加入：' + r.wish.name + (state.space ? '（旅伴也看得到）' : ''), 'ok');
      $('w-name').value = ''; $('w-note').value = ''; $('w-url').value = '';
      setSeg('wf-scope', r.wish.scope);   // 篩選切到剛加的那一類，才看得到
      updateCount(); renderWishes();
    }, function (e) { msg('msg-wish', e.message, 'err'); }).then(function () { btn.disabled = false; });
  }
  function renderWishes() {
    var box = $('wish-list'), all = wishes(), by = wishByMap(state.space);
    $('wish-space-hint').textContent = state.space ? '這是「' + spaceName(state.space) + '」共用的清單，旅伴加的也會出現在這裡。' : '';
    box.textContent = '';
    var list = L.filterWishes(all, { scope: segValue('wf-scope'), kind: segValue('wf-kind'), showDone: $('wf-done').checked });
    if (!list.length) {
      box.appendChild(el('div', 'empty', all.length ? '這個分類還沒有東西。' : '還沒有願望。看到想去的，用上面的欄位先記下來。'));
      return;
    }
    L.groupWishes(list).forEach(function (g) {
      var sec = el('div', 'wgroup');
      sec.appendChild(el('h3', '', g.city + '（' + g.items.length + '）'));
      g.items.forEach(function (w) { sec.appendChild(wishRow(w, by[w.id])); });
      box.appendChild(sec);
    });
  }
  function wishRow(w, by) {
    var row = el('div', 'wish ' + (w.kind === 'eat' ? 'kind-eat' : 'kind-play') + (w.done ? ' done' : ''));
    var nm = el('div', 'name');
    nm.appendChild(el('span', 'type', L.WISH_KIND[w.kind]));
    nm.appendChild(document.createTextNode(w.name));
    row.appendChild(nm);
    var meta = [w.note, w.added ? w.added.slice(5).replace('-', '/') + ' 記' : '', w.addedBy ? who(state.space, w.addedBy) + ' 加的' : by ? by + ' 最後更新' : ''].filter(Boolean).join(' · ');
    if (meta) row.appendChild(el('div', 'meta', meta));
    var act = el('div', 'actions');
    act.appendChild(link('地圖', L.mapSearchUrl(w.name + ' ' + w.city)));
    if (w.url) act.appendChild(link('連結', w.url));
    if (w.scope === 'domestic' && !w.done && !guest()) act.appendChild(button('排進行程', 'go', function () { planFromWish(w); }));
    if (!canEditWish(w)) { row.appendChild(act); return row; }   // 別人加的點：旅伴只能看
    act.appendChild(button(w.done ? '取消去過' : '去過了', '', function () {
      var c = {}; Object.keys(w).forEach(function (k) { c[k] = w[k]; }); c.done = !w.done;
      putItem(state.space, 'wish', w.id, c).then(function () { updateCount(); renderWishes(); }, function (e) { msg('msg-wish', e.message, 'err'); });
    }));
    act.appendChild(armed(button('刪除', '', null), '確定刪除？', function () {
      delete state.picked[w.id];
      delItem(state.space, 'wish', w.id).then(function () { updateCount(); renderWishes(); }, function (e) { msg('msg-wish', e.message, 'err'); });
    }));
    row.appendChild(act);
    return row;
  }
  function planFromWish(w) {
    if ($('f-city').value !== w.city) { $('f-city').value = w.city; state.picked = {}; }
    state.picked[w.id] = true;
    show('plan');
    msg('msg-form', '已選「' + w.name + '」，也可以再勾同縣市的其他願望。', 'ok');
    $('wish-picks-box').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ================= 行程結果 ================= */
  function openResult() {
    var own = isOwnerOf(state.tripSpace);
    ['btn-save', 'save-space', 'btn-edit'].forEach(function (id) { $(id).classList.toggle('hidden', !own); });
    $('btn-back').textContent = own && !guest() ? '← 回去修改' : '← 回到行程';
    renderSaveSpace();
    updateSaveButton();
    msg('msg-result', '');
    renderPlan();
    show('result');
  }
  function renderSaveSpace() {
    var sel = $('save-space'); sel.textContent = '';
    var opts = [{ id: '', name: '存到：我自己' }].concat(groups().filter(function (g) { return !g.legacy && g.role === 'owner'; }).map(function (g) { return { id: g.groupId, name: '存到：' + g.name }; }));
    opts.forEach(function (o) { var op = el('option', '', o.name); op.value = o.id; sel.appendChild(op); });
    sel.value = state.tripId ? state.tripSpace : state.space;
    sel.classList.toggle('hidden', opts.length < 2);
  }
  function updateSaveButton() {
    var b = $('btn-save'), sp = $('save-space').value;
    var savedHere = state.tripId && state.tripSpace === sp;
    b.disabled = !!(savedHere && !state.dirty);
    b.textContent = savedHere ? (state.dirty ? '儲存修改' : '已存 ✓') : '存起來';
    $('btn-edit').textContent = state.editing ? '完成編輯' : '編輯行程';
  }
  function markDirty() { state.dirty = true; updateSaveButton(); }

  function onSave() {
    if (!state.plan) return;
    var sp = $('save-space').value;
    if (sp && !group(sp)) sp = '';
    var f = state.form || {};
    var isNew = !(state.tripId && state.tripSpace === sp);
    var id = isNew ? L.makeId(JSON.stringify(state.plan) + (f.date || '') + sp) : state.tripId;
    var trip = { id: id, savedDate: isNew ? todayYmd() : (state.tripSavedDate || todayYmd()), form: f, plan: state.plan };
    var obj = sp ? L.shareTrip(trip) : L.cleanTrip(trip);
    if (!obj) { msg('msg-result', '行程內容有問題，存不進去', 'err'); return; }
    var b = $('btn-save'); b.disabled = true; b.textContent = '儲存中…';
    putItem(sp, 'trip', id, obj).then(function () {
      // 寫完讀回來確認真的存進去，不只相信沒丟錯
      if (!tripsIn(sp).some(function (t) { return t.id === id; })) throw new Error('存不進去（瀏覽器空間不足或無痕模式）');
      if (!isNew || checksIn(sp, id).length) return;
      return Promise.all(L.seedChecks(id, state.plan).map(function (c) { return putItem(sp, 'check', c.id, c); }));
    }).then(function () {
      askPersist();
      state.tripId = id; state.tripSpace = sp; state.dirty = false; state.tripSavedDate = trip.savedDate;
      msg('msg-result', sp ? '已存到「' + spaceName(sp) + '」，旅伴打開就看得到。' : '已存到「我自己」。', 'ok');
      updateSaveButton(); updateCount(); renderPlan();
    }, function (e) {
      updateSaveButton();
      b.textContent = '存不進去';
      msg('msg-result', e.message, 'err');
    });
  }

  function editStop(fn) { state.plan = fn(state.plan); markDirty(); renderPlan(); }

  function renderPlan() {
    var plan = state.plan, f = state.form || {}, box = $('result');
    var canEdit = isOwnerOf(state.tripSpace);
    var canDrag = !state.editing && (canEdit || !!state.tripId);
    box.textContent = '';
    var mode = L.travelMode(f.transport);

    var head = el('div', 'card glass plan-head');
    head.appendChild(el('div', 'eyebrow', '你的行程'));
    var hr = el('div', 'head-row');
    hr.appendChild(el('h2', '', plan.title));
    var dur = planDuration(plan);
    if (dur) hr.appendChild(el('span', 'dur-pill', dur));
    head.appendChild(hr);
    if (plan.summary) head.appendChild(el('p', 'sum', plan.summary));
    var metaBits = [];
    if (f.date) metaBits.push(L.dayLabel(f.date) + (f.days === 2 ? ' 起兩天一夜' : ' 一日來回'));
    if (L.originText(f.origin)) metaBits.push('從 ' + L.originText(f.origin) + ' 出發');
    if (L.transportText(f.transport)) metaBits.push(L.transportText(f.transport));
    if (f.people) metaBits.push(f.people + ' 人');
    if (state.tripId) metaBits.push('存在「' + spaceName(state.tripSpace) + '」');
    head.appendChild(el('div', 'meta', metaBits.join(' · ')));
    box.appendChild(head);

    if (plan.days.length > 1) {
      var tabs = el('div', 'daytabs no-print');
      plan.days.forEach(function (d, i) {
        var b = button(d.label, 'chip', function () { state.day = i; renderPlan(); });
        b.setAttribute('aria-pressed', String(i === state.day));
        tabs.appendChild(b);
      });
      box.appendChild(tabs);
    }

    plan.days.forEach(function (d, di) {
      var panel = el('div', 'card glass day-panel' + (di === state.day ? '' : ' hidden'));
      if (plan.days.length > 1) panel.appendChild(el('h3', '', d.label));
      var ul = el('ol', 'timeline');
      d.items.forEach(function (it, ii) {
        var drag = canDrag && d.items.length > 1;
        var li = el('li', 'stop c-' + it.type + (drag ? ' draggable' : ''));
        li.appendChild(el('span', 'num', String(ii + 1)));
        var body = el('div', 'body');
        if (state.editing) body.appendChild(stopEditor(di, ii, it, plan));
        else stopView(body, it, d, di, ii, f, mode);
        li.appendChild(body);
        if (drag) {
          var h = el('button', 'drag-h', '⋮⋮'); h.type = 'button';
          h.setAttribute('aria-label', '拖曳調整「' + it.name + '」的順序（也可以用上下鍵）');
          li.appendChild(h);
        }
        ul.appendChild(li);
      });
      panel.appendChild(ul);
      if (canDrag && d.items.length > 1) bindDrag(ul, di);
      if (state.editing) {
        var tools = el('div', 'day-tools');
        tools.appendChild(button('＋加一站', 'btn small ghost', function () { editStop(function (p) { return L.addStop(p, di); }); }));
        tools.appendChild(button('依時間排序', 'btn small ghost', function () { editStop(function (p) { return L.sortByTime(p, di); }); }));
        panel.appendChild(tools);
      }
      box.appendChild(panel);
    });

    if (plan.nearbyExtras.length) {
      var ex = el('div', 'card glass sec nearby');
      var eh = el('div', 'sec-head');
      eh.appendChild(el('h3', '', '附近可吃可玩'));
      if (f.city) eh.appendChild(el('span', 'meta', f.city));
      ex.appendChild(eh);
      plan.nearbyExtras.forEach(function (x, xi) {
        var o = el('div', 'near c-' + x.type);
        o.appendChild(el('span', 'near-ico', TYPE_ICON[x.type] || '📍'));
        var mid = el('div', 'near-mid');
        var nm = link(x.name, L.mapSearchUrl(x.mapQuery)); nm.className = 'near-name';
        mid.appendChild(nm);
        mid.appendChild(el('div', 'near-sub', [L.TYPE_LABEL[x.type], x.why].filter(Boolean).join(' · ')));
        o.appendChild(mid);
        // 一鍵加進目前這一天的最後；多天行程在編輯模式可以選加到哪一天
        if (state.editing && plan.days.length > 1) {
          var mb = el('div', 'mini-btns');
          plan.days.forEach(function (d, di) {
            mb.appendChild(button('加到' + d.label, '', function () { editStop(function (p) { return L.extraToStop(p, xi, di, null); }); }));
          });
          mid.appendChild(mb);
        } else if (canEdit) {
          o.appendChild(button('加入', 'near-add', function () {
            editStop(function (p) { return L.extraToStop(p, xi, state.day, null); });
            msg('msg-result', '「' + x.name + '」已加到行程最後，可以按「編輯行程」調整時間。', 'ok');
          }));
        }
        ex.appendChild(o);
      });
      box.appendChild(ex);
    }

    if (plan.lodging.length) {
      var lg = el('div', 'card glass sec');
      lg.appendChild(el('h3', '', '住宿建議'));
      plan.lodging.forEach(function (x) {
        var o = el('div', 'opt');
        o.appendChild(el('div', 'name', [x.name, x.area].filter(Boolean).join(' · ')));
        var s = [x.priceRange, x.why].filter(Boolean).join(' · ');
        if (s) o.appendChild(el('div', 'meta', s));
        var ls = el('div', 'links'); ls.appendChild(link('地圖', L.mapSearchUrl(x.mapQuery || x.area)));
        o.appendChild(ls);
        lg.appendChild(o);
      });
      box.appendChild(lg);
    }

    var bt = L.budgetTotal(plan, f.people);
    if (bt.perPerson) {
      var bc = el('div', 'card glass sec');
      bc.appendChild(el('h3', '', '預算估算'));
      var tb = el('table', 'budget');
      plan.budget.forEach(function (b) {
        var tr = el('tr');
        var td = el('td', '', b.item);
        if (b.note) td.appendChild(el('div', 'meta', b.note));
        tr.appendChild(td);
        tr.appendChild(el('td', 'n', money(b.amount)));
        tb.appendChild(tr);
      });
      var tr1 = el('tr', 'total');
      tr1.appendChild(el('td', '', '每人合計'));
      tr1.appendChild(el('td', 'n', money(bt.perPerson)));
      tb.appendChild(tr1);
      if (bt.people > 1) {
        var tr2 = el('tr', 'total');
        tr2.appendChild(el('td', '', bt.people + ' 人合計'));
        tr2.appendChild(el('td', 'n', money(bt.total)));
        tb.appendChild(tr2);
      }
      bc.appendChild(tb);
      box.appendChild(bc);
    }

    renderChecks(box);

    if (plan.tips.length) {
      var tp = el('div', 'card glass sec');
      tp.appendChild(el('h3', '', '小提醒'));
      var ul3 = el('ul', 'plain');
      plan.tips.forEach(function (t) { ul3.appendChild(el('li', '', t)); });
      tp.appendChild(ul3);
      box.appendChild(tp);
    }
  }

  /* ================= 拖曳換順序（手指、滑鼠、鍵盤都可以） ================= */
  function bindDrag(ul, di) {
    ul.addEventListener('keydown', function (e) {
      var h = e.target.closest('.drag-h'); if (!h) return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      var from = Array.prototype.indexOf.call(ul.children, h.closest('li'));
      var to = from + (e.key === 'ArrowUp' ? -1 : 1);
      if (to < 0 || to >= ul.children.length) return;
      onReorder(di, from, to, true);
    });
    ul.addEventListener('pointerdown', function (e) {
      var h = e.target.closest('.drag-h'); if (!h || e.button > 0) return;
      var li = h.closest('li'), items = Array.prototype.slice.call(ul.children);
      var from = items.indexOf(li); if (from < 0) return;
      e.preventDefault();
      try { h.setPointerCapture(e.pointerId); } catch (err) {}
      state.dragging = true;
      var startY = e.clientY, to = from, step = li.getBoundingClientRect().height;
      var mids = items.map(function (it) { var r = it.getBoundingClientRect(); return r.top + r.height / 2; });
      li.classList.add('dragging');
      ul.classList.add('drag-on');
      function move(ev) {
        var dy = ev.clientY - startY, y = mids[from] + dy;
        li.style.transform = 'translateY(' + dy + 'px)';
        to = 0;
        mids.forEach(function (m, i) { if (i !== from && y > m) to++; });
        items.forEach(function (it, i) {
          if (it === li) return;
          var shift = from < to && i > from && i <= to ? -step : to < from && i >= to && i < from ? step : 0;
          it.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
        });
      }
      function up() {
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        h.removeEventListener('pointercancel', up);
        items.forEach(function (it) { it.style.transform = ''; });
        li.classList.remove('dragging'); ul.classList.remove('drag-on');
        state.dragging = false;
        if (to !== from) onReorder(di, from, to);
      }
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
    });
  }
  function onReorder(di, from, to, keepFocus) {
    var next = L.reorderStop(state.plan, di, from, to);
    if (next === state.plan) return;
    state.plan = next;
    renderPlan();
    if (keepFocus) {
      var hs = $('result').querySelectorAll('.day-panel')[di].querySelectorAll('.drag-h');
      if (hs[to]) hs[to].focus();
    }
    if (!state.tripId) { markDirty(); return; }
    saveOrder();
  }
  // 已存的行程：換完順序直接存回去（旅伴也可以，後端只允許換順序）
  function saveOrder() {
    var sp = state.tripSpace, id = state.tripId;
    var trip = { id: id, savedDate: state.tripSavedDate || todayYmd(), form: state.form || {}, plan: state.plan };
    var obj = sp ? L.shareTrip(trip) : L.cleanTrip(trip);
    if (!obj) return;
    msg('msg-result', '儲存順序中…');
    putItem(sp, 'trip', id, obj).then(function () {
      state.dirty = false; updateSaveButton();
      msg('msg-result', '已更新順序' + (sp ? '，旅伴那邊也會看到。' : '。'), 'ok');
    }, function (e) {
      msg('msg-result', e.message, 'err');
      var t = tripsIn(sp).filter(function (x) { return x.id === id; })[0];   // 存失敗就換回伺服器上的版本
      if (t) { state.plan = t.plan; renderPlan(); }
    });
  }

  function stopView(body, it, d, di, ii, f, mode) {
    body.appendChild(el('div', 'when', [it.time, L.TYPE_LABEL[it.type]].filter(Boolean).join(' · ')));
    body.appendChild(el('div', 'name', it.name));
    var line = [it.transport, it.note].filter(Boolean).join(' · ');
    if (line) body.appendChild(el('div', 'sub', line));
    var small = [];
    if (it.duration) small.push('停留 ' + it.duration);
    if (it.cost) small.push('每人約 ' + money(it.cost));
    if (small.length) body.appendChild(el('div', 'sub2', small.join(' · ')));
    if (it.verify) body.appendChild(el('span', 'verify', '出發前確認營業／預約'));
    if (it.mapQuery && it.type !== 'transport') {
      var links = el('div', 'links');
      links.appendChild(link('地圖', L.mapSearchUrl(it.mapQuery)));
      // 第一天第一個地點：從出發地（家裡／車站／飯店）導航
      var from = L.prevPlace(d.items, ii) || (di === 0 ? L.originPlace(f.origin) : '');
      links.appendChild(link(from ? '從上一站導航' : '導航', L.mapDirUrl(from, it.mapQuery, mode)));
      body.appendChild(links);
    }
  }

  var TYPE_ICON = { transport: '🚆', sight: '🏞️', food: '🍜', snack: '🍡', lodging: '🛏️', shop: '🛍️', rest: '☕' };
  // 「約 6 小時」：第一天第一站到最後一站的時間差；兩天以上直接寫天數
  function planDuration(plan) {
    if (plan.days.length > 1) return plan.days.length === 2 ? '兩天一夜' : plan.days.length + ' 天';
    var ts = plan.days[0].items.map(function (it) { return it.time; }).filter(function (t) { return /^\d{2}:\d{2}$/.test(t); });
    if (ts.length < 2) return '';
    function m(t) { return Number(t.slice(0, 2)) * 60 + Number(t.slice(3)); }
    var mins = m(ts[ts.length - 1]) - m(ts[0]);
    if (mins <= 0) return '';
    var h = Math.round(mins / 30) / 2;
    return '約 ' + h + ' 小時';
  }

  // 編輯模式：一站一組欄位。文字欄位改完（change）就存進 state，不重畫，免得游標跳掉
  function stopEditor(di, ii, it, plan) {
    var wrap = el('div', '');
    var grid = el('div', 'edit-row');
    function field(inp, key, conv) {
      inp.addEventListener('change', function () {
        var v = conv ? conv(inp.value) : inp.value, o = {}; o[key] = v;
        state.plan = L.updateStop(state.plan, di, ii, o); markDirty();
        if (key === 'time' || key === 'type') renderPlan();
      });
      return inp;
    }
    var t = el('input'); t.type = 'time'; t.value = it.time; t.setAttribute('aria-label', '時間');
    grid.appendChild(field(t, 'time'));
    var ty = el('select'); ty.setAttribute('aria-label', '類型');
    L.TYPES.forEach(function (k) { var o = el('option', '', L.TYPE_LABEL[k]); o.value = k; ty.appendChild(o); });
    ty.value = it.type;
    grid.appendChild(field(ty, 'type'));
    var nmI = el('input', 'wide'); nmI.type = 'text'; nmI.value = it.name; nmI.maxLength = 100; nmI.setAttribute('aria-label', '名稱');
    grid.appendChild(field(nmI, 'name'));
    var note = el('input', 'wide'); note.type = 'text'; note.value = it.note; note.maxLength = 200; note.placeholder = '備註'; note.setAttribute('aria-label', '備註');
    grid.appendChild(field(note, 'note'));
    var cost = el('input'); cost.type = 'number'; cost.min = '0'; cost.value = it.cost || ''; cost.placeholder = '每人 NT$'; cost.setAttribute('aria-label', '每人費用');
    grid.appendChild(field(cost, 'cost', function (v) { return Number(v) || 0; }));
    var dur = el('input'); dur.type = 'text'; dur.value = it.duration; dur.maxLength = 30; dur.placeholder = '停留多久'; dur.setAttribute('aria-label', '停留時間');
    grid.appendChild(field(dur, 'duration'));
    wrap.appendChild(grid);
    var mb = el('div', 'mini-btns');
    var n = plan.days[di].items.length;
    if (ii > 0) mb.appendChild(button('↑ 往前', '', function () { editStop(function (p) { return L.moveStop(p, di, ii, -1); }); }));
    if (ii < n - 1) mb.appendChild(button('↓ 往後', '', function () { editStop(function (p) { return L.moveStop(p, di, ii, 1); }); }));
    if (plan.nearbyExtras.length) {
      var sw = el('select'); sw.setAttribute('aria-label', '換成備選');
      var o0 = el('option', '', '換成備選…'); o0.value = ''; sw.appendChild(o0);
      plan.nearbyExtras.forEach(function (x, xi) { var o = el('option', '', x.name); o.value = String(xi); sw.appendChild(o); });
      sw.addEventListener('change', function () {
        if (sw.value === '') return;
        var xi = Number(sw.value);
        editStop(function (p) { return L.extraToStop(p, xi, di, ii); });
      });
      mb.appendChild(sw);
    }
    mb.appendChild(armed(button('刪除這站', 'danger', null), '確定刪除？', function () {
      editStop(function (p) { return L.removeStop(p, di, ii); });
    }));
    wrap.appendChild(mb);
    return wrap;
  }

  /* ================= 出發前清單（可勾選、可認領） ================= */
  function renderChecks(box) {
    var plan = state.plan;
    if (!state.tripId) {
      if (!plan.checkBefore.length) return;
      var c0 = el('div', 'card glass sec');
      c0.appendChild(el('h3', '', '出發前確認'));
      var u0 = el('ul', 'plain');
      plan.checkBefore.forEach(function (t) { u0.appendChild(el('li', '', t)); });
      c0.appendChild(u0);
      c0.appendChild(el('p', 'hint2', '存起來之後可以勾選、認領「我來負責」，存在群組的話旅伴也看得到。'));
      box.appendChild(c0);
      return;
    }
    var sp = state.tripSpace, tripId = state.tripId, me = sp ? myId(sp) : myNick(sp), canEdit = isOwnerOf(sp);
    var list = checksIn(sp, tripId);
    var cb = el('div', 'card glass sec');
    cb.appendChild(el('h3', '', '出發前確認' + (sp ? '（大家都能勾、可以認領）' : '')));
    var ul = el('ul', 'check');
    list.forEach(function (c) {
      var li = el('li', c.done ? 'done' : '');
      var lab = el('label'), ck = el('input');
      ck.type = 'checkbox'; ck.checked = c.done;
      ck.addEventListener('change', function () { saveCheck(c, { done: ck.checked }); });
      lab.appendChild(ck); lab.appendChild(el('span', 't', c.text));
      li.appendChild(lab);
      if (c.who) {
        var mine = c.who === me || (sp && c.who === myNick(sp));
        li.appendChild(button(who(sp, c.who) + ' 負責 ×', 'who' + (mine ? ' mine' : ''), function () { saveCheck(c, { who: '' }); }));
      } else {
        li.appendChild(button('我來', 'who', function () { saveCheck(c, { who: me }); }));
      }
      if (canEdit) li.appendChild(armed(button('刪', 'who', null), '確定？', function () {
        delItem(sp, 'check', c.id).then(function () { renderPlan(); }, function (e) { msg('msg-result', e.message, 'err'); });
      }));
      ul.appendChild(li);
    });
    cb.appendChild(ul);
    if (!canEdit) { box.appendChild(cb); return; }   // 旅伴：只能打勾、認領
    var add = el('div', 'check-add');
    var inp = el('input'); inp.type = 'text'; inp.maxLength = 100; inp.placeholder = '加一項，例：帶行動電源'; inp.setAttribute('aria-label', '新增確認項目');
    add.appendChild(inp);
    add.appendChild(button('加一項', 'btn small', function () {
      var order = list.reduce(function (m, c) { return Math.max(m, c.order); }, -1) + 1;
      var c = L.normalizeCheck({ text: inp.value, order: order }, tripId + '.' + newId('u'));
      if (!c) { msg('msg-result', '先打要確認的事', 'err'); return; }
      putItem(sp, 'check', c.id, c).then(function () { renderPlan(); }, function (e) { msg('msg-result', e.message, 'err'); });
    }));
    cb.appendChild(add);
    box.appendChild(cb);
  }
  function saveCheck(c, fields) {
    var o = {}; Object.keys(c).forEach(function (k) { o[k] = c[k]; });
    Object.keys(fields).forEach(function (k) { o[k] = fields[k]; });
    putItem(state.tripSpace, 'check', c.id, o).then(function () { renderPlan(); }, function (e) { msg('msg-result', e.message, 'err'); renderPlan(); });
  }

  /* ================= 儲存可靠度 ================= */
  var persistAsked = false;
  function askPersist() {
    if (persistAsked) return; persistAsked = true;
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {}); } catch (e) {}
  }
  function storageWorks() {
    try { localStorage.setItem('quicktrip.probe', '1'); localStorage.removeItem('quicktrip.probe'); return true; } catch (e) { return false; }
  }
  // LINE、FB、IG、Messenger 等 App 內建瀏覽器：資料常常關掉就不見
  function inAppBrowser() {
    return /Line\/|FBAN|FBAV|FB_IAB|Instagram|Messenger|MicroMessenger|; wv\)/i.test(navigator.userAgent || '');
  }
  function checkStorage() {
    var w = $('storage-warn'), text = '';
    if (auth()) text = '';   // 登入後資料都在雲端，瀏覽器關掉也不會不見
    else if (!storageWorks()) text = '這個瀏覽器不讓網頁存資料（可能是無痕模式），存的行程關掉就會不見。請改用一般模式的 Safari 或 Chrome 打開。';
    else if (inAppBrowser()) text = '你現在是在 App 裡的內建瀏覽器打開，這裡存的資料可能關掉就不見。到「旅伴」頁登入，資料就會存到你的帳號。';
    w.textContent = text;
    w.classList.toggle('hidden', !text);
  }

  /* ================= 備份（只備份「我自己」） ================= */
  function onExport() {
    var text = L.buildBackup(tripsIn(''), wishesIn(''), todayYmd());
    try {
      var url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      var a = document.createElement('a');
      a.href = url; a.download = 'quick-trip-backup-' + todayYmd() + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      msg('msg-backup', '已匯出：行程 ' + tripsIn('').length + ' 筆、願望 ' + wishesIn('').length + ' 筆。檔案在「下載項目／檔案」App 裡。', 'ok');
    } catch (e) {
      msg('msg-backup', '這個瀏覽器不能下載檔案，請改用 Safari 或 Chrome。', 'err');
    }
  }
  function onImportFile() {
    var f = $('import-file').files[0];
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      var r = L.parseBackup(rd.result);
      if (!r.ok) { msg('msg-backup', r.error, 'err'); return; }
      if (auth()) {   // 登入中：直接搬進帳號（雲端已經有的同一筆不蓋掉）
        store(KEY_TRIPS, r.trips); store(KEY_WISH, r.wishes); store(KEY_CHECKS, null);
        var notes = [];
        msg('msg-backup', '匯入中…');
        migrateLocal(notes).then(function () { updateCount(); renderSaved(); msg('msg-backup', notes.join(' ') || '沒有新的資料。', 'ok'); });
        return;
      }
      var t = L.mergeById(tripsIn(''), r.trips, 30), w = L.mergeById(wishesIn(''), r.wishes, L.WISH_MAX);
      if (!store(KEY_TRIPS, t) || !store(KEY_WISH, w)) { msg('msg-backup', '存不進去（瀏覽器空間不足或無痕模式）', 'err'); return; }
      askPersist();
      updateCount(); renderSaved();
      msg('msg-backup', '已匯入：行程 ' + r.trips.length + ' 筆、願望 ' + r.wishes.length + ' 筆（同一筆以備份為準）。', 'ok');
    };
    rd.onerror = function () { msg('msg-backup', '讀不到這個檔案', 'err'); };
    rd.readAsText(f);
    $('import-file').value = '';
  }

  /* ================= 行程清單 ================= */
  function updateCount() {
    var n = trips().length; $('saved-count').textContent = n ? '(' + n + ')' : '';
    var w = L.filterWishes(wishes(), {}).length; $('wish-count').textContent = w ? '(' + w + ')' : '';
  }
  function renderSaved() {
    var box = $('saved-list'), list = trips();
    $('saved-space-hint').textContent = state.space ? '「' + spaceName(state.space) + '」共用的行程，旅伴存的也在這裡。' : '';
    $('backup-card').classList.toggle('hidden', !!state.space);
    box.textContent = '';
    if (!list.length) { box.appendChild(el('div', 'card empty', guest() ? '建立者還沒有分享行程，排好後會出現在這裡。' : '還沒有存任何行程。排好一趟之後按「存起來」。')); return; }
    list.forEach(function (t) {
      var card = el('div', 'card trip-item');
      var g = el('div', 'grow');
      g.appendChild(el('div', 'name', t.plan.title));
      var f = t.form || {};
      g.appendChild(el('div', 'meta', [f.date ? L.dayLabel(f.date) : '', L.destText(f)].filter(Boolean).join(' · ')));
      card.appendChild(g);
      card.appendChild(button('打開', 'btn small', function () {
        state.plan = t.plan; state.form = f; state.tripId = t.id; state.tripSpace = state.space; state.tripSavedDate = t.savedDate;
        state.dirty = false; state.editing = false; state.day = 0;
        openResult();
      }));
      var sp = state.space;
      if (isOwnerOf(sp)) card.appendChild(armed(button('刪除', 'btn small ghost', null), '確定刪除？', function () {
        delItem(sp, 'trip', t.id).then(function () { updateCount(); renderSaved(); }, function (e) { msg('msg-backup', e.message, 'err'); });
      }));
      box.appendChild(card);
    });
  }

  /* ================= 帳號 ================= */
  function renderAccount() {
    var a = auth();
    // 沒登入：登入框放在最上面（按「先不登入」才收起來）；登入後改到「旅伴」頁管理帳號
    $('login-card').classList.toggle('hidden', !!a || !!state.skipLogin || state.view === 'result');
    $('acct-card').classList.toggle('hidden', !a);
    if (a) $('acct-who').textContent = a.name;
    var legacy = !a && groups().some(function (g) { return g.legacy; });
    $('acct-legacy').classList.toggle('hidden', !legacy);
  }
  function readCred() {
    var name = L.cleanNick($('acct-name').value), pass = $('acct-pass').value;
    if (!name) { msg('msg-login', '請填名字', 'err'); $('acct-name').focus(); return null; }
    if (pass.length < 4) { msg('msg-login', '密碼至少 4 個字', 'err'); $('acct-pass').focus(); return null; }
    return { name: name, pass: pass };
  }
  function onAuth(action) {
    var c = readCred(); if (!c) return;
    var bs = [$('btn-login'), $('btn-signup')];
    bs.forEach(function (b) { b.disabled = true; });
    msg('msg-login', action === 'signup' ? '建立中…' : '登入中…');
    S.call(action, c).then(function (d) {
      store(KEY_AUTH, { token: d.token, accountId: d.accountId, personalId: d.personalId, name: d.name });
      store(KEY_NICK, d.name);
      $('acct-pass').value = '';
      msg('msg-login', ''); msg('msg-top', (action === 'signup' ? '帳號建立好了' : '歡迎回來') + '，' + d.name + '！', 'ok');
      return afterLogin(action === 'signup');
    }).then(null, function (e) { msg('msg-login', e.message, 'err'); }).then(function () {
      bs.forEach(function (b) { b.disabled = false; });
    });
  }
  // 登入後：舊身分搬到帳號、手機裡的資料搬上雲端、拿回群組清單、處理等著的邀請
  function afterLogin(fresh) {
    var notes = [];
    return migrateGroups(notes).then(function () { return migrateLocal(notes); }).then(function () {
      return refreshMe();
    }).then(function () {
      state.lastSync = 0; switchSpace(state.space); renderGroups();
      if (notes.length) msg('msg-top', $('msg-top').textContent + ' ' + notes.join(' '), notes.some(function (n) { return /沒有搬/.test(n); }) ? 'err' : 'ok');
      var j = state.pendingJoin;
      if (!j) return;
      // 剛建好的帳號：讓他確認在群組裡的暱稱（被釋放的旅伴要填回原本的暱稱才拿得回自己的點）
      if (fresh) { $('join-nick').value = myNick(''); renderGroups(); $('join-hint').textContent = '最後一步：確認你在這個群組的暱稱，按「加入」。'; try { $('join-nick').focus(); } catch (e) {} }
      else joinWithNick(j, myNick(''));
    });
  }
  function migrateGroups(notes) {
    var legacy = groups().filter(function (g) { return g.legacy; });
    return legacy.reduce(function (p, g) {
      return p.then(function () {
        var req = g.ownerKey ? call('linkOwner', null, { groupId: g.groupId, ownerKey: g.ownerKey, inviteKey: g.inviteKey || '' })
          : g.memberId && g.memberKey ? call('linkMember', null, { groupId: g.groupId, memberId: g.memberId, memberKey: g.memberKey })
          : call('joinGroup', null, { groupId: g.groupId, key: g.inviteKey || g.key, nick: g.nick });
        return req.then(function () { notes.push('「' + g.name + '」已經搬到你的帳號。'); },
          function (e) { notes.push('「' + g.name + '」沒有搬過去：' + e.message); });
      });
    }, Promise.resolve());
  }
  // 手機裡「我自己」的資料一次搬上去（雲端已經有的不蓋掉），搬完就從手機刪掉
  function migrateLocal(notes) {
    var items = [];
    ['wish', 'trip', 'check'].forEach(function (kind) {
      localList(kind).forEach(function (x) {
        if (!x || !x.id) return;
        var body = {}; Object.keys(x).forEach(function (k) { if (k !== 'id') body[k] = x[k]; });
        items.push({ kind: kind, itemId: String(x.id), json: JSON.stringify(body) });
      });
    });
    if (!items.length) return Promise.resolve();
    var batches = [], cur = [], size = 0;
    items.forEach(function (it) {
      var n = it.json.length + 80;
      if (cur.length && (size + n > 30000 || cur.length >= 150)) { batches.push(cur); cur = []; size = 0; }
      cur.push(it); size += n;
    });
    if (cur.length) batches.push(cur);
    var cid = cloudId(''), added = 0;
    return batches.reduce(function (p, b) {
      return p.then(function () {
        return call('importItems', '', { json: JSON.stringify({ items: b }) }).then(function (d) {
          added += d.added; setGcache(cid, L.mergeRows(gcache(cid), d.items));
        });
      });
    }, Promise.resolve()).then(function () {
      [KEY_WISH, KEY_TRIPS, KEY_CHECKS].forEach(function (k) { store(k, null); });
      if (added) notes.push('這支手機原本存的 ' + added + ' 筆資料已經搬到你的帳號。');
    }, function (e) { notes.push('手機裡的資料沒有搬完（' + e.message + '），下次登入會再試。'); });
  }
  // 登出：這支手機不留任何雲端資料
  function logoutLocal() {
    var a = auth();
    groups().forEach(function (g) { store(KEY_GC + g.groupId, null); });
    if (a) store(KEY_GC + a.personalId, null);
    store(KEY_GROUPS, null); store(KEY_AUTH, null);
    state.space = ''; store(KEY_SPACE, ''); state.lastSync = 0; state.gdFor = null;
    renderSpaceBar(); statusIdle(); refreshViews(); renderAccount();
  }
  function onLogout() {
    logoutLocal(); renderGroups();
    msg('msg-top', '已登出，這支手機上的雲端資料都清掉了。', 'ok');
    window.scrollTo(0, 0);
  }
  function onSetPass() {
    var oldp = $('acct-old').value, newp = $('acct-new').value;
    if (newp.length < 4) { msg('msg-acct', '新密碼至少 4 個字', 'err'); return; }
    var b = $('btn-setpass'); b.disabled = true; msg('msg-acct', '更新中…');
    call('setPass', null, { pass: oldp, newPass: newp }).then(function (d) {
      store(KEY_AUTH, { token: d.token, accountId: d.accountId, personalId: d.personalId, name: d.name });
      $('acct-old').value = ''; $('acct-new').value = '';
      msg('msg-acct', '密碼改好了。其他瀏覽器要用新密碼重新登入。', 'ok');
    }, function (e) { msg('msg-acct', e.message, 'err'); }).then(function () { b.disabled = false; });
  }

  /* ================= 旅伴頁 ================= */
  function renderGroups() {
    $('group-off').classList.toggle('hidden', S.configured());
    renderAccount();
    var a = auth();
    var list = $('space-list'); list.textContent = '';
    [{ groupId: '', name: '📱 我自己', note: a ? '存在你的帳號，換手機也看得到' : '只存在這支手機（登入後就能帶著走）' }].concat(groups().map(function (g) {
      return { groupId: g.groupId, name: '👥 ' + g.name, note: g.legacy ? '登入後會搬到你的帳號' : '你是「' + g.nick + '」' + (g.role === 'owner' ? ' · 你建立的' : '') };
    })).forEach(function (o) {
      var b = el('button', '', o.name); b.type = 'button';
      b.appendChild(el('small', '', o.note));
      b.setAttribute('aria-pressed', String(o.groupId === state.space));
      b.addEventListener('click', function () { switchSpace(o.groupId); renderGroups(); });
      list.appendChild(b);
    });
    var g = group(state.space);
    if (g && g.legacy) g = null;
    $('group-detail').classList.toggle('hidden', !g);
    if (g) {
      var owner = g.role === 'owner';
      $('gd-name').textContent = g.name;
      $('gd-meta').textContent = '你在這個群組是「' + g.nick + '」' + (state.lastSync ? ' · 最後同步 ' + hhmm(state.lastSync) : '');
      $('gd-link').value = g.inviteKey ? L.inviteUrl(location.href, g.groupId, g.inviteKey) : owner ? '（按下面的「重設邀請連結」產生新的連結）' : '（請建立者傳邀請連結給你）';
      $('btn-gd-share').classList.toggle('hidden', !navigator.share || !g.inviteKey);
      $('gd-owner').classList.toggle('hidden', !owner);
      // 同步會每 20 秒重畫這一頁：正在打的名稱／暱稱不要被舊值蓋掉，換群組時才重填
      var fresh = state.gdFor !== g.groupId;
      state.gdFor = g.groupId;
      ['gd-rename', 'gd-nick'].forEach(function (id) {
        var inp = $(id);
        if (fresh || inp.getAttribute('data-dirty') !== '1') { inp.value = id === 'gd-rename' ? g.name : g.nick; inp.removeAttribute('data-dirty'); }
      });
      var leave = $('btn-gd-leave');   // 「確定離開？」按到一半遇到同步重畫，不要被重設
      leave.classList.toggle('hidden', owner);
      if (fresh || leave.getAttribute('data-armed') !== '1') { leave.removeAttribute('data-armed'); leave.textContent = '離開群組'; }
      renderMembers(g);
    }
    $('ng-login').classList.toggle('hidden', !!a);
    $('ng-form').classList.toggle('hidden', !a);
    if (a && !$('ng-nick').value) $('ng-nick').value = a.name;
    var jc = !!state.pendingJoin;
    $('join-card').classList.toggle('hidden', !jc);
    $('join-form').classList.toggle('hidden', !a);
    $('join-login').classList.toggle('hidden', !!a);
    if (jc && a && !$('join-nick').value) $('join-nick').value = a.name;
  }
  // 成員名單：誰在群組裡；建立者可以「釋放」（旅伴忘記密碼時用）或「移出」
  var STATUS_TEXT = { released: '已釋放，等本人用同暱稱重新加入', kicked: '已移出', left: '已離開' };
  function renderMembers(g) {
    var box = $('gd-members'), list = membersIn(g.groupId), owner = g.role === 'owner';
    box.textContent = '';
    $('gd-members-hint').classList.toggle('hidden', !owner);
    if (!list.length) { box.appendChild(el('div', 'hint2', '同步後會列出成員。')); return; }
    var order = { active: 0, released: 1, kicked: 2, left: 3 };
    list.slice().sort(function (a, b) { return order[a.status] - order[b.status] || (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : 0); }).forEach(function (m) {
      var row = el('div', 'member' + (m.status === 'active' ? '' : ' gone'));
      var nm = el('div', 'grow');
      nm.appendChild(el('span', 'name', m.nick));
      if (m.role === 'owner') nm.appendChild(el('span', 'badge', '建立者'));
      if (m.memberId === g.memberId) nm.appendChild(el('span', 'badge me', '你'));
      if (STATUS_TEXT[m.status]) nm.appendChild(el('div', 'meta', STATUS_TEXT[m.status]));
      row.appendChild(nm);
      if (owner && m.role !== 'owner' && (m.status === 'active' || m.status === 'released')) {
        var mb = el('div', 'mini-btns');
        if (m.status === 'active') mb.appendChild(armed(button('釋放', '', null), '確定釋放？', function () { removeMember(g, m, 'release'); }));
        mb.appendChild(armed(button('移出', 'danger', null), '確定移出？', function () { removeMember(g, m, 'kick'); }));
        row.appendChild(mb);
      }
      box.appendChild(row);
    });
  }
  function removeMember(g, m, mode) {
    msg('msg-gd', mode === 'release' ? '釋放中…' : '移出中…');
    call('removeMember', g.groupId, { targetId: m.memberId, mode: mode }).then(function (d) {
      var c = gcache(g.groupId); c.members = L.cleanMembers(d.members); setGcache(g.groupId, c);
      renderGroups();
      msg('msg-gd', mode === 'release'
        ? '已釋放「' + m.nick + '」。請他建立新帳號（或登入別的帳號），用同一個暱稱重新點邀請連結，就能拿回原本加的點。'
        : '已把「' + m.nick + '」移出群組，他加過的點會留著並標示已離開。要防他再加入，記得按「重設邀請連結」。', 'ok');
    }, function (e) { msg('msg-gd', e.message, 'err'); });
  }

  function onCreateGroup() {
    var name = L.cleanGroupName($('ng-name').value), nick = L.cleanNick($('ng-nick').value);
    if (!auth()) { msg('msg-ng', '請先在上面登入', 'err'); return; }
    if (!name || !nick) { msg('msg-ng', '群組名稱和暱稱都要填', 'err'); return; }
    var b = $('btn-ng'); b.disabled = true; msg('msg-ng', '建立中…');
    call('createGroup', null, { name: name, nick: nick }).then(function (d) {
      upsertGroup({ groupId: d.groupId, name: d.name, memberId: d.memberId, nick: d.nick, role: d.role, inviteKey: d.inviteKey });
      $('ng-name').value = '';
      msg('msg-ng', '已建立「' + name + '」。把上面的邀請連結傳給旅伴就可以了。', 'ok');
      switchSpace(d.groupId); renderGroups();
    }, function (e) { msg('msg-ng', e.message, 'err'); }).then(function () { b.disabled = false; });
  }
  function onJoin() {
    var j = state.pendingJoin, nick = L.cleanNick($('join-nick').value);
    if (!j || !auth()) return;
    if (!nick) { msg('msg-join', '請填暱稱', 'err'); $('join-nick').focus(); return; }
    var b = $('btn-join'); b.disabled = true; msg('msg-join', '加入中…');
    doJoin(j, nick).then(null, function (e) { msg('msg-join', e.message, 'err'); $('join-nick').focus(); }).then(function () { b.disabled = false; });
  }
  // 用邀請碼加入：身分綁在帳號上。回傳 Promise
  function doJoin(j, nick) {
    return call('joinGroup', null, { groupId: j.groupId, key: j.key, nick: nick }).then(function (d) {
      var fresh = !group(j.groupId);
      upsertGroup({ groupId: d.groupId, name: d.name, memberId: d.memberId, nick: d.nick, role: d.role, inviteKey: d.inviteKey || j.key });
      if (fresh) store(KEY_GC + j.groupId, null);
      state.pendingJoin = null;
      msg('msg-join', '');
      switchSpace(j.groupId); show('group');
      msg('msg-gd', fresh ? '已加入「' + d.name + '」！你在這個群組是「' + d.nick + '」（下面可以改）。' + (guest() ? '到「行程」分頁看大家的行程。' : '')
        : '你已經在「' + d.name + '」了，你是「' + d.nick + '」。', 'ok');
    });
  }
  // 點邀請連結：沒登入 → 先登入（第一次就建帳號），登入後自動加入；已登入 → 直接加入（暱稱撞到才請他換）
  function handleInvite(inv) {
    if (!auth()) {
      state.pendingJoin = inv;
      show('group');
      $('join-hint').textContent = '正在確認邀請…';
      S.call('previewGroup', { groupId: inv.groupId, key: inv.key }).then(function (d) {
        if (state.pendingJoin !== inv) return;
        $('join-hint').textContent = '「' + d.name + '」邀請你一起規劃行程。先登入，第一次用就建立帳號（名字＋密碼），之後換手機也不會搞丟。';
      }, function (e) {
        if (state.pendingJoin !== inv) return;
        $('join-hint').textContent = ''; msg('msg-join', e.message, 'err');
      });
      state.skipLogin = false; renderAccount();
      try { $('acct-name').focus(); } catch (e) {}
      return;
    }
    var g = group(inv.groupId);
    if (g && !g.legacy) {
      state.pendingJoin = null;
      switchSpace(g.groupId); show('group');
      msg('msg-gd', '你已經在「' + g.name + '」了，你是「' + g.nick + '」。', 'ok');
      return;
    }
    joinWithNick(inv, myNick(''));
  }
  function joinWithNick(inv, nick) {
    state.pendingJoin = null;
    show('group');
    msg('msg-gd', '加入中…');
    doJoin(inv, nick).then(null, function (e) {
      msg('msg-gd', '');
      state.pendingJoin = inv; renderGroups();
      $('join-hint').textContent = /已經有人用了/.test(e.message) ? '這個群組已經有人叫「' + nick + '」了，換一個暱稱吧。' : '';
      msg('msg-join', e.message, 'err');
      $('join-nick').value = '';
      try { $('join-nick').focus(); } catch (x) {}
    });
  }
  function onJoinLink() {
    var j = L.parseInvite($('jl-link').value);
    if (!j) { msg('msg-jl', '這不像邀請連結，請整段貼上（要有 #join= 那段）', 'err'); return; }
    msg('msg-jl', '');
    $('jl-link').value = '';
    handleInvite(j);
  }
  function onCopyInvite() {
    copyText($('gd-link').value, $('gd-link')).then(function (ok) {
      msg('msg-gd', ok ? '已複製，貼到 LINE 傳給旅伴。' : '請長按連結全選後複製。', ok ? 'ok' : 'err');
    });
  }
  function onShareInvite() {
    var g = group(state.space); if (!g) return;
    navigator.share({ title: '一起規劃「' + g.name + '」', text: '點連結加入「' + g.name + '」一起排行程：', url: $('gd-link').value }).catch(function () {});
  }
  function onReset() {
    var g = group(state.space); if (!g || g.role !== 'owner') return;
    call('resetInvite', g.groupId, {}).then(function (d) {
      patchGroup(g.groupId, { inviteKey: d.inviteKey });
      renderGroups();
      msg('msg-gd', '新的邀請連結好了。舊連結不能再用來加入（已經加入的人不受影響）。', 'ok');
    }, function (e) { msg('msg-gd', e.message, 'err'); });
  }
  function onRename() {
    var g = group(state.space), name = L.cleanGroupName($('gd-rename').value);
    if (!g || g.role !== 'owner') return;
    if (!name) { msg('msg-gd', '請填群組名稱', 'err'); return; }
    var b = $('btn-gd-rename'); b.disabled = true; msg('msg-gd', '改名中…');
    call('renameGroup', g.groupId, { name: name }).then(function () {
      $('gd-rename').removeAttribute('data-dirty');
      patchGroup(g.groupId, { name: name }); renderSpaceBar(); renderGroups();
      msg('msg-gd', '已改名，旅伴下次同步就會看到。', 'ok');
    }, function (e) { msg('msg-gd', e.message, 'err'); }).then(function () { b.disabled = false; });
  }
  function onNick() {
    var g = group(state.space), nick = L.cleanNick($('gd-nick').value);
    if (!g) return;
    if (!nick) { msg('msg-gd', '請填暱稱', 'err'); return; }
    var b = $('btn-gd-nick'); b.disabled = true; msg('msg-gd', '更新中…');
    call('setNick', g.groupId, { nick: nick }).then(function (d) {
      $('gd-nick').removeAttribute('data-dirty');
      patchGroup(g.groupId, { nick: d.nick });
      renderSpaceBar(); pullNow(); renderGroups();
      msg('msg-gd', '已改成「' + d.nick + '」，你加過的點也會一起顯示新名字。', 'ok');
    }, function (e) { msg('msg-gd', e.message, 'err'); }).then(function () { b.disabled = false; });
  }
  function onLeave() {
    var g = group(state.space), b = $('btn-gd-leave');
    if (!g || g.role === 'owner') return;
    if (b.getAttribute('data-armed') !== '1') {
      b.setAttribute('data-armed', '1');
      b.textContent = '確定離開？（你加的點會留著）';
      return;
    }
    b.disabled = true;
    call('leaveGroup', g.groupId, {}).then(function () {
      b.removeAttribute('data-armed'); b.textContent = '離開群組'; state.gdFor = null;
      dropGroup(g.groupId);
      msg('msg-ng', '已離開「' + g.name + '」。', 'ok');
    }, function (e) { msg('msg-gd', e.message, 'err'); }).then(function () { b.disabled = false; });
  }
  function onImportWishes() {
    var sp = state.space; if (!sp) return;
    var have = {}; wishesIn(sp).forEach(function (w) { have[w.id] = true; });
    var mine = L.filterWishes(wishesIn(''), {}).filter(function (w) { return !have[w.id]; });
    if (!mine.length) { msg('msg-gd', '「我自己」沒有新的願望可以複製。', 'ok'); return; }
    msg('msg-gd', '複製中…');
    mine.reduce(function (p, w) { return p.then(function () { return putItem(sp, 'wish', w.id, w); }); }, Promise.resolve()).then(function () {
      updateCount();
      msg('msg-gd', '已把 ' + mine.length + ' 個願望複製到「' + spaceName(sp) + '」。', 'ok');
    }, function (e) { msg('msg-gd', e.message, 'err'); });
  }

  /* ================= 綁定 ================= */
  function bindToggle(id, multi, after) {
    $(id).addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b || b.disabled) return;
      if (multi) b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
      else setSeg(id, b.getAttribute('data-v'));
      if (after) after(b.getAttribute('data-v'));
    });
  }
  function init() {
    buildMenus();
    setOtype('station', true);
    defaults();
    var draft = store(KEY_DRAFT);
    if (draft && typeof draft === 'object') {
      // 草稿的日期若已過，換成最近的星期六
      if (!draft.date || draft.date < todayYmd()) draft.date = L.nextSaturday(todayYmd());
      fillForm(draft);
    }
    state.space = group(store(KEY_SPACE)) ? store(KEY_SPACE) : '';

    bindToggle('f-days', false, renderQuick); bindToggle('f-pace', false, renderQuick);
    bindToggle('f-food', true); bindToggle('f-transport', true, renderQuick);
    bindToggle('f-mode', false, function (v) { setPressedTexts('f-transport', MODE_PRESET[v] || []); renderQuick(); });
    $('pill-days').addEventListener('click', function () { cycleSeg('f-days'); });
    $('pill-pace').addEventListener('click', function () { cycleSeg('f-pace'); });
    $('pill-budget').addEventListener('click', cycleBudget);
    $('f-budget').addEventListener('input', renderQuick);
    $('f-destination').addEventListener('change', autoCity);
    bindToggle('f-otype', false, function (v) { setSeg('f-otype', state.otype); setOtype(v); });
    bindToggle('w-scope', false, syncWishScope); bindToggle('w-kind');
    bindToggle('wf-scope', false, renderWishes); bindToggle('wf-kind', false, renderWishes);
    $('wf-done').addEventListener('change', renderWishes);
    $('f-city').addEventListener('change', function () { state.picked = {}; renderPicks(); });
    $('btn-prompt').addEventListener('click', onPrompt);
    $('btn-copy-open').addEventListener('click', function () { onCopy(true); });
    $('btn-copy').addEventListener('click', function () { onCopy(false); });
    $('btn-parse').addEventListener('click', onParse);
    $('btn-wish-add').addEventListener('click', onWishAdd);
    $('btn-export').addEventListener('click', onExport);
    $('btn-import').addEventListener('click', function () { $('import-file').click(); });
    $('import-file').addEventListener('change', onImportFile);
    $('btn-back').addEventListener('click', function () { show(isOwnerOf(state.tripSpace) && !guest() ? 'plan' : 'saved'); });
    $('btn-save').addEventListener('click', onSave);
    $('save-space').addEventListener('change', updateSaveButton);
    $('btn-edit').addEventListener('click', function () {
      state.editing = !state.editing;
      updateSaveButton(); renderPlan();
      // 完成編輯時，已經存過的行程直接存回原本的地方
      if (!state.editing && state.tripId && state.dirty) { $('save-space').value = state.tripSpace; onSave(); }
    });
    $('btn-print').addEventListener('click', function () { window.print(); });
    $('tab-plan').addEventListener('click', function () { show('plan'); });
    $('tab-wish').addEventListener('click', function () { show('wish'); });
    $('tab-saved').addEventListener('click', function () { show('saved'); });
    $('tab-group').addEventListener('click', function () { show('group'); });
    $('space-bar').addEventListener('click', function () { show('group'); });
    $('btn-login').addEventListener('click', function () { onAuth('login'); });
    $('btn-signup').addEventListener('click', function () { onAuth('signup'); });
    $('acct-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') onAuth('login'); });
    $('btn-logout').addEventListener('click', onLogout);
    $('btn-setpass').addEventListener('click', onSetPass);
    $('btn-join-login').addEventListener('click', function () { state.skipLogin = false; renderAccount(); window.scrollTo(0, 0); $('acct-name').focus(); });
    $('btn-skip-login').addEventListener('click', function () { state.skipLogin = true; renderAccount(); });
    $('btn-ng').addEventListener('click', onCreateGroup);
    $('btn-join').addEventListener('click', onJoin);
    $('btn-join-cancel').addEventListener('click', function () { state.pendingJoin = null; renderGroups(); });
    $('btn-jl').addEventListener('click', onJoinLink);
    $('btn-gd-copy').addEventListener('click', onCopyInvite);
    $('btn-gd-share').addEventListener('click', onShareInvite);
    $('btn-gd-reset').addEventListener('click', onReset);
    $('btn-gd-rename').addEventListener('click', onRename);
    ['gd-rename', 'gd-nick'].forEach(function (id) { $(id).addEventListener('input', function () { $(id).setAttribute('data-dirty', '1'); }); });
    $('btn-gd-nick').addEventListener('click', onNick);
    $('btn-gd-leave').addEventListener('click', onLeave);
    $('btn-gd-import').addEventListener('click', onImportWishes);
    syncWishScope();
    renderSpaceBar(); statusIdle();
    renderPicks();
    updateCount();
    if (guest()) show('saved'); else applyGuest();

    // 邀請連結：#join=群組.邀請碼 → 先從網址列拿掉（免得被截圖或轉傳），再加入
    function takeInvite() {
      var inv = L.parseInvite(location.hash);
      if (!inv) return;
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
      handleInvite(inv);
    }
    takeInvite();
    window.addEventListener('hashchange', takeInvite);   // 頁面開著時又點了一條邀請連結
    // 登入中：先跟後端對一次群組清單（換瀏覽器、被移出都在這裡更新），再同步資料
    (auth() ? refreshMe().then(null, function (e) { setStatus(e.message, true); }) : Promise.resolve()).then(pullNow);
    setInterval(function () { if (document.visibilityState === 'visible') pullNow(); }, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') pullNow(); });
  }
  init();
})();
