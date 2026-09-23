/* 展示積木：只負責畫面與收集輸入；規則都問 TripLogic。
 * 一律用 textContent 放文字，不用 innerHTML。 */
(function () {
  'use strict';
  var L = window.TripLogic;
  var KEY_TRIPS = 'quicktrip.trips.v1';
  var KEY_DRAFT = 'quicktrip.draft.v1';
  var state = { form: null, plan: null, tripId: null, day: 0 };

  function $(id) { return document.getElementById(id); }
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

  /* ---------- 分頁 ---------- */
  function show(view) {
    ['plan', 'result', 'saved'].forEach(function (v) { $('view-' + v).classList.toggle('hidden', v !== view); });
    $('tab-plan').setAttribute('aria-selected', String(view !== 'saved'));
    $('tab-saved').setAttribute('aria-selected', String(view === 'saved'));
    if (view === 'saved') renderSaved();
    window.scrollTo(0, 0);
  }

  /* ---------- 表單 ---------- */
  function segValue(id) {
    var b = $(id).querySelector('[aria-pressed="true"]');
    return b ? b.getAttribute('data-v') : '';
  }
  function setSeg(id, v) {
    Array.prototype.forEach.call($(id).querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === String(v)));
    });
  }
  function readForm() {
    var food = [];
    Array.prototype.forEach.call($('f-food').querySelectorAll('[aria-pressed="true"]'), function (b) { food.push(b.textContent); });
    return {
      destination: $('f-destination').value, mustDo: $('f-mustDo').value,
      date: $('f-date').value, days: Number(segValue('f-days')) || 1,
      origin: $('f-origin').value, transport: $('f-transport').value,
      leaveAt: $('f-leaveAt').value, backBy: $('f-backBy').value,
      people: Number($('f-people').value), who: $('f-who').value,
      pace: segValue('f-pace'), food: food.join('、'),
      budget: $('f-budget').value, extra: $('f-extra').value
    };
  }
  function fillForm(f) {
    ['destination', 'mustDo', 'date', 'origin', 'leaveAt', 'backBy', 'people', 'budget', 'extra'].forEach(function (k) {
      if (f[k] != null) $('f-' + k).value = f[k];
    });
    if (f.transport) $('f-transport').value = f.transport;
    if (f.who != null) $('f-who').value = f.who;
    if (f.days) setSeg('f-days', f.days);
    if (f.pace) setSeg('f-pace', f.pace);
    var foods = String(f.food || '').split('、');
    Array.prototype.forEach.call($('f-food').querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', String(foods.indexOf(b.textContent) !== -1));
    });
    syncOriginChips();
  }
  function syncOriginChips() {
    var v = $('f-origin').value;
    Array.prototype.forEach.call($('origin-chips').querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === v));
    });
  }
  function defaults() {
    fillForm({
      date: L.nextSaturday(todayYmd()), days: 1, origin: '高鐵新竹站', transport: '高鐵＋當地大眾運輸',
      leaveAt: '08:00', backBy: '21:30', people: 2, who: '', pace: '剛好，景點與休息平衡', food: '在地小吃'
    });
  }

  function onPrompt() {
    var f = readForm();
    var errs = L.validateForm(f);
    if (errs.length) { msg('msg-form', errs.join('；'), 'err'); return; }
    msg('msg-form', '');
    state.form = f;
    store(KEY_DRAFT, f);
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
    var w = open ? window.open('https://claude.ai/new', '_blank', 'noopener') : null;
    copyText(text).then(function (ok) {
      if (ok) msg('msg-copy', open ? '已複製，到 Claude 貼上送出，再把回答貼到第 3 步。' : '已複製。', 'ok');
      else msg('msg-copy', '自動複製失敗，請長按上面的文字框全選後複製。', 'err');
    });
    return w;
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

  /* ---------- 行程渲染 ---------- */
  function renderPlan() {
    var plan = state.plan, f = state.form || {}, box = $('result');
    box.textContent = '';
    var mode = /開車|租車/.test(f.transport || '') ? 'driving' : 'transit';

    var head = el('div', 'card plan-head');
    head.appendChild(el('h2', '', plan.title));
    if (plan.summary) head.appendChild(el('p', 'sum', plan.summary));
    var metaBits = [];
    if (f.date) metaBits.push(L.dayLabel(f.date) + (f.days === 2 ? ' 起兩天一夜' : ' 一日來回'));
    if (f.origin) metaBits.push('從 ' + f.origin + ' 出發');
    if (f.people) metaBits.push(f.people + ' 人');
    head.appendChild(el('div', 'meta', metaBits.join(' · ')));
    box.appendChild(head);

    if (plan.days.length > 1) {
      var tabs = el('div', 'daytabs no-print');
      plan.days.forEach(function (d, i) {
        var b = el('button', 'chip', d.label);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(i === state.day));
        b.addEventListener('click', function () { state.day = i; renderPlan(); });
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
          var from = L.prevPlace(d.items, ii);
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
      var rows = plan.budget.length ? plan.budget : [];
      rows.forEach(function (b) {
        var tr = el('tr');
        var td = el('td', '', b.item);
        if (b.note) { td.appendChild(el('div', 'meta', b.note)); }
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

  /* ---------- 我的行程 ---------- */
  function trips() { var t = store(KEY_TRIPS); return Array.isArray(t) ? t : []; }
  function updateCount() { var n = trips().length; $('saved-count').textContent = n ? '(' + n + ')' : ''; }

  function onSave() {
    if (!state.plan) return;
    var f = state.form || {};
    var id = state.tripId || L.makeId(JSON.stringify(state.plan) + (f.date || ''));
    var trip = { id: id, savedDate: todayYmd(), form: f, plan: state.plan };
    if (store(KEY_TRIPS, L.upsertTrip(trips(), trip))) {
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
      g.appendChild(el('div', 'meta', [f.date ? L.dayLabel(f.date) : '', f.destination || ''].filter(Boolean).join(' · ')));
      card.appendChild(g);
      var open = el('button', 'btn small', '打開'); open.type = 'button';
      open.addEventListener('click', function () {
        state.plan = r.plan; state.form = f; state.tripId = t.id; state.day = 0;
        $('btn-save').disabled = true; $('btn-save').textContent = '已存 ✓';
        renderPlan(); show('result');
      });
      var del = el('button', 'btn small ghost', '刪除'); del.type = 'button';
      del.addEventListener('click', function () {
        if (del.getAttribute('data-armed') !== '1') { del.setAttribute('data-armed', '1'); del.textContent = '確定刪除？'; return; }
        store(KEY_TRIPS, L.removeTrip(trips(), t.id)); updateCount(); renderSaved();
      });
      card.appendChild(open); card.appendChild(del);
      box.appendChild(card);
    });
  }

  /* ---------- 綁定 ---------- */
  function bindToggle(id, multi) {
    $(id).addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (multi) b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
      else setSeg(id, b.getAttribute('data-v'));
    });
  }
  function init() {
    defaults();
    var draft = store(KEY_DRAFT);
    if (draft && typeof draft === 'object') {
      // 草稿的日期若已過，換成最近的星期六
      if (!draft.date || draft.date < todayYmd()) draft.date = L.nextSaturday(todayYmd());
      fillForm(draft);
    }
    bindToggle('f-days'); bindToggle('f-pace'); bindToggle('f-food', true);
    $('origin-chips').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      e.preventDefault();
      $('f-origin').value = b.getAttribute('data-v');
      if (/開車/.test(b.getAttribute('data-v'))) $('f-transport').value = '自行開車';
      syncOriginChips();
    });
    $('f-origin').addEventListener('input', syncOriginChips);
    $('btn-prompt').addEventListener('click', onPrompt);
    $('btn-copy-open').addEventListener('click', function () { onCopy(true); });
    $('btn-copy').addEventListener('click', function () { onCopy(false); });
    $('btn-parse').addEventListener('click', onParse);
    $('btn-back').addEventListener('click', function () { show('plan'); });
    $('btn-save').addEventListener('click', onSave);
    $('btn-print').addEventListener('click', function () { window.print(); });
    $('tab-plan').addEventListener('click', function () { show('plan'); });
    $('tab-saved').addEventListener('click', function () { show('saved'); });
    updateCount();
  }
  init();
})();
