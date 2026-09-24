/* 展示積木：只負責畫面與收集輸入；規則都問 TripLogic。
 * 一律用 textContent 放文字，不用 innerHTML。 */
(function () {
  'use strict';
  var L = window.TripLogic;
  var KEY_TRIPS = 'quicktrip.trips.v1';
  var KEY_DRAFT = 'quicktrip.draft.v1';
  var KEY_WISH = 'quicktrip.wishes.v1';
  var KEY_HOME = 'quicktrip.home.v1';
  var state = { form: null, plan: null, tripId: null, day: 0, picked: {}, otext: {}, otype: 'station' };

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
  function msg(id, text, kind) {
    var m = $(id); m.textContent = text || ''; m.className = 'msg' + (kind ? ' ' + kind : '');
  }
  function store(key, val) {
    try {
      if (val === undefined) { var s = localStorage.getItem(key); return s ? JSON.parse(s) : null; }
      localStorage.setItem(key, JSON.stringify(val)); return true;
    } catch (e) { return val === undefined ? null : false; }
  }
  function todayYmd() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function money(n) { return 'NT$' + Number(n || 0).toLocaleString('zh-TW'); }

  /* ---------- 選單 ---------- */
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

  /* ---------- 分頁 ---------- */
  function show(view) {
    ['plan', 'wish', 'result', 'saved'].forEach(function (v) { $('view-' + v).classList.toggle('hidden', v !== view); });
    var tab = view === 'result' ? 'plan' : view;
    ['plan', 'wish', 'saved'].forEach(function (t) { $('tab-' + t).setAttribute('aria-selected', String(t === tab)); });
    if (view === 'saved') { renderSaved(); checkStorage(); }
    if (view === 'wish') renderWishes();
    if (view === 'plan') renderPicks();
    window.scrollTo(0, 0);
  }

  /* ---------- 共用切換 ---------- */
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

  /* ---------- 出發地 ---------- */
  var OTYPE_UI = {
    home: { ph: '家裡地址，例：新竹市東區○○路○號', hint: '地址只存在這支手機，下次選「自家」會自動帶入。' },
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

  /* ---------- 表單 ---------- */
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

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    var t = $('prompt-out');
    t.value = text; t.focus(); t.select(); t.setSelectionRange(0, text.length);
    try { return document.execCommand('copy'); } catch (e) { return false; }
  }
  function onCopy(open) {
    var text = $('prompt-out').value;
    if (!text) return;
    // 先開視窗（要在使用者點擊的同一拍，否則會被擋）
    if (open) window.open('https://claude.ai/new', '_blank', 'noopener');
    copyText(text).then(function (ok) {
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
    state.tripId = null;
    state.day = 0;
    $('btn-save').disabled = false;
    $('btn-save').textContent = '存到我的行程';
    renderPlan();
    show('result');
  }

  /* ---------- 願望清單（規劃頁的勾選） ---------- */
  function renderPicks() {
    var city = $('f-city').value, box = $('wish-picks');
    var list = L.wishesForCity(wishes(), city);
    box.textContent = '';
    $('wish-picks-box').classList.toggle('hidden', !list.length);
    if (!list.length) return;
    $('wish-picks-title').textContent = '願望清單裡的' + city + '（點選要排進去的）';
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

  /* ---------- 願望清單頁 ---------- */
  function wishes() { return L.cleanWishes(store(KEY_WISH)); }
  function saveWishes(list) { var ok = store(KEY_WISH, list); updateCount(); return ok; }

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
    var id = 'w' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    var r = L.normalizeWish(input, id, todayYmd());
    if (!r.ok) { msg('msg-wish', r.error, 'err'); return; }
    var list = wishes();
    if (list.length >= L.WISH_MAX) { msg('msg-wish', '願望清單滿了（' + L.WISH_MAX + ' 筆），先刪掉一些去過的吧', 'err'); return; }
    if (!saveWishes(L.upsertTrip(list, r.wish, L.WISH_MAX))) { msg('msg-wish', '存不進去（瀏覽器空間不足或無痕模式）', 'err'); return; }
    msg('msg-wish', '已加入：' + r.wish.name, 'ok');
    $('w-name').value = ''; $('w-note').value = ''; $('w-url').value = '';
    // 篩選切到剛加的那一類，才看得到
    setSeg('wf-scope', r.wish.scope);
    renderWishes();
  }
  function renderWishes() {
    var box = $('wish-list'), all = wishes();
    box.textContent = '';
    var list = L.filterWishes(all, { scope: segValue('wf-scope'), kind: segValue('wf-kind'), showDone: $('wf-done').checked });
    if (!list.length) {
      box.appendChild(el('div', 'empty', all.length ? '這個分類還沒有東西。' : '還沒有願望。看到想去的，用上面的欄位先記下來。'));
      return;
    }
    L.groupWishes(list).forEach(function (g) {
      var sec = el('div', 'wgroup');
      sec.appendChild(el('h3', '', g.city + '（' + g.items.length + '）'));
      g.items.forEach(function (w) { sec.appendChild(wishRow(w)); });
      box.appendChild(sec);
    });
  }
  function wishRow(w) {
    var row = el('div', 'wish ' + (w.kind === 'eat' ? 'kind-eat' : 'kind-play') + (w.done ? ' done' : ''));
    var nm = el('div', 'name');
    nm.appendChild(el('span', 'type', L.WISH_KIND[w.kind]));
    nm.appendChild(document.createTextNode(w.name));
    row.appendChild(nm);
    var meta = [w.note, w.added ? w.added.slice(5).replace('-', '/') + ' 記' : ''].filter(Boolean).join(' · ');
    if (meta) row.appendChild(el('div', 'meta', meta));
    var act = el('div', 'actions');
    act.appendChild(link('地圖', L.mapSearchUrl(w.name + ' ' + w.city)));
    if (w.url) act.appendChild(link('連結', w.url));
    if (w.scope === 'domestic' && !w.done) {
      act.appendChild(button('排進行程', 'go', function () { planFromWish(w); }));
    }
    act.appendChild(button(w.done ? '取消去過' : '去過了', '', function () {
      saveWishes(L.toggleDone(wishes(), w.id)); renderWishes();
    }));
    var del = button('刪除', '', function () {
      if (del.getAttribute('data-armed') !== '1') { del.setAttribute('data-armed', '1'); del.textContent = '確定刪除？'; return; }
      delete state.picked[w.id];
      saveWishes(L.removeTrip(wishes(), w.id)); renderWishes();
    });
    act.appendChild(del);
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

  /* ---------- 行程渲染 ---------- */
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
        li.appendChild(body);
        ul.appendChild(li);
      });
      panel.appendChild(ul);
      box.appendChild(panel);
    });

    if (plan.nearbyExtras.length) {
      var ex = el('div', 'card sec');
      ex.appendChild(el('h3', '', '附近備選（臨時想換可以去）'));
      plan.nearbyExtras.forEach(function (x) {
        var o = el('div', 'opt c-' + x.type);
        var n = el('div', 'name');
        n.appendChild(el('span', 'type', L.TYPE_LABEL[x.type]));
        n.appendChild(document.createTextNode(x.name));
        o.appendChild(n);
        if (x.why) o.appendChild(el('div', 'sub meta', x.why));
        var ls = el('div', 'links'); ls.appendChild(link('地圖', L.mapSearchUrl(x.mapQuery)));
        o.appendChild(ls);
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

    if (plan.checkBefore.length) {
      var cb = el('div', 'card sec');
      cb.appendChild(el('h3', '', '出發前確認'));
      var ul2 = el('ul', 'check');
      plan.checkBefore.forEach(function (t) {
        var li = el('li'), lab = el('label'), ck = el('input');
        ck.type = 'checkbox';
        lab.appendChild(ck); lab.appendChild(el('span', '', t));
        li.appendChild(lab); ul2.appendChild(li);
      });
      cb.appendChild(ul2);
      box.appendChild(cb);
    }

    if (plan.tips.length) {
      var tp = el('div', 'card sec');
      tp.appendChild(el('h3', '', '小提醒'));
      var ul3 = el('ul', 'plain');
      plan.tips.forEach(function (t) { ul3.appendChild(el('li', '', t)); });
      tp.appendChild(ul3);
      box.appendChild(tp);
    }
  }

  /* ---------- 儲存可靠度 ---------- */
  // 請瀏覽器把這個網站的資料標成「不要自動清掉」（不支援就算了）
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

  /* ---------- 備份 ---------- */
  function onExport() {
    var text = L.buildBackup(trips(), wishes(), todayYmd());
    try {
      var url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      var a = document.createElement('a');
      a.href = url; a.download = 'quick-trip-backup-' + todayYmd() + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      msg('msg-backup', '已匯出：行程 ' + trips().length + ' 筆、願望 ' + wishes().length + ' 筆。檔案在「下載項目／檔案」App 裡。', 'ok');
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
      var t = L.mergeById(trips(), r.trips, 30), w = L.mergeById(wishes(), r.wishes, L.WISH_MAX);
      if (!store(KEY_TRIPS, t) || !store(KEY_WISH, w)) { msg('msg-backup', '存不進去（瀏覽器空間不足或無痕模式）', 'err'); return; }
      askPersist();
      updateCount(); renderSaved();
      msg('msg-backup', '已匯入：行程 ' + r.trips.length + ' 筆、願望 ' + r.wishes.length + ' 筆（同一筆以備份為準）。', 'ok');
    };
    rd.onerror = function () { msg('msg-backup', '讀不到這個檔案', 'err'); };
    rd.readAsText(f);
    $('import-file').value = '';
  }

  /* ---------- 我的行程 ---------- */
  function trips() { return L.cleanTrips(store(KEY_TRIPS)); }
  function updateCount() {
    var n = trips().length; $('saved-count').textContent = n ? '(' + n + ')' : '';
    var w = L.filterWishes(wishes(), {}).length; $('wish-count').textContent = w ? '(' + w + ')' : '';
  }

  function onSave() {
    if (!state.plan) return;
    var f = state.form || {};
    var id = state.tripId || L.makeId(JSON.stringify(state.plan) + (f.date || ''));
    var trip = { id: id, savedDate: todayYmd(), form: f, plan: state.plan };
    store(KEY_TRIPS, L.upsertTrip(trips(), trip));
    // 寫完讀回來確認真的存進去，不只相信 setItem 沒丟錯
    var saved = trips().some(function (t) { return t.id === id; });
    if (saved) {
      askPersist();
      state.tripId = id;
      $('btn-save').textContent = '已存 ✓';
      $('btn-save').disabled = true;
      updateCount();
    } else {
      $('btn-save').textContent = '存不進去（瀏覽器空間不足或無痕模式）';
    }
  }

  function renderSaved() {
    var box = $('saved-list'), list = trips();
    box.textContent = '';
    if (!list.length) { box.appendChild(el('div', 'card empty', '還沒有存任何行程。排好一趟之後按「存到我的行程」。')); return; }
    list.forEach(function (t) {
      if (!t || !t.plan) return;
      var r = L.parsePlan(JSON.stringify(t.plan)); // 讀回來也走一次清洗
      if (!r.ok) return;
      var card = el('div', 'card trip-item');
      var g = el('div', 'grow');
      g.appendChild(el('div', 'name', r.plan.title));
      var f = t.form || {};
      g.appendChild(el('div', 'meta', [f.date ? L.dayLabel(f.date) : '', L.destText(f)].filter(Boolean).join(' · ')));
      card.appendChild(g);
      card.appendChild(button('打開', 'btn small', function () {
        state.plan = r.plan; state.form = f; state.tripId = t.id; state.day = 0;
        $('btn-save').disabled = true; $('btn-save').textContent = '已存 ✓';
        renderPlan(); show('result');
      }));
      var del = button('刪除', 'btn small ghost', function () {
        if (del.getAttribute('data-armed') !== '1') { del.setAttribute('data-armed', '1'); del.textContent = '確定刪除？'; return; }
        store(KEY_TRIPS, L.removeTrip(trips(), t.id)); updateCount(); renderSaved();
      });
      card.appendChild(del);
      box.appendChild(card);
    });
  }

  /* ---------- 綁定 ---------- */
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
    $('btn-print').addEventListener('click', function () { window.print(); });
    $('tab-plan').addEventListener('click', function () { show('plan'); });
    $('tab-wish').addEventListener('click', function () { show('wish'); });
    $('tab-saved').addEventListener('click', function () { show('saved'); });
    syncWishScope();
    renderPicks();
    updateCount();
  }
  init();
})();
