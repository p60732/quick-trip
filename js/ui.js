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
  var KEY_GC = 'quicktrip.gc.';          // + groupId：群組資料的本機快取
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

  /* ================= 群組與空間 ================= */
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
  function myNick(spaceId) { var g = group(spaceId); return g ? g.nick : (L.cleanNick(store(KEY_NICK)) || '我'); }
  function gcache(id) { var c = store(KEY_GC + id); return c && c.items && typeof c.items === 'object' ? c : { since: 0, items: {} }; }
  function setGcache(id, c) { store(KEY_GC + id, { since: c.since, items: c.items }); }

  /* ================= 資料層：同一套呼叫，「我自己」存手機、群組走後端 ================= */
  function wishesIn(sp) {
    if (!sp) return L.cleanWishes(store(KEY_WISH));
    return L.cleanWishes(L.listKind(gcache(sp), 'wish').map(function (x) { return x.obj; }));
  }
  function wishByMap(sp) {
    var m = {};
    if (sp) L.listKind(gcache(sp), 'wish').forEach(function (x) { m[x.obj.id] = x.by; });
    return m;
  }
  function tripsIn(sp) {
    if (!sp) return L.cleanTrips(store(KEY_TRIPS));
    return L.cleanTrips(L.listKind(gcache(sp), 'trip').map(function (x) { return x.obj; }));
  }
  function checksIn(sp, tripId) {
    if (!sp) return L.checksForTrip(store(KEY_CHECKS), tripId);
    return L.checksForTrip(L.listKind(gcache(sp), 'check').map(function (x) { return x.obj; }), tripId);
  }
  function wishes() { return wishesIn(state.space); }
  function trips() { return tripsIn(state.space); }

  function localList(kind) {
    return kind === 'wish' ? L.cleanWishes(store(KEY_WISH)) : kind === 'trip' ? L.cleanTrips(store(KEY_TRIPS)) : (store(KEY_CHECKS) || []);
  }
  function localKey(kind) { return kind === 'wish' ? KEY_WISH : kind === 'trip' ? KEY_TRIPS : KEY_CHECKS; }
  function localMax(kind) { return kind === 'wish' ? L.WISH_MAX : kind === 'trip' ? 30 : 2000; }

  // 寫入一筆。群組：帶版本號送後端，衝突就換成最新內容並回報
  function putItem(sp, kind, id, obj) {
    if (!sp) {
      var o = {}; Object.keys(obj).forEach(function (k) { o[k] = obj[k]; }); o.id = id;
      var list = localList(kind), idx = -1;
      list.forEach(function (x, i) { if (x && x.id === id) idx = i; });
      if (idx !== -1) list[idx] = o; else list = L.upsertTrip(list, o, localMax(kind));
      if (!store(localKey(kind), list)) return Promise.reject(new Error('存不進去（瀏覽器空間不足或無痕模式）'));
      return Promise.resolve();
    }
    var g = group(sp);
    if (!g) return Promise.reject(new Error('找不到這個群組'));
    var body = {}; Object.keys(obj).forEach(function (k) { if (k !== 'id') body[k] = obj[k]; });
    return S.call('put', {
      groupId: g.groupId, key: g.key, kind: kind, itemId: id, json: JSON.stringify(body),
      baseVer: L.itemVer(gcache(sp), kind, id), nick: g.nick
    }).then(function (d) { return afterWrite(sp, d); });
  }
  function delItem(sp, kind, id) {
    if (!sp) {
      store(localKey(kind), L.removeTrip(localList(kind), id));
      return Promise.resolve();
    }
    var g = group(sp);
    if (!g) return Promise.reject(new Error('找不到這個群組'));
    return S.call('del', {
      groupId: g.groupId, key: g.key, kind: kind, itemId: id, baseVer: L.itemVer(gcache(sp), kind, id), nick: g.nick
    }).then(function (d) { return afterWrite(sp, d); });
  }
  function afterWrite(sp, d) {
    setGcache(sp, L.mergeRows(gcache(sp), d && d.item ? [d.item] : []));
    if (d && d.conflict) {
      refreshViews();
      throw new Error('旅伴剛改過這一筆，已換成最新內容，請再改一次');
    }
  }

  /* ================= 同步 ================= */
  function setStatus(text, isErr) {
    var s = $('space-status'); s.textContent = text || ''; s.classList.toggle('err', !!isErr);
  }
  function statusIdle() {
    if (!state.space) setStatus('只存在這支手機');
    else setStatus(state.lastSync ? '已同步 ' + hhmm(state.lastSync) : '');
  }
  function pullNow() {
    var g = group(state.space);
    if (!g || !S.configured() || state.syncing) return Promise.resolve();
    state.syncing = true; setStatus('同步中…');
    var sp = g.groupId;
    return S.call('pull', { groupId: g.groupId, key: g.key, since: gcache(sp).since }).then(function (d) {
      var c2 = L.mergeRows(gcache(sp), d.items);
      setGcache(sp, c2);
      if (d.name && d.name !== g.name) patchGroup(sp, { name: L.cleanGroupName(d.name) });
      state.lastSync = Date.now();
      state.syncing = false;
      statusIdle();
      if (c2.changed && state.space === sp) refreshViews();
      renderSpaceBar();
    }, function (e) {
      state.syncing = false;
      setStatus(e.message, true);
    });
  }
  // 別人改了資料：重畫目前看到的畫面（正在編輯行程時不動，免得打字打到一半被洗掉）
  function refreshViews() {
    updateCount();
    if (state.view === 'wish') renderWishes();
    if (state.view === 'saved') renderSaved();
    if (state.view === 'plan') renderPicks();
    if (state.view === 'group') renderGroups();
    if (state.view === 'result' && state.plan && !state.editing) {
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
    state.view = view;
    ['plan', 'wish', 'result', 'saved', 'group'].forEach(function (v) { $('view-' + v).classList.toggle('hidden', v !== view); });
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
    $('space-name').textContent = g ? '👥 ' + g.name : '📱 我自己';
    $('space-bar').classList.toggle('hidden', !groups().length && !S.configured());
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
    station: { ph: '例：高鐵新竹站', hint: '可以直接打字，或從建議清單選車站。' },
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
  }
  function defaults() {
    fillForm({
      date: L.nextSaturday(todayYmd()), days: 1, origin: { type: 'station', text: '高鐵新竹站' },
      transport: ['高鐵', '捷運／公車'], leaveAt: '08:00', backBy: '21:30', people: 2, who: '',
      pace: '剛好，景點與休息平衡', food: '在地小吃'
    });
  }

  function onPrompt() {
    var f = readForm();
    var errs = L.validateForm(f);
    if (errs.length) { msg('msg-form', errs.join('；'), 'err'); return; }
    msg('msg-form', '');
    state.form = f;
    store(KEY_DRAFT, f);
    if (f.origin.type === 'home') store(KEY_HOME, L.normOrigin(f.origin).text);
    $('prompt-out').value = L.buildPrompt(f);
    $('card-copy').classList.remove('locked');
    $('card-paste').classList.remove('locked');
    msg('msg-copy', '');
    $('card-copy').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function copyText(text, fallbackInput) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text, fallbackInput); });
    }
    return Promise.resolve(legacyCopy(text, fallbackInput));
  }
  function legacyCopy(text, t) {
    t.value = text; t.focus(); t.select(); t.setSelectionRange(0, text.length);
    try { return document.execCommand('copy'); } catch (e) { return false; }
  }
  function onCopy(open) {
    var text = $('prompt-out').value;
    if (!text) return;
    // 先開視窗（要在使用者點擊的同一拍，否則會被擋）
    if (open) window.open('https://claude.ai/new', '_blank', 'noopener');
    copyText(text, $('prompt-out')).then(function (ok) {
      if (ok) msg('msg-copy', open ? '已複製，到 Claude 貼上送出，再把回答貼到第 3 步。' : '已複製。', 'ok');
      else msg('msg-copy', '自動複製失敗，請長按上面的文字框全選後複製。', 'err');
    });
  }

  function onParse() {
    var r = L.parsePlan($('paste-in').value);
    if (!r.ok) { msg('msg-parse', r.error, 'err'); return; }
    msg('msg-parse', '');
    state.plan = r.plan;
    state.form = state.form || readForm();
    state.tripId = null; state.tripSpace = state.space; state.dirty = true; state.editing = false;
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
    var meta = [w.note, w.added ? w.added.slice(5).replace('-', '/') + ' 記' : '', by ? by + ' 最後更新' : ''].filter(Boolean).join(' · ');
    if (meta) row.appendChild(el('div', 'meta', meta));
    var act = el('div', 'actions');
    act.appendChild(link('地圖', L.mapSearchUrl(w.name + ' ' + w.city)));
    if (w.url) act.appendChild(link('連結', w.url));
    if (w.scope === 'domestic' && !w.done) act.appendChild(button('排進行程', 'go', function () { planFromWish(w); }));
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
    renderSaveSpace();
    updateSaveButton();
    msg('msg-result', '');
    renderPlan();
    show('result');
  }
  function renderSaveSpace() {
    var sel = $('save-space'); sel.textContent = '';
    var opts = [{ id: '', name: '存到：我自己' }].concat(groups().map(function (g) { return { id: g.groupId, name: '存到：' + g.name }; }));
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
    var trip = { id: id, savedDate: todayYmd(), form: f, plan: state.plan };
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
      state.tripId = id; state.tripSpace = sp; state.dirty = false;
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
    box.textContent = '';
    var mode = L.travelMode(f.transport);

    var head = el('div', 'card plan-head');
    head.appendChild(el('h2', '', plan.title));
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
      var panel = el('div', 'card day-panel' + (di === state.day ? '' : ' hidden'));
      if (plan.days.length > 1) panel.appendChild(el('h3', '', d.label));
      var ul = el('ol', 'timeline');
      d.items.forEach(function (it, ii) {
        var li = el('li', 'stop c-' + it.type);
        li.appendChild(el('div', 't', it.time || '—'));
        li.appendChild(el('span', 'dot'));
        var body = el('div', 'body');
        if (state.editing) body.appendChild(stopEditor(di, ii, it, plan));
        else stopView(body, it, d, di, ii, f, mode);
        li.appendChild(body);
        ul.appendChild(li);
      });
      panel.appendChild(ul);
      if (state.editing) {
        var tools = el('div', 'day-tools');
        tools.appendChild(button('＋加一站', 'btn small ghost', function () { editStop(function (p) { return L.addStop(p, di); }); }));
        tools.appendChild(button('依時間排序', 'btn small ghost', function () { editStop(function (p) { return L.sortByTime(p, di); }); }));
        panel.appendChild(tools);
      }
      box.appendChild(panel);
    });

    if (plan.nearbyExtras.length) {
      var ex = el('div', 'card sec');
      ex.appendChild(el('h3', '', '附近備選（臨時想換可以去）'));
      plan.nearbyExtras.forEach(function (x, xi) {
        var o = el('div', 'opt c-' + x.type);
        var n = el('div', 'name');
        n.appendChild(el('span', 'type', L.TYPE_LABEL[x.type]));
        n.appendChild(document.createTextNode(x.name));
        o.appendChild(n);
        if (x.why) o.appendChild(el('div', 'sub meta', x.why));
        var ls = el('div', 'links'); ls.appendChild(link('地圖', L.mapSearchUrl(x.mapQuery)));
        o.appendChild(ls);
        if (state.editing) {
          var mb = el('div', 'mini-btns');
          plan.days.forEach(function (d, di) {
            mb.appendChild(button('加到' + (plan.days.length > 1 ? d.label : '行程') + '最後', '', function () {
              editStop(function (p) { return L.extraToStop(p, xi, di, null); });
            }));
          });
          o.appendChild(mb);
        }
        ex.appendChild(o);
      });
      box.appendChild(ex);
    }

    if (plan.lodging.length) {
      var lg = el('div', 'card sec');
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
      var bc = el('div', 'card sec');
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
      var tp = el('div', 'card sec');
      tp.appendChild(el('h3', '', '小提醒'));
      var ul3 = el('ul', 'plain');
      plan.tips.forEach(function (t) { ul3.appendChild(el('li', '', t)); });
      tp.appendChild(ul3);
      box.appendChild(tp);
    }
  }

  function stopView(body, it, d, di, ii, f, mode) {
    var nm = el('div', 'name');
    nm.appendChild(el('span', 'type', L.TYPE_LABEL[it.type]));
    nm.appendChild(document.createTextNode(it.name));
    body.appendChild(nm);
    var sub = [];
    if (it.duration) sub.push(it.duration);
    if (it.cost) sub.push('每人約 ' + money(it.cost));
    if (sub.length) body.appendChild(el('div', 'sub', sub.join(' · ')));
    if (it.transport) body.appendChild(el('div', 'how', it.transport));
    if (it.note) body.appendChild(el('div', 'note', it.note));
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
      var c0 = el('div', 'card sec');
      c0.appendChild(el('h3', '', '出發前確認'));
      var u0 = el('ul', 'plain');
      plan.checkBefore.forEach(function (t) { u0.appendChild(el('li', '', t)); });
      c0.appendChild(u0);
      c0.appendChild(el('p', 'hint2', '存起來之後可以勾選、認領「我來負責」，存在群組的話旅伴也看得到。'));
      box.appendChild(c0);
      return;
    }
    var sp = state.tripSpace, tripId = state.tripId, me = myNick(sp);
    var list = checksIn(sp, tripId);
    var cb = el('div', 'card sec');
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
        li.appendChild(button(c.who + ' 負責 ×', 'who' + (c.who === me ? ' mine' : ''), function () { saveCheck(c, { who: '' }); }));
      } else {
        li.appendChild(button('我來', 'who', function () { saveCheck(c, { who: me }); }));
      }
      li.appendChild(armed(button('刪', 'who', null), '確定？', function () {
        delItem(sp, 'check', c.id).then(function () { renderPlan(); }, function (e) { msg('msg-result', e.message, 'err'); });
      }));
      ul.appendChild(li);
    });
    cb.appendChild(ul);
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
    if (!storageWorks()) text = '這個瀏覽器不讓網頁存資料（可能是無痕模式），存的行程關掉就會不見。請改用一般模式的 Safari 或 Chrome 打開。';
    else if (inAppBrowser()) text = '你現在是在 App 裡的內建瀏覽器打開，這裡存的資料可能關掉就不見。請按右上角「⋯」選「用 Safari／瀏覽器開啟」，再加到書籤或主畫面。';
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
    if (!list.length) { box.appendChild(el('div', 'card empty', '還沒有存任何行程。排好一趟之後按「存起來」。')); return; }
    list.forEach(function (t) {
      var card = el('div', 'card trip-item');
      var g = el('div', 'grow');
      g.appendChild(el('div', 'name', t.plan.title));
      var f = t.form || {};
      g.appendChild(el('div', 'meta', [f.date ? L.dayLabel(f.date) : '', L.destText(f)].filter(Boolean).join(' · ')));
      card.appendChild(g);
      card.appendChild(button('打開', 'btn small', function () {
        state.plan = t.plan; state.form = f; state.tripId = t.id; state.tripSpace = state.space;
        state.dirty = false; state.editing = false; state.day = 0;
        openResult();
      }));
      var sp = state.space;
      card.appendChild(armed(button('刪除', 'btn small ghost', null), '確定刪除？', function () {
        delItem(sp, 'trip', t.id).then(function () { updateCount(); renderSaved(); }, function (e) { msg('msg-backup', e.message, 'err'); });
      }));
      box.appendChild(card);
    });
  }

  /* ================= 旅伴頁 ================= */
  function renderGroups() {
    $('group-off').classList.toggle('hidden', S.configured());
    var list = $('space-list'); list.textContent = '';
    [{ groupId: '', name: '📱 我自己', note: '只存在這支手機' }].concat(groups().map(function (g) {
      return { groupId: g.groupId, name: '👥 ' + g.name, note: '暱稱：' + g.nick + (g.ownerKey ? ' · 你建立的' : '') };
    })).forEach(function (o) {
      var b = el('button', '', o.name); b.type = 'button';
      b.appendChild(el('small', '', o.note));
      b.setAttribute('aria-pressed', String(o.groupId === state.space));
      b.addEventListener('click', function () { switchSpace(o.groupId); renderGroups(); });
      list.appendChild(b);
    });
    var g = group(state.space);
    $('group-detail').classList.toggle('hidden', !g);
    if (g) {
      $('gd-name').textContent = g.name;
      $('gd-meta').textContent = '你的暱稱：' + g.nick + (state.lastSync ? ' · 最後同步 ' + hhmm(state.lastSync) : '');
      var inv = g.inviteKey || (g.ownerKey ? '' : g.key);
      $('gd-link').value = inv ? L.inviteUrl(location.href, g.groupId, inv) : '（找不到邀請碼，請請建立者重設連結）';
      $('btn-gd-share').classList.toggle('hidden', !navigator.share || !inv);
      $('gd-owner').classList.toggle('hidden', !g.ownerKey);
      $('gd-rename').value = g.name;
      $('gd-nick').value = g.nick;
      var leave = $('btn-gd-leave'); leave.removeAttribute('data-armed'); leave.textContent = '離開群組';
    }
    var jc = !!state.pendingJoin;
    $('join-card').classList.toggle('hidden', !jc);
    if (jc && !$('join-nick').value) $('join-nick').value = L.cleanNick(store(KEY_NICK));
  }

  function onCreateGroup() {
    var name = L.cleanGroupName($('ng-name').value), nick = L.cleanNick($('ng-nick').value);
    if (!name || !nick) { msg('msg-ng', '群組名稱和暱稱都要填', 'err'); return; }
    var b = $('btn-ng'); b.disabled = true; msg('msg-ng', '建立中…');
    S.call('createGroup', { name: name, nick: nick }).then(function (d) {
      upsertGroup({ groupId: d.groupId, name: d.name, key: d.ownerKey, inviteKey: d.inviteKey, ownerKey: d.ownerKey, nick: nick });
      store(KEY_NICK, nick);
      $('ng-name').value = '';
      msg('msg-ng', '已建立「' + name + '」。把上面的邀請連結傳給旅伴就可以了。', 'ok');
      switchSpace(d.groupId); renderGroups();
    }, function (e) { msg('msg-ng', e.message, 'err'); }).then(function () { b.disabled = false; });
  }
  function onJoin() {
    var j = state.pendingJoin, nick = L.cleanNick($('join-nick').value);
    if (!j) return;
    if (!nick) { msg('msg-join', '請填暱稱', 'err'); return; }
    var b = $('btn-join'); b.disabled = true; msg('msg-join', '加入中…');
    S.call('joinGroup', { groupId: j.groupId, key: j.key }).then(function (d) {
      var old = group(j.groupId);
      upsertGroup({
        groupId: j.groupId, name: d.name, key: old && old.ownerKey ? old.ownerKey : j.key,
        inviteKey: j.key, ownerKey: old ? old.ownerKey : '', nick: nick
      });
      store(KEY_NICK, nick);
      state.pendingJoin = null;
      msg('msg-join', '');
      switchSpace(j.groupId); renderGroups();
      msg('msg-gd', '已加入「' + d.name + '」！願望清單和行程分頁現在都是大家共用的。', 'ok');
    }, function (e) { msg('msg-join', e.message, 'err'); }).then(function () { b.disabled = false; });
  }
  function onJoinLink() {
    var j = L.parseInvite($('jl-link').value);
    if (!j) { msg('msg-jl', '這不像邀請連結，請整段貼上（要有 #join= 那段）', 'err'); return; }
    msg('msg-jl', '');
    state.pendingJoin = j; $('jl-link').value = '';
    renderGroups();
    $('join-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    var g = group(state.space); if (!g || !g.ownerKey) return;
    S.call('resetInvite', { groupId: g.groupId, ownerKey: g.ownerKey }).then(function (d) {
      patchGroup(g.groupId, { inviteKey: d.inviteKey });
      renderGroups();
      msg('msg-gd', '舊連結已失效。把新連結傳給要留下的旅伴，他們重新點一次就好。', 'ok');
    }, function (e) { msg('msg-gd', e.message, 'err'); });
  }
  function onRename() {
    var g = group(state.space), name = L.cleanGroupName($('gd-rename').value);
    if (!g || !g.ownerKey) return;
    if (!name) { msg('msg-gd', '請填群組名稱', 'err'); return; }
    S.call('renameGroup', { groupId: g.groupId, ownerKey: g.ownerKey, name: name }).then(function () {
      patchGroup(g.groupId, { name: name }); renderSpaceBar(); renderGroups();
      msg('msg-gd', '已改名，旅伴下次同步就會看到。', 'ok');
    }, function (e) { msg('msg-gd', e.message, 'err'); });
  }
  function onNick() {
    var g = group(state.space), nick = L.cleanNick($('gd-nick').value);
    if (!g) return;
    if (!nick) { msg('msg-gd', '請填暱稱', 'err'); return; }
    patchGroup(g.groupId, { nick: nick }); renderGroups();
    msg('msg-gd', '已更新，之後的修改會顯示「' + nick + '」。', 'ok');
  }
  function onLeave() {
    var g = group(state.space), b = $('btn-gd-leave');
    if (!g) return;
    if (b.getAttribute('data-armed') !== '1') {
      b.setAttribute('data-armed', '1');
      b.textContent = g.ownerKey ? '確定？你是建立者，離開後就不能重設連結了' : '確定離開？（資料留在群組裡）';
      return;
    }
    saveGroups(groups().filter(function (x) { return x.groupId !== g.groupId; }));
    store(KEY_GC + g.groupId, null);
    switchSpace(''); renderGroups();
    msg('msg-ng', '已離開「' + g.name + '」。', 'ok');
  }
  function onImportWishes() {
    var sp = state.space; if (!sp) return;
    var have = {}; wishesIn(sp).forEach(function (w) { have[w.id] = true; });
    var mine = L.filterWishes(wishesIn(''), {}).filter(function (w) { return !have[w.id]; });
    if (!mine.length) { msg('msg-gd', '「我自己」沒有新的願望可以複製。', 'ok'); return; }
    msg('msg-gd', '複製中…');
    Promise.all(mine.map(function (w) { return putItem(sp, 'wish', w.id, w); })).then(function () {
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

    bindToggle('f-days'); bindToggle('f-pace'); bindToggle('f-food', true); bindToggle('f-transport', true);
    bindToggle('f-scope');
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
    $('btn-back').addEventListener('click', function () { show('plan'); });
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
    $('btn-ng').addEventListener('click', onCreateGroup);
    $('btn-join').addEventListener('click', onJoin);
    $('btn-join-cancel').addEventListener('click', function () { state.pendingJoin = null; renderGroups(); });
    $('btn-jl').addEventListener('click', onJoinLink);
    $('btn-gd-copy').addEventListener('click', onCopyInvite);
    $('btn-gd-share').addEventListener('click', onShareInvite);
    $('btn-gd-reset').addEventListener('click', onReset);
    $('btn-gd-rename').addEventListener('click', onRename);
    $('btn-gd-nick').addEventListener('click', onNick);
    $('btn-gd-leave').addEventListener('click', onLeave);
    $('btn-gd-import').addEventListener('click', onImportWishes);
    syncWishScope();
    renderSpaceBar(); statusIdle();
    renderPicks();
    updateCount();

    // 邀請連結：#join=群組.邀請碼 → 先從網址列拿掉（免得被截圖或轉傳），再請使用者填暱稱
    function takeInvite() {
      var inv = L.parseInvite(location.hash);
      if (!inv) return;
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
      state.pendingJoin = inv;
      show('group');
    }
    takeInvite();
    window.addEventListener('hashchange', takeInvite);   // 頁面開著時又點了一條邀請連結
    pullNow();
    setInterval(function () { if (document.visibilityState === 'visible') pullNow(); }, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') pullNow(); });
  }
  init();
})();
