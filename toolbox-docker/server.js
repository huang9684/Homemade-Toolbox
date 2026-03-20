/**
 * 个人工具箱 v5 - All-in-One Server
 * 功能：短链接 / 剪贴板 / 文件分享 / 编码转换
 *       文本对比(Diff) / JSON工具 / 密码生成 / 网络工具
 *       正则测试器 / 颜色转换 / 文本工具箱
 */

const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const url      = require('url');
const crypto   = require('crypto');
const busboy   = require('busboy');
const QRCode   = require('qrcode');
const Database = require('better-sqlite3');

// ── 配置 ────────────────────────────────────────────────────
const PORT             = process.env.PORT        || 3000;
const UPLOAD_DIR       = path.join(__dirname, 'uploads');
const DB_PATH          = path.join(__dirname, 'data', 'data.db');
const MAX_FILE_MB      = Number(process.env.MAX_FILE_MB)      || 50;
const FILE_EXPIRE_DAYS = Number(process.env.FILE_EXPIRE_DAYS) || 7;
const RATE_LIMIT_RPM   = Number(process.env.RATE_LIMIT_RPM)   || 60;

// ── 初始化目录 ───────────────────────────────────────────────
[UPLOAD_DIR, path.dirname(DB_PATH)].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── 初始化数据库 ─────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -2000');
db.exec(`
  CREATE TABLE IF NOT EXISTS short_links (
    code       TEXT PRIMARY KEY,
    url        TEXT NOT NULL,
    visits     INTEGER DEFAULT 0,
    max_visits INTEGER DEFAULT 0,
    password   TEXT DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS pastes (
    code       TEXT PRIMARY KEY,
    content    TEXT NOT NULL,
    lang       TEXT DEFAULT 'text',
    expire_at  INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS files (
    code       TEXT PRIMARY KEY,
    filename   TEXT NOT NULL,
    stored_as  TEXT NOT NULL,
    size       INTEGER,
    expire_at  INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS access_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ip         TEXT,
    method     TEXT,
    path       TEXT,
    status     INTEGER,
    ts         INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_log_ts ON access_log(ts);
`);

// 兼容旧数据库：添加新列
['max_visits INTEGER DEFAULT 0', 'password TEXT DEFAULT \'\''].forEach(col => {
  try { db.exec(`ALTER TABLE short_links ADD COLUMN ${col}`); } catch (_) {}
});

// ── 工具函数 ─────────────────────────────────────────────────
const genCode  = (len = 6) => crypto.randomBytes(len).toString('base64url').slice(0, len);
const now      = ()        => Math.floor(Date.now() / 1000);
const expireTs = days      => days > 0 ? now() + days * 86400 : null;

function formatSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function jsonRes(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function errRes(res, msg, status = 400) { jsonRes(res, { error: msg }, status); }

function readBody(req, maxBytes = 512000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => {
      if ((body + c).length > maxBytes) { reject(new Error('body too large')); return; }
      body += c;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ── 访问日志 ────────────────────────────────────────────────
const logStmt = db.prepare('INSERT INTO access_log (ip, method, path, status) VALUES (?, ?, ?, ?)');
function writeLog(ip, method, pathname, status) {
  try { logStmt.run(ip, method, pathname.slice(0, 200), status); } catch (_) {}
}

// ── 限速 ────────────────────────────────────────────────────
const ratemap = new Map();
function checkRate(ip) {
  const windowMs = 60 * 1000;
  const ts = Date.now();
  let hits = ratemap.get(ip) || [];
  hits = hits.filter(t => ts - t < windowMs);
  hits.push(ts);
  ratemap.set(ip, hits);
  return hits.length <= RATE_LIMIT_RPM;
}
setInterval(() => {
  const ts = Date.now();
  for (const [ip, hits] of ratemap) {
    if (!hits.some(t => ts - t < 60000)) ratemap.delete(ip);
  }
}, 5 * 60 * 1000);

// ── MIME 映射 ────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
};

// ── 统计 API ─────────────────────────────────────────────────
function handleStats(req, res) {
  const linkCount   = db.prepare('SELECT COUNT(*) as n FROM short_links').get().n;
  const pasteCount  = db.prepare('SELECT COUNT(*) as n FROM pastes').get().n;
  const fileCount   = db.prepare('SELECT COUNT(*) as n FROM files').get().n;
  const fileSize    = db.prepare('SELECT SUM(size) as s FROM files').get().s || 0;
  const totalVisits = db.prepare('SELECT SUM(visits) as v FROM short_links').get().v || 0;
  const since24h    = now() - 86400;
  const reqs24h     = db.prepare('SELECT COUNT(*) as n FROM access_log WHERE ts > ?').get(since24h).n;

  const daily = [];
  for (let i = 6; i >= 0; i--) {
    const start = now() - i * 86400;
    const end   = start + 86400;
    const count = db.prepare('SELECT COUNT(*) as n FROM access_log WHERE ts >= ? AND ts < ?').get(start, end).n;
    const d = new Date(start * 1000);
    daily.push({ date: `${d.getMonth()+1}/${d.getDate()}`, count });
  }

  jsonRes(res, {
    links:    { count: linkCount, totalVisits },
    pastes:   { count: pasteCount },
    files:    { count: fileCount, totalSize: fileSize, totalSizeHuman: formatSize(fileSize) },
    requests: { last24h: reqs24h, daily },
    server:   { uptime: Math.floor(process.uptime()), memMB: Math.round(process.memoryUsage().rss / 1024 / 1024), node: process.version }
  });
}

// ── 健康检查 ─────────────────────────────────────────────────
function handleHealth(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', uptime: Math.floor(process.uptime()) }));
}

// ── 短链接 ───────────────────────────────────────────────────
function handleLinkCreate(req, res) {
  readBody(req).then(body => {
    let data;
    try { data = JSON.parse(body); } catch { return errRes(res, '无效的 JSON'); }
    const { url: targetUrl, custom, max_visits = 0, password = '' } = data;
    if (!targetUrl) return errRes(res, '缺少 url 参数');
    try { new URL(targetUrl); } catch { return errRes(res, '无效的 URL'); }
    const code = custom ? custom.slice(0, 20).replace(/[^a-zA-Z0-9_-]/g, '') : genCode();
    if (!code) return errRes(res, '自定义短码无效');
    if (db.prepare('SELECT code FROM short_links WHERE code = ?').get(code)) return errRes(res, '该短码已被占用');
    const pwdHash = password ? crypto.createHash('sha256').update(String(password)).digest('hex').slice(0, 16) : '';
    db.prepare('INSERT INTO short_links (code, url, max_visits, password) VALUES (?, ?, ?, ?)').run(code, targetUrl, Number(max_visits) || 0, pwdHash);
    jsonRes(res, { code, short: `/s/${code}`, url: targetUrl });
  }).catch(() => errRes(res, '请求体过大'));
}

function handleLinkList(req, res) {
  jsonRes(res, db.prepare('SELECT code, url, visits, max_visits, created_at, CASE WHEN password!=\'\' THEN 1 ELSE 0 END as has_password FROM short_links ORDER BY created_at DESC LIMIT 200').all());
}

function handleLinkDelete(req, res, code) {
  db.prepare('DELETE FROM short_links WHERE code = ?').run(code);
  jsonRes(res, { ok: true });
}

function handleLinkRedirect(req, res, code) {
  const row = db.prepare('SELECT * FROM short_links WHERE code = ?').get(code);
  if (!row) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2 style="font-family:sans-serif;color:#555;padding:2rem">短链接不存在或已删除</h2>');
    return;
  }
  // 访问次数上限检查
  if (row.max_visits > 0 && row.visits >= row.max_visits) {
    res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2 style="font-family:sans-serif;color:#555;padding:2rem">该短链接已达到访问次数上限</h2>');
    return;
  }
  // 密码保护
  if (row.password) {
    const parsed = new URL(req.url, 'http://x');
    const pwd = parsed.searchParams.get('pwd') || '';
    const pwdHash = pwd ? crypto.createHash('sha256').update(pwd).digest('hex').slice(0, 16) : '';
    if (pwdHash !== row.password) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>访问受保护的短链接</title>
<style>body{font-family:'Segoe UI',sans-serif;background:#0f1117;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.box{background:#1a1d2e;border:1px solid #2e3250;border-radius:12px;padding:2rem;width:340px;text-align:center;}
h3{color:#6c63ff;margin-bottom:1rem;}p{color:#8892b0;font-size:.88rem;margin-bottom:1.2rem;}
input{width:100%;background:#242740;border:1px solid #2e3250;color:#e2e8f0;padding:.6rem .9rem;border-radius:8px;font-size:.9rem;margin-bottom:.9rem;box-sizing:border-box;outline:none;}
button{background:#6c63ff;color:#fff;border:none;padding:.6rem 1.5rem;border-radius:8px;cursor:pointer;font-size:.9rem;width:100%;}
.err{color:#ff6b6b;font-size:.82rem;margin-top:.5rem;display:none;}
</style></head><body><div class="box">
<h3>🔒 受保护的链接</h3>
<p>此短链接需要密码才能访问</p>
<form onsubmit="go(event)">
<input type="password" id="p" placeholder="请输入访问密码" autofocus>
<button type="submit">访问</button>
<div class="err" id="err">${pwd ? '密码错误，请重试' : ''}</div>
</form>
</div>
<script>
${pwd ? 'document.getElementById("err").style.display="block";' : ''}
function go(e){e.preventDefault();const p=document.getElementById('p').value;if(p)window.location='/s/${code}?pwd='+encodeURIComponent(p);}
</script></body></html>`);
      return;
    }
  }
  db.prepare('UPDATE short_links SET visits = visits + 1 WHERE code = ?').run(code);
  res.writeHead(302, { Location: row.url });
  res.end();
}

// ── 剪贴板 ───────────────────────────────────────────────────
function handlePasteCreate(req, res) {
  readBody(req).then(body => {
    let data;
    try { data = JSON.parse(body); } catch { return errRes(res, '无效的 JSON'); }
    const { content, lang = 'text', expire = 7 } = data;
    if (!content || !content.trim()) return errRes(res, '内容不能为空');
    if (content.length > 500000) return errRes(res, '内容过长（最大 500KB）');
    const code = genCode(8);
    db.prepare('INSERT INTO pastes (code, content, lang, expire_at) VALUES (?, ?, ?, ?)').run(code, content, lang, expireTs(Number(expire)));
    jsonRes(res, { code, link: `/p/${code}` });
  }).catch(() => errRes(res, '请求体过大'));
}

function handlePasteGet(req, res, code) {
  const row = db.prepare('SELECT * FROM pastes WHERE code = ?').get(code);
  if (!row) return errRes(res, '不存在或已过期', 404);
  if (row.expire_at && row.expire_at < now()) {
    db.prepare('DELETE FROM pastes WHERE code = ?').run(code);
    return errRes(res, '已过期', 404);
  }
  jsonRes(res, row);
}

function handlePasteList(req, res) {
  db.prepare('DELETE FROM pastes WHERE expire_at IS NOT NULL AND expire_at < ?').run(now());
  jsonRes(res, db.prepare('SELECT code, lang, LENGTH(content) as size, expire_at, created_at FROM pastes ORDER BY created_at DESC LIMIT 200').all());
}

function handlePasteDelete(req, res, code) {
  db.prepare('DELETE FROM pastes WHERE code = ?').run(code);
  jsonRes(res, { ok: true });
}

// ── 文件分享 ─────────────────────────────────────────────────
function handleFileUpload(req, res) {
  const maxBytes = MAX_FILE_MB * 1024 * 1024;
  let totalBytes = 0, finished = false;
  const bb = busboy({ headers: req.headers, limits: { fileSize: maxBytes } });
  const code = genCode(8);
  let origName = 'file', storedAs = '', fileSize = 0;

  bb.on('file', (_, file, info) => {
    origName = Buffer.from(info.filename, 'latin1').toString('utf8') || 'file';
    const ext = path.extname(origName).replace(/[^a-zA-Z0-9.]/g, '');
    storedAs  = code + (ext || '');
    const dest = path.join(UPLOAD_DIR, storedAs);
    const ws   = fs.createWriteStream(dest);
    file.on('data', chunk => { totalBytes += chunk.length; });
    file.on('limit', () => {
      ws.destroy(); fs.unlink(dest, () => {});
      if (!finished) { finished = true; errRes(res, `文件超过 ${MAX_FILE_MB}MB 限制`); }
    });
    file.pipe(ws);
    ws.on('finish', () => { fileSize = totalBytes; });
  });

  bb.on('finish', () => {
    if (finished) return; finished = true;
    if (!storedAs) return errRes(res, '没有收到文件');
    db.prepare('INSERT INTO files (code, filename, stored_as, size, expire_at) VALUES (?, ?, ?, ?, ?)').run(code, origName, storedAs, fileSize, expireTs(FILE_EXPIRE_DAYS));
    jsonRes(res, { code, filename: origName, size: fileSize, link: `/f/${code}`, download: `/download/${code}` });
  });

  bb.on('error', err => { if (!finished) { finished = true; errRes(res, '上传失败: ' + err.message); } });
  req.pipe(bb);
}

function handleFileList(req, res) {
  db.prepare('DELETE FROM files WHERE expire_at IS NOT NULL AND expire_at < ?').run(now());
  jsonRes(res, db.prepare('SELECT code, filename, size, expire_at, created_at FROM files ORDER BY created_at DESC LIMIT 200').all());
}

function handleFileDownload(req, res, code) {
  const row = db.prepare('SELECT * FROM files WHERE code = ?').get(code);
  if (!row) { res.writeHead(404); res.end('文件不存在'); return; }
  if (row.expire_at && row.expire_at < now()) {
    db.prepare('DELETE FROM files WHERE code = ?').run(code);
    res.writeHead(410); res.end('文件已过期'); return;
  }
  const filePath = path.join(UPLOAD_DIR, row.stored_as);
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('文件丢失'); return; }
  res.writeHead(200, {
    'Content-Type':        'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
    'Content-Length':      row.size
  });
  fs.createReadStream(filePath).pipe(res);
}

function handleFileDelete(req, res, code) {
  const row = db.prepare('SELECT stored_as FROM files WHERE code = ?').get(code);
  if (row) {
    const fp = path.join(UPLOAD_DIR, row.stored_as);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    db.prepare('DELETE FROM files WHERE code = ?').run(code);
  }
  jsonRes(res, { ok: true });
}

// ── 编码转换 API ──────────────────────────────────────────────
async function handleEncode(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return errRes(res, '无效的 JSON'); }
  const { type, input, file_code } = body;
  if (!type) return errRes(res, '缺少 type 参数');

  let data;
  if (file_code) {
    const row = db.prepare('SELECT stored_as FROM files WHERE code = ?').get(file_code);
    if (!row) return errRes(res, '文件不存在');
    const fp = path.join(UPLOAD_DIR, row.stored_as);
    if (!fs.existsSync(fp)) return errRes(res, '文件丢失');
    data = fs.readFileSync(fp);
  } else {
    if (input === undefined || input === null) return errRes(res, '缺少 input 参数');
    data = Buffer.from(String(input), 'utf8');
  }

  try {
    switch (type) {
      case 'md5':    return jsonRes(res, { result: crypto.createHash('md5').update(data).digest('hex') });
      case 'sha1':   return jsonRes(res, { result: crypto.createHash('sha1').update(data).digest('hex') });
      case 'sha256': return jsonRes(res, { result: crypto.createHash('sha256').update(data).digest('hex') });
      case 'sha512': return jsonRes(res, { result: crypto.createHash('sha512').update(data).digest('hex') });
      case 'base64_encode': return jsonRes(res, { result: data.toString('base64') });
      case 'base64_decode': return jsonRes(res, { result: Buffer.from(data.toString('utf8').trim(), 'base64').toString('utf8') });
      case 'url_encode':    return jsonRes(res, { result: encodeURIComponent(data.toString('utf8')) });
      case 'url_decode':    return jsonRes(res, { result: decodeURIComponent(data.toString('utf8')) });
      case 'hex_encode':    return jsonRes(res, { result: data.toString('hex') });
      case 'hex_decode':    return jsonRes(res, { result: Buffer.from(data.toString('utf8').trim().replace(/\s+/g,''), 'hex').toString('utf8') });
      case 'qrcode': {
        const text = data.toString('utf8').trim();
        if (!text) return errRes(res, '内容不能为空');
        if (text.length > 2000) return errRes(res, '内容过长（最大 2000 字符）');
        const dataUrl = await QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width: 300 });
        return jsonRes(res, { result: dataUrl, type: 'image' });
      }
      default: return errRes(res, `不支持的转换类型: ${type}`);
    }
  } catch (e) {
    return errRes(res, '转换失败: ' + e.message);
  }
}

// ── 文本对比（Myers Diff 算法）────────────────────────────────
function myersDiff(a, b) {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const N = aLines.length, M = bLines.length;
  const MAX = N + M;
  const v = new Array(2 * MAX + 1).fill(0);
  const trace = [];

  for (let d = 0; d <= MAX; d++) {
    trace.push([...v]);
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[k - 1 + MAX] < v[k + 1 + MAX])) {
        x = v[k + 1 + MAX];
      } else {
        x = v[k - 1 + MAX] + 1;
      }
      let y = x - k;
      while (x < N && y < M && aLines[x] === bLines[y]) { x++; y++; }
      v[k + MAX] = x;
      if (x >= N && y >= M) {
        const result = [];
        let cx = x, cy = y;
        for (let dd = d; dd > 0; dd--) {
          const pv = trace[dd - 1];
          const pk = cx - cy;
          let px, py;
          if (pk === -dd || (pk !== dd && pv[pk - 1 + MAX] < pv[pk + 1 + MAX])) {
            px = pv[pk + 1 + MAX]; py = px - (pk + 1);
          } else {
            px = pv[pk - 1 + MAX] + 1; py = px - (pk - 1);
          }
          while (cx > px && cy > py) { cx--; cy--; result.unshift({ type: 'eq', line: aLines[cx] }); }
          if (dd > 0) {
            if (cx > px) { cx--; result.unshift({ type: 'del', line: aLines[cx] }); }
            else         { cy--; result.unshift({ type: 'ins', line: bLines[cy] }); }
          }
        }
        while (cx > 0 && cy > 0) { cx--; cy--; result.unshift({ type: 'eq', line: aLines[cx] }); }
        return result;
      }
    }
  }
  const result = [];
  aLines.forEach(l => result.push({ type: 'del', line: l }));
  bLines.forEach(l => result.push({ type: 'ins', line: l }));
  return result;
}

function handleDiff(req, res) {
  readBody(req, 1024 * 200).then(raw => {
    let body;
    try { body = JSON.parse(raw); } catch { return errRes(res, '无效的 JSON'); }
    const { left = '', right = '' } = body;
    if (left.length > 100000 || right.length > 100000) return errRes(res, '文本过长（每段最大 100KB）');
    const diff = myersDiff(left, right);
    const stats = { eq: 0, del: 0, ins: 0 };
    diff.forEach(d => stats[d.type]++);
    jsonRes(res, { diff, stats });
  }).catch(e => errRes(res, e.message));
}

// ── JSON 工具 API ─────────────────────────────────────────────
function handleJsonTool(req, res) {
  readBody(req, 1024 * 512).then(raw => {
    let body;
    try { body = JSON.parse(raw); } catch { return errRes(res, '无效的请求 JSON'); }
    const { type, input } = body;
    if (!input) return errRes(res, '缺少 input');

    switch (type) {
      case 'format': {
        let parsed;
        try { parsed = JSON.parse(input); } catch (e) { return errRes(res, 'JSON 解析失败: ' + e.message); }
        return jsonRes(res, { result: JSON.stringify(parsed, null, 2), valid: true });
      }
      case 'minify': {
        let parsed;
        try { parsed = JSON.parse(input); } catch (e) { return errRes(res, 'JSON 解析失败: ' + e.message); }
        return jsonRes(res, { result: JSON.stringify(parsed), valid: true });
      }
      case 'validate': {
        try {
          const parsed = JSON.parse(input);
          const keyCount = typeof parsed === 'object' && parsed ? Object.keys(parsed).length : 0;
          return jsonRes(res, { valid: true, type: Array.isArray(parsed) ? 'array' : typeof parsed, keyCount });
        } catch (e) {
          const match = e.message.match(/position (\d+)/);
          const pos   = match ? Number(match[1]) : -1;
          let line = -1, col = -1;
          if (pos >= 0) {
            const before = input.slice(0, pos);
            line = before.split('\n').length;
            col  = before.length - before.lastIndexOf('\n');
          }
          return jsonRes(res, { valid: false, error: e.message, line, col });
        }
      }
      case 'json_to_yaml': {
        let parsed;
        try { parsed = JSON.parse(input); } catch (e) { return errRes(res, 'JSON 解析失败: ' + e.message); }
        return jsonRes(res, { result: jsonToYaml(parsed, 0).replace(/^\n/, '') });
      }
      default: return errRes(res, `不支持的操作: ${type}`);
    }
  }).catch(e => errRes(res, e.message));
}

function jsonToYaml(obj, indent) {
  const pad = '  '.repeat(indent);
  if (obj === null)          return 'null';
  if (typeof obj === 'boolean' || typeof obj === 'number') return String(obj);
  if (typeof obj === 'string') {
    if (obj.includes('\n') || obj.includes('"')) return `|\n${pad}  ` + obj.replace(/\n/g, `\n${pad}  `);
    return /[\s:{}[\],#&*?|<>=!%@`]/.test(obj) ? `"${obj.replace(/"/g, '\\"')}"` : obj;
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return obj.map(item => `\n${pad}- ${jsonToYaml(item, indent + 1)}`).join('');
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (keys.length === 0) return '{}';
    return keys.map(k => {
      const val = obj[k];
      const keyStr = `\n${pad}${k}:`;
      if (val !== null && typeof val === 'object') return keyStr + ' ' + jsonToYaml(val, indent + 1);
      return `${keyStr} ${jsonToYaml(val, indent + 1)}`;
    }).join('');
  }
  return String(obj);
}

// ── 密码生成器 API ────────────────────────────────────────────
function handlePassGen(req, res) {
  readBody(req).then(raw => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 使用默认值 */ }

    const length     = Math.min(Math.max(Number(body.length) || 16, 4), 128);
    const useUpper   = body.upper   !== false;
    const useLower   = body.lower   !== false;
    const useDigits  = body.digits  !== false;
    const useSymbols = body.symbols === true;
    const count      = Math.min(Math.max(Number(body.count) || 1, 1), 20);
    const excludeAmbiguous = body.noAmbiguous === true;

    let charset = '';
    if (useUpper)   charset += excludeAmbiguous ? 'ABCDEFGHJKLMNPQRSTUVWXYZ' : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (useLower)   charset += excludeAmbiguous ? 'abcdefghjkmnpqrstuvwxyz'  : 'abcdefghijklmnopqrstuvwxyz';
    if (useDigits)  charset += excludeAmbiguous ? '23456789' : '0123456789';
    if (useSymbols) charset += '!@#$%^&*()_+-=[]{}|;:,.<>?';
    if (!charset)   charset = 'abcdefghijklmnopqrstuvwxyz';

    const passwords = [];
    for (let i = 0; i < count; i++) {
      let pwd = '';
      const bytes = crypto.randomBytes(length * 2);
      for (let j = 0; j < length; j++) {
        pwd += charset[bytes[j * 2] % charset.length];
      }
      passwords.push(pwd);
    }

    const p = passwords[0];
    let strength = 0;
    if (p.length >= 8)  strength++;
    if (p.length >= 12) strength++;
    if (p.length >= 16) strength++;
    if (/[A-Z]/.test(p)) strength++;
    if (/[a-z]/.test(p)) strength++;
    if (/[0-9]/.test(p)) strength++;
    if (/[^A-Za-z0-9]/.test(p)) strength++;
    const levels = ['极弱', '弱', '一般', '较强', '强', '很强', '极强', '极强'];

    jsonRes(res, { passwords, strength: { score: strength, label: levels[strength] || '极强' } });
  }).catch(e => errRes(res, e.message));
}

// ── 网络工具 API ──────────────────────────────────────────────
function httpGet(urlStr, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const mod    = parsed.protocol === 'https:' ? https : http;
    const timer  = setTimeout(() => reject(new Error('请求超时')), timeout);
    const req    = mod.get(urlStr, { headers: { 'User-Agent': 'Toolbox/5.0' } }, r => {
      clearTimeout(timer);
      let data = '';
      r.on('data', c => { if (data.length < 65536) data += c; });
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: data }));
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

async function handleNetTool(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return errRes(res, '无效的 JSON'); }
  const { type } = body;

  switch (type) {
    case 'myip': {
      const ip = getClientIp(req);
      return jsonRes(res, { ip });
    }
    case 'ip_lookup': {
      const target = (body.ip || '').trim();
      if (!target) return errRes(res, '缺少 ip 参数');
      if (!/^[\d.a-fA-F:]+$/.test(target)) return errRes(res, 'IP 地址格式无效');
      try {
        const r = await httpGet(`http://ip-api.com/json/${encodeURIComponent(target)}?lang=zh-CN&fields=status,message,country,regionName,city,isp,org,as,query,lat,lon,timezone`);
        const data = JSON.parse(r.body);
        if (data.status !== 'success') return errRes(res, data.message || '查询失败');
        return jsonRes(res, data);
      } catch (e) { return errRes(res, '查询失败: ' + e.message); }
    }
    case 'http_status': {
      const code = Number(body.code);
      const STATUS_MAP = {
        100:'继续',101:'切换协议',102:'处理中',
        200:'成功',201:'已创建',202:'已接受',204:'无内容',206:'部分内容',
        301:'永久重定向',302:'临时重定向',303:'查看其他',304:'未修改',307:'临时重定向',308:'永久重定向',
        400:'错误请求',401:'未授权',403:'禁止访问',404:'未找到',405:'方法不允许',
        408:'请求超时',409:'冲突',410:'已消失',413:'请求体过大',414:'URI 过长',
        415:'不支持的媒体类型',422:'无法处理的实体',429:'请求过多',
        500:'服务器内部错误',501:'未实现',502:'网关错误',503:'服务不可用',504:'网关超时',
      };
      if (!STATUS_MAP[code]) return errRes(res, `未知的 HTTP 状态码: ${code}`);
      const categories = {1:'信息响应',2:'成功',3:'重定向',4:'客户端错误',5:'服务器错误'};
      return jsonRes(res, { code, text: STATUS_MAP[code], category: categories[Math.floor(code/100)] || '未知' });
    }
    case 'http_check': {
      const target = (body.url || '').trim();
      if (!target) return errRes(res, '缺少 url 参数');
      let parsed;
      try { parsed = new URL(target); } catch { return errRes(res, '无效的 URL'); }
      if (!['http:','https:'].includes(parsed.protocol)) return errRes(res, '仅支持 HTTP/HTTPS');
      const start = Date.now();
      try {
        const r = await httpGet(target, 8000);
        const ms = Date.now() - start;
        return jsonRes(res, { reachable: true, status: r.status, ms, server: r.headers['server'] || '-', contentType: r.headers['content-type'] || '-' });
      } catch (e) {
        return jsonRes(res, { reachable: false, error: e.message, ms: Date.now() - start });
      }
    }
    case 'timestamp': {
      const input = body.input;
      if (input === undefined) return errRes(res, '缺少 input');
      const num = Number(input);
      if (!isNaN(num) && String(input).trim() !== '') {
        const ts = num > 1e10 ? num : num * 1000;
        const d  = new Date(ts);
        return jsonRes(res, {
          ts_sec: Math.floor(ts / 1000), ts_ms: ts,
          utc: d.toUTCString(), local: d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
          iso: d.toISOString()
        });
      } else {
        const d = new Date(String(input));
        if (isNaN(d.getTime())) return errRes(res, '无效的日期格式');
        return jsonRes(res, { ts_sec: Math.floor(d.getTime() / 1000), ts_ms: d.getTime(), iso: d.toISOString() });
      }
    }
    default: return errRes(res, `不支持的操作: ${type}`);
  }
}

// ── 正则测试器 API ────────────────────────────────────────────
function handleRegex(req, res) {
  readBody(req, 1024 * 64).then(raw => {
    let body;
    try { body = JSON.parse(raw); } catch { return errRes(res, '无效的 JSON'); }
    const { pattern, flags = '', text = '' } = body;
    if (!pattern) return errRes(res, '缺少 pattern');
    if (text.length > 50000) return errRes(res, '测试文本过长（最大 50KB）');

    // 安全校验 flags
    const safeFlags = (flags || '').replace(/[^gimsuy]/g, '').slice(0, 6);
    let re;
    try { re = new RegExp(pattern, safeFlags); } catch (e) { return errRes(res, '正则表达式语法错误: ' + e.message); }

    const matches = [];
    let m;
    if (re.global || re.sticky) {
      re.lastIndex = 0;
      let safety = 0;
      while ((m = re.exec(text)) !== null && safety++ < 500) {
        matches.push({
          match:  m[0],
          index:  m.index,
          length: m[0].length,
          groups: m.slice(1),
          namedGroups: m.groups || null
        });
        if (m[0].length === 0) re.lastIndex++; // 防死循环
      }
    } else {
      m = re.exec(text);
      if (m) matches.push({
        match:  m[0],
        index:  m.index,
        length: m[0].length,
        groups: m.slice(1),
        namedGroups: m.groups || null
      });
    }

    return jsonRes(res, {
      matches,
      count:   matches.length,
      valid:   true,
      pattern, flags: safeFlags
    });
  }).catch(e => errRes(res, e.message));
}

// ── 文本工具箱 API ────────────────────────────────────────────
function handleTextTool(req, res) {
  readBody(req, 1024 * 256).then(raw => {
    let body;
    try { body = JSON.parse(raw); } catch { return errRes(res, '无效的 JSON'); }
    const { type, text = '' } = body;
    if (!type) return errRes(res, '缺少 type');

    const lines = text.split('\n');

    switch (type) {
      case 'stats': {
        const chars   = text.length;
        const words   = text.trim() ? text.trim().split(/\s+/).length : 0;
        const linesN  = lines.length;
        const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
        const bytes   = Buffer.byteLength(text, 'utf8');
        return jsonRes(res, { result: null, stats: { chars, words, lines: linesN, chinese, bytes } });
      }
      case 'upper':       return jsonRes(res, { result: text.toUpperCase() });
      case 'lower':       return jsonRes(res, { result: text.toLowerCase() });
      case 'title': {
        const result = text.replace(/\b\w/g, c => c.toUpperCase());
        return jsonRes(res, { result });
      }
      case 'trim_lines': {
        return jsonRes(res, { result: lines.map(l => l.trim()).join('\n') });
      }
      case 'remove_empty': {
        return jsonRes(res, { result: lines.filter(l => l.trim()).join('\n') });
      }
      case 'dedup': {
        const seen = new Set();
        return jsonRes(res, { result: lines.filter(l => { if (seen.has(l)) return false; seen.add(l); return true; }).join('\n') });
      }
      case 'sort_asc':  return jsonRes(res, { result: [...lines].sort((a,b) => a.localeCompare(b, 'zh')).join('\n') });
      case 'sort_desc': return jsonRes(res, { result: [...lines].sort((a,b) => b.localeCompare(a, 'zh')).join('\n') });
      case 'sort_len':  return jsonRes(res, { result: [...lines].sort((a,b) => a.length - b.length).join('\n') });
      case 'reverse_lines': return jsonRes(res, { result: [...lines].reverse().join('\n') });
      case 'reverse_text':  return jsonRes(res, { result: [...text].reverse().join('') });
      case 'add_line_num':  return jsonRes(res, { result: lines.map((l,i) => `${i+1}. ${l}`).join('\n') });
      case 'slug': {
        const result = text.toLowerCase().trim()
          .replace(/[\s_]+/g, '-')
          .replace(/[^\w-]/g, '')
          .replace(/--+/g, '-')
          .replace(/^-+|-+$/g, '');
        return jsonRes(res, { result });
      }
      case 'escape_html': {
        return jsonRes(res, { result: text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;') });
      }
      case 'unescape_html': {
        return jsonRes(res, { result: text.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'") });
      }
      default: return errRes(res, `不支持的操作: ${type}`);
    }
  }).catch(e => errRes(res, e.message));
}

// ── 颜色转换 API（纯计算，无依赖）───────────────────────────────
function handleColor(req, res) {
  readBody(req).then(raw => {
    let body;
    try { body = JSON.parse(raw); } catch { return errRes(res, '无效的 JSON'); }
    const { input } = body;
    if (!input) return errRes(res, '缺少 input');

    const str = input.trim();
    let r, g, b, a = 1;

    // HEX → RGB
    const hexM = str.match(/^#?([0-9a-fA-F]{3,8})$/);
    if (hexM) {
      let h = hexM[1];
      if (h.length === 3)      h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
      if (h.length === 4)      h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2]+h[3]+h[3];
      if (h.length === 8) {
        a = parseInt(h.slice(6,8),16) / 255;
        h = h.slice(0,6);
      }
      r = parseInt(h.slice(0,2),16);
      g = parseInt(h.slice(2,4),16);
      b = parseInt(h.slice(4,6),16);
    }
    // RGB / RGBA
    else if (/^rgba?\s*\(/.test(str)) {
      const m = str.match(/rgba?\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/);
      if (!m) return errRes(res, '无法解析颜色');
      [,r,g,b] = m; r=Number(r); g=Number(g); b=Number(b);
      if (m[4] !== undefined) a = Number(m[4]);
    }
    // HSL / HSLA
    else if (/^hsla?\s*\(/.test(str)) {
      const m = str.match(/hsla?\s*\(\s*([\d.]+)\s*,\s*([\d.]+)%?\s*,\s*([\d.]+)%?(?:\s*,\s*([\d.]+))?\s*\)/);
      if (!m) return errRes(res, '无法解析颜色');
      let h2 = Number(m[1]), s2 = Number(m[2])/100, l2 = Number(m[3])/100;
      if (m[4] !== undefined) a = Number(m[4]);
      // HSL to RGB
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
      };
      if (s2 === 0) { r = g = b = l2 * 255; }
      else {
        const q = l2 < 0.5 ? l2*(1+s2) : l2+s2-l2*s2;
        const p = 2*l2 - q;
        r = Math.round(hue2rgb(p, q, h2/360 + 1/3) * 255);
        g = Math.round(hue2rgb(p, q, h2/360) * 255);
        b = Math.round(hue2rgb(p, q, h2/360 - 1/3) * 255);
      }
    } else {
      return errRes(res, '不支持的颜色格式，请使用 HEX / RGB / HSL');
    }

    r = Math.max(0, Math.min(255, Math.round(r)));
    g = Math.max(0, Math.min(255, Math.round(g)));
    b = Math.max(0, Math.min(255, Math.round(b)));

    // RGB → HSL
    const rn = r/255, gn = g/255, bn = b/255;
    const max = Math.max(rn,gn,bn), min = Math.min(rn,gn,bn);
    const l = (max+min)/2;
    let h=0, s=0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d/(2-max-min) : d/(max+min);
      switch(max) {
        case rn: h = ((gn-bn)/d + (gn<bn?6:0))/6; break;
        case gn: h = ((bn-rn)/d + 2)/6; break;
        case bn: h = ((rn-gn)/d + 4)/6; break;
      }
    }
    const hDeg  = Math.round(h*360);
    const sPct  = Math.round(s*100);
    const lPct  = Math.round(l*100);
    const hex   = '#' + [r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
    const hexA  = a < 1 ? hex + Math.round(a*255).toString(16).padStart(2,'0') : hex;

    return jsonRes(res, {
      hex, hexA,
      rgb:  `rgb(${r}, ${g}, ${b})`,
      rgba: `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`,
      hsl:  `hsl(${hDeg}, ${sPct}%, ${lPct}%)`,
      hsla: `hsla(${hDeg}, ${sPct}%, ${lPct}%, ${a.toFixed(2)})`,
      r, g, b, a: parseFloat(a.toFixed(4)),
      h: hDeg, s: sPct, l: lPct,
      preview: hex
    });
  }).catch(e => errRes(res, e.message));
}

// ── 静态文件服务 ─────────────────────────────────────────────
function serveStatic(req, res, reqPath) {
  let filePath = path.join(__dirname, 'public', reqPath === '/' ? 'index.html' : reqPath);
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      filePath = path.join(__dirname, 'public', 'index.html');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ── 定时清理任务（每小时） ────────────────────────────────────
function runCleanup() {
  const ts = now();
  const p  = db.prepare('DELETE FROM pastes WHERE expire_at IS NOT NULL AND expire_at < ?').run(ts);
  const expiredFiles = db.prepare('SELECT stored_as FROM files WHERE expire_at IS NOT NULL AND expire_at < ?').all(ts);
  expiredFiles.forEach(row => {
    const fp = path.join(UPLOAD_DIR, row.stored_as);
    if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (_) {} }
  });
  if (expiredFiles.length) db.prepare('DELETE FROM files WHERE expire_at IS NOT NULL AND expire_at < ?').run(ts);
  const logDel = db.prepare('DELETE FROM access_log WHERE ts < ?').run(ts - 30 * 86400);
  if (p.changes || expiredFiles.length || logDel.changes) {
    console.log(`[cleanup] pastes:${p.changes} files:${expiredFiles.length} logs:${logDel.changes}`);
  }
}
setInterval(runCleanup, 60 * 60 * 1000);
runCleanup();

// ── 主路由 ───────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const { pathname } = url.parse(req.url);
  const method = req.method;
  const ip     = getClientIp(req);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }

  if (pathname === '/health') return handleHealth(req, res);

  if (!checkRate(ip)) {
    writeLog(ip, method, pathname, 429);
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
    res.end(JSON.stringify({ error: '请求过于频繁，请稍后再试' }));
    return;
  }

  const origWriteHead = res.writeHead.bind(res);
  let loggedStatus = 200;
  res.writeHead = (code, ...args) => { loggedStatus = code; return origWriteHead(code, ...args); };
  res.on('finish', () => writeLog(ip, method, pathname, loggedStatus));

  // ── 短链跳转
  const sMatch = pathname.match(/^\/s\/([a-zA-Z0-9_-]+)$/);
  if (sMatch) return handleLinkRedirect(req, res, sMatch[1]);

  // ── 文件下载
  const dlMatch = pathname.match(/^\/download\/([a-zA-Z0-9_-]+)$/);
  if (dlMatch) return handleFileDownload(req, res, dlMatch[1]);

  // ── 统计
  if (pathname === '/api/stats' && method === 'GET') return handleStats(req, res);

  // ── 短链接 API
  if (pathname === '/api/links' && method === 'GET')  return handleLinkList(req, res);
  if (pathname === '/api/links' && method === 'POST') return handleLinkCreate(req, res);
  const linkDel = pathname.match(/^\/api\/links\/([a-zA-Z0-9_-]+)$/);
  if (linkDel && method === 'DELETE') return handleLinkDelete(req, res, linkDel[1]);

  // ── 剪贴板 API
  if (pathname === '/api/pastes' && method === 'GET')  return handlePasteList(req, res);
  if (pathname === '/api/pastes' && method === 'POST') return handlePasteCreate(req, res);
  const pasteMatch = pathname.match(/^\/api\/pastes\/([a-zA-Z0-9_-]+)$/);
  if (pasteMatch && method === 'GET')    return handlePasteGet(req, res, pasteMatch[1]);
  if (pasteMatch && method === 'DELETE') return handlePasteDelete(req, res, pasteMatch[1]);

  // ── 文件 API
  if (pathname === '/api/files' && method === 'GET')  return handleFileList(req, res);
  if (pathname === '/api/files' && method === 'POST') return handleFileUpload(req, res);
  const fileDel = pathname.match(/^\/api\/files\/([a-zA-Z0-9_-]+)$/);
  if (fileDel && method === 'DELETE') return handleFileDelete(req, res, fileDel[1]);

  // ── 工具 API
  if (pathname === '/api/encode'  && method === 'POST') return handleEncode(req, res);
  if (pathname === '/api/diff'    && method === 'POST') return handleDiff(req, res);
  if (pathname === '/api/json'    && method === 'POST') return handleJsonTool(req, res);
  if (pathname === '/api/passgen' && method === 'POST') return handlePassGen(req, res);
  if (pathname === '/api/net'     && method === 'POST') return handleNetTool(req, res);
  if (pathname === '/api/regex'   && method === 'POST') return handleRegex(req, res);
  if (pathname === '/api/text'    && method === 'POST') return handleTextTool(req, res);
  if (pathname === '/api/color'   && method === 'POST') return handleColor(req, res);

  // ── SPA fallback
  if (pathname.match(/^\/(p|f|s)\//) || pathname === '/') return serveStatic(req, res, '/');
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`\n  个人工具箱 v5 已启动`);
  console.log(`  地址：http://localhost:${PORT}`);
  console.log(`  功能：短链接(+密码+次数限制) / 剪贴板 / 文件 / 编码 / Diff`);
  console.log(`         JSON / 密码生成 / 网络 / 正则测试 / 文本工具 / 颜色转换`);
  console.log(`  限速：${RATE_LIMIT_RPM} req/min/IP\n`);
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`端口 ${PORT} 已被占用`);
  else console.error('服务器错误:', e.message);
  process.exit(1);
});

process.on('SIGTERM', () => { db.close(); server.close(); process.exit(0); });
