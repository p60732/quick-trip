/* 連線積木：只負責跟 GAS 後端講話。統一回傳 data 或丟出帶中文訊息的 Error。 */
(function () {
  'use strict';
  var READS = { joinGroup: true, pull: true };

  function url() { return (window.QT_CONFIG && window.QT_CONFIG.GAS_URL) || ''; }
  function configured() { return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url()); }

  function once(action, params) {
    return fetch(url(), {
      method: 'POST',
      // text/plain 避免 CORS 預檢；GAS 會 302 轉到 googleusercontent 回結果
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: action, params: params }),
      redirect: 'follow',
      cache: 'no-store'
    }).then(function (r) {
      if (!r.ok) throw new Error('伺服器回應異常（' + r.status + '）');
      return r.json();
    });
  }

  function call(action, params) {
    if (!configured()) return Promise.reject(new Error('旅伴功能的後端還沒設定好'));
    var retried = false;
    function go() {
      return once(action, params).then(function (j) {
        // 換版那幾秒可能拿到健康檢查頁：讀取自動重試一次，寫入明確報錯（那次寫入沒有發生）
        if (j && j.health) {
          if (READS[action] && !retried) { retried = true; return go(); }
          throw new Error('伺服器剛好在更新，這次沒有存到，請再按一次');
        }
        if (!j || j.success !== true) throw new Error((j && j.error) || '連線失敗');
        return j.data;
      });
    }
    return go().catch(function (e) {
      if (e instanceof TypeError || /JSON/.test(String(e && e.message))) throw new Error('連不上伺服器，請確認網路後再試');
      throw e;
    });
  }

  window.TripSync = { configured: configured, call: call };
})();
