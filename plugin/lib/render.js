// plugin/lib/render.js
// 把一個節點的測試結果畫成 PNG 報告圖（純 JS：點陣字型 + 索引色畫布 + png.js）。

"use strict";

var png = require("./png.js");
var parser = require("./parser.js");
var fmt = require("./format.js");
var zh = require("./zh.js");

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
Canvas.prototype.conv = function (s) { s = String(s); return this.cn ? zh.toCN(s) : s; };
Canvas.prototype.textWidth = function (s, bold) {
  var f = font(), w = 0;
  s = this.conv(s);
  for (var i = 0; i < s.length; i++) {
    var gi = f.index[s.charAt(i)];
    var code = s.charCodeAt(i);
    if (gi === undefined && ((code >= 0xd800 && code <= 0xdfff) || (code >= 0xfe00 && code <= 0xfe0f) || code === 0x200d)) continue;
    w += gi === undefined ? (code > 0x2e80 ? 17 : 9) : f.widths[gi] + (bold ? 1 : 0);
  }
  return w;
};
Canvas.prototype.fit = function (s, maxW, bold) {
  s = this.conv(s);
  if (this.textWidth(s, bold) <= maxW) return s;
  while (s.length > 1 && this.textWidth(s + "…", bold) > maxW) s = s.slice(0, -1);
  return s + "…";
};
// 以背景色 bg 與文字色 fg 的 4 階混色畫字；bold = 水平重疊 1px
Canvas.prototype.text = function (x, y, s, fg, bg, opts) {
  opts = opts || {};
  var f = font();
  var bold = Boolean(opts.bold);
  s = this.conv(s);
  if (opts.maxW) s = this.fit(s, opts.maxW, bold);
  var w = this.textWidth(s, bold);
  if (opts.align === "right") x -= w;
  else if (opts.align === "center") x -= w / 2;
  x = Math.round(x); y = Math.round(y);
  var F = hex(fg), B = hex(bg);
  var shades = [null];
  for (var a = 1; a <= 3; a++) shades.push(this.color([Math.round(B[0] + (F[0] - B[0]) * a / 3), Math.round(B[1] + (F[1] - B[1]) * a / 3), Math.round(B[2] + (F[2] - B[2]) * a / 3)]));
  var levelAt = bold ? {} : null;
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
      var rowOff = py * this.w;
      for (var gx = 0; gx < gw2; gx++) {
        var bitIndex = gy * gw2 + gx;
        var byte = f.data[base + (bitIndex >> 2)];
        var level = (byte >> (6 - 2 * (bitIndex & 3))) & 3;
        if (!level) continue;
        if (!bold) {
          var px0 = x + gx;
          if (px0 >= 0 && px0 < this.w) this.px[rowOff + px0] = shades[level];
          continue;
        }
        for (var r = 0; r < 2; r++) {
          var px = x + gx + r;
          if (px < 0 || px >= this.w) continue;
          var idx = rowOff + px;
          if (levelAt[idx] !== undefined && levelAt[idx] >= level) continue;
          levelAt[idx] = level;
          this.px[idx] = shades[level];
        }
      }
    }
    x += gw2 + (bold ? 1 : 0);
  }
  return w;
};
Canvas.prototype.toPNG = function () { return png.encodeIndexed(this.w, this.h, this.px, this.palette); };

// ---------- 版面 ----------

var C = {
  bg: "#ffffff", head: "#1e3a8a", headText: "#ffffff", headSub: "#c7d2fe", text: "#0f172a", sub: "#64748b",
  line: "#e2e8f0", zebra: "#f8fafc", section: "#1e40af", thBg: "#eef2ff", thBgL: "#e0e7ff",
  largeBg: "#f8fafc", largeZebra: "#f1f5f9", good: "#16a34a", mid: "#d97706", bad: "#dc2626", none: "#94a3b8"
};
var W = 1000, PAD = 28, ROW = 32, FH = 24;

function latColor(v) { return v === null || v === undefined ? C.none : v < 80 ? C.good : v < 180 ? C.mid : C.bad; }
function pctColor(v) { return v === null || v === undefined ? C.none : v < 1 ? C.good : v < 5 ? C.mid : C.bad; }
function lossColor(v) { return v === null || v === undefined ? C.none : v <= 0 ? C.good : v < 5 ? C.mid : C.bad; }
function pctText(v) { return v === null || v === undefined ? "-" : (v < 10 ? v.toFixed(2) : v.toFixed(1)) + "%"; }

function groupLatRows(rows) {
  var provs = [], map = {}, others = [];
  rows.forEach(function (r) {
    var col = parser.ispOrder(r.isp);
    if (col > 2) { others.push(r); return; }
    if (!map[r.prov]) { map[r.prov] = [null, null, null]; provs.push(r.prov); }
    if (!map[r.prov][col] || (r.avg !== null && (map[r.prov][col].avg === null || r.avg < map[r.prov][col].avg))) map[r.prov][col] = r;
  });
  return { provs: provs, map: map, others: others };
}

function latencyBlocks(latency, latencyLarge) {
  var out = [];
  ["4", "6"].forEach(function (fam) {
    var sRows = (latency || []).filter(function (r) { return r.family === fam; });
    var lRows = (latencyLarge || []).filter(function (r) { return r.family === fam; });
    if (!sRows.length && !lRows.length) return;
    if (sRows.length && lRows.length) {
      var sg = groupLatRows(sRows), lg = groupLatRows(lRows);
      var provs = sg.provs.slice();
      lg.provs.forEach(function (p) { if (provs.indexOf(p) < 0) provs.push(p); });
      var lines = provs.map(function (p) { return { label: fmt.tProv(p), sCells: sg.map[p] || [null, null, null], lCells: lg.map[p] || [null, null, null] }; });
      var oKeys = [], oS = {}, oL = {};
      sg.others.forEach(function (r) { var k = r.prov + "|" + r.isp; if (!oS[k]) { oS[k] = r; oKeys.push(k); } });
      lg.others.forEach(function (r) { var k = r.prov + "|" + r.isp; if (!oL[k]) { oL[k] = r; if (oKeys.indexOf(k) < 0) oKeys.push(k); } });
      oKeys.forEach(function (k) {
        var r = oS[k] || oL[k];
        lines.push({ label: fmt.tProv(r.prov) + fmt.tIsp(r.isp), sCells: [oS[k] || null, null, null], lCells: [oL[k] || null, null, null] });
      });
      var tS = fmt.latencyTables(sRows)[0], tL = fmt.latencyTables(lRows, "大包")[0];
      out.push({ family: fam, dual: true, lines: lines, summary: tS ? tS.summary : "", largeSummary: tL ? tL.summary : "", note: tS ? tS.note : "", count: sRows[0].sent, largeCount: lRows[0].sent });
      return;
    }
    var isLarge = !sRows.length;
    var rows = isLarge ? lRows : sRows;
    var g = groupLatRows(rows);
    var singleLines = g.provs.map(function (p) { return { label: fmt.tProv(p), cells: g.map[p] }; });
    g.others.forEach(function (r) { singleLines.push({ label: fmt.tProv(r.prov) + fmt.tIsp(r.isp), cells: [r, null, null] }); });
    var t = fmt.latencyTables(rows, isLarge ? "大包" : "")[0];
    out.push({ family: fam, dual: false, large: isLarge, lines: singleLines, summary: t ? t.summary : "", note: t && !isLarge ? t.note : "", count: rows[0].sent });
  });
  return out;
}

// job: {type,family,points,mode,startedAt,finishedAt}；r: parser 結果
function renderResult(job, nodeName, r, opts) {
  opts = opts || {};
  var lat = r ? latencyBlocks(r.latency, r.latencyLarge) : [];
  var speed = r && r.speed ? r.speed : [];
  var single = job.mode !== "multi", multi = job.mode !== "single";
  var fams = ["4", "6"].filter(function (f) { return speed.some(function (s) { return s.family === f; }); });

  // 先算高度
  var h = 96 + 40;
  // 註解太長時換行
  var measure = new Canvas(W, 1, C.bg);
  measure.cn = opts.lang === "zh_CN";
  lat.forEach(function (b) {
    b.noteLines = [];
    if (!b.note) return;
    var head = b.note.slice(0, b.note.indexOf("：") + 1), items = b.note.slice(head.length).split("、"), line = head;
    items.forEach(function (it, i) {
      var add = (line === head ? "" : "、") + it;
      if (measure.textWidth(line + add) > W - 2 * PAD && line !== head) { b.noteLines.push(line + "、"); line = "　" + it; }
      else line += add;
    });
    b.noteLines.push(line);
  });
  lat.forEach(function (b) {
    var headH = b.dual ? 60 : ROW;
    var sumH = b.dual ? 68 : 40;
    h += 44 + headH + b.lines.length * ROW + sumH + b.noteLines.length * 28;
  });
  fams.forEach(function (f) { h += 44 + ROW + speed.filter(function (s) { return s.family === f; }).length * ROW + 16; });
  var anyLarge = speed.some(function (x) { return x.rttLarge !== undefined && x.rttLarge !== null; });
  if (fams.length) h += anyLarge ? 56 : 28;
  var msgs = (r ? r.errors.map(function (e) { return "錯誤：" + e; }) : ["沒有收到節點結果"]);
  var notes = r && fmt.retryNote(r) ? ["※ " + fmt.retryNote(r)] : [];
  if (r && fmt.trafficText(r)) notes.unshift(fmt.trafficText(r));
  h += notes.length * 28;
  h += msgs.length * 28 + 56;

  var cv = new Canvas(W, h, C.bg);
  cv.cn = opts.lang === "zh_CN";
  // 標題列
  cv.rect(0, 0, W, 96, C.head);
  cv.text(PAD, 16, cv.fit(fmt.typeLabel(job.type) + "｜" + nodeName, W - 2 * PAD, true), C.headText, C.head, { bold: true });
  var meta = fmt.familyLabel(job.family) + "　" + fmt.ispsLabel(job.isps) + (job.type !== "ping" ? "　測速點 " + fmt.pointsLabel(job.points) + "　" + fmt.modeLabel(job.mode) : "") + "　" + fmt.fmtTime((r && r.finishedAt) || job.finishedAt || new Date().toISOString());
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
  var provW = 116, halfW = (W - 2 * PAD - provW) / 2, colW = halfW / 3;
  var sx0 = PAD + provW, lx0 = sx0 + halfW;
  function drawDualCell(c, colCenter, rowY, cellBg) {
    if (!c) { cv.text(colCenter, rowY + 4, "-", C.none, cellBg, { align: "center" }); return; }
    if (!c.recv) { cv.text(colCenter, rowY + 4, "不通", C.bad, cellBg, { align: "center" }); return; }
    if (c.loss > 0) {
      var at = fmt.fmtMs(c.avg) + (c.sameAs ? "*" : "");
      var lt = (c.loss < 10 ? c.loss.toFixed(1) : Math.round(c.loss)) + "%";
      var aw = cv.textWidth(at), lw = cv.textWidth(lt), tw = aw + 6 + lw;
      var x0 = Math.round(colCenter - tw / 2);
      cv.text(x0, rowY + 4, at, latColor(c.avg), cellBg);
      cv.text(x0 + aw + 6, rowY + 4, lt, lossColor(c.loss), cellBg);
    } else {
      cv.text(colCenter, rowY + 4, fmt.fmtMs(c.avg) + (c.avg !== null ? " ms" : "") + (c.sameAs ? "*" : ""), latColor(c.avg), cellBg, { align: "center" });
    }
  }
  lat.forEach(function (b) {
    y += 12;
    if (b.dual) {
      var lsz = fmt.largeSizeLabel(r, b.family);
      cv.text(PAD, y, "IPv" + b.family + " 三網延遲 / 丟包（標準 × " + b.count + " 次 ｜ 大包回程 " + lsz + " × " + b.largeCount + " 次）", C.section, C.bg, { bold: true });
      y += 32;
      // 雙層表頭：左半標準、右半大包
      cv.rect(PAD, y, provW + halfW, 60, C.thBg);
      cv.rect(lx0, y, halfW, 60, C.thBgL);
      cv.text(PAD + 10, y + 18, "省份", C.sub, C.thBg);
      cv.text(sx0 + halfW / 2, y + 3, "標準（TCP 握手）", C.section, C.thBg, { align: "center", bold: true });
      cv.text(lx0 + halfW / 2, y + 3, "大包回程（" + lsz + "）", C.section, C.thBgL, { align: "center", bold: true });
      cv.rect(sx0, y + 30, W - PAD - sx0, 1, C.line);
      ["電信", "聯通", "移動"].forEach(function (n, i) {
        cv.text(sx0 + colW * (i + 0.5), y + 34, n, C.sub, C.thBg, { align: "center" });
        cv.text(lx0 + colW * (i + 0.5), y + 34, n, C.sub, C.thBgL, { align: "center" });
      });
      cv.rect(sx0, y, 1, 60, C.line);
      cv.rect(lx0, y, 1, 60, C.line);
      y += 60;
      b.lines.forEach(function (line, li) {
        var bgS = li % 2 ? C.zebra : C.bg;
        var bgL = li % 2 ? C.largeZebra : C.largeBg;
        if (bgS !== C.bg) cv.rect(PAD, y, provW + halfW, ROW, bgS);
        cv.rect(lx0, y, halfW, ROW, bgL);
        cv.rect(sx0, y, 1, ROW, C.line);
        cv.rect(lx0, y, 1, ROW, C.line);
        cv.text(PAD + 10, y + 4, line.label, C.text, bgS, { maxW: provW - 16 });
        line.sCells.forEach(function (c, i) { drawDualCell(c, sx0 + colW * (i + 0.5), y, bgS); });
        line.lCells.forEach(function (c, i) { drawDualCell(c, lx0 + colW * (i + 0.5), y, bgL); });
        y += ROW;
      });
      cv.rect(PAD, y, W - 2 * PAD, 1, C.line);
      y += 8;
      cv.text(PAD, y, "• " + b.summary, C.sub, C.bg, { maxW: W - 2 * PAD });
      y += 28;
      cv.text(PAD, y, "• " + b.largeSummary, C.sub, C.bg, { maxW: W - 2 * PAD });
      y += 32;
      b.noteLines.forEach(function (nl) { cv.text(PAD, y - 4, nl, C.sub, C.bg, { maxW: W - 2 * PAD }); y += 28; });
      return;
    }
    cv.text(PAD, y, b.large
      ? "IPv" + b.family + " 大包回程延遲 / 丟包（" + fmt.largeSizeLabel(r, b.family) + " × " + b.count + " 次）"
      : "IPv" + b.family + " 三網 TCP 延遲 / 丟包（每個目標握手 " + b.count + " 次）", C.section, C.bg, { bold: true });
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
        cv.text(gx + gw * 0.42, y + 4, fmt.fmtMs(c.avg) + " ms" + (c.sameAs ? "*" : ""), latColor(c.avg), bg, { align: "right" });
        cv.text(gx + gw - 16, y + 4, (c.loss < 10 ? c.loss.toFixed(1) : Math.round(c.loss)) + "%", lossColor(c.loss), bg, { align: "right" });
      });
      y += ROW;
    });
    cv.rect(PAD, y, W - 2 * PAD, 1, C.line);
    y += 8;
    cv.text(PAD, y, b.summary, C.sub, C.bg, { maxW: W - 2 * PAD });
    y += 32;
    b.noteLines.forEach(function (nl) { cv.text(PAD, y - 4, nl, C.sub, C.bg, { maxW: W - 2 * PAD }); y += 28; });
  });

  // 泰爾測速 + 回程重傳
  fams.forEach(function (fam) {
    var rows = speed.filter(function (s) { return s.family === fam; });
    y += 12;
    cv.text(PAD, y, "IPv" + fam + " 泰爾測速（Mbps）", C.section, C.bg, { bold: true });
    y += 32;
    var largeCol = rows.some(function (x) { return x.rttLarge !== undefined && x.rttLarge !== null; });
    var cols = [largeCol ? { k: "rttLarge", t: "大包延遲" } : { k: "rtt", t: "延遲" }];
    if (single) cols.push({ k: "singleDown", t: "單線程↓" }, { k: "singleUp", t: "單線程↑" });
    if (multi) cols.push({ k: "multiDown", t: "多線程↓" }, { k: "multiUp", t: "多線程↑" });
    cols.push({ k: "upRetrans", t: "回程重傳" });
    if (rows.some(function (x) { return x.trafficRx !== undefined; })) cols.push({ k: "traffic", t: "流量" });
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
        else if (c.k === "rttLarge") {
          if (v === null || v === undefined) { txt = s.lossLarge === 100 ? "不通" : "-"; col = s.lossLarge === 100 ? C.bad : C.none; }
          else { txt = fmt.fmtMs(v) + (s.lossLarge > 0 ? "/" + Math.round(s.lossLarge) + "%" : " ms"); col = s.lossLarge > 0 ? lossColor(s.lossLarge) : latColor(v); }
        }
        else if (c.k === "upRetrans") { txt = pctText(v) + (s.rtxSource === "snmp" ? "≈" : ""); col = pctColor(v); }
        else if (c.k === "traffic") { txt = s.trafficRx === undefined ? "-" : fmt.fmtBytes(s.trafficRx + s.trafficTx); col = C.sub; }
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
    if (anyLarge) { y += 28; cv.text(PAD, y + 4, "大包延遲＝" + fmt.largeSizeLabel(r) + " 的封包到泰爾測速伺服器的延遲（有丟包時顯示 延遲/丟包率）", C.sub, C.bg, { maxW: W - 2 * PAD }); }
    y += 28;
  }

  notes.forEach(function (m) { cv.text(PAD, y + 4, m, m.charAt(0) === "※" ? C.mid : C.text, C.bg, { maxW: W - 2 * PAD }); y += 28; });
  msgs.forEach(function (m) { cv.text(PAD, y + 4, m, C.bad, C.bg, { maxW: W - 2 * PAD }); y += 28; });
  cv.rect(0, h - 40, W, 40, C.thBg);
  cv.text(PAD, h - 32, "Komari cn-speedtest　延遲 / 丟包：TCP 握手探測（TcpQuality 節點）　測速：泰爾測速", C.sub, C.thBg, { maxW: W - 2 * PAD });
  return cv.toPNG();
}

module.exports = { renderResult: renderResult, Canvas: Canvas };
