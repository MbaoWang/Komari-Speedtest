// plugin/lib/telegram.js
// Telegram 機器人：long polling（getUpdates）+ 互動式 Inline 鍵盤選單 + 文字指令 / 關鍵字測速。

"use strict";

var fs = require("fs");
var path = require("path");
var remote = require("./remote.js");
var fmt = require("./format.js");

var PAGE_SIZE = 10;

function errText(e) { return e && e.message ? e.message : String(e); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function tgStatePath() {
  var dir = typeof __storageDir__ === "string" && __storageDir__ ? __storageDir__ : ".";
  return path.join(dir, "telegram.json");
}

var KW = {
  ping: ["ping", "tcping", "延遲", "延迟", "時延", "时延", "測延遲", "测延迟"],
  speed: ["speed", "speedtest", "測速", "测速", "泰爾", "泰尔", "泰爾測速", "泰尔测速"],
  full: ["full", "all", "全測", "全测", "完整", "完整測試", "完整测试"],
  nodes: ["nodes", "list", "節點", "节点", "節點列表", "节点列表"],
  menu: ["start", "menu", "菜單", "菜单", "選單", "选单", "主選單"],
  help: ["help", "幫助", "帮助", "說明", "说明"],
  jobs: ["jobs", "任務", "任务", "狀態", "状态"],
  last: ["last", "result", "結果", "结果", "上次"],
  id: ["id", "chatid", "我的id"]
};
var FAMILY_KW = { "v4": "4", "ipv4": "4", "4": "4", "v6": "6", "ipv6": "6", "6": "6", "雙棧": "both", "双栈": "both", "both": "both", "dual": "both", "v46": "both", "46": "both" };
// 運營商關鍵字（單獨一個字詞；「上海电信」這種帶地點的仍視為測速點）
var ISP_KW = { "電信": "电信", "电信": "电信", "聯通": "联通", "联通": "联通", "移動": "移动", "移动": "移动", "三網": "all", "三网": "all" };
var ISP_CODE = { "ct": "电信", "cu": "联通", "cm": "移动" };
var MODE_KW = {
  "single": "single", "單線程": "single", "单线程": "single", "單": "single", "单": "single", "s": "single",
  "multi": "multi", "多線程": "multi", "多线程": "multi", "多": "multi", "m": "multi",
  "單多": "both", "单多": "both", "單+多": "both", "单+多": "both", "sm": "both", "全模式": "both"
};

function lookupCmd(word) {
  var w = String(word || "").toLowerCase();
  for (var k in KW) if (KW[k].indexOf(w) >= 0) return k;
  return null;
}

// 判斷一個字是否為泰爾測速支援的測速點（省份 / 城市，可帶運營商）
function isPointToken(tok) {
  var s = remote.toSimplified(tok);
  if (s === "北上广" || s === "bsg") return true;
  var base = s.replace(/(电信|联通|移动)$/, "");
  if (!base) return false;
  return remote.PROVINCES.indexOf(base) >= 0 || remote.EXTRA_CITIES.indexOf(base) >= 0 ||
    ["石家庄", "太原", "呼和浩特", "沈阳", "长春", "哈尔滨", "南京", "杭州", "合肥", "福州", "南昌", "济南", "郑州", "武汉", "长沙", "广州", "南宁", "海口", "成都", "贵阳", "昆明", "拉萨", "西安", "兰州", "西宁", "银川", "乌鲁木齐"].indexOf(base) >= 0;
}

function createBot(getConfig, mgr) {
  var stopped = false;
  var running = false;
  var aborter = null;
  var offset = 0;
  var me = null;
  var sessions = {};
  var loopPromise = null;

  try {
    var st = JSON.parse(fs.readFileSync(tgStatePath(), "utf8"));
    if (st && st.offset) offset = Number(st.offset) || 0;
    if (st && st.sessions) sessions = st.sessions;
  } catch (e) { /* 首次執行 */ }

  function saveState() {
    try { fs.writeFileSync(tgStatePath(), JSON.stringify({ offset: offset, sessions: sessions })); } catch (e) { /* ignore */ }
  }

  function cfg() { return getConfig(); }

  async function api(method, params, signal) {
    var c = cfg();
    var url = c.tgApiBase.replace(/\/+$/, "") + "/bot" + c.tgToken + "/" + method;
    var init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params || {}) };
    if (signal) init.signal = signal;
    var res = await fetch(url, init);
    var text = await res.text();
    var data;
    try { data = JSON.parse(text); } catch (e) { throw new Error("Telegram 回應無法解析（HTTP " + res.status + "）"); }
    if (!data.ok) {
      var err = new Error("Telegram " + method + " 失敗：" + (data.description || res.status));
      err.code = data.error_code;
      throw err;
    }
    return data.result;
  }

  async function apiForm(method, form) {
    var c = cfg();
    var res = await fetch(c.tgApiBase.replace(/\/+$/, "") + "/bot" + c.tgToken + "/" + method, { method: "POST", body: form });
    var text = await res.text();
    var data;
    try { data = JSON.parse(text); } catch (e) { throw new Error("Telegram 回應無法解析（HTTP " + res.status + "）"); }
    if (!data.ok) throw new Error("Telegram " + method + " 失敗：" + (data.description || res.status));
    return data.result;
  }

  function isAllowed(msgFrom, chat) {
    var ids = cfg().tgAllowedIds;
    if (!ids.length) return false;
    var a = msgFrom && msgFrom.id !== undefined ? String(msgFrom.id) : "";
    var b = chat && chat.id !== undefined ? String(chat.id) : "";
    return ids.indexOf(a) >= 0 || ids.indexOf(b) >= 0;
  }

  function session(chatId) {
    var c = cfg();
    var s = sessions[chatId];
    if (!s) { s = sessions[chatId] = { points: c.defaultPoints, mode: c.defaultMode, isps: c.defaultIsps }; }
    if (!Array.isArray(s.isps)) s.isps = c.defaultIsps;
    return s;
  }

  async function send(chatId, html, extra) {
    var chunks = fmt.splitMessage(html);
    var last = null;
    for (var i = 0; i < chunks.length; i++) {
      var p = { chat_id: chatId, text: chunks[i], parse_mode: "HTML", disable_web_page_preview: true };
      if (extra && i === chunks.length - 1) for (var k in extra) p[k] = extra[k];
      last = await api("sendMessage", p);
    }
    return last;
  }

  async function edit(chatId, messageId, html, markup) {
    var p = { chat_id: chatId, message_id: messageId, text: html.length > 4096 ? html.slice(0, 4000) + "…" : html, parse_mode: "HTML", disable_web_page_preview: true };
    if (markup) p.reply_markup = markup;
    try { return await api("editMessageText", p); }
    catch (e) { if (!/not modified/i.test(errText(e))) throw e; return null; }
  }

  // ---------------- 選單 ----------------

  async function homeView(page) {
    var list = await mgr.nodes();
    if (!cfg().tgShowHidden) list = list.filter(function (n) { return !n.hidden; });
    var pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    page = Math.min(Math.max(0, page || 0), pages - 1);
    var slice = list.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    var rows = [];
    for (var i = 0; i < slice.length; i += 2) {
      var row = [];
      [slice[i], slice[i + 1]].forEach(function (n) {
        if (!n) return;
        row.push({ text: (n.online ? "🟢 " : "⚪ ") + n.name.slice(0, 24), callback_data: "n:" + n.uuid });
      });
      rows.push(row);
    }
    if (pages > 1) {
      var nav = [];
      if (page > 0) nav.push({ text: "⬅️ 上一頁", callback_data: "h:" + (page - 1) });
      nav.push({ text: (page + 1) + " / " + pages, callback_data: "h:" + page });
      if (page < pages - 1) nav.push({ text: "下一頁 ➡️", callback_data: "h:" + (page + 1) });
      rows.push(nav);
    }
    rows.push([{ text: "🌐 全部在線節點", callback_data: "n:all" }]);
    rows.push([{ text: "📋 進行中任務", callback_data: "j" }, { text: "❓ 使用說明", callback_data: "hp" }, { text: "🔄 重新整理", callback_data: "h:" + page }]);
    var online = list.filter(function (n) { return n.online; }).length;
    var text = "<b>🇨🇳 中國網路測速（Komari）</b>\n" +
      "節點：" + list.length + " 台（在線 " + online + "）\n\n" +
      "請選擇要測試的節點 👇\n" +
      "<i>也可直接輸入：測速 節點名 v6 上海｜延遲 節點名</i>";
    return { text: text, markup: { inline_keyboard: rows } };
  }

  async function nodeView(chatId, target) {
    var s = session(chatId);
    var title;
    var info = "";
    if (target === "all") {
      var list = await mgr.nodes();
      var on = list.filter(function (n) { return n.online && !/windows/i.test(n.os) && (cfg().tgShowHidden || !n.hidden); });
      title = "🌐 全部在線節點（" + on.length + " 台）";
      info = "⚠️ 會對所有在線節點同時下發測試";
    } else {
      var n = (await mgr.nodes()).filter(function (x) { return x.uuid === target; })[0];
      if (!n) return { text: "找不到節點，可能已被刪除。", markup: { inline_keyboard: [[{ text: "⬅️ 返回", callback_data: "h:0" }]] } };
      title = (n.online ? "🟢 " : "⚪ ") + fmt.esc(n.name);
      var bits = [];
      if (n.region) bits.push(fmt.esc(n.region));
      if (n.os) bits.push(fmt.esc(n.os));
      if (n.arch) bits.push(fmt.esc(n.arch));
      info = bits.join("｜");
      var last = mgr.latest(n.uuid);
      if (last && last.ping) info += "\n上次延遲：" + fmt.esc(fmt.fmtTime(last.ping.at));
      if (last && last.speed) info += "\n上次測速：" + fmt.esc(fmt.fmtTime(last.speed.at));
      if (!n.online) info += "\n⚠️ 節點離線，無法測試";
    }
    var text = "<b>" + title + "</b>\n" + info + "\n\n" +
      "📍 測速點：<b>" + fmt.esc(fmt.pointsLabel(s.points)) + "</b>\n" +
      "⚙️ 測速模式：<b>" + fmt.modeLabel(s.mode) + "</b>\n" +
      "📡 運營商：<b>" + fmt.ispsLabel(s.isps) + "</b>\n\n" +
      "選擇測試項目 👇";
    var t = target;
    var rows = [
      [{ text: "🚀 測速 IPv4", callback_data: "r:s4:" + t }, { text: "🚀 測速 IPv6", callback_data: "r:s6:" + t }, { text: "🚀 測速 雙棧", callback_data: "r:sb:" + t }],
      [{ text: "📶 延遲 IPv4", callback_data: "r:p4:" + t }, { text: "📶 延遲 IPv6", callback_data: "r:p6:" + t }, { text: "📶 延遲 雙棧", callback_data: "r:pb:" + t }],
      [{ text: "🧪 完整 IPv4", callback_data: "r:f4:" + t }, { text: "🧪 完整 IPv6", callback_data: "r:f6:" + t }, { text: "🧪 完整 雙棧", callback_data: "r:fb:" + t }],
      [{ text: "📍 選擇測速點", callback_data: "pt:" + t }, { text: "⚙️ 模式：" + fmt.modeLabel(s.mode), callback_data: "mc:" + t }],
      [{ text: "📡 運營商：" + fmt.ispsLabel(s.isps), callback_data: "ic:" + t }]
    ];
    if (target !== "all") rows.push([{ text: "📄 上次結果", callback_data: "l:" + t }, { text: "⬅️ 返回節點列表", callback_data: "h:0" }]);
    else rows.push([{ text: "⬅️ 返回節點列表", callback_data: "h:0" }]);
    return { text: text, markup: { inline_keyboard: rows } };
  }

  function ispView(chatId, target) {
    var s = session(chatId);
    var all = !s.isps.length;
    var names = [["电信", "電信"], ["联通", "聯通"], ["移动", "移動"]];
    var rows = [
      [{ text: (all ? "✅ " : "") + "三網（全部）", callback_data: "it:a:" + target }],
      names.map(function (n, i) { return { text: (!all && s.isps.indexOf(n[0]) >= 0 ? "✅ " : "") + n[1], callback_data: "it:" + i + ":" + target }; }),
      [{ text: "✔️ 完成", callback_data: "n:" + target }]
    ];
    return {
      text: "<b>📡 選擇運營商</b>（可多選）\n目前：<b>" + fmt.ispsLabel(s.isps) + "</b>\n\n同時套用到延遲 / 丟包與泰爾測速。\n<i>文字指令也可以加：測速 節點名 電信 聯通</i>",
      markup: { inline_keyboard: rows }
    };
  }

  function pointsView(chatId, target) {
    var s = session(chatId);
    var selected = s.points ? s.points.split(",") : [];
    var rows = [[{ text: (selected.length ? "" : "✅ ") + "北上廣三網（預設）", callback_data: "ps:b:" + target }]];
    var row = [];
    remote.PROVINCES.forEach(function (p, i) {
      row.push({ text: (selected.indexOf(p) >= 0 ? "✅" : "") + fmt.tProv(p), callback_data: "ps:" + i + ":" + target });
      if (row.length === 4) { rows.push(row); row = []; }
    });
    if (row.length) rows.push(row);
    rows.push([{ text: "✔️ 完成", callback_data: "n:" + target }]);
    var text = "<b>📍 選擇測速點</b>（可多選，每個地點測電信 / 聯通 / 移動）\n" +
      "目前：<b>" + fmt.esc(fmt.pointsLabel(s.points)) + "</b>\n\n" +
      "<i>指定單一運營商可用文字指令，例如：測速 節點名 上海电信,广东移动</i>";
    return { text: text, markup: { inline_keyboard: rows } };
  }

  function jobsView() {
    var list = mgr.running();
    var lines = ["<b>📋 進行中任務</b>"];
    if (!list.length) lines.push("目前沒有進行中的任務。");
    list.forEach(function (j) {
      var done = j.clients.filter(function (u) { return j.results[u]; }).length;
      var secs = Math.round((Date.now() - Date.parse(j.startedAt)) / 1000);
      lines.push("• " + fmt.typeLabel(j.type) + " " + fmt.familyLabel(j.family) + "｜" + j.clients.map(function (u) { return fmt.esc(j.names[u] || mgr.nodeName(u)); }).join("、") +
        "｜" + done + "/" + j.clients.length + "｜已 " + secs + " 秒（預估 " + j.estimateSec + " 秒）");
    });
    return { text: lines.join("\n"), markup: { inline_keyboard: [[{ text: "🔄 重新整理", callback_data: "j" }, { text: "⬅️ 返回", callback_data: "h:0" }]] } };
  }

  function helpText() {
    return [
      "<b>❓ 使用說明</b>",
      "",
      "<b>互動選單</b>：/menu → 選節點 → 選測試項目",
      "",
      "<b>指令 / 關鍵字</b>（可不加斜線）：",
      "<code>/speed 節點 [v4|v6|雙棧] [測速點] [單|多|單多]</code>  泰爾測速",
      "<code>/ping 節點 [v4|v6|雙棧] [電信|聯通|移動]</code>  延遲 / 丟包",
      "<code>/full 節點 [v4|v6|雙棧] [測速點]</code>  延遲 + 測速",
      "<code>/last 節點</code>  上次結果",
      "<code>/nodes</code>  節點列表（可用編號代替名稱）",
      "<code>/jobs</code>  進行中任務",
      "<code>/id</code>  顯示你的 chat id",
      "",
      "<b>範例</b>：",
      "<code>測速 HK-1 v6</code>",
      "<code>延遲 2 雙棧</code>",
      "<code>测速 日本 v4 上海,广东 多</code>",
      "<code>speed tokyo 上海电信,北京联通</code>",
      "<code>延遲 HK-1 電信 移動</code>（只測電信、移動）",
      "<code>全測 all</code>（所有在線節點）",
      "",
      "節點可用：編號、名稱（不分大小寫，可部分符合）、UUID 前綴、all / 全部。",
      "測速點：省份或城市（如 上海、广东、深圳），可加運營商（上海电信）。預設北上廣三網。",
      "運營商：電信 / 聯通 / 移動（可多個，同時套用到延遲與測速），也可在選單「📡 運營商」選擇。",
      "測速某點失敗（速度 0）時會自動重測（設定可調次數）。"
    ].join("\n");
  }

  // ---------------- 執行測試 ----------------

  async function startJob(chatId, replyTo, type, family, target, points, mode, isps) {
    var uuids;
    var list = await mgr.nodes(true);
    if (target === "all") {
      uuids = list.filter(function (n) { return n.online && !/windows/i.test(n.os) && (cfg().tgShowHidden || !n.hidden); }).map(function (n) { return n.uuid; });
    } else uuids = [target];
    if (!uuids.length) throw new Error("沒有在線節點");
    var names = uuids.map(function (u) { return mgr.nodeName(u); });
    var statusMsg = await send(chatId,
      "⏳ <b>" + fmt.typeLabel(type) + "</b>（" + fmt.familyLabel(remote.normFamily(family)) + "｜" + fmt.ispsLabel(remote.normIsps(isps)) + "）已派發到：" + fmt.esc(names.slice(0, 10).join("、")) + (names.length > 10 ? " 等 " + names.length + " 台" : "") +
      (type !== "ping" ? "\n📍 " + fmt.esc(fmt.pointsLabel(remote.normPoints(points))) + "｜" + fmt.modeLabel(remote.normMode(mode)) : "") +
      "\n請稍候…", replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : undefined);
    try {
      var job = await mgr.run({ clients: uuids, type: type, family: family, points: points, mode: mode, isps: isps, origin: { kind: "tg", chatId: chatId, messageId: statusMsg.message_id } });
      var extra = "";
      var sk = job.skipped;
      if (sk.offline.length) extra += "\n⚪ 略過離線：" + sk.offline.map(mgr.nodeName).map(fmt.esc).join("、");
      if (sk.windows.length) extra += "\n🪟 略過 Windows：" + sk.windows.map(mgr.nodeName).map(fmt.esc).join("、");
      if (sk.busy.length) extra += "\n⏳ 略過測試中：" + sk.busy.map(mgr.nodeName).map(fmt.esc).join("、");
      await edit(chatId, statusMsg.message_id,
        "⏳ <b>" + fmt.typeLabel(job.type) + "</b>（" + fmt.familyLabel(job.family) + "｜" + fmt.ispsLabel(job.isps) + "）執行中：" + fmt.esc(job.clients.map(function (u) { return job.names[u]; }).join("、")) +
        (job.type !== "ping" ? "\n📍 " + fmt.esc(fmt.pointsLabel(job.points)) + "｜" + fmt.modeLabel(job.mode) : "") +
        "\n預估約 " + Math.ceil(job.estimateSec / 60) + " 分鐘，完成後會自動回傳結果。" + extra);
    } catch (e) {
      await edit(chatId, statusMsg.message_id, "❌ 無法開始測試：" + fmt.esc(errText(e)));
    }
  }

  function resultMarkup(job, uuid) {
    var f = job.family === "both" ? "b" : job.family;
    var t = job.type === "ping" ? "p" : job.type === "speed" ? "s" : "f";
    var target = job.clients.length > 1 ? "all" : uuid;
    return { inline_keyboard: [[{ text: "🔁 再測一次", callback_data: "r:" + t + f + ":" + target }, { text: "📋 節點選單", callback_data: "n:" + uuid }]] };
  }

  async function sendPhoto(chatId, png, caption, extra) {
    var form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("caption", caption.length > 1024 ? caption.slice(0, 1000) + "…" : caption);
    form.append("parse_mode", "HTML");
    if (extra) for (var k in extra) form.append(k, typeof extra[k] === "object" ? JSON.stringify(extra[k]) : String(extra[k]));
    form.append("photo", new Blob([png], { type: "image/png" }), "cn-speedtest.png");
    return apiForm("sendPhoto", form);
  }

  async function sendNodeResult(chatId, job, uuid, result, replyTo, img) {
    var name = job.names[uuid] || mgr.nodeName(uuid);
    var mode = cfg().tgResultFormat;
    var extra = { reply_markup: resultMarkup(job, uuid) };
    if (replyTo) { extra.reply_to_message_id = replyTo; extra.allow_sending_without_reply = true; }
    if (img && img.png && mode !== "text") {
      var caption = fmt.shortSummaryHTML(job, name, result) + (img.url ? "\n🔗 " + fmt.esc(img.url) : "");
      try {
        await sendPhoto(chatId, img.png, caption, mode === "both" ? (replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : null) : extra);
        if (mode === "both") await send(chatId, fmt.nodeResultHTML(job, name, result, { showIp: cfg().tgShowFullIp }), { reply_markup: resultMarkup(job, uuid) });
        return;
      } catch (e) {
        console.warn("[cn-speedtest] Telegram 傳送圖片失敗，改傳文字：" + errText(e));
      }
    }
    var html = fmt.nodeResultHTML(job, name, result, { showIp: cfg().tgShowFullIp }) + (img && img.url ? "\n🔗 結果圖：" + fmt.esc(img.url) : "");
    await send(chatId, html, extra);
  }

  // 單一節點結果（含圖片）→ 傳給發起者 / 通知對象
  async function deliverNodeResult(job, uuid, result, img) {
    if (stopped || !cfg().tgEnabled) return;
    var targets = [];
    if (job.origin && job.origin.kind === "tg") targets.push({ chatId: job.origin.chatId, replyTo: job.origin.messageId });
    else if (job.origin && (job.origin.kind === "cron" || (job.origin.kind === "web" && cfg().tgNotifyWeb))) cfg().tgNotifyIds.forEach(function (id) { targets.push({ chatId: id }); });
    for (var i = 0; i < targets.length; i++) {
      try { await sendNodeResult(targets[i].chatId, job, uuid, result, targets[i].replyTo, img); }
      catch (e) { console.warn("[cn-speedtest] Telegram 傳送結果失敗：" + errText(e)); }
    }
  }

  // 任務結束 → 更新「執行中」那則狀態訊息
  async function onJobDone(job) {
    if (stopped || !cfg().tgEnabled) return;
    if (job.origin && job.origin.kind === "tg") {
      var ok = job.clients.filter(function (u) { return job.results[u] && job.results[u].ok; }).length;
      var icon = job.status === "done" ? "✅" : job.status === "cancelled" ? "🛑" : "⚠️";
      var took = Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000);
      try {
        await edit(job.origin.chatId, job.origin.messageId,
          icon + " <b>" + fmt.typeLabel(job.type) + "</b>（" + fmt.familyLabel(job.family) + "）完成：成功 " + ok + " / " + job.clients.length + " 台，耗時 " + took + " 秒" +
          (job.error ? "\n" + fmt.esc(job.error) : ""));
      } catch (e) { /* ignore */ }
    }
  }

  // ---------------- 解析文字 ----------------

  async function resolveNode(tokens) {
    var list = await mgr.nodes(true);
    if (!cfg().tgShowHidden) list = list.filter(function (n) { return !n.hidden; });
    var joined = tokens.join(" ").toLowerCase();
    if (!joined) return { error: "請指定節點，例如：測速 HK-1（輸入 /nodes 查看列表）" };
    if (joined === "all" || joined === "全部" || joined === "所有") return { target: "all" };
    if (/^\d+$/.test(joined)) {
      var idx = Number(joined) - 1;
      if (list[idx]) return { target: list[idx].uuid };
    }
    var exact = list.filter(function (n) { return n.name.toLowerCase() === joined; });
    if (exact.length === 1) return { target: exact[0].uuid };
    var byUuid = list.filter(function (n) { return joined.length >= 4 && n.uuid.toLowerCase().indexOf(joined) === 0; });
    if (byUuid.length === 1) return { target: byUuid[0].uuid };
    var sub = list.filter(function (n) { return n.name.toLowerCase().indexOf(joined) >= 0; });
    if (sub.length === 1) return { target: sub[0].uuid };
    if (sub.length > 1) return { error: "符合「" + joined + "」的節點有多個：" + sub.slice(0, 8).map(function (n) { return n.name; }).join("、") + "，請輸入更完整的名稱或編號" };
    return { error: "找不到節點「" + joined + "」，輸入 /nodes 查看列表" };
  }

  // 回傳 { cmd, family, mode, points, nodeTokens }，若不是指令回傳 null
  function parseText(text) {
    var t = String(text || "").trim();
    if (!t) return null;
    var slash = t.charAt(0) === "/";
    var tokens = t.replace(/^\//, "").split(/\s+/);
    var first = tokens.shift().replace(/@\S+$/, "");
    var cmd = lookupCmd(first);
    if (!cmd) return slash ? { cmd: "unknown" } : null;
    var family = null, mode = null, pointsArr = [], nodeTokens = [], ispArr = [];
    tokens.forEach(function (tok) {
      var low = tok.toLowerCase();
      if (nodeTokens.length && FAMILY_KW[low] && family === null) { family = FAMILY_KW[low]; return; }
      if (!nodeTokens.length && FAMILY_KW[low] && !/^\d+$/.test(low)) { family = FAMILY_KW[low]; return; }
      if (ISP_KW[low] || (nodeTokens.length && ISP_CODE[low])) { ispArr.push(ISP_KW[low] || ISP_CODE[low]); return; }
      if (MODE_KW[low] && mode === null && (nodeTokens.length || low.length > 1)) { mode = MODE_KW[low]; return; }
      var pts = tok.split(/[,，、]/).filter(Boolean);
      if (pts.length && pts.every(isPointToken)) { pointsArr = pointsArr.concat(pts); return; }
      nodeTokens.push(tok);
    });
    return { cmd: cmd, family: family, mode: mode, points: pointsArr.length ? pointsArr.join(",") : null, isps: ispArr.length ? remote.normIsps(ispArr) : null, nodeTokens: nodeTokens };
  }

  async function nodesListText() {
    var list = await mgr.nodes(true);
    if (!cfg().tgShowHidden) list = list.filter(function (n) { return !n.hidden; });
    var lines = ["<b>🖥 節點列表</b>（可用編號代替名稱）"];
    list.forEach(function (n, i) {
      lines.push((i + 1) + ". " + (n.online ? "🟢 " : "⚪ ") + fmt.esc(n.name) + (n.region ? " " + fmt.esc(n.region) : ""));
    });
    if (list.length === 0) lines.push("（沒有節點）");
    return lines.join("\n");
  }

  async function lastResultText(target) {
    var html = [];
    var l = mgr.latest(target);
    var name = mgr.nodeName(target);
    if (!l) return "📄 " + fmt.esc(name) + " 還沒有測試紀錄。";
    if (l.ping) html.push(fmt.nodeResultHTML({ type: "ping", family: l.ping.family }, name, { latency: l.ping.latency, speed: [], errors: [], warnings: [], ip4: l.ping.ip4, ip6: l.ping.ip6 }, { showIp: cfg().tgShowFullIp }) + "\n<i>" + fmt.esc(fmt.fmtTime(l.ping.at)) + "</i>");
    if (l.speed) html.push(fmt.nodeResultHTML({ type: "speed", family: l.speed.family, points: l.speed.points, mode: l.speed.mode }, name, { latency: [], speed: l.speed.speed, errors: [], warnings: [], exit: l.speed.exit }, {}) + "\n<i>" + fmt.esc(fmt.fmtTime(l.speed.at)) + "</i>");
    return html.join("\n\n");
  }

  async function handleMessage(msg) {
    var chatId = msg.chat.id;
    var parsed = parseText(msg.text);
    if (!parsed) return;
    if (parsed.cmd === "id") {
      return send(chatId, "👤 你的 user id：<code>" + (msg.from ? msg.from.id : "-") + "</code>\n💬 此聊天 chat id：<code>" + chatId + "</code>");
    }
    if (!isAllowed(msg.from, msg.chat)) {
      if (msg.chat.type === "private" || msg.text.charAt(0) === "/") {
        return send(chatId, "⛔ 你沒有使用權限。\n請管理員在 Komari 插件設定的「允許的 Telegram ID」加入：<code>" + (msg.from ? msg.from.id : chatId) + "</code>");
      }
      return;
    }
    var s = session(chatId);
    switch (parsed.cmd) {
      case "menu": { var v = await homeView(0); return send(chatId, v.text, { reply_markup: v.markup }); }
      case "help": return send(chatId, helpText());
      case "nodes": return send(chatId, await nodesListText());
      case "jobs": { var jv = jobsView(); return send(chatId, jv.text, { reply_markup: jv.markup }); }
      case "unknown": return send(chatId, "未知指令，輸入 /help 查看說明。");
      case "last": {
        var rn = await resolveNode(parsed.nodeTokens);
        if (rn.error) return send(chatId, "⚠️ " + fmt.esc(rn.error));
        if (rn.target === "all") return send(chatId, "請指定單一節點。");
        return send(chatId, await lastResultText(rn.target));
      }
      case "ping": case "speed": case "full": {
        if (!parsed.nodeTokens.length) {
          var hv = await homeView(0);
          return send(chatId, "請選擇節點（或輸入：" + (parsed.cmd === "ping" ? "延遲" : "測速") + " 節點名）\n\n" + hv.text, { reply_markup: hv.markup });
        }
        var r = await resolveNode(parsed.nodeTokens);
        if (r.error) return send(chatId, "⚠️ " + fmt.esc(r.error));
        var family = parsed.family || cfg().defaultFamily;
        var points = parsed.points !== null ? parsed.points : s.points;
        var mode = parsed.mode || s.mode;
        var isps = parsed.isps !== null ? parsed.isps : s.isps;
        try { remote.normPoints(points); } catch (e) { return send(chatId, "⚠️ " + fmt.esc(errText(e))); }
        return startJob(chatId, msg.message_id, parsed.cmd, family, r.target, points, mode, isps);
      }
    }
  }

  async function handleCallback(q) {
    var data = String(q.data || "");
    var msg = q.message;
    if (!msg) return api("answerCallbackQuery", { callback_query_id: q.id });
    var chatId = msg.chat.id;
    if (!isAllowed(q.from, msg.chat)) return api("answerCallbackQuery", { callback_query_id: q.id, text: "⛔ 沒有使用權限（ID " + q.from.id + "）", show_alert: true });
    var s = session(chatId);
    var parts = data.split(":");
    var view = null;
    var toast = "";
    try {
      switch (parts[0]) {
        case "h": view = await homeView(Number(parts[1]) || 0); break;
        case "n": view = await nodeView(chatId, parts.slice(1).join(":")); break;
        case "j": view = jobsView(); break;
        case "hp": view = { text: helpText(), markup: { inline_keyboard: [[{ text: "⬅️ 返回", callback_data: "h:0" }]] } }; break;
        case "pt": view = pointsView(chatId, parts.slice(1).join(":")); break;
        case "ps": {
          var target = parts.slice(2).join(":");
          if (parts[1] === "b") s.points = "";
          else {
            var prov = remote.PROVINCES[Number(parts[1])];
            var sel = s.points ? s.points.split(",") : [];
            var at = sel.indexOf(prov);
            if (at >= 0) sel.splice(at, 1); else if (prov) sel.push(prov);
            if (sel.length > 8) { toast = "最多選 8 個地點"; sel.pop(); }
            s.points = sel.join(",");
          }
          saveState();
          view = pointsView(chatId, target);
          break;
        }
        case "ic": view = ispView(chatId, parts.slice(1).join(":")); break;
        case "it": {
          var tgt = parts.slice(2).join(":");
          if (parts[1] === "a") s.isps = [];
          else {
            var isp = ["电信", "联通", "移动"][Number(parts[1])];
            var cur = s.isps.length ? s.isps.slice() : [];
            var at2 = cur.indexOf(isp);
            if (at2 >= 0) cur.splice(at2, 1); else if (isp) cur.push(isp);
            s.isps = remote.normIsps(cur);
          }
          saveState();
          view = ispView(chatId, tgt);
          break;
        }
        case "mc": {
          s.mode = s.mode === "single" ? "multi" : s.mode === "multi" ? "both" : "single";
          saveState();
          view = await nodeView(chatId, parts.slice(1).join(":"));
          toast = "模式：" + fmt.modeLabel(s.mode);
          break;
        }
        case "l": {
          await api("answerCallbackQuery", { callback_query_id: q.id });
          await send(chatId, await lastResultText(parts.slice(1).join(":")));
          return;
        }
        case "r": {
          var code = parts[1] || "p4";
          var type = code.charAt(0) === "s" ? "speed" : code.charAt(0) === "f" ? "full" : "ping";
          var fam = code.charAt(1) === "b" ? "both" : code.charAt(1);
          await api("answerCallbackQuery", { callback_query_id: q.id, text: "已派發 " + fmt.typeLabel(type) });
          await startJob(chatId, null, type, fam, parts.slice(2).join(":"), s.points, s.mode, s.isps);
          return;
        }
      }
    } catch (e) {
      return api("answerCallbackQuery", { callback_query_id: q.id, text: "錯誤：" + errText(e).slice(0, 150), show_alert: true });
    }
    await api("answerCallbackQuery", toast ? { callback_query_id: q.id, text: toast } : { callback_query_id: q.id });
    if (view) await edit(chatId, msg.message_id, view.text, view.markup);
  }

  async function handleUpdate(u) {
    try {
      if (u.message && typeof u.message.text === "string") await handleMessage(u.message);
      else if (u.callback_query) await handleCallback(u.callback_query);
    } catch (e) {
      console.warn("[cn-speedtest] 處理 Telegram 訊息失敗：" + errText(e));
      try {
        var chat = u.message ? u.message.chat.id : (u.callback_query && u.callback_query.message ? u.callback_query.message.chat.id : null);
        if (chat) await send(chat, "❌ 發生錯誤：" + fmt.esc(errText(e)));
      } catch (e2) { /* ignore */ }
    }
  }

  async function loop() {
    var backoff = 3000;
    while (!stopped) {
      try {
        aborter = typeof AbortController !== "undefined" ? new AbortController() : null;
        var updates = await api("getUpdates", { offset: offset, timeout: 20, allowed_updates: ["message", "callback_query"] }, aborter ? aborter.signal : undefined);
        aborter = null;
        backoff = 3000;
        if (!Array.isArray(updates) || !updates.length) continue;
        for (var i = 0; i < updates.length && !stopped; i++) {
          offset = updates[i].update_id + 1;
          saveState();
          await handleUpdate(updates[i]);
        }
      } catch (e) {
        aborter = null;
        if (stopped) break;
        if (e && e.code === 401) { console.error("[cn-speedtest] Telegram Bot Token 無效，停止輪詢"); break; }
        if (e && e.code === 409) {
          // 有 webhook 或另一個程式在輪詢
          try { await api("deleteWebhook", { drop_pending_updates: false }); } catch (e2) { /* ignore */ }
        }
        console.warn("[cn-speedtest] Telegram 輪詢錯誤：" + errText(e));
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60000);
      }
    }
    running = false;
  }

  async function start() {
    var c = cfg();
    if (!c.tgEnabled || !c.tgToken) return;
    if (running) return;
    running = true;
    stopped = false;
    try {
      me = await api("getMe", {});
      console.info("[cn-speedtest] Telegram 機器人 @" + me.username + " 已啟動");
      await api("setMyCommands", {
        commands: [
          { command: "menu", description: "互動式選單" },
          { command: "speed", description: "泰爾測速：/speed 節點 [v4|v6] [測速點]" },
          { command: "ping", description: "三網延遲：/ping 節點 [v4|v6|雙棧]" },
          { command: "full", description: "延遲 + 測速：/full 節點" },
          { command: "nodes", description: "節點列表" },
          { command: "last", description: "上次結果：/last 節點" },
          { command: "jobs", description: "進行中任務" },
          { command: "id", description: "顯示 chat id" },
          { command: "help", description: "使用說明" }
        ]
      });
    } catch (e) {
      console.error("[cn-speedtest] Telegram 初始化失敗：" + errText(e));
      if (e && e.code === 401) { running = false; return; }
    }
    loopPromise = loop();
  }

  function stop() {
    stopped = true;
    if (aborter) { try { aborter.abort(); } catch (e) { /* ignore */ } }
    saveState();
  }

  async function sendTest(chatId) {
    var target = chatId || cfg().tgNotifyIds[0] || cfg().tgAllowedIds[0];
    if (!target) throw new Error("請先設定允許的 Telegram ID 或通知 ID");
    var info = await api("getMe", {});
    await send(target, "✅ Komari 中國網路測速插件連線成功（@" + fmt.esc(info.username) + "）\n輸入 /menu 開始。");
    return { bot: info.username, chat: target };
  }

  return { start: start, stop: stop, deliverNodeResult: deliverNodeResult, onJobDone: onJobDone, sendTest: sendTest, parseText: parseText, isRunning: function () { return running; } };
}

module.exports = { createBot: createBot, isPointToken: isPointToken };
