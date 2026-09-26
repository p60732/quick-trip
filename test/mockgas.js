// 在 Node 裡模擬 Apps Script 環境，跑 Code.gs，並提供本機網站 + /api
const fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');

function makeSheet(name) {
  const data = [];
  const sh = {
    name, data,
    getDataRange: () => ({ getValues: () => data.length ? data.map(r => r.slice()) : [[]] }),
    getRange: (r, c, nr = 1, nc = 1) => ({
      setValues: (vals) => {
        for (let i = 0; i < nr; i++) {
          while (data.length < r + i) data.push([]);
          const row = data[r + i - 1];
          for (let j = 0; j < nc; j++) {
            let v = vals[i][j];
            if (typeof v === 'string' && v.startsWith("'")) v = v.slice(1);
            else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) v = new Date(v + 'T00:00:00+08:00'); // 模擬試算表自動轉日期
            else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
            row[c + j - 1] = v;
          }
        }
      },
      setNumberFormat: () => {}
    }),
    getLastRow: () => data.length,
    deleteRow: (r) => data.splice(r - 1, 1),
    setFrozenRows: () => {}
  };
  return sh;
}
const sheets = {};
const ss = {
  getSheetByName: n => sheets[n] || null,
  insertSheet: n => (sheets[n] = makeSheet(n)),
  deleteSheet: s => { delete sheets[s.name]; },
  getId: () => 'mock'
};
const ctx = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ss },
  LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
  Utilities: {
    getUuid: () => crypto.randomUUID(),
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
    computeDigest: (alg, s) => [...crypto.createHash('sha256').update(s, 'utf8').digest()].map(b => b > 127 ? b - 256 : b),
    formatDate: (d, tz, f) => new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10)
  },
  ContentService: { createTextOutput: s => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
  Logger: { log: (...a) => console.log('[Logger]', ...a) },
  module: { exports: {} }, console, Date, Math, JSON
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'gas/Code.gs'), 'utf8'), ctx);
const G = ctx.module.exports;
G.setup();
const boot = sheets.Settings.data.find(r => r[0] === 'bootstrapCode')[1];
fs.writeFileSync(path.join(require('os').tmpdir(), 'letsgo-bootcode.txt'), boot);

function call(body) { const out = G.doPost({ postData: { contents: JSON.stringify(body) } }); return JSON.parse(out.s); }
module.exports = { call, sheets, boot, G };

if (require.main === module) {
  const port = +process.env.PORT || 8766;
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
  http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/api')) {
      let b = ''; req.on('data', c => b += c); req.on('end', () => {
        const delay = +process.env.DELAY || 0;
        setTimeout(() => {
          const out = G.doPost({ postData: { contents: b } });
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(out.s);
        }, delay);
      });
      return;
    }
    let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); res.end('nf'); return; }
    let body = fs.readFileSync(f);
    if (p === '/index.html') body = Buffer.from(body.toString().replace(/const API_URL = '[^']*';/, "const API_URL = '/api';"));
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); res.end(body);
  }).listen(port, () => console.log('mock on', port, 'boot', boot));
}
