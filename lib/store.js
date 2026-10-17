'use strict';
const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.bansFile = path.join(dir, 'bans.json');
    this.reportsFile = path.join(dir, 'reports.json');
    this.modlogFile = path.join(dir, 'modlog.json');
    this.bans = readJson(this.bansFile, {});       // key -> {until, reason, ts}
    this.reports = readJson(this.reportsFile, []); // newest last
    this.modlog = readJson(this.modlogFile, []);
  }

  // ---- bans ----
  banUntil(...keys) {
    const now = Date.now();
    let max = 0;
    for (const k of keys) {
      const b = this.bans[k];
      if (b && b.until > now) max = Math.max(max, b.until);
    }
    return max;
  }
  ban(key, hours, reason) {
    this.bans[key] = { until: Date.now() + hours * 3600e3, reason, ts: Date.now() };
    writeJson(this.bansFile, this.bans);
  }
  unban(key) {
    delete this.bans[key];
    writeJson(this.bansFile, this.bans);
  }

  // ---- reports ----
  addReport(r) {
    this.reports.push(r);
    if (this.reports.length > 2000) this.reports.splice(0, this.reports.length - 2000);
    writeJson(this.reportsFile, this.reports);
  }
  setReportStatus(id, status) {
    const r = this.reports.find((x) => x.id === id);
    if (r) { r.status = status; writeJson(this.reportsFile, this.reports); }
    return !!r;
  }
  distinctReporters(targetId, sinceTs) {
    return new Set(this.reports.filter((r) => r.reported === targetId && r.ts >= sinceTs).map((r) => r.reporter)).size;
  }

  // ---- moderation hits (no message text stored, only matched terms) ----
  addModHit(h) {
    this.modlog.push(h);
    if (this.modlog.length > 1000) this.modlog.splice(0, this.modlog.length - 1000);
    writeJson(this.modlogFile, this.modlog);
  }
}

module.exports = Store;
