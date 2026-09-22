import struct
def lzss(src, outlen, fill=0):
    N=4096; F=18; TH=2
    buf=bytearray([fill])*N; r=N-F; out=bytearray(); i=0; flags=0
    while len(out)<outlen and i<len(src):
        flags >>= 1
        if not (flags & 0x100):
            flags = src[i] | 0xff00; i+=1
        if flags & 1:
            c=src[i]; i+=1; out.append(c); buf[r]=c; r=(r+1)&(N-1)
        else:
            a=src[i]; b=src[i+1]; i+=2
            pos = a | ((b&0xf0)<<4); ln=(b&0x0f)+TH+1
            for k in range(ln):
                c=buf[(pos+k)&(N-1)]; out.append(c); buf[r]=c; r=(r+1)&(N-1)
    return bytes(out[:outlen]), i
def load_grp(path):
    d=open(path,'rb').read()
    assert d[:4]==b'GRPC', d[:4]
    ul,cl=struct.unpack('<II',d[4:12])
    out,used=lzss(d[12:],ul)
    return out,used,cl
if __name__=='__main__':
    import sys
    from hd import hd
    for p in sys.argv[1:]:
        out,used,cl=load_grp(p)
        print(p, 'unc',len(out),'consumed',used,'of',cl)
        open('/tmp/'+p.split('/')[-1]+'.raw','wb').write(out)
