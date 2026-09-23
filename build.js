/* 建置：把資源內容雜湊掛到 index.html 的 ?v=，內容沒變就不換。node build.js */
'use strict';
var fs = require('fs'), crypto = require('crypto'), path = require('path');
var root = __dirname, html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
['css/style.css', 'js/logic.js', 'js/ui.js'].forEach(function (f) {
  var h = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex').slice(0, 8);
  var re = new RegExp('(' + f.replace(/[.\/]/g, '\\$&') + ')\\?v=[^"]*');
  if (!re.test(html)) { console.error('index.html 沒有引用 ' + f); process.exit(1); }
  html = html.replace(re, '$1?v=' + h);
  console.log(f + ' → ' + h);
});
fs.writeFileSync(path.join(root, 'index.html'), html);
