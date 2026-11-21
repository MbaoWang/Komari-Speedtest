// plugin/lib/imaging.js
// 產生結果圖：繪製 PNG → 存到 __storageDir__/images → （選用）上傳到圖床取得公開網址。

"use strict";

var fs = require("fs");
var path = require("path");
var render = require("./render.js");

var KEEP_IMAGES = 120;
var HOSTS = {
  catbox: { url: "https://catbox.moe/user/api.php", field: "fileToUpload", extra: { reqtype: "fileupload" } },
  "0x0": { url: "https://0x0.st", field: "file", extra: {} }
};

function errText(e) { return e && e.message ? e.message : String(e); }
function imagesDir() {
  var base = typeof __storageDir__ === "string" && __storageDir__ ? __storageDir__ : ".";
  return path.join(base, "images");
}

function safeName(s) { return String(s || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80); }

function fileFor(jobId, uuid) { return safeName(jobId) + "_" + safeName(String(uuid).slice(0, 8)) + ".png"; }

function prune() {
  try {
    var dir = imagesDir();
    var files = fs.readdirSync(dir).filter(function (f) { return /\.png$/.test(f); });
    if (files.length <= KEEP_IMAGES) return;
    files.map(function (f) { return { f: f, t: fs.statSync(path.join(dir, f)).mtimeMs || 0 }; })
      .sort(function (a, b) { return a.t - b.t; })
      .slice(0, files.length - KEEP_IMAGES)
      .forEach(function (x) { try { fs.unlinkSync(path.join(dir, x.f)); } catch (e) { /* ignore */ } });
  } catch (e) { /* ignore */ }
}

async function uploadTo(host, png) {
  var h = HOSTS[host];
  if (!h) throw new Error("未知的圖床：" + host);
  var form = new FormData();
  for (var k in h.extra) form.append(k, h.extra[k]);
  form.append(h.field, new Blob([png], { type: "image/png" }), "cn-speedtest.png");
  var res = await fetch(h.url, { method: "POST", body: form, headers: { "User-Agent": "komari-cn-speedtest/1.2" } });
  var text = String(await res.text()).trim();
  if (res.status >= 300 || !/^https?:\/\/\S+$/.test(text)) throw new Error(host + " 上傳失敗（HTTP " + res.status + "）：" + text.slice(0, 120));
  return text;
}

function createImaging(getConfig) {
  // 繪圖 + 存檔（+ 上傳）。回傳 { file, url, png } 或 null
  async function produce(job, uuid, name, result) {
    var cfg = getConfig();
    if (!cfg.imageEnabled) return null;
    var png;
    try {
      png = render.renderResult(job, name, result, { showIp: cfg.imageShowFullIp, lang: job.lang });
    } catch (e) {
      console.warn("[cn-speedtest] 產生結果圖失敗：" + errText(e));
      return null;
    }
    var file = fileFor(job.id, uuid);
    try {
      fs.mkdirSync(imagesDir(), { recursive: true });
      fs.writeFileSync(path.join(imagesDir(), file), Buffer.from(png));
      prune();
    } catch (e) {
      console.warn("[cn-speedtest] 儲存結果圖失敗：" + errText(e));
      file = null;
    }
    var url = null;
    if (cfg.imageUpload && cfg.imageUpload !== "none") {
      var order = [cfg.imageUpload].concat(Object.keys(HOSTS).filter(function (h) { return h !== cfg.imageUpload; }));
      for (var i = 0; i < order.length && !url; i++) {
        try { url = await uploadTo(order[i], png); }
        catch (e) { console.warn("[cn-speedtest] " + errText(e)); }
      }
    }
    return { file: file, url: url, png: png };
  }

  function read(file) {
    var f = safeName(String(file || "").replace(/\.png$/, "")) + ".png";
    var p = path.join(imagesDir(), f);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p);
  }

  return { produce: produce, read: read };
}

module.exports = { createImaging: createImaging, fileFor: fileFor };
