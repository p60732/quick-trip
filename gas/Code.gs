/**
 * 說走就走－出發吧：揪團後端（Google Apps Script + Google 試算表）
 *
 * 安裝：
 * 1. 新建一個 Google 試算表 → 擴充功能 → Apps Script，把這個檔案整份貼進 Code.gs
 * 2. 在編輯器上方選 setup → 執行（第一次會要授權）
 *    執行紀錄會印出「第一個帳號的邀請碼」
 * 3. 部署 → 新增部署作業 → 類型選「網頁應用程式」
 *    執行身分：我；誰可以存取：所有人 → 部署，複製網址
 * 4. 把網址貼到 index.html 最上面的 API_URL
 * 5. 打開 網站網址#join/邀請碼 建立你自己的帳號
 * 6. 選 installTriggers → 執行，開啟每週備份
 */

/* ============ 設定 ============ */
var SCHEMA = {
  Users:       ['userId','name','nameKey','installed','disabled','invitedBy','createdAt'],
  Secrets:     ['userId','salt','hash','tempHash','tempExp'],
  Sessions:    ['token','userId','exp'],
  Trips:       ['tripId','title','dest','startDate','days','mode','maxPeople','ownerId','stage','inviteCode','rev','createdAt','cancelledAt','transferTo','updatedAt'],
  Members:     ['tripId','userId','role','joinedAt','left','lastSeen'],
  Wishlist:    ['placeId','tripId','name','type','note','addedBy','createdAt','status'],
  Votes:       ['tripId','placeId','userId'],
  Itinerary:   ['tripId','ver','json','by','at','note'],
  Tasks:       ['taskId','tripId','title','ownerId','status','takeoverBy','createdAt','createdBy'],
  Expenses:    ['expenseId','tripId','title','category','amount','paidBy','splitMode','shares','stopRef','createdBy','createdAt','deleted'],
  Settlements: ['tripId','fromId','toId','amount','status','updatedAt'],
  Log:         ['at','tripId','userId','action','text'],
  Settings:    ['key','value']
};
var DEFAULTS = { maxUsers: 60, maxOwnedTrips: 3, maxPeople: 6, sessionDays: 7, restoreDays: 30, backupKeep: 8 };
var ACTIVE = { collect: 1, plan: 1, final: 1 };

/* ============ 入口 ============ */
function doGet() {
  // 第一次打開網址時自動建立資料表
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Settings')) setup();
  // 還沒開每週備份就自動開
  if (!ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'weekly'; })) installTriggers();
  return ContentService.createTextOutput(JSON.stringify({ ok: true, app: 'letsgo', time: new Date().toISOString() }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var out;
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = { ok: true, data: handle(body) };
  } catch (err) {
    if (err && err.userMsg) out = { ok: false, error: err.userMsg, code: err.code || 'bad', extra: err.extra || null };
    else { out = { ok: false, error: '伺服器出錯了，請稍後再試', code: 'server', detail: String(err && err.stack || err) }; }
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function fail(msg, code) { var e = new Error(msg); e.userMsg = msg; e.code = code || 'bad'; throw e; }

var PUBLIC = { login: 1, join: 1, inviteInfo: 1, ping: 1, resolveMap: 1 };
var READ = { ping: 1, resolveMap: 1, inviteInfo: 1, me: 1, myTrips: 1, getTrip: 1, rev: 1, ended: 1, updates: 1 };

function handle(b) {
  var fn = API[b.action];
  if (!fn) fail('不認得的動作：' + b.action);
  DB.reset();
  var lock = null;
  if (!READ[b.action]) {
    lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) fail('太多人同時在改，請再按一次', 'busy');
  }
  try {
    var me = null;
    if (!PUBLIC[b.action]) me = auth(b.token);
    var res = fn(b, me);
    DB.flush();  // 出錯就不寫，避免只改一半
    return res;
  } finally {
    if (lock) lock.releaseLock();
  }
}

/* ============ 資料表 ============ */
var DB = (function () {
  var cache = {};
  function sheet(name) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); sh.getRange(1, 1, 1, SCHEMA[name].length).setValues([SCHEMA[name]]); sh.setFrozenRows(1); }
    return sh;
  }
  function load(name) {
    if (cache[name]) return cache[name];
    var sh = sheet(name);
    var vals = sh.getDataRange().getValues();
    var head = vals[0] && vals[0].length && vals[0][0] ? vals[0] : SCHEMA[name];
    var rows = [];
    for (var i = 1; i < vals.length; i++) {
      var o = { _r: i + 1 };
      for (var j = 0; j < head.length; j++) o[head[j]] = vals[i][j];
      rows.push(o);
    }
    cache[name] = { sh: sh, head: head, rows: rows, dirty: {}, added: [] };
    return cache[name];
  }
  // 文字一律存成文字：數字、日期樣子的字（例如 2026-10-10、名字叫 123）前面加 ' 防止試算表自動轉型，也擋掉 = 開頭的公式
  function cell(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string' && /^[=+\-@']|^\s*[\d.]|^\s*(true|false)\s*$/i.test(v)) return "'" + v;
    return v;
  }
  function toRow(t, o) { return t.head.map(function (h) { return cell(o[h]); }); }
  return {
    reset: function () { cache = {}; },
    all: function (name) { return load(name).rows; },
    find: function (name, fn) { var r = load(name).rows; for (var i = 0; i < r.length; i++) if (fn(r[i])) return r[i]; return null; },
    filter: function (name, fn) { return load(name).rows.filter(fn); },
    insert: function (name, o) { var t = load(name); o._r = null; t.rows.push(o); t.added.push(o); return o; },
    save: function (name, o) { var t = load(name); if (o._r) t.dirty[o._r] = o; },
    remove: function (name, fn) {
      // 真的刪列（只在清理舊資料時用）
      var t = load(name); DB.flush();
      var rows = t.rows.filter(fn).map(function (o) { return o._r; }).filter(Boolean).sort(function (a, b) { return b - a; });
      rows.forEach(function (r) { t.sh.deleteRow(r); });
      delete cache[name];
      return rows.length;
    },
    flush: function () {
      Object.keys(cache).forEach(function (name) {
        var t = cache[name];
        Object.keys(t.dirty).forEach(function (r) { t.sh.getRange(+r, 1, 1, t.head.length).setValues([toRow(t, t.dirty[r])]); });
        t.dirty = {};
        if (t.added.length) {
          var start = t.sh.getLastRow() + 1;
          t.sh.getRange(start, 1, t.added.length, t.head.length).setValues(t.added.map(function (o) { return toRow(t, o); }));
          t.added.forEach(function (o, i) { o._r = start + i; });
          t.added = [];
        }
      });
    }
  };
})();

function setting(key) {
  var s = DB.find('Settings', function (r) { return r.key === key; });
  return s && s.value !== '' ? s.value : DEFAULTS[key];
}

/* ============ 小工具 ============ */
function now() { return new Date().getTime(); }
function id(prefix) { return prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 10); }
function sha(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}
function str(v, max, label) {
  v = String(v == null ? '' : v).trim();
  if (max && v.length > max) fail((label || '內容') + '太長了（最多 ' + max + ' 字）');
  return v;
}
function bool(v) { return v === true || v === 'TRUE' || v === 'true' || v === 1; }
function jsonParse(s, d) { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } }
function nameKey(n) { return String(n).trim().toLowerCase().replace(/\s+/g, ''); }
function userName(uid) { var u = DB.find('Users', function (r) { return r.userId === uid; }); return u ? u.name : '（已離開）'; }
function log(tripId, uid, action, text) { DB.insert('Log', { at: now(), tripId: tripId, userId: uid, action: action, text: text }); }
function bump(trip) { trip.rev = (+trip.rev || 0) + 1; trip.updatedAt = now(); DB.save('Trips', trip); }
function inviteCode() { var c = ''; var a = 'abcdefghjkmnpqrstuvwxyz23456789'; for (var i = 0; i < 8; i++) c += a.charAt(Math.floor(Math.random() * a.length)); return c; }

/* ============ 帳號 ============ */
function auth(token) {
  if (!token) fail('請先登入', 'auth');
  var s = DB.find('Sessions', function (r) { return r.token === token; });
  if (!s || +s.exp < now()) fail('登入過期了，請重新登入', 'auth');
  var u = DB.find('Users', function (r) { return r.userId === s.userId; });
  if (!u || bool(u.disabled)) fail('這個帳號已停用', 'auth');
  // 快到期就自動延長，不用每次都寫
  var days = +setting('sessionDays');
  if (+s.exp - now() < (days - 1) * 86400000) {
    s.exp = now() + days * 86400000;
    DB.save('Sessions', s);
  }
  return u;
}
function newSession(uid) {
  var token = Utilities.getUuid() + Utilities.getUuid().slice(0, 8);
  DB.insert('Sessions', { token: token, userId: uid, exp: now() + setting('sessionDays') * 86400000 });
  return token;
}
function publicUser(u) { return { userId: u.userId, name: u.name, installed: bool(u.installed) }; }
function nameSuggest(name) {
  var base = String(name).trim(); var out = [];
  [base + '-2', base + '2', base + base.slice(-1), base + '-3'].forEach(function (n) {
    if (!DB.find('Users', function (r) { return r.nameKey === nameKey(n); })) out.push(n);
  });
  return out.slice(0, 3);
}
function checkPw(pw) { pw = String(pw || ''); if (pw.length < 4) fail('密碼至少 4 個字'); if (pw.length > 64) fail('密碼太長了'); return pw; }

function tripByCode(code) {
  code = String(code || '').trim();
  var t = DB.find('Trips', function (r) { return r.inviteCode === code; });
  return t;
}

var API = {};

API.ping = function () { return { pong: true }; };

/* Google 地圖分享短網址 → 店名（瀏覽器跨網域讀不到轉址，由後端代讀） */
API.resolveMap = function (b) {
  var url = String(b.url || '').trim();
  var ok = /^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|(www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)/;
  if (!ok.test(url)) fail('只支援 Google 地圖的分享連結');
  var cur = url, info = null;
  for (var i = 0; i < 6 && !info; i++) {
    var plain = cur; try { plain = decodeURIComponent(cur); } catch (e) {}
    info = mapInfo(plain);
    if (info) break;
    var res = UrlFetchApp.fetch(cur, { followRedirects: false, muteHttpExceptions: true });
    var h = res.getHeaders(); var loc = h.Location || h.location;
    if (!loc) {
      var html = res.getContentText().slice(0, 60000);
      info = mapInfoHtml(html);
      break;
    }
    cur = loc;
  }
  info = info || { name: '', area: '' };
  return { name: info.name, area: info.area, url: url };
};
// 「307新竹縣芎林鄉…37號店名」→ 地址、店名分開
function splitAddrName(q) {
  q = String(q).replace(/\+/g, ' ').trim();
  var m = /^(\d{3,6})?\s*(.{0,12}?[縣市].{0,40}?(?:號|樓)(?:之\d+)?)\s*(.+)$/.exec(q);
  if (m && m[3].length >= 2) return { name: m[3].trim(), area: m[2].trim() };
  if (q.indexOf(',') > 0) { var parts = q.split(','); return { name: parts[0].trim(), area: parts.slice(1).join(',').trim() }; }
  return { name: q, area: '' };
}
function mapInfo(s) {
  var p = /\/maps\/place\/([^\/@?]+)/.exec(s);
  if (p) { var n = p[1]; try { n = decodeURIComponent(n); } catch (e) {} return splitAddrName(n); }
  var q = /[?&]q=([^&]+)/.exec(s);
  if (q) { var v = q[1]; try { v = decodeURIComponent(v); } catch (e) {} if (!/^[\d.,\s-]+$/.test(v)) return splitAddrName(v); }
  return null;
}
function mapInfoHtml(html) {
  var m = /<meta[^>]+(?:property|itemprop|name)="(?:og:title|name)"[^>]+content="([^"]+)"/.exec(html) || /<title>([^<]+)<\/title>/.exec(html);
  var t = m ? m[1].split(' · ')[0].replace(/ - Google (?:地圖|Maps)$/, '').trim() : '';
  if (t && !/^(Google (地圖|Maps)|Before you continue.*)$/.test(t)) return { name: t, area: '' };
  var m2 = /https:\/\/www\.google\.[a-z.]+\/maps\/place\/[^"'\s\\]+/.exec(html);
  return m2 ? mapInfo(m2[0]) : null;
}

API.inviteInfo = function (b) {
  var code = String(b.code || '').trim();
  if (code && code === setting('bootstrapCode')) return { bootstrap: true };
  var t = tripByCode(code);
  if (!t || !ACTIVE[t.stage]) fail('這個邀請連結失效了，請跟開團人要新的', 'invite');
  var ms = activeMembers(t.tripId);
  return { tripId: t.tripId, title: t.title, owner: userName(t.ownerId), count: ms.length, max: +t.maxPeople, names: ms.map(function (m) { return userName(m.userId); }) };
};

API.join = function (b) {
  var code = String(b.code || '').trim();
  var boot = code && code === setting('bootstrapCode');
  var t = boot ? null : tripByCode(code);
  if (!boot && (!t || !ACTIVE[t.stage])) fail('這個邀請連結失效了，請跟開團人要新的', 'invite');
  var name = str(b.name, 20, '名字');
  if (!name) fail('請填名字');
  var pw = checkPw(b.password);
  if (DB.find('Users', function (r) { return r.nameKey === nameKey(name); })) {
    var e = new Error('nameTaken'); e.userMsg = '已經有人叫「' + name + '」了。名字是登入用的，不能重複。'; e.code = 'nameTaken';
    e.extra = { suggest: nameSuggest(name) };
    throw e;
  }
  var users = DB.all('Users').filter(function (u) { return !bool(u.disabled); });
  if (users.length >= +setting('maxUsers')) fail('目前名額已滿，請聯絡網站管理人', 'full');
  if (t && activeMembers(t.tripId).length >= +t.maxPeople) fail('這團已經滿 ' + t.maxPeople + ' 人了', 'tripFull');
  var uid = id('u');
  var salt = Utilities.getUuid();
  DB.insert('Users', { userId: uid, name: name, nameKey: nameKey(name), installed: !!b.standalone, disabled: false, invitedBy: t ? t.ownerId : 'bootstrap', createdAt: now() });
  DB.insert('Secrets', { userId: uid, salt: salt, hash: sha(salt + pw), tempHash: '', tempExp: '' });
  if (boot) { var s = DB.find('Settings', function (r) { return r.key === 'bootstrapCode'; }); s.value = 'used-' + now(); DB.save('Settings', s); }
  if (t) { addMember(t, uid, 'member'); log(t.tripId, uid, 'join', name + ' 加入了'); bump(t); }
  return { token: newSession(uid), user: publicUser(DB.find('Users', function (r) { return r.userId === uid; })), tripId: t ? t.tripId : null };
};

API.login = function (b) {
  var name = str(b.name, 40);
  var u = DB.find('Users', function (r) { return r.nameKey === nameKey(name); });
  var sec = u && DB.find('Secrets', function (r) { return r.userId === u.userId; });
  var pw = String(b.password || '');
  var ok = sec && sha(sec.salt + pw) === sec.hash;
  var usedTemp = false;
  if (!ok && sec && sec.tempHash && +sec.tempExp > now() && sha(sec.salt + pw) === sec.tempHash) { ok = true; usedTemp = true; }
  if (!ok) fail('名字或密碼不對', 'login');
  if (bool(u.disabled)) fail('這個帳號已停用', 'login');
  var joined = null;
  if (b.code) {
    var t = tripByCode(b.code);
    if (t && ACTIVE[t.stage] && !isMember(t.tripId, u.userId)) {
      if (activeMembers(t.tripId).length >= +t.maxPeople) fail('這團已經滿 ' + t.maxPeople + ' 人了', 'tripFull');
      addMember(t, u.userId, 'member'); log(t.tripId, u.userId, 'join', u.name + ' 加入了'); bump(t); joined = t.tripId;
    } else if (t && isMember(t.tripId, u.userId)) joined = t.tripId;
  }
  var wasInstalled = bool(u.installed);
  if (b.standalone && !wasInstalled) { u.installed = true; DB.save('Users', u); }
  return { token: newSession(u.userId), user: publicUser(u), mustChangePw: usedTemp, safariButInstalled: wasInstalled && !b.standalone, tripId: joined };
};

API.acceptInvite = function (b, me) {
  var t = tripByCode(b.code);
  if (!t || !ACTIVE[t.stage]) fail('這個邀請連結失效了，請跟開團人要新的', 'invite');
  if (isMember(t.tripId, me.userId)) return { tripId: t.tripId, already: true };
  if (activeMembers(t.tripId).length >= +t.maxPeople) fail('這團已經滿 ' + t.maxPeople + ' 人了', 'tripFull');
  addMember(t, me.userId, 'member'); log(t.tripId, me.userId, 'join', me.name + ' 加入了'); bump(t);
  return { tripId: t.tripId };
};
API.me = function (b, me) { return { user: publicUser(me) }; };
API.setInstalled = function (b, me) { me.installed = true; DB.save('Users', me); return {}; };
API.logout = function (b) { var s = DB.find('Sessions', function (r) { return r.token === b.token; }); if (s) { s.exp = 0; DB.save('Sessions', s); } return {}; };
API.changePw = function (b, me) {
  var pw = checkPw(b.password);
  var sec = DB.find('Secrets', function (r) { return r.userId === me.userId; });
  sec.salt = Utilities.getUuid(); sec.hash = sha(sec.salt + pw); sec.tempHash = ''; sec.tempExp = '';
  DB.save('Secrets', sec); return {};
};
API.changeName = function (b, me) {
  var name = str(b.name, 20, '名字'); if (!name) fail('請填名字');
  if (DB.find('Users', function (r) { return r.nameKey === nameKey(name) && r.userId !== me.userId; })) fail('已經有人叫「' + name + '」了', 'nameTaken');
  me.name = name; me.nameKey = nameKey(name); DB.save('Users', me); return { user: publicUser(me) };
};

/* ============ 團 ============ */
function activeMembers(tripId) { return DB.filter('Members', function (m) { return m.tripId === tripId && !bool(m.left); }); }
function isMember(tripId, uid) { return !!DB.find('Members', function (m) { return m.tripId === tripId && m.userId === uid && !bool(m.left); }); }
function addMember(t, uid, role) {
  var old = DB.find('Members', function (m) { return m.tripId === t.tripId && m.userId === uid; });
  if (old) { old.left = false; old.role = role; DB.save('Members', old); return old; }
  return DB.insert('Members', { tripId: t.tripId, userId: uid, role: role, joinedAt: now(), left: false, lastSeen: now() });
}
function getT(tripId, me, needOwner) {
  var t = DB.find('Trips', function (r) { return r.tripId === tripId; });
  if (!t) fail('找不到這個團', 'notfound');
  if (!isMember(tripId, me.userId)) fail('你不在這個團裡', 'notmember');
  if (needOwner && t.ownerId !== me.userId) fail('只有開團人能做這件事', 'owner');
  return t;
}
function needActive(t) { if (!ACTIVE[t.stage]) fail('這團已經結束了，只能看不能改', 'closed'); }
function ownedActive(uid) { return DB.filter('Trips', function (t) { return t.ownerId === uid && ACTIVE[t.stage]; }); }

API.myTrips = function (b, me) {
  var mine = DB.filter('Members', function (m) { return m.userId === me.userId && !bool(m.left); }).map(function (m) { return m.tripId; });
  var trips = DB.filter('Trips', function (t) { return mine.indexOf(t.tripId) >= 0 && ACTIVE[t.stage]; }).map(function (t) { return tripCard(t, me); });
  var ended = DB.filter('Trips', function (t) { return mine.indexOf(t.tripId) >= 0 && (t.stage === 'archived' || (t.stage === 'cancelled' && t.ownerId === me.userId)); }).length;
  var pendingTransfer = DB.filter('Trips', function (t) { return t.transferTo === me.userId && ACTIVE[t.stage]; }).map(function (t) { return { tripId: t.tripId, title: t.title, from: userName(t.ownerId) }; });
  return { trips: trips, endedCount: ended, owned: ownedActive(me.userId).length, maxOwned: +setting('maxOwnedTrips'), pendingTransfer: pendingTransfer };
};
function tripCard(t, me) {
  var m = DB.find('Members', function (x) { return x.tripId === t.tripId && x.userId === me.userId; });
  var unread = DB.filter('Log', function (l) { return l.tripId === t.tripId && +l.at > +(m && m.lastSeen || 0) && l.userId !== me.userId; }).length;
  return { tripId: t.tripId, title: t.title, startDate: fmtDate(t.startDate), days: +t.days, stage: t.stage, owner: userName(t.ownerId), isOwner: t.ownerId === me.userId,
    count: activeMembers(t.tripId).length, max: +t.maxPeople, unread: unread, cancelledAt: +t.cancelledAt || null };
}
function fmtDate(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd');
  return String(v).slice(0, 10);
}

API.createTrip = function (b, me) {
  if (ownedActive(me.userId).length >= +setting('maxOwnedTrips')) fail('你開的團已經有 ' + setting('maxOwnedTrips') + ' 個在進行中了', 'ownedFull');
  var title = str(b.title, 30, '團名'); if (!title) fail('請填團名');
  var max = Math.min(+b.maxPeople || 6, +setting('maxPeople'));
  if (max < 2) max = 2;
  var t = DB.insert('Trips', {
    tripId: id('t'), title: title, dest: str(b.dest, 40, '目的地'), startDate: str(b.startDate, 10), days: Math.max(1, Math.min(+b.days || 1, 14)),
    mode: str(b.mode, 10) || '開車', maxPeople: max, ownerId: me.userId, stage: 'collect', inviteCode: inviteCode(), rev: 1, createdAt: now(), cancelledAt: '', transferTo: '', updatedAt: now()
  });
  addMember(t, me.userId, 'owner');
  log(t.tripId, me.userId, 'create', me.name + ' 開了這個團');
  if (b.itinerary) {
    // 從「直接出發」升級：直接進入排行程
    saveItin(t, me, b.itinerary, '從個人行程升級');
    t.stage = 'plan';
  }
  return { tripId: t.tripId, inviteCode: t.inviteCode };
};

API.getTrip = function (b, me) {
  var t = getT(b.tripId, me);
  var ms = DB.filter('Members', function (m) { return m.tripId === t.tripId; });
  var active = ms.filter(function (m) { return !bool(m.left); });
  var places = DB.filter('Wishlist', function (p) { return p.tripId === t.tripId && p.status !== 'deleted'; });
  var votes = DB.filter('Votes', function (v) { return v.tripId === t.tripId; });
  var itin = latestItin(t.tripId);
  var versions = DB.filter('Itinerary', function (i) { return i.tripId === t.tripId; }).map(function (i) { return { ver: +i.ver, by: userName(i.by), at: +i.at, note: i.note }; });
  var tasks = DB.filter('Tasks', function (x) { return x.tripId === t.tripId && x.status !== 'deleted'; });
  var exps = DB.filter('Expenses', function (x) { return x.tripId === t.tripId && !bool(x.deleted); });
  var me_m = ms.filter(function (m) { return m.userId === me.userId; })[0];
  var unread = DB.filter('Log', function (l) { return l.tripId === t.tripId && +l.at > +(me_m.lastSeen || 0) && l.userId !== me.userId; }).length;
  var isOwner = t.ownerId === me.userId;
  return {
    trip: { tripId: t.tripId, title: t.title, dest: t.dest, startDate: fmtDate(t.startDate), days: +t.days, mode: t.mode, maxPeople: +t.maxPeople, stage: t.stage, rev: +t.rev,
      ownerId: t.ownerId, owner: userName(t.ownerId), inviteCode: isOwner || ACTIVE[t.stage] ? t.inviteCode : '', cancelledAt: +t.cancelledAt || null,
      transferTo: t.transferTo || '', transferToName: t.transferTo ? userName(t.transferTo) : '' },
    me: { userId: me.userId, name: me.name, isOwner: isOwner },
    members: active.map(function (m) { return { userId: m.userId, name: userName(m.userId), role: m.role }; }),
    allNames: ms.reduce(function (o, m) { o[m.userId] = userName(m.userId); return o; }, {}),
    places: places.map(function (p) {
      var vs = votes.filter(function (v) { return v.placeId === p.placeId; });
      return { placeId: p.placeId, name: p.name, type: p.type, note: p.note, addedBy: p.addedBy, addedByName: userName(p.addedBy), status: p.status, createdAt: +p.createdAt,
        votes: vs.length, myVote: vs.some(function (v) { return v.userId === me.userId; }), voters: vs.map(function (v) { return userName(v.userId); }) };
    }).sort(function (a, b) { return b.votes - a.votes || a.createdAt - b.createdAt; }),
    itinerary: itin ? { ver: +itin.ver, data: jsonParse(itin.json, null), by: userName(itin.by), at: +itin.at } : null,
    versions: versions,
    tasks: tasks.map(function (x) { return { taskId: x.taskId, title: x.title, ownerId: x.ownerId, ownerName: x.ownerId ? userName(x.ownerId) : '', status: x.status, takeoverBy: x.takeoverBy, takeoverName: x.takeoverBy ? userName(x.takeoverBy) : '' }; }),
    expenses: exps.map(function (x) { return { expenseId: x.expenseId, title: x.title, category: x.category, amount: +x.amount, paidBy: x.paidBy, splitMode: x.splitMode, shares: jsonParse(x.shares, {}), stopRef: x.stopRef, createdBy: x.createdBy, createdAt: +x.createdAt }; })
      .sort(function (a, b) { return b.createdAt - a.createdAt; }),
    settle: settleState(t),
    unread: unread,
    ownedCount: ownedActive(me.userId).length, maxOwned: +setting('maxOwnedTrips')
  };
};

API.rev = function (b, me) {
  var t = getT(b.tripId, me);
  return { rev: +t.rev, stage: t.stage };
};

API.editTrip = function (b, me) {
  var t = getT(b.tripId, me, true); needActive(t);
  if (b.title != null) { t.title = str(b.title, 30, '團名') || t.title; }
  if (b.dest != null) t.dest = str(b.dest, 40);
  if (b.startDate != null) t.startDate = str(b.startDate, 10);
  if (b.days != null) t.days = Math.max(1, Math.min(+b.days || 1, 14));
  if (b.mode != null) t.mode = str(b.mode, 10);
  if (b.maxPeople != null) {
    var n = Math.min(+b.maxPeople, +setting('maxPeople'));
    if (n < activeMembers(t.tripId).length) fail('已經有 ' + activeMembers(t.tripId).length + ' 人了，不能改得比這更少');
    t.maxPeople = n;
  }
  log(t.tripId, me.userId, 'edit', me.name + ' 改了團的資料'); bump(t);
  return {};
};

API.regenInvite = function (b, me) {
  var t = getT(b.tripId, me, true); needActive(t);
  t.inviteCode = inviteCode(); bump(t);
  return { inviteCode: t.inviteCode };
};

API.removeMember = function (b, me) {
  var t = getT(b.tripId, me, true); needActive(t);
  if (b.userId === me.userId) fail('不能移除自己');
  var m = DB.find('Members', function (x) { return x.tripId === t.tripId && x.userId === b.userId && !bool(x.left); });
  if (!m) fail('這個人不在團裡');
  m.left = true; DB.save('Members', m);
  releaseTasks(t.tripId, b.userId);
  log(t.tripId, me.userId, 'remove', me.name + ' 把 ' + userName(b.userId) + ' 移出了團'); bump(t);
  return {};
};

API.resetMemberPw = function (b, me) {
  var t = getT(b.tripId, me, true);
  if (!isMember(t.tripId, b.userId)) fail('這個人不在團裡');
  var temp = String(Math.floor(100000 + Math.random() * 900000));
  var sec = DB.find('Secrets', function (r) { return r.userId === b.userId; });
  sec.tempHash = sha(sec.salt + temp); sec.tempExp = now() + 86400000; DB.save('Secrets', sec);
  log(t.tripId, me.userId, 'resetpw', me.name + ' 幫 ' + userName(b.userId) + ' 重設了密碼');
  return { temp: temp, name: userName(b.userId) };
};

API.leaveTrip = function (b, me) {
  var t = getT(b.tripId, me);
  if (t.ownerId === me.userId) fail('開團人不能退出，要先把開團人交給別人，或封存／取消這個團', 'owner');
  var m = DB.find('Members', function (x) { return x.tripId === t.tripId && x.userId === me.userId && !bool(x.left); });
  m.left = true; DB.save('Members', m);
  releaseTasks(t.tripId, me.userId);
  log(t.tripId, me.userId, 'leave', me.name + ' 退出了團'); bump(t);
  return {};
};
function releaseTasks(tripId, uid) {
  DB.filter('Tasks', function (x) { return x.tripId === tripId && x.ownerId === uid && x.status === 'claimed'; })
    .forEach(function (x) { x.ownerId = ''; x.status = 'open'; x.takeoverBy = ''; DB.save('Tasks', x); });
}

API.transferOwner = function (b, me) {
  var t = getT(b.tripId, me, true); needActive(t);
  if (!b.userId) { t.transferTo = ''; bump(t); return {}; }
  if (!isMember(t.tripId, b.userId) || b.userId === me.userId) fail('要交給團裡的其他人');
  if (ownedActive(b.userId).length >= +setting('maxOwnedTrips')) fail(userName(b.userId) + ' 開的團已滿 ' + setting('maxOwnedTrips') + ' 個，不能接');
  t.transferTo = b.userId;
  log(t.tripId, me.userId, 'transfer', me.name + ' 想把開團人交給 ' + userName(b.userId) + '，等對方按「接手」'); bump(t);
  return {};
};
API.answerTransfer = function (b, me) {
  var t = DB.find('Trips', function (r) { return r.tripId === b.tripId; });
  if (!t || t.transferTo !== me.userId) fail('這個交接已經不在了');
  needActive(t);
  if (b.accept) {
    if (ownedActive(me.userId).length >= +setting('maxOwnedTrips')) fail('你開的團已滿 ' + setting('maxOwnedTrips') + ' 個，不能接');
    var oldOwner = t.ownerId;
    var mo = DB.find('Members', function (x) { return x.tripId === t.tripId && x.userId === oldOwner; }); if (mo) { mo.role = 'member'; DB.save('Members', mo); }
    var mn = DB.find('Members', function (x) { return x.tripId === t.tripId && x.userId === me.userId; }); mn.role = 'owner'; DB.save('Members', mn);
    t.ownerId = me.userId; t.transferTo = '';
    log(t.tripId, me.userId, 'transfer', me.name + ' 接手當開團人');
  } else {
    t.transferTo = '';
    log(t.tripId, me.userId, 'transfer', me.name + ' 沒有接手開團人');
  }
  bump(t); return {};
};

API.cancelTrip = function (b, me) {
  var t = getT(b.tripId, me, true); needActive(t);
  if (DB.find('Expenses', function (x) { return x.tripId === t.tripId && !bool(x.deleted); })) fail('這團已經記過帳，不能取消。要先結清，再封存。', 'hasExpense');
  if (str(b.confirm) !== t.title) fail('輸入的團名不一樣');
  t.stage = 'cancelled'; t.cancelledAt = now(); t.transferTo = '';
  log(t.tripId, me.userId, 'cancel', me.name + ' 取消了「' + t.title + '」'); bump(t);
  return {};
};
API.restoreTrip = function (b, me) {
  var t = DB.find('Trips', function (r) { return r.tripId === b.tripId; });
  if (!t || t.ownerId !== me.userId || t.stage !== 'cancelled') fail('找不到可以還原的團');
  if (now() - +t.cancelledAt > setting('restoreDays') * 86400000) fail('已經超過 30 天，救不回來了');
  if (ownedActive(me.userId).length >= +setting('maxOwnedTrips')) fail('你開的團已滿 ' + setting('maxOwnedTrips') + ' 個，要先結束一個才能還原', 'ownedFull');
  t.stage = latestItin(t.tripId) ? 'plan' : 'collect'; t.cancelledAt = '';
  log(t.tripId, me.userId, 'restore', me.name + ' 還原了這個團'); bump(t);
  return { stage: t.stage };
};
API.archiveTrip = function (b, me) {
  var t = getT(b.tripId, me, true); needActive(t);
  var st = settleState(t);
  if (st.transfers.some(function (x) { return x.status !== 'confirmed'; })) fail('還有 ' + st.transfers.filter(function (x) { return x.status !== 'confirmed'; }).length + ' 筆帳沒結清，要先結清才能封存', 'unsettled');
  t.stage = 'archived'; t.transferTo = '';
  log(t.tripId, me.userId, 'archive', me.name + ' 封存了這個團'); bump(t);
  return {};
};
API.ended = function (b, me) {
  var mine = DB.filter('Members', function (m) { return m.userId === me.userId; }).map(function (m) { return m.tripId; });
  var list = DB.filter('Trips', function (t) {
    if (mine.indexOf(t.tripId) < 0) return false;
    if (t.stage === 'archived') return true;
    return t.stage === 'cancelled' && t.ownerId === me.userId && now() - +t.cancelledAt < setting('restoreDays') * 86400000;
  });
  return { trips: list.map(function (t) { var c = tripCard(t, me); c.daysLeft = t.stage === 'cancelled' ? Math.ceil((setting('restoreDays') * 86400000 - (now() - +t.cancelledAt)) / 86400000) : null; return c; }) };
};

/* ============ 想去的點 ============ */
var TYPES = { '吃': 1, '喝': 1, '玩': 1, '住': 1 };
API.addPlace = function (b, me) {
  var t = getT(b.tripId, me); needActive(t);
  var name = str(b.name, 40, '名字'); if (!name) fail('請填想去的地方');
  var type = TYPES[b.type] ? b.type : '玩';
  var dup = DB.find('Wishlist', function (p) { return p.tripId === t.tripId && p.status !== 'deleted' && nameKey(p.name) === nameKey(name); });
  if (dup) fail('「' + dup.name + '」已經在清單裡了，幫它按讚就好', 'dup');
  var status = t.stage === 'collect' ? 'active' : 'backlog';
  var p = DB.insert('Wishlist', { placeId: id('p'), tripId: t.tripId, name: name, type: type, note: str(b.note, 100, '備註'), addedBy: me.userId, createdAt: now(), status: status });
  DB.insert('Votes', { tripId: t.tripId, placeId: p.placeId, userId: me.userId });
  log(t.tripId, me.userId, 'place', me.name + ' 加了「' + name + '」' + (status === 'backlog' ? '（進候補）' : '')); bump(t);
  return { placeId: p.placeId, status: status };
};
API.editPlace = function (b, me) {
  var p = DB.find('Wishlist', function (x) { return x.placeId === b.placeId; }); if (!p) fail('找不到這個點');
  var t = getT(p.tripId, me); needActive(t);
  if (p.addedBy !== me.userId && t.ownerId !== me.userId) fail('只有加的人和開團人能改');
  if (b.name != null) { var n = str(b.name, 40, '名字'); if (n) p.name = n; }
  if (b.type != null && TYPES[b.type]) p.type = b.type;
  if (b.note != null) p.note = str(b.note, 100, '備註');
  DB.save('Wishlist', p); log(t.tripId, me.userId, 'place', me.name + ' 改了「' + p.name + '」'); bump(t);
  return {};
};
API.delPlace = function (b, me) {
  var p = DB.find('Wishlist', function (x) { return x.placeId === b.placeId; }); if (!p) fail('找不到這個點');
  var t = getT(p.tripId, me); needActive(t);
  if (p.addedBy !== me.userId && t.ownerId !== me.userId) fail('只有加的人和開團人能刪');
  p.status = 'deleted'; DB.save('Wishlist', p); log(t.tripId, me.userId, 'place', me.name + ' 刪了「' + p.name + '」'); bump(t);
  return {};
};
API.vote = function (b, me) {
  var p = DB.find('Wishlist', function (x) { return x.placeId === b.placeId && x.status !== 'deleted'; }); if (!p) fail('找不到這個點');
  var t = getT(p.tripId, me); needActive(t);
  var v = DB.find('Votes', function (x) { return x.placeId === p.placeId && x.userId === me.userId; });
  if (v) { v.placeId = 'x-' + v.placeId; v.userId = 'x-' + v.userId; DB.save('Votes', v); }  // 取消讚（留列不刪，免得列號錯亂）
  else DB.insert('Votes', { tripId: t.tripId, placeId: p.placeId, userId: me.userId });
  bump(t);
  return { voted: !v };
};

/* ============ 行程 ============ */
function latestItin(tripId) {
  var list = DB.filter('Itinerary', function (i) { return i.tripId === tripId; });
  if (!list.length) return null;
  return list.reduce(function (a, b) { return +b.ver > +a.ver ? b : a; });
}
function saveItin(t, me, data, note) {
  var json = typeof data === 'string' ? data : JSON.stringify(data);
  if (json.length > 45000) fail('行程太長了，存不進去（請 AI 精簡 note 或備選）');
  var parsed = jsonParse(json, null);
  if (!parsed || !parsed.days || !parsed.days.length) fail('行程格式不對');
  var cur = latestItin(t.tripId);
  var ver = cur ? +cur.ver + 1 : 1;
  DB.insert('Itinerary', { tripId: t.tripId, ver: ver, json: json, by: me.userId, at: now(), note: str(note, 60) });
  return ver;
}
API.endCollect = function (b, me) {
  var t = getT(b.tripId, me, true); needActive(t);
  if (t.stage !== 'collect') fail('已經不在收集中了');
  var picks = b.picks || [];
  DB.filter('Wishlist', function (p) { return p.tripId === t.tripId && p.status === 'active'; }).forEach(function (p) {
    p.status = picks.indexOf(p.placeId) >= 0 ? 'picked' : 'backlog'; DB.save('Wishlist', p);
  });
  t.stage = 'plan';
  log(t.tripId, me.userId, 'stage', me.name + ' 結束收集，挑了 ' + picks.length + ' 個點，正在請 AI 排行程'); bump(t);
  return {};
};
API.reopenCollect = function (b, me) {
  var t = getT(b.tripId, me, true); needActive(t);
  if (t.stage !== 'plan' || latestItin(t.tripId)) fail('已經有行程了，不能回到收集');
  DB.filter('Wishlist', function (p) { return p.tripId === t.tripId && (p.status === 'picked' || p.status === 'backlog'); }).forEach(function (p) { p.status = 'active'; DB.save('Wishlist', p); });
  t.stage = 'collect'; log(t.tripId, me.userId, 'stage', me.name + ' 重新開放收集'); bump(t);
  return {};
};
API.saveItinerary = function (b, me) {
  var t = getT(b.tripId, me, true); needActive(t);
  if (b.baseVer != null) { var cur = latestItin(t.tripId); if (cur && +cur.ver !== +b.baseVer) fail('行程剛被改過（第 ' + cur.ver + ' 版），請重新整理再改', 'conflict'); }
  var ver = saveItin(t, me, b.data, b.note || '');
  if (t.stage === 'collect') t.stage = 'plan';
  log(t.tripId, me.userId, 'itin', me.name + ' 更新了行程（第 ' + ver + ' 版' + (b.note ? '：' + str(b.note, 60) : '') + '）'); bump(t);
  return { ver: ver };
};
API.restoreVersion = function (b, me) {
  var t = getT(b.tripId, me, true); needActive(t);
  var v = DB.find('Itinerary', function (i) { return i.tripId === t.tripId && +i.ver === +b.ver; }); if (!v) fail('找不到這一版');
  var ver = saveItin(t, me, v.json, '還原成第 ' + b.ver + ' 版');
  log(t.tripId, me.userId, 'itin', me.name + ' 把行程還原成第 ' + b.ver + ' 版'); bump(t);
  return { ver: ver };
};
API.scheduleBacklog = function (b, me) {
  var t = getT(b.tripId, me, true); needActive(t);
  var p = DB.find('Wishlist', function (x) { return x.placeId === b.placeId && x.tripId === t.tripId; }); if (!p) fail('找不到這個點');
  var cur = latestItin(t.tripId); if (!cur) fail('還沒有行程，先貼回 AI 排的行程');
  var data = jsonParse(cur.json, null); var d = data.days[+b.day]; if (!d) fail('沒有這一天');
  var time = /^\d{1,2}:\d{2}$/.test(b.time || '') ? b.time : '10:00';
  d.stops.push({ time: time, name: p.name, area: '', type: p.type, meal: null, stay_min: 60, note: p.note || '候補排進來的', open_status: 'unknown', hours: '', parking: null, legs: [], alternatives: [], placeId: p.placeId });
  d.stops.sort(function (a, c) { return a.time < c.time ? -1 : a.time > c.time ? 1 : 0; });
  var ver = saveItin(t, me, data, '排入「' + p.name + '」');
  p.status = 'picked'; DB.save('Wishlist', p);
  log(t.tripId, me.userId, 'itin', me.name + ' 把「' + p.name + '」排進第 ' + (+b.day + 1) + ' 天 ' + time); bump(t);
  return { ver: ver };
};
API.finalize = function (b, me) {
  var t = getT(b.tripId, me, true); needActive(t);
  if (!latestItin(t.tripId)) fail('還沒有行程，不能定案');
  t.stage = b.undo ? 'plan' : 'final';
  log(t.tripId, me.userId, 'stage', me.name + (b.undo ? ' 取消定案，行程可以再改' : ' 把行程定案了，大家可以認領分工')); bump(t);
  return {};
};

/* ============ 分工 ============ */
function getTask(b, me) { var x = DB.find('Tasks', function (r) { return r.taskId === b.taskId && r.status !== 'deleted'; }); if (!x) fail('找不到這件事'); var t = getT(x.tripId, me); needActive(t); return { x: x, t: t }; }
API.addTask = function (b, me) {
  var t = getT(b.tripId, me); needActive(t);
  var title = str(b.title, 40, '事情'); if (!title) fail('請填要做的事');
  var x = DB.insert('Tasks', { taskId: id('k'), tripId: t.tripId, title: title, ownerId: b.claim ? me.userId : '', status: b.claim ? 'claimed' : 'open', takeoverBy: '', createdAt: now(), createdBy: me.userId });
  log(t.tripId, me.userId, 'task', me.name + ' 加了一件事「' + title + '」'); bump(t);
  return { taskId: x.taskId };
};
API.claimTask = function (b, me) {
  var r = getTask(b, me); if (r.x.status !== 'open') fail('這件事已經有人認領了');
  r.x.ownerId = me.userId; r.x.status = 'claimed'; r.x.takeoverBy = ''; DB.save('Tasks', r.x);
  log(r.t.tripId, me.userId, 'task', me.name + ' 認領了「' + r.x.title + '」'); bump(r.t); return {};
};
API.giveUpTask = function (b, me) {
  var r = getTask(b, me); if (r.x.ownerId !== me.userId) fail('這不是你的');
  r.x.ownerId = ''; r.x.status = 'open'; r.x.takeoverBy = ''; DB.save('Tasks', r.x);
  log(r.t.tripId, me.userId, 'task', me.name + ' 放棄了「' + r.x.title + '」，需要有人接'); bump(r.t); return {};
};
API.requestTask = function (b, me) {
  var r = getTask(b, me); if (r.x.status !== 'claimed' || r.x.ownerId === me.userId) fail('不需要接手');
  r.x.takeoverBy = me.userId; DB.save('Tasks', r.x);
  log(r.t.tripId, me.userId, 'task', me.name + ' 想接手「' + r.x.title + '」，等 ' + userName(r.x.ownerId) + ' 同意'); bump(r.t); return {};
};
API.answerTakeover = function (b, me) {
  var r = getTask(b, me);
  if (r.x.ownerId !== me.userId && r.t.ownerId !== me.userId) fail('只有負責的人或開團人能決定');
  if (!r.x.takeoverBy) fail('沒有人要接手');
  var who = r.x.takeoverBy;
  if (b.accept) { r.x.ownerId = who; log(r.t.tripId, me.userId, 'task', userName(who) + ' 接手了「' + r.x.title + '」'); }
  else log(r.t.tripId, me.userId, 'task', me.name + ' 沒有交出「' + r.x.title + '」');
  r.x.takeoverBy = ''; DB.save('Tasks', r.x); bump(r.t); return {};
};
API.assignTask = function (b, me) {
  var r = getTask(b, me); if (r.t.ownerId !== me.userId) fail('只有開團人能指派');
  if (b.userId && !isMember(r.t.tripId, b.userId)) fail('這個人不在團裡');
  r.x.ownerId = b.userId || ''; r.x.status = b.userId ? (r.x.status === 'done' ? 'done' : 'claimed') : 'open'; r.x.takeoverBy = ''; DB.save('Tasks', r.x);
  log(r.t.tripId, me.userId, 'task', b.userId ? me.name + ' 把「' + r.x.title + '」指派給 ' + userName(b.userId) : me.name + ' 把「' + r.x.title + '」改回沒人認領'); bump(r.t); return {};
};
API.doneTask = function (b, me) {
  var r = getTask(b, me); if (r.x.ownerId !== me.userId && r.t.ownerId !== me.userId) fail('只有負責的人能打勾');
  r.x.status = b.undo ? 'claimed' : 'done'; DB.save('Tasks', r.x);
  log(r.t.tripId, me.userId, 'task', me.name + (b.undo ? ' 把「' + r.x.title + '」改回還沒好' : ' 辦好了「' + r.x.title + '」')); bump(r.t); return {};
};
API.delTask = function (b, me) {
  var r = getTask(b, me); if (r.x.createdBy !== me.userId && r.t.ownerId !== me.userId) fail('只有加的人和開團人能刪');
  r.x.status = 'deleted'; DB.save('Tasks', r.x); log(r.t.tripId, me.userId, 'task', me.name + ' 刪了「' + r.x.title + '」'); bump(r.t); return {};
};

/* ============ 分帳 ============ */
/**
 * 算法：
 * 每筆只算「有份的人」。平分時每人 floor(金額/人數)，零頭由付錢的人吸收。
 * 每人差額 = 已付 − 該付，全部加起來 = 0。
 * 差額正的等收錢、負的要付錢，用最少筆數兩兩配對。
 */
function computeSettle(memberIds, expenses) {
  var paid = {}, owed = {};
  function add(o, k, v) { o[k] = (o[k] || 0) + v; }
  expenses.forEach(function (x) {
    var amt = Math.round(+x.amount);
    add(paid, x.paidBy, amt);
    var sh = typeof x.shares === 'string' ? jsonParse(x.shares, {}) : (x.shares || {});
    var ids = Object.keys(sh);
    if (!ids.length) return;
    if (x.splitMode === 'custom') {
      var sum = 0; ids.forEach(function (u) { var v = Math.round(+sh[u] || 0); add(owed, u, v); sum += v; });
      if (sum !== amt) add(owed, x.paidBy, amt - sum);  // 對不齊的差額也由付錢的人吸收
    } else {
      var base = Math.floor(amt / ids.length);
      ids.forEach(function (u) { add(owed, u, base); });
      add(owed, x.paidBy, amt - base * ids.length);  // 零頭
    }
  });
  var ids = {}; memberIds.concat(Object.keys(paid), Object.keys(owed)).forEach(function (u) { ids[u] = 1; });
  var rows = Object.keys(ids).map(function (u) { return { userId: u, paid: paid[u] || 0, owed: owed[u] || 0, diff: (paid[u] || 0) - (owed[u] || 0) }; });
  var cred = rows.filter(function (r) { return r.diff > 0; }).map(function (r) { return { u: r.userId, v: r.diff }; }).sort(function (a, b) { return b.v - a.v; });
  var debt = rows.filter(function (r) { return r.diff < 0; }).map(function (r) { return { u: r.userId, v: -r.diff }; }).sort(function (a, b) { return b.v - a.v; });
  var transfers = []; var i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    var v = Math.min(debt[i].v, cred[j].v);
    if (v > 0) transfers.push({ from: debt[i].u, to: cred[j].u, amount: v });
    debt[i].v -= v; cred[j].v -= v;
    if (debt[i].v === 0) i++;
    if (cred[j].v === 0) j++;
  }
  return { rows: rows, transfers: transfers, total: expenses.reduce(function (s, x) { return s + Math.round(+x.amount); }, 0) };
}
function settleState(t) {
  var exps = DB.filter('Expenses', function (x) { return x.tripId === t.tripId && !bool(x.deleted); });
  var mem = activeMembers(t.tripId).map(function (m) { return m.userId; });
  var r = computeSettle(mem, exps);
  var recs = DB.filter('Settlements', function (s) { return s.tripId === t.tripId; });
  r.transfers.forEach(function (x) {
    var rec = recs.filter(function (s) { return s.fromId === x.from && s.toId === x.to && +s.amount === x.amount; })[0];
    x.status = rec ? rec.status : 'pending';
    x.fromName = userName(x.from); x.toName = userName(x.to);
  });
  r.rows.forEach(function (x) { x.name = userName(x.userId); });
  return r;
}
function checkExpense(t, b) {
  var amt = Math.round(+b.amount);
  if (!(amt > 0) || amt > 10000000) fail('金額要是大於 0 的數字');
  if (!isMember(t.tripId, b.paidBy)) fail('付錢的人要是團裡的人');
  var sh = b.shares || {}; var ids = Object.keys(sh);
  if (!ids.length) fail('至少要有一個人有份');
  ids.forEach(function (u) { if (!isMember(t.tripId, u)) fail('有份的人要是團裡的人'); });
  if (b.splitMode === 'custom') {
    var sum = ids.reduce(function (s, u) { return s + Math.round(+sh[u] || 0); }, 0);
    if (sum !== amt) fail('每個人的金額加起來是 ' + sum + '，跟總額 ' + amt + ' 不一樣');
  }
  return amt;
}
API.addExpense = function (b, me) {
  var t = getT(b.tripId, me); needActive(t);
  var amt = checkExpense(t, b);
  var title = str(b.title, 40, '項目') || '花費';
  DB.insert('Expenses', { expenseId: id('e'), tripId: t.tripId, title: title, category: str(b.category, 10), amount: amt, paidBy: b.paidBy, splitMode: b.splitMode === 'custom' ? 'custom' : 'equal',
    shares: JSON.stringify(b.shares), stopRef: str(b.stopRef, 60), createdBy: me.userId, createdAt: now(), deleted: false });
  log(t.tripId, me.userId, 'expense', me.name + ' 記了一筆「' + title + '」NT$' + amt + '（' + userName(b.paidBy) + ' 付，' + Object.keys(b.shares).length + ' 人有份）'); bump(t);
  return {};
};
API.editExpense = function (b, me) {
  var x = DB.find('Expenses', function (r) { return r.expenseId === b.expenseId && !bool(r.deleted); }); if (!x) fail('找不到這筆');
  var t = getT(x.tripId, me); needActive(t);
  if (x.createdBy !== me.userId && t.ownerId !== me.userId) fail('只有記的人和開團人能改');
  var amt = checkExpense(t, b);
  x.title = str(b.title, 40, '項目') || x.title; x.category = str(b.category, 10); x.amount = amt; x.paidBy = b.paidBy; x.splitMode = b.splitMode === 'custom' ? 'custom' : 'equal'; x.shares = JSON.stringify(b.shares);
  DB.save('Expenses', x); log(t.tripId, me.userId, 'expense', me.name + ' 改了「' + x.title + '」'); bump(t);
  return {};
};
API.delExpense = function (b, me) {
  var x = DB.find('Expenses', function (r) { return r.expenseId === b.expenseId && !bool(r.deleted); }); if (!x) fail('找不到這筆');
  var t = getT(x.tripId, me); needActive(t);
  if (x.createdBy !== me.userId && t.ownerId !== me.userId) fail('只有記的人和開團人能刪');
  x.deleted = true; DB.save('Expenses', x); log(t.tripId, me.userId, 'expense', me.name + ' 刪了「' + x.title + '」'); bump(t);
  return {};
};
function setSettle(t, from, to, amount, status) {
  var rec = DB.find('Settlements', function (s) { return s.tripId === t.tripId && s.fromId === from && s.toId === to; });
  if (rec) { rec.amount = amount; rec.status = status; rec.updatedAt = now(); DB.save('Settlements', rec); }
  else DB.insert('Settlements', { tripId: t.tripId, fromId: from, toId: to, amount: amount, status: status, updatedAt: now() });
}
API.markPaid = function (b, me) {
  var t = getT(b.tripId, me); needActive(t);
  var x = settleState(t).transfers.filter(function (s) { return s.from === b.from && s.to === b.to; })[0];
  if (!x) fail('這筆帳已經變了，請重新整理');
  if (x.from !== me.userId && t.ownerId !== me.userId) fail('只有要付錢的人能按');
  setSettle(t, x.from, x.to, x.amount, b.undo ? 'pending' : 'paid');
  log(t.tripId, me.userId, 'settle', b.undo ? me.name + ' 取消了付款標記' : userName(x.from) + ' 說已經付 ' + userName(x.to) + ' NT$' + x.amount + '，等對方確認'); bump(t);
  return {};
};
API.confirmPaid = function (b, me) {
  var t = getT(b.tripId, me); needActive(t);
  var x = settleState(t).transfers.filter(function (s) { return s.from === b.from && s.to === b.to; })[0];
  if (!x) fail('這筆帳已經變了，請重新整理');
  if (x.to !== me.userId && t.ownerId !== me.userId) fail('只有收錢的人能確認');
  setSettle(t, x.from, x.to, x.amount, b.reject ? 'pending' : 'confirmed');
  log(t.tripId, me.userId, 'settle', b.reject ? userName(x.to) + ' 說還沒收到 ' + userName(x.from) + ' 的錢' : userName(x.to) + ' 確認收到 ' + userName(x.from) + ' NT$' + x.amount); bump(t);
  return {};
};

/* ============ 動態 ============ */
API.updates = function (b, me) {
  var t = getT(b.tripId, me);
  var m = DB.find('Members', function (x) { return x.tripId === t.tripId && x.userId === me.userId; });
  var seen = +m.lastSeen || 0;
  var list = DB.filter('Log', function (l) { return l.tripId === t.tripId; }).sort(function (a, c) { return c.at - a.at; }).slice(0, 80)
    .map(function (l) { return { at: +l.at, text: l.text, mine: l.userId === me.userId, isNew: +l.at > seen && l.userId !== me.userId, action: l.action }; });
  return { list: list };
};
API.markSeen = function (b, me) {
  var m = DB.find('Members', function (x) { return x.tripId === b.tripId && x.userId === me.userId; });
  if (m) { m.lastSeen = now(); DB.save('Members', m); }
  return {};
};

/* ============ 安裝、備份、清理 ============ */
function setup() {
  Object.keys(SCHEMA).forEach(function (n) {
    var ss = SpreadsheetApp.getActiveSpreadsheet(); var sh = ss.getSheetByName(n);
    if (!sh) { sh = ss.insertSheet(n); sh.getRange(1, 1, 1, SCHEMA[n].length).setValues([SCHEMA[n]]); sh.setFrozenRows(1); }
  });
  DB.reset();
  Object.keys(DEFAULTS).forEach(function (k) {
    if (!DB.find('Settings', function (r) { return r.key === k; })) DB.insert('Settings', { key: k, value: DEFAULTS[k] });
  });
  var bc = DB.find('Settings', function (r) { return r.key === 'bootstrapCode'; });
  var code;
  if (!DB.all('Users').length) {
    code = 'admin' + inviteCode();
    if (bc) { bc.value = code; DB.save('Settings', bc); } else DB.insert('Settings', { key: 'bootstrapCode', value: code });
  }
  DB.flush();
  var s1 = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('工作表1') || SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sheet1');
  if (s1 && s1.getLastRow() === 0) SpreadsheetApp.getActiveSpreadsheet().deleteSheet(s1);
  if (code) Logger.log('第一個帳號的邀請碼：' + code + '\n部署後打開：你的網站網址#join/' + code);
  else Logger.log('資料表都在了。已經有帳號，不再產生第一個帳號的邀請碼。');
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (tr) { if (tr.getHandlerFunction() === 'weekly') ScriptApp.deleteTrigger(tr); });
  ScriptApp.newTrigger('weekly').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(3).inTimezone('Asia/Taipei').create();
  Logger.log('每週一 03:00 備份已開啟');
}

function weekly() {
  try { backup(); } catch (e) {
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(), '【出發吧】每週備份失敗', '錯誤：' + (e && e.stack || e));
  }
  try { purge(); } catch (e) {}
}

function backup() {
  var file = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId());
  var it = DriveApp.getFoldersByName('出發吧-備份');
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder('出發吧-備份');
  file.makeCopy('出發吧備份 ' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd'), folder);
  var files = []; var fi = folder.getFiles(); while (fi.hasNext()) files.push(fi.next());
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  files.slice(+DEFAULTS.backupKeep).forEach(function (f) { f.setTrashed(true); });
}

function purge() {
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    DB.reset();
    var cut = now() - DEFAULTS.restoreDays * 86400000;
    var gone = DB.filter('Trips', function (t) { return t.stage === 'cancelled' && +t.cancelledAt < cut; }).map(function (t) { return t.tripId; });
    if (gone.length) {
      ['Members', 'Wishlist', 'Votes', 'Itinerary', 'Tasks', 'Expenses', 'Settlements', 'Log'].forEach(function (n) { DB.remove(n, function (r) { return gone.indexOf(r.tripId) >= 0; }); });
      DB.remove('Trips', function (r) { return gone.indexOf(r.tripId) >= 0; });
    }
    DB.remove('Sessions', function (s) { return +s.exp < now(); });
    DB.remove('Votes', function (v) { return String(v.userId).indexOf('x-') === 0; });
  } finally { lock.releaseLock(); }
}

/* Node 測試用 */
if (typeof module !== 'undefined') module.exports = { handle: handle, computeSettle: computeSettle, doPost: doPost, setup: setup, purge: purge, DB: DB, API: API };
