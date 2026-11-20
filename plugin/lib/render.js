// plugin/lib/render.js
// 把一個節點的測試結果畫成 PNG 報告圖（純 JS：點陣字型 + 索引色畫布 + png.js）。

"use strict";

var png = require("./png.js");
var parser = require("./parser.js");
var fmt = require("./format.js");

var FONT = null;
function font() {
  if (FONT) return FONT;
  var raw = require("./font-data.js");
  var data = typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(raw.data, "base64")) : decodeB64(raw.data);
  var widths = typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(raw.widths, "base64")) : decodeB64(raw.widths);
  var index = {};
  var offsets = new Uint32Array(widths.length);
  var off = 0;
  for (var i = 0; i < widths.length; i++) {
    index[raw.chars.charAt(i)] = i;
    offsets[i] = off;
    off += Math.ceil(widths[i] * raw.height / 4);
  }
  FONT = { h: raw.height, data: data, widths: widths, index: index, offsets: offsets };
  return FONT;
}

function decodeB64(s) {
  var T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var map = {};
  for (var i = 0; i < 64; i++) map[T.charAt(i)] = i;
  s = s.replace(/=+$/, "");
  var out = new Uint8Array(Math.floor(s.length * 3 / 4));
  var o = 0, bits = 0, n = 0;
  for (var j = 0; j < s.length; j++) {
    bits = (bits << 6) | map[s.charAt(j)];
    n += 6;
    if (n >= 8) { n -= 8; out[o++] = (bits >> n) & 255; }
  }
  return out;
}

// ---------- 畫布 ----------

function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }

function Canvas(w, h, bg) {
  this.w = w; this.h = h;
  this.px = new Uint8Array(w * h);
  this.palette = [];
  this.pmap = {};
  var b = this.color(bg);
  if (b) this.px.fill(b);
}
Canvas.prototype.color = function (rgb) {
  if (typeof rgb === "string") rgb = hex(rgb);
  var key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
  var i = this.pmap[key];
  if (i !== undefined) return i;
  if (this.palette.length >= 256) { // 調色盤滿了：找最接近的顏色
    var best = 0, bd = 1e9;
    for (var k = 0; k < this.palette.length; k++) {
      var p = this.palette[k];
      var d = Math.abs(p[0] - rgb[0]) + Math.abs(p[1] - rgb[1]) + Math.abs(p[2] - rgb[2]);
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }
  this.palette.push([rgb[0], rgb[1], rgb[2]]);
  this.pmap[key] = this.palette.length - 1;
  return this.palette.length - 1;
};
Canvas.prototype.rect = function (x, y, w, h, c) {
  var ci = this.color(c);
  x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
  var x2 = Math.min(this.w, x + Math.round(w)), y2 = Math.min(this.h, y + Math.round(h));
  for (var yy = y; yy < y2; yy++) this.px.fill(ci, yy * this.w + x, yy * this.w + x2);
};
Canvas.prototype.textWidth = function (s) {
  var f = font(), w = 0;
  s = String(s);
  for (var i = 0; i < s.length; i++) {
    var gi = f.index[s.charAt(i)];
    var code = s.charCodeAt(i);
    if (gi === undefined && ((code >= 0xd800 && code <= 0xdfff) || (code >= 0xfe00 && code <= 0xfe0f) || code === 0x200d)) continue;
    w += gi === undefined ? (code > 0x2e80 ? 17 : 9) : f.widths[gi];
  }
  return w;
};
Canvas.prototype.fit = function (s, maxW) {
  s = String(s);
  if (this.textWidth(s) <= maxW) return s;
  while (s.length > 1 && this.textWidth(s + "…") > maxW) s = s.slice(0, -1);
  return s + "…";
};
// 以背景色 bg 與文字色 fg 的 4 階混色畫字；bold = 水平重疊 1px
Canvas.prototype.text = function (x, y, s, fg, bg, opts) {
  opts = opts || {};
  var f = font();
  s = String(s);
  if (opts.maxW) s = this.fit(s, opts.maxW);
  var w = this.textWidth(s);
  if (opts.align === "right") x -= w;
  else if (opts.align === "center") x -= w / 2;
  x = Math.round(x); y = Math.round(y);
  var F = hex(fg), B = hex(bg);
  var shades = [null];
  for (var a = 1; a <= 3; a++) shades.push(this.color([Math.round(B[0] + (F[0] - B[0]) * a / 3), Math.round(B[1] + (F[1] - B[1]) * a / 3), Math.round(B[2] + (F[2] - B[2]) * a / 3)]));
  var levelAt = {};
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    var gi = f.index[ch];
    if (gi === undefined) {
      var code = ch.charCodeAt(0);
      if ((code >= 0xd800 && code <= 0xdfff) || (code >= 0xfe00 && code <= 0xfe0f) || code === 0x200d) continue; // emoji 等：略過
      var gw = code > 0x2e80 ? 17 : 9;
      if (ch !== " ") this.rect(x + 2, y + 6, gw - 4, f.h - 12, fg); // 字型沒有的字畫成方塊
      x += gw;
      continue;
    }
    var gw2 = f.widths[gi], base = f.offsets[gi];
    for (var gy = 0; gy < f.h; gy++) {
      var py = y + gy;
      if (py < 0 || py >= this.h) continue;
      for (var gx = 0; gx < gw2; gx++) {
        var bitIndex = gy * gw2 + gx;
        var byte = f.data[base + (bitIndex >> 2)];
        var level = (byte >> (6 - 2 * (bitIndex & 3))) & 3;
        if (!level) continue;
        var reps = opts.bold ? 2 : 1;
        for (var r = 0; r < reps; r++) {
          var px = x + gx + r;
          if (px < 0 || px >= this.w) continue;
          var idx = py * this.w + px;
          var key = idx;
          if (opts.bold && levelAt[key] !== undefined && levelAt[key] >= level) continue;
          levelAt[key] = level;
          this.px[idx] = shades[level];
        }
      }
    }
    x += gw2 + (opts.bold ? 1 : 0);
  }
  return w;
};
Canvas.prototype.toPNG = function () { return png.encodeIndexed(this.w, this.h, this.px, this.palette); };

// ---------- 版面 ----------

var C = {
  bg: "#ffffff", head: "#1e3a8a", headText: "#ffffff", headSub: "#c7d2fe", text: "#0f172a", sub: "#64748b",
  line: "#e2e8f0", zebra: "#f8fafc", section: "#1e40af", thBg: "#eef2ff", good: "#16a34a", mid: "#d97706", bad: "#dc2626", none: "#94a3b8"
};
var W = 1000, PAD = 28, ROW = 32, FH = 24;

function latColor(v) { return v === null || v === undefined ? C.none : v < 80 ? C.good : v < 180 ? C.mid : C.bad; }
function pctColor(v) { return v === null || v === undefined ? C.none : v < 1 ? C.good : v < 5 ? C.mid : C.bad; }
function lossColor(v) { return v === null || v === undefined ? C.none : v <= 0 ? C.good : v < 5 ? C.mid : C.bad; }
function pctText(v) { return v === null || v === undefined ? "-" : (v < 10 ? v.toFixed(2) : v.toFixed(1)) + "%"; }

function latencyBlocks(latency) {
  var out = [];
  ["4", "6"].forEach(function (fam) {
    var rows = latency.filter(function (r) { return r.family === fam; });
    if (!rows.length) return;
    var provs = [], map = {}, others = [];
    rows.forEach(function (r) {
      var col = parser.ispOrder(r.isp);
      if (col > 2) { others.push(r); return; }
      if (!map[r.prov]) { map[r.prov] = [null, null, null]; provs.push(r.prov); }
      map[r.prov][col] = r;
    });
    var lines = provs.map(function (p) { return { label: fmt.tProv(p), cells: map[p] }; });
    others.forEach(function (r) { lines.push({ label: fmt.tProv(r.prov) + fmt.tIsp(r.isp), cells: [r, null, null] }); });
    var t = fmt.latencyTables(rows)[0];
    out.push({ family: fam, lines: lines, summary: t ? t.summary : "", count: rows[0].sent });
  });
  return out;
}

// job: {type,family,points,mode,startedAt,finishedAt}；r: parser 結果
function renderResult(job, nodeName, r, opts) {
  opts = opts || {};
  var lat = r && r.latency ? latencyBlocks(r.latency) : [];
  var speed = r && r.speed ? r.speed : [];
  var single = job.mode !== "multi", multi = job.mode !== "single";
  var fams = ["4", "6"].filter(function (f) { return speed.some(function (s) { return s.family === f; }); });

  // 先算高度
  var h = 96 + 40;
  lat.forEach(function (b) { h += 44 + ROW + b.lines.length * ROW + 40; });
  fams.forEach(function (f) { h += 44 + ROW + speed.filter(function (s) { return s.family === f; }).length * ROW + 16; });
  if (fams.length) h += 28;
  var msgs = (r ? r.errors.map(function (e) { return "錯誤：" + e; }) : ["沒有收到節點結果"]);
  h += msgs.length * 28 + 56;

  var cv = new Canvas(W, h, C.bg);
  // 標題列
  cv.rect(0, 0, W, 96, C.head);
  cv.text(PAD, 16, cv.fit(fmt.typeLabel(job.type) + "｜" + nodeName, W - 2 * PAD), C.headText, C.head, { bold: true });
  var meta = fmt.familyLabel(job.family) + (job.type !== "ping" ? "　測速點 " + fmt.pointsLabel(job.points) + "　" + fmt.modeLabel(job.mode) : "") + "　" + fmt.fmtTime(job.finishedAt || new Date().toISOString());
  cv.text(PAD, 54, meta, C.headSub, C.head, { maxW: W - 2 * PAD });
  var y = 96 + 12;
  var info = [];
  if (r && r.ip4) info.push("IPv4 出口 " + (opts.showIp ? r.ip4 : parser.maskIp(r.ip4)));
  if (r && r.ip6) info.push("IPv6 出口 " + (opts.showIp ? r.ip6 : parser.maskIp(r.ip6)));
  if (r && r.exit) info.push("泰爾識別 " + r.exit);
  cv.text(PAD, y, info.join("　") || " ", C.sub, C.bg, { maxW: W - 2 * PAD });
  y += 28;

  // 延遲 / 丟包
  var gx0 = PAD + 140, gw = (W - 2 * PAD - 140) / 3;
  lat.forEach(function (b) {
    y += 12;
    cv.text(PAD, y, "IPv" + b.family + " 三網 TCP 延遲 / 丟包（每個目標握手 " + b.count + " 次）", C.section, C.bg, { bold: true });
    y += 32;
    cv.rect(PAD, y, W - 2 * PAD, ROW, C.thBg);
    cv.text(PAD + 10, y + 4, "省份", C.sub, C.thBg);
    ["電信", "聯通", "移動"].forEach(function (n, i) {
      var gx = gx0 + gw * i;
      cv.text(gx + gw * 0.42, y + 4, n + " 延遲", C.sub, C.thBg, { align: "right" });
      cv.text(gx + gw - 16, y + 4, "丟包", C.sub, C.thBg, { align: "right" });
    });
    y += ROW;
    b.lines.forEach(function (line, li) {
      var bg = li % 2 ? C.zebra : C.bg;
      if (bg !== C.bg) cv.rect(PAD, y, W - 2 * PAD, ROW, bg);
      cv.text(PAD + 10, y + 4, line.label, C.text, bg, { maxW: 130 });
      line.cells.forEach(function (c, i) {
        var gx = gx0 + gw * i;
        if (!c) { cv.text(gx + gw * 0.42, y + 4, "-", C.none, bg, { align: "right" }); return; }
        if (!c.recv) { cv.text(gx + gw * 0.42, y + 4, "不通", C.bad, bg, { align: "right" }); cv.text(gx + gw - 16, y + 4, "100%", C.bad, bg, { align: "right" }); return; }
        cv.text(gx + gw * 0.42, y + 4, fmt.fmtMs(c.avg) + " ms", latColor(c.avg), bg, { align: "right" });
        cv.text(gx + gw - 16, y + 4, (c.loss < 10 ? c.loss.toFixed(1) : Math.round(c.loss)) + "%", lossColor(c.loss), bg, { align: "right" });
      });
      y += ROW;
    });
    cv.rect(PAD, y, W - 2 * PAD, 1, C.line);
    y += 8;
    cv.text(PAD, y, b.summary, C.sub, C.bg, { maxW: W - 2 * PAD });
    y += 32;
  });

  // 泰爾測速 + 回程重傳
  fams.forEach(function (fam) {
    var rows = speed.filter(function (s) { return s.family === fam; });
    y += 12;
    cv.text(PAD, y, "IPv" + fam + " 泰爾測速（Mbps）", C.section, C.bg, { bold: true });
    y += 32;
    var cols = [{ k: "rtt", t: "延遲" }];
    if (single) cols.push({ k: "singleDown", t: "單線程↓" }, { k: "singleUp", t: "單線程↑" });
    if (multi) cols.push({ k: "multiDown", t: "多線程↓" }, { k: "multiUp", t: "多線程↑" });
    cols.push({ k: "upRetrans", t: "回程重傳" });
    var x0 = PAD + 170, cw = (W - 2 * PAD - 170) / cols.length;
    cv.rect(PAD, y, W - 2 * PAD, ROW, C.thBg);
    cv.text(PAD + 10, y + 4, "測速點", C.sub, C.thBg);
    cols.forEach(function (c, i) { cv.text(x0 + cw * (i + 1) - 14, y + 4, c.t, C.sub, C.thBg, { align: "right" }); });
    y += ROW;
    rows.forEach(function (s, li) {
      var bg = li % 2 ? C.zebra : C.bg;
      if (bg !== C.bg) cv.rect(PAD, y, W - 2 * PAD, ROW, bg);
      cv.text(PAD + 10, y + 4, fmt.tProv(s.prov) + fmt.tIsp(s.isp), C.text, bg, { maxW: 150 });
      cols.forEach(function (c, i) {
        var v = s[c.k], txt, col;
        if (c.k === "rtt") { txt = v === null ? "-" : fmt.fmtMs(v) + " ms"; col = latColor(v); }
        else if (c.k === "upRetrans") { txt = pctText(v) + (s.rtxSource === "snmp" ? "≈" : ""); col = pctColor(v); }
        else { txt = v === null || v === undefined || v < 0.001 ? "失敗" : fmt.fmtMbps(v); col = txt === "失敗" ? C.bad : C.text; }
        cv.text(x0 + cw * (i + 1) - 14, y + 4, txt, col, bg, { align: "right" });
      });
      y += ROW;
    });
    cv.rect(PAD, y, W - 2 * PAD, 1, C.line);
    y += 4;
  });
  if (fams.length) {
    cv.text(PAD, y + 4, "↓ 去程（中國→節點）　↑ 回程（節點→中國）　回程重傳＝測速期間節點送出資料的 TCP 重傳比例", C.sub, C.bg, { maxW: W - 2 * PAD });
    y += 28;
  }

  msgs.forEach(function (m) { cv.text(PAD, y + 4, m, C.bad, C.bg, { maxW: W - 2 * PAD }); y += 28; });
  cv.rect(0, h - 40, W, 40, C.thBg);
  cv.text(PAD, h - 32, "Komari cn-speedtest　延遲 / 丟包：TCP 握手探測（TcpQuality 節點）　測速：泰爾測速", C.sub, C.thBg, { maxW: W - 2 * PAD });
  return cv.toPNG();
}

module.exports = { renderResult: renderResult, Canvas: Canvas };
