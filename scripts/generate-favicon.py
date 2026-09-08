import zlib, struct, math

W = H = 32
CELL = 3

BG        = (0, 0, 0, 0)
WHITE     = (238, 238, 234, 255)
DARK      = (26, 26, 30, 255)
WHITE_SHD = (176, 178, 186, 255)
DARK_SHD  = (16, 16, 20, 255)
POLE      = (158, 160, 168, 255)
POLE_SHD  = (92, 94, 102, 255)
OUTLINE   = (58, 58, 66, 255)

px = [[BG for _ in range(W)] for _ in range(H)]
def put(x, y, c):
    if 0 <= x < W and 0 <= y < H: px[y][x] = c

POLE_X = 6
for y in range(4, 29):
    put(POLE_X, y, POLE); put(POLE_X + 1, y, POLE_SHD)
put(POLE_X, 3, POLE_SHD); put(POLE_X + 1, 3, POLE_SHD)

FLAG_X0, FLAG_X1 = 8, 27
FLAG_Y0, FLAG_H = 6, 14

def wave(x):
    t = (x - FLAG_X0) / (FLAG_X1 - FLAG_X0)
    return int(round(math.sin(t * math.pi * 2.0) * 1.9))

for x in range(FLAG_X0, FLAG_X1 + 1):
    off = wave(x)
    top = FLAG_Y0 + off
    bot = top + FLAG_H
    for y in range(top, bot):
        cx = (x - FLAG_X0) // CELL
        cy = (y - top) // CELL
        light = (cx + cy) % 2 == 0
        shaded = off > 0
        put(x, y, (WHITE_SHD if shaded else WHITE) if light else (DARK_SHD if shaded else DARK))
    put(x, top - 1, OUTLINE)
    put(x, bot, OUTLINE)

off = wave(FLAG_X1)
for y in range(FLAG_Y0 + off - 1, FLAG_Y0 + off + FLAG_H + 1):
    put(FLAG_X1 + 1, y, OUTLINE)

def write_png(path, pixels, scale=1):
    w, h = len(pixels[0]) * scale, len(pixels) * scale
    raw = b''
    for row in pixels:
        line = b'\x00'
        for c in row: line += bytes(c) * scale
        raw += line * scale
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    open(path, 'wb').write(png)

write_png('app/icon.png', px)
write_png('app/apple-icon.png', px, scale=6)
