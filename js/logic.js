/* 邏輯積木：純函式。不碰 DOM、不讀現在時間、不改傳入資料。
 * 瀏覽器掛在 window.TripLogic；Node 用 module.exports（給測試）。 */
(function (root) {
  'use strict';

  var TYPES = ['transport', 'sight', 'food', 'snack', 'lodging', 'shop', 'rest'];
  var TYPE_LABEL = {
    transport: '交通', sight: '景點', food: '正餐', snack: '小吃點心',
    lodging: '住宿', shop: '逛街', rest: '休息'
  };
  var LIMIT = { str: 400, days: 3, items: 24, list: 12 };
  var WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  var FENCE = '\x60\x60\x60'; // 三個反引號（程式碼區塊標記）

  /* ---------- 日期 ---------- */
  // today: 'YYYY-MM-DD'；回傳下一個星期六（今天是六就回今天）
  function nextSaturday(today) {
    var d = parseYmd_(today);
    if (!d) return '';
    var add = (6 - d.getUTCDay() + 7) % 7;
    d.setUTCDate(d.getUTCDate() + add);
    return fmtYmd_(d);
  }
  function addDays(ymd, n) {
    var d = parseYmd_(ymd);
    if (!d) return '';
    d.setUTCDate(d.getUTCDate() + n);
    return fmtYmd_(d);
  }
  function dayLabel(ymd) {
    var d = parseYmd_(ymd);
    if (!d) return '';
    return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '（' + WEEK[d.getUTCDay()] + '）';
  }
  function parseYmd_(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (d.getUTCMonth() !== +m[2] - 1) return null;
    return d;
  }
  function fmtYmd_(d) {
    return d.getUTCFullYear() + '-' + pad_(d.getUTCMonth() + 1) + '-' + pad_(d.getUTCDate());
  }
  function pad_(n) { return (n < 10 ? '0' : '') + n; }

  /* ---------- 表單驗證 ---------- */
  function validateForm(f) {
    var errs = [];
    if (!clean_(f.destination)) errs.push('請填想去的主要地點');
    if (!clean_(f.origin)) errs.push('請填出發地');
    if (!parseYmd_(f.date)) errs.push('日期格式不對');
    if (f.days !== 1 && f.days !== 2) errs.push('天數只能是一日或兩天一夜');
    if (!(f.people >= 1 && f.people <= 20)) errs.push('人數請填 1–20');
    if (f.leaveAt && !/^\d{2}:\d{2}$/.test(f.leaveAt)) errs.push('出發時間格式不對');
    if (f.backBy && !/^\d{2}:\d{2}$/.test(f.backBy)) errs.push('回到家時間格式不對');
    return errs;
  }

  /* ---------- 提示詞 ---------- */
  function buildPrompt(f) {
    var d1 = f.date, lines = [];
    var dates = f.days === 2
      ? dayLabel(d1) + ' 出發，' + dayLabel(addDays(d1, 1)) + ' 回程（兩天一夜）'
      : dayLabel(d1) + ' 當天來回';
    lines.push('請幫我規劃一趟台灣國內的說走就走小旅行，並把附近順路的好玩景點和好吃的餐廳、小吃一起排進去。');
    lines.push('');
    lines.push('【基本資料】');
    lines.push('- 出發地：' + clean_(f.origin));
    lines.push('- 主要目的地（一定要去）：' + clean_(f.destination));
    if (clean_(f.mustDo)) lines.push('- 其他指定想去／想吃：' + clean_(f.mustDo));
    lines.push('- 日期：' + dates);
    lines.push('- 交通方式：' + clean_(f.transport));
    if (f.leaveAt) lines.push('- 最早出發時間：' + f.leaveAt);
    if (f.backBy) lines.push('- 希望回到出發地的時間：' + f.backBy + ' 前');
    lines.push('- 人數：' + f.people + ' 人' + (clean_(f.who) ? '（' + clean_(f.who) + '）' : ''));
    lines.push('- 步調：' + clean_(f.pace));
    if (clean_(f.food)) lines.push('- 飲食偏好：' + clean_(f.food));
    if (clean_(f.budget)) lines.push('- 每人預算上限：約 NT$' + clean_(f.budget));
    if (clean_(f.extra)) lines.push('- 其他備註：' + clean_(f.extra));
    lines.push('');
    lines.push('【規劃要求】');
    lines.push('1. 以主要目的地為中心，優先挑車程或步行 20 分鐘內的景點與餐廳，路線不要來回折返。');
    lines.push('2. 用真實存在、目前仍營業的店家與景點；不確定是否還在營業、營業時間或需要預約的，在 note 寫明並把 verify 設為 true。');
    lines.push('3. 時間表要包含：出發、每段交通（班次類型、轉乘方式、大約車程）、每個點的停留時間、午餐晚餐與點心。');
    lines.push('4. 大眾運輸要寫出實際車站名稱（例如高鐵左營站、捷運站名、公車路線號碼）。');
    lines.push('5. 另外列出 4–6 個「附近備選」：時間多出來或臨時不想去某站時可以替換的點。');
    if (f.days === 2) lines.push('6. 給 2–3 個住宿建議（區域或具體旅館皆可），說明為什麼選那一區。');
    lines.push((f.days === 2 ? '7' : '6') + '. 預算以「每人」新台幣估算，列出交通、門票、餐費' + (f.days === 2 ? '、住宿（以兩人一房平分）' : '') + '。');
    lines.push('');
    lines.push('【回覆格式】只回一個 ' + FENCE + 'json 程式碼區塊，不要其他文字，格式如下：');
    lines.push(FENCE + 'json');
    lines.push(JSON.stringify(schemaExample_(f.days), null, 1));
    lines.push(FENCE);
    lines.push('type 只能是：' + TYPES.join(' / ') + '。time 用 24 小時制 HH:MM。cost 是每人新台幣整數，免費填 0。mapQuery 填能在 Google 地圖搜到的「店名＋區域」。');
    return lines.join('\n');
  }

  function schemaExample_(days) {
    var ex = {
      title: '行程標題',
      summary: '一兩句話說明這趟的重點',
      days: [{
        label: 'Day 1',
        items: [{
          time: '08:10', type: 'transport', name: '高鐵新竹站 → 左營站',
          mapQuery: '高鐵新竹站', duration: '約 70 分鐘',
          transport: '怎麼從上一站到這裡', note: '補充說明', cost: 1080, verify: false
        }]
      }],
      nearbyExtras: [{ name: '', type: 'sight', why: '為什麼推薦', mapQuery: '' }],
      budget: [{ item: '高鐵來回', amount: 2160, note: '' }],
      tips: ['實用提醒'],
      checkBefore: ['出發前要先確認或預約的事']
    };
    if (days === 2) ex.lodging = [{ name: '', area: '', why: '', priceRange: '', mapQuery: '' }];
    return ex;
  }

  /* ---------- 解析 Claude 回覆 ---------- */
  // 回傳 {ok:true, plan} 或 {ok:false, error}
  function parsePlan(text) {
    var raw = String(text || '');
    if (raw.length > 200000) return { ok: false, error: '貼上的內容太長了' };
    var body = extractJson_(raw);
    if (!body) return { ok: false, error: '找不到 JSON。請確認貼上的是 Claude 回覆裡整段 json 程式碼區塊' };
    var data;
    try { data = JSON.parse(body); } catch (e) {
      return { ok: false, error: 'JSON 格式有誤（可能沒複製完整）：' + String(e.message).slice(0, 80) };
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.days) || !data.days.length) {
      return { ok: false, error: '內容裡沒有 days 行程' };
    }
    var plan = {
      title: str_(data.title) || '我的小旅行',
      summary: str_(data.summary),
      days: data.days.slice(0, LIMIT.days).map(function (d, i) {
        return {
          label: str_(d && d.label) || ('Day ' + (i + 1)),
          items: (Array.isArray(d && d.items) ? d.items : []).slice(0, LIMIT.items).map(item_)
        };
      }),
      nearbyExtras: list_(data.nearbyExtras).map(function (x) {
        return { name: str_(x.name), type: type_(x.type), why: str_(x.why), mapQuery: str_(x.mapQuery) || str_(x.name) };
      }).filter(hasName_),
      lodging: list_(data.lodging).map(function (x) {
        return { name: str_(x.name), area: str_(x.area), why: str_(x.why), priceRange: str_(x.priceRange), mapQuery: str_(x.mapQuery) || str_(x.name) };
      }).filter(function (x) { return x.name || x.area; }),
      budget: list_(data.budget).map(function (x) {
        return { item: str_(x.item), amount: num_(x.amount), note: str_(x.note) };
      }).filter(function (x) { return x.item; }),
      tips: strList_(data.tips),
      checkBefore: strList_(data.checkBefore)
    };
    var count = plan.days.reduce(function (s, d) { return s + d.items.length; }, 0);
    if (!count) return { ok: false, error: '行程裡沒有任何站點' };
    return { ok: true, plan: plan };
  }

  function extractJson_(raw) {
    var m = /\x60\x60\x60(?:json)?\s*([\s\S]*?)\x60\x60\x60/i.exec(raw);
    if (m && m[1].indexOf('{') !== -1) return m[1].trim();
    var a = raw.indexOf('{'), b = raw.lastIndexOf('}');
    if (a !== -1 && b > a) return raw.slice(a, b + 1);
    return '';
  }
  function item_(x) {
    x = x && typeof x === 'object' ? x : {};
    var t = /^\d{1,2}:\d{2}$/.test(String(x.time || '').trim()) ? String(x.time).trim() : '';
    if (t.length === 4) t = '0' + t;
    return {
      time: t, type: type_(x.type), name: str_(x.name) || '（未命名）',
      mapQuery: str_(x.mapQuery) || str_(x.name), duration: str_(x.duration),
      transport: str_(x.transport), note: str_(x.note), cost: num_(x.cost), verify: x.verify === true
    };
  }
  function type_(t) { return TYPES.indexOf(t) === -1 ? 'sight' : t; }
  function str_(s) {
    if (s == null) return '';
    if (typeof s !== 'string' && typeof s !== 'number') return '';
    return String(s).replace(/\s+/g, ' ').trim().slice(0, LIMIT.str);
  }
  function num_(n) {
    var v = typeof n === 'string' ? Number(n.replace(/[^\d.]/g, '')) : Number(n);
    return isFinite(v) && v > 0 ? Math.min(Math.round(v), 1000000) : 0;
  }
  function list_(a) {
    return (Array.isArray(a) ? a : []).slice(0, LIMIT.list).filter(function (x) { return x && typeof x === 'object'; });
  }
  function strList_(a) {
    return (Array.isArray(a) ? a : []).slice(0, LIMIT.list).map(str_).filter(Boolean);
  }
  function hasName_(x) { return !!x.name; }
  function clean_(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 300); }

  /* ---------- 計算 ---------- */
  function budgetTotal(plan, people) {
    var per = plan.budget.length
      ? plan.budget.reduce(function (s, b) { return s + b.amount; }, 0)
      : plan.days.reduce(function (s, d) {
          return s + d.items.reduce(function (t, i) { return t + i.cost; }, 0);
        }, 0);
    var n = people >= 1 ? Math.floor(people) : 1;
    return { perPerson: per, total: per * n, people: n };
  }

  // 同一天裡，找「上一個有地點的站」，給導航用
  function prevPlace(items, index) {
    for (var i = index - 1; i >= 0; i--) {
      if (items[i].mapQuery && items[i].type !== 'transport') return items[i].mapQuery;
    }
    return '';
  }

  /* ---------- 地圖連結（不需金鑰） ---------- */
  function mapSearchUrl(q) {
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q || '');
  }
  function mapDirUrl(from, to, mode) {
    var u = 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(to || '');
    if (from) u += '&origin=' + encodeURIComponent(from);
    u += '&travelmode=' + (mode === 'driving' ? 'driving' : 'transit');
    return u;
  }

  /* ---------- 存檔清單 ---------- */
  function makeId(seed) {
    var h = 5381, s = String(seed);
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return 't' + h.toString(36);
  }
  // 回傳新陣列：同 id 取代，最新放最前，最多 30 筆
  function upsertTrip(list, trip) {
    var out = [trip];
    (Array.isArray(list) ? list : []).forEach(function (t) { if (t && t.id !== trip.id) out.push(t); });
    return out.slice(0, 30);
  }
  function removeTrip(list, id) {
    return (Array.isArray(list) ? list : []).filter(function (t) { return t && t.id !== id; });
  }

  var api = {
    TYPES: TYPES, TYPE_LABEL: TYPE_LABEL,
    nextSaturday: nextSaturday, addDays: addDays, dayLabel: dayLabel,
    validateForm: validateForm, buildPrompt: buildPrompt, parsePlan: parsePlan,
    budgetTotal: budgetTotal, prevPlace: prevPlace,
    mapSearchUrl: mapSearchUrl, mapDirUrl: mapDirUrl,
    makeId: makeId, upsertTrip: upsertTrip, removeTrip: removeTrip
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TripLogic = api;
})(this);
