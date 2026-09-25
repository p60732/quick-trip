/* 邏輯積木：純函式。不碰 DOM、不讀現在時間、不改傳入資料。
 * 瀏覽器掛在 window.TripLogic；Node 用 module.exports（給測試）。 */
(function (root) {
  'use strict';

  var TYPES = ['transport', 'sight', 'food', 'snack', 'lodging', 'shop', 'rest'];
  var TYPE_LABEL = {
    transport: '交通', sight: '景點', food: '正餐', snack: '小吃點心',
    lodging: '住宿', shop: '逛街', rest: '休息'
  };
  var LIMIT = { str: 400, days: 3, items: 24, list: 12, wishes: 500 };
  var WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  var FENCE = '\x60\x60\x60'; // 三個反引號（程式碼區塊標記）

  /* ---------- 選單資料 ---------- */
  var TW_REGIONS = [
    { region: '北部', cities: ['台北市', '新北市', '基隆市', '桃園市', '新竹市', '新竹縣', '宜蘭縣'] },
    { region: '中部', cities: ['苗栗縣', '台中市', '彰化縣', '南投縣', '雲林縣'] },
    { region: '南部', cities: ['嘉義市', '嘉義縣', '台南市', '高雄市', '屏東縣'] },
    { region: '東部', cities: ['花蓮縣', '台東縣'] },
    { region: '離島', cities: ['澎湖縣', '金門縣', '連江縣'] }
  ];
  var TW_CITIES = TW_REGIONS.reduce(function (a, r) { return a.concat(r.cities); }, []);
  var TRANSPORTS = ['高鐵', '台鐵', '客運', '捷運／公車', '計程車／叫車', '租車', '自行開車', '機車', '步行／腳踏車'];
  var CAR_MODES = ['租車', '自行開車', '機車'];
  var ORIGIN_TYPES = { home: '自家', station: '車站', hotel: '飯店', other: '其他' };
  var STATIONS = [
    '高鐵南港站', '高鐵台北站', '高鐵板橋站', '高鐵桃園站', '高鐵新竹站', '高鐵苗栗站', '高鐵台中站',
    '高鐵彰化站', '高鐵雲林站', '高鐵嘉義站', '高鐵台南站', '高鐵左營站',
    '台鐵台北站', '台鐵桃園站', '台鐵新竹站', '台鐵竹北站', '台鐵台中站', '台鐵嘉義站',
    '台鐵台南站', '台鐵高雄站', '台鐵宜蘭站', '台鐵花蓮站', '台鐵台東站'
  ];
  var WISH_SCOPE = { domestic: '國內', abroad: '國外' };
  var WISH_KIND = { eat: '吃的', play: '玩的' };

  function isTwCity(c) { return TW_CITIES.indexOf(c) !== -1; }
  // 從一段文字猜縣市（舊版草稿只有「高雄 鈴鹿賽道樂園」這種字串時用）
  function guessCity(s) {
    s = String(s || '').replace(/臺/g, '台');
    for (var i = 0; i < TW_CITIES.length; i++) if (s.indexOf(TW_CITIES[i]) !== -1) return TW_CITIES[i];
    for (var j = 0; j < TW_CITIES.length; j++) if (s.indexOf(TW_CITIES[j].slice(0, 2)) !== -1) return TW_CITIES[j];
    return '';
  }

  /* ---------- 交通（可混合） ---------- */
  // 新格式是陣列；舊版存的是一段字串（例「高鐵＋當地大眾運輸」），用關鍵字換算
  function normTransport(v) {
    if (Array.isArray(v)) {
      return TRANSPORTS.filter(function (t) { return v.indexOf(t) !== -1; });
    }
    var s = String(v || ''), out = [];
    if (/高鐵/.test(s)) out.push('高鐵');
    if (/台鐵/.test(s)) out.push('台鐵');
    if (/客運/.test(s)) out.push('客運');
    if (/大眾運輸|捷運|公車/.test(s)) out.push('捷運／公車');
    if (/計程車|叫車/.test(s)) out.push('計程車／叫車');
    if (/租車/.test(s)) out.push('租車');
    if (/開車/.test(s)) out.push('自行開車');
    return TRANSPORTS.filter(function (t) { return out.indexOf(t) !== -1; });
  }
  // 站與站之間的導航：當地有車（開車／租車／機車／計程車）且沒選捷運公車 → driving，其餘 transit
  function travelMode(v) {
    var list = normTransport(v);
    var car = list.some(function (t) { return CAR_MODES.indexOf(t) !== -1 || t === '計程車／叫車'; });
    return car && list.indexOf('捷運／公車') === -1 ? 'driving' : 'transit';
  }
  function transportText(v) {
    var list = normTransport(v);
    if (!list.length) return '';
    return list.length === 1 ? list[0] : '混合：' + list.join('＋');
  }

  /* ---------- 出發地 ---------- */
  // 新格式 {type, text}；舊版是字串
  function normOrigin(o) {
    if (o && typeof o === 'object') {
      var type = ORIGIN_TYPES[o.type] ? o.type : 'other';
      return { type: type, text: clean_(o.text) };
    }
    var s = clean_(o);
    return { type: /站/.test(s) ? 'station' : 'other', text: s };
  }
  function originText(o) {
    var n = normOrigin(o);
    if (!n.text) return n.type === 'home' && o && typeof o === 'object' ? '自家' : '';
    return n.type === 'other' ? n.text : ORIGIN_TYPES[n.type] + '（' + n.text + '）';
  }
  // 地圖用：只要地址或站名本身
  function originPlace(o) { return normOrigin(o).text; }

  /* ---------- 目的地 ---------- */
  function destText(f) {
    var city = clean_(f.city), place = clean_(f.destination);
    if (city && place) return place.indexOf(city.slice(0, 2)) === 0 ? place : city + ' ' + place;
    return city || place;
  }

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
    // 縣市可空（讓 Claude 從想去的點判斷），但有填就要在選單內；兩個都空就擋
    if (clean_(f.city) && !isTwCity(f.city)) errs.push('縣市不在選單內');
    else if (!isTwCity(f.city) && !clean_(f.destination)) errs.push('請填想去的點，或在「更多選項」選縣市');
    var o = normOrigin(f.origin);
    if (!o.text) errs.push(o.type === 'home' ? '請填家裡地址' : o.type === 'hotel' ? '請填飯店名稱' : '請填出發地');
    if (!normTransport(f.transport).length) errs.push('請至少選一種交通方式');
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
    var picks = (Array.isArray(f.wishPicks) ? f.wishPicks : []).map(clean_).filter(Boolean).slice(0, 12);
    var tlist = normTransport(f.transport);
    lines.push('請幫我規劃一趟台灣國內的說走就走小旅行，並把附近順路的好玩景點和好吃的餐廳、小吃一起排進去。');
    lines.push('');
    lines.push('【基本資料】');
    lines.push('- 出發地：' + originText(f.origin));
    lines.push('- 目的地縣市：' + (isTwCity(f.city) ? clean_(f.city) : '（請依主要想去的點判斷）'));
    if (clean_(f.destination)) lines.push('- 主要想去（一定要去）：' + clean_(f.destination));
    if (picks.length) lines.push('- 願望清單裡想順便去／吃（盡量排進去，排不進去就放到附近備選）：' + picks.join('、'));
    if (clean_(f.mustDo)) lines.push('- 其他指定想去／想吃：' + clean_(f.mustDo));
    lines.push('- 日期：' + dates);
    lines.push('- 交通方式：' + tlist.join('、') + (tlist.length > 1 ? '（可以混合搭配，每一段選最順的）' : ''));
    if (f.leaveAt) lines.push('- 最早出發時間：' + f.leaveAt);
    if (f.backBy) lines.push('- 希望回到出發地的時間：' + f.backBy + ' 前');
    lines.push('- 人數：' + f.people + ' 人' + (clean_(f.who) ? '（' + clean_(f.who) + '）' : ''));
    lines.push('- 步調：' + clean_(f.pace));
    if (clean_(f.food)) lines.push('- 飲食偏好：' + clean_(f.food));
    if (clean_(f.budget)) lines.push('- 每人預算上限：約 NT$' + clean_(f.budget));
    if (clean_(f.extra)) lines.push('- 其他備註：' + clean_(f.extra));
    lines.push('');
    lines.push('【規劃要求】');
    lines.push('1. ' + (clean_(f.destination) ? '以主要想去的點為中心' : '在' + clean_(f.city) + '挑順路的一區') + '，優先挑車程或步行 20 分鐘內的景點與餐廳，路線不要來回折返。');
    lines.push('2. 用真實存在、目前仍營業的店家與景點；不確定是否還在營業、營業時間或需要預約的，在 note 寫明並把 verify 設為 true。');
    lines.push('3. 時間表要包含：從出發地出發、每段交通（交通工具、轉乘方式、大約車程）、每個點的停留時間、午餐晚餐與點心。');
    lines.push('4. 大眾運輸要寫出實際車站名稱（例如高鐵左營站、捷運站名、公車路線號碼）；開車要提醒停車。');
    lines.push('5. 另外列出 4–6 個「附近備選」：時間多出來或臨時不想去某站時可以替換的點。');
    if (f.days === 2) lines.push('6. 給 2–3 個住宿建議（區域或具體旅館皆可），說明為什麼選那一區。');
    lines.push((f.days === 2 ? '7' : '6') + '. 預算以「每人」新台幣估算，列出交通、門票、餐費' + (f.days === 2 ? '、住宿（以兩人一房平分）' : '') + '。');
    lines.push('');
    return lines.concat(formatSpec_(f.days)).join('\n');
  }
  function formatSpec_(days) {
    return [
      '【回覆格式】只回一個 ' + FENCE + 'json 程式碼區塊，不要其他文字，格式如下：',
      FENCE + 'json',
      JSON.stringify(schemaExample_(days), null, 1),
      FENCE,
      'type 只能是：' + TYPES.join(' / ') + '。time 用 24 小時制 HH:MM。cost 是每人新台幣整數，免費填 0。mapQuery 填能在 Google 地圖搜到的「店名＋區域」。'
    ];
  }
  // 行程排好後想再請 AI 改：附上目前的行程＋想改的地方（沒寫就請它照同樣條件重排一版）
  function buildRevisePrompt(plan, request, f) {
    var p = plan && Array.isArray(plan.days) ? plan : { days: [] };
    var days = p.days.length >= 2 ? 2 : 1;
    var req = clean_(request).slice(0, 500);
    var lines = [];
    lines.push('這是我已經排好的台灣國內小旅行行程（JSON），請幫我修改。');
    lines.push('');
    lines.push('【想改的地方】');
    lines.push(req ? '- ' + req : '- 照同樣的出發地、日期、交通和步調重新排一版，換掉不順路或不理想的點，其他盡量保留。');
    var base = [];
    if (f && typeof f === 'object') {
      if (f.origin) base.push('出發地：' + originText(f.origin));
      if (isTwCity(f.city)) base.push('縣市：' + clean_(f.city));
      var tl = f.transport ? normTransport(f.transport) : [];
      if (tl.length) base.push('交通：' + tl.join('、'));
      if (clean_(f.pace)) base.push('步調：' + clean_(f.pace));
      if (f.people) base.push('人數：' + f.people + ' 人');
    }
    if (base.length) { lines.push(''); lines.push('【原本的條件】' + base.join('；')); }
    lines.push('');
    lines.push('【修改要求】');
    lines.push('1. 沒被要求改的部分盡量保留原樣（時間、店家、交通）。');
    lines.push('2. 改動後要重新檢查時間順序與交通接駁是否合理，路線不要來回折返。');
    lines.push('3. 用真實存在、目前仍營業的店家與景點；不確定的在 note 寫明並把 verify 設為 true。');
    lines.push('4. 預算、附近備選、提醒事項也跟著更新。');
    lines.push('');
    lines.push('【目前的行程】');
    lines.push(FENCE + 'json');
    lines.push(JSON.stringify(p));
    lines.push(FENCE);
    lines.push('');
    return lines.concat(formatSpec_(days)).join('\n');
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

  // Google 地圖的地點連結（在 Google 地圖按「分享」複製出來的）
  var GMAP_RE_ = /^https:\/\/(maps\.app\.goo\.gl\/|goo\.gl\/maps\/|(www\.)?google\.com(\.tw)?\/maps[\/?]|maps\.google\.com(\.tw)?\/)[^\s<>"']*$/i;
  function isGmapUrl(u) { return GMAP_RE_.test(String(u || '')); }
  // 貼上 Google 地圖分享的內容（可能是「店名＋換行＋連結」或只有連結）→ {name, mapUrl}
  function parseMapShare(text) {
    var t = String(text || '');
    var m = /https:\/\/[^\s<>"']+/i.exec(t);
    if (!m || !isGmapUrl(m[0])) return null;
    var url = m[0].replace(/[)\]。，,]+$/, '');
    // 連結前面的文字：第一行是店名，其餘（或「·」後面）當地址，用來猜縣市
    var lines = t.slice(0, m.index).split(/[\r\n]+/).map(function (x) { return clean_(x); }).filter(Boolean);
    var first = lines.shift() || '', addr = lines.join(' ');
    var dot = first.split(/\s*[·•]\s*/);
    if (dot.length > 1) { first = dot.shift(); addr = (dot.join(' ') + ' ' + addr).trim(); }
    var name = first.replace(/[：:\-－|｜]+$/, '').trim();
    if (!name) name = placeFromUrl_(url);
    return { name: name.slice(0, 100), mapUrl: url.slice(0, 500), address: addr.slice(0, 200) };
  }
  // 完整網址裡的 /maps/place/店名/
  function placeFromUrl_(url) {
    var pm = /\/maps\/(?:place|search)\/([^\/?#]+)/.exec(String(url || ''));
    if (!pm) return '';
    try { return clean_(decodeURIComponent(pm[1].replace(/\+/g, ' '))); } catch (e) { return ''; }
  }

  /* ---------- 從 iPhone 分享鍵帶進來的內容（#add=…） ---------- */
  // 回傳 {name, mapUrl, url, city, note} 或 null；Google 地圖連結放 mapUrl，其他連結（IG、文章）放 url
  function parseAddLink(hash) {
    var m = /#add=([^#]*)/.exec(String(hash || ''));
    if (!m) return null;
    var text;
    try { text = decodeURIComponent(m[1].replace(/\+/g, '%20')); } catch (e) { return null; }
    return shareToWish(text.slice(0, 2000));
  }
  function shareToWish(text) {
    var t = String(text || '');
    if (!clean_(t)) return null;
    var g = parseMapShare(t);
    if (g) return { name: g.name, mapUrl: g.mapUrl, url: '', city: guessCity(g.address + ' ' + g.name), note: '' };
    var u = /https?:\/\/[^\s<>"']+/i.exec(t);
    var before = clean_((u ? t.slice(0, u.index) : t).split(/[\r\n]+/)[0] || '');
    return { name: before.slice(0, 100), mapUrl: '', url: u ? u[0].slice(0, 500) : '', city: guessCity(t), note: '' };
  }

  /* ---------- Google 匯出（Takeout）的已儲存地點 ---------- */
  function parseCsv_(text) {
    var rows = [], row = [], cur = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); rows.push(row); row = []; cur = '';
      } else cur += ch;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }
  // 支援：已儲存清單 CSV（Title, Note, URL…）、已加標籤的地點 / 已儲存的地點 JSON（GeoJSON）
  // 回傳 {ok, places:[{name, address, mapUrl, lat, lng, country, note}]} 或 {ok:false, error}
  function parseTakeout(text) {
    var t = String(text || '').replace(/^\uFEFF/, '');
    if (t.length > 3000000) return { ok: false, error: '檔案太大了' };
    var out = [];
    if (/^\s*[\[{]/.test(t)) {
      var d; try { d = JSON.parse(t); } catch (e) { return { ok: false, error: '這個 JSON 檔讀不懂' }; }
      var feats = d && Array.isArray(d.features) ? d.features : Array.isArray(d) ? d : null;
      if (!feats) return { ok: false, error: '不是 Google 匯出的地點檔（要「已加標籤的地點」或「已儲存的地點」）' };
      feats.forEach(function (f) {
        if (!f || typeof f !== 'object') return;
        var pr = f.properties && typeof f.properties === 'object' ? f.properties : {};
        var loc = pr.location || pr.Location || {};
        var c = f.geometry && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : [];
        var lng = Number(c[0]), lat = Number(c[1]);
        var ok = isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
        out.push({
          name: clean_(pr.name || loc.name || pr.Title || loc['Business Name'] || ''),
          address: clean_(pr.address || loc.address || loc.Address || ''),
          mapUrl: clean_(pr.google_maps_url || pr['Google Maps URL'] || ''),
          lat: ok ? lat : null, lng: ok ? lng : null,
          country: clean_(loc.country_code || loc['Country Code'] || ''),
          note: clean_(pr.Comment || pr.comment || pr.Note || '')
        });
      });
    } else {
      var rows = parseCsv_(t);
      var head = (rows.shift() || []).map(function (h) { return clean_(h).toLowerCase(); });
      var col = function (names) { for (var i = 0; i < head.length; i++) if (names.indexOf(head[i]) !== -1) return i; return -1; };
      var ti = col(['title', '標題', '名稱', 'name']), ni = col(['note', '附註', '備註', '筆記']), ui = col(['url', '網址', '連結']), ci = col(['comment', '留言', '評論']);
      if (ti === -1 && ui === -1) return { ok: false, error: '不是 Google 匯出的清單檔（第一列要有 Title、URL）' };
      rows.forEach(function (r) {
        var g = function (i) { return i === -1 ? '' : clean_(r[i] || ''); };
        if (!g(ti) && !g(ui)) return;
        out.push({ name: g(ti), address: '', mapUrl: g(ui), lat: null, lng: null, country: '', note: [g(ni), g(ci)].filter(Boolean).join('；') });
      });
    }
    out = out.filter(function (x) { return x.name || x.address || x.mapUrl || x.lat !== null; });
    if (!out.length) return { ok: false, error: '檔案裡沒有地點' };
    return { ok: true, places: out.slice(0, LIMIT.wishes) };
  }
  var EAT_RE_ = /餐|食|麵|飯|粥|咖啡|café|cafe|coffee|茶|飲|甜|冰|豆花|燒|烤|鍋|肉|魚|蝦|蟹|雞|鴨|牛|豬|羊|滷|炸|酒|吧|bar|小吃|早午餐|早餐|便當|壽司|拉麵|丼|披薩|pizza|漢堡|burger|麵包|烘焙|蛋糕|甜點|bistro|restaurant|kitchen|廚房|食堂|料理|美食|夜市/i;
  function guessKind(name) { return EAT_RE_.test(String(name || '')) ? 'eat' : 'play'; }
  // 把一個匯出的地點轉成願望草稿（縣市猜不到就留空，讓使用者選）
  function placeToWish(pl) {
    var p = pl && typeof pl === 'object' ? pl : {};
    var name = clean_(p.name) || placeFromUrl_(p.mapUrl) || clean_(p.address).slice(0, 40);
    var addr = clean_(p.address);
    var abroad = !!p.country && String(p.country).toUpperCase() !== 'TW';
    var city = abroad ? '' : guessCity(addr + ' ' + name);
    if (abroad) { var parts = addr.split(/[,，]/).map(clean_).filter(Boolean); city = parts.slice(-2).join(' ').slice(0, 60) || String(p.country).toUpperCase(); }
    var raw = clean_(p.mapUrl).replace(/^http:\/\//i, 'https://');
    var mapUrl = isGmapUrl(raw) ? raw
      : p.lat !== null && p.lat !== undefined && isFinite(p.lat) ? 'https://www.google.com/maps/search/?api=1&query=' + Number(p.lat).toFixed(6) + ',' + Number(p.lng).toFixed(6)
      : name ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent((name + ' ' + addr).trim()) : '';
    return { name: name.slice(0, 100), scope: abroad ? 'abroad' : 'domestic', kind: guessKind(name), city: city, note: clean_(p.note).slice(0, 200), url: '', mapUrl: mapUrl.slice(0, 500) };
  }

  /* ---------- 願望清單 ---------- */
  // input: {name, scope, kind, city, note, url}；回傳 {ok, wish} 或 {ok:false, error}
  function normalizeWish(input, id, addedYmd) {
    var w = input && typeof input === 'object' ? input : {};
    var name = clean_(w.name).slice(0, 100);
    var scope = WISH_SCOPE[w.scope] ? w.scope : '';
    var kind = WISH_KIND[w.kind] ? w.kind : '';
    var city = clean_(w.city).slice(0, 60);
    var url = clean_(w.url).slice(0, 500);
    if (!name) return { ok: false, error: '請填想去的地方或店名' };
    if (!scope) return { ok: false, error: '請選國內或國外' };
    if (!kind) return { ok: false, error: '請選吃的或玩的' };
    if (scope === 'domestic' && !isTwCity(city)) return { ok: false, error: '請選縣市' };
    if (scope === 'abroad' && !city) return { ok: false, error: '請填國家或城市' };
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) return { ok: false, error: '連結要是 http 或 https 開頭' };
    var mapUrl = clean_(w.mapUrl).slice(0, 500);
    if (mapUrl && !isGmapUrl(mapUrl)) return { ok: false, error: 'Google 地圖連結不對：請在 Google 地圖按「分享」→「複製連結」再貼上' };
    return {
      ok: true,
      wish: {
        id: String(id || ''), name: name, scope: scope, kind: kind, city: city,
        note: clean_(w.note).slice(0, 200), url: url, mapUrl: mapUrl, done: w.done === true,
        added: /^\d{4}-\d{2}-\d{2}$/.test(String(addedYmd || w.added || '')) ? String(addedYmd || w.added) : '',
        addedBy: clean_(w.addedBy).slice(0, 20)   // 群組裡由後端填，旅伴只能改刪自己加的
      }
    };
  }
  // 讀回 localStorage 的清單時再清洗一次，壞掉的丟掉
  function cleanWishes(list) {
    return (Array.isArray(list) ? list : []).slice(0, LIMIT.wishes).map(function (w) {
      var r = normalizeWish(w, w && w.id);
      return r.ok && r.wish.id ? r.wish : null;
    }).filter(Boolean);
  }
  // opt: {scope, kind:'all'|'eat'|'play', showDone}
  function filterWishes(list, opt) {
    opt = opt || {};
    return (Array.isArray(list) ? list : []).filter(function (w) {
      if (opt.scope && w.scope !== opt.scope) return false;
      if (opt.kind && opt.kind !== 'all' && w.kind !== opt.kind) return false;
      if (!opt.showDone && w.done) return false;
      return true;
    });
  }
  // 依城市分組；國內照縣市選單順序，國外照名稱
  function groupWishes(list) {
    var map = {}, keys = [];
    (Array.isArray(list) ? list : []).forEach(function (w) {
      if (!map[w.city]) { map[w.city] = []; keys.push(w.city); }
      map[w.city].push(w);
    });
    keys.sort(function (a, b) {
      var ia = TW_CITIES.indexOf(a), ib = TW_CITIES.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return keys.map(function (k) { return { city: k, items: map[k] }; });
  }
  function wishesForCity(list, city) {
    return (Array.isArray(list) ? list : []).filter(function (w) {
      return w.scope === 'domestic' && w.city === city && !w.done;
    });
  }
  function toggleDone(list, id) {
    return (Array.isArray(list) ? list : []).map(function (w) {
      if (w.id !== id) return w;
      var c = {}; for (var k in w) c[k] = w[k];
      c.done = !w.done;
      return c;
    });
  }

  /* ---------- 行程存檔清洗、備份匯出／匯入 ---------- */
  var FORM_STR_KEYS = ['scope', 'city', 'destination', 'mustDo', 'date', 'leaveAt', 'backBy', 'who', 'pace', 'food', 'budget', 'extra'];
  function cleanForm_(f) {
    f = f && typeof f === 'object' ? f : {};
    var out = {};
    FORM_STR_KEYS.forEach(function (k) { if (f[k] != null) out[k] = clean_(f[k]); });
    out.days = f.days === 2 ? 2 : 1;
    out.people = f.people >= 1 && f.people <= 20 ? Math.floor(f.people) : 1;
    out.origin = normOrigin(f.origin);
    out.transport = normTransport(f.transport);
    out.wishPicks = (Array.isArray(f.wishPicks) ? f.wishPicks : []).map(clean_).filter(Boolean).slice(0, 12);
    return out;
  }
  // 一筆行程：id 必須是字串、plan 要能通過 parsePlan；壞的回 null
  function cleanTrip(t) {
    if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !/^[\w-]{1,40}$/.test(t.id)) return null;
    var r = parsePlan(JSON.stringify(t.plan || null));
    if (!r.ok) return null;
    return {
      id: t.id, savedDate: /^\d{4}-\d{2}-\d{2}$/.test(String(t.savedDate)) ? t.savedDate : '',
      form: cleanForm_(t.form), plan: r.plan
    };
  }
  function cleanTrips(list) {
    return (Array.isArray(list) ? list : []).slice(0, 30).map(cleanTrip).filter(Boolean);
  }
  // 備份不含家裡地址（行程裡的出發地除外），檔案可能被傳來傳去
  function buildBackup(trips, wishes, todayYmd) {
    return JSON.stringify({
      app: 'quick-trip', v: 1, exported: String(todayYmd || ''),
      trips: cleanTrips(trips), wishes: cleanWishes(wishes)
    }, null, 1);
  }
  function parseBackup(text) {
    var raw = String(text || '');
    if (raw.length > 5000000) return { ok: false, error: '檔案太大，不像是這個工具的備份' };
    var d;
    try { d = JSON.parse(raw); } catch (e) { return { ok: false, error: '檔案格式不對（不是 JSON）' }; }
    if (!d || d.app !== 'quick-trip') return { ok: false, error: '這不是「說走就走小旅行」的備份檔' };
    return { ok: true, trips: cleanTrips(d.trips), wishes: cleanWishes(d.wishes) };
  }
  // 合併：以匯入的為準（同 id 取代），原本有、匯入沒有的保留
  function mergeById(existing, incoming, max) {
    var out = [], seen = {};
    (Array.isArray(incoming) ? incoming : []).concat(Array.isArray(existing) ? existing : []).forEach(function (x) {
      if (x && x.id && !seen[x.id]) { seen[x.id] = true; out.push(x); }
    });
    return out.slice(0, max || 30);
  }

  /* ---------- 行程逐站編輯（都回傳新的 plan，不改原本的） ---------- */
  var STOP_FIELDS = ['time', 'type', 'name', 'mapQuery', 'duration', 'transport', 'note', 'cost', 'verify'];
  function editPlan_(plan, fn) {
    var p = JSON.parse(JSON.stringify(plan));
    if (fn(p) === false) return plan;
    var r = parsePlan(JSON.stringify(p));
    return r.ok ? r.plan : plan;
  }
  function hasStop_(p, d, i) { return p.days[d] && i >= 0 && i < p.days[d].items.length; }
  function moveStop(plan, d, i, dir) {
    return editPlan_(plan, function (p) {
      var j = i + (dir < 0 ? -1 : 1);
      if (!hasStop_(p, d, i) || !hasStop_(p, d, j)) return false;
      var its = p.days[d].items, t = its[i]; its[i] = its[j]; its[j] = t;
    });
  }
  // 拖曳換順序：站點搬到新位置，時間留在原本的格子（行程時間仍由早到晚）
  function reorderStop(plan, d, from, to) {
    return editPlan_(plan, function (p) {
      if (!hasStop_(p, d, from) || !hasStop_(p, d, to) || from === to) return false;
      var its = p.days[d].items, times = its.map(function (x) { return x.time; });
      its.splice(to, 0, its.splice(from, 1)[0]);
      its.forEach(function (x, k) { x.time = times[k]; });
    });
  }
  // 旅伴裝置：有加入群組、但一個都不是自己建立的 → 不開放 AI 規劃
  function isGuestDevice(groups) {
    var gs = Array.isArray(groups) ? groups : [];
    return gs.length > 0 && !gs.some(function (g) { return g && (g.role === 'owner' || g.ownerKey); });
  }
  function removeStop(plan, d, i) {
    return editPlan_(plan, function (p) {
      if (!hasStop_(p, d, i)) return false;
      p.days[d].items.splice(i, 1);
    });
  }
  function updateStop(plan, d, i, fields) {
    return editPlan_(plan, function (p) {
      if (!hasStop_(p, d, i)) return false;
      var s = p.days[d].items[i];
      Object.keys(fields || {}).forEach(function (k) {
        if (STOP_FIELDS.indexOf(k) !== -1) s[k] = fields[k];
      });
      // 改了名稱但沒改地圖關鍵字 → 地圖跟著名稱走
      if (fields && fields.name != null && fields.mapQuery == null) s.mapQuery = fields.name;
    });
  }
  function addStop(plan, d, stop) {
    return editPlan_(plan, function (p) {
      if (!p.days[d] || p.days[d].items.length >= LIMIT.items) return false;
      p.days[d].items.push(stop || { name: '新的一站', type: 'sight' });
    });
  }
  function sortByTime(plan, d) {
    return editPlan_(plan, function (p) {
      if (!p.days[d]) return false;
      // 沒填時間的維持原本相對位置，排在有時間的後面
      var its = p.days[d].items.map(function (s, k) { return { s: s, k: k }; });
      its.sort(function (a, b) {
        var ta = a.s.time || '99:99', tb = b.s.time || '99:99';
        return ta < tb ? -1 : ta > tb ? 1 : a.k - b.k;
      });
      p.days[d].items = its.map(function (x) { return x.s; });
    });
  }
  // 把附近備選放進行程：replaceIndex 有給就取代那一站（被換掉的放回備選），沒給就加在當天最後
  function extraToStop(plan, extraIndex, d, replaceIndex) {
    return editPlan_(plan, function (p) {
      var x = p.nearbyExtras[extraIndex];
      if (!x || !p.days[d]) return false;
      var stop = { name: x.name, mapQuery: x.mapQuery, type: x.type, note: x.why };
      if (replaceIndex != null) {
        if (!hasStop_(p, d, replaceIndex)) return false;
        var old = p.days[d].items[replaceIndex];
        stop.time = old.time; stop.duration = old.duration; stop.transport = old.transport;
        p.days[d].items[replaceIndex] = stop;
        p.nearbyExtras[extraIndex] = { name: old.name, mapQuery: old.mapQuery, type: old.type, why: '原本排在 ' + (old.time || '行程') + ' 的點' };
      } else {
        if (p.days[d].items.length >= LIMIT.items) return false;
        p.days[d].items.push(stop);
        p.nearbyExtras.splice(extraIndex, 1);
      }
    });
  }

  /* ---------- 出發前清單（可分工） ---------- */
  function normalizeCheck(c, id) {
    c = c && typeof c === 'object' ? c : {};
    var cid = String(id || c.id || '');
    var tripId = cid.split('.')[0];
    var text = clean_(c.text).slice(0, 100);
    if (!/^[\w-]{1,40}\.[\w-]{1,30}$/.test(cid) || !text) return null;
    return {
      id: cid, tripId: tripId, text: text, done: c.done === true,
      who: clean_(c.who).slice(0, 20), order: typeof c.order === 'number' && isFinite(c.order) ? c.order : 999
    };
  }
  function seedChecks(tripId, plan) {
    return (plan && plan.checkBefore ? plan.checkBefore : []).map(function (t, i) {
      return normalizeCheck({ text: t, order: i }, tripId + '.c' + i);
    }).filter(Boolean);
  }
  function checksForTrip(list, tripId) {
    return (Array.isArray(list) ? list : []).map(function (c) { return normalizeCheck(c, c && c.id); })
      .filter(function (c) { return c && c.tripId === tripId; })
      .sort(function (a, b) { return a.order - b.order || (a.id < b.id ? -1 : 1); });
  }

  /* ---------- 旅伴群組 ---------- */
  // 邀請連結：...#join=<groupId>.<key>（放在 # 後面，不會送到任何伺服器的網址紀錄）
  function parseInvite(s) {
    var m = /#join=([A-Za-z0-9_-]{6,40})\.([A-Za-z0-9]{16,64})/.exec(String(s || ''));
    return m ? { groupId: m[1], key: m[2] } : null;
  }
  function inviteUrl(base, groupId, key) {
    return String(base || '').split('#')[0].split('?')[0] + '#join=' + groupId + '.' + key;
  }
  function cleanNick(s) { return clean_(s).slice(0, 20); }
  var KEY_RE_ = /^[A-Za-z0-9]{16,64}$/, GID_RE_ = /^[A-Za-z0-9_-]{6,40}$/;
  // 群組清單（登入後以後端為準，這裡只是快取）：格式不對的丟掉
  // 舊版（還沒登入時）留在手機上的邀請碼、管理碼、成員鑰匙也保留，登入後用來把身分搬到帳號上
  function cleanGroups(list) {
    var seen = {};
    return (Array.isArray(list) ? list : []).map(function (g) {
      if (!g || typeof g !== 'object' || !GID_RE_.test(g.groupId) || seen[g.groupId]) return null;
      var k = function (v) { return KEY_RE_.test(v) ? v : ''; };
      var mid = GID_RE_.test(g.memberId) ? g.memberId : '';
      var legacy = !!(k(g.key) || k(g.ownerKey) || (mid && k(g.memberKey)));
      if (!mid && !legacy && !k(g.inviteKey)) return null;
      seen[g.groupId] = true;
      return {
        groupId: g.groupId, name: cleanGroupName(g.name) || '未命名群組',
        memberId: mid, role: g.role === 'owner' || k(g.ownerKey) ? 'owner' : 'member', inviteKey: k(g.inviteKey),
        nick: cleanNick(g.nick) || '我', legacy: legacy,
        key: k(g.key), ownerKey: k(g.ownerKey), memberKey: mid ? k(g.memberKey) : ''
      };
    }).filter(Boolean).slice(0, 30);
  }
  // 登入狀態：只記登入憑證和帳號名稱，不記密碼
  function cleanAuth(a) {
    if (!a || typeof a !== 'object' || !/^a[0-9a-f]{15}\.\d{1,6}\.\d{13}\.[0-9a-f]{32}$/.test(a.token)) return null;
    if (a.token.split('.')[0] !== a.accountId || !/^u[0-9a-f]{15}$/.test(a.personalId) || 'u' + a.accountId.slice(1) !== a.personalId) return null;
    return { token: a.token, accountId: a.accountId, personalId: a.personalId, name: cleanNick(a.name) || '我' };
  }
  // 成員名單（後端 pull 帶回來）：只留要顯示的欄位
  function cleanMembers(list) {
    return (Array.isArray(list) ? list : []).filter(function (m) { return m && GID_RE_.test(m.memberId); }).slice(0, 100).map(function (m) {
      return { memberId: m.memberId, nick: cleanNick(m.nick), role: m.role === 'owner' ? 'owner' : 'member',
        status: ['active', 'released', 'kicked', 'left'].indexOf(m.status) !== -1 ? m.status : 'active' };
    });
  }
  // 顯示「誰」：成員編號換成暱稱；離開的人標示；舊資料是暱稱字串就原樣顯示
  function memberLabel(members, id) {
    if (!id) return '';
    var m = (Array.isArray(members) ? members : []).filter(function (x) { return x.memberId === id; })[0];
    if (!m) return /^m[0-9a-f]{15}$/.test(id) ? '（不明成員）' : cleanNick(id);
    return m.nick + (m.status === 'kicked' || m.status === 'left' ? '（已離開）' : '');
  }
  function cleanGroupName(s) { return clean_(s).slice(0, 40); }
  // 分享到群組的行程：拿掉家裡地址，只留「自家」
  function shareTrip(trip) {
    var t = cleanTrip(trip);
    if (!t) return null;
    if (t.form.origin.type === 'home') t.form.origin = { type: 'home', text: '' };
    return t;
  }
  // 同步：把伺服器回來的列合併進本機快取；同一筆取版本較新的。回傳新快取，不改舊的
  function mergeRows(cache, rows) {
    var old = cache && cache.items ? cache.items : {};
    var items = {}, since = cache && cache.since || 0, changed = false;
    Object.keys(old).forEach(function (k) { items[k] = old[k]; });
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      if (!r || KIND_OK.indexOf(r.kind) === -1 || typeof r.itemId !== 'string') return;
      var k = r.kind + ':' + r.itemId, cur = items[k];
      if (!cur || r.ver > cur.ver || (r.ver === cur.ver && r.updatedAt > cur.updatedAt)) {
        items[k] = {
          kind: r.kind, itemId: r.itemId, json: r.deleted ? '' : String(r.json || ''), ver: Number(r.ver) || 0,
          updatedAt: Number(r.updatedAt) || 0, updatedBy: cleanNick(r.updatedBy), deleted: r.deleted === true
        };
        changed = true;
      }
      if (Number(r.updatedAt) > since) since = Number(r.updatedAt);
    });
    return { since: since, items: items, changed: changed };
  }
  var KIND_OK = ['wish', 'trip', 'check'];
  // 從快取取出某一類（沒刪掉、JSON 讀得懂的），附上版本與最後修改者
  function listKind(cache, kind) {
    var items = cache && cache.items ? cache.items : {}, out = [];
    Object.keys(items).forEach(function (k) {
      var r = items[k];
      if (r.kind !== kind || r.deleted) return;
      var o; try { o = JSON.parse(r.json); } catch (e) { return; }
      if (!o || typeof o !== 'object') return;
      o.id = r.itemId;
      out.push({ obj: o, ver: r.ver, by: r.updatedBy, at: r.updatedAt });
    });
    return out.sort(function (a, b) { return b.at - a.at; });
  }
  function itemVer(cache, kind, id) {
    var r = cache && cache.items ? cache.items[kind + ':' + id] : null;
    return r ? r.ver : 0;
  }

  /* ---------- 存檔清單 ---------- */
  function makeId(seed) {
    var h = 5381, s = String(seed);
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return 't' + h.toString(36);
  }
  // 回傳新陣列：同 id 取代，最新放最前，最多 max 筆（預設 30）
  function upsertTrip(list, trip, max) {
    var out = [trip];
    (Array.isArray(list) ? list : []).forEach(function (t) { if (t && t.id !== trip.id) out.push(t); });
    return out.slice(0, max || 30);
  }
  function removeTrip(list, id) {
    return (Array.isArray(list) ? list : []).filter(function (t) { return t && t.id !== id; });
  }

  var api = {
    TYPES: TYPES, TYPE_LABEL: TYPE_LABEL, TW_REGIONS: TW_REGIONS, TW_CITIES: TW_CITIES,
    TRANSPORTS: TRANSPORTS, reorderStop: reorderStop, cleanMembers: cleanMembers, memberLabel: memberLabel, isGuestDevice: isGuestDevice, ORIGIN_TYPES: ORIGIN_TYPES, STATIONS: STATIONS,
    WISH_SCOPE: WISH_SCOPE, WISH_KIND: WISH_KIND, WISH_MAX: LIMIT.wishes,
    isTwCity: isTwCity, guessCity: guessCity, parseAddLink: parseAddLink, shareToWish: shareToWish, parseTakeout: parseTakeout, placeToWish: placeToWish, guessKind: guessKind, normTransport: normTransport, travelMode: travelMode, transportText: transportText,
    normOrigin: normOrigin, originText: originText, originPlace: originPlace, destText: destText,
    nextSaturday: nextSaturday, addDays: addDays, dayLabel: dayLabel,
    validateForm: validateForm, buildPrompt: buildPrompt, buildRevisePrompt: buildRevisePrompt, parsePlan: parsePlan,
    budgetTotal: budgetTotal, prevPlace: prevPlace,
    mapSearchUrl: mapSearchUrl, mapDirUrl: mapDirUrl, isGmapUrl: isGmapUrl, parseMapShare: parseMapShare,
    normalizeWish: normalizeWish, cleanWishes: cleanWishes, filterWishes: filterWishes,
    groupWishes: groupWishes, wishesForCity: wishesForCity, toggleDone: toggleDone,
    moveStop: moveStop, removeStop: removeStop, updateStop: updateStop, addStop: addStop, sortByTime: sortByTime, extraToStop: extraToStop,
    normalizeCheck: normalizeCheck, seedChecks: seedChecks, checksForTrip: checksForTrip,
    parseInvite: parseInvite, inviteUrl: inviteUrl, cleanNick: cleanNick, cleanGroups: cleanGroups, cleanAuth: cleanAuth, cleanGroupName: cleanGroupName, shareTrip: shareTrip,
    mergeRows: mergeRows, listKind: listKind, itemVer: itemVer,
    cleanTrip: cleanTrip, cleanTrips: cleanTrips, buildBackup: buildBackup, parseBackup: parseBackup, mergeById: mergeById,
    makeId: makeId, upsertTrip: upsertTrip, removeTrip: removeTrip
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TripLogic = api;
})(this);
