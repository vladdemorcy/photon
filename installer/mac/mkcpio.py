#!/usr/bin/env python3
"""Writes a gzipped odc cpio archive the way Apple's pkgbuild does: every path starts with
"./" and is owned by root:admin (0:80). GNU cpio drops the "./", so it isn't used.
usage: mkcpio.py <source dir> <output file>"""
import gzip, os, stat, sys

src, out = sys.argv[1], sys.argv[2]

def entries(root):
    yield '.'
    for d, dirs, files in os.walk(root):
        dirs.sort(); files.sort()
        rel = os.path.relpath(d, root)
        for n in dirs + files:
            yield os.path.join('.', n) if rel == '.' else os.path.join('.', rel, n)

with gzip.open(out, 'wb', compresslevel=9) as z:
    ino = 1
    for rel in entries(src):
        p = os.path.join(src, rel)
        st = os.lstat(p)
        data = b''
        if stat.S_ISLNK(st.st_mode): data = os.readlink(p).encode()
        elif stat.S_ISREG(st.st_mode):
            with open(p, 'rb') as f: data = f.read()
        name = rel.encode() + b'\0'
        hdr = '070707%06o%06o%06o%06o%06o%06o%06o%011o%06o%011o' % (
            0, ino, st.st_mode, 0, 80, 1, 0, int(st.st_mtime), len(name), len(data))
        z.write(hdr.encode() + name + data)
        ino += 1
    tr = b'TRAILER!!!\0'
    z.write(('070707%06o%06o%06o%06o%06o%06o%06o%011o%06o%011o' % (0, 0, 0, 0, 0, 1, 0, 0, len(tr), 0)).encode() + tr)
