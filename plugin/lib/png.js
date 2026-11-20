// plugin/lib/png.js
// 極簡 PNG 編碼器（8-bit 索引色），純 JavaScript，不依賴 zlib。
// 壓縮：deflate 固定霍夫曼 + 只找距離 1 / 距離 = 一列寬 的重複（表格圖片大量單色區塊，壓縮率很好）。

"use strict";

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
// 依 LSB 先寫入 n 個位元
BitWriter.prototype.write = function (value, n) {
  for (var i = 0; i < n; i++) {
    this.cur |= ((value >>> i) & 1) << this.bit;
    if (++this.bit === 8) { this.ensure(); this.buf[this.pos++] = this.cur; this.cur = 0; this.bit = 0; }
  }
};
// 霍夫曼碼需 MSB 先
BitWriter.prototype.writeCode = function (code, n) {
  for (var i = n - 1; i >= 0; i--) {
    this.cur |= ((code >>> i) & 1) << this.bit;
    if (++this.bit === 8) { this.ensure(); this.buf[this.pos++] = this.cur; this.cur = 0; this.bit = 0; }
  }
};
BitWriter.prototype.finish = function () {
  if (this.bit > 0) { this.ensure(); this.buf[this.pos++] = this.cur; }
  return this.buf.subarray(0, this.pos);
};

var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function writeLitLen(w, v) {
  if (v < 144) w.writeCode(0x30 + v, 8);
  else if (v < 256) w.writeCode(0x190 + v - 144, 9);
  else if (v < 280) w.writeCode(v - 256, 7);
  else w.writeCode(0xc0 + v - 280, 8);
}
function writeMatch(w, len, dist) {
  var i = LEN_BASE.length - 1;
  while (LEN_BASE[i] > len) i--;
  writeLitLen(w, 257 + i);
  if (LEN_EXTRA[i]) w.write(len - LEN_BASE[i], LEN_EXTRA[i]);
  var d = DIST_BASE.length - 1;
  while (DIST_BASE[d] > dist) d--;
  w.writeCode(d, 5);
  if (DIST_EXTRA[d]) w.write(dist - DIST_BASE[d], DIST_EXTRA[d]);
}

function zlibDeflate(data, rowDist) {
  var w = new BitWriter(Math.max(1024, data.length >> 3));
  w.write(0x78, 8); w.write(0x01, 8);
  w.write(1, 1); // BFINAL
  w.write(1, 2); // 固定霍夫曼
  var n = data.length;
  var i = 0;
  var dists = rowDist > 1 && rowDist <= 32768 ? [1, rowDist] : [1];
  while (i < n) {
    var bestLen = 0, bestDist = 0;
    for (var k = 0; k < dists.length; k++) {
      var d = dists[k];
      if (i < d) continue;
      var l = 0;
      while (l < 258 && i + l < n && data[i + l] === data[i + l - d]) l++;
      if (l > bestLen) { bestLen = l; bestDist = d; }
    }
    if (bestLen >= 3) { writeMatch(w, bestLen, bestDist); i += bestLen; }
    else { writeLitLen(w, data[i]); i++; }
  }
  writeLitLen(w, 256);
  var body = w.finish();
  var a = 1, b = 0;
  for (var j = 0; j < n; j++) { a = (a + data[j]) % 65521; b = (b + a) % 65521; }
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
  var parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("PLTE", plte),
    chunk("IDAT", zlibDeflate(raw, stride)),
    chunk("IEND", new Uint8Array(0))
  ];
  var total = 0;
  parts.forEach(function (p) { total += p.length; });
  var png = new Uint8Array(total);
  var off = 0;
  parts.forEach(function (p) { png.set(p, off); off += p.length; });
  return png;
}

module.exports = { encodeIndexed: encodeIndexed, crc32: crc32 };
