"""WOFF 1.0 -> TTF (stdlib only). Provenance of assets/fonts/*.ttf (T0D-15):
Flutter loads TTF/OTF only, so the pinned @fontsource 5.3.0 woff files (OFL-1.1, T0-03 rows) are unwrapped
losslessly (zlib-inflate each table, rebuild the sfnt directory). Usage: python woff2ttf.py in.woff out.ttf
"""
import struct
import sys
import zlib


def convert(src: bytes) -> bytes:
    sig, flavor, _len, n = struct.unpack('>4sIIH', src[:14])
    if sig != b'wOFF':
        raise ValueError('not a WOFF 1.0 file')
    entries = []
    for i in range(n):
        tag, off, clen, olen, csum = struct.unpack('>4sIIII', src[44 + 20 * i:64 + 20 * i])
        data = src[off:off + clen]
        if clen < olen:
            data = zlib.decompress(data)
        if len(data) != olen:
            raise ValueError(f'table {tag!r}: bad length')
        entries.append((tag, csum, data))
    entries.sort(key=lambda e: e[0])
    es = max(k for k in range(16) if 2 ** k <= n)
    sr = 16 * 2 ** es
    out = bytearray(struct.pack('>IHHHH', flavor, n, sr, es, n * 16 - sr))
    off = 12 + 16 * n
    body = bytearray()
    for tag, csum, data in entries:
        out += struct.pack('>4sIII', tag, csum, off + len(body), len(data))
        body += data + b'\0' * (-len(data) % 4)
    return bytes(out + body)


if __name__ == '__main__':
    with open(sys.argv[1], 'rb') as f:
        ttf = convert(f.read())
    with open(sys.argv[2], 'wb') as f:
        f.write(ttf)
