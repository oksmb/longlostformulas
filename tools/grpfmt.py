import struct, sys, os
from PIL import Image
from lzss import load_grp
def parse(path, outdir=None):
    d,_,_=load_grp(path)
    magic,z,size,nTex,texOff,nMesh,meshOff,nObj,objOff=struct.unpack('<4s8I',d[:36])
    name=os.path.basename(path)
    print(f"{name}: {magic} size={size} tex={nTex}@{texOff:#x} mesh={nMesh}@{meshOff:#x} obj={nObj}@{objOff:#x}")
    texs=[]
    for i in range(nTex):
        e=d[texOff+i*0x58:texOff+(i+1)*0x58]
        h,nm,tfl,w,ht,fmt,sz=struct.unpack('<I20sI4I',e[:44]); dataoff=struct.unpack('<I',e[0x54:0x58])[0]
        nm=nm.split(b'\0')[0].decode('latin1')
        texs.append((nm,w,ht,fmt,sz,dataoff))
        print(f"   tex {i}: {nm!r} {w}x{ht} fmt={fmt:#x} size={sz} @ {dataoff:#x}  bpp={sz/(w*ht):.2f}")
        if outdir and fmt==0x888:
            Image.frombytes('RGB',(w,ht),d[dataoff:dataoff+w*ht*3]).save(f"{outdir}/{name}_{i}_{nm}.png")
    meshes=[]
    for i in range(nMesh):
        e=d[meshOff+i*0x2c:meshOff+(i+1)*0x2c]
        flags,nF,nV,nFrames,nUV,fOff,uvOff,vOff,bbOff=struct.unpack('<I4H4I',e[:28])
        print(f"   mesh {i}: faces={nF} verts={nV} frames={nFrames} uvs={nUV} f@{fOff:#x} uv@{uvOff:#x} v@{vOff:#x} bb@{bbOff:#x} rest={e[28:].hex()}")
        meshes.append((nF,nV,nFrames,nUV,fOff,uvOff,vOff))
    return d,texs,meshes
def to_obj(d,m,path):
    nF,nV,nFr,nUV,fOff,uvOff,vOff=m
    with open(path,'w') as f:
        for k in range(nV):
            x,y,z=struct.unpack_from('<3f',d,vOff+k*12); f.write(f"v {x} {y} {z}\n")
        for k in range(nUV):
            u,v=struct.unpack_from('<2f',d,uvOff+k*8); f.write(f"vt {u} {1-v}\n")
        for k in range(nF):
            a,b,c,ta,tb,tc,fl,ti=struct.unpack_from('<8H',d,fOff+k*16)
            f.write(f"f {a+1}/{ta+1} {b+1}/{tb+1} {c+1}/{tc+1}\n")
if __name__=='__main__':
    os.makedirs('out',exist_ok=True)
    for p in sys.argv[1:]:
        d,t,m=parse(p,'out')
        for i,mm in enumerate(m): to_obj(d,mm,f"out/{os.path.basename(p)}_{i}.obj")
