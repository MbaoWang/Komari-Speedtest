"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const remote = require("../plugin/lib/remote.js");
const parser = require("../plugin/lib/parser.js");
const fmt = require("../plugin/lib/format.js");
const tg = require("../plugin/lib/telegram.js");

const fixture = fs.readFileSync(path.join(__dirname, "fixtures/node-output.txt"), "utf8");

test("parser 解析延遲與泰爾測速", () => {
  const r = parser.parseOutput(fixture, 0);
  assert.ok(r.ok);
  assert.strictEqual(r.latency.length, 20);
  const dead = r.latency.find((x) => x.host === "dead");
  assert.strictEqual(dead.recv, 0);
  assert.strictEqual(dead.loss, 100);
  assert.strictEqual(r.speed.length, 2);
  assert.strictEqual(r.speed[0].prov, "北京");
  assert.strictEqual(r.speed[0].isp, "电信");
  assert.strictEqual(r.speed[0].rtt, 45);
  assert.strictEqual(r.speed[1].family, "6");
  assert.strictEqual(r.exit, "香港 Cogent");
  assert.deepStrictEqual(r.errors, []);
});

test("parser 偵測 Agent 停用遠端執行", () => {
  const r = parser.parseOutput("Remote control is disabled.", -1);
  assert.ok(!r.ok);
  assert.match(r.errors[0], /disable-web-ssh/);
});

test("format 產生 Telegram 表格且不超過長度", () => {
  const r = parser.parseOutput(fixture, 0);
  const html = fmt.nodeResultHTML({ type: "full", family: "both", points: "", mode: "single", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:01:00Z" }, "HK<1>", r, {});
  assert.match(html, /HK&lt;1&gt;/);
  assert.match(html, /電信/);
  assert.match(html, /88\.2/);
  fmt.splitMessage(html + "\n<pre>" + "x".repeat(5000) + "</pre>").forEach((c) => assert.ok(c.length <= 4096));
});

test("測速點正規化與注入防護", () => {
  assert.strictEqual(remote.normPoints(""), "");
  assert.strictEqual(remote.normPoints("北上廣"), "");
  assert.strictEqual(remote.normPoints("上海，廣東電信 湖北"), "上海,广东电信,湖北");
  assert.throws(() => remote.normPoints("上海'; rm -rf /"));
  assert.throws(() => remote.normPoints("$(id)"));
  assert.throws(() => remote.buildRemoteCommand({ runId: "a'b", ping: true }));
  assert.throws(() => remote.buildRemoteCommand({ runId: "abcd-1", ping: true, getNodesUrl: "http://x/'$(id)'" }));
  const custom = remote.parseCustomTargets("4,上海,电信,ok,1.2.3.4,80\n4,x,y,z,1.2.3.4;id,80\n6,北京,联通,v6,2400:da00::6666,443");
  assert.strictEqual(custom.length, 2);
});

test("產生的指令通過 sh 語法檢查", () => {
  for (const type of ["ping", "speed", "full"]) {
    for (const family of ["4", "6", "both"]) {
      const cmd = remote.buildRemoteCommand({ runId: "t-1234", ping: type !== "speed", speed: type !== "ping", family, points: "上海电信", mode: "both", customTargets: "4,a,b,c,1.1.1.1,80" });
      execFileSync("sh", ["-n"], { input: cmd });
    }
  }
});

test("Telegram 文字指令解析", () => {
  const bot = tg.createBot(() => ({ tgAllowedIds: [], defaultPoints: "", defaultMode: "single", tgApiBase: "x", tgToken: "" }), {});
  let p = bot.parseText("測速 HK-1 v6 上海,广东 多");
  assert.deepStrictEqual([p.cmd, p.family, p.points, p.mode, p.nodeTokens], ["speed", "6", "上海,广东", "multi", ["HK-1"]]);
  p = bot.parseText("/ping@MyBot 2 雙棧");
  assert.deepStrictEqual([p.cmd, p.family, p.nodeTokens], ["ping", "both", ["2"]]);
  p = bot.parseText("延遲 3 6");
  assert.deepStrictEqual([p.cmd, p.family, p.nodeTokens], ["ping", "6", ["3"]]);
  p = bot.parseText("speed tokyo 上海电信,北京联通");
  assert.deepStrictEqual([p.cmd, p.points, p.nodeTokens], ["speed", "上海电信,北京联通", ["tokyo"]]);
  p = bot.parseText("全測 all");
  assert.deepStrictEqual([p.cmd, p.nodeTokens], ["full", ["all"]]);
  assert.strictEqual(bot.parseText("你好"), null);
  assert.strictEqual(bot.parseText("/foo").cmd, "unknown");
});

const fixture2 = fs.readFileSync(path.join(__dirname, "fixtures/node-output-v2.txt"), "utf8");

test("v2 輸出：握手丟包與 TCP 重傳率", () => {
  const r = parser.parseOutput(fixture2, 0);
  assert.ok(r.ok);
  const bj = r.latency.find((x) => x.host === "北京电信");
  assert.strictEqual(bj.sent, 20);
  assert.strictEqual(bj.recv, 14);
  assert.strictEqual(bj.synRetrans, 6);
  assert.strictEqual(bj.fail, 0);
  assert.strictEqual(bj.loss, 30);
  const dead = r.latency.find((x) => x.host === "dead");
  assert.strictEqual(dead.loss, 100);
  assert.strictEqual(r.speed.length, 2);
  assert.strictEqual(r.speed[0].rtxSource, "tcp_info");
  assert.strictEqual(r.speed[0].upRetrans, 2.2);
  assert.strictEqual(r.speed[1].upRetrans, 2.03);
  assert.strictEqual(r.speed[0].dnOoo, undefined);
  const html = fmt.nodeResultHTML({ type: "full", family: "4", points: "", mode: "single" }, "n", r, {});
  assert.match(html, /TCP 重傳率/);
  assert.match(html, /握手重傳/);
});

test("沒有 ss 時以 /proc/net/snmp 估算", () => {
  const out = "@@BEGIN|2|Linux|x86_64\n@@SPEED_BEGIN|北京电信\n[{\"region\":\"北京电信\",\"family\":\"IPv4\",\"rtt\":\"9ms\",\"single_down_f\":10,\"single_up_f\":5}]\n@@SPEED_END|0\n@@RTXS|1000|10|11000|60\n@@END";
  const r = parser.parseOutput(out, 0);
  assert.strictEqual(r.speed[0].rtxSource, "snmp");
  assert.strictEqual(r.speed[0].upRetrans, 0.5);
});

test("測速點展開", () => {
  assert.strictEqual(remote.expandPoints("").length, 9);
  assert.deepStrictEqual(remote.expandPoints("上海电信,广东"), ["上海电信", "广东电信", "广东联通", "广东移动"]);
});

test("結果圖：PNG 結構與 deflate 可被 zlib 正確解壓", () => {
  const zlib = require("zlib");
  const render = require("../plugin/lib/render.js");
  const r = parser.parseOutput(fixture2, 0);
  const png = Buffer.from(render.renderResult({ type: "full", family: "4", points: "", mode: "single", finishedAt: new Date().toISOString() }, "HK 香港 🚀", r, {}));
  assert.deepStrictEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.strictEqual(width, 1000);
  let off = 8, idat = [];
  const pngLib = require("../plugin/lib/png.js");
  while (off < png.length) {
    const len = png.readUInt32BE(off), type = png.toString("ascii", off + 4, off + 8);
    assert.strictEqual(png.readUInt32BE(off + 8 + len), pngLib.crc32(png.subarray(off + 4, off + 8 + len)), type + " CRC");
    if (type === "IDAT") idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert.strictEqual(raw.length, (width + 1) * height);
});

test("運營商選擇與測速點展開", () => {
  assert.deepStrictEqual(remote.normIsps("電信, cm"), ["电信", "移动"]);
  assert.deepStrictEqual(remote.normIsps(["电信", "联通", "移动"]), []);
  assert.deepStrictEqual(remote.normIsps("全部"), []);
  assert.deepStrictEqual(remote.expandPoints("上海,广东电信", ["移动"]), ["上海移动", "广东电信"]);
  assert.strictEqual(remote.expandPoints("", ["联通"]).length, 3);
  const cmd = remote.buildRemoteCommand({ runId: "isp-1", ping: true, speed: true, isps: ["联通"], retries: 2 });
  assert.match(cmd, /-v isps='联通'/);
  assert.match(cmd, /RETRIES=2/);
  assert.match(cmd, /for P in '北京联通' '上海联通' '广东联通'/);
});

test("自動重測結果解析", () => {
  const out = [
    "@@BEGIN|2|Linux|x86_64",
    "@@SPEED_BEGIN|广东移动",
    '[{"region":"广东移动","family":"IPv4","rtt":"18ms","single_down_f":80,"single_up_f":0}]',
    "@@SPEED_END|0",
    "@@RETRY|广东移动|1|1",
    "@@SPEED_BEGIN|上海电信",
    '[{"region":"上海电信","family":"IPv4","rtt":"30ms","single_down_f":80,"single_up_f":40}]',
    "@@SPEED_END|0",
    "@@RETRY|上海电信|1|0",
    "@@END"
  ].join("\n");
  const r = parser.parseOutput(out, 0);
  assert.deepStrictEqual(r.retries.map((x) => [x.point, x.retries, x.stillFailed]), [["广东移动", 1, true], ["上海电信", 1, false]]);
  assert.strictEqual(r.speed[0].retries, 1);
  assert.match(fmt.retryNote(r), /廣東移動 ×1（仍有失敗）/);
});

test("單線程 / 多線程分開執行後合併", () => {
  const row = (m, up, dn) => `[{"region":"广东联通","family":"IPv6","rtt":"55ms","single_up_f":${m === "single" ? up : 0},"single_down_f":${m === "single" ? dn : 0},"multi_up_f":${m === "multi" ? up : 0},"multi_down_f":${m === "multi" ? dn : 0}}]`;
  const out = [
    "@@BEGIN|2|Linux|x86_64",
    "@@SPEED_BEGIN|广东联通|single", row("single", 450, 306), "@@SPEED_END|0", "@@RTX|6|10000|50|20000|0|1",
    "@@SPEED_BEGIN|广东联通|multi", row("multi", 0, 532), "@@SPEED_END|0", "@@RTX|6|40000|4000|80000|0|4",
    "@@RETRY|广东联通|2|1|multi",
    "@@END"
  ].join("\n");
  const r = parser.parseOutput(out, 0);
  assert.strictEqual(r.speed.length, 1);
  const s = r.speed[0];
  assert.deepStrictEqual([s.singleUp, s.singleDown, s.multiUp, s.multiDown], [450, 306, 0, 532]);
  assert.strictEqual(s.upRetrans, 0.5); // 取單線程那次
  assert.strictEqual(s.retries, 2);
  assert.match(fmt.retryNote(r), /廣東聯通（多線程） ×2（仍有失敗）/);
  const cmd = remote.buildRemoteCommand({ runId: "split-1", speed: true, mode: "both" });
  assert.match(cmd, /for M in single multi/);
  assert.match(remote.buildRemoteCommand({ runId: "split-2", speed: true, mode: "multi" }), /for M in multi;/);
});

test("繁體 → 簡體轉換與語言判斷", () => {
  const zh = require("../plugin/lib/zh.js");
  assert.strictEqual(zh.toCN("📋 節點選單｜🔄 重新整理"), "📋 节点菜单｜🔄 刷新");
  assert.strictEqual(zh.toCN("預設網路設定，節點離線"), "默认网络设置，节点离线");
  assert.strictEqual(zh.toCN("广东移动 IPv6 123"), "广东移动 IPv6 123");
  assert.strictEqual(zh.normLang("zh-hans"), "zh_CN");
  assert.strictEqual(zh.normLang("zh_CN"), "zh_CN");
  assert.strictEqual(zh.normLang("zh-hant"), "zh_TW");
  assert.strictEqual(zh.normLang("zh-TW"), "zh_TW");
  assert.strictEqual(zh.normLang("en"), null);
});

test("消耗流量解析與顯示", () => {
  const out = [
    "@@BEGIN|2|Linux|x86_64",
    "@@LAT_BEGIN", "@@LAT|4|上海|电信|h|20|20|1|2|3|0.5|0", "@@LAT_END",
    "@@TRAFFIC|latency|1000|2000|1001000|1502000",
    "@@SPEED_BEGIN|广东移动|single",
    '[{"region":"广东移动","family":"IPv4","rtt":"18ms","single_down_f":490,"single_up_f":487}]',
    "@@SPEED_END|0",
    "@@SPEED_BEGIN|广东移动|multi",
    '[{"region":"广东移动","family":"IPv4","rtt":"18ms","multi_down_f":496,"multi_up_f":502}]',
    "@@SPEED_END|0",
    "@@TRAFFIC|point|1001000|1502000|1074742824|538372824|广东移动|single",
    "@@TRAFFIC|point|1074742824|538372824|2148484648|1075243648|广东移动|multi",
    "@@TRAFFIC|total|0|0|2150000000|1076000000",
    "@@END"
  ].join("\n");
  const r = parser.parseOutput(out, 0);
  assert.deepStrictEqual(r.traffic.total, { rx: 2150000000, tx: 1076000000 });
  assert.strictEqual(r.traffic.latency.rx, 1000000);
  assert.strictEqual(r.traffic.speed.rx, 2147483648);
  assert.strictEqual(r.speed[0].trafficRx, 2147483648);
  assert.strictEqual(fmt.fmtBytes(2147483648), "2.00 GB");
  assert.match(fmt.trafficText(r), /共 3\.00 GB（下載 2\.00 GB／上傳 1\.00 GB）/);
  const html = fmt.nodeResultHTML({ type: "full", family: "4", points: "广东", mode: "both" }, "n", r, {});
  assert.match(html, /📦 消耗流量/);
  const png = require("../plugin/lib/render.js").renderResult({ type: "full", family: "4", points: "广东", mode: "both" }, "n", r, {});
  assert.ok(png.length > 1000);
});

test("大包延遲 / 丟包（nping）解析", () => {
  const r = parser.parseOutput(fs.readFileSync(path.join(__dirname, "fixtures/node-output-large.txt"), "utf8"), 0);
  assert.strictEqual(r.latencyLarge.length, 10);
  const sh = r.latencyLarge.find((x) => x.host === "上海电信");
  assert.deepStrictEqual([sh.sent, sh.recv, sh.loss], [5, 2, 60]);
  const small = r.latency.find((x) => x.host === "上海电信");
  assert.strictEqual(small.loss, 0); // 同一目標小包不丟、大包丟
  assert.deepStrictEqual(r.largeSize, { v4: 1400, v6: 1400, wanted: 1400 });
  assert.strictEqual(r.speed[0].rttLarge, 0);
  assert.strictEqual(r.speed[0].lossLarge, 0);
  const html = fmt.nodeResultHTML({ type: "full", family: "4", points: "广东移动", mode: "both" }, "n", r, {});
  assert.match(html, /大包（1400 B）回程延遲/);
  assert.match(html, /大包延遲/);
  const cmd = remote.buildRemoteCommand({ runId: "lg-1", ping: true, speed: true, largeSize: 1400 });
  assert.match(cmd, /nping \$FF --tcp -p "\$port" --flags syn --data-length "\$PL"/);
  assert.match(cmd, /LSIZE4=1400/);
  assert.doesNotMatch(remote.buildRemoteCommand({ runId: "lg-2", ping: true, large: false }), /@@LATL_BEGIN/);
});

test("IPv6 清單：共用節點標記、省份排序、Zstatic 備援", () => {
  const r = parser.parseOutput(fs.readFileSync(path.join(__dirname, "fixtures/node-output-v6-list.txt"), "utf8"), 0);
  assert.strictEqual(r.latency.length, 93);
  assert.strictEqual(r.latency[0].prov, "北京");
  assert.strictEqual(r.latency[r.latency.length - 1].prov, "新疆");
  const ln = r.latency.find((x) => x.prov === "辽宁" && x.isp === "移动");
  assert.strictEqual(ln.sameAs, "河北移动");
  assert.match(fmt.latencyTables(r.latency)[0].note, /遼寧移動＝河北移動/);
  const cmd = remote.buildRemoteCommand({ runId: "zs-1", ping: true, family: "both" });
  assert.match(cmd, /bj:北京/);
  assert.match(cmd, /\$pc-\$ic-v6\.ip\.zstaticcdn\.com/);
  assert.match(cmd, /@@SHARE/);
});

test("遠端腳本優化：PID 鎖自癒、依協議並行抓 IP、逐協議 Zstatic、@@SRVL 修正", () => {
  const cmd4 = remote.buildRemoteCommand({ runId: "opt-v4", ping: true, speed: true, family: "4", provinceFilter: "上海", isps: ["电信"] });
  assert.match(cmd4, /LOCK\/pid/);
  assert.match(cmd4, /kill -0 "\$lp"/);
  assert.match(cmd4, /https:\/\/4\.ipw\.cn/);
  assert.doesNotMatch(cmd4, /https:\/\/6\.ipw\.cn/); // 單 IPv4 不浪費時間抓 IPv6
  assert.match(cmd4, /sh:上海/);
  assert.doesNotMatch(cmd4, /bj:北京/); // Zstatic 備援已先依 provinceFilter 過濾
  assert.match(cmd4, /ct:电信/);
  assert.doesNotMatch(cmd4, /cu:联通/); // Zstatic 備援已先依 isps 過濾
  assert.match(cmd4, /LSIZE6_ORIG=\$LSIZE6/);
  assert.match(cmd4, /ss\.best/);
  assert.match(cmd4, /grep -qx "\$sf" "\$WORK\/large\.skip"/);
  assert.match(cmd4, /::ffff:\*/);
  execFileSync("sh", ["-n"], { input: cmd4 });

  // 驗證 ss.best 權重選點邏輯：控制 API 連線樣本多但資料量少，應選出資料量最大的測速伺服器
  const ssBest = [
    "10.0.0.1:50001_1.1.1.1:443 4 5 5 0 0",
    "10.0.0.1:50001_1.1.1.1:443 4 6 6 0 0",
    "10.0.0.1:50001_1.1.1.1:443 4 7 7 0 0",
    "10.0.0.1:50001_1.1.1.1:443 4 8 8 0 0",
    "10.0.0.1:50002_[::ffff:2.2.2.2]:8080 4 5000 8000 10 0",
    "10.0.0.1:50002_[::ffff:2.2.2.2]:8080 4 9000 12000 12 0"
  ].join("\n") + "\n";
  const picked = execFileSync("sh", ["-c",
    `awk '{ n = split($1, a, "_"); k = $2 " " a[n]; seg = $3 + $4; if (seg > m[$1]) m[$1] = seg; p[$1] = k; cnt[k]++ } END { for (c in m) w[p[c]] += m[c]; for (k in cnt) print w[k] + 0, cnt[k], k }' | sort -k1,1rn -k2,2rn | awk '!seen[$3]++ { print $3, $4 }'`
  ], { input: ssBest, encoding: "utf8" }).trim();
  assert.strictEqual(picked, "4 [::ffff:2.2.2.2]:8080");
});

test("parser：空流量不誤判為 0、雙棧不重複計流量、城市前綴比對", () => {
  const out = [
    "@@BEGIN|2|Linux|x86_64",
    "@@SPEED_BEGIN|深圳电信|single",
    '[{"region":"广东深圳电信","family":"IPv4","rtt":"20ms","single_down_f":300,"single_up_f":100},{"region":"广东深圳电信","family":"IPv6","rtt":"25ms","single_down_f":100,"single_up_f":100}]',
    "@@SPEED_END|0",
    "@@SRVL|4|深圳电信|-|srv|10|10|18.0|19.5|21.0||0",
    "@@TRAFFIC|point|0|0|400000000|200000000|深圳电信|single",
    "@@TRAFFIC|total||||",
    "@@END"
  ].join("\n");
  const r = parser.parseOutput(out, 0);
  assert.strictEqual(r.traffic.total, null); // 空網卡讀數不應誤計為 0 KB
  assert.strictEqual(r.speed.length, 2);
  const v4 = r.speed.find((x) => x.family === "4");
  const v6 = r.speed.find((x) => x.family === "6");
  assert.strictEqual(v4.rttLarge, 19.5); // 深圳电信 對上 广东深圳电信
  assert.strictEqual(v4.trafficRx + v6.trafficRx, 400000000); // 總和不重複計算
  assert.strictEqual(v4.trafficRx, 300000000); // 依速度 3:1 分攤
  assert.strictEqual(v6.trafficRx, 100000000);
  assert.strictEqual(v4.trafficTx, 100000000);
  assert.strictEqual(v6.trafficTx, 100000000);
});

test("format：單節點耗時使用 r.finishedAt 與安全 HTML 截斷", () => {
  const r = parser.parseOutput(fixture, 0);
  r.finishedAt = "2026-01-01T00:01:15Z";
  const html = fmt.nodeResultHTML({ type: "ping", family: "4", startedAt: "2026-01-01T00:00:00Z", finishedAt: null }, "N1", r, {});
  assert.match(html, /耗時 75 秒/);

  const longHtml = "<b>標題</b>\n<pre>" + "A&lt;B🚀".repeat(500) + "</pre>";
  const cut = fmt.truncateHTML(longHtml, 200);
  assert.ok(cut.length <= 200);
  assert.ok(cut.endsWith("…</pre>"));
  assert.doesNotMatch(cut, /&lt(?![;])|<pre[^>]*$/); // 實體與標籤未截斷
});

test("png 純 JS deflate 與 render 優化驗證", () => {
  const zlib = require("zlib");
  const pngLib = require("../plugin/lib/png.js");
  const render = require("../plugin/lib/render.js");
  // 直接驗證純 JS zlibDeflate 輸出可被標準 zlib 完整還原
  const stride = 201;
  const raw = new Uint8Array(stride * 80);
  for (let y = 0; y < 80; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < 200; x++) raw[y * stride + 1 + x] = (x < 50 ? 1 : ((x + y) % 7 === 0 ? 2 : 0));
  }
  const deflated = pngLib.zlibDeflate(raw, stride);
  const inflated = zlib.inflateSync(Buffer.from(deflated));
  assert.deepStrictEqual(new Uint8Array(inflated), raw);

  // 粗體寬度與重複目標擇優、rttLarge 為 null 不報錯
  const cv = new render.Canvas(300, 40, "#ffffff");
  assert.ok(cv.textWidth("測試標題", true) > cv.textWidth("測試標題", false));
  const png = render.renderResult(
    { type: "full", family: "4", points: "北京", mode: "single", finishedAt: "2026-01-01T00:00:00Z" },
    "Node",
    {
      latency: [
        { family: "4", prov: "北京", isp: "电信", host: "a", sent: 10, recv: 10, loss: 0, min: 30, avg: 32, max: 35, jitter: 1 },
        { family: "4", prov: "北京", isp: "电信", host: "b", sent: 10, recv: 0, loss: 100, min: null, avg: null, max: null, jitter: null }
      ],
      speed: [{ family: "4", prov: "北京", isp: "电信", rtt: 30, rttLarge: null, lossLarge: null, singleDown: 100, singleUp: 50, upRetrans: 0.5, rtxSource: "tcp_info" }],
      errors: [], warnings: []
    },
    {}
  );
  assert.ok(png.length > 500);
});

test("Telegram：地名節點指令解析、callback_data <= 64 與 /last 大包顯示", async () => {
  const fakeLatest = {
    ping: {
      at: "2026-01-01T00:00:00Z", family: "4", largeSize: { v4: 1400, v6: 1400, wanted: 1400 },
      latency: [{ family: "4", prov: "上海", isp: "电信", host: "a", sent: 10, recv: 10, loss: 0, min: 20, avg: 22, max: 25, jitter: 1 }],
      latencyLarge: [{ family: "4", prov: "上海", isp: "电信", host: "a", sent: 10, recv: 8, loss: 20, min: 25, avg: 28, max: 32, jitter: 2 }]
    }
  };
  const bot = tg.createBot(
    () => ({ tgAllowedIds: [], defaultPoints: "", defaultMode: "single", defaultFamily: "both", defaultIsps: [], tgApiBase: "x", tgToken: "", tgShowFullIp: false }),
    { latest: (u) => (u === "u1" ? fakeLatest : u === "empty" ? {} : null), nodeName: (u) => u }
  );
  assert.deepStrictEqual(bot.parseText("延遲 香港").nodeTokens, ["香港"]);
  assert.deepStrictEqual(bot.parseText("/last 台灣").nodeTokens, ["台灣"]);
  let p = bot.parseText("測速 香港");
  assert.deepStrictEqual([p.nodeTokens, p.points], [["香港"], null]);
  p = bot.parseText("測速 香港 上海,广东");
  assert.deepStrictEqual([p.nodeTokens, p.points], [["香港"], "上海,广东"]);

  // 超長 UUID 不超過 Telegram 64 bytes 上限
  const longUuid = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const kb = bot.resultMarkup({ id: "ml123456-abcdefgh", type: "speed", family: "both", clients: [longUuid] }, longUuid);
  kb.inline_keyboard[0].forEach((btn) => assert.ok(Buffer.byteLength(btn.callback_data, "utf8") <= 64, btn.callback_data));

  const lastTxt = await bot.lastResultText("u1");
  assert.match(lastTxt, /大包（1400 B）回程延遲/);
  const emptyTxt = await bot.lastResultText("empty");
  assert.match(emptyTxt, /還沒有測試紀錄/);
});

test("jobs + imaging：生命週期、失敗不覆蓋最新圖、prune 保護最新圖", async () => {
  const os = require("os");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kcst-test-"));
  const prevStorage = global.__storageDir__;
  global.__storageDir__ = tmpDir;
  try {
    const jobsLib = require("../plugin/lib/jobs.js");
    const imagingLib = require("../plugin/lib/imaging.js");
    let taskResults = [];
    const execCalls = [];
    const mockServer = {
      async call(method, params) {
        if (method === "admin:listClients") return [{ uuid: "node-1", name: "HK-1", region: "HK", os: "Linux", arch: "amd64", hidden: false, weight: 1 }];
        if (method === "common:getNodesLatestStatus") return { "node-1": { online: true } };
        if (method === "admin:exec") { execCalls.push(params); return { task_id: "t-" + execCalls.length }; }
        if (method === "admin:getTaskById") return { results: taskResults };
        return null;
      }
    };
    const cfg = () => ({ defaultFamily: "4", defaultMode: "single", defaultPoints: "", defaultIsps: [], duration: 5, pingCount: 5, pingParallel: 4, provinceFilter: "", getNodesUrl: "", taierUrl: "", customTargets: "", speedRetries: 0, largeEnabled: false, largeSize: 1400, npingInstall: false, maxConcurrentJobs: 3, historyKeep: 40, imageEnabled: true, imageUpload: "none", imageShowFullIp: false });
    const mgr = jobsLib.createJobManager(mockServer, cfg);
    const img = imagingLib.createImaging(cfg, mgr.latestImageFiles);

    // 1. 成功任務 → 寫入 latest 與圖片
    const job1 = await mgr.run({ clients: ["node-1"], type: "ping", family: "4" });
    taskResults = [{ client: "node-1", finished_at: "2026-01-01T00:00:10Z", exit_code: 0, result: fixture }];
    await mgr.pollOnce();
    assert.strictEqual(job1.status, "done");
    const produced1 = await img.produce(job1, "node-1", "HK-1", job1.results["node-1"]);
    mgr.setImage(job1, "node-1", produced1);
    assert.strictEqual(mgr.latest("node-1").image.file, produced1.file);
    assert.ok(img.exists(produced1.file));

    // 2. 失敗任務 → 不得覆蓋 latest.image
    const job2 = await mgr.run({ clients: ["node-1"], type: "ping", family: "4" });
    taskResults = [{ client: "node-1", finished_at: "2026-01-01T00:01:10Z", exit_code: 1, result: "Remote control is disabled." }];
    await mgr.pollOnce();
    assert.strictEqual(job2.status, "failed");
    const produced2 = await img.produce(job2, "node-1", "HK-1", job2.results["node-1"]);
    mgr.setImage(job2, "node-1", produced2);
    assert.strictEqual(job2.results["node-1"].image.file, produced2.file);
    assert.strictEqual(mgr.latest("node-1").image.file, produced1.file); // 維持有效舊圖

    // 3. prune 保護最新圖不被刪除（即使 mtime 最舊）
    const imgDir = path.join(tmpDir, "images");
    const oldTime = new Date(Date.now() - 100000);
    fs.utimesSync(path.join(imgDir, produced1.file), oldTime, oldTime);
    fs.writeFileSync(path.join(imgDir, "extra_1.png"), Buffer.from([1]));
    fs.writeFileSync(path.join(imgDir, "extra_2.png"), Buffer.from([2]));
    imagingLib.prune(mgr.latestImageFiles(), 2);
    assert.ok(img.exists(produced1.file)); // 被保護

    // 4. 取消與 shutdown flush
    const job3 = await mgr.run({ clients: ["node-1"], type: "ping", family: "4" });
    assert.strictEqual(mgr.cancel(job3.id), true);
    assert.strictEqual(job3.status, "cancelled");
    mgr.shutdown();
    const persisted = JSON.parse(fs.readFileSync(path.join(tmpDir, "state.json"), "utf8"));
    assert.strictEqual(persisted.latest["node-1"].image.file, produced1.file);
  } finally {
    if (prevStorage === undefined) delete global.__storageDir__;
    else global.__storageDir__ = prevStorage;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("script.js：定時排程邊界（peak_start === peak_end、跨午夜）與 queryParam 安全解碼", () => {
  const vm = require("vm");
  const code = fs.readFileSync(path.join(__dirname, "../plugin/script.js"), "utf8") +
    "\n;globalThis.__testExports = { scheduleToCron, queryParam };";
  const sandbox = {
    console, setTimeout, clearTimeout, Date, Math, Array, Object, String, Number, Boolean, RegExp, JSON, Error, Promise, Uint8Array, decodeURIComponent,
    require: (m) => (m === "server" ? { route() {}, registerRPC() {}, cron() {} } : require(path.resolve(__dirname, "../plugin", m)))
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  const { scheduleToCron, queryParam } = sandbox.__testExports;

  // peak_start === peak_end 不得展開成全天
  const eq = scheduleToCron({ schedule: "關閉", peak_enabled: true, peak_start: 20, peak_end: 20, peak_interval: "每30分鐘" });
  assert.deepStrictEqual([...eq.specs], []);

  // 跨午夜晚高峰（22~2）正常展開 4 小時
  const cross = scheduleToCron({ schedule: "關閉", peak_enabled: true, peak_start: 22, peak_end: 2, peak_interval: "每30分鐘" });
  assert.ok(cross.specs.length > 0);
  assert.match(cross.text, /22:00–02:00/);

  // queryParam 遇到無效 % 編碼不拋錯
  assert.strictEqual(queryParam({ url: "/api/plugin/cn-speedtest/image?file=%E0%A4%A" }, "file"), "%E0%A4%A");
  assert.strictEqual(queryParam({ url: "/api/plugin/cn-speedtest/image?file=a%20b.png" }, "file"), "a b.png");
});

