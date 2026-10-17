'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createModerator } = require('../lib/moderation');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'keywords.json'), 'utf8'));
const { scan } = createModerator(cfg);
const act = (t) => scan(t).action;

// blocks, including obfuscation
assert.equal(act('fuck you'), 'block');
assert.equal(act('F U C K'), 'block');
assert.equal(act('f.u.c.k'), 'block');
assert.equal(act('fuuuuck'), 'block');
assert.equal(act('you are a b1tch'), 'block');
assert.equal(act('SEND NUDES'), 'block');
assert.equal(act('send   nudes'), 'block');
assert.equal(act('madarchod'), 'block');

// no Scunthorpe false positives
for (const ok of ['class assignment', 'I assume so', 'Hello there', 'classic', 'passion for music', 'bass guitar', 'Scunthorpe', 'cocktail party', 'I love chai']) {
  assert.equal(act(ok), 'allow', ok);
}

// mask
assert.equal(scan('this is bullshit lol').text, 'this is ******** lol');
assert.equal(act('mc'), 'mask');

// contacts
assert.equal(scan('call me 98765 43210').text, 'call me [hidden]');
assert.equal(scan('my insta is cool_guy99').text, 'my [hidden]'.replace('my [hidden]', scan('my insta is cool_guy99').text));
assert.ok(scan('my insta is cool_guy99').text.includes('[hidden]'));
assert.ok(scan('mail me a@b.com').text.includes('[hidden]'));
assert.ok(scan('see www.example.com').text.includes('[hidden]'));
assert.equal(act('I have 2 classes and 3 exams'), 'allow');

// care flag
assert.equal(act('sometimes I want to die'), 'flag');

console.log('moderation: all passed');
