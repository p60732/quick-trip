/* 說走就走－出發吧：揪團（要登入、資料在雲端） */
'use strict';

/* ================= API ================= */
const session = () => LS.get('session', null);
const loggedIn = () => !!(session() && session().token);
let net = { state: 'ok', last: 0 };
async function api(action, data = {}, opts = {}) {
  if (!API_URL) throw Object.assign(new Error('還沒接上雲端（開發者要先設定 API_URL）'), { code: 'noapi' });
  const s = session();
  const body = JSON.stringify({ action, token: s && s.token, standalone: isStandalone(), ...data });
  let res;
  try {
    res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body, redirect: 'follow' });
  } catch (e) {
    net.state = 'offline'; updateSync();
    throw Object.assign(new Error('連不上網路，等一下再試'), { code: 'offline' });
  }
  let j;
  try { j = await res.json(); } catch (e) { throw Object.assign(new Error('伺服器回應看不懂，等一下再試'), { code: 'server' }); }
  net.state = 'ok'; net.last = Date.now();
  if (!j.ok) {
    if (j.code === 'auth' && !opts.noAuthRedirect) {
      LS.del('session');
      toast(j.error);
      go('login');
    }
    throw Object.assign(new Error(j.error), { code: j.code, extra: j.extra });
  }
  return j.data;
}
async function run(btn, fn) {
  // 按鈕按下去：鎖住、顯示處理中、出錯跳訊息
  if (btn && btn.dataset.busy) return;
  const label = btn ? btn.innerHTML : '';
  if (btn) { btn.dataset.busy = '1'; btn.setAttribute('aria-busy', 'true'); btn.style.opacity = '.6'; }
  try { return await fn(); }
  catch (e) { if (e.code !== 'auth' && e.code !== 'nameTaken') toast(e.message); throw e; }
  finally { if (btn && btn.isConnected) { delete btn.dataset.busy; btn.removeAttribute('aria-busy'); btn.style.opacity = ''; btn.innerHTML = label; } }
}
const quiet = p => p.catch(() => {});

/* ================= 團資料快取 ================= */
const GC = {};          // tripId -> getTrip 資料
function cacheTrip(id, d) { GC[id] = d; try { LS.set('gcache.' + id, d); } catch (e) {} }
function cachedTrip(id) { return GC[id] || LS.get('gcache.' + id, null); }
async function loadTrip(id, force) {
  if (!force && GC[id]) return GC[id];
  const d = await api('getTrip', { tripId: id });
  cacheTrip(id, d); loadedAt[id] = Date.now(); return d;
}

/* 輪詢：15 秒問一次 rev，有變才重抓 */
let pollTimer = null, pollTrip = null, staleNotice = false;
function startPoll(id) {
  pollTrip = id;
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (!pollTrip || document.hidden) return;
    const cur = GC[pollTrip]; if (!cur) return;
    try {
      const r = await api('rev', { tripId: pollTrip }, { noAuthRedirect: true });
      if (r.rev !== cur.trip.rev) {
        const d = await api('getTrip', { tripId: pollTrip }, { noAuthRedirect: true });
        cacheTrip(pollTrip, d);
        if (isBusy()) { staleNotice = true; showStale(); } else render();
      } else updateSync();
    } catch (e) { updateSync(); }
  }, 15000);
}
function stopPoll() { pollTrip = null; }
function isBusy() { const a = document.activeElement; return $('#layer').innerHTML || (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)); }
function showStale() {
  const el = $('#syncLine'); if (!el) return;
  el.innerHTML = `<button class="link" style="min-height:28px;font-size:12px;padding:0;justify-content:flex-start;color:var(--blue)" data-act="refresh">有新的變動，點這裡更新</button>`;
}
ACT.refresh = () => { staleNotice = false; render(); };
function syncText() {
  const s = session();
  if (net.state === 'offline') return `<span style="width:7px;height:7px;border-radius:4px;background:var(--amber2)"></span><span style="color:var(--amber2)">沒有網路，顯示上次的內容</span>`;
  return `<span style="width:7px;height:7px;border-radius:4px;background:var(--ok)"></span>已同步 · ${esc(s ? s.user.name : '')}`;
}
function updateSync() { const el = $('#syncLine'); if (el && !staleNotice) el.innerHTML = syncText(); }
document.addEventListener('visibilitychange', () => { if (!document.hidden && pollTrip && GC[pollTrip]) quiet(loadTrip(pollTrip, true).then(() => { if (!isBusy()) render(); })); });

/* 路由切換：離開團頁就停止輪詢 */
window.addEventListener('hashchange', () => { if (!/^#(g|gowner|gpick|gprompt|gpaste|settle|addexp|updates)\//.test(location.hash)) stopPoll(); });

/* 非同步畫面：先畫「載入中」，資料到了再畫 */
const loadedAt = {};
function asyncView(key, loader, view) {
  const cached = key && cachedTrip(key);
  if (cached && GC[key]) {
    // 先用手上的資料畫，背景再問一次雲端；有變才重畫
    if (Date.now() - (loadedAt[key] || 0) > 3000) {
      loadedAt[key] = Date.now();
      const rev = GC[key].trip.rev;
      quiet(loader().then(() => { if (GC[key] && GC[key].trip.rev !== rev && location.hash.includes(key) && !isBusy()) render(); }));
    }
    return view(cached);
  }
  quiet(loader().then(() => { if (!key || location.hash.includes(key)) render(); }).catch(e => {
    if (e.code === 'auth') return;
    if (cached) { GC[key] = cached; render(); return; }
    $('#app').innerHTML = header('打不開', 'mytrips') + `<div class="pad stack"><div class="note terra">${esc(e.message)}</div><button class="btn" data-act="reload">再試一次</button><button class="link" data-go="mytrips">回我的行程</button></div>`;
  }));
  if (cached) { GC[key] = cached; return view(cached); }
  return header('載入中…', 'mytrips') + `<div class="pad"><div class="note blue" role="status">正在從雲端拿資料…</div></div>`;
}
ACT.reload = () => location.reload();

/* ================= 分享連結（LINE 自動跳 Safari） ================= */
function inviteUrl(code) { return location.origin + location.pathname + '?openExternalBrowser=1#join/' + code; }
function tripUrl(id) { return location.origin + location.pathname + '?openExternalBrowser=1#g/' + id; }
(function inAppRedirect() {
  if (/Line\//i.test(navigator.userAgent) && !/openExternalBrowser=1/.test(location.search)) {
    const u = new URL(location.href); u.searchParams.set('openExternalBrowser', '1'); location.replace(u.toString());
  }
})();
routes.openinsafari = () => header('用 Safari 打開', 'home') + `<div class="pad stack">
  <div class="note amber"><b>你現在是在 ${/FBAN|FBAV/i.test(navigator.userAgent) ? 'Facebook' : /Instagram/i.test(navigator.userAgent) ? 'Instagram' : 'App'} 裡面開的</b><br>在這裡登入，下次從別的地方打開會以為資料不見。請改用 Safari：</div>
  <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:10px">
    <span>1　點右上角或右下角的「⋯」</span><span>2　選「在瀏覽器中開啟」或「用 Safari 開啟」</span><span>3　打開後照畫面加到主畫面，之後都從圖示開</span>
  </div>
  <button class="btn" data-act="copyHere">找不到？複製連結，自己貼到 Safari</button>
  <button class="link" data-act="ignoreInApp">先在這裡看就好</button>
</div>`;
ACT.copyHere = async () => { const ok = await copyText(location.href.replace('#openinsafari', '')); toast(ok ? '連結已複製，打開 Safari 貼上' : '複製失敗'); };
ACT.ignoreInApp = () => { sessionStorage.setItem('lg.ignoreInApp', '1'); history.back(); };

/* ================= 登入、加入 ================= */
routes.login = () => {
  const code = sessionStorage.getItem('lg.pendingCode') || '';
  return header('登入', code ? 'join/' + enc(code) : 'home') + `<div class="pad stack" style="gap:18px">
    <div class="sub">揪團要登入；路過找吃和直接出發不用。</div>
    ${code ? '<div class="note blue">登入後會直接加進剛剛那一團。</div>' : ''}
    <div class="field"><label class="lbl" for="lgName">名字</label><input id="lgName" class="inp" autocomplete="username" placeholder="加入團時設的名字"></div>
    <div class="field"><label class="lbl" for="lgPw">密碼</label><input id="lgPw" class="inp" type="password" autocomplete="current-password"></div>
    <div class="hint">忘記密碼？請開團人在「開團人工具 › 成員」幫你重設，會拿到 6 位數臨時密碼，24 小時內有效。</div>
  </div>
  <div class="foot"><button class="btn" data-act="doLogin">登入</button>
    <div class="hint" style="text-align:center">第一次用？點旅伴給的邀請連結加入</div>
    <button class="link" data-go="nologin">沒有帳號、想自己開團？</button></div>`;
};
ACT.doLogin = el => run(el, async () => {
  const name = $('#lgName').value.trim(), password = $('#lgPw').value;
  if (!name || !password) { toast('名字和密碼都要填'); return; }
  const code = sessionStorage.getItem('lg.pendingCode') || '';
  const r = await api('login', { name, password, code });
  LS.set('session', { token: r.token, user: r.user });
  sessionStorage.removeItem('lg.pendingCode');
  if (r.mustChangePw) { go('account/pw'); toast('你用的是臨時密碼，請設一組新的'); return; }
  if (r.safariButInstalled && isIOS) { sessionStorage.setItem('lg.safariWarn', '1'); }
  const after = sessionStorage.getItem('lg.afterLogin'); sessionStorage.removeItem('lg.afterLogin');
  myTripsData = null;
  go(r.tripId ? 'g/' + r.tripId : (after || 'mytrips'));
});
routes.nologin = () => header('建立新團', 'login') + `<div class="pad stack">
  <div class="note amber"><b style="font-size:17px">開團要先有帳號</b><br>帳號只能從旅伴的邀請連結建立。加入過任何一團的人，之後都能自己開團。</div>
  <h2 class="sec">還沒有帳號的話</h2>
  <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:12px;line-height:1.6">
    <span><b>1 請已經在用的朋友傳邀請連結</b><br><span class="sub">他開一個團，或把你加進他現有的團都可以。</span></span>
    <span><b>2 點連結、設名字和密碼</b><br><span class="sub">加入那一團的同時，你的帳號就建好了。</span></span>
    <span><b>3 回來按「建立新團」</b><br><span class="sub">之後你就能自己開團，一次最多 3 個進行中。</span></span>
  </div>
  <div class="note blue">不想揪團也沒關係：首頁的「路過找吃」和「直接出發」不用帳號就能用。</div>
</div>
<div class="foot"><button class="btn" data-go="login">我有帳號，去登入</button><button class="link" data-go="home">回首頁</button></div>`;

let joinInfo = null;
routes.join = (code) => {
  if (inApp && !/Line\//i.test(navigator.userAgent) && !sessionStorage.getItem('lg.ignoreInApp')) { setTimeout(() => go('openinsafari'), 0); return ''; }
  sessionStorage.setItem('lg.pendingCode', code);
  if (!joinInfo || joinInfo.code !== code) {
    joinInfo = { code, data: null, err: null };
    api('inviteInfo', { code }).then(d => { joinInfo.data = d; render(); }).catch(e => { joinInfo.err = e.message; render(); });
    return header('加入團', 'home') + `<div class="pad"><div class="note blue" role="status">正在看這個邀請…</div></div>`;
  }
  if (joinInfo.err) return header('加入團', 'home') + `<div class="pad stack"><div class="note terra">${esc(joinInfo.err)}</div><button class="btn" data-go="home">回首頁</button></div>`;
  const d = joinInfo.data;
  const card = d.bootstrap ? `<div class="note blue"><b style="font-size:18px">建立第一個帳號</b><br>這是網站管理人的帳號，建好之後就能開團、邀請朋友。</div>` :
    `<div style="padding:20px;background:var(--sage-l);border-radius:20px;display:flex;flex-direction:column;gap:10px">
      <span style="font-size:15px;color:var(--sage);font-weight:700">你被邀請加入</span>
      <h1 style="margin:0;font-size:26px">${esc(d.title)}</h1>
      <span class="sub" style="color:var(--ink2)">開團人：${esc(d.owner)} · 目前 ${d.count} / ${d.max} 人</span>
      <div style="display:flex;gap:6px;flex-wrap:wrap">${d.names.map(n => avatar(n)).join('')}</div></div>`;
  if (loggedIn() && !d.bootstrap) {
    return header('加入團', 'home') + `<div class="pad stack">${card}<div class="sub">你已經登入為「${esc(session().user.name)}」。</div></div>
      <div class="foot"><button class="btn" data-act="acceptInvite">用這個帳號加入</button><button class="link" data-act="logoutJoin">我不是 ${esc(session().user.name)}</button></div>`;
  }
  const taken = joinInfo.taken;
  return `<div style="height:calc(24px + env(safe-area-inset-top))"></div><div class="pad stack" style="gap:18px">${card}
    <div class="field"><label class="lbl" for="jName">你的名字</label>
      <input id="jName" class="inp" autocomplete="username" placeholder="旅伴會看到這個名字" value="${esc(joinInfo.name || '')}" ${taken ? 'aria-invalid="true" aria-describedby="jErr" style="border-color:#b0664a"' : ''}>
      ${taken ? `<span id="jErr" style="font-size:14px;line-height:1.5;color:var(--bad)">${esc(taken.msg)}</span><span class="sub">換一個，或點下面的建議：</span>
        <div class="chips">${taken.suggest.map(n => `<button class="chip" data-act="pickName" data-n="${esc(n)}">${esc(n)}</button>`).join('')}</div>
        <div class="note" style="background:#fff;border:1px solid var(--line)">你就是「${esc(joinInfo.name)}」？代表你已經有帳號了，<button class="link" style="display:inline;min-height:0;padding:0" data-go="login">直接登入</button>就會加進這團。</div>`
        : '<span class="hint">登入也用這個名字，不能跟別人重複</span>'}</div>
    <div class="field"><label class="lbl" for="jPw">設一組密碼</label><input id="jPw" class="inp" type="password" autocomplete="new-password" placeholder="下次換手機登入用（至少 4 個字）"></div>
  </div>
  <div class="foot"><button class="btn" data-act="doJoin">${d.bootstrap ? '建立帳號' : '加入這個團'}</button><button class="link" data-go="login">已經有帳號？登入</button></div>`;
};
function avatar(n) {
  const colors = ['#42605a', '#7690a8', '#9a6a53', '#7a6330', '#6f7f73', '#4f6a82'];
  let h = 0; for (const c of String(n)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `<span aria-label="${esc(n)}" title="${esc(n)}" style="width:36px;height:36px;border-radius:50%;background:${colors[h % colors.length]};color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700">${esc(String(n).slice(-1))}</span>`;
}
ACT.pickName = el => { joinInfo.name = el.dataset.n; joinInfo.taken = null; render(); setTimeout(() => $('#jPw') && $('#jPw').focus(), 50); };
ACT.logoutJoin = () => { LS.del('session'); render(); };
ACT.acceptInvite = el => run(el, async () => {
  const r = await api('acceptInvite', { code: joinInfo.code });
  sessionStorage.removeItem('lg.pendingCode');
  go('g/' + r.tripId);
});
ACT.doJoin = el => run(el, async () => {
  const name = $('#jName').value.trim(), password = $('#jPw').value;
  joinInfo.name = name;
  if (!name) { toast('請填名字'); return; }
  if (password.length < 4) { toast('密碼至少 4 個字'); return; }
  try {
    const r = await api('join', { code: joinInfo.code, name, password });
    LS.set('session', { token: r.token, user: r.user });
    sessionStorage.removeItem('lg.pendingCode');
    const next = r.tripId ? 'g/' + r.tripId : 'mytrips';
    if (isIOS && !isStandalone()) { sessionStorage.setItem('lg.afterHome', next); go('addhome'); } else go(next);
  } catch (e) {
    if (e.code === 'nameTaken') { joinInfo.taken = { msg: e.message, suggest: (e.extra && e.extra.suggest) || [] }; render(); }
    throw e;
  }
});

routes.addhome = () => {
  const next = sessionStorage.getItem('lg.afterHome') || 'mytrips';
  return header('加到主畫面', next) + `<div class="pad stack">
    <div class="note ok"><b>加入成功！</b>再一步：把網站加到主畫面。</div>
    <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:14px;line-height:1.6">
      <span><b>1 按 Safari 下方的「分享」</b>（方框加向上箭頭）</span>
      <span><b>2 往下滑，選「加入主畫面」</b></span>
      <span><b>3 按右上角「新增」</b>，之後都從「出發吧」圖示打開</span>
    </div>
    <div class="note amber"><b>為什麼要加？</b><br>只用 Safari 開，7 天沒打開登入可能會被清掉，還以為資料不見。從主畫面開不會被清，也比較不會開錯地方。<br>第一次從主畫面打開要再登入一次（名字＋剛剛設的密碼）。</div>
  </div>
  <div class="foot"><button class="btn" data-go="${esc(next)}">先進團看看</button></div>`;
};

/* ================= 帳號 ================= */
routes.account = (mode) => {
  if (!loggedIn()) return routes.login();
  const u = session().user;
  return header('我的名字和密碼', 'mytrips') + `<div class="pad stack" style="gap:18px">
    <div class="field"><label class="lbl" for="acName">名字</label><input id="acName" class="inp" value="${esc(u.name)}"></div>
    <button class="btn2" data-act="saveName">改名字</button>
    <div class="field"><label class="lbl" for="acPw">新密碼</label><input id="acPw" class="inp" type="password" autocomplete="new-password" placeholder="至少 4 個字"></div>
    <button class="btn2" data-act="savePw" ${mode === 'pw' ? 'style="border-color:var(--sage);background:var(--sage-l)"' : ''}>改密碼</button>
    <div class="hint">帳號存在雲端。換手機時，用名字和密碼登入就能看到所有的團。</div>
    <button class="link" style="color:var(--bad)" data-act="logout">登出這支手機</button>
  </div>`;
};
ACT.saveName = el => run(el, async () => { const r = await api('changeName', { name: $('#acName').value.trim() }); const s = session(); s.user = r.user; LS.set('session', s); toast('名字改好了'); });
ACT.savePw = el => run(el, async () => { await api('changePw', { password: $('#acPw').value }); toast('密碼改好了'); go('mytrips'); });
ACT.logout = el => run(el, async () => { await quiet(api('logout')); LS.del('session'); Object.keys(GC).forEach(k => delete GC[k]); toast('已登出'); go('home'); });

/* ================= 我的行程（加上團） ================= */
let myTripsData = null;
function groupWarn() {
  return sessionStorage.getItem('lg.safariWarn') && !isStandalone() ? `<div class="note amber" role="status"><b>你現在是用 Safari 開的</b><br>你的手機已經有主畫面版了。之後從主畫面圖示打開，兩邊資料是同一份，但只有主畫面版不會被清掉、也能離線看。</div>` : '';
}
function groupSection() {
  if (!API_URL) return `<div class="card" style="padding:16px"><div class="sub">揪團功能還沒接上雲端。</div></div>`;
  if (!loggedIn()) return `<div class="card" style="padding:16px;display:flex;flex-direction:column;gap:10px"><div class="sub">揪團要登入，團的資料存在雲端，換手機也看得到。</div><div style="display:flex;gap:8px"><button class="btn2" style="flex:1" data-go="login">登入</button><button class="btn2" style="flex:1" data-go="nologin">怎麼加入</button></div></div>`;
  if (!myTripsData) { quiet(api('myTrips').then(d => { myTripsData = d; if (location.hash === '#mytrips') render(); })); return `<div class="sub" role="status">載入中…</div>`; }
  const d = myTripsData; const me = session().user;
  // 下次進來再更新
  setTimeout(() => quiet(api('myTrips').then(x => { const changed = JSON.stringify(x) !== JSON.stringify(myTripsData); myTripsData = x; if (changed && location.hash === '#mytrips') render(); })), 0);
  const stageTag = s => ({ collect: ['收集中', 'var(--sage-l)', 'var(--sage-d)'], plan: ['排行程', 'var(--blue-l)', 'var(--blue-d)'], final: ['已定案', 'var(--ok-l)', 'var(--ok)'] })[s] || ['', '', ''];
  const cards = d.trips.map(t => { const [l, bg, c] = stageTag(t.stage); return `<button class="card" data-go="g/${enc(t.tripId)}" style="padding:14px 16px;display:flex;align-items:center;gap:12px;text-align:left;width:100%">
    <span style="width:8px;align-self:stretch;border-radius:4px;background:var(--sage)"></span>
    <span style="display:flex;flex-direction:column;gap:4px;flex:1"><span style="font-size:17px;font-weight:700">${esc(t.title)}</span><span class="sub">${t.startDate ? esc(mdw(t.startDate)) + ' 出發 · ' : ''}${t.count}/${t.max} 人 · ${t.isOwner ? '你開的團' : esc(t.owner) + ' 開的團'}</span></span>
    <span style="display:flex;flex-direction:column;align-items:flex-end;gap:6px"><span class="tag" style="background:${bg};color:${c}">${l}</span>${t.unread ? `<span class="tag" style="background:var(--terra);color:#fff">${t.unread} 則新的</span>` : ''}</span></button>`; }).join('');
  const pend = d.pendingTransfer.map(p => `<div class="note blue"><b>${esc(p.from)} 想把「${esc(p.title)}」的開團人交給你</b><div style="display:flex;gap:8px;margin-top:8px"><button class="btn2" style="flex:1" data-act="ansTransfer" data-id="${esc(p.tripId)}" data-a="1">接手</button><button class="btn2" style="flex:1" data-act="ansTransfer" data-id="${esc(p.tripId)}" data-a="0">不要</button></div></div>`).join('');
  return `${pend}${cards || '<div class="card" style="padding:16px"><div class="sub">還沒有進行中的團。</div></div>'}
    ${d.endedCount ? `<button class="link" style="justify-content:flex-start;color:var(--mute);font-weight:400" data-go="ended">已結束的團（${d.endedCount}）</button>` : ''}
    <button class="btn" data-act="newTripGo">建立新團</button>
    <div style="display:flex;justify-content:space-between;align-items:center"><span class="hint">登入為「${esc(me.name)}」· 已開 ${d.owned}／${d.maxOwned} 團</span><button class="hbtn" data-go="account">帳號</button></div>`;
}
ACT.ansTransfer = el => run(el, async () => { await api('answerTransfer', { tripId: el.dataset.id, accept: el.dataset.a === '1' }); myTripsData = null; toast(el.dataset.a === '1' ? '你現在是開團人了' : '已回絕'); render(); });
ACT.newTripGo = () => {
  if (!loggedIn()) { go('nologin'); return; }
  if (myTripsData && myTripsData.owned >= myTripsData.maxOwned) { go('ownedfull'); return; }
  go('newtrip');
};

routes.ownedfull = () => {
  if (!myTripsData) { go('mytrips'); return ''; }
  const mine = myTripsData.trips.filter(t => t.isOwner);
  return header('建立新團', 'mytrips') + `<div class="pad stack">
    <div class="note amber" role="status"><b style="font-size:17px">你開的團有 ${mine.length} 個還在進行中</b><br>一個人最多同時開 ${myTripsData.maxOwned} 個團。結束其中一個，就能再開新的。</div>
    <h2 class="sec">你開的團（${mine.length}／${myTripsData.maxOwned}）</h2>
    ${mine.map(t => `<button class="card" data-go="gowner/${enc(t.tripId)}" style="padding:14px 16px;text-align:left;width:100%"><b>${esc(t.title)}</b><br><span class="sub">${t.count}/${t.max} 人 · 點開開團人工具</span></button>`).join('')}
    <h2 class="sec">怎麼空出名額</h2>
    <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:10px;line-height:1.6">
      <span><b>已經玩完的團：結清後封存</b></span><span><b>不會成行的團：取消</b>（沒記過帳才能取消，30 天內可還原）</span><span><b>交給旅伴當開團人</b>，就不算你的名額</span></div>
    <div class="hint">只算你開的團。被邀請加入的團不限數量；封存、取消的團不算。</div>
  </div><div class="foot"><button class="btn" data-go="mytrips">回我的行程</button></div>`;
};

/* ================= 建立新團、邀請 ================= */
let ntForm = null;
routes.newtrip = () => {
  if (!loggedIn()) return routes.nologin();
  ntForm = ntForm || { title: '', dest: '', startDate: addDays(ymd(new Date()), 14), days: 2, mode: '開車', maxPeople: 6, itinerary: null };
  const f = ntForm;
  const seg = (k, opts, cols) => `<div class="seg" style="grid-template-columns:repeat(${cols},1fr)">${opts.map(([v, t]) => `<button aria-pressed="${String(f[k]) === String(v)}" data-act="ntSet" data-k="${k}" data-v="${v}" style="${String(f[k]) === String(v) ? 'border-color:var(--sage);background:var(--sage-l);color:var(--sage)' : ''}">${t}</button>`).join('')}</div>`;
  return header(f.itinerary ? '升級成團' : '建立新團', f.itinerary ? 'mytrips' : 'mytrips', myTripsData ? `<button class="hbtn" data-go="ownedfull">已開 ${myTripsData.owned}／${myTripsData.maxOwned}</button>` : '') + `<div class="pad stack" style="gap:18px">
    ${f.itinerary ? '<div class="note blue">這份行程會變成團的第一版，直接進入「排行程」。旅伴可以加點到候補。</div>' : ''}
    <div class="field"><label class="lbl" for="ntTitle">團名</label><input id="ntTitle" class="inp" value="${esc(f.title)}" placeholder="例：花蓮三天兩夜" data-nt="title"></div>
    <div class="field"><label class="lbl" for="ntDest">想去哪裡（選填，可以先空著讓大家加）</label><input id="ntDest" class="inp" value="${esc(f.dest)}" placeholder="例：花蓮、太魯閣" data-nt="dest"></div>
    <div class="field"><label class="lbl" for="ntDate">出發日</label><input id="ntDate" class="inp" type="date" value="${esc(f.startDate)}" data-nt="startDate"></div>
    <div class="field"><span class="lbl">幾天</span>${seg('days', [[1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5+']], 5)}</div>
    <div class="field"><span class="lbl">交通</span>${seg('mode', [['開車', '開車'], ['大眾運輸', '大眾運輸'], ['機車', '機車']], 3)}</div>
    <div class="field"><span class="lbl">最多幾人（含你）</span>${seg('maxPeople', [[3, '3'], [4, '4'], [5, '5'], [6, '6']], 4)}</div>
  </div>
  <div class="foot"><button class="btn" data-act="ntCreate">${f.itinerary ? '建立團並邀請旅伴' : '建立並邀請旅伴'}</button><span class="hint" style="text-align:center">${f.itinerary ? '' : '建好是「收集中」，大家先加想去的點'}</span></div>`;
};
document.addEventListener('input', e => { const k = e.target.dataset.nt; if (k && ntForm) ntForm[k] = e.target.value; });
ACT.ntSet = el => { ntForm[el.dataset.k] = isNaN(+el.dataset.v) ? el.dataset.v : +el.dataset.v; render(); };
ACT.ntCreate = el => run(el, async () => {
  const f = ntForm; f.title = $('#ntTitle').value.trim(); if (!f.title) { toast('請填團名'); return; }
  try {
    const r = await api('createTrip', { title: f.title, dest: f.dest, startDate: f.startDate, days: f.days, mode: f.mode, maxPeople: f.maxPeople, itinerary: f.itinerary });
    ntForm = null; myTripsData = null;
    go('invite/' + r.tripId);
  } catch (e) { if (e.code === 'ownedFull') { myTripsData = await api('myTrips'); go('ownedfull'); } throw e; }
});
ACT.upgrade = () => {
  const t = getTrip(curTripId); if (!t) return;
  if (!API_URL) { openSheet(`<div class="pad stack"><b style="font-size:18px">升級成團</b><div class="note blue">揪團功能還沒接上雲端。</div><button class="btn" data-act="closeSheet">知道了</button></div>`); return; }
  if (!loggedIn()) { go('nologin'); return; }
  ntForm = { title: t.title, dest: t.place || '', startDate: t.data.days[0].date || ymd(new Date()), days: t.data.days.length, mode: t.mode, maxPeople: 6, itinerary: t.data };
  go('newtrip');
};

routes.invite = (id) => asyncView(id, () => loadTrip(id, true), d => {
  const url = inviteUrl(d.trip.inviteCode);
  return header('邀請旅伴', 'g/' + enc(id)) + `<div class="pad stack">
    <div class="note ok"><b style="font-size:17px">「${esc(d.trip.title)}」建好了</b><br>把邀請連結傳給旅伴，點開設名字和密碼就能加入。目前 ${d.members.length} / ${d.trip.maxPeople} 人。</div>
    <div class="card" style="padding:14px;font-size:13px;word-break:break-all;color:var(--mute)">${esc(url)}</div>
    <button class="btn" data-act="shareInvite" data-id="${esc(id)}">分享到 LINE…</button>
    <button class="btn2" data-act="copyInvite" data-id="${esc(id)}">複製邀請連結</button>
    <div class="hint">從 LINE 點開會自動跳到 Safari，避免在 LINE 裡登入。連結外流的話，可以在開團人工具「重新產生邀請連結」，舊的就失效。</div>
  </div><div class="foot"><button class="btn2" style="width:100%" data-go="g/${enc(id)}">進入團</button></div>`;
});
ACT.shareInvite = async el => {
  const d = GC[el.dataset.id]; const url = inviteUrl(d.trip.inviteCode); const text = `一起來排「${d.trip.title}」：點連結加入`;
  if (navigator.share) { try { await navigator.share({ title: d.trip.title, text, url }); } catch (e) {} }
  else location.href = 'https://line.me/R/msg/text/?' + enc(text + ' ' + url);
};
ACT.copyInvite = async el => { const d = GC[el.dataset.id]; const ok = await copyText(inviteUrl(d.trip.inviteCode)); toast(ok ? '邀請連結已複製' : '複製失敗'); };

/* ================= 團頁 ================= */
const STAGES = [['collect', '收集中'], ['plan', '排行程'], ['final', '定案']];
function stageBar(d) {
  const i = STAGES.findIndex(s => s[0] === d.trip.stage);
  const now = { collect: '加你想去的點，喜歡的按讚', plan: d.itinerary ? '看行程；新想到的點會進候補' : `${d.trip.owner} 正在請 AI 排行程`, final: '行程定了，去「分工」認領要辦的事' }[d.trip.stage];
  if (i < 0) return `<div class="pad"><div class="note amber"><b>${d.trip.stage === 'archived' ? '這團已封存' : '這團已取消'}</b>，只能看不能改。</div></div>`;
  return `<div style="margin:0 16px 12px;padding:12px 14px;background:var(--sage-l);border-radius:16px;display:flex;flex-direction:column;gap:8px">
    <div style="display:flex;align-items:center;gap:6px;font-size:13px;flex-wrap:wrap">${STAGES.map((s, k) => `<span style="padding:4px 10px;border-radius:999px;${k === i ? 'background:var(--sage);color:#fff;font-weight:700' : 'color:var(--sage)'}">${k + 1} ${s[1]}</span>`).join('<span style="color:var(--mute)">›</span>')}</div>
    <span style="font-size:16px;font-weight:700;color:var(--sage-d)">現在：${esc(now)}</span></div>`;
}
function ownerBar(d, id) {
  if (!d.me.isOwner || !ACTIVE_STAGE(d)) return '';
  const next = { collect: '結束收集，挑要排的點', plan: d.itinerary ? '貼回新版本或定案' : '複製提示詞、貼回行程', final: '定案後：封存、成員管理' }[d.trip.stage];
  return `<button data-go="gowner/${enc(id)}" style="margin:0 16px 12px;width:calc(100% - 32px);padding:12px 14px;border-radius:14px;border:1.5px solid var(--sage);background:#fff;display:flex;align-items:center;gap:10px;text-align:left">
    <span class="tag" style="background:var(--sage);color:#fff">開團人工具</span><span style="flex:1;font-size:14px;color:var(--sage-d)">${esc(next)}</span>${ICON.chev}</button>`;
}
const ACTIVE_STAGE = d => ['collect', 'plan', 'final'].includes(d.trip.stage);
function gHeader(d, id, back) {
  return `<header class="top" style="align-items:flex-start">
    <button class="iconbtn" aria-label="回我的行程" data-go="${esc(back || 'mytrips')}">${ICON.back}</button>
    <span style="display:flex;flex-direction:column;flex:1;min-width:0;padding-top:4px"><h1 style="font-size:20px">${esc(d.trip.title)}</h1><span id="syncLine" style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--ok)">${syncText()}</span></span>
    <button class="iconbtn" aria-label="最新動態${d.unread ? '，' + d.unread + ' 則新的' : ''}" data-go="updates/${enc(id)}" style="position:relative"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>${d.unread ? `<span style="position:absolute;top:6px;right:6px;min-width:18px;height:18px;border-radius:9px;background:var(--terra);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center">${d.unread > 9 ? '9+' : d.unread}</span>` : ''}</button>
    <button class="iconbtn" aria-label="更多" data-act="gMenu" data-id="${esc(id)}"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button>
  </header>`;
}
function gNav(id, tab) {
  const T = [['list', '清單', '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>'], ['plan', '行程', '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>'], ['tasks', '分工', '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>'], ['split', '分帳', '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h3"/>']];
  return `<nav aria-label="團分頁" style="position:sticky;bottom:0;height:calc(68px + env(safe-area-inset-bottom));padding-bottom:env(safe-area-inset-bottom);display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid #dcd8cf;background:#fbfaf7;z-index:6">
    ${T.map(([k, l, p]) => `<button data-go="g/${enc(id)}/${k}" ${k === tab ? 'aria-current="page"' : ''} style="border:none;background:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;font-size:13px;${k === tab ? 'color:var(--sage);font-weight:700;border-top:3px solid var(--sage)' : 'color:var(--mute);border-top:3px solid transparent'}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${p}</svg>${l}</button>`).join('')}</nav>`;
}
routes.g = (id, tab) => {
  if (!loggedIn()) return notLoggedTeam(id);
  tab = tab || (cachedTrip(id) && cachedTrip(id).trip.stage !== 'collect' ? 'plan' : 'list');
  return asyncView(id, () => loadTrip(id, true), d => {
    startPoll(id);
    const body = { list: tabList, plan: tabPlan, tasks: tabTasks, split: tabSplit }[tab] || tabList;
    return `<div style="min-height:100vh;display:flex;flex-direction:column">${gHeader(d, id)}${stageBar(d)}${ownerBar(d, id)}<div style="flex:1">${body(d, id)}</div>${gNav(id, tab)}</div>`;
  });
};
routes.g_after = (id) => { curTripId = 'g:' + id; };
function notLoggedTeam(id) {
  sessionStorage.setItem('lg.afterLogin', 'g/' + id);
  return header('打開團', 'home') + `<div class="pad stack">
    <div class="note blue"><b style="font-size:17px">這個瀏覽器還沒登入</b><br>團的資料都在雲端，沒有不見。登入後就看得到。</div>
    ${isIOS && !isStandalone() ? '<div class="note amber">如果你手機主畫面已經有「出發吧」圖示，請從圖示打開，那邊已經登入了。</div>' : ''}
  </div><div class="foot"><button class="btn" data-go="login">登入</button><div class="hint" style="text-align:center">第一次來？請跟開團人要邀請連結</div></div>`;
}

/* ---- 清單分頁 ---- */
const TYPE_CLS = { '吃': 't-eat', '喝': 't-drink', '玩': 't-play', '住': 't-stay' };
function placeRow(p, d, id, extra = '') {
  const mine = p.addedBy === d.me.userId;
  const canVote = ACTIVE_STAGE(d);
  return `<div class="card" style="padding:14px 16px;display:flex;align-items:center;gap:12px">
    <div style="display:flex;flex-direction:column;gap:4px;flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:8px"><span class="tag ${TYPE_CLS[p.type] || 't-play'}">${esc(p.type)}</span><span style="font-size:17px;font-weight:700;overflow-wrap:anywhere">${esc(p.name)}</span></div>
      ${p.note ? `<span class="sub">${esc(p.note)}</span>` : ''}
      ${mine || d.me.isOwner ? `<button class="link" style="justify-content:flex-start;min-height:28px;padding:0;font-size:14px" data-act="editPlace" data-id="${esc(id)}" data-p="${esc(p.placeId)}">${mine ? '我加的' : esc(p.addedByName) + ' 加的'} · 修改</button>` : `<span class="sub">${esc(p.addedByName)} 加的</span>`}
      <span style="display:flex;gap:10px;flex-wrap:wrap"><a class="sub" style="color:var(--sage);font-weight:700" href="${esc(gm.search(p.name + ' ' + (d.trip.dest || '')))}" target="_blank" rel="noopener">看評價</a>${extra}</span>
    </div>
    <button type="button" ${canVote ? `data-act="vote" data-id="${esc(id)}" data-p="${esc(p.placeId)}"` : 'disabled'} aria-pressed="${p.myVote}" aria-label="按讚，目前 ${p.votes} 票${p.voters.length ? '：' + esc(p.voters.join('、')) : ''}" style="min-width:64px;height:44px;display:flex;align-items:center;justify-content:center;gap:6px;border:1.5px solid ${p.myVote ? 'var(--sage)' : '#cdd9d5'};border-radius:12px;background:${p.myVote ? 'var(--sage-l)' : '#fff'};font-size:16px;font-weight:700;color:${p.myVote ? 'var(--sage)' : 'var(--ink2)'}"><svg width="18" height="18" viewBox="0 0 24 24" fill="${p.myVote ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/></svg>${p.votes}</button>
  </div>`;
}
function tabList(d, id) {
  const act = d.places.filter(p => p.status === 'active');
  const picked = d.places.filter(p => p.status === 'picked');
  const back = d.places.filter(p => p.status === 'backlog');
  let html = '<div class="pad stack" style="padding-bottom:16px">';
  if (d.trip.stage === 'collect') {
    html += act.length ? act.map(p => placeRow(p, d, id)).join('') : `<div class="card" style="padding:18px"><div class="sub">還沒有人加想去的點。第一個來吧！</div></div>`;
  } else {
    if (back.length) html += `<h2 class="sec">候補（${back.length}）</h2><div class="hint" style="margin-top:-6px">行程排好後才加的點。${d.me.isOwner ? '按「排進行程」選哪天幾點。' : '開團人可以把它排進某一天。'}</div>` +
      back.map(p => placeRow(p, d, id, d.me.isOwner && d.itinerary && ACTIVE_STAGE(d) ? `<button class="link" style="min-height:0;padding:0;font-size:14px" data-act="schedule" data-id="${esc(id)}" data-p="${esc(p.placeId)}">排進行程</button>` : '')).join('');
    if (picked.length) html += `<h2 class="sec">已排進行程（${picked.length}）</h2>` + picked.map(p => placeRow(p, d, id)).join('');
    if (!back.length && !picked.length) html += `<div class="card" style="padding:18px"><div class="sub">清單是空的。</div></div>`;
  }
  html += '</div>';
  if (ACTIVE_STAGE(d)) html += `<div style="padding:4px 16px 12px;position:sticky;bottom:calc(68px + env(safe-area-inset-bottom))"><button class="btn" data-act="addPlace" data-id="${esc(id)}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>加一個想去的點</button></div>`;
  return html;
}
function placeForm(p) {
  const type = p ? p.type : '玩';
  return `<div class="field"><label class="lbl" for="plName">想去哪裡</label><input id="plName" class="inp" value="${esc(p ? p.name : '')}" placeholder="店名或景點，要能在 Google 地圖搜到"></div>
    <div class="field"><span class="lbl">類型</span><div class="seg" id="plType" style="grid-template-columns:repeat(4,1fr)">${['吃', '喝', '玩', '住'].map(v => `<button aria-pressed="${v === type}" data-act="addType" data-v="${v}">${v}</button>`).join('')}</div></div>
    <div class="field"><label class="lbl" for="plNote">一句話（選填）</label><input id="plNote" class="inp" value="${esc(p ? p.note : '')}" placeholder="例：IG 很紅的早午餐"></div>`;
}
ACT.addPlace = el => {
  const d = GC[el.dataset.id];
  openSheet(`<div class="pad stack"><b style="font-size:18px">加一個想去的點</b>
    ${d.trip.stage !== 'collect' ? '<div class="note amber">行程已經在排了，新加的點會先進「候補」，開團人再決定排不排。</div>' : ''}
    ${placeForm(null)}
    <a class="btn2" href="${esc(gm.search((d.trip.dest || '') + ' 景點'))}" target="_blank" rel="noopener">還沒想到？先去 Google 地圖逛逛</a>
    <button class="btn" data-act="savePlace" data-id="${esc(el.dataset.id)}">加進清單</button><button class="link" data-act="closeSheet">取消</button></div>`);
  setTimeout(() => $('#plName') && $('#plName').focus(), 80);
};
ACT.savePlace = el => run(el, async () => {
  const id = el.dataset.id, pid = el.dataset.p;
  const body = { name: $('#plName').value.trim(), type: document.querySelector('#plType [aria-pressed="true"]').dataset.v, note: $('#plNote').value.trim() };
  if (!body.name) { toast('先填名字'); return; }
  if (pid) await api('editPlace', { placeId: pid, ...body }); else { const r = await api('addPlace', { tripId: id, ...body }); if (r.status === 'backlog') toast('已加進候補'); }
  closeSheet(); await loadTrip(id, true); render();
});
ACT.editPlace = el => {
  const d = GC[el.dataset.id]; const p = d.places.find(x => x.placeId === el.dataset.p);
  openSheet(`<div class="pad stack"><b style="font-size:18px">修改「${esc(p.name)}」</b>${placeForm(p)}
    <button class="btn" data-act="savePlace" data-id="${esc(el.dataset.id)}" data-p="${esc(p.placeId)}">存檔</button>
    <button class="btn2" style="color:var(--bad)" data-act="delPlace" data-id="${esc(el.dataset.id)}" data-p="${esc(p.placeId)}">從清單刪掉</button>
    <button class="link" data-act="closeSheet">取消</button></div>`);
};
ACT.delPlace = el => run(el, async () => { await api('delPlace', { placeId: el.dataset.p }); closeSheet(); await loadTrip(el.dataset.id, true); render(); toast('已刪掉'); });
ACT.vote = el => {
  const id = el.dataset.id, pid = el.dataset.p; const d = GC[id]; const p = d.places.find(x => x.placeId === pid);
  // 先改畫面，再送出（按讚要快）
  p.myVote = !p.myVote; p.votes += p.myVote ? 1 : -1; render();
  api('vote', { placeId: pid }).then(() => loadTrip(id, true)).then(() => { if (!isBusy()) render(); }).catch(e => { toast(e.message); p.myVote = !p.myVote; p.votes += p.myVote ? 1 : -1; render(); });
};
ACT.schedule = el => {
  const d = GC[el.dataset.id]; const p = d.places.find(x => x.placeId === el.dataset.p);
  const days = d.itinerary.data.days;
  openSheet(`<div class="pad stack"><b style="font-size:18px">把「${esc(p.name)}」排進行程</b>
    <div class="field"><span class="lbl">哪一天</span><div class="seg" id="scDay" style="grid-template-columns:repeat(${Math.min(days.length, 4)},1fr)">${days.map((x, i) => `<button aria-pressed="${i === 0}" data-act="addType" data-v="${i}">第 ${i + 1} 天</button>`).join('')}</div></div>
    <div class="field"><label class="lbl" for="scTime">幾點</label><input id="scTime" class="inp" type="time" value="10:00"></div>
    <div class="hint">排進去不用重跑 AI。營業時間和停車會標「不確定」，出發前按「看評價」確認。</div>
    <button class="btn" data-act="doSchedule" data-id="${esc(el.dataset.id)}" data-p="${esc(p.placeId)}">排進去</button><button class="link" data-act="closeSheet">取消</button></div>`);
};
ACT.doSchedule = el => run(el, async () => {
  const day = +document.querySelector('#scDay [aria-pressed="true"]').dataset.v;
  await api('scheduleBacklog', { tripId: el.dataset.id, placeId: el.dataset.p, day, time: $('#scTime').value });
  closeSheet(); await loadTrip(el.dataset.id, true); toast('排進第 ' + (day + 1) + ' 天了'); go('g/' + el.dataset.id + '/plan');
});

/* ---- 行程分頁 ---- */
let gDay = {};
function groupTripObj(d, id) { return { id: 'g:' + id, title: d.trip.title, mode: d.trip.mode, data: JSON.parse(JSON.stringify(d.itinerary.data)), saved: true, _ver: d.itinerary.ver }; }
function tabPlan(d, id) {
  if (!d.itinerary) {
    return `<div class="pad stack"><div class="card" style="padding:18px;display:flex;flex-direction:column;gap:10px">
      <b style="font-size:17px">${d.trip.stage === 'collect' ? '還在收集想去的點' : '開團人正在排行程'}</b>
      <span class="sub" style="line-height:1.6">${d.trip.stage === 'collect' ? `大家先在「清單」加點、按讚。${esc(d.trip.owner)} 覺得差不多了，會結束收集、請 AI 排成行程，排好會出現在這裡。` : `${esc(d.trip.owner)} 會把挑好的點交給 AI，排好貼回來就會出現在這裡。`}</span>
      ${d.me.isOwner ? `<button class="btn" data-go="gowner/${enc(id)}">去開團人工具</button>` : `<button class="btn2" data-go="g/${enc(id)}/list">去清單加點</button>`}</div></div>`;
  }
  const t = groupTripObj(d, id);
  const di = Math.min(gDay[id] || 0, t.data.days.length - 1);
  const dd = t.data.days[di];
  const back = d.places.filter(p => p.status === 'backlog').length;
  const st = tripStats(t);
  return `<div class="pad stack">
    <div class="sub">第 ${d.itinerary.ver} 版 · ${esc(d.itinerary.by)} 貼的 · ${st.n} 站 · ${esc(d.trip.mode)}${t.data.budget_ntd ? ' · 預算約 NT$' + esc(t.data.budget_ntd) + ' / 人' : ''}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><button class="btn2" data-act="gToday" data-id="${esc(id)}">當天模式</button><button class="btn2" data-act="gShare" data-id="${esc(id)}">分享／匯出</button></div>
    ${back ? `<button class="note amber" style="border:none;text-align:left" data-go="g/${enc(id)}/list"><b>候補區有 ${back} 個點</b>${d.me.isOwner ? '，點這裡排進行程 ›' : '，開團人會決定排不排'}</button>` : ''}
    <div class="note ${st.closed ? 'terra' : (st.unk ? 'amber' : 'ok')}">${st.open} 站確認有營業${st.unk ? '，' + st.unk + ' 站不確定' : ''}${st.closed ? '，<b>' + st.closed + ' 站公休</b>' : ''}</div>
  </div>
  ${t.data.days.length > 1 ? `<div class="tabs" role="tablist" style="margin-top:12px">${t.data.days.map((x, i) => `<button role="tab" aria-selected="${i === di}" data-act="gDay" data-id="${esc(id)}" data-i="${i}">第 ${i + 1} 天 · ${esc(mdw(x.date))}</button>`).join('')}</div>` : '<div style="height:12px"></div>'}
  <div class="stack" style="padding:0 16px 16px 8px">${dd.stops.map((_, si) => stopHTML(t, di, si, { noswap: !(d.me.isOwner && ACTIVE_STAGE(d)) })).join('') || '<div class="pad sub">這天還沒有排。</div>'}</div>
  ${d.me.isOwner && ACTIVE_STAGE(d) ? '<div class="hint pad" style="padding-bottom:16px">你是開團人：「換一家」會存成新的一版，大家都會看到。</div>' : ''}`;
}
ACT.gDay = el => { gDay[el.dataset.id] = +el.dataset.i; render(); };
function toGtoday(id) {
  // 當天模式和分享用一份放在手機裡的副本（沒訊號也能看）
  const d = GC[id]; const t = groupTripObj(d, id); const old = LS.get('gtoday', null);
  t.id = 'gtoday'; t.gid = id; t.progress = old && old.gid === id && old.ver === d.itinerary.ver ? old.progress : {}; t.ver = d.itinerary.ver;
  LS.set('gtoday', t);
}
ACT.gToday = el => { toGtoday(el.dataset.id); go('today/gtoday'); };
ACT.gShare = el => { toGtoday(el.dataset.id); go('share/gtoday'); };

/* 讓單機版的函式也能用在團上 */
const _getTrip = getTrip, _putTrip = putTrip;
getTrip = function (id) {
  if (id === 'gtoday') return LS.get('gtoday', null);
  if (String(id).startsWith('g:')) { const tid = id.slice(2); const d = GC[tid]; return d && d.itinerary ? groupTripObj(d, tid) : null; }
  return _getTrip(id);
};
putTrip = function (t) {
  if (t.id === 'gtoday') { LS.set('gtoday', t); return; }
  if (String(t.id).startsWith('g:')) {
    const tid = t.id.slice(2);
    api('saveItinerary', { tripId: tid, data: t.data, baseVer: t._ver, note: t._note || '換了一家' })
      .then(() => loadTrip(tid, true)).then(() => { render(); toast('已存成新的一版'); })
      .catch(e => { toast(e.message); quiet(loadTrip(tid, true).then(render)); });
    const d = GC[tid]; d.itinerary.data = t.data;  // 先顯示
    return;
  }
  return _putTrip(t);
};

/* ---- 分工分頁 ---- */
function tabTasks(d, id) {
  const me = d.me.userId;
  const rows = d.tasks.map(x => {
    let right = '', status = '';
    const isMine = x.ownerId === me;
    if (x.status === 'open') { status = '<span class="status s-unk">還沒人認領</span>'; right = ACTIVE_STAGE(d) ? `<button class="act" style="background:var(--sage);color:#fff;border-color:var(--sage)" data-act="tk" data-a="claimTask" data-id="${esc(id)}" data-k="${esc(x.taskId)}">我來</button>` : ''; }
    else if (x.status === 'done') { status = `<span class="status s-open">✓ ${esc(x.ownerName)} 辦好了</span>`; right = isMine || d.me.isOwner ? `<button class="act" data-act="tk" data-a="doneTask" data-undo="1" data-id="${esc(id)}" data-k="${esc(x.taskId)}">改回還沒好</button>` : ''; }
    else {
      status = `<span class="sub">${isMine ? '<b style="color:var(--sage)">你負責</b>' : esc(x.ownerName) + ' 負責'}</span>`;
      if (isMine) right = `<button class="act" style="background:var(--sage);color:#fff;border-color:var(--sage)" data-act="tk" data-a="doneTask" data-id="${esc(id)}" data-k="${esc(x.taskId)}">辦好了</button><button class="act" data-act="tk" data-a="giveUpTask" data-id="${esc(id)}" data-k="${esc(x.taskId)}">放棄</button>`;
      else if (!x.takeoverBy) right = `<button class="act" data-act="tk" data-a="requestTask" data-id="${esc(id)}" data-k="${esc(x.taskId)}">我來接手</button>`;
    }
    let take = '';
    if (x.takeoverBy && x.status === 'claimed') {
      take = (isMine || d.me.isOwner) ? `<div class="note amber" style="padding:10px 12px">${esc(x.takeoverName)} 想接手<div style="display:flex;gap:8px;margin-top:6px"><button class="act" data-act="tk" data-a="answerTakeover" data-accept="1" data-id="${esc(id)}" data-k="${esc(x.taskId)}">交給 ${esc(x.takeoverName)}</button><button class="act" data-act="tk" data-a="answerTakeover" data-id="${esc(id)}" data-k="${esc(x.taskId)}">不用</button></div></div>`
        : `<span class="sub">${esc(x.takeoverName)} 想接手，等 ${esc(x.ownerName)} 同意</span>`;
    }
    const owner = d.me.isOwner && ACTIVE_STAGE(d) ? `<button class="link" style="justify-content:flex-start;min-height:32px;padding:0;font-size:14px" data-act="assign" data-id="${esc(id)}" data-k="${esc(x.taskId)}">指派／改派</button>` : '';
    return `<div class="card" style="padding:14px 16px;display:flex;flex-direction:column;gap:8px"><div style="font-size:17px;font-weight:700">${esc(x.title)}</div>${status}${take}${ACTIVE_STAGE(d) && right ? `<div class="acts">${right}</div>` : ''}${owner}
      ${x.status === 'done' && isMine ? `<button class="link" style="justify-content:flex-start;min-height:32px;padding:0;font-size:14px" data-go="addexp/${enc(id)}?t=${enc(x.title)}">有付錢嗎？記一筆 ›</button>` : ''}</div>`;
  }).join('');
  return `<div class="pad stack" style="padding-bottom:16px">
    ${d.trip.stage !== 'final' && ACTIVE_STAGE(d) ? '<div class="hint">要辦的事（訂民宿、租車、買車票…）先列在這裡，定案後大家認領。</div>' : ''}
    ${rows || '<div class="card" style="padding:18px"><div class="sub">還沒有要辦的事。</div></div>'}
    ${ACTIVE_STAGE(d) ? `<button class="btn2" data-act="addTask" data-id="${esc(id)}">＋ 加一件要辦的事</button>` : ''}
    <div class="hint">辦好的事有付錢？到「分帳」記一筆，大家一起分。</div>
  </div>`;
}
ACT.tk = el => run(el, async () => {
  const body = { taskId: el.dataset.k }; if (el.dataset.undo) body.undo = true; if (el.dataset.accept) body.accept = true;
  await api(el.dataset.a, body); await loadTrip(el.dataset.id, true); render();
});
ACT.addTask = el => {
  const sug = ['訂民宿', '租車', '買車票', '查天氣', '準備零食'];
  openSheet(`<div class="pad stack"><b style="font-size:18px">加一件要辦的事</b>
    <div class="field"><label class="lbl" for="tkTitle">要辦什麼</label><input id="tkTitle" class="inp" placeholder="例：訂民宿"></div>
    <div class="chips">${sug.map(s => `<button class="chip" data-act="tkSug" data-v="${s}">${s}</button>`).join('')}</div>
    <label class="switch"><input type="checkbox" id="tkClaim">我自己來辦</label>
    <button class="btn" data-act="saveTask" data-id="${esc(el.dataset.id)}">加進去</button><button class="link" data-act="closeSheet">取消</button></div>`);
};
ACT.tkSug = el => { $('#tkTitle').value = el.dataset.v; };
ACT.saveTask = el => run(el, async () => { const title = $('#tkTitle').value.trim(); if (!title) { toast('先填要辦什麼'); return; } await api('addTask', { tripId: el.dataset.id, title, claim: $('#tkClaim').checked }); closeSheet(); await loadTrip(el.dataset.id, true); render(); });
ACT.assign = el => {
  const d = GC[el.dataset.id]; const x = d.tasks.find(t => t.taskId === el.dataset.k);
  openSheet(`<div class="pad stack"><b style="font-size:18px">「${esc(x.title)}」交給誰？</b>
    <div class="card list">${d.members.map(m => `<button class="rowitem" style="width:100%;border:none;border-bottom:1px solid var(--line2);background:none;text-align:left" data-act="doAssign" data-id="${esc(el.dataset.id)}" data-k="${esc(x.taskId)}" data-u="${esc(m.userId)}"><span style="flex:1;font-size:16px">${esc(m.name)}${m.userId === d.me.userId ? '（你）' : ''}</span>${x.ownerId === m.userId ? '<span class="sub">現在負責</span>' : ''}</button>`).join('')}
      <button class="rowitem" style="width:100%;border:none;background:none;text-align:left;color:var(--mute)" data-act="doAssign" data-id="${esc(el.dataset.id)}" data-k="${esc(x.taskId)}" data-u="">改回沒人認領</button></div>
    ${x.createdBy === d.me.userId || d.me.isOwner ? `<button class="btn2" style="color:var(--bad)" data-act="delTaskDo" data-id="${esc(el.dataset.id)}" data-k="${esc(x.taskId)}">刪掉這件事</button>` : ''}
    <button class="link" data-act="closeSheet">取消</button></div>`);
};
ACT.doAssign = el => run(el, async () => { await api('assignTask', { taskId: el.dataset.k, userId: el.dataset.u }); closeSheet(); await loadTrip(el.dataset.id, true); render(); });
ACT.delTaskDo = el => run(el, async () => { await api('delTask', { taskId: el.dataset.k }); closeSheet(); await loadTrip(el.dataset.id, true); render(); });

/* ---- 分帳分頁 ---- */
const money = n => 'NT$' + Math.round(n).toLocaleString('en-US');
function mySummary(d) {
  const me = d.me.userId; const s = d.settle;
  const pay = s.transfers.filter(x => x.from === me && x.status !== 'confirmed');
  const get = s.transfers.filter(x => x.to === me && x.status !== 'confirmed');
  if (!s.total) return '還沒有花費';
  if (!pay.length && !get.length) return '你的帳都結清了';
  const parts = [];
  if (pay.length) parts.push('要付 ' + pay.map(x => esc(x.toName) + ' ' + money(x.amount)).join('、'));
  if (get.length) parts.push('要收 ' + get.map(x => esc(x.fromName) + ' ' + money(x.amount)).join('、'));
  return parts.join('；');
}
function tabSplit(d, id) {
  const s = d.settle;
  return `<div class="pad stack" style="padding-bottom:16px">
    <div style="padding:16px;background:var(--sage);border-radius:18px;color:#fff;display:flex;flex-direction:column;gap:6px">
      <span style="font-size:14px;color:#dbe7e3">你的結算</span><span style="font-size:20px;font-weight:700;line-height:1.4">${mySummary(d)}</span>
      <span style="font-size:14px;color:#dbe7e3">全團共花 ${money(s.total)} · ${d.expenses.length} 筆</span>
      ${s.total ? `<button data-go="settle/${enc(id)}" style="align-self:flex-start;min-height:40px;margin-top:4px;padding:0 14px;border:none;border-radius:10px;background:#fff;color:var(--sage-d);font-size:15px;font-weight:700">看怎麼結清</button>` : ''}
    </div>
    <h2 class="sec">花費紀錄</h2>
    ${d.expenses.length ? `<div class="card list">${d.expenses.map(x => { const n = Object.keys(x.shares).length; const who = d.allNames[x.paidBy] || '?'; const missing = d.members.filter(m => !(m.userId in x.shares)).map(m => m.name);
      return `<button class="rowitem" style="width:100%;border:none;border-bottom:1px solid var(--line2);background:none;text-align:left" data-go="addexp/${enc(id)}/${enc(x.expenseId)}"><span style="display:flex;flex-direction:column;flex:1"><span style="font-size:16px;font-weight:700">${esc(x.title)}</span><span class="sub">${esc(who)} 付 · ${x.splitMode === 'custom' ? '各付各的' : n + ' 人平分'}${missing.length && missing.length < 3 && x.splitMode !== 'custom' ? '（' + esc(missing.join('、')) + '沒份）' : ''}</span></span><span style="font-size:16px;font-weight:700">${money(x.amount)}</span></button>`; }).join('')}</div>` : '<div class="card" style="padding:18px"><div class="sub">還沒有花費。誰先付了錢就記一筆，最後系統幫大家算誰要給誰多少。</div></div>'}
    <div class="hint">點一筆可以修改；只有記的人和開團人能改或刪。</div>
  </div>
  ${ACTIVE_STAGE(d) ? `<div style="padding:4px 16px 12px;position:sticky;bottom:calc(68px + env(safe-area-inset-bottom))"><button class="btn" data-go="addexp/${enc(id)}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>記一筆</button></div>` : ''}`;
}

/* ---- 記一筆 ---- */
let expDraft = null;
const CATS = ['住宿', '交通', '吃', '門票', '其他'];
routes.addexp = (idq, eid) => {
  const [id, qs] = String(idq).split('?');
  return asyncView(id, () => loadTrip(id), d => {
    if (!expDraft || expDraft.id !== id || expDraft.eid !== (eid || '')) {
      const x = eid ? d.expenses.find(e => e.expenseId === eid) : null;
      const pre = new URLSearchParams(qs || '').get('t') || '';
      expDraft = x ? { id, eid, title: x.title, category: x.category, amount: String(x.amount), paidBy: x.paidBy, splitMode: x.splitMode, who: Object.keys(x.shares), custom: { ...x.shares }, createdBy: x.createdBy }
        : { id, eid: '', title: pre, category: /民宿|住/.test(pre) ? '住宿' : /車|票/.test(pre) ? '交通' : '', amount: '', paidBy: d.me.userId, splitMode: 'equal', who: d.members.map(m => m.userId), custom: {} };
    }
    const f = expDraft; const amt = Math.round(+f.amount || 0);
    const canEdit = !eid || f.createdBy === d.me.userId || d.me.isOwner;
    const n = f.who.length; const base = n ? Math.floor(amt / n) : 0; const rem = amt - base * n;
    const customSum = f.who.reduce((s, u) => s + Math.round(+f.custom[u] || 0), 0);
    const preview = !amt ? '' : f.splitMode === 'equal'
      ? (n ? `每人 ${money(base)}${rem ? `，零頭 ${rem} 元由 ${esc(d.allNames[f.paidBy])} 吸收` : ''}` : '至少要有一個人有份')
      : (customSum === amt ? '金額對得起來 ✓' : `加起來 ${money(customSum)}，還差 ${money(amt - customSum)}`);
    return header(eid ? '修改這筆' : '記一筆', 'g/' + enc(id) + '/split') + `<div class="pad stack" style="gap:18px">
      <div class="field"><label class="lbl" for="exTitle">花在什麼</label><input id="exTitle" class="inp" data-ex="title" value="${esc(f.title)}" placeholder="例：民宿兩晚" ${canEdit ? '' : 'disabled'}></div>
      <div class="chips">${CATS.map(c => `<button class="chip" aria-pressed="${f.category === c}" data-act="exSet" data-k="category" data-v="${c}">${c}</button>`).join('')}</div>
      <div class="field"><label class="lbl" for="exAmt">多少錢</label><input id="exAmt" class="inp" data-ex="amount" inputmode="numeric" value="${esc(f.amount)}" placeholder="NT$" style="font-size:22px;font-weight:700"></div>
      <div class="field"><span class="lbl">誰付的</span><div class="chips">${d.members.map(m => `<button class="chip" aria-pressed="${f.paidBy === m.userId}" data-act="exSet" data-k="paidBy" data-v="${esc(m.userId)}">${esc(m.name)}</button>`).join('')}</div></div>
      <div class="field"><span class="lbl">怎麼分</span><div class="seg" style="grid-template-columns:1fr 1fr">
        <button aria-pressed="${f.splitMode === 'equal'}" data-act="exSet" data-k="splitMode" data-v="equal">有份的人平分</button><button aria-pressed="${f.splitMode === 'custom'}" data-act="exSet" data-k="splitMode" data-v="custom">各付各的</button></div></div>
      <div class="field"><span class="lbl">誰有份</span><div class="card list">${d.members.map(m => { const on = f.who.includes(m.userId); return `<label class="rowitem" style="gap:12px"><input type="checkbox" data-exwho="${esc(m.userId)}" ${on ? 'checked' : ''} style="width:22px;height:22px;accent-color:var(--sage)"><span style="flex:1;font-size:16px">${esc(m.name)}</span>${f.splitMode === 'custom' && on ? `<input class="inp" style="width:110px;height:44px" inputmode="numeric" data-excustom="${esc(m.userId)}" value="${esc(f.custom[m.userId] || '')}" placeholder="金額">` : (on && amt && f.splitMode === 'equal' ? `<span class="sub">${money(base + (m.userId === f.paidBy ? rem : 0))}</span>` : '')}</label>`; }).join('')}</div>
        <span class="hint" id="exPreview" style="font-size:15px;font-weight:700;color:${f.splitMode === 'custom' && amt && customSum !== amt ? 'var(--bad)' : 'var(--sage-d)'}">${preview}</span>
        <span class="hint">沒吃、沒住的人取消勾選，就不會算到他。</span></div>
    </div>
    <div class="foot"><button class="btn" data-act="saveExp" ${canEdit ? '' : 'disabled'}>${eid ? '存檔' : '記下來'}</button>${eid && canEdit ? '<button class="link" style="color:var(--bad)" data-act="delExp">刪掉這筆</button>' : ''}${canEdit ? '' : '<span class="hint" style="text-align:center">只有記的人和開團人能改</span>'}</div>`;
  });
};
document.addEventListener('input', e => {
  if (!expDraft) return;
  const k = e.target.dataset.ex; if (k) { expDraft[k] = e.target.value; if (k === 'amount') softRender(); }
  const c = e.target.dataset.excustom; if (c) { expDraft.custom[c] = e.target.value; softRender(); }
});
document.addEventListener('change', e => {
  if (!expDraft) return;
  const u = e.target.dataset.exwho; if (u) { const i = expDraft.who.indexOf(u); if (e.target.checked && i < 0) expDraft.who.push(u); if (!e.target.checked && i >= 0) expDraft.who.splice(i, 1); render(); }
});
function softRender() {
  // 打字時只更新試算結果，不重畫整頁（避免鍵盤跳掉）
  clearTimeout(softRender.t); softRender.t = setTimeout(() => {
    const a = document.activeElement; const key = a && (a.dataset.ex ? '[data-ex="' + a.dataset.ex + '"]' : a.dataset.excustom ? '[data-excustom="' + a.dataset.excustom + '"]' : null);
    const pos = a && a.selectionStart; render();
    if (key) { const el = document.querySelector(key); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (e) {} } }
  }, 350);
}
ACT.exSet = el => { expDraft[el.dataset.k] = el.dataset.v; render(); };
ACT.saveExp = el => run(el, async () => {
  const f = expDraft; const amt = Math.round(+f.amount);
  if (!f.title.trim()) f.title = f.category || '花費';
  if (!(amt > 0)) { toast('金額要填數字'); return; }
  if (!f.who.length) { toast('至少要有一個人有份'); return; }
  const shares = {}; f.who.forEach(u => shares[u] = f.splitMode === 'custom' ? Math.round(+f.custom[u] || 0) : 1);
  const body = { tripId: f.id, title: f.title.trim(), category: f.category, amount: amt, paidBy: f.paidBy, splitMode: f.splitMode, shares };
  if (f.eid) await api('editExpense', { expenseId: f.eid, ...body }); else await api('addExpense', body);
  const id = f.id; expDraft = null; await loadTrip(id, true); toast('記好了'); go('g/' + id + '/split');
});
ACT.delExp = el => run(el, async () => { const id = expDraft.id; await api('delExpense', { expenseId: expDraft.eid }); expDraft = null; await loadTrip(id, true); toast('已刪掉'); go('g/' + id + '/split'); });

/* ---- 怎麼結清 ---- */
routes.settle = (id) => asyncView(id, () => loadTrip(id, true), d => {
  const s = d.settle; const me = d.me.userId;
  const ST = { pending: ['待付款', 'var(--amber-l)', 'var(--amber)'], paid: ['已付，等確認', 'var(--blue-l)', 'var(--blue-d)'], confirmed: ['已結清', 'var(--ok-l)', 'var(--ok)'] };
  const rows = s.transfers.map(x => {
    const [l, bg, c] = ST[x.status] || ST.pending;
    let btns = '';
    if (ACTIVE_STAGE(d)) {
      if (x.status === 'pending' && (x.from === me || d.me.isOwner)) btns = `<button class="act" style="background:var(--sage);color:#fff;border-color:var(--sage)" data-act="stl" data-a="markPaid" data-id="${esc(id)}" data-f="${esc(x.from)}" data-t="${esc(x.to)}">${x.from === me ? '我付了' : '標成已付'}</button>`;
      if (x.status === 'paid' && (x.to === me || d.me.isOwner)) btns = `<button class="act" style="background:var(--sage);color:#fff;border-color:var(--sage)" data-act="stl" data-a="confirmPaid" data-id="${esc(id)}" data-f="${esc(x.from)}" data-t="${esc(x.to)}">收到了</button><button class="act" data-act="stl" data-a="confirmPaid" data-reject="1" data-id="${esc(id)}" data-f="${esc(x.from)}" data-t="${esc(x.to)}">還沒收到</button>`;
      if (x.status === 'paid' && x.from === me && x.to !== me && !d.me.isOwner) btns = `<button class="act" data-act="stl" data-a="markPaid" data-undo="1" data-id="${esc(id)}" data-f="${esc(x.from)}" data-t="${esc(x.to)}">按錯了</button>`;
    }
    return `<div class="card" style="padding:14px 16px;display:flex;flex-direction:column;gap:8px ${x.from === me || x.to === me ? ';border:2px solid var(--sage)' : ''}">
      <div style="display:flex;align-items:center;gap:8px"><span style="flex:1;font-size:17px"><b>${esc(x.fromName)}</b> → <b>${esc(x.toName)}</b></span><span style="font-size:18px;font-weight:700">${money(x.amount)}</span></div>
      <span class="tag" style="align-self:flex-start;background:${bg};color:${c}">${l}</span>${btns ? `<div class="acts">${btns}</div>` : ''}</div>`;
  }).join('');
  const done = s.transfers.length && s.transfers.every(x => x.status === 'confirmed');
  return header('怎麼結清', 'g/' + enc(id) + '/split') + `<div class="pad stack" style="padding-bottom:32px">
    <div class="sub">${esc(d.trip.title)} · 全團共花 ${money(s.total)}</div>
    ${s.transfers.length ? `<h2 class="sec">最少 ${s.transfers.length} 筆轉帳就能結清</h2>${rows}` : '<div class="note ok">大家付的剛好等於該付的，不用轉帳。</div>'}
    ${done ? `<div class="note ok"><b>全部結清了！</b>${d.me.isOwner ? '可以到開團人工具封存這個團。' : ''}</div>` : ''}
    <h2 class="sec">算法對照表</h2>
    <div class="card" style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:15px">
      <thead><tr style="color:var(--mute);font-size:13px;text-align:right"><th style="text-align:left;padding:10px 12px;font-weight:500">誰</th><th style="padding:10px 6px;font-weight:500">已付</th><th style="padding:10px 6px;font-weight:500">該付</th><th style="padding:10px 12px;font-weight:500">差額</th></tr></thead>
      <tbody>${s.rows.map(r => `<tr style="border-top:1px solid var(--line2);text-align:right"><td style="text-align:left;padding:10px 12px;font-weight:700">${esc(r.name)}</td><td style="padding:10px 6px">${money(r.paid)}</td><td style="padding:10px 6px">${money(r.owed)}</td><td style="padding:10px 12px;font-weight:700;color:${r.diff > 0 ? 'var(--ok)' : r.diff < 0 ? 'var(--bad)' : 'var(--mute)'}">${r.diff > 0 ? '+' : ''}${Math.round(r.diff).toLocaleString('en-US')}</td></tr>`).join('')}
      <tr style="border-top:2px solid var(--line);text-align:right;color:var(--mute)"><td style="text-align:left;padding:10px 12px">合計</td><td style="padding:10px 6px">${money(s.rows.reduce((a, r) => a + r.paid, 0))}</td><td style="padding:10px 6px">${money(s.rows.reduce((a, r) => a + r.owed, 0))}</td><td style="padding:10px 12px">${s.rows.reduce((a, r) => a + r.diff, 0)}</td></tr></tbody></table></div>
    <div class="note blue" style="line-height:1.7"><b>怎麼算的</b><br>1 每一筆只算「有份的人」，平分時每人付整數，零頭由付錢的人吸收。<br>2 差額 ＝ 已付 − 該付。正的等收錢，負的要付錢，全部加起來剛好是 0。<br>3 把要付錢的人和要收錢的人兩兩配對，用最少的轉帳筆數結清。</div>
    <div class="hint">付完按「我付了」，收錢的人按「收到了」才算結清。全部結清，開團人才能封存這個團。</div>
  </div>`;
});
ACT.stl = el => run(el, async () => {
  const body = { tripId: el.dataset.id, from: el.dataset.f, to: el.dataset.t }; if (el.dataset.undo) body.undo = true; if (el.dataset.reject) body.reject = true;
  await api(el.dataset.a, body); await loadTrip(el.dataset.id, true); render();
});

/* ---- 最新動態 ---- */
let updCache = {};
routes.updates = (id) => {
  if (!updCache[id]) {
    api('updates', { tripId: id }).then(r => { updCache[id] = r.list; render(); quiet(api('markSeen', { tripId: id }).then(() => { if (GC[id]) GC[id].unread = 0; })); }).catch(e => toast(e.message));
    return header('最新動態', 'g/' + enc(id)) + '<div class="pad"><div class="note blue" role="status">載入中…</div></div>';
  }
  const list = updCache[id]; setTimeout(() => { delete updCache[id]; }, 0);
  const fmt = at => { const d = new Date(at); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  return header('最新動態', 'g/' + enc(id)) + `<div class="pad stack" style="padding-bottom:32px">
    ${isIOS && !isStandalone() ? '<div class="note amber">iPhone 要從主畫面圖示打開，才收得到旅伴的更新提醒。</div>' : ''}
    <div class="card list">${list.map(l => `<div class="rowitem" style="align-items:flex-start;${l.isNew ? 'background:var(--terra-l)' : ''}"><span style="flex:1;line-height:1.5;font-size:15px">${l.isNew ? '<b style="color:var(--terra-d)">新 </b>' : ''}${esc(l.text)}</span><span class="sub" style="white-space:nowrap;font-size:12px">${fmt(l.at)}</span></div>`).join('') || '<div class="rowitem sub">還沒有動態</div>'}</div>
  </div>`;
};

/* ---- 團選單 ---- */
ACT.gMenu = el => {
  const id = el.dataset.id; const d = GC[id];
  openSheet(`<div class="pad stack"><b style="font-size:18px">${esc(d.trip.title)}</b>
    <div class="card list">
      <button class="rowitem" style="width:100%;border:none;border-bottom:1px solid var(--line2);background:none;text-align:left" data-go="updates/${enc(id)}"><span style="flex:1">最新動態</span>${ICON.chev}</button>
      ${ACTIVE_STAGE(d) ? `<button class="rowitem" style="width:100%;border:none;border-bottom:1px solid var(--line2);background:none;text-align:left" data-go="invite/${enc(id)}"><span style="flex:1">邀請旅伴（${d.members.length}/${d.trip.maxPeople}）</span>${ICON.chev}</button>` : ''}
      <button class="rowitem" style="width:100%;border:none;border-bottom:1px solid var(--line2);background:none;text-align:left" data-act="copyTripLink" data-id="${esc(id)}"><span style="flex:1">複製這團的連結（給已加入的人）</span></button>
      <button class="rowitem" style="width:100%;border:none;border-bottom:1px solid var(--line2);background:none;text-align:left" data-go="account"><span style="flex:1">我的名字和密碼</span>${ICON.chev}</button>
      ${d.me.isOwner ? `<button class="rowitem" style="width:100%;border:none;background:none;text-align:left" data-go="gowner/${enc(id)}"><span style="flex:1">開團人工具</span>${ICON.chev}</button>` :
        (ACTIVE_STAGE(d) ? `<button class="rowitem" style="width:100%;border:none;background:none;text-align:left;color:var(--bad)" data-act="leave" data-id="${esc(id)}"><span style="flex:1">退出這個團</span></button>` : '')}
    </div>
    <div class="hint">成員：${d.members.map(m => esc(m.name) + (m.role === 'owner' ? '（開團人）' : '')).join('、')}</div>
    ${d.me.isOwner ? '<div class="hint">開團人不能退出，要先把開團人交給別人，或封存／取消這個團。</div>' : ''}
    <button class="link" data-act="closeSheet">關閉</button></div>`);
};
ACT.copyTripLink = async el => { const ok = await copyText(tripUrl(el.dataset.id)); toast(ok ? '已複製' : '複製失敗'); };
ACT.leave = el => openSheet(`<div class="pad stack"><b style="font-size:18px">確定退出？</b><div class="note amber">你認領的事會變回沒人認領。你記過的帳還會留著。</div><button class="btn terra" data-act="leave2" data-id="${esc(el.dataset.id)}">退出</button><button class="link" data-act="closeSheet">不要</button></div>`);
ACT.leave2 = el => run(el, async () => { await api('leaveTrip', { tripId: el.dataset.id }); myTripsData = null; closeSheet(); toast('已退出'); go('mytrips'); });

/* ================= 開團人工具 ================= */
routes.gowner = (id) => asyncView(id, () => loadTrip(id, true), d => {
  if (!d.me.isOwner) return header('開團人工具', 'g/' + enc(id)) + '<div class="pad"><div class="note amber">只有開團人看得到這頁。</div></div>';
  startPoll(id);
  const st = d.trip.stage; const act = ACTIVE_STAGE(d);
  const nVoters = new Set(d.places.flatMap(p => p.voters)).size;
  let card = '';
  if (st === 'collect') card = `<h2 style="margin:0;font-size:18px">清單收到 ${d.places.filter(p => p.status === 'active').length} 個點、${nVoters} 人投過票</h2>
    <p class="sub" style="margin:0;line-height:1.6">覺得差不多了，就結束收集，挑出要交給 AI 排的點。</p>
    <button class="btn" data-go="gpick/${enc(id)}">結束收集，挑要排的點</button>`;
  else if (st === 'plan' && !d.itinerary) card = `<h2 style="margin:0;font-size:18px">挑好了，請 AI 排行程</h2>
    <p class="sub" style="margin:0;line-height:1.6">複製提示詞，貼到你自己的 AI（ChatGPT、Claude、Gemini 都可以），再把回覆貼回來。</p>
    <button class="btn" data-go="gprompt/${enc(id)}">複製提示詞</button><button class="btn2" data-go="gpaste/${enc(id)}">已經問好了，貼回行程</button>
    <button class="link" data-act="reopen" data-id="${esc(id)}">回到收集中，重新挑</button>`;
  else if (st === 'plan') card = `<h2 style="margin:0;font-size:18px">行程第 ${d.itinerary.ver} 版</h2>
    <p class="sub" style="margin:0;line-height:1.6">大家看過沒問題就定案，旅伴開始認領分工。之後新加的點會進候補。</p>
    <button class="btn" data-act="finalize" data-id="${esc(id)}">確認定案</button>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><button class="btn2" data-go="g/${enc(id)}/plan">看目前的行程</button><button class="btn2" data-go="gprompt/${enc(id)}">重新問 AI</button></div>`;
  else if (st === 'final') card = `<h2 style="margin:0;font-size:18px">已定案</h2><p class="sub" style="margin:0;line-height:1.6">出發吧！旅行結束、帳都結清後，封存這個團。</p>
    <button class="btn2" data-act="unfinalize" data-id="${esc(id)}">取消定案，行程還要改</button>`;
  else card = `<h2 style="margin:0;font-size:18px">${st === 'archived' ? '已封存' : '已取消'}</h2>`;
  const unsettled = d.settle.transfers.filter(x => x.status !== 'confirmed').length;
  const members = d.members.map(m => `<div class="rowitem" style="padding-right:6px"><span style="flex:1;font-size:16px">${esc(m.name)}${m.userId === d.me.userId ? '（你）' : ''}</span>${m.userId === d.me.userId ? '<span class="sub">開團人</span>' : act ? `<button class="act" style="border:none" data-act="resetPw" data-id="${esc(id)}" data-u="${esc(m.userId)}">重設密碼</button><button class="act" style="border:none;color:var(--mute)" data-act="removeM" data-id="${esc(id)}" data-u="${esc(m.userId)}">移除</button>` : ''}</div>`).join('');
  return header('開團人工具', 'g/' + enc(id), '') + `<div class="pad stack" style="padding-bottom:32px">
    <div class="sub" style="margin-top:-6px">${esc(d.trip.title)} · 只有你看得到這頁</div>
    <section class="card" style="padding:18px;display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;align-items:center;gap:6px;font-size:13px;flex-wrap:wrap">${STAGES.map((s, k) => `<span style="padding:4px 10px;border-radius:999px;${s[0] === st ? 'background:var(--sage);color:#fff;font-weight:700' : 'color:var(--sage);background:var(--sage-l)'}">${k + 1} ${s[1]}</span>`).join('<span style="color:var(--mute)">›</span>')}</div>
      ${card}</section>
    ${d.trip.transferTo ? `<div class="note amber">等 ${esc(d.trip.transferToName)} 按「接手」。<button class="link" style="display:inline;min-height:0;padding:0" data-act="cancelTransfer" data-id="${esc(id)}">取消交接</button></div>` : ''}
    <div style="display:flex;align-items:center;justify-content:space-between"><h2 class="sec" style="margin:0">成員 ${d.members.length} / ${d.trip.maxPeople}</h2>${act ? `<button class="hbtn" data-go="invite/${enc(id)}">邀請</button>` : ''}</div>
    <div class="card list">${members}</div>
    ${act ? `<div class="card list">
      <button class="rowitem" style="width:100%;border:none;border-bottom:1px solid var(--line2);background:none;text-align:left" data-go="g/${enc(id)}/tasks"><span style="flex:1">指派／改派分工</span>${ICON.chev}</button>
      <button class="rowitem" style="width:100%;border:none;border-bottom:1px solid var(--line2);background:none;text-align:left" data-act="versions" data-id="${esc(id)}"><span style="flex:1">行程版本紀錄與還原</span>${ICON.chev}</button>
      <button class="rowitem" style="width:100%;border:none;border-bottom:1px solid var(--line2);background:none;text-align:left" data-act="editTrip" data-id="${esc(id)}"><span style="flex:1">改團名、日期、人數</span>${ICON.chev}</button>
      <button class="rowitem" style="width:100%;border:none;border-bottom:1px solid var(--line2);background:none;text-align:left" data-act="regen" data-id="${esc(id)}"><span style="flex:1">重新產生邀請連結（舊連結失效）</span></button>
      <button class="rowitem" style="width:100%;border:none;border-bottom:1px solid var(--line2);background:none;text-align:left" data-go="transfer/${enc(id)}"><span style="flex:1">把開團人交給別人</span>${ICON.chev}</button>
      <button class="rowitem" style="width:100%;border:none;border-bottom:1px solid var(--line2);background:none;text-align:left" data-act="archive" data-id="${esc(id)}"><span style="flex:1;display:flex;flex-direction:column"><span>旅行結束，封存這個團</span>${unsettled ? `<span style="font-size:13px;color:var(--amber2)">還有 ${unsettled} 筆帳沒結清，要先結清才能封存</span>` : ''}</span></button>
      <button class="rowitem" style="width:100%;border:none;background:none;text-align:left;color:var(--bad)" data-go="gcancel/${enc(id)}"><span style="flex:1">取消這個團（不去了）</span>${ICON.chev}</button>
    </div>` : ''}
  </div>`;
});
ACT.reopen = el => run(el, async () => { await api('reopenCollect', { tripId: el.dataset.id }); await loadTrip(el.dataset.id, true); render(); });
ACT.finalize = el => run(el, async () => { await api('finalize', { tripId: el.dataset.id }); await loadTrip(el.dataset.id, true); toast('定案了！旅伴可以認領分工'); go('g/' + el.dataset.id + '/tasks'); });
ACT.unfinalize = el => run(el, async () => { await api('finalize', { tripId: el.dataset.id, undo: true }); await loadTrip(el.dataset.id, true); render(); });
ACT.cancelTransfer = el => run(el, async () => { await api('transferOwner', { tripId: el.dataset.id, userId: '' }); await loadTrip(el.dataset.id, true); render(); });
ACT.resetPw = el => {
  const d = GC[el.dataset.id]; const m = d.members.find(x => x.userId === el.dataset.u);
  openSheet(`<div class="pad stack"><b style="font-size:18px">幫 ${esc(m.name)} 重設密碼？</b><div class="note blue">會產生一組 6 位數臨時密碼，24 小時內有效。${esc(m.name)} 用它登入後，要設新密碼。他原本的密碼也還能用。</div>
    <button class="btn" data-act="resetPw2" data-id="${esc(el.dataset.id)}" data-u="${esc(m.userId)}">產生臨時密碼</button><button class="link" data-act="closeSheet">取消</button></div>`);
};
ACT.resetPw2 = el => run(el, async () => {
  const r = await api('resetMemberPw', { tripId: el.dataset.id, userId: el.dataset.u });
  openSheet(`<div class="pad stack"><b style="font-size:18px">${esc(r.name)} 的臨時密碼</b><div style="font-size:40px;font-weight:700;letter-spacing:6px;text-align:center;padding:12px;background:#fff;border-radius:16px">${esc(r.temp)}</div>
    <div class="hint">私訊給 ${esc(r.name)}，24 小時內有效。這組密碼只會顯示這一次。</div><button class="btn" data-act="copyTemp" data-v="${esc(r.temp)}">複製</button><button class="link" data-act="closeSheet">關閉</button></div>`);
});
ACT.copyTemp = async el => { const ok = await copyText(el.dataset.v); toast(ok ? '已複製' : '複製失敗'); };
ACT.removeM = el => {
  const d = GC[el.dataset.id]; const m = d.members.find(x => x.userId === el.dataset.u);
  openSheet(`<div class="pad stack"><b style="font-size:18px">把 ${esc(m.name)} 移出團？</b><div class="note amber">他認領的事會變回沒人認領；記過的帳會留著。之後可以再用邀請連結加回來。</div>
    <button class="btn terra" data-act="removeM2" data-id="${esc(el.dataset.id)}" data-u="${esc(m.userId)}">移出</button><button class="link" data-act="closeSheet">不要</button></div>`);
};
ACT.removeM2 = el => run(el, async () => { await api('removeMember', { tripId: el.dataset.id, userId: el.dataset.u }); closeSheet(); await loadTrip(el.dataset.id, true); render(); });
ACT.regen = el => run(el, async () => { await api('regenInvite', { tripId: el.dataset.id }); await loadTrip(el.dataset.id, true); toast('新的邀請連結好了，舊的失效'); go('invite/' + el.dataset.id); });
ACT.archive = el => run(el, async () => { await api('archiveTrip', { tripId: el.dataset.id }); myTripsData = null; await loadTrip(el.dataset.id, true); toast('封存了，隨時可以回來看'); go('ended'); });
ACT.versions = el => {
  const d = GC[el.dataset.id]; const vs = [...d.versions].sort((a, b) => b.ver - a.ver);
  const fmt = at => { const x = new Date(at); return (x.getMonth() + 1) + '/' + x.getDate() + ' ' + String(x.getHours()).padStart(2, '0') + ':' + String(x.getMinutes()).padStart(2, '0'); };
  openSheet(`<div class="pad stack"><b style="font-size:18px">行程版本</b>
    ${vs.length ? `<div class="card list">${vs.map(v => `<div class="rowitem"><span style="flex:1;display:flex;flex-direction:column"><b>第 ${v.ver} 版${d.itinerary && v.ver === d.itinerary.ver ? '（現在）' : ''}</b><span class="sub">${esc(v.by)} · ${fmt(v.at)}${v.note ? ' · ' + esc(v.note) : ''}</span></span>${d.itinerary && v.ver !== d.itinerary.ver ? `<button class="act" data-act="restoreVer" data-id="${esc(el.dataset.id)}" data-v="${v.ver}">還原</button>` : ''}</div>`).join('')}</div>` : '<div class="sub">還沒有行程。</div>'}
    <div class="hint">還原會存成新的一版，舊版本都會留著。</div><button class="link" data-act="closeSheet">關閉</button></div>`);
};
ACT.restoreVer = el => run(el, async () => { await api('restoreVersion', { tripId: el.dataset.id, ver: +el.dataset.v }); closeSheet(); await loadTrip(el.dataset.id, true); toast('已還原'); go('g/' + el.dataset.id + '/plan'); });
ACT.editTrip = el => {
  const d = GC[el.dataset.id]; const t = d.trip;
  openSheet(`<div class="pad stack"><b style="font-size:18px">改團的資料</b>
    <div class="field"><label class="lbl" for="etTitle">團名</label><input id="etTitle" class="inp" value="${esc(t.title)}"></div>
    <div class="field"><label class="lbl" for="etDest">目的地</label><input id="etDest" class="inp" value="${esc(t.dest)}"></div>
    <div class="field"><label class="lbl" for="etDate">出發日</label><input id="etDate" class="inp" type="date" value="${esc(t.startDate)}"></div>
    <div class="field"><label class="lbl" for="etDays">幾天</label><input id="etDays" class="inp" type="number" min="1" max="14" value="${t.days}"></div>
    <div class="field"><label class="lbl" for="etMax">最多幾人</label><input id="etMax" class="inp" type="number" min="2" max="6" value="${t.maxPeople}"></div>
    <button class="btn" data-act="editTrip2" data-id="${esc(el.dataset.id)}">存檔</button><button class="link" data-act="closeSheet">取消</button></div>`);
};
ACT.editTrip2 = el => run(el, async () => { await api('editTrip', { tripId: el.dataset.id, title: $('#etTitle').value, dest: $('#etDest').value, startDate: $('#etDate').value, days: +$('#etDays').value, maxPeople: +$('#etMax').value }); closeSheet(); await loadTrip(el.dataset.id, true); render(); toast('改好了'); });

/* ---- 挑點 ---- */
let pickSel = {};
routes.gpick = (id) => asyncView(id, () => loadTrip(id, true), d => {
  const act = d.places.filter(p => p.status === 'active');
  if (!pickSel[id]) { pickSel[id] = new Set(act.filter(p => p.votes >= Math.max(1, Math.ceil(d.members.length / 2))).map(p => p.placeId)); }
  const sel = pickSel[id];
  return header('挑要排的點', 'gowner/' + enc(id)) + `<div class="pad stack" style="padding-bottom:16px">
    <div class="hint">票數當參考，你來拍板。已經幫你勾好過半數人按讚的點。沒勾的會進「候補」，之後還能排。</div>
    <div class="card list">${act.map(p => `<label class="rowitem" style="gap:12px"><input type="checkbox" data-pick="${esc(p.placeId)}" ${sel.has(p.placeId) ? 'checked' : ''} style="width:22px;height:22px;accent-color:var(--sage)"><span class="tag ${TYPE_CLS[p.type] || 't-play'}">${esc(p.type)}</span><span style="flex:1;display:flex;flex-direction:column"><b>${esc(p.name)}</b><span class="sub">${p.votes} 票${p.voters.length ? '：' + esc(p.voters.join('、')) : ''}</span></span></label>`).join('') || '<div class="rowitem sub">清單是空的，也可以直接讓 AI 自由排。</div>'}</div>
  </div>
  <div class="foot"><button class="btn" data-act="endCollect" data-id="${esc(id)}">結束收集（挑了 ${sel.size} 個）</button><span class="hint" style="text-align:center">結束後旅伴新加的點會進候補</span></div>`;
});
document.addEventListener('change', e => { const p = e.target.dataset.pick; if (p) { const id = location.hash.split('/')[1]; const s = pickSel[id]; if (e.target.checked) s.add(p); else s.delete(p); render(); } });
ACT.endCollect = el => run(el, async () => { const id = el.dataset.id; await api('endCollect', { tripId: id, picks: [...pickSel[id]] }); delete pickSel[id]; await loadTrip(id, true); go('gprompt/' + id); });

/* ---- 提示詞 ---- */
function buildGroupPrompt(d, extra) {
  const f = { place: d.trip.dest || d.trip.title, date: d.trip.startDate || ymd(new Date()), span: ['一天', '一天', '兩天一夜', '三天兩夜'][Math.min(d.trip.days, 3)] || d.trip.days + ' 天', mode: d.trip.mode, meals: meals().filter(m => m.on).map(m => m.k), start: LS.get('lastStart', ''), people: d.members.length, kids: false, budget: '', extra: '' };
  let p = buildPrompt(f);
  if (d.trip.days > 3) p = p.replace(/日期：.*\n/, `日期：從 ${f.date} 起共 ${d.trip.days} 天\n`);
  const picked = d.places.filter(x => x.status === 'picked');
  const lines = [];
  lines.push(`這是 ${d.members.length} 個人一起去的團「${d.trip.title}」。`);
  if (picked.length) lines.push('一定要排（依票數）：' + picked.map(x => `${x.name}（${x.type}，${x.votes} 票）`).join('、'));
  if (extra) lines.push('補充：' + extra);
  return p.replace('\n\n規則：', '\n' + lines.join('\n') + '\n\n規則：');
}
routes.gprompt = (id) => asyncView(id, () => loadTrip(id, true), d => {
  const extra = sessionStorage.getItem('lg.gextra.' + id) || '';
  const pr = buildGroupPrompt(d, extra);
  const [head, fixed] = pr.split('回覆：只回一段 JSON');
  return header('請 AI 排行程', 'gowner/' + enc(id)) + `<div class="pad stack" style="padding-bottom:16px">
    <div class="hint">用餐時段和吃喝玩偏好，照的是你自己的設定（<button class="link" style="display:inline;min-height:0;padding:0;font-size:13px" data-act="toPrefs">改偏好</button>）。</div>
    <div class="card" style="padding:14px;font-size:14px;line-height:1.6;white-space:pre-wrap;max-height:40vh;overflow:auto">${esc(head)}<span style="color:var(--mute)">回覆：只回一段 JSON…（格式固定，改了網頁會讀不懂，所以鎖住不給改）</span></div>
    <div class="field"><label class="lbl" for="gExtra">加一句補充給 AI（選填）</label><input id="gExtra" class="inp" value="${esc(extra)}" placeholder="例：第三天想 15:00 前回程" data-gextra="${esc(id)}"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px"><a class="btn2" href="https://chatgpt.com/" target="_blank" rel="noopener">ChatGPT</a><a class="btn2" href="https://claude.ai/new" target="_blank" rel="noopener">Claude</a><a class="btn2" href="https://gemini.google.com/app" target="_blank" rel="noopener">Gemini</a></div>
  </div>
  <div class="foot"><button class="btn" data-act="gCopyPrompt" data-id="${esc(id)}">複製提示詞</button><button class="link" data-go="gpaste/${enc(id)}">已經問好了，貼回行程</button></div>`;
});
document.addEventListener('input', e => { const k = e.target.dataset.gextra; if (k) sessionStorage.setItem('lg.gextra.' + k, e.target.value); });
ACT.toPrefs = () => { sessionStorage.setItem('lg.back', location.hash.slice(1)); go('prefs'); };
ACT.gCopyPrompt = async el => { const id = el.dataset.id; const ok = await copyText(buildGroupPrompt(GC[id], $('#gExtra').value.trim())); toast(ok ? '提示詞已複製，貼到你的 AI' : '複製失敗'); if (ok) setTimeout(() => go('gpaste/' + id), 600); };

/* ---- 貼回 ---- */
routes.gpaste = (id) => asyncView(id, () => loadTrip(id), d => {
  const key = 'gpaste.' + id; const val = LS.get(key, '');
  const chk = gCheck[id];
  const items = chk ? (chk.fatal ? [chk.fatal] : [...chk.errs.map(e => e.msg), ...chk.warns]) : [];
  return header('貼回行程', 'gowner/' + enc(id)) + `<div class="pad stack" style="padding-bottom:16px">
    ${d.itinerary ? `<div class="note amber">現在是第 ${d.itinerary.ver} 版。貼上新的會變成第 ${d.itinerary.ver + 1} 版，舊的留著可以還原。</div>` : ''}
    ${items.length ? `<div class="note terra"><b>有 ${items.length} 個地方看不懂</b><ul style="margin:8px 0 0;padding-left:20px">${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div><button class="btn2" data-act="gCopyFix" data-id="${esc(id)}">複製修正指令，貼給 AI</button>` : ''}
    <div class="field"><div style="display:flex;align-items:center;justify-content:space-between"><label class="lbl" for="gPasteBox">貼上 AI 的回覆</label><button class="hbtn" data-act="gClear" data-id="${esc(id)}">清空</button></div>
      <textarea id="gPasteBox" class="inp" data-gpaste="${esc(id)}" placeholder="長按貼上整段回覆">${esc(val)}</textarea></div>
  </div>
  <div class="foot"><button class="btn" data-act="gParse" data-id="${esc(id)}">${items.length ? 'AI 改好了，重新檢查' : '排成行程，大家都看得到'}</button>${chk && !chk.fatal && chk.okCount ? `<button class="link" data-act="gUsePartial" data-id="${esc(id)}">先用讀得懂的 ${chk.okCount} 站</button>` : ''}</div>`;
});
const gCheck = {};
document.addEventListener('input', e => { const k = e.target.dataset.gpaste; if (k) LS.set('gpaste.' + k, e.target.value); });
ACT.gClear = el => { LS.set('gpaste.' + el.dataset.id, ''); delete gCheck[el.dataset.id]; render(); setTimeout(() => $('#gPasteBox') && $('#gPasteBox').focus(), 50); };
ACT.gCopyFix = async el => { const c = gCheck[el.dataset.id]; lastCheck = c; await ACT.copyFix(); };
async function gSave(id, data) {
  normalize(data);
  const d = GC[id]; data.days.forEach((x, i) => { if (!x.date) x.date = addDays(d.trip.startDate || ymd(new Date()), i); });
  await api('saveItinerary', { tripId: id, data, note: 'AI 排的' });
  LS.set('gpaste.' + id, ''); delete gCheck[id];
  await loadTrip(id, true); toast('行程貼好了，旅伴都看得到'); go('g/' + id + '/plan');
}
ACT.gParse = el => run(el, async () => {
  const id = el.dataset.id; const text = $('#gPasteBox').value; LS.set('gpaste.' + id, text);
  if (!text.trim()) { toast('先貼上 AI 的回覆'); return; }
  let data; try { data = extractJSON(text); } catch (e) { gCheck[id] = { fatal: e.message }; render(); return; }
  const v = validate(data);
  if (v.errs.length || v.warns.length) { gCheck[id] = { data, ...v }; render(); return; }
  await gSave(id, data);
});
ACT.gUsePartial = el => run(el, async () => { await gSave(el.dataset.id, gCheck[el.dataset.id].data); });

/* ---- 交給別人、取消團、已結束 ---- */
routes.transfer = (id) => asyncView(id, () => loadTrip(id, true), d => {
  const others = d.members.filter(m => m.userId !== d.me.userId);
  return header('把開團人交給別人', 'gowner/' + enc(id)) + `<div class="pad stack">
    <p class="sub" style="margin:0;line-height:1.6">交出去之後，你變成一般旅伴，開團人工具會移到對方那邊，你開的團名額也會少一個。</p>
    ${others.length ? `<div class="card list">${others.map((m, i) => `<label class="rowitem" style="gap:12px"><input type="radio" name="to" value="${esc(m.userId)}" ${i === 0 ? 'checked' : ''} style="width:22px;height:22px;accent-color:var(--sage)">${avatar(m.name)}<span style="flex:1;font-size:16px;font-weight:700">${esc(m.name)}</span></label>`).join('')}</div>
    <div class="note amber">對方會在「我的行程」看到通知，要按「接手」才算交接完成。對方開的團已滿 ${d.maxOwned} 個就不能接。</div>` : '<div class="note amber">團裡還沒有其他人，先邀請旅伴。</div>'}
  </div>
  <div class="foot">${others.length ? `<button class="btn" data-act="doTransfer" data-id="${esc(id)}">請對方接手</button>` : ''}<button class="link" data-go="gowner/${enc(id)}">先不要</button></div>`;
});
ACT.doTransfer = el => run(el, async () => { const u = document.querySelector('input[name="to"]:checked').value; await api('transferOwner', { tripId: el.dataset.id, userId: u }); await loadTrip(el.dataset.id, true); toast('已送出，等對方接手'); go('gowner/' + el.dataset.id); });
routes.gcancel = (id) => asyncView(id, () => loadTrip(id, true), d => {
  const hasExp = d.expenses.length > 0;
  return header('取消這個團', 'gowner/' + enc(id)) + `<div class="pad stack">
    <div class="sub">${esc(d.trip.title)} · 只有開團人能做</div>
    <div class="note terra" style="line-height:1.8"><b style="font-size:17px">確定不去了嗎？</b><br>• 大家都看不到這團了：清單、行程、分工一起收起來。<br>• 會通知 ${d.members.length - 1} 位旅伴。<br>• 30 天內可以在「已結束的團」救回來，之後才真的刪掉。<br>• 名額馬上空出來，你可以再開一個新團。</div>
    ${hasExp ? `<div class="note amber"><b>這團已經記過帳，不能取消</b><br>有人已經付了錢，要先結清，再用「旅行結束，封存這個團」收起來，免得帳對不回來。</div>` :
      `<div class="note ok">這團還沒有任何花費紀錄，可以直接取消。</div>
       <div class="field"><label class="lbl" for="cfName">輸入團名「${esc(d.trip.title)}」確認</label><input id="cfName" class="inp" autocomplete="off"><span class="hint">避免手滑按到</span></div>`}
  </div>
  <div class="foot">${hasExp ? `<button class="btn" data-go="settle/${enc(id)}">去結清</button>` : `<button class="btn terra" data-act="doCancel" data-id="${esc(id)}">取消這個團</button>`}<button class="link" data-go="gowner/${enc(id)}">不要，回開團人工具</button></div>`;
});
ACT.doCancel = el => run(el, async () => { await api('cancelTrip', { tripId: el.dataset.id, confirm: $('#cfName').value.trim() }); myTripsData = null; delete GC[el.dataset.id]; sessionStorage.setItem('lg.cancelled', '1'); go('ended'); });
let endedData = null;
routes.ended = () => {
  if (!loggedIn()) return routes.login();
  if (!endedData) { api('ended').then(r => { endedData = r.trips; render(); }).catch(e => toast(e.message)); return header('已結束的團', 'mytrips') + '<div class="pad"><div class="note blue">載入中…</div></div>'; }
  const list = endedData; setTimeout(() => { endedData = null; }, 0);
  const cancelled = list.filter(t => t.stage === 'cancelled'), archived = list.filter(t => t.stage === 'archived');
  const msg = sessionStorage.getItem('lg.cancelled'); sessionStorage.removeItem('lg.cancelled');
  return header('已結束的團', 'mytrips') + `<div class="pad stack" style="padding-bottom:32px">
    ${msg ? '<div class="note ok" role="status"><b>已取消，旅伴都收到通知了</b></div>' : ''}
    ${cancelled.length ? `<h2 class="sec" style="color:var(--terra-d)">最近取消（30 天內可還原）</h2>${cancelled.map(t => `<div class="card" style="padding:14px 16px;display:flex;align-items:center;gap:12px"><span style="flex:1;display:flex;flex-direction:column;gap:4px"><b style="font-size:17px">${esc(t.title)}</b><span class="sub">你取消的 · 還剩 ${t.daysLeft} 天</span></span><button class="act" data-act="restore" data-id="${esc(t.tripId)}">還原</button></div>`).join('')}` : ''}
    <h2 class="sec" style="color:var(--sage-d)">封存的團（只能看，不能改）</h2>
    ${archived.map(t => `<button class="card" data-go="g/${enc(t.tripId)}/plan" style="padding:14px 16px;text-align:left;width:100%"><b style="font-size:17px">${esc(t.title)}</b><br><span class="sub">${t.startDate ? esc(mdw(t.startDate)) + ' · ' : ''}${t.count} 人</span></button>`).join('') || '<div class="sub">還沒有封存的團。</div>'}
    <div class="hint">封存的團會一直留著當紀錄。取消的團 30 天後真的刪掉；旅伴看不到已取消的團。</div>
  </div><div class="foot"><button class="btn" data-go="mytrips">回我的行程</button></div>`;
};
ACT.restore = el => run(el, async () => { try { await api('restoreTrip', { tripId: el.dataset.id }); } catch (e) { if (e.code === 'ownedFull') { myTripsData = await api('myTrips'); go('ownedfull'); } throw e; } myTripsData = null; toast('還原了'); go('g/' + el.dataset.id); });

/* ================= 首頁：登入入口 ================= */
const baseHome = routes.home;
routes.home = () => {
  let h = baseHome();
  if (API_URL) h = h.replace(`<button class="link" data-go="prefs">吃喝玩偏好</button>`, (loggedIn() ? `<div class="hint" style="text-align:center">已登入為「${esc(session().user.name)}」</div>` : `<div class="hint" style="text-align:center">揪團才需要登入 · <button class="link" style="display:inline;min-height:0;padding:0" data-go="login">登入</button></div>`) + `<button class="link" data-go="prefs">吃喝玩偏好</button>`);
  return h.replace('存過的行程會放在這裡', '存過的行程、和旅伴一起規劃的團');
};

/* 從主畫面打開時，告訴後端「這個人有主畫面版」 */
if (isStandalone() && loggedIn() && !session().user.installed) { quiet(api('setInstalled').then(() => { const s = session(); s.user.installed = true; LS.set('session', s); })); }
/* 從 LINE/FB/IG 打開團連結：先導去 Safari */
if (inApp && !/Line\//i.test(navigator.userAgent) && /^#(g|join)\//.test(location.hash) && !sessionStorage.getItem('lg.ignoreInApp')) { sessionStorage.setItem('lg.inAppFrom', location.hash); }

render();
