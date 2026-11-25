// plugin/lib/png.js
// 極簡 PNG 編碼器（8-bit 索引色），有 Node zlib 時優先使用以縮小圖檔並提速，否則退回純 JavaScript deflate。

"use strict";

var NATIVE_ZLIB = null;
try {
  var z = require("zlib");
  if (z && typeof z.deflateSync === "function") NATIVE_ZLIB = z;
} catch (e) { /* 純 JS 環境無 zlib，使用內建實作 */ }

var CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c;
  }
  return CRC_TABLE;
}
function crc32(bytes) {
  var t = crcTable();
  var c = -1;
  for (var i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function BitWriter(size) {
  this.buf = new Uint8Array(size);
  this.pos = 0;
  this.bit = 0;
  this.cur = 0;
}
BitWriter.prototype.ensure = function () {
  if (this.pos + 8 >= this.buf.length) {
    var n = new Uint8Array(this.buf.length * 2);
    n.set(this.buf);
    this.buf = n;
  }
};
// 依 LSB 先寫入 n 個位元（n <= 16）
BitWriter.prototype.write = function (value, n) {
  this.cur |= value << this.bit;
  this.bit += n;
  if (this.bit >= 8) {
    this.ensure();
    while (this.bit >= 8) {
      this.buf[this.pos++] = this.cur & 255;
      this.cur >>>= 8;
      this.bit -= 8;
    }
  }
};
// 霍夫曼碼需 MSB 先（預先反轉位元後一次寫入）
function revBits(code, n) {
  var r = 0;
  for (var i = 0; i < n; i++) { r = (r << 1) | (code & 1); code >>>= 1; }
  return r;
}

var LIT_CODE = new Uint16Array(288);
var LIT_BITS = new Uint8Array(288);
(function () {
  for (var v = 0; v < 288; v++) {
    if (v < 144) { LIT_CODE[v] = revBits(0x30 + v, 8); LIT_BITS[v] = 8; }
    else if (v < 256) { LIT_CODE[v] = revBits(0x190 + v - 144, 9); LIT_BITS[v] = 9; }
    else if (v < 280) { LIT_CODE[v] = revBits(v - 256, 7); LIT_BITS[v] = 7; }
    else { LIT_CODE[v] = revBits(0xc0 + v - 280, 8); LIT_BITS[v] = 8; }
  }
})();
var DIST_CODE = new Uint8Array(30);
(function () { for (var d = 0; d < 30; d++) DIST_CODE[d] = revBits(d, 5); })();

var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

BitWriter.prototype.finish = function () {
  if (this.bit > 0) { this.ensure(); this.buf[this.pos++] = this.cur & 255; }
  return this.buf.subarray(0, this.pos);
};

function writeLitLen(w, v) { w.write(LIT_CODE[v], LIT_BITS[v]); }
function writeMatch(w, len, dist) {
  var i = LEN_BASE.length - 1;
  while (LEN_BASE[i] > len) i--;
  writeLitLen(w, 257 + i);
  if (LEN_EXTRA[i]) w.write(len - LEN_BASE[i], LEN_EXTRA[i]);
  var d = DIST_BASE.length - 1;
  while (DIST_BASE[d] > dist) d--;
  w.write(DIST_CODE[d], 5);
  if (DIST_EXTRA[d]) w.write(dist - DIST_BASE[d], DIST_EXTRA[d]);
}

function zlibDeflate(data, rowDist) {
  var w = new BitWriter(Math.max(1024, data.length >> 3));
  w.write(0x78, 8); w.write(0x01, 8);
  w.write(1, 1); // BFINAL
  w.write(1, 2); // 固定霍夫曼
  var n = data.length;
  var i = 0;
  var hasRow = rowDist > 1 && rowDist <= 32768;
  var head = new Int32Array(4096);
  head.fill(-1);
  while (i < n) {
    var bestLen = 0, bestDist = 0;
    // 1. 距離 1（同色水平延伸）
    if (i >= 1 && data[i] === data[i - 1]) {
      var l1 = 1;
      var max1 = Math.min(258, n - i);
      while (l1 < max1 && data[i + l1] === data[i + l1 - 1]) l1++;
      if (l1 > bestLen) { bestLen = l1; bestDist = 1; }
    }
    // 2. 距離 = 一列寬（上下列重複）
    if (hasRow && i >= rowDist && bestLen < 258 && data[i] === data[i - rowDist]) {
      var l2 = 1;
      var max2 = Math.min(258, n - i);
      while (l2 < max2 && data[i + l2] === data[i + l2 - rowDist]) l2++;
      if (l2 > bestLen) { bestLen = l2; bestDist = rowDist; }
    }
    // 3. 3-byte hash 匹配（字形與相鄰列重複）
    if (i + 2 < n) {
      var h = ((data[i] << 4) ^ (data[i + 1] << 2) ^ data[i + 2]) & 4095;
      var prev = head[h];
      head[h] = i;
      if (prev >= 0 && bestLen < 258) {
        var hd = i - prev;
        if (hd > 0 && hd <= 32768 && hd !== 1 && hd !== rowDist && data[i] === data[prev] && data[i + 1] === data[prev + 1] && data[i + 2] === data[prev + 2]) {
          var l3 = 3;
          var max3 = Math.min(258, n - i);
          while (l3 < max3 && data[i + l3] === data[prev + l3]) l3++;
          if (l3 > bestLen) { bestLen = l3; bestDist = hd; }
        }
      }
    }
    if (bestLen >= 3) {
      writeMatch(w, bestLen, bestDist);
      i += bestLen;
    } else {
      writeLitLen(w, data[i]);
      i++;
    }
  }
  writeLitLen(w, 256);
  var body = w.finish();
  // Adler-32（每 5552 位元組取一次餘數，避免溢位同時減少模運算）
  var a = 1, b = 0, j = 0;
  while (j < n) {
    var end = Math.min(n, j + 5552);
    for (; j < end; j++) { a += data[j]; b += a; }
    a %= 65521; b %= 65521;
  }
  var out = new Uint8Array(body.length + 4);
  out.set(body);
  var ad = ((b << 16) | a) >>> 0;
  out[body.length] = ad >>> 24; out[body.length + 1] = (ad >>> 16) & 255; out[body.length + 2] = (ad >>> 8) & 255; out[body.length + 3] = ad & 255;
  return out;
}

function chunk(type, data) {
  var out = new Uint8Array(12 + data.length);
  var len = data.length;
  out[0] = len >>> 24; out[1] = (len >>> 16) & 255; out[2] = (len >>> 8) & 255; out[3] = len & 255;
  for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  var c = crc32(out.subarray(4, 8 + len));
  out[8 + len] = c >>> 24; out[9 + len] = (c >>> 16) & 255; out[10 + len] = (c >>> 8) & 255; out[11 + len] = c & 255;
  return out;
}

// pixels: Uint8Array（每像素一個調色盤索引），palette: [[r,g,b], ...]（≤256）
function encodeIndexed(width, height, pixels, palette) {
  var stride = width + 1;
  var raw = new Uint8Array(stride * height); // 每列前置 filter 0
  for (var y = 0; y < height; y++) raw.set(pixels.subarray(y * width, y * width + width), y * stride + 1);
  var ihdr = new Uint8Array(13);
  ihdr[0] = width >>> 24; ihdr[1] = (width >>> 16) & 255; ihdr[2] = (width >>> 8) & 255; ihdr[3] = width & 255;
  ihdr[4] = height >>> 24; ihdr[5] = (height >>> 16) & 255; ihdr[6] = (height >>> 8) & 255; ihdr[7] = height & 255;
  ihdr[8] = 8; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  var plte = new Uint8Array(palette.length * 3);
  palette.forEach(function (c, i) { plte[i * 3] = c[0]; plte[i * 3 + 1] = c[1]; plte[i * 3 + 2] = c[2]; });
  var idat = NATIVE_ZLIB ? new Uint8Array(NATIVE_ZLIB.deflateSync(raw, { level: 6 })) : zlibDeflate(raw, stride);
  var parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("PLTE", plte),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0))
  ];
  var total = 0;
  parts.forEach(function (p) { total += p.length; });
  var png = new Uint8Array(total);
  var off = 0;
  parts.forEach(function (p) { png.set(p, off); off += p.length; });
  return png;
}

module.exports = { encodeIndexed: encodeIndexed, crc32: crc32, zlibDeflate: zlibDeflate };
