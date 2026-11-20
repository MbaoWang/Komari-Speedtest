// plugin/lib/jobs.js
// 任務管理：admin:exec 派發 → 輪詢 admin:getTaskById → 解析 → 存入 __storageDir__/state.json
// 一個 job 可以包含多個節點（同一個 exec task）。

"use strict";

var fs = require("fs");
var path = require("path");
var remote = require("./remote.js");
var parser = require("./parser.js");

var STATE_FILE = "state.json";
var POLL_MS = 5000;
var MAX_JOBS_WITH_RESULTS = 15; // 較舊的任務只留摘要，完整結果移除以控制檔案大小（每個節點的最新結果另外保存）

function errText(e) { return e && e.message ? e.message : String(e); }
function nowIso() { return new Date().toISOString(); }
function storagePath() {
  var dir = typeof __storageDir__ === "string" && __storageDir__ ? __storageDir__ : ".";
  return path.join(dir, STATE_FILE);
}
function newId() { return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10); }

function createJobManager(server, getConfig) {
  var state = null;
  var pollTimer = null;
  var unloaded = false;
  var listeners = { nodeDone: [], jobDone: [] };
  var nodeCache = null;
  var nodeCacheAt = 0;

  function emptyState() { return { schema: 1, jobs: [], latest: {} }; }

  function load() {
    if (state) return state;
    try {
      var p = storagePath();
      if (fs.existsSync(p)) {
        var j = JSON.parse(fs.readFileSync(p, "utf8"));
        if (j && typeof j === "object" && Array.isArray(j.jobs)) {
          state = j;
          if (!state.latest) state.latest = {};
          return state;
        }
      }
    } catch (e) { console.warn("[cn-speedtest] 讀取狀態失敗：" + errText(e)); }
    state = emptyState();
    return state;
  }

  function save() {
    var s = load();
    // 只保留最近的任務，較舊任務移除結果內容以控制檔案大小
    s.jobs.sort(function (a, b) { return Date.parse(b.startedAt) - Date.parse(a.startedAt); });
    var keep = getConfig().historyKeep || 40;
    if (s.jobs.length > keep) s.jobs = s.jobs.slice(0, keep);
    s.jobs.forEach(function (j, i) { if (i >= MAX_JOBS_WITH_RESULTS && j.status !== "running") j.results = {}; });
    try {
      var p = storagePath();
      fs.writeFileSync(p + ".tmp", JSON.stringify(s));
      fs.renameSync(p + ".tmp", p);
    } catch (e) { console.error("[cn-speedtest] 寫入狀態失敗：" + errText(e)); }
  }

  function on(ev, fn) { if (listeners[ev]) listeners[ev].push(fn); }
  function emit(ev, a, b, c) {
    (listeners[ev] || []).forEach(function (fn) {
      try {
        var r = fn(a, b, c);
        if (r && typeof r.then === "function") r.then(null, function (e) { console.warn("[cn-speedtest] listener error: " + errText(e)); });
      } catch (e) { console.warn("[cn-speedtest] listener error: " + errText(e)); }
    });
  }

  // 節點列表（含在線狀態），快取 10 秒
  async function nodes(force) {
    if (!force && nodeCache && Date.now() - nodeCacheAt < 10000) return nodeCache;
    var clients = await server.call("admin:listClients");
    var status = {};
    try { status = (await server.call("common:getNodesLatestStatus")) || {}; } catch (e) { console.warn("[cn-speedtest] 讀取節點狀態失敗：" + errText(e)); }
    var list = [];
    (Array.isArray(clients) ? clients : []).forEach(function (c) {
      if (!c || !c.uuid) return;
      var st = status[c.uuid] || {};
      list.push({
        uuid: c.uuid,
        name: c.name || c.uuid.slice(0, 8),
        region: c.region || "",
        os: c.os || "",
        arch: c.arch || "",
        group: c.group || "",
        hidden: Boolean(c.hidden),
        weight: Number(c.weight) || 0,
        online: st.online === true
      });
    });
    list.sort(function (a, b) { return (a.weight - b.weight) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
    nodeCache = list;
    nodeCacheAt = Date.now();
    return list;
  }

  function nodeName(uuid) {
    var n = (nodeCache || []).filter(function (x) { return x.uuid === uuid; })[0];
    return n ? n.name : String(uuid).slice(0, 8);
  }

  function running() { return load().jobs.filter(function (j) { return j.status === "running"; }); }

  function busyNodes() {
    var set = {};
    running().forEach(function (j) { j.clients.forEach(function (u) { if (!j.results[u]) set[u] = j.id; }); });
    return set;
  }

  // spec: { clients:[uuid], type:'ping'|'speed'|'full', family, points, mode, origin }
  async function run(spec) {
    if (unloaded) throw new Error("插件已停止");
    var cfg = getConfig();
    var type = spec.type === "speed" || spec.type === "full" ? spec.type : "ping";
    var family = remote.normFamily(spec.family || cfg.defaultFamily);
    var mode = remote.normMode(spec.mode || cfg.defaultMode);
    var points = remote.normPoints(spec.points !== undefined && spec.points !== null ? spec.points : cfg.defaultPoints);
    var isps = remote.normIsps(spec.isps !== undefined && spec.isps !== null ? spec.isps : cfg.defaultIsps);
    var list = await nodes(true);
    var known = {};
    list.forEach(function (n) { known[n.uuid] = n; });
    var uuids = (spec.clients || []).filter(function (u, i, a) { return typeof u === "string" && known[u] && a.indexOf(u) === i; });
    if (!uuids.length) throw new Error("找不到指定的節點");
    var offline = uuids.filter(function (u) { return !known[u].online; });
    var winNodes = uuids.filter(function (u) { return /windows/i.test(known[u].os); });
    uuids = uuids.filter(function (u) { return known[u].online && !/windows/i.test(known[u].os); });
    var busy = busyNodes();
    var busyList = uuids.filter(function (u) { return busy[u]; });
    uuids = uuids.filter(function (u) { return !busy[u]; });
    if (!uuids.length) {
      var why = [];
      if (offline.length) why.push("離線：" + offline.map(nodeName).join("、"));
      if (winNodes.length) why.push("不支援 Windows：" + winNodes.map(nodeName).join("、"));
      if (busyList.length) why.push("測試進行中：" + busyList.map(nodeName).join("、"));
      throw new Error("沒有可執行的節點（" + (why.join("；") || "未知原因") + "）");
    }
    if (running().length >= cfg.maxConcurrentJobs) throw new Error("同時進行的任務已達上限（" + cfg.maxConcurrentJobs + "），請稍後再試");

    var runId = newId();
    var opts = {
      runId: runId,
      ping: type !== "speed",
      speed: type !== "ping",
      family: family,
      points: points,
      mode: mode,
      duration: cfg.duration,
      pingCount: cfg.pingCount,
      parallel: cfg.pingParallel,
      provinceFilter: cfg.provinceFilter,
      getNodesUrl: cfg.getNodesUrl,
      taierUrl: cfg.taierUrl,
      customTargets: cfg.customTargets,
      isps: isps,
      retries: cfg.speedRetries
    };
    var command = remote.buildRemoteCommand(opts);
    var estSec = remote.estimateSeconds({ ping: opts.ping, speed: opts.speed, family: family, points: points, mode: mode, duration: cfg.duration, pingCount: cfg.pingCount, isps: isps, retries: cfg.speedRetries });
    // 等待上限要涵蓋「每個測速點都重測」的最壞情況
    var worstSec = remote.estimateSeconds({ ping: opts.ping, speed: opts.speed, family: family, points: points, mode: mode, duration: cfg.duration, pingCount: cfg.pingCount, isps: isps, retries: 0 }) * (1 + (opts.speed ? cfg.speedRetries : 0));
    var resp = await server.call("admin:exec", { command: command, clients: uuids });
    var taskId = resp && resp.task_id ? String(resp.task_id) : "";
    if (!taskId) throw new Error("admin:exec 沒有回傳 task_id");
    var job = {
      id: runId,
      taskId: taskId,
      type: type,
      family: family,
      points: points,
      mode: mode,
      isps: isps,
      clients: uuids,
      names: {},
      skipped: { offline: offline, windows: winNodes, busy: busyList },
      status: "running",
      startedAt: nowIso(),
      finishedAt: null,
      estimateSec: estSec,
      deadlineAt: new Date(Date.now() + (Math.min(worstSec, 3600) + 180) * 1000).toISOString(),
      origin: spec.origin || { kind: "web" },
      results: {},
      error: null
    };
    uuids.forEach(function (u) { job.names[u] = known[u].name; });
    load().jobs.unshift(job);
    save();
    schedulePoll(1500);
    return job;
  }

  function applyResult(job, r) {
    var uuid = r.client;
    if (job.clients.indexOf(uuid) < 0 || job.results[uuid] || !r.finished_at) return false;
    var parsed = parser.parseOutput(String(r.result || ""), r.exit_code);
    parsed.finishedAt = nowIso();
    parsed.exitCode = r.exit_code;
    job.results[uuid] = parsed;
    var s = load();
    if (!s.latest[uuid]) s.latest[uuid] = {};
    if (parsed.latency.length) s.latest[uuid].ping = { at: parsed.finishedAt, jobId: job.id, family: job.family, latency: parsed.latency, ip4: parsed.ip4, ip6: parsed.ip6 };
    if (parsed.speed.length) s.latest[uuid].speed = { at: parsed.finishedAt, jobId: job.id, family: job.family, points: job.points, mode: job.mode, speed: parsed.speed, exit: parsed.exit };
    return true;
  }

  function finishJob(job, error) {
    if (job.status !== "running") return;
    job.clients.forEach(function (u) {
      if (!job.results[u]) job.results[u] = { ok: false, latency: [], speed: [], errors: [error || "等待逾時，沒有收到節點結果"], warnings: [], finishedAt: nowIso() };
    });
    job.status = error && error !== "cancelled" ? "failed" : (error === "cancelled" ? "cancelled" : "done");
    if (job.status === "done" && job.clients.every(function (u) { return !job.results[u].ok; })) job.status = "failed";
    job.error = error && error !== "cancelled" ? error : null;
    job.finishedAt = nowIso();
    save();
    emit("jobDone", job);
  }

  async function pollOnce() {
    var list = running();
    for (var i = 0; i < list.length; i++) {
      var job = list[i];
      if (unloaded) return;
      try {
        var info = await server.call("admin:getTaskById", { task_id: job.taskId });
        var changed = false;
        if (info && Array.isArray(info.results)) {
          info.results.forEach(function (r) {
            if (applyResult(job, r)) {
              changed = true;
              emit("nodeDone", job, r.client, job.results[r.client]);
            }
          });
        }
        if (job.clients.every(function (u) { return job.results[u]; })) finishJob(job, null);
        else if (Date.now() > Date.parse(job.deadlineAt)) finishJob(job, "等待逾時，節點未回傳結果");
        else if (changed) save();
      } catch (e) {
        job.pollError = errText(e);
        if (Date.now() > Date.parse(job.deadlineAt)) finishJob(job, "輪詢失敗：" + errText(e));
      }
    }
  }

  function schedulePoll(ms) {
    if (unloaded || pollTimer) return;
    pollTimer = setTimeout(async function () {
      pollTimer = null;
      try { await pollOnce(); } catch (e) { console.warn("[cn-speedtest] poll error: " + errText(e)); }
      if (running().length) schedulePoll(POLL_MS);
    }, ms || POLL_MS);
  }

  function cancel(id) {
    var job = load().jobs.filter(function (j) { return j.id === id; })[0];
    if (!job || job.status !== "running") return false;
    finishJob(job, "cancelled");
    return true;
  }

  // 結果圖產生後記錄到任務與節點最新結果
  function setImage(job, uuid, img) {
    if (!img || !job.results[uuid]) return;
    job.results[uuid].image = { file: img.file, url: img.url };
    var l = load().latest[uuid];
    if (l) l.image = { file: img.file, url: img.url, at: new Date().toISOString(), jobId: job.id, type: job.type };
    save();
  }

  // 清除已結束的任務紀錄（不影響各節點的最新結果與公開頁）
  function clearFinished() {
    var s = load();
    var before = s.jobs.length;
    s.jobs = s.jobs.filter(function (j) { return j.status === "running"; });
    save();
    return before - s.jobs.length;
  }

  function getJob(id) { return load().jobs.filter(function (j) { return j.id === id; })[0] || null; }
  function jobs() { return load().jobs; }
  function latest(uuid) { return load().latest[uuid] || null; }

  function start() {
    load();
    if (running().length) schedulePoll(2000);
  }

  function shutdown() {
    unloaded = true;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }

  return { start: start, shutdown: shutdown, run: run, clearFinished: clearFinished, setImage: setImage, cancel: cancel, nodes: nodes, nodeName: nodeName, getJob: getJob, jobs: jobs, latest: latest, running: running, on: on };
}

module.exports = { createJobManager: createJobManager };
