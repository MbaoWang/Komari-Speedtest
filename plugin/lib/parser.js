// plugin/lib/parser.js
// 解析節點端腳本輸出（@@ 開頭的標記行 + 泰爾測速 JSON）。

"use strict";

function stripAnsi(s) {
  return String(s || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "\n");
}

function num(v) {
  if (v === undefined || v === null || v === "") return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

function parseMs(s) {
  if (s === undefined || s === null) return null;
  var m = String(s).match(/([\d.]+)\s*ms/i);
  return m ? Number(m[1]) : null;
}

function maskIp(ip) {
  ip = String(ip || "");
  if (!ip) return "";
  if (ip.indexOf(":") >= 0) {
    var p = ip.split(":");
    return p.slice(0, 2).join(":") + ":****";
  }
  var q = ip.split(".");
  if (q.length !== 4) return ip;
  return q[0] + "." + q[1] + ".*.*";
}

// 從混合輸出中取出泰爾測速的 JSON 陣列
function extractJsonArray(text) {
  var start = text.indexOf("\n[");
  if (start < 0 && text.charAt(0) === "[") start = 0; else if (start >= 0) start += 1;
  if (start < 0) return null;
  var end = text.lastIndexOf("]");
  if (end <= start) return null;
  try {
    var arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch (e) {
    return null;
  }
}

function familyOf(s) {
  return /6/.test(String(s || "")) ? "6" : "4";
}

function parseSpeedRows(arr) {
  return arr.map(function (r) {
    var region = String(r.region || "");
    var isp = "";
    var m = region.match(/(电信|联通|移动)$/);
    if (m) isp = m[1];
    return {
      region: region,
      prov: isp ? region.slice(0, region.length - isp.length) : region,
      isp: isp,
      family: familyOf(r.family),
      rtt: parseMs(r.rtt),
      singleDown: num(r.single_down_f),
      singleUp: num(r.single_up_f),
      multiDown: num(r.multi_down_f),
      multiUp: num(r.multi_up_f)
    };
  });
}

function pct(n, d, minDen) {
  if (d === null || d === undefined || n === null || n === undefined || d < (minDen || 1)) return null;
  return Math.round(n / d * 10000) / 100;
}

// 把 @@RTX（ss / TCP_INFO）或 @@RTXS（/proc/net/snmp 系統整體）套用到該測速點的結果列
function applyRetrans(rows, block) {
  rows.forEach(function (r) {
    var x = block.rtx[r.family];
    if (x) {
      r.upRetrans = pct(x.rt, x.dso, 200);
      r.upSegs = x.dso;
      r.retransSegs = x.rt;
      r.rtxSource = "tcp_info";
    } else if (block.snmp) {
      r.upRetrans = pct(block.snmp.r, block.snmp.o, 200);
      r.rtxSource = "snmp";
    } else {
      r.upRetrans = null;
      r.rtxSource = null;
    }
  });
  return rows;
}

// 回傳：{ ok, os, arch, ip4, ip6, exit, latency:[], speed:[], errors:[], warnings:[] }
function parseOutput(raw, exitCode) {
  var text = stripAnsi(raw);
  var res = { ok: false, os: "", arch: "", ip4: "", ip6: "", exit: "", latency: [], speed: [], errors: [], warnings: [], speedRc: null, retries: [] };
  var lines = text.split("\n");
  var cur = null;
  var blocks = [];
  var last = null;
  var sawBegin = false;
  var sawEnd = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var t = line.trim();
    if (cur) {
      if (t.indexOf("@@SPEED_END") === 0) {
        cur.rc = Number(t.split("|")[1]);
        blocks.push(cur);
        last = cur;
        cur = null;
        continue;
      }
      cur.lines.push(line);
      var exitMatch = t.match(/出口\s+(\S+)\s*(.*)$/);
      if (exitMatch) res.exit = exitMatch[2].trim();
      continue;
    }
    if (t.indexOf("@@") !== 0) continue;
    var p = t.split("|");
    switch (p[0]) {
      case "@@BEGIN": sawBegin = true; res.os = p[2] || ""; res.arch = p[3] || ""; break;
      case "@@END": sawEnd = true; break;
      case "@@IP":
        if (p[1] === "4") res.ip4 = p[2] || "";
        else res.ip6 = p[2] || "";
        break;
      case "@@ERR": res.errors.push(p.slice(2).join("|") || p[1]); break;
      case "@@WARN": res.warnings.push(p.slice(2).join("|") || p[1]); break;
      case "@@SPERR": if (last && p.slice(1).join("|").trim()) last.err.push(p.slice(1).join("|").trim()); break;
      case "@@SPEED_BEGIN": cur = { point: p[1] || "", lines: [], rc: null, rtx: {}, snmp: null, err: [] }; break;
      case "@@RTX":
        if (last) last.rtx[p[1] === "6" ? "6" : "4"] = { dso: num(p[2]) || 0, rt: num(p[3]) || 0, dsi: num(p[4]) || 0, oo: num(p[5]) || 0, conns: num(p[6]) || 0 };
        break;
      case "@@RETRY": {
        var tries = num(p[2]) || 0;
        var left = num(p[3]);
        if (last) last.retries = tries;
        res.retries.push({ point: p[1] || "", retries: tries, stillFailed: left !== null && left > 0 });
        break;
      }
      case "@@RTXS": {
        var o0 = num(p[1]), r0 = num(p[2]), o1 = num(p[3]), r1 = num(p[4]);
        if (last && o0 !== null && o1 !== null && r0 !== null && r1 !== null && o1 > o0) last.snmp = { o: o1 - o0, r: Math.max(0, r1 - r0) };
        break;
      }
      case "@@LAT": {
        var sent = num(p[5]) || 0;
        var recv = num(p[6]) || 0;
        var rtx = num(p[11]) || 0;
        res.latency.push({
          family: p[1] === "6" ? "6" : "4",
          prov: p[2] || "-",
          isp: p[3] || "-",
          host: p[4] || "",
          sent: sent,
          recv: recv,
          synRetrans: rtx,
          fail: Math.max(0, sent - recv - rtx),
          loss: sent > 0 ? Math.round((1 - recv / sent) * 1000) / 10 : 100,
          min: num(p[7]),
          avg: num(p[8]),
          max: num(p[9]),
          jitter: num(p[10])
        });
        break;
      }
    }
  }
  if (cur) blocks.push(cur); // 被中止、沒有 SPEED_END
  var anyRows = false;
  blocks.forEach(function (b) {
    var arr = extractJsonArray(b.lines.join("\n"));
    if (arr && arr.length) {
      anyRows = true;
      res.speed = res.speed.concat(applyRetrans(parseSpeedRows(arr), b).map(function (r) { r.retries = b.retries || 0; return r; }));
    } else {
      res.warnings.push("泰爾測速 " + (b.point || "") + " 沒有結果（exit " + b.rc + "）" + (b.err.length ? "：" + b.err.join(" / ") : ""));
    }
  });
  if (blocks.length && !anyRows) res.errors.push("泰爾測速全部失敗");
  if (!sawBegin) {
    var tail = text.trim().slice(-300);
    if (/Remote control is disabled/i.test(text)) res.errors.push("此節點 Agent 已停用遠端執行（--disable-web-ssh），無法測速");
    else res.errors.push("節點未執行測試腳本" + (tail ? "：" + tail : "") + (exitCode !== undefined ? "（exit " + exitCode + "）" : ""));
  } else if (!sawEnd && res.errors.length === 0) {
    res.warnings.push("腳本未正常結束（可能逾時被中止）");
  }
  res.latency.sort(function (a, b) {
    if (a.family !== b.family) return a.family < b.family ? -1 : 1;
    if (a.prov !== b.prov) return a.prov < b.prov ? -1 : 1;
    return ispOrder(a.isp) - ispOrder(b.isp);
  });
  res.speed.sort(function (a, b) { return a.family < b.family ? -1 : a.family > b.family ? 1 : 0; });
  res.ok = res.latency.length > 0 || res.speed.length > 0;
  return res;
}

function ispOrder(isp) {
  var s = String(isp || "");
  if (/电信|電信|ct|telecom/i.test(s)) return 0;
  if (/联通|聯通|cu|unicom/i.test(s)) return 1;
  if (/移动|移動|cm|mobile/i.test(s)) return 2;
  return 3;
}

module.exports = { parseOutput: parseOutput, stripAnsi: stripAnsi, maskIp: maskIp, ispOrder: ispOrder, extractJsonArray: extractJsonArray };
