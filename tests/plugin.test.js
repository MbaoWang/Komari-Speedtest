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
