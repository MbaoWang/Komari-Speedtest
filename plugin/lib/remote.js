// plugin/lib/remote.js
// 產生透過 Komari Agent（admin:exec）在節點上執行的 shell 指令。
//
//   延遲：參考 TcpQuality，從其 getNodes 服務取得全國三網（IPv4 / IPv6）節點，
//         以 curl 的 time_connect 做 TCP 握手延遲（tcping），計算 平均 / 最小 / 最大 / 抖動 / 丟包。
//   測速：直接執行 MbaoWang/taierspeedtest-mod（泰爾測速 / 全球網測）的 Release 二進位，
//         以 --json 輸出單線程 / 多線程上下行速度與延遲。
//
// Agent 以 `sh -s` 執行指令，因此腳本只使用 POSIX sh 語法。
// 所有插入腳本的值都在這裡做白名單檢查，避免 shell 注入。

"use strict";

var DEFAULT_GETNODES_URL = "https://tcpquality.ibsgss.uk/getNodes";
var DEFAULT_TAIER_URL = "https://github.com/MbaoWang/taierspeedtest-mod/releases/latest/download/taierspeedtest-linux-{arch}";

// 泰爾測速支援的測速點（省 / 直轄市 / 特區，與 taierspeedtest-mod 的 provinceCity 對應）
var PROVINCES = [
  "北京", "天津", "上海", "重庆", "河北", "山西", "内蒙古", "辽宁", "吉林", "黑龙江",
  "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南", "湖北", "湖南", "广东",
  "广西", "海南", "四川", "贵州", "云南", "西藏", "陕西", "甘肃", "青海", "宁夏",
  "新疆", "香港", "澳门", "台湾"
];
var EXTRA_CITIES = ["深圳", "苏州", "宁波", "青岛", "厦门", "东莞", "无锡", "佛山"];

// 常見繁體輸入 → 泰爾測速使用的簡體名稱
var TRAD_TO_SIMP = {
  "慶": "庆", "龍": "龙", "遼": "辽", "蘇": "苏", "廣": "广", "貴": "贵", "雲": "云",
  "陝": "陕", "肅": "肃", "寧": "宁", "東": "东", "門": "门", "灣": "湾", "內": "内",
  "島": "岛", "錫": "锡", "電": "电", "聯": "联", "動": "动", "長": "长", "漢": "汉",
  "瀋": "沈", "鄭": "郑", "濟": "济", "臺": "台", "爾": "尔", "濱": "滨", "與": "与",
  "蒙": "蒙", "莊": "庄", "陽": "阳", "鳥": "乌", "烏": "乌", "魯": "鲁", "齊": "齐",
  "佈": "布", "見": "见", "華": "华", "線": "线"
};

function toSimplified(s) {
  var out = "";
  s = String(s || "");
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    out += TRAD_TO_SIMP[ch] || ch;
  }
  return out;
}

function clampInt(v, min, max, def) {
  var n = Math.floor(Number(v));
  if (!isFinite(n)) return def;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function validateRunId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9-]{4,64}$/.test(id)) throw new Error("Invalid run id");
  return id;
}

function normFamily(v) {
  var s = String(v || "").toLowerCase().replace(/\s+/g, "");
  if (s === "4" || s === "v4" || s === "ipv4") return "4";
  if (s === "6" || s === "v6" || s === "ipv6") return "6";
  return "both";
}

function normMode(v) {
  var s = String(v || "").toLowerCase();
  if (s === "multi" || s === "m" || s === "多" || s === "多線程" || s === "多线程") return "multi";
  if (s === "both" || s === "b" || s === "all" || s === "全部" || s === "單+多" || s === "单+多") return "both";
  return "single";
}

// 將使用者輸入的測速點正規化為 "北京,上海电信" 形式；空字串代表北上廣三網（--bsg）。
function normPoints(v) {
  var s = toSimplified(String(v || "").trim());
  if (!s || s === "北上广" || s === "bsg" || s === "默认" || s === "預設" || s === "预设") return "";
  s = s.replace(/[，、;；\s]+/g, ",").replace(/,+/g, ",").replace(/^,|,$/g, "");
  if (!/^[一-龥A-Za-z,]{1,120}$/.test(s)) throw new Error("測速點格式錯誤：只能包含中文省份 / 城市名稱，以逗號分隔");
  var parts = s.split(",");
  if (parts.length > 12) throw new Error("測速點最多 12 個");
  return parts.join(",");
}

function normProvinceFilter(v) {
  var s = toSimplified(String(v || "").trim());
  if (!s) return "";
  s = s.replace(/[，、;；\s]+/g, ",").replace(/,+/g, ",").replace(/^,|,$/g, "");
  if (!/^[一-龥A-Za-z,]{1,300}$/.test(s)) throw new Error("延遲省份篩選格式錯誤");
  return s;
}

function normUrl(v, def) {
  var s = String(v || "").trim();
  if (!s) return def;
  if (!/^https?:\/\/[A-Za-z0-9._~:\/?#\[\]@!$&()*+,;=%{}-]+$/.test(s) || s.indexOf("'") >= 0) {
    throw new Error("網址格式錯誤：" + s);
  }
  return s;
}

// 自訂延遲目標，每行：協議,省份,運營商,名稱,IP,端口   例如：4,上海,电信,上海电信CN2,1.2.3.4,80
function parseCustomTargets(text) {
  var out = [];
  String(text || "").split(/\r?\n/).forEach(function (line) {
    line = line.trim();
    if (!line || line.charAt(0) === "#") return;
    var p = line.split(/[,，|\t]/).map(function (x) { return x.trim(); });
    if (p.length < 5) return;
    var fam = p[0] === "6" ? "6" : (p[0] === "4" ? "4" : "");
    var ip = p[4];
    var port = clampInt(p[5] || 80, 1, 65535, 80);
    var okIp = fam === "4" ? /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) : /^[0-9a-fA-F:]{2,39}$/.test(ip);
    var safe = function (x, d) { x = String(x || "").replace(/[^一-龥A-Za-z0-9._-]/g, ""); return x || d; };
    if (!fam || !okIp) return;
    out.push({ family: fam, prov: safe(toSimplified(p[1]), "自訂"), isp: safe(toSimplified(p[2]), "-"), host: safe(p[3], ip.replace(/:/g, "_")), ip: ip, port: port });
  });
  return out.slice(0, 200);
}

// 把測速點展開成「地點+運營商」清單（泰爾測速每個點單獨執行一次，方便統計各點的重傳率）
var ISPS = ["电信", "联通", "移动"];
function expandPoints(points) {
  var list = points ? points.split(",") : ["北京", "上海", "广东"];
  var out = [];
  list.forEach(function (p) {
    if (/(电信|联通|移动)$/.test(p)) out.push(p);
    else ISPS.forEach(function (isp) { out.push(p + isp); });
  });
  return out.filter(function (p, i, a) { return a.indexOf(p) === i; }).slice(0, 36);
}

// 估算節點端執行時間（秒），用於 timeout 與插件端等待上限。
function estimateSeconds(opts) {
  var fams = opts.family === "both" ? 2 : 1;
  var t = 30;
  if (opts.ping) t += 90 + Math.ceil((opts.pingCount || 20) * 1.5) * fams;
  if (opts.speed) {
    var points = expandPoints(opts.points || "").length;
    var modes = opts.mode === "both" ? 2 : 1;
    t += 120 + points * (8 + fams * (modes * (2 * (opts.duration || 5) + 6) + 6));
  }
  return Math.min(t, 3600);
}

// 每個延遲目標的探測腳本（由 xargs -P 平行執行）。
// 參考 TcpQuality：以 TCP 握手做探測，
//   - 3 秒內握手失敗 → 丟包
//   - 握手成功但比最小值慢 ≥ 900ms → 第一個 SYN / SYN-ACK 遺失、由核心重送（Linux 初始 RTO 1 秒）→ 也算丟包，另記為握手重傳
//   - 延遲平均 / 最小 / 最大 / 抖動只用沒有重傳的樣本計算
function probeScript(count) {
  return [
    "fam=$1; prov=$2; isp=$3; host=$4; ip=$5; port=$6",
    '[ -n "$ip" ] || exit 0',
    'if [ "$fam" = 6 ]; then u="http://[$ip]:$port/"; else u="http://$ip:$port/"; fi',
    "CNT=" + count + "; i=0; fails=0; out=''",
    'while [ "$i" -lt "$CNT" ]; do',
    '  t=$(curl -"$fam" --noproxy "*" -s -o /dev/null -I --connect-timeout 3 -m 3 -w "%{time_connect}" "$u" 2>/dev/null)',
    '  [ -n "$t" ] || t=0',
    '  out="$out $t"',
    '  case "$t" in 0|0.000000) fails=$((fails+1)) ;; esac',
    "  i=$((i+1))",
    '  if [ "$i" -ge 3 ] && [ "$fails" -ge "$i" ]; then break; fi',
    "  sleep 0.2 2>/dev/null || true",
    "done",
    'echo "$out" | awk -v f="$fam" -v p="$prov" -v s="$isp" -v h="$host" -v n="$CNT" \'{',
    "  mn = -1",
    "  for (i = 1; i <= NF; i++) { v[i] = $i * 1000; if (v[i] > 0 && (mn < 0 || v[i] < mn)) mn = v[i] }",
    "  for (i = 1; i <= NF; i++) { t = v[i]; if (t <= 0) continue; if (t >= mn + 900) { rtx++; continue }",
    "    c++; sum += t; if (c == 1 || t < lo) lo = t; if (t > hi) hi = t; if (c > 1) { d = t - last; if (d < 0) d = -d; jit += d } last = t }",
    "  if (c > 0) printf \"@@LAT|%s|%s|%s|%s|%d|%d|%.1f|%.1f|%.1f|%.1f|%d\\n\", f, p, s, h, n, c, lo, sum / c, hi, (c > 1 ? jit / (c - 1) : 0), rtx",
    "  else printf \"@@LAT|%s|%s|%s|%s|%d|0|||||%d\\n\", f, p, s, h, n, rtx",
    "}'"
  ].join("\n");
}

// 從 ss -tinp 取出泰爾測速程式（comm 會被截成 15 字元 "taierspeedtest-"）每條連線的 TCP_INFO：
//   key family data_segs_out data_segs_in retrans(總數) rcv_ooopack
var SS_AWK = [
  '!/^[ \\t]/ { m = index($0, "\\"taierspeedtes") > 0; if (m) { k = $4 "_" $5; fm = ($5 ~ /^\\[/ && $5 !~ /^\\[::ffff:/) ? 6 : 4 } next }',
  "m { dso = 0; dsi = 0; rt = 0; oo = 0",
  "  for (i = 1; i <= NF; i++) { split($i, a, \":\")",
  "    if (a[1] == \"data_segs_out\") dso = a[2]; else if (a[1] == \"data_segs_in\") dsi = a[2]",
  "    else if (a[1] == \"retrans\") { split(a[2], b, \"/\"); rt = b[2] } else if (a[1] == \"rcv_ooopack\") oo = a[2] }",
  "  print k, fm, dso + 0, dsi + 0, rt + 0, oo + 0; m = 0 }"
].join("\n");

// 每條連線取最大值後依協議加總 → @@RTX|協議|上行資料段|上行重傳段|下行資料段|下行亂序包|連線數
var RTX_AWK = [
  "{ k = $1; f[k] = $2; if ($3 > a[k]) a[k] = $3; if ($4 > b[k]) b[k] = $4; if ($5 > c[k]) c[k] = $5; if ($6 > d[k]) d[k] = $6 }",
  "END { for (k in f) { F = f[k]; DSO[F] += a[k]; DSI[F] += b[k]; RT[F] += c[k]; OO[F] += d[k]; N[F]++ }",
  "  for (F in N) printf \"@@RTX|%s|%d|%d|%d|%d|%d\\n\", F, DSO[F], RT[F], DSI[F], OO[F], N[F] }"
].join("\n");

// opts: { runId, ping, speed, family, points, mode, duration, pingCount, parallel,
//         provinceFilter, getNodesUrl, taierUrl, customTargets }
function buildRemoteCommand(opts) {
  var runId = validateRunId(opts.runId);
  var family = normFamily(opts.family);
  var mode = normMode(opts.mode);
  var points = normPoints(opts.points);
  var duration = clampInt(opts.duration, 5, 13, 5);
  var pingCount = clampInt(opts.pingCount, 3, 50, 20);
  var parallel = clampInt(opts.parallel, 1, 64, 16);
  var provFilter = normProvinceFilter(opts.provinceFilter);
  var getNodesUrl = normUrl(opts.getNodesUrl, DEFAULT_GETNODES_URL);
  var taierUrl = normUrl(opts.taierUrl, DEFAULT_TAIER_URL);
  var custom = parseCustomTargets(opts.customTargets);
  var est = estimateSeconds({ ping: opts.ping, speed: opts.speed, family: family, points: points, mode: mode, duration: duration, pingCount: pingCount });
  var fams = family === "both" ? "4 6" : family;

  var L = [];
  L.push(
    'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
    "export LC_ALL=C TERM=dumb NO_COLOR=1",
    "umask 022",
    'T="${TMPDIR:-/tmp}"',
    'WORK="$T/kcst-' + runId + '"',
    'LOCK="$T/kcst.lock"',
    'mkdir "$WORK" 2>/dev/null || { echo "@@ERR|workdir|無法建立暫存目錄"; exit 1; }',
    'if ! mkdir "$LOCK" 2>/dev/null; then',
    '  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +' + Math.ceil(est / 60 + 10) + ' 2>/dev/null)" ]; then rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null; else echo "@@ERR|busy|此節點已有測速任務在執行，請稍後再試"; rm -rf "$WORK"; exit 75; fi',
    "fi",
    "trap 'rm -rf \"$WORK\"; rmdir \"$LOCK\" 2>/dev/null' EXIT",
    "trap 'exit 130' INT TERM",
    'command -v curl >/dev/null 2>&1 || { echo "@@ERR|nocurl|節點缺少 curl，請先安裝 curl"; exit 2; }',
    'TMO=""; command -v timeout >/dev/null 2>&1 && TMO="timeout"',
    'echo "@@BEGIN|2|$(uname -s)|$(uname -m)"',
    'ip4=$(curl -4 -fsS -m 6 https://4.ipw.cn 2>/dev/null || curl -4 -fsS -m 6 https://api.ipify.org 2>/dev/null); ip4=$(printf "%s" "$ip4" | tr -cd "0-9.")',
    'ip6=$(curl -6 -fsS -m 6 https://6.ipw.cn 2>/dev/null || curl -6 -fsS -m 6 https://api6.ipify.org 2>/dev/null); ip6=$(printf "%s" "$ip6" | tr -cd "0-9a-fA-F:")',
    'echo "@@IP|4|$ip4"',
    'echo "@@IP|6|$ip6"'
  );

  if (opts.ping) {
    L.push(
      "# ---------- 延遲 / 丟包（TCP 握手，參考 TcpQuality 節點） ----------",
      "PAR=" + parallel,
      'GN=' + shQuote(getNodesUrl),
      'case "$GN" in *\\?*) GN="$GN&format=tsv&scope=cdn" ;; *) GN="$GN?format=tsv&scope=cdn" ;; esac',
      ': > "$WORK/nodes.tsv"',
      'curl -fsSL --connect-timeout 6 -m 30 "$GN" -o "$WORK/nodes.tsv" 2>/dev/null || curl -4 -fsSL --connect-timeout 6 -m 30 "$GN" -o "$WORK/nodes.tsv" 2>/dev/null || echo "@@WARN|getnodes|無法取得 TcpQuality 節點清單"'
    );
    if (custom.length) {
      L.push("cat >> \"$WORK/nodes.tsv\" <<'KCST_CUSTOM'");
      custom.forEach(function (c) {
        L.push(["custom", c.family, c.prov, c.isp, c.host, c.ip, String(c.port)].join("\t"));
      });
      L.push("KCST_CUSTOM");
    }
    L.push(
      "awk -F'\\t' -v fams=' " + fams + " ' -v provs=" + shQuote(provFilter) + " '",
      '  function pick(p,  n,i,a){ if(provs=="") return 1; n=split(provs,a,","); for(i=1;i<=n;i++){ if(a[i]!="" && (index(p,a[i]) || index(a[i],p))) return 1 } return 0 }',
      '  ($1=="cdn" || $1=="custom") && index(fams, " " $2 " ") && $6!="" && pick($3) {',
      '    p=$3; s=$4; h=$5; if(p=="")p="-"; if(s=="")s="-"; if(h=="")h=$6; port=$7; if(port=="")port=80;',
      '    gsub(/[|\\t "\\047\\\\]/,"",p); gsub(/[|\\t "\\047\\\\]/,"",s); gsub(/[|\\t "\\047\\\\]/,"",h);',
      '    print $2, p, s, h, $6, port',
      "  }' \"$WORK/nodes.tsv\" > \"$WORK/targets\"",
      'if [ ! -s "$WORK/targets" ]; then echo "@@ERR|nodes|沒有可用的延遲測試節點（getNodes 無回應或篩選條件過嚴）"; else',
      "cat > \"$WORK/probe.sh\" <<'KCST_PROBE'",
      probeScript(pingCount),
      "KCST_PROBE",
      'echo "@@LAT_BEGIN"',
      // xargs -P：工作池，不會因為一個不通的節點拖住整批
      'if echo x | xargs -P 2 -n 1 true >/dev/null 2>&1; then',
      '  xargs -P "$PAR" -L 1 sh "$WORK/probe.sh" < "$WORK/targets"',
      "else",
      "  n=0",
      '  while read -r a1 a2 a3 a4 a5 a6; do sh "$WORK/probe.sh" "$a1" "$a2" "$a3" "$a4" "$a5" "$a6" & n=$((n+1)); if [ "$n" -ge "$PAR" ]; then wait; n=0; fi; done < "$WORK/targets"',
      "  wait",
      "fi",
      'echo "@@LAT_END"',
      "fi"
    );
  }

  if (opts.speed) {
    var list = expandPoints(points);
    var perRun = Math.max(60, (family === "both" ? 2 : 1) * ((mode === "both" ? 2 : 1) * (2 * duration + 6) + 6) + 60);
    var args = "--json --no-image --ip " + family + " --mode " + mode + " --duration " + duration;
    L.push(
      "# ---------- 測速 + 重傳率（泰爾測速 taierspeedtest-mod，每個測速點單獨執行並以 ss 取樣 TCP_INFO） ----------",
      'case "$(uname -m)" in x86_64|amd64) A=amd64 ;; aarch64|arm64) A=arm64 ;; *) A="" ;; esac',
      'if [ "$(uname -s)" != "Linux" ] || [ -z "$A" ]; then echo "@@ERR|arch|泰爾測速只支援 Linux amd64 / arm64（目前：$(uname -s) $(uname -m)）"; else',
      '  BDIR="$T/kcst-bin"; mkdir -p "$BDIR"; BIN="$BDIR/taierspeedtest-$A"',
      '  if [ ! -x "$BIN" ] || [ -n "$(find "$BIN" -mmin +1440 2>/dev/null)" ]; then',
      "    URL=" + shQuote(taierUrl),
      '    URL=$(printf "%s" "$URL" | sed "s/{arch}/$A/g")',
      '    if curl -fsSL --retry 2 --connect-timeout 10 -m 240 -o "$BIN.tmp" "$URL" 2>/dev/null && [ -s "$BIN.tmp" ]; then chmod +x "$BIN.tmp" && mv -f "$BIN.tmp" "$BIN"; else rm -f "$BIN.tmp"; echo "@@WARN|download|下載泰爾測速程式失敗"; fi',
      "  fi",
      '  if [ -x "$BIN" ]; then',
      '    if [ -n "$TMO" ]; then TS="timeout -k 10 ' + perRun + '"; else TS=""; fi',
      '    HAS_SS=0; command -v ss >/dev/null 2>&1 && ss -tin >/dev/null 2>&1 && HAS_SS=1',
      '    [ "$HAS_SS" = 1 ] || echo "@@WARN|noss|節點沒有 ss（iproute2），重傳率改用系統整體計數器估算"',
      "    snmp() { awk '/^Tcp:/ { if (!h) { for (i = 1; i <= NF; i++) n[i] = $i; h = 1 } else { for (i = 1; i <= NF; i++) { if (n[i] == \"OutSegs\") o = $i; if (n[i] == \"RetransSegs\") r = $i } print o \"|\" r; exit } }' /proc/net/snmp 2>/dev/null; }",
      "    cat > \"$WORK/ss.awk\" <<'KCST_SS'",
      SS_AWK,
      "KCST_SS",
      "    cat > \"$WORK/rtx.awk\" <<'KCST_RTX'",
      RTX_AWK,
      "KCST_RTX",
      "    for P in " + list.map(shQuote).join(" ") + "; do",
      '      echo "@@SPEED_BEGIN|$P"',
      '      S0=$(snmp); : > "$WORK/ss.log"',
      '      $TS "$BIN" ' + args + ' --points "$P" </dev/null >"$WORK/sp.out" 2>"$WORK/sp.err" &',
      "      SPID=$!",
      '      if [ "$HAS_SS" = 1 ]; then',
      '        while kill -0 "$SPID" 2>/dev/null; do ss -tinp 2>/dev/null | awk -f "$WORK/ss.awk" >> "$WORK/ss.log"; sleep 0.3 2>/dev/null || sleep 1; done',
      "      fi",
      '      wait "$SPID"; rc=$?',
      "      S1=$(snmp)",
      '      cat "$WORK/sp.out"',
      '      echo "@@SPEED_END|$rc"',
      '      [ -s "$WORK/ss.log" ] && awk -f "$WORK/rtx.awk" "$WORK/ss.log"',
      '      echo "@@RTXS|$S0|$S1"',
      '      if [ "$rc" != 0 ]; then tr "\\r" "\\n" < "$WORK/sp.err" | grep -v "测速进度" | grep -v "^[[:space:]]*$" | tail -n 3 | sed "s/^/@@SPERR|/"; fi',
      "    done",
      '  else echo "@@ERR|download|無法取得泰爾測速程式（可在插件設定填入鏡像網址）"; fi',
      "fi"
    );
  }

  L.push('echo "@@END"', "exit 0");
  return L.join("\n");
}

module.exports = {
  DEFAULT_GETNODES_URL: DEFAULT_GETNODES_URL,
  DEFAULT_TAIER_URL: DEFAULT_TAIER_URL,
  PROVINCES: PROVINCES,
  EXTRA_CITIES: EXTRA_CITIES,
  toSimplified: toSimplified,
  normFamily: normFamily,
  normMode: normMode,
  normPoints: normPoints,
  parseCustomTargets: parseCustomTargets,
  estimateSeconds: estimateSeconds,
  expandPoints: expandPoints,
  buildRemoteCommand: buildRemoteCommand,
  clampInt: clampInt
};
