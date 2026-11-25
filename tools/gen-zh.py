#!/usr/bin/env python3
"""產生繁體 → 簡體轉換表 plugin/lib/zh.js（並複製到 pages/ 與 public/ 供網頁使用）。

插件的介面文字以繁體撰寫；顯示語言為簡體時，執行期用這份表轉換：
  1. 詞彙（台灣用語 → 大陸用語，例如 網路→网络、設定→设置、預設→默认），最長優先比對
  2. 其餘逐字轉換
只收錄插件原始碼中實際出現的字詞，表格很小。改了介面文字後請重新執行本工具。

需要：opencc-python-reimplemented（pip install opencc-python-reimplemented）
"""
import json, os, re, sys

try:
    from opencc import OpenCC
except ImportError:
    sys.exit("請先安裝 opencc-python-reimplemented")

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
PLUGIN = os.path.join(ROOT, "plugin")
SKIP = {"font-data.js", "zh.js"}
HAN = re.compile(r"[㐀-鿿豈-﫿]+")
# OpenCC 的結果中少數不符合一般用語的，手動修正
FIX = {"缺省": "默认"}
# 這些詞改用逐字轉換（OpenCC 的大陸用語在這裡不合語境，例如 離線→脱机、啟用→激活）
DROP = {"啟用", "離線", "文字", "正規化", "核心", "執行", "位元", "字元", "字串", "陣列", "存檔", "呼叫", "點選"}
# 轉換結果與逐字相同、但要當成一個詞先比對，避免和相鄰字誤組成別的詞（例如「節點選單」不能被拆成 節｜點選｜單）
PROTECT = {"節點"}

corpus = []
for base, _, files in os.walk(PLUGIN):
    for f in files:
        if f in SKIP or not f.endswith((".js", ".html")):
            continue
        corpus += HAN.findall(open(os.path.join(base, f), encoding="utf-8").read())
text = "\n".join(corpus)

t2s = OpenCC("t2s")
tw2sp = OpenCC("tw2sp")

def fix(s):
    for a, b in FIX.items():
        s = s.replace(a, b)
    return s

chars = {}
for c in sorted(set("".join(corpus))):
    s = t2s.convert(c)
    if s != c:
        chars[c] = s

def char_conv(s):
    return "".join(chars.get(c, c) for c in s)

# 詞彙：OpenCC 詞典中出現在原始碼裡、且整詞轉換結果與逐字轉換不同的
dict_dir = os.path.join(os.path.dirname(sys.modules["opencc"].__file__), "dictionary")
words = {}
for fname in ("TWPhrasesRev.txt", "TWVariantsRevPhrases.txt", "TSPhrases.txt"):
    for line in open(os.path.join(dict_dir, fname), encoding="utf-8"):
        key = line.split("\t", 1)[0].strip()
        if len(key) < 2 or key not in text or key in DROP:
            continue
        val = fix(tw2sp.convert(key))
        if val != char_conv(key):
            words[key] = val
for w in PROTECT:
    words.setdefault(w, char_conv(w))

# 驗證：用與執行期相同的演算法轉換原始碼中的每一段文字，和 OpenCC 正確斷詞的結果比較
maxw = max([len(w) for w in words] + [0])
def runtime(run):
    out, i = "", 0
    while i < len(run):
        hit = None
        for n in range(min(maxw, len(run) - i), 1, -1):
            if run[i:i + n] in words:
                hit = run[i:i + n]; break
        if hit:
            out += words[hit]; i += len(hit)
        else:
            out += chars.get(run[i], run[i]); i += 1
    return out
bad = []
for run in sorted(set(corpus)):
    a, b = runtime(run), fix(tw2sp.convert(run))
    for d in DROP:  # DROP 的詞本來就刻意逐字轉換
        b = b.replace(fix(tw2sp.convert(d)), char_conv(d))
    if a != b:
        bad.append("%s：%s ≠ %s" % (run, a, b))
if bad:
    print("與 OpenCC 斷詞結果不同（請檢查）：\n  " + "\n  ".join(bad[:40]))

out = {"chars": chars, "words": words}
js = """// 自動產生（tools/gen-zh.py），請勿手動修改。繁體 → 簡體轉換（OpenCC 詞典，Apache-2.0）。
(function (root) {
  "use strict";
  var DATA = %s;
  var WORDS = Object.keys(DATA.words).sort(function (a, b) { return b.length - a.length; });
  var MAXW = WORDS.length ? WORDS[0].length : 0;

  function convRun(run) {
    var out = "";
    var i = 0;
    while (i < run.length) {
      var hit = null;
      for (var n = Math.min(MAXW, run.length - i); n >= 2 && !hit; n--) {
        var w = run.substr(i, n);
        if (DATA.words[w] !== undefined) hit = w;
      }
      if (hit) { out += DATA.words[hit]; i += hit.length; continue; }
      var c = run.charAt(i);
      out += DATA.chars[c] || c;
      i++;
    }
    return out;
  }

  // 繁體 → 簡體
  function toCN(s) {
    if (s === null || s === undefined) return s;
    return String(s).replace(/[\\u3400-\\u9fff\\uf900-\\ufaff]+/g, convRun);
  }

  // 語言代碼 → "zh_CN" / "zh_TW" / null
  function normLang(code) {
    var c = String(code || "").toLowerCase().replace(/_/g, "-");
    if (!c) return null;
    if (/^zh-(cn|sg|my|hans)/.test(c) || c === "zh") return "zh_CN";
    if (/^zh-(tw|hk|mo|hant)/.test(c)) return "zh_TW";
    return null;
  }

  var api = { toCN: toCN, normLang: normLang };
  if (typeof module === "object" && module && module.exports) { module.exports = api; return; }
  root.KCST_ZH = api;
  if (typeof document === "undefined") return;

  // ---- 網頁：依 Komari 介面語言（cookie language）自動轉成簡體 ----
  function detect() {
    var c = (document.cookie.match(/(?:^|;\\s*)language=([^;]+)/) || [])[1];
    if (c) { try { c = decodeURIComponent(c); } catch (e) { /* ignore */ } }
    var tries = [c];
    try { tries.push(localStorage.getItem("language"), localStorage.getItem("i18nextLng")); } catch (e) { /* ignore */ }
    try { if (window.parent && window.parent !== window) tries.push(window.parent.document.documentElement.lang); } catch (e) { /* ignore */ }
    tries.push(navigator.language);
    for (var i = 0; i < tries.length; i++) { var l = normLang(tries[i]); if (l) return l; if (tries[i] && /^en/i.test(tries[i])) return "zh_TW"; }
    return "zh_TW";
  }
  var lang = detect();
  root.KCST_LANG = lang;
  root.KCST_T = function (s) { return lang === "zh_CN" ? toCN(s) : s; };
  if (lang !== "zh_CN") return;
  document.documentElement.lang = "zh-CN";
  var ATTRS = ["title", "placeholder", "aria-label", "alt"];
  function convAttrs(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      if (!el.hasAttribute(ATTRS[i])) continue;
      var v = el.getAttribute(ATTRS[i]), n = toCN(v);
      if (n !== v) el.setAttribute(ATTRS[i], n);
    }
  }
  function conv(node) {
    if (node.nodeType === 3) { var v = node.nodeValue, n = toCN(v); if (n !== v) node.nodeValue = n; return; }
    if (node.nodeType !== 1 || /^(SCRIPT|STYLE)$/.test(node.tagName)) return;
    convAttrs(node);
    if (/^(TEXTAREA|INPUT)$/.test(node.tagName)) return;
    for (var c = node.firstChild; c; c = c.nextSibling) conv(c);
  }
  function start() {
    document.title = toCN(document.title);
    conv(document.body);
    new MutationObserver(function (ms) {
      ms.forEach(function (m) {
        if (m.type === "characterData") conv(m.target);
        else if (m.type === "attributes") convAttrs(m.target);
        else for (var i = 0; i < m.addedNodes.length; i++) conv(m.addedNodes[i]);
      });
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    var oc = window.confirm, oa = window.alert;
    window.confirm = function (m) { return oc.call(window, toCN(m)); };
    window.alert = function (m) { return oa.call(window, toCN(m)); };
  }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})(typeof globalThis !== "undefined" ? globalThis : this);
""" % json.dumps(out, ensure_ascii=False, sort_keys=True)

for rel in ("lib/zh.js", "pages/zh.js", "public/zh.js"):
    open(os.path.join(PLUGIN, rel), "w", encoding="utf-8").write(js)
print("chars:", len(chars), "words:", len(words), "bytes:", len(js.encode()))
print("詞彙：", "、".join("%s→%s" % (k, v) for k, v in sorted(words.items())))
