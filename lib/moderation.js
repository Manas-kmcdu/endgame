'use strict';
/**
 * Keyword moderation.
 * Lists (data/keywords.json):
 *   block: message is rejected, sender gets a strike
 *   mask : word is replaced with asterisks, message still sent
 *   flag : message sent, sender gets a private care notice (self-harm etc.)
 * Entry syntax: "word" exact | "word*" prefix | "*word*" contains | "two words" phrase
 * Matching is on normalized text: lowercase, accents stripped, leetspeak (4->a, 0->o, @->a),
 * repeated letters collapsed (fuuuck -> fuck), and spaced-out letters merged (f u c k, f.u.c.k).
 * Whole-token matching avoids "Scunthorpe" false positives (class, assume, etc.).
 */

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

function norm(s) {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[013457@$]/g, (c) => LEET[c])
    .replace(/(.)\1+/g, '$1');
}

function compile(entries) {
  const exact = new Set();
  const prefix = [];
  const contains = [];
  const phrases = [];
  for (let raw of entries || []) {
    raw = String(raw).trim().toLowerCase();
    if (!raw) continue;
    const pre = raw.endsWith('*');
    const suf = raw.startsWith('*');
    const core = norm(raw.replace(/^\*|\*$/g, '').trim());
    if (!core) continue;
    if (core.includes(' ')) phrases.push(core);
    else if (pre && suf) contains.push(core);
    else if (pre) prefix.push(core);
    else exact.add(core);
  }
  return { exact, prefix, contains, phrases };
}

function tokenize(text) {
  const re = /[\p{L}\p{N}@$]+/gu;
  const toks = [];
  let m;
  while ((m = re.exec(text))) toks.push({ start: m.index, end: m.index + m[0].length, raw: m[0] });
  // merge runs of 3+ single-char tokens separated by one separator ("f u c k")
  const out = [];
  let i = 0;
  while (i < toks.length) {
    let j = i;
    while (
      j + 1 < toks.length &&
      toks[j].raw.length === 1 &&
      toks[j + 1].raw.length === 1 &&
      /^[ .\-_*,]$/.test(text.slice(toks[j].end, toks[j + 1].start))
    ) j++;
    if (j - i >= 2) {
      out.push({ start: toks[i].start, end: toks[j].end, raw: text.slice(toks[i].start, toks[j].end), merged: toks.slice(i, j + 1).map((t) => t.raw).join('') });
      i = j + 1;
    } else {
      out.push(toks[i]);
      i++;
    }
  }
  for (const t of out) t.n = norm(t.merged || t.raw);
  return out;
}

function matchList(toks, c) {
  const hits = [];
  const tokHit = (t) =>
    c.exact.has(t.n) || c.prefix.some((p) => t.n.startsWith(p)) || c.contains.some((p) => t.n.includes(p));
  toks.forEach((t) => { if (tokHit(t)) hits.push({ start: t.start, end: t.end, word: t.n }); });
  for (const ph of c.phrases) {
    const k = ph.split(' ').length;
    for (let i = 0; i + k <= toks.length; i++) {
      if (toks.slice(i, i + k).map((t) => t.n).join(' ') === ph)
        hits.push({ start: toks[i].start, end: toks[i + k - 1].end, word: ph });
    }
  }
  return hits;
}

const RX = {
  url: /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|in|me|co|io|ly|gg|app|xyz)\b\S*/gi,
  email: /[\w.+-]+@[\w-]+\.[\w.]+/g,
  phone: /(?:\+?\d[\s().-]?){10,}/g,
  handle: /\b(?:insta(?:gram)?|ig|snap(?:chat)?|whats\s?app|wa|telegram|tg)\b\s*(?:id|handle|is)?\s*[:@-]?\s*@?[\w.]{3,}|@[\w.]{3,}/gi,
};

function createModerator(cfg) {
  let lists = {};
  let contacts = true;
  function reload(c) {
    lists = { block: compile(c.block), mask: compile(c.mask), flag: compile(c.flag) };
    contacts = c.contacts !== false;
  }
  reload(cfg);

  function scan(text) {
    const toks = tokenize(text);
    const blockHits = matchList(toks, lists.block);
    if (blockHits.length) return { action: 'block', text, matches: blockHits.map((h) => h.word) };

    let out = text;
    const matches = [];
    const maskHits = matchList(toks, lists.mask).sort((a, b) => b.start - a.start);
    for (const h of maskHits) {
      out = out.slice(0, h.start) + '*'.repeat(h.end - h.start) + out.slice(h.end);
      matches.push(h.word);
    }
    let action = maskHits.length ? 'mask' : 'allow';

    if (contacts) {
      for (const rx of [RX.email, RX.url, RX.phone, RX.handle]) {
        const next = out.replace(rx, '[hidden]');
        if (next !== out) { out = next; action = 'mask'; matches.push('contact'); }
      }
    }
    if (matchList(toks, lists.flag).length) {
      return { action: 'flag', text: out, matches: ['flag'] };
    }
    return { action, text: out, matches };
  }
  return { scan, reload };
}

module.exports = { createModerator, norm };
