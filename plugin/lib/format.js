// plugin/lib/format.js
// 把測試結果整理成 Telegram（HTML parse_mode）可讀的文字表格。

"use strict";

var parser = require("./parser.js");

var ISP_T = { "电信": "電信", "联通": "聯通", "移动": "移動" };
var PROV_T = {
  "广东": "廣東", "广西": "廣西", "重庆": "重慶", "黑龙江": "黑龍江", "辽宁": "遼寧", "江苏": "江蘇",
  "贵州": "貴州", "云南": "雲南", "陕西": "陝西", "甘肃": "甘肅", "宁夏": "寧夏", "内蒙古": "內蒙古",
  "台湾": "台灣", "澳门": "澳門", "宁波": "寧波", "苏州": "蘇州", "东莞": "東莞", "青岛": "青島",
  "厦门": "廈門", "无锡": "無錫", "新疆": "新疆", "山东": "山東", "海南": "海南"
};

function esc(s) {
  return String(s === undefined || s === null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function tIsp(s) { return ISP_T[s] || s; }
function tProv(s) { return PROV_T[s] || s; }

// 中文字寬度約為 2
function width(s) {
  var w = 0;
  s = String(s);
  for (var i = 0; i < s.length; i++) w += s.charCodeAt(i) > 0x2e80 ? 2 : 1;
  return w;
}
function padR(s, w) { s = String(s); var n = w - width(s); return n > 0 ? s + new Array(n + 1).join(" ") : s; }
function padL(s, w) { s = String(s); var n = w - width(s); return n > 0 ? new Array(n + 1).join(" ") + s : s; }

function fmtMs(v) {
  if (v === null || v === undefined) return "-";
  return v < 10 ? v.toFixed(1) : String(Math.round(v));
}
function fmtMbps(v) {
  if (v === null || v === undefined || v < 0.001) return "失敗";
  if (v >= 1000) return v.toFixed(0);
  if (v >= 100) return v.toFixed(0);
  return v.toFixed(1);
}

function typeLabel(t) {
  return t === "ping" ? "延遲測試" : t === "speed" ? "泰爾測速" : "完整測試";
}
function familyLabel(f) {
  return f === "4" ? "IPv4" : f === "6" ? "IPv6" : "IPv4 + IPv6";
}
function modeLabel(m) {
  return m === "multi" ? "多線程" : m === "both" ? "單線程 + 多線程" : "單線程";
}
function ispsLabel(isps) {
  if (!isps || !isps.length || isps.length >= 3) return "三網";
  return isps.map(tIsp).join("、");
}

// 自動重測說明
function retryNote(r) {
  if (!r || !r.retries || !r.retries.length) return "";
  return "已自動重測：" + r.retries.map(function (x) {
    var m = String(x.point).match(/^(.*?)(电信|联通|移动)?$/);
    var md = x.mode === "multi" ? "多線程" : x.mode === "single" ? "單線程" : "";
    return tProv(m[1]) + tIsp(m[2] || "") + (md ? "（" + md + "）" : "") + " ×" + x.retries + (x.stillFailed ? "（仍有失敗）" : "");
  }).join("、");
}

function pointsLabel(p) {
  return p ? p : "北上廣";
}

// 延遲：每個協議一張「省份 × 三網」表，格內為 平均ms（丟包率>0 時附上 %）
// tag：表頭 / 摘要的附加字（例如「大包」）
function latencyTables(latency, tag) {
  tag = tag || "";
  var out = [];
  ["4", "6"].forEach(function (fam) {
    var rows = latency.filter(function (r) { return r.family === fam; });
    if (!rows.length) return;
    var provs = [];
    var map = {};
    var others = [];
    rows.forEach(function (r) {
      var col = parser.ispOrder(r.isp);
      if (col > 2) { others.push(r); return; }
      if (!map[r.prov]) { map[r.prov] = [null, null, null]; provs.push(r.prov); }
      if (!map[r.prov][col] || (r.avg !== null && (map[r.prov][col].avg === null || r.avg < map[r.prov][col].avg))) map[r.prov][col] = r;
    });
    var cell = function (r) {
      if (!r) return "";
      if (!r.recv) return "×";
      var s = fmtMs(r.avg);
      if (r.loss > 0) s += "/" + Math.round(r.loss) + "%";
      return s + (r.sameAs ? "*" : "");
    };
    var lines = [];
    lines.push(padR("IPv" + fam + tag, 8) + padL("電信", 9) + padL("聯通", 9) + padL("移動", 9));
    var all = [];
    provs.forEach(function (p) {
      var c = map[p];
      lines.push(padR(tProv(p), 8) + padL(cell(c[0]), 9) + padL(cell(c[1]), 9) + padL(cell(c[2]), 9));
      c.forEach(function (r) { if (r && r.recv) all.push(r); });
    });
    others.forEach(function (r) {
      lines.push(padR(tProv(r.prov) + tIsp(r.isp), 17) + padL(cell(r), 9));
      if (r.recv) all.push(r);
    });
    var summary = "";
    if (all.length) {
      var best = all.slice().sort(function (a, b) { return a.avg - b.avg; })[0];
      var avg = all.reduce(function (s, r) { return s + r.avg; }, 0) / all.length;
      var sent = 0, lost = 0, rtx = 0;
      rows.forEach(function (r) { sent += r.sent; lost += r.sent - r.recv; rtx += r.synRetrans || 0; });
      var worst = rows.slice().sort(function (a, b) { return b.loss - a.loss; })[0];
      summary = "IPv" + fam + (tag ? " " + tag : "") + "：平均 " + fmtMs(avg) + " ms，整體丟包 " + (sent ? (lost / sent * 100).toFixed(1) : "0") + "%" +
        (rtx ? "（握手重傳 " + rtx + " 次）" : "") +
        "，最佳 " + tProv(best.prov) + tIsp(best.isp) + " " + fmtMs(best.avg) + " ms" +
        (worst && worst.loss > 0 ? "，丟包最多 " + tProv(worst.prov) + tIsp(worst.isp) + " " + Math.round(worst.loss) + "%" : "");
    } else {
      summary = "IPv" + fam + (tag ? " " + tag : "") + "：全部節點不通";
    }
    var shared = rows.filter(function (r) { return r.sameAs; }).map(function (r) {
      var m = String(r.sameAs).match(/^(.*?)(电信|联通|移动)?$/);
      return tProv(r.prov) + tIsp(r.isp) + "＝" + tProv(m[1]) + tIsp(m[2] || "");
    });
    out.push({ family: fam, table: lines.join("\n"), summary: summary, note: shared.length ? "* 共用同一節點（Zstatic 在該省沒有獨立節點）：" + shared.join("、") : "" });
  });
  return out;
}

function speedTable(speed, mode) {
  var out = [];
  ["4", "6"].forEach(function (fam) {
    var rows = speed.filter(function (r) { return r.family === fam; });
    if (!rows.length) return;
    var lines = [];
    var single = mode !== "multi";
    var multi = mode !== "single";
    var large = rows.some(function (r) { return r.rttLarge !== undefined && r.rttLarge !== null; });
    var lw = large ? 10 : 6;
    var head = padR("IPv" + fam, 11) + padL(large ? "大包延遲" : "延遲", lw);
    if (single) head += padL("單↓", 7) + padL("單↑", 7);
    if (multi) head += padL("多↓", 7) + padL("多↑", 7);
    lines.push(head);
    rows.forEach(function (r) {
      var lat = large ? (r.rttLarge === undefined || r.rttLarge === null ? (r.lossLarge === 100 ? "×" : "-") : fmtMs(r.rttLarge) + (r.lossLarge > 0 ? "/" + Math.round(r.lossLarge) + "%" : "")) : fmtMs(r.rtt);
      var l = padR(tProv(r.prov) + tIsp(r.isp), 11) + padL(lat, lw);
      if (single) l += padL(fmtMbps(r.singleDown), 7) + padL(fmtMbps(r.singleUp), 7);
      if (multi) l += padL(fmtMbps(r.multiDown), 7) + padL(fmtMbps(r.multiUp), 7);
      lines.push(l);
    });
    out.push({ family: fam, table: lines.join("\n"), large: large });
  });
  return out;
}

// 大包大小說明，例如「1400 B」；IPv4 / IPv6 因 MTU 不同時分開列
function largeSizeLabel(r) {
  var z = r && r.largeSize;
  if (!z) return "1400 B";
  if (z.v4 && z.v6 && z.v4 !== z.v6) return "IPv4 " + z.v4 + " B／IPv6 " + z.v6 + " B";
  return (z.v4 || z.v6 || z.wanted) + " B";
}

function fmtPct(v) {
  if (v === null || v === undefined) return "-";
  return v < 10 ? v.toFixed(2) + "%" : v.toFixed(1) + "%";
}

// 測速期間的回程 TCP 重傳率（節點送往中國的資料被重傳的比例，與 TcpQuality 的「回程重傳」相同）
function retransTable(speed) {
  var rows = speed.filter(function (r) { return r.rtxSource; });
  if (!rows.length) return null;
  var approx = rows.some(function (r) { return r.rtxSource === "snmp"; });
  var lines = [padR("測速點", 14) + padL("回程重傳", 10)];
  rows.forEach(function (r) {
    lines.push(padR(tProv(r.prov) + tIsp(r.isp) + " v" + r.family, 14) + padL(fmtPct(r.upRetrans) + (r.rtxSource === "snmp" ? "≈" : ""), 10));
  });
  return { table: lines.join("\n"), approx: approx };
}

// 產生一個節點結果的 Telegram HTML 文字（可能超過 4096，呼叫端會切段）
function nodeResultHTML(job, nodeName, r, opts) {
  opts = opts || {};
  var parts = [];
  parts.push("<b>🇨🇳 " + esc(typeLabel(job.type)) + "｜" + esc(nodeName) + "</b>");
  var meta = "協議：" + familyLabel(job.family) + "｜運營商：" + ispsLabel(job.isps);
  if (job.type !== "ping") meta += "｜測速點：" + esc(pointsLabel(job.points)) + "｜" + modeLabel(job.mode);
  parts.push(meta);
  if (r) {
    var ipLine = [];
    if (r.ip4) ipLine.push("v4 " + esc(opts.showIp ? r.ip4 : parser.maskIp(r.ip4)));
    if (r.ip6) ipLine.push("v6 " + esc(opts.showIp ? r.ip6 : parser.maskIp(r.ip6)));
    if (ipLine.length) parts.push("出口：" + ipLine.join("｜") + (r.exit ? "（" + esc(r.exit) + "）" : ""));
    else if (r.exit) parts.push("出口：" + esc(r.exit));
  }
  if (!r) {
    parts.push("\n⚠️ 沒有收到節點回傳結果");
    return parts.join("\n");
  }
  if (r.latency.length) {
    var lt = latencyTables(r.latency);
    parts.push("\n<b>📶 三網 TCP 延遲 / 丟包（ms，平均/丟包率）</b>");
    lt.forEach(function (t) { parts.push("<pre>" + esc(t.table) + "</pre>"); });
    lt.forEach(function (t) { parts.push("• " + esc(t.summary)); });
    lt.forEach(function (t) { if (t.note) parts.push(esc(t.note)); });
    if (r.nodeLists && r.nodeLists.length) parts.push(esc("節點清單：" + r.nodeLists.map(function (x) { return x.scope + " " + x.count + " 個" + (x.http !== "200" ? "（HTTP " + x.http + "）" : ""); }).join("、")));
  }
  if (r.latencyLarge && r.latencyLarge.length) {
    var ll = latencyTables(r.latencyLarge, "大包");
    parts.push("\n<b>🧱 大包（" + esc(largeSizeLabel(r)) + "）回程延遲 / 丟包</b>");
    ll.forEach(function (t) { parts.push("<pre>" + esc(t.table) + "</pre>"); });
    ll.forEach(function (t) { parts.push("• " + esc(t.summary)); });
  }
  if (r.speed.length) {
    parts.push("\n<b>🚀 泰爾測速（Mbps）</b>");
    var sts = speedTable(r.speed, job.mode);
    sts.forEach(function (t) { parts.push("<pre>" + esc(t.table) + "</pre>"); });
    parts.push("↓ 去程（中國→節點）　↑ 回程（節點→中國）" + (sts.some(function (t) { return t.large; }) ? "\n大包延遲＝" + esc(largeSizeLabel(r)) + " 的封包到測速伺服器" : ""));
    var rt = retransTable(r.speed);
    if (rt) {
      parts.push("<b>🔁 回程 TCP 重傳率（測速期間，節點→中國）</b>");
      parts.push("<pre>" + esc(rt.table) + "</pre>");
      if (rt.approx) parts.push("<i>※ 節點沒有 ss，重傳率為系統整體計數器估算</i>");
    }
  }
  if (trafficText(r)) parts.push("\n📦 " + esc(trafficText(r)));
  if (retryNote(r)) parts.push("↻ " + esc(retryNote(r)));
  if (r.errors.length) parts.push("\n❌ " + r.errors.map(esc).join("\n❌ "));
  if (r.warnings.length && opts.showWarnings !== false) parts.push("⚠️ " + r.warnings.slice(0, 4).map(esc).join("\n⚠️ "));
  var endAt = (r && r.finishedAt) || job.finishedAt;
  var took = endAt && job.startedAt ? Math.max(0, Math.round((Date.parse(endAt) - Date.parse(job.startedAt)) / 1000)) : null;
  if (took !== null) parts.push("\n<i>耗時 " + took + " 秒｜" + esc(fmtTime(endAt)) + "</i>");
  return parts.join("\n");
}

// 圖片說明用的簡短摘要（Telegram caption 上限 1024 字）
function shortSummaryHTML(job, nodeName, r) {
  var parts = ["<b>🇨🇳 " + esc(typeLabel(job.type)) + "｜" + esc(nodeName) + "</b>"];
  var meta = familyLabel(job.family) + "｜" + ispsLabel(job.isps);
  if (job.type !== "ping") meta += "｜" + esc(pointsLabel(job.points)) + "｜" + modeLabel(job.mode);
  parts.push(meta);
  if (!r) { parts.push("⚠️ 沒有收到節點回傳結果"); return parts.join("\n"); }
  if (r.latency && r.latency.length) latencyTables(r.latency).forEach(function (t) { parts.push("📶 " + esc(t.summary)); });
  if (r.latencyLarge && r.latencyLarge.length) latencyTables(r.latencyLarge, "大包").forEach(function (t) { parts.push("🧱 " + esc(t.summary)); });
  ["4", "6"].forEach(function (fam) {
    var rows = (r.speed || []).filter(function (s) { return s.family === fam; });
    if (!rows.length) return;
    var up = rows.map(function (s) { return s.singleUp !== null && s.singleUp > 0.001 ? s.singleUp : s.multiUp; }).filter(function (v) { return v !== null && v > 0.001; });
    var dn = rows.map(function (s) { return s.singleDown !== null && s.singleDown > 0.001 ? s.singleDown : s.multiDown; }).filter(function (v) { return v !== null && v > 0.001; });
    var rt = rows.map(function (s) { return s.upRetrans; }).filter(function (v) { return v !== null && v !== undefined; });
    var avg = function (a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; };
    var line = "🚀 IPv" + fam + "：";
    line += up.length ? "回程↑ 平均 " + fmtMbps(avg(up)) + " Mbps" : "回程↑ 失敗";
    line += dn.length ? "，去程↓ 平均 " + fmtMbps(avg(dn)) + " Mbps" : "";
    if (rt.length) line += "，回程重傳 平均 " + fmtPct(avg(rt)) + "（最高 " + fmtPct(Math.max.apply(null, rt)) + "）";
    parts.push(esc(line));
  });
  if (trafficText(r)) parts.push("📦 " + esc(trafficText(r)));
  if (retryNote(r)) parts.push("↻ " + esc(retryNote(r).slice(0, 200)));
  if (r.errors && r.errors.length) parts.push("❌ " + esc(r.errors.join("；").slice(0, 300)));
  return parts.join("\n");
}

function fmtBytes(n) {
  if (n === null || n === undefined || !isFinite(n)) return "-";
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + " GB";
  if (n >= 1048576) return (n / 1048576).toFixed(n >= 104857600 ? 0 : 1) + " MB";
  return Math.max(0, Math.round(n / 1024)) + " KB";
}

// 消耗流量（節點網卡在測試期間的收發量）
function trafficText(r) {
  var t = r && r.traffic && r.traffic.total;
  if (!t) return "";
  var s = "消耗流量：共 " + fmtBytes(t.rx + t.tx) + "（下載 " + fmtBytes(t.rx) + "／上傳 " + fmtBytes(t.tx) + "）";
  var parts = [];
  if (r.traffic.speed) parts.push("測速 " + fmtBytes(r.traffic.speed.rx + r.traffic.speed.tx));
  if (r.traffic.latency) parts.push("延遲 " + fmtBytes(r.traffic.latency.rx + r.traffic.latency.tx));
  if (parts.length > 1) s += "，其中 " + parts.join("、");
  return s;
}

function fmtTime(iso) {
  if (!iso) return "-";
  var d = new Date(Date.parse(iso) + 8 * 3600e3); // 以 UTC+8 顯示
  var p = function (n) { return n < 10 ? "0" + n : String(n); };
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) + " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + " (UTC+8)";
}

// 安全截斷 Telegram HTML：不切斷標籤、HTML 實體與 emoji，並補齊未關閉的標籤
function truncateHTML(html, limit) {
  html = String(html || "");
  if (html.length <= limit) return html;
  var out = "";
  var stack = [];
  var closeLen = 0;
  var i = 0;
  while (i < html.length) {
    var ch = html.charAt(i);
    if (ch === "<") {
      var gt = html.indexOf(">", i);
      if (gt < 0) break;
      var tok = html.slice(i, gt + 1);
      var m = tok.match(/^<(\/?)([a-zA-Z0-9]+)/);
      var nextStack = stack.slice();
      var nextCloseLen = closeLen;
      if (m) {
        var tag = m[2].toLowerCase();
        if (m[1]) {
          var idx = nextStack.lastIndexOf(tag);
          if (idx >= 0) { nextStack.splice(idx, 1); nextCloseLen -= tag.length + 3; }
        } else if (!/\/>$/.test(tok)) {
          nextStack.push(tag);
          nextCloseLen += tag.length + 3;
        }
      }
      if (out.length + tok.length + 1 + nextCloseLen > limit) break;
      out += tok;
      stack = nextStack;
      closeLen = nextCloseLen;
      i = gt + 1;
      continue;
    }
    var unit = ch;
    if (ch === "&") {
      var ent = html.slice(i, i + 12).match(/^&[a-zA-Z0-9#]+;/);
      if (ent) unit = ent[0];
    } else {
      var code = html.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < html.length) {
        var lo = html.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) unit = html.slice(i, i + 2);
      }
    }
    if (out.length + unit.length + 1 + closeLen > limit) break;
    out += unit;
    i += unit.length;
  }
  out += "…";
  for (var k = stack.length - 1; k >= 0; k--) out += "</" + stack[k] + ">";
  return out;
}

// 依 Telegram 4096 字元限制切段，盡量在 <pre> 區塊之間切開
function splitMessage(html, limit) {
  limit = limit || 3900;
  if (html.length <= limit) return [html];
  var blocks = html.split(/\n(?=<pre>|<b>|• |❌|⚠️|<i>)/);
  var out = [];
  var cur = "";
  blocks.forEach(function (b) {
    if ((cur + "\n" + b).length > limit && cur) { out.push(cur); cur = b; }
    else cur = cur ? cur + "\n" + b : b;
  });
  if (cur) out.push(cur);
  return out.map(function (s) { return s.length > 4096 ? truncateHTML(s, 4096) : s; });
}

module.exports = {
  esc: esc, tIsp: tIsp, tProv: tProv, fmtMs: fmtMs, fmtMbps: fmtMbps, fmtTime: fmtTime,
  typeLabel: typeLabel, largeSizeLabel: largeSizeLabel, fmtBytes: fmtBytes, trafficText: trafficText, ispsLabel: ispsLabel, retryNote: retryNote, familyLabel: familyLabel, modeLabel: modeLabel, pointsLabel: pointsLabel,
  latencyTables: latencyTables, speedTable: speedTable, retransTable: retransTable, fmtPct: fmtPct, shortSummaryHTML: shortSummaryHTML, nodeResultHTML: nodeResultHTML, truncateHTML: truncateHTML, splitMessage: splitMessage
};
