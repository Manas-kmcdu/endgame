'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createModerator } = require('./lib/moderation');
const Store = require('./lib/store');

const env = process.env;
const CFG = {
  port: +env.PORT || 3000,
  roundSec: +env.ROUND_SECONDS || 180,       // length of one speed round
  extendSec: +env.EXTEND_SECONDS || 180,     // added when BOTH people tap "keep talking"
  maxLen: 300,                               // max characters per message
  rematchCooldownMs: 30 * 60e3,              // same two people won't be paired again for this long
  reportBanThreshold: 3,                     // distinct reporters within 24h -> auto ban
  reportBanHours: 24,
  strikeLimit: 3,                            // blocked messages per round before removal
  strikeCooldownMs: 10 * 60e3,
  skipBurst: 8,                              // max skips per minute
  inviteCode: env.INVITE_CODE || '',         // optional gate until real DU verification is plugged in
  adminKey: env.ADMIN_KEY || crypto.randomBytes(8).toString('hex'),
  ipSalt: env.IP_SALT || 'corridor-salt',
  dataDir: env.DATA_DIR || path.join(__dirname, 'var'),
};
const HELPLINE = 'If things feel heavy, you can call Tele-MANAS at 14416 any time. It is free and open 24x7.';
const REASONS = ['harassment', 'sexual', 'hate', 'spam', 'minor', 'other'];

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'data', f), 'utf8'));
const doors = readJson('doors.json');
const doorMap = new Map(doors.map((d) => [d.id, d]));
const keywordsFile = env.KEYWORDS_FILE || path.join(__dirname, 'data', 'keywords.json');
const moderator = createModerator(JSON.parse(fs.readFileSync(keywordsFile, 'utf8')));
const store = new Store(CFG.dataDir);

// ---------- state ----------
const queues = new Map(doors.map((d) => [d.id, []]));
const sessions = new Map();
const byId = new Map();           // clientId -> client
const recent = new Map();         // pairKey -> ts
const blocked = new Set();        // pairKey (after a report)
const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
const rid = () => crypto.randomBytes(6).toString('hex');
const ipHash = (ip) => crypto.createHash('sha256').update(CFG.ipSalt + ip).digest('hex').slice(0, 16);

const ADJ = ['Quiet', 'Golden', 'Midnight', 'Paper', 'Sunny', 'Velvet', 'Stray', 'Mellow', 'Brisk', 'Cosmic', 'Lazy', 'Neon'];
const NOUN = ['Peacock', 'Chai', 'Metro', 'Lotus', 'Monsoon', 'Kite', 'Sparrow', 'Mango', 'Lantern', 'Banyan', 'Jalebi', 'Comet'];
const randomHandle = () => ADJ[Math.random() * ADJ.length | 0] + ' ' + NOUN[Math.random() * NOUN.length | 0];

function send(c, obj) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); }

// ---------- counts ----------
let lastCounts = '';
function counts() {
  const o = {};
  for (const d of doors) o[d.id] = queues.get(d.id).length;
  for (const s of sessions.values()) o[s.door] += 2;
  return o;
}
function broadcastCounts(force) {
  const c = counts();
  const j = JSON.stringify(c);
  if (!force && j === lastCounts) return;
  lastCounts = j;
  for (const cl of byId.values()) if (cl.ready) send(cl, { t: 'counts', counts: c });
}
setInterval(() => { broadcastCounts(); for (const d of doors) tryMatch(d.id); }, 2000);

// ---------- matching ----------
function canPair(a, b) {
  if (a.id === b.id) return false;
  const k = pairKey(a.id, b.id);
  if (blocked.has(k)) return false;
  const t = recent.get(k);
  return !(t && Date.now() - t < CFG.rematchCooldownMs);
}

function tryMatch(doorId) {
  const q = queues.get(doorId);
  for (let i = 0; i < q.length; i++) {
    for (let j = i + 1; j < q.length; j++) {
      if (canPair(q[i], q[j])) {
        const [a, b] = [q[i], q[j]];
        q.splice(j, 1);
        q.splice(i, 1);
        startSession(a, b, doorId);
        return tryMatch(doorId);
      }
    }
  }
}

function startSession(a, b, doorId) {
  const door = doorMap.get(doorId);
  const s = {
    id: rid(), door: doorId, a, b, startedAt: Date.now(), endsAt: Date.now() + CFG.roundSec * 1000,
    extend: new Set(), log: [], timer: null,
  };
  s.timer = setTimeout(() => endSession(s.id, 'time'), CFG.roundSec * 1000);
  sessions.set(s.id, s);
  recent.set(pairKey(a.id, b.id), Date.now());
  const prompt = door.prompts[Math.random() * door.prompts.length | 0];
  for (const [me, other] of [[a, b], [b, a]]) {
    me.state = 'chat'; me.sid = s.id; me.strikes = 0;
    send(me, { t: 'matched', partner: other.handle, prompt, left: CFG.roundSec * 1000 });
  }
  broadcastCounts();
}

/** reason: time | skip | leave | disconnect | moderation | report. `by` is the client who caused it. */
function endSession(sid, reason, by) {
  const s = sessions.get(sid);
  if (!s) return;
  clearTimeout(s.timer);
  sessions.delete(sid);
  for (const [me, other] of [[s.a, s.b], [s.b, s.a]]) {
    me.last = { // kept so a report can still be filed right after the round ends
      sid, door: s.door, partnerId: other.id, partnerHandle: other.handle,
      log: s.log.slice(-30).map((m) => ({ who: m.from === me.id ? 'reporter' : 'reported', text: m.text, ts: m.ts })),
      expires: Date.now() + 10 * 60e3,
    };
    me.sid = null;
    me.state = 'idle';
    if (me === by) continue;
    if (reason === 'time') send(me, { t: 'ended', reason: 'time' });
    else send(me, { t: 'partner_left', reason: reason === 'disconnect' ? 'disconnect' : 'skip' });
  }
  broadcastCounts();
}

function removeFromQueue(c) {
  if (!c.door) return;
  const q = queues.get(c.door);
  const i = q.indexOf(c);
  if (i >= 0) q.splice(i, 1);
}

function enqueue(c, doorId) {
  c.door = doorId; c.state = 'waiting';
  queues.get(doorId).push(c);
  send(c, { t: 'waiting', door: doorId });
  broadcastCounts();
  tryMatch(doorId);
}

function leave(c, reason) {
  if (c.sid) endSession(c.sid, reason, c);
  removeFromQueue(c);
  c.state = 'idle'; c.door = null; c.sid = null;
  broadcastCounts();
}

// ---------- message handlers ----------
function cleanHandle(h) {
  h = String(h || '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 24);
  if (h.length < 2) return randomHandle();
  const r = moderator.scan(h);
  return r.action === 'allow' ? h : randomHandle();
}

function handle(c, m) {
  switch (m.t) {
    case 'hello': return onHello(c, m);
    case 'join': return onJoin(c, m);
    case 'msg': return onMsg(c, m);
    case 'typing': {
      const s = sessions.get(c.sid);
      if (s) send(s.a === c ? s.b : s.a, { t: 'typing' });
      return;
    }
    case 'skip': return onSkip(c);
    case 'extend': return onExtend(c);
    case 'report': return onReport(c, m);
    case 'leave': return leave(c, 'leave');
  }
}

function onHello(c, m) {
  if (c.ready) return;
  const id = String(m.clientId || '');
  if (!/^[a-f0-9-]{16,64}$/.test(id)) return c.ws.close();
  if (CFG.inviteCode && String(m.code || '').trim().toLowerCase() !== CFG.inviteCode.toLowerCase()) {
    send(c, { t: 'need_code' });
    return;
  }
  const until = store.banUntil(id, 'ip:' + c.ip);
  if (until) { send(c, { t: 'banned', until }); return c.ws.close(); }
  const old = byId.get(id);
  if (old && old !== c) { send(old, { t: 'kicked' }); old.ws.close(); leave(old, 'disconnect'); }
  c.id = id; c.ready = true; byId.set(id, c);
  send(c, { t: 'welcome', doors, counts: counts(), cfg: { roundSec: CFG.roundSec, maxLen: CFG.maxLen, reasons: REASONS } });
}

function onJoin(c, m) {
  if (!c.ready || c.state !== 'idle') return;
  if (!doorMap.has(m.door)) return;
  if (Date.now() < c.cooldownUntil) {
    return send(c, { t: 'notice', text: 'You are on a short break. Try again in ' + Math.ceil((c.cooldownUntil - Date.now()) / 60000) + ' min.' });
  }
  c.handle = cleanHandle(m.handle);
  enqueue(c, m.door);
}

function onMsg(c, m) {
  const s = sessions.get(c.sid);
  if (!s) return;
  let text = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, CFG.maxLen);
  if (!text) return;
  const now = Date.now();
  c.msgTimes = c.msgTimes.filter((t) => now - t < 4000);
  if (c.msgTimes.length >= 5) return send(c, { t: 'notice', text: 'Slow down a little.' });
  c.msgTimes.push(now);

  const r = moderator.scan(text);
  if (r.action === 'block') {
    c.strikes++;
    store.addModHit({ ts: now, clientId: c.id, door: s.door, terms: r.matches });
    send(c, { t: 'blocked', text: 'That message was not sent. Keep it respectful.', strikes: c.strikes, limit: CFG.strikeLimit });
    if (c.strikes >= CFG.strikeLimit) {
      c.cooldownUntil = now + CFG.strikeCooldownMs;
      send(c, { t: 'removed', text: 'You have been removed for repeated blocked messages. Take a 10 minute break.' });
      leave(c, 'moderation');
    }
    return;
  }
  if (r.action === 'flag') send(c, { t: 'notice', text: HELPLINE, care: true });
  text = r.text;
  const other = s.a === c ? s.b : s.a;
  const msg = { from: c.id, text, ts: now };
  s.log.push(msg);
  send(c, { t: 'msg', me: true, text, ts: now });
  send(other, { t: 'msg', me: false, text, ts: now });
}

const skipTimes = new WeakMap();
function onSkip(c) {
  if (c.state !== 'chat') return;
  const now = Date.now();
  const arr = (skipTimes.get(c) || []).filter((t) => now - t < 60000);
  if (arr.length >= CFG.skipBurst) return send(c, { t: 'notice', text: 'Too many skips in a row. Give this one a minute.' });
  arr.push(now); skipTimes.set(c, arr);
  const door = c.door;
  endSession(c.sid, 'skip', c);
  enqueue(c, door); // skipper goes straight back into the same door
}

function onExtend(c) {
  const s = sessions.get(c.sid);
  if (!s) return;
  s.extend.add(c.id);
  const other = s.a === c ? s.b : s.a;
  if (s.extend.size < 2) return send(other, { t: 'extend_vote' });
  s.extend.clear();
  s.endsAt += CFG.extendSec * 1000;
  clearTimeout(s.timer);
  s.timer = setTimeout(() => endSession(s.id, 'time'), s.endsAt - Date.now());
  for (const p of [s.a, s.b]) send(p, { t: 'extended', left: s.endsAt - Date.now() });
}

function onReport(c, m) {
  const reason = REASONS.includes(m.reason) ? m.reason : 'other';
  let src = null;
  const s = sessions.get(c.sid);
  if (s) {
    const other = s.a === c ? s.b : s.a;
    src = {
      door: s.door, partnerId: other.id, partnerHandle: other.handle,
      log: s.log.slice(-30).map((x) => ({ who: x.from === c.id ? 'reporter' : 'reported', text: x.text, ts: x.ts })),
    };
  } else if (c.last && c.last.expires > Date.now()) src = c.last;
  if (!src) return send(c, { t: 'notice', text: 'Nothing to report right now.' });

  store.addReport({
    id: rid(), ts: Date.now(), door: src.door, reporter: c.id, reported: src.partnerId,
    reportedHandle: src.partnerHandle, reason, note: String(m.note || '').slice(0, 300),
    transcript: src.log, status: 'open',
  });
  blocked.add(pairKey(c.id, src.partnerId));

  // auto action
  const n = store.distinctReporters(src.partnerId, Date.now() - 24 * 3600e3);
  if (n >= CFG.reportBanThreshold) {
    store.ban(src.partnerId, CFG.reportBanHours, 'auto: ' + n + ' reports in 24h');
    const t = byId.get(src.partnerId);
    if (t) { send(t, { t: 'banned', until: store.banUntil(src.partnerId) }); leave(t, 'moderation'); t.ws.close(); }
  }
  if (s) endSession(s.id, 'report', c);
  c.last = null; c.state = 'idle'; c.door = null;
  send(c, { t: 'reported' });
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function authed(req) {
  const k = String(req.headers['x-admin-key'] || '');
  const a = Buffer.from(k), b = Buffer.from(CFG.adminKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function body(req) {
  return new Promise((res, rej) => {
    let d = '';
    req.on('data', (x) => { d += x; if (d.length > 100000) { rej(new Error('big')); req.destroy(); } });
    req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch (e) { rej(e); } });
  });
}
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

async function admin(req, res, url) {
  if (!authed(req)) return json(res, 401, { error: 'bad key' });
  try {
    if (req.method === 'GET' && url === '/admin/api/state') {
      return json(res, 200, {
        reports: store.reports.slice(-200).reverse(),
        bans: store.bans,
        modlog: store.modlog.slice(-100).reverse(),
        keywords: JSON.parse(fs.readFileSync(keywordsFile, 'utf8')),
        live: { counts: counts(), sessions: sessions.size, online: byId.size },
      });
    }
    const b = await body(req);
    if (url === '/admin/api/keywords') {
      const k = {
        contacts: b.contacts !== false,
        block: [].concat(b.block || []).map(String), mask: [].concat(b.mask || []).map(String), flag: [].concat(b.flag || []).map(String),
      };
      fs.writeFileSync(keywordsFile, JSON.stringify(k, null, 2));
      moderator.reload(k);
      return json(res, 200, { ok: true });
    }
    if (url === '/admin/api/test') return json(res, 200, moderator.scan(String(b.text || '')));
    if (url === '/admin/api/ban') { store.ban(String(b.id), +b.hours || 24, 'admin'); return json(res, 200, { ok: true }); }
    if (url === '/admin/api/unban') { store.unban(String(b.id)); return json(res, 200, { ok: true }); }
    if (url === '/admin/api/report-status') return json(res, 200, { ok: store.setReportStatus(String(b.id), String(b.status)) });
    return json(res, 404, { error: 'nope' });
  } catch (e) { return json(res, 400, { error: e.message }); }
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/admin/api/')) return admin(req, res, url);
  if (url === '/healthz') return json(res, 200, { ok: true });
  const file = url === '/' ? 'index.html' : url === '/admin' ? 'admin.html' : url.slice(1);
  const full = path.join(__dirname, 'public', file);
  if (!full.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
});

// ---------- websocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
wss.on('connection', (ws, req) => {
  const ip = ipHash(String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim());
  const c = {
    ws, ip, id: null, ready: false, handle: '', door: null, state: 'idle', sid: null,
    msgTimes: [], strikes: 0, cooldownUntil: 0, last: null, alive: true,
  };
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t !== 'hello' && !c.ready) return;
    try { handle(c, m); } catch (e) { console.error('handler error', e); }
  });
  ws.on('close', () => {
    if (c.ready) { leave(c, 'disconnect'); if (byId.get(c.id) === c) byId.delete(c.id); }
    broadcastCounts();
  });
});
setInterval(() => {
  for (const c of byId.values()) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false; c.ws.ping();
  }
  const now = Date.now();
  for (const [k, t] of recent) if (now - t > CFG.rematchCooldownMs) recent.delete(k);
}, 30000);

if (require.main === module) {
  server.listen(CFG.port, () => {
    console.log('Corridor on http://localhost:' + CFG.port);
    console.log('Admin: /admin   key: ' + CFG.adminKey + (env.ADMIN_KEY ? '' : '  (random; set ADMIN_KEY to keep it)'));
  });
}
module.exports = { server, CFG, store };
