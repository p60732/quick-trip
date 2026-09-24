/* 連線積木：只負責跟 GAS 後端講話。統一回傳 data 或丟出帶中文訊息的 Error。 */
(function () {
  'use strict';
  var READS = { previewGroup: true, pull: true };   // 只有純讀取會自動重試；加入會建身分，不重送
  // 超過就放棄，避免「同步中…」卡住、輪詢停擺（測試可用 QT_CONFIG 調短）
  function cfg(k, d) { var c = window.QT_CONFIG || {}; return (typeof c[k] === 'number' && c[k] > 0) ? c[k] : d; }

  function url() { return (window.QT_CONFIG && window.QT_CONFIG.GAS_URL) || ''; }
  function configured() { return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url()); }

  function netErr(msg) { var e = new Error(msg); e.transient = true; return e; }

  function once(action, params) {
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, cfg('TIMEOUT_MS', 20000)) : null;
    return fetch(url(), {
      method: 'POST',
      // text/plain 避免 CORS 預檢；GAS 會 302 轉到 googleusercontent 回結果
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: action, params: params }),
      redirect: 'follow',
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      // Google 偶爾會短暫回 404 / 5xx，屬暫時性錯誤
      if (!r.ok) throw netErr('伺服器暫時沒回應（' + r.status + '）');
      return r.json();
    }, function (e) {
      if (e && e.name === 'AbortError') throw netErr('伺服器太久沒回應');
      throw netErr('連不上伺服器，請確認網路');
    }).then(function (j) {
      if (timer) clearTimeout(timer);
      return j;
    }, function (e) {
      if (timer) clearTimeout(timer);
      if (!e.transient && (e instanceof SyntaxError || /JSON/.test(String(e && e.message)))) throw netErr('伺服器回應看不懂');
      throw e;
    });
  }

  function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  function call(action, params) {
    if (!configured()) return Promise.reject(new Error('旅伴功能的後端還沒設定好'));
    var retried = false;
    var isRead = !!READS[action];
    function go() {
      return once(action, params).then(function (j) {
        // 換版那幾秒可能拿到健康檢查頁：讀取自動重試一次，寫入明確報錯（那次寫入沒有發生）
        if (j && j.health) {
          if (isRead && !retried) { retried = true; return go(); }
          throw new Error('伺服器剛好在更新，這次沒有存到，請再按一次');
        }
        if (!j || j.success !== true) throw new Error((j && j.error) || '連線失敗');
        return j.data;
      }, function (e) {
        // 讀取遇到暫時性錯誤：等一下再試一次；寫入不自動重送（可能已寫入，交給版本號判斷）
        if (e.transient && isRead && !retried) { retried = true; return wait(cfg('RETRY_DELAY_MS', 1500)).then(go); }
        if (e.transient) throw new Error(e.message + (isRead ? '，稍後會自動再同步' : '，這次可能沒存到，請重新整理確認'));
        throw e;
      });
    }
    return go();
  }

  window.TripSync = { configured: configured, call: call };
})();
