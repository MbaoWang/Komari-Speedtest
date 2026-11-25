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

// 省份依地理順序排列（華北 → 東北 → 華東 → 華中 → 華南 → 西南 → 西北），與 TcpQuality / Zstatic 清單一致
var PROV_ORDER = ["北京", "天津", "河北", "山西", "内蒙古", "辽宁", "吉林", "黑龙江", "上海", "江苏", "浙江", "安徽", "福建", "江西", "山东",
  "河南", "湖北", "湖南", "广东", "广西", "海南", "重庆", "四川", "贵州", "云南", "西藏", "陕西", "甘肃", "青海", "宁夏", "新疆", "香港", "澳门", "台湾"];
function provOrder(p) { var i = PROV_ORDER.indexOf(p); return i < 0 ? 99 : i; }

function latRow(p) {
  var sent = num(p[5]) || 0;
  var recv = num(p[6]) || 0;
  return {
    family: p[1] === "6" ? "6" : "4", prov: p[2] || "-", isp: p[3] || "-", host: p[4] || "",
    sent: sent, recv: recv, synRetrans: 0, fail: Math.max(0, sent - recv),
    loss: sent > 0 ? Math.round((1 - recv / sent) * 1000) / 10 : 100,
    min: num(p[7]), avg: num(p[8]), max: num(p[9]), jitter: num(p[10])
  };
}

// 回傳：{ ok, os, arch, ip4, ip6, exit, latency:[], speed:[], errors:[], warnings:[] }
function parseOutput(raw, exitCode) {
  var text = stripAnsi(raw);
  var res = { ok: false, os: "", arch: "", ip4: "", ip6: "", exit: "", latency: [], speed: [], errors: [], warnings: [], speedRc: null, retries: [], latencyLarge: [], srvLarge: [], largeSize: null, shared: [], nodeLists: [], traffic: { total: null, latency: null, speed: null, points: [] } };
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
      case "@@SPEED_BEGIN": cur = { point: p[1] || "", mode: p[2] || "", lines: [], rc: null, rtx: {}, snmp: null, err: [] }; break;
      case "@@RTX":
        if (last) last.rtx[p[1] === "6" ? "6" : "4"] = { dso: num(p[2]) || 0, rt: num(p[3]) || 0, dsi: num(p[4]) || 0, oo: num(p[5]) || 0, conns: num(p[6]) || 0 };
        break;
      case "@@RETRY": {
        var tries = num(p[2]) || 0;
        var left = num(p[3]);
        if (last) last.retries = tries;
        res.retries.push({ point: p[1] || "", retries: tries, stillFailed: left !== null && left > 0, mode: p[4] || "" });
        break;
      }
      case "@@TRAFFIC": {
        // @@TRAFFIC|種類|rx0|tx0|rx1|tx1[|測速點|模式]
        var rx = num(p[4]) - num(p[2]), tx = num(p[5]) - num(p[3]);
        if (!isFinite(rx) || !isFinite(tx) || rx < 0 || tx < 0) break;
        var tr = { rx: rx, tx: tx };
        if (p[1] === "total") res.traffic.total = tr;
        else if (p[1] === "latency") res.traffic.latency = tr;
        else if (p[1] === "point") {
          tr.point = p[6] || ""; tr.mode = p[7] || "";
          res.traffic.points.push(tr);
          var sp = res.traffic.speed || { rx: 0, tx: 0 };
          sp.rx += rx; sp.tx += tx; res.traffic.speed = sp;
        }
        break;
      }
      case "@@RTXS": {
        var o0 = num(p[1]), r0 = num(p[2]), o1 = num(p[3]), r1 = num(p[4]);
        if (last && o0 !== null && o1 !== null && r0 !== null && r1 !== null && o1 > o0) last.snmp = { o: o1 - o0, r: Math.max(0, r1 - r0) };
        break;
      }
      case "@@GN": res.nodeLists.push({ scope: p[1] || "", count: num(p[2]) || 0, http: p[3] || "" }); break;
      case "@@SHARE": res.shared.push({ family: p[1] === "6" ? "6" : "4", prov: p[2] || "", isp: p[3] || "", sameProv: p[4] || "", sameIsp: p[5] || "" }); break;
      case "@@LSIZE": res.largeSize = { v4: num(p[1]), v6: num(p[2]), wanted: num(p[3]) }; break;
      case "@@LATL": {
        var lr = latRow(p);
        if (p[11] === "E") lr.error = true;
        res.latencyLarge.push(lr);
        break;
      }
      case "@@SRVL": {
        var srv = latRow(p);
        if (p[11] !== "E") res.srvLarge.push({ point: p[2] || "", family: srv.family, sent: srv.sent, recv: srv.recv, loss: srv.loss, avg: srv.avg, min: srv.min, max: srv.max });
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
  var merged = {};
  var order = [];
  blocks.forEach(function (b) {
    var arr = extractJsonArray(b.lines.join("\n"));
    if (!arr || !arr.length) {
      res.warnings.push("泰爾測速 " + (b.point || "") + (b.mode ? "（" + (b.mode === "multi" ? "多線程" : "單線程") + "）" : "") + " 沒有結果（exit " + b.rc + "）" + (b.err.length ? "：" + b.err.join(" / ") : ""));
      return;
    }
    anyRows = true;
    applyRetrans(parseSpeedRows(arr), b).forEach(function (r) {
      r.retries = b.retries || 0;
      // 單線程 / 多線程分開執行時，只取該模式的欄位
      if (b.mode === "single") { r.multiDown = null; r.multiUp = null; }
      if (b.mode === "multi") { r.singleDown = null; r.singleUp = null; }
      var key = r.region + "|" + r.family;
      var e = merged[key];
      if (!e) { merged[key] = r; order.push(key); r.rtxMode = b.mode; return; }
      if (b.mode === "single") { e.singleDown = r.singleDown; e.singleUp = r.singleUp; }
      else if (b.mode === "multi") { e.multiDown = r.multiDown; e.multiUp = r.multiUp; }
      if (e.rtt === null || e.rtt === undefined) e.rtt = r.rtt;
      // 回程重傳率以單線程那次為準（與 TcpQuality 相同）
      if (r.rtxSource && (b.mode === "single" || !e.rtxSource)) {
        e.upRetrans = r.upRetrans; e.rtxSource = r.rtxSource; e.upSegs = r.upSegs; e.retransSegs = r.retransSegs; e.rtxMode = b.mode;
      }
      e.retries = Math.max(e.retries || 0, r.retries);
    });
  });
  order.forEach(function (k) { res.speed.push(merged[k]); });
  // 每個測速點的流量（單 / 多線程與重測加總）
  res.traffic.points.forEach(function (t) {
    res.speed.forEach(function (r) {
      if (r.region !== t.point) return;
      r.trafficRx = (r.trafficRx || 0) + t.rx; r.trafficTx = (r.trafficTx || 0) + t.tx;
    });
  });
  if (blocks.length && !anyRows) res.errors.push("泰爾測速全部失敗");
  if (!sawBegin) {
    var tail = text.trim().slice(-300);
    if (/Remote control is disabled/i.test(text)) res.errors.push("此節點 Agent 已停用遠端執行（--disable-web-ssh），無法測速");
    else res.errors.push("節點未執行測試腳本" + (tail ? "：" + tail : "") + (exitCode !== undefined ? "（exit " + exitCode + "）" : ""));
  } else if (!sawEnd && res.errors.length === 0) {
    res.warnings.push("腳本未正常結束（可能逾時被中止）");
  }
  var latSort = function (a, b) {
    if (a.family !== b.family) return a.family < b.family ? -1 : 1;
    if (a.prov !== b.prov) { var pa = provOrder(a.prov), pb = provOrder(b.prov); return pa !== pb ? pa - pb : (a.prov < b.prov ? -1 : 1); }
    return ispOrder(a.isp) - ispOrder(b.isp);
  };
  res.latency.sort(latSort);

  // 大包：nping 發不出去（例如 IPv6 需要指定網卡）的目標不列入
  var lErr = res.latencyLarge.filter(function (r) { return r.error; });
  res.latencyLarge = res.latencyLarge.filter(function (r) { return !r.error; }).sort(latSort);
  if (lErr.length) res.warnings.push("大包測試有 " + lErr.length + " 個目標無法發送（nping 錯誤），已略過");
  // 共用節點標記（不同省份同一個 IP）
  res.shared.forEach(function (x) {
    res.latency.concat(res.latencyLarge).forEach(function (r) {
      if (r.family === x.family && r.prov === x.prov && r.isp === x.isp) r.sameAs = x.sameProv + x.sameIsp;
    });
  });
  // 測速伺服器的大包延遲 / 丟包 → 套到測速結果
  res.srvLarge.forEach(function (x) {
    res.speed.forEach(function (r) {
      if (r.region === x.point && r.family === x.family) { r.rttLarge = x.avg; r.lossLarge = x.loss; r.largeSent = x.sent; }
    });
  });
  res.speed.sort(function (a, b) { return a.family < b.family ? -1 : a.family > b.family ? 1 : 0; });
  res.ok = res.latency.length > 0 || res.speed.length > 0 || res.latencyLarge.length > 0;
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
