'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.PORT = '0';
process.env.ROUND_SECONDS = '3';
process.env.EXTEND_SECONDS = '3';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'corridor-'));
process.env.ADMIN_KEY = 'testkey';
process.env.KEYWORDS_FILE = path.join(process.env.DATA_DIR, 'keywords.json');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'keywords.json'), process.env.KEYWORDS_FILE);
const WebSocket = require('ws');
const { server, store } = require('../server');

class C {
  constructor(port, name) {
    this.name = name; this.q = []; this.waiters = [];
    this.id = crypto.randomBytes(16).toString('hex');
    this.ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    this.ws.on('message', (d) => {
      const m = JSON.parse(d); this.q.push(m);
      this.waiters = this.waiters.filter((w) => !w(m));
    });
    this.opened = new Promise((r) => this.ws.on('open', r));
  }
  async hello() { await this.opened; this.send({ t: 'hello', clientId: this.id }); return this.wait('welcome'); }
  send(o) { this.ws.send(JSON.stringify(o)); }
  wait(type, pred = () => true, ms = 4000) {
    const hit = this.q.findIndex((m) => m.t === type && pred(m));
    if (hit >= 0) return Promise.resolve(this.q.splice(hit, 1)[0]);
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error(this.name + ' timed out waiting for ' + type)), ms);
      this.waiters.push((m) => {
        if (m.t === type && pred(m)) { clearTimeout(to); this.q.splice(this.q.indexOf(m), 1); res(m); return true; }
        return false;
      });
    });
  }
  async none(type, ms = 300) { await new Promise((r) => setTimeout(r, ms)); assert(!this.q.some((m) => m.t === type), this.name + ' unexpectedly got ' + type); }
  join(door) { this.send({ t: 'join', door, handle: this.name }); }
  close() { this.ws.close(); }
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const mk = async (n) => { const c = new C(port, n); await c.hello(); return c; };

  // 1. match + chat
  const [A, B] = [await mk('Alice'), await mk('Bob')];
  A.join('music'); await A.wait('waiting');
  B.join('music');
  const [ma, mb] = await Promise.all([A.wait('matched'), B.wait('matched')]);
  assert.equal(ma.partner, 'Bob'); assert.equal(mb.partner, 'Alice');
  A.send({ t: 'msg', text: 'hey, what are you listening to?' });
  assert.equal((await B.wait('msg')).text, 'hey, what are you listening to?');
  await A.wait('msg', (m) => m.me);
  console.log('ok  match + chat');

  // 2. moderation: block, mask, contacts
  A.send({ t: 'msg', text: 'f u c k off' });
  assert.equal((await A.wait('blocked')).strikes, 1);
  await B.none('msg');
  B.send({ t: 'msg', text: 'this is bullshit, call 9876543210' });
  const masked = await A.wait('msg', (m) => !m.me);
  assert.equal(masked.text, 'this is ********, call [hidden]');
  A.send({ t: 'msg', text: 'i want to die' });
  assert((await A.wait('notice')).care);
  console.log('ok  block / mask / contacts / care notice');

  // 3. strikes -> removal
  A.send({ t: 'msg', text: 'bitch' }); await A.wait('blocked');
  A.send({ t: 'msg', text: 'bitch' }); await A.wait('blocked');
  await A.wait('removed');
  assert.equal((await B.wait('partner_left')).reason, 'skip');
  console.log('ok  3 strikes removes sender');

  // 4. skip + rematch cooldown
  const [C1, D] = [await mk('Cara'), await mk('Dev')];
  C1.join('screen'); D.join('screen');
  await Promise.all([C1.wait('matched'), D.wait('matched')]);
  C1.send({ t: 'skip' });
  await D.wait('partner_left'); await C1.wait('waiting');
  D.join('screen'); await D.wait('waiting');
  await C1.none('matched', 2500); // recent pair cooldown: must NOT rematch
  const E = await mk('Esha');
  E.join('screen');
  await E.wait('matched'); // pairs with whoever is oldest and eligible (Cara)
  console.log('ok  skip, requeue, no instant rematch');

  // 5. mutual extend + timer end
  const [F, G] = [await mk('Fay'), await mk('Gus')];
  F.join('career'); G.join('career');
  const mf = await F.wait('matched'); await G.wait('matched');
  assert.equal(mf.left, 3000);
  F.send({ t: 'extend' }); await G.wait('extend_vote');
  G.send({ t: 'extend' });
  const ext = await F.wait('extended'); assert(ext.left > 2500);
  await Promise.all([F.wait('ended', () => true, 10000), G.wait('ended', () => true, 10000)]);
  console.log('ok  mutual extend, timer end');

  // 6. report: stored, pair blocked, auto-ban after 3 distinct reporters
  const X = await mk('Troll');
  for (let i = 1; i <= 3; i++) {
    const R = await mk('Rep' + i);
    X.join('gaming'); R.join('gaming');
    await Promise.all([X.wait('matched'), R.wait('matched')]);
    R.send({ t: 'msg', text: 'hi' }); await X.wait('msg');
    X.send({ t: 'msg', text: 'hello' }); await R.wait('msg', (m) => !m.me);
    R.send({ t: 'report', reason: 'harassment', note: 'rude' });
    await R.wait('reported');
    if (i < 3) await X.wait('partner_left');
  }
  await X.wait('banned');
  assert.equal(store.reports.length, 3);
  assert.equal(store.reports[0].transcript.length, 2);
  assert(store.banUntil(X.id) > Date.now());
  const X2 = new C(port, 'Troll2'); X2.id = X.id; await X2.opened; X2.send({ t: 'hello', clientId: X.id });
  await X2.wait('banned');
  console.log('ok  report -> transcript saved, 3 reporters -> auto ban, ban persists on reconnect');

  // 7. admin api
  const base = 'http://127.0.0.1:' + port;
  assert.equal((await fetch(base + '/admin/api/state')).status, 401);
  const st = await (await fetch(base + '/admin/api/state', { headers: { 'x-admin-key': 'testkey' } })).json();
  assert.equal(st.reports.length, 3);
  const r = await (await fetch(base + '/admin/api/keywords', { method: 'POST', headers: { 'x-admin-key': 'testkey', 'content-type': 'application/json' }, body: JSON.stringify({ block: ['zebra'], mask: [], flag: [], contacts: false }) })).json();
  assert(r.ok);
  const t = await (await fetch(base + '/admin/api/test', { method: 'POST', headers: { 'x-admin-key': 'testkey', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'z e b r a' }) })).json();
  assert.equal(t.action, 'block');
  console.log('ok  admin auth, live keyword reload');

  console.log('\nALL E2E PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
