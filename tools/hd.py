import sys
def hd(path, off=0, n=256):
    d=open(path,'rb').read()[off:off+n]
    for i in range(0,len(d),16):
        c=d[i:i+16]
        print(f"{off+i:08x}  {' '.join(f'{b:02x}' for b in c):<48}  {''.join(chr(b) if 32<=b<127 else '.' for b in c)}")
if __name__=='__main__':
    hd(sys.argv[1], int(sys.argv[2],0) if len(sys.argv)>2 else 0, int(sys.argv[3],0) if len(sys.argv)>3 else 256)
