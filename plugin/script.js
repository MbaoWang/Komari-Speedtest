// plugin/script.js
// Komari 插件：中國網路測速（cn-speedtest）
//   - 透過 Komari Agent 在節點上執行三網 TCP 延遲（TcpQuality 節點）與泰爾測速（taierspeedtest-mod）
//   - IPv4 / IPv6 / 雙棧
//   - Komari 後台頁面直接操作
//   - Telegram 機器人：互動式選單 + 文字指令 / 關鍵字

"use strict";

var server = require("server");
var jobsLib = require("./lib/jobs.js");
var botLib = require("./lib/telegram.js");
var remote = require("./lib/remote.js");
var imagingLib = require("./lib/imaging.js");

var SHORT = "cn-speedtest";
var BASE = "/api/plugin/" + SHORT;

var config = null;
var mgr = null;
var bot = null;
var startTimer = null;
var imaging = null;
var pending = {}; // jobId -> [Promise]：節點結果（含圖片）傳送中
var delivered = {}; // jobId -> { uuid: true }：避免重複傳送且不寫入 state.json

function errText(e) { return e && e.message ? e.message : String(e); }

function bool(v, def) {
  if (v === undefined || v === null || v === "") return def;
  return v === true || v === "true" || v === 1 || v === "1";
}

function idList(v) {
  return String(v || "").split(/[\s,，;；]+/).map(function (x) { return x.trim(); }).filter(function (x) { return /^-?\d{3,20}$/.test(x); });
}

function nodeList(v) {
  if (Array.isArray(v)) return v.filter(function (x) { return typeof x === "string" && x; });
  if (typeof v === "string" && v.trim()) {
    try { var a = JSON.parse(v); if (Array.isArray(a)) return a.filter(Boolean); } catch (e) { /* ignore */ }
  }
  return [];
}

// 定時設定（選單）→ 一或多條 cron。Komari 排程用伺服器本地時區，
// 這裡以「北京 / 台北時間（UTC+8）」計算要跑的時間點，再換算成伺服器時間。
var SCHEDULE = {
  "每小時": 1, "每1小時": 1, "每3小時": 3, "每6小時": 6, "每12小時": 12,
  "每小时": 1, "每3小时": 3, "每6小时": 6, "每12小时": 12
};
var WEEKDAYS = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
function pad2(n) { return (n < 10 ? "0" : "") + n; }

// slots：[{ h: 北京小時, m: [分鐘...] }] → 依伺服器時區換算、把分鐘相同的時段合併成 cron
function slotsToCron(slots, dow) {
  var S = -new Date().getTimezoneOffset();
  var byMin = {};
  slots.forEach(function (sl) {
    sl.m.forEach(function (m) {
      var t = sl.h * 60 + m - 480 + S;
      var shift = Math.floor(t / 1440);
      t = ((t % 1440) + 1440) % 1440;
      var key = String(t % 60) + (dow !== undefined ? "@" + ((((dow + shift) % 7) + 7) % 7) : "");
      (byMin[key] = byMin[key] || []).push(Math.floor(t / 60));
    });
  });
  var groups = {};
  Object.keys(byMin).forEach(function (k) {
    var hours = byMin[k].filter(function (h, i, a) { return a.indexOf(h) === i; }).sort(function (a, b) { return a - b; }).join(",");
    var parts = k.split("@");
    var gk = hours + "@" + (parts[1] !== undefined ? parts[1] : "*");
    (groups[gk] = groups[gk] || []).push(Number(parts[0]));
  });
  return Object.keys(groups).map(function (gk) {
    var p = gk.split("@");
    return groups[gk].sort(function (a, b) { return a - b; }).join(",") + " " + p[0] + " * * " + p[1];
  });
}

function scheduleToCron(c) {
  var mode = String(c.schedule || "").trim();
  var custom = String(c.cron_spec || "").trim();
  var customList = custom.split(/[;；\n]+/).map(function (x) { return x.trim(); }).filter(Boolean);
  // 舊設定：只有填 Cron 表達式
  if (!mode) return customList.length ? { specs: customList, text: "自訂 " + customList.join("；") } : { specs: [], text: "" };
  if (mode === "自訂" || mode === "自定义") return customList.length ? { specs: customList, text: "自訂 " + customList.join("；") } : { specs: [], text: "" };

  // 晚高峰加密
  var peak = bool(c.peak_enabled, false);
  var ps = remote.clampInt(c.peak_start, 0, 23, 20);
  var pe = remote.clampInt(c.peak_end, 1, 24, 24);
  var pStep = /15/.test(String(c.peak_interval || "")) ? 15 : 30;
  var inPeak = function (h) { return peak && (ps === pe ? false : ps < pe ? h >= ps && h < pe : h >= ps || h < pe); };
  var peakSlots = [];
  if (peak) for (var h = 0; h < 24; h++) if (inPeak(h)) { var ms = []; for (var m = 0; m < 60; m += pStep) ms.push(m); peakSlots.push({ h: h, m: ms }); }
  var peakActive = peak && peakSlots.length > 0;
  var peakText = peakActive ? "晚高峰 " + pad2(ps) + ":00–" + pad2(pe % 24) + ":00 每" + pStep + "分鐘" : "";

  var hour = remote.clampInt(c.schedule_hour, 0, 23, 4);
  var specs = [], text = "";
  if (SCHEDULE[mode]) {
    var n = SCHEDULE[mode], base = [];
    for (var b = 0; b < 24; b += n) if (!inPeak(b)) base.push({ h: b, m: [0] });
    specs = slotsToCron(base);
    text = mode;
  } else if (mode === "每天") {
    specs = inPeak(hour) ? [] : slotsToCron([{ h: hour, m: [0] }]);
    text = "每天 " + pad2(hour) + ":00";
  } else if (mode === "每週" || mode === "每周") {
    var wd = WEEKDAYS.indexOf(String(c.schedule_weekday || "週一").replace("周", "週"));
    if (wd < 0) wd = 1;
    specs = inPeak(hour) ? [] : slotsToCron([{ h: hour, m: [0] }], wd);
    text = "每" + WEEKDAYS[wd] + " " + pad2(hour) + ":00";
  }
  if (peakActive) specs = specs.concat(slotsToCron(peakSlots));
  if (!specs.length) return { specs: [], text: "" };
  return { specs: specs, text: (peakActive ? peakText + (text ? "，其餘時間 " + text : "") : text) + "（UTC+8）" };
}

// 定時測試項目：選單顯示中文，相容舊的 ping / speed / full
function cronTypeOf(v) {
  var t = String(v || "").trim();
  if (t === "speed" || /泰爾測速|泰尔测速/.test(t)) return "speed";
  if (t === "full" || /完整/.test(t)) return "full";
  return "ping";
}

function normalizeConfig(raw) {
  var c = raw || {};
  var pts = "";
  try { pts = remote.normPoints(c.default_points); } catch (e) { console.warn("[cn-speedtest] 預設測速點格式錯誤，改用北上廣"); }
  var sched = scheduleToCron(c);
  return {
    tgEnabled: bool(c.tg_enabled, false),
    tgToken: String(c.tg_token || "").trim(),
    tgApiBase: String(c.tg_api_base || "https://api.telegram.org").trim() || "https://api.telegram.org",
    tgAllowedIds: idList(c.tg_allowed_ids),
    tgNotifyIds: idList(c.tg_notify_ids),
    tgNotifyWeb: bool(c.tg_notify_web, false),
    tgShowHidden: bool(c.tg_show_hidden, false),
    tgShowFullIp: bool(c.tg_show_full_ip, false),
    publicEnabled: bool(c.public_enabled, false),
    publicTitle: String(c.public_title || "").trim().slice(0, 60),
    lang: c.language === "zh_TW" || c.language === "zh_CN" ? c.language : "auto",
    tgResultFormat: c.tg_result_format === "text" || c.tg_result_format === "both" ? c.tg_result_format : "image",
    imageEnabled: bool(c.image_enabled, true),
    imageUpload: c.image_upload === "catbox" || c.image_upload === "0x0" ? c.image_upload : "none",
    imageShowFullIp: bool(c.tg_show_full_ip, false),
    defaultFamily: remote.normFamily(c.default_family || "both"),
    defaultMode: remote.normMode(c.default_mode || "single"),
    defaultPoints: pts,
    defaultIsps: remote.normIsps(c.default_isps),
    speedRetries: remote.clampInt(c.speed_retries, 0, 3, 1),
    largeEnabled: bool(c.large_enabled, true),
    npingInstall: bool(c.nping_install, true),
    largeSize: remote.clampInt(c.large_size, 200, 1500, 1400),
    historyKeep: remote.clampInt(c.history_keep, 10, 200, 40),
    duration: remote.clampInt(c.duration, 5, 13, 5),
    pingCount: remote.clampInt(c.ping_count, 3, 50, 20),
    pingParallel: remote.clampInt(c.ping_parallel, 1, 64, 16),
    provinceFilter: String(c.province_filter || "").trim(),
    getNodesUrl: String(c.getnodes_url || "").trim(),
    taierUrl: String(c.taier_url || "").trim(),
    customTargets: String(c.custom_targets || ""),
    maxConcurrentJobs: remote.clampInt(c.max_jobs, 1, 20, 3),
    cronSpecs: sched.specs,
    cronSpec: sched.specs.join("；"),
    cronText: sched.text,
    cronType: cronTypeOf(c.cron_type),
    cronNodes: nodeList(c.cron_nodes)
  };
}

function cfg() { return config || normalizeConfig({}); }

function sendJSON(res, code, payload) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function isAdmin(req) {
  var ctx = req && req.context;
  return Boolean(ctx && (ctx.role === "admin" || (ctx.principal && Array.isArray(ctx.principal.roles) && ctx.principal.roles.indexOf("admin") >= 0)));
}

function parseBody(req) {
  if (!req || !req.body) return {};
  var b = JSON.parse(req.body);
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("Expected a JSON object");
  return b;
}

function queryParam(req, name) {
  var q = req && req.query;
  if (q && q[name] !== undefined) return Array.isArray(q[name]) ? q[name][0] : q[name];
  var m = String((req && req.url) || "").match(new RegExp("[?&]" + name + "=([^&]*)"));
  if (!m) return "";
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}

// 給後台頁面用：任務摘要（不含完整結果）
function jobSummary(j) {
  var ok = 0;
  j.clients.forEach(function (u) { if (j.results[u] && j.results[u].ok) ok++; });
  return {
    id: j.id, type: j.type, family: j.family, points: j.points, mode: j.mode, isps: j.isps || [], status: j.status,
    clients: j.clients, names: j.names, done: Object.keys(j.results || {}).length, ok: ok,
    startedAt: j.startedAt, finishedAt: j.finishedAt, estimateSec: j.estimateSec, error: j.error,
    origin: j.origin ? j.origin.kind : "web", skipped: j.skipped
  };
}

function adminRoute(method, p, handler) {
  server.route(method, BASE + p, async function (req, res) {
    if (!isAdmin(req)) return sendJSON(res, 403, { status: "error", message: "需要管理員權限" });
    try {
      var data = await handler(req, res);
      sendJSON(res, 200, { status: "success", data: data === undefined ? null : data });
    } catch (e) {
      sendJSON(res, 400, { status: "error", message: errText(e) });
    }
  });
}

// ---------- 訪客公開結果頁 ----------

var siteCache = { at: 0, privateSite: false, name: "" };
async function siteSettings() {
  if (Date.now() - siteCache.at < 30000) return siteCache;
  try {
    var st = (await server.call("admin:getSettings")) || {};
    siteCache = { at: Date.now(), privateSite: st.private_site === true, name: String(st.sitename || "") };
  } catch (e) { siteCache.at = Date.now(); }
  return siteCache;
}

function isLoggedIn(req) {
  var ctx = req && req.context;
  var t = ctx && ctx.principal ? ctx.principal.type : "";
  return Boolean(isAdmin(req) || (t && t !== "anonymous" && t !== "agent"));
}

// 公開資料：只含未隱藏節點、只有最近結果；不含 IP、錯誤細節、任務紀錄
async function publicView() {
  var list = await mgr.nodes();
  var c = cfg();
  var nodes = [];
  list.forEach(function (n) {
    if (n.hidden) return;
    var l = mgr.latest(n.uuid) || {};
    var item = { uuid: n.uuid, name: n.name, region: n.region, online: n.online, ping: null, speed: null, image: false };
    if (l.ping) item.ping = { at: l.ping.at, family: l.ping.family, largeSize: l.ping.largeSize || null, latencyLarge: (l.ping.latencyLarge || []).map(pubLat), latency: l.ping.latency.map(function (r) {
      return { family: r.family, prov: r.prov, isp: r.isp, sent: r.sent, recv: r.recv, loss: r.loss, synRetrans: r.synRetrans, min: r.min, avg: r.avg, max: r.max, jitter: r.jitter, sameAs: r.sameAs };
    }) };
    if (l.speed) item.speed = { at: l.speed.at, family: l.speed.family, points: l.speed.points, mode: l.speed.mode, exit: l.speed.exit, speed: l.speed.speed.map(function (r) {
      return { family: r.family, prov: r.prov, isp: r.isp, rtt: r.rtt, singleDown: r.singleDown, singleUp: r.singleUp, multiDown: r.multiDown, multiUp: r.multiUp, upRetrans: r.upRetrans, rtxSource: r.rtxSource, rttLarge: r.rttLarge, lossLarge: r.lossLarge };
    }) };
    var hasImg = Boolean(l.image && l.image.file && !c.imageShowFullIp && (!imaging || imaging.exists(l.image.file)));
    item.image = hasImg;
    if (hasImg && l.image.at) item.imageAt = l.image.at;
    nodes.push(item);
  });
  var site = await siteSettings();
  return { title: c.publicTitle || "中國網路測速", site: site.name, nodes: nodes };
}

function pubLat(r) {
  return { family: r.family, prov: r.prov, isp: r.isp, sent: r.sent, recv: r.recv, loss: r.loss, min: r.min, avg: r.avg, max: r.max, sameAs: r.sameAs };
}

function publicRoute(p, handler) {
  server.route("GET", BASE + p, async function (req, res) {
    if (!cfg().publicEnabled) return sendJSON(res, 404, { status: "error", message: "公開結果頁未開啟" });
    var site = await siteSettings();
    if (site.privateSite && !isLoggedIn(req)) return sendJSON(res, 401, { status: "error", message: "此站點為私有站點，請先登入" });
    try { await handler(req, res); }
    catch (e) { sendJSON(res, 500, { status: "error", message: "讀取失敗" }); }
  });
}

function registerPublicRoutes() {
  publicRoute("/public/data", async function (req, res) {
    sendJSON(res, 200, { status: "success", data: await publicView() });
  });
  publicRoute("/public/image", async function (req, res) {
    var uuid = String(queryParam(req, "uuid"));
    var node = (await mgr.nodes()).filter(function (n) { return n.uuid === uuid && !n.hidden; })[0];
    var l = node ? mgr.latest(uuid) : null;
    var data = l && l.image && l.image.file && !cfg().imageShowFullIp && imaging ? imaging.read(l.image.file) : null;
    if (!data) return sendJSON(res, 404, { status: "error", message: "找不到圖片" });
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.write(new Uint8Array(data));
    res.end();
  });
}

function registerRoutes() {
  registerPublicRoutes();
  adminRoute("GET", "/overview", async function () {
    var list = await mgr.nodes(true);
    var c = cfg();
    return {
      nodes: list.map(function (n) {
        var l = mgr.latest(n.uuid) || {};
        return { uuid: n.uuid, name: n.name, region: n.region, os: n.os, arch: n.arch, online: n.online, hidden: n.hidden, group: n.group,
          lastPing: l.ping ? l.ping.at : null, lastSpeed: l.speed ? l.speed.at : null };
      }),
      jobs: mgr.jobs().map(jobSummary),
      historyKeep: c.historyKeep,
      lastSettings: mgr.getWebPrefs(),
      provinces: remote.PROVINCES,
      defaults: { family: c.defaultFamily, mode: c.defaultMode, points: c.defaultPoints, isps: c.defaultIsps, duration: c.duration, retries: c.speedRetries, showFullIp: c.tgShowFullIp },
      schedule: c.cronSpec ? c.cronText + "｜" + ({ ping: "延遲", speed: "測速", full: "完整" }[c.cronType] || c.cronType) : "",
      publicPage: { enabled: c.publicEnabled, url: "/api/plugin/" + SHORT + "/public/" },
      telegram: { enabled: c.tgEnabled, configured: Boolean(c.tgToken), running: Boolean(bot && bot.isRunning()), allowed: c.tgAllowedIds.length }
    };
  });

  adminRoute("POST", "/run", async function (req) {
    var b = parseBody(req);
    if (!Array.isArray(b.clients) || !b.clients.length) throw new Error("請選擇至少一個節點");
    var job = await mgr.run({ clients: b.clients, type: b.type, family: b.family, points: b.points, mode: b.mode, isps: b.isps, lang: b.lang, origin: { kind: "web" } });
    // 記住這次的設定，下次打開頁面沿用
    mgr.setWebPrefs({ clients: b.clients.filter(function (u) { return typeof u === "string"; }).slice(0, 200), type: job.type, family: job.family, points: job.points, mode: job.mode, isps: job.isps });
    return jobSummary(job);
  });

  adminRoute("POST", "/jobs/delete", async function (req) {
    var b = parseBody(req);
    return { deleted: mgr.deleteJob(String(b.id || "")) };
  });

  adminRoute("POST", "/jobs/clear", async function () {
    return { removed: mgr.clearFinished() };
  });

  adminRoute("POST", "/cancel", async function (req) {
    var b = parseBody(req);
    return { cancelled: mgr.cancel(String(b.id || "")) };
  });

  adminRoute("GET", "/job", async function (req) {
    var j = mgr.getJob(String(queryParam(req, "id")));
    if (!j) throw new Error("找不到任務");
    var s = jobSummary(j);
    s.results = j.results;
    return s;
  });

  adminRoute("GET", "/latest", async function (req) {
    var uuid = String(queryParam(req, "uuid"));
    return { uuid: uuid, name: mgr.nodeName(uuid), latest: mgr.latest(uuid) };
  });

  // 結果圖（PNG）
  server.route("GET", BASE + "/image", async function (req, res) {
    if (!isAdmin(req)) return sendJSON(res, 403, { status: "error", message: "需要管理員權限" });
    var data = imaging ? imaging.read(String(queryParam(req, "file"))) : null;
    if (!data) return sendJSON(res, 404, { status: "error", message: "找不到圖片" });
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.write(new Uint8Array(data));
    res.end();
  });

  adminRoute("POST", "/telegram/test", async function () {
    if (!bot) throw new Error("Telegram 機器人未啟用（請在插件設定開啟並填入 Bot Token）");
    return await bot.sendTest();
  });

  // 預覽要在節點執行的指令（方便除錯 / 審查）
  adminRoute("POST", "/preview", async function (req) {
    var b = parseBody(req);
    var c = cfg();
    var type = b.type === "speed" || b.type === "full" ? b.type : "ping";
    return {
      command: remote.buildRemoteCommand({
        runId: "preview-0000", ping: type !== "speed", speed: type !== "ping",
        family: b.family || c.defaultFamily, points: b.points !== undefined ? b.points : c.defaultPoints, mode: b.mode || c.defaultMode,
        duration: c.duration, pingCount: c.pingCount, parallel: c.pingParallel, provinceFilter: c.provinceFilter,
        getNodesUrl: c.getNodesUrl, taierUrl: c.taierUrl, customTargets: c.customTargets,
        isps: b.isps !== undefined ? b.isps : c.defaultIsps, retries: c.speedRetries,
        large: c.largeEnabled, largeSize: c.largeSize, npingInstall: c.npingInstall
      })
    };
  });

  server.registerRPC("cnSpeedtest:run", async function (params) {
    var p = params || {};
    return jobSummary(await mgr.run({ clients: p.clients, type: p.type, family: p.family, points: p.points, mode: p.mode, isps: p.isps, origin: { kind: "web" } }));
  });
  server.registerRPC("cnSpeedtest:latest", function (params) {
    var uuid = params && params.uuid ? String(params.uuid) : "";
    return mgr.latest(uuid);
  });
}

function setupCron() {
  var c = cfg();
  if (!c.cronSpecs.length) return;
  var job = async function () {
      if (!mgr) return;
      try {
        var list = await mgr.nodes(true);
        var pool = c.cronNodes.length ? c.cronNodes : list.map(function (n) { return n.uuid; });
        var online = list.filter(function (n) { return n.online && pool.indexOf(n.uuid) >= 0 && !/windows/i.test(n.os); }).map(function (n) { return n.uuid; });
        if (!online.length) return;
        await mgr.run({ clients: online, type: c.cronType, family: c.defaultFamily, points: c.defaultPoints, mode: c.defaultMode, isps: c.defaultIsps, origin: { kind: "cron" } });
      } catch (e) { console.warn("[cn-speedtest] 定時測試失敗：" + errText(e)); }
  };
  try {
    c.cronSpecs.forEach(function (spec) { server.cron(spec, job); });
    console.info("[cn-speedtest] 已啟用定時測試：" + c.cronText + "（" + c.cronType + "，伺服器 cron：" + c.cronSpec + "）");
  } catch (e) {
    console.error("[cn-speedtest] Cron 表達式錯誤：" + errText(e));
  }
}

// 節點完成：產生結果圖 → 存檔 / 上傳 → Telegram
function deliver(job, uuid, result) {
  var map = delivered[job.id] = delivered[job.id] || {};
  if (map[uuid]) return;
  map[uuid] = true;
  // 取消的任務：沒有結果的節點不產生圖片、不傳訊息（狀態訊息會改成「已取消」）
  if (job.status === "cancelled" && (!result || !result.ok)) return;
  var p = (async function () {
    var img = null;
    if (imaging && result && (result.ok || (result.errors && result.errors.length))) {
      img = await imaging.produce(job, uuid, job.names[uuid] || mgr.nodeName(uuid), result);
      if (img && mgr) mgr.setImage(job, uuid, img);
    }
    if (bot) await bot.deliverNodeResult(job, uuid, result, img);
  })().then(null, function (e) { console.warn("[cn-speedtest] 傳送結果失敗：" + errText(e)); });
  (pending[job.id] = pending[job.id] || []).push(p);
  return p;
}

function load() {
  mgr = jobsLib.createJobManager(server, cfg);
  registerRoutes();
  startTimer = setTimeout(async function () {
    startTimer = null;
    try { config = normalizeConfig(await server.getConfig()); } catch (e) { console.warn("[cn-speedtest] 讀取設定失敗：" + errText(e)); config = normalizeConfig({}); }
    if (!mgr) return;
    mgr.start();
    setupCron();
    imaging = imagingLib.createImaging(cfg, mgr.latestImageFiles);
    mgr.on("nodeDone", function (job, uuid, result) { deliver(job, uuid, result); });
    mgr.on("jobDone", function (job) {
      // 逾時等沒有觸發 nodeDone 的節點也要產生結果
      var map = delivered[job.id] || {};
      job.clients.forEach(function (u) { if (!map[u]) deliver(job, u, job.results[u]); });
      var list = pending[job.id] || [];
      delete pending[job.id];
      delete delivered[job.id];
      return Promise.all(list).then(function () { return bot && bot.onJobDone(job); });
    });
    if (config.tgEnabled && config.tgToken) {
      bot = botLib.createBot(cfg, mgr);
      if (!config.tgAllowedIds.length) console.warn("[cn-speedtest] 尚未設定允許的 Telegram ID，機器人只會回覆 chat id");
      bot.start();
    }
  }, 500);
  console.info("[cn-speedtest] plugin loaded");
}

function unload() {
  if (startTimer) { clearTimeout(startTimer); startTimer = null; }
  if (bot) { bot.stop(); bot = null; }
  imaging = null;
  pending = {};
  delivered = {};
  if (mgr) { mgr.shutdown(); mgr = null; }
  console.info("[cn-speedtest] plugin unloaded");
}
