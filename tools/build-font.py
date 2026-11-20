#!/usr/bin/env python3
"""產生 plugin/lib/font-data.js：Noto Sans CJK TC 的 2-bit 灰階點陣字型（供插件在純 JS 環境繪製 PNG）。

字元集：ASCII、GB2312（簡體 6763 字）、Big5 常用字（繁體 5401 字）與表格會用到的符號。
需要：Pillow、fonts-noto-cjk（/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc）。
字型授權：SIL Open Font License 1.1（見 plugin/lib/FONT-LICENSE.txt）。
"""
import base64, json, os, sys
from PIL import Image, ImageDraw, ImageFont

FONT = os.environ.get("FONT", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")
INDEX = 3          # Noto Sans CJK TC
SIZE = 17          # 字級（px）
H = 24             # 字格高度
OUT = os.path.join(os.path.dirname(__file__), "..", "plugin", "lib", "font-data.js")

chars = set(chr(c) for c in range(32, 127))
for hi in range(0xB0, 0xF8):            # GB2312 漢字區
    for lo in range(0xA1, 0xFF):
        try: chars.add(bytes([hi, lo]).decode("gb2312"))
        except UnicodeDecodeError: pass
for hi in range(0xA4, 0xC7):            # Big5 常用字
    for lo in list(range(0x40, 0x7F)) + list(range(0xA1, 0xFF)):
        try: chars.add(bytes([hi, lo]).decode("big5"))
        except UnicodeDecodeError: pass
chars.update("\u3000※×↓↑→←·•｜：，。、（）％—…≈✓✗№℃°±≤≥「」『』【】《》〈〉！？；～＋－／＝＜＞")
chars = sorted(c for c in chars if c.isprintable() or c == "\u3000")

font = ImageFont.truetype(FONT, SIZE, index=INDEX)
ascent, descent = font.getmetrics()
base_y = (H - (ascent + descent)) // 2

widths = bytearray()
data = bytearray()
kept = []
for ch in chars:
    adv = int(round(font.getlength(ch)))
    if adv <= 0 or adv > 40:
        continue
    img = Image.new("L", (adv, H), 0)
    ImageDraw.Draw(img).text((0, base_y), ch, font=font, fill=255)
    px = img.load()
    bits = 0; n = 0; buf = bytearray()
    for y in range(H):
        for x in range(adv):
            q = min(3, (px[x, y] + 42) // 85)   # 0..3
            bits = (bits << 2) | q; n += 1
            if n == 4:
                buf.append(bits); bits = 0; n = 0
    if n:
        buf.append(bits << (2 * (4 - n)))
    kept.append(ch); widths.append(adv); data += buf

js = "// 自動產生（tools/build-font.py），請勿手動修改。Noto Sans CJK TC %dpx，2-bit 灰階，SIL OFL 1.1。\n" % SIZE
js += "module.exports = " + json.dumps({
    "height": H,
    "chars": "".join(kept),
    "widths": base64.b64encode(bytes(widths)).decode(),
    "data": base64.b64encode(bytes(data)).decode(),
}, ensure_ascii=False) + ";\n"
open(OUT, "w", encoding="utf-8").write(js)
print("glyphs:", len(kept), "data bytes:", len(data), "file:", os.path.getsize(OUT))
