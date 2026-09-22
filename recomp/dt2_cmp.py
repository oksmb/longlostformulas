import json, struct, zlib, math, collections
from unicorn import *
from unicorn.x86_const import *
from lift import Lifter
L=Lifter('/mnt/user-data/uploads/MnMs.exe'); L.leaders=set()
cases=json.load(open('cases2.json')); res=json.load(open('res2.json')); scratch=open('scratch.bin','rb').read()
SCR,SCRSZ,STUB=0x2000000,0x100000,0x3000000
REGS=[UC_X86_REG_EAX,UC_X86_REG_ECX,UC_X86_REG_EDX,UC_X86_REG_EBX,UC_X86_REG_ESP,UC_X86_REG_EBP,UC_X86_REG_ESI,UC_X86_REG_EDI]
load=b''.join(b'\xdd\x05'+struct.pack('<I',SCR+0xff000+8*(7-i)) for i in range(8)); store=b''.join(b'\xdd\x1d'+struct.pack('<I',SCR+0xff100+8*i) for i in range(8))
mu=Uc(UC_ARCH_X86,UC_MODE_32); mu.mem_map(L.base,(len(L.image)+0xfff)&~0xfff); mu.mem_map(SCR,SCRSZ); mu.mem_map(STUB,0x1000)
mu.mem_write(STUB,load+b'\x90'*4); mu.mem_write(STUB+0x100,store+b'\x90'*4)
SAFE={'add','sub','cmp','test','and','or','xor','inc','dec','neg','adc','sbb'}
executed=[]
def hook(uc,addr,size,ud): executed.append(addr)
mu.hook_add(UC_HOOK_CODE,hook,begin=L.ts,end=L.te)
ok=bad=skip=0; shown=0; kinds=collections.Counter()
for c,r in zip(cases,res):
    if r['err'] or r['pc'] is None: skip+=1; continue
    L.lift_block(c['a'])
    if r['pc'] in L.last_visited and r['pc']!=c['a']: skip+=1; continue
    if r['pc']==c['a'] and len(L.last_visited)>1 and False: pass
    mu.mem_write(L.base,L.image); mu.mem_write(SCR,scratch)
    try:
        mu.reg_write(UC_X86_REG_ESP,SCR+0x8000); mu.emu_start(STUB,STUB+len(load))
        for g,v in zip(REGS,c['regs']): mu.reg_write(g,v)
        mu.reg_write(UC_X86_REG_EFLAGS,0x202); executed.clear()
        a=c['a']
        if r['pc']==a: mu.emu_start(a,0xffffffff,count=1); a=mu.reg_read(UC_X86_REG_EIP)
        if a!=r['pc'] or r['pc']!=c['a']: mu.emu_start(a,r['pc'],count=400)
        end=mu.reg_read(UC_X86_REG_EIP); out=[mu.reg_read(g) for g in REGS]; efl=mu.reg_read(UC_X86_REG_EFLAGS)
        mu.reg_write(UC_X86_REG_ESP,SCR+0x8000); mu.emu_start(STUB+0x100,STUB+0x100+len(store))
    except UcError: skip+=1; continue
    mem=mu.mem_read(SCR,SCRSZ); ins=[L.decode(x) for x in executed if L.in_text(x)]; ins=[i for i in ins if i]
    mn=[i.mnemonic for i in ins]
    if any(m in ('in','out','int3','hlt','pushfd','popfd','idiv','div') or m.startswith('rep') for m in mn) or any('fs:' in i.op_str for i in ins) or len(executed)>=399: skip+=1; continue
    probs=[]
    if end!=r['pc']: probs.append('pc')
    sw=any(m=='fnstsw' for m in mn)
    for i,(x,y) in enumerate(zip(r['out'],out)):
        mk=0xffffc7ff if (i==0 and sw) else 0xffffffff
        if (x&mk)!=(y&mk): probs.append('reg%d'%i)
    flaggy=[m for m in mn if m in SAFE or m in ('shl','shr','sar','sal','imul','mul','rol','ror','rcr','rcl','shld','shrd','bt','sahf')]
    if flaggy and flaggy[-1] in SAFE:
        if r['cf']!=bool(efl&1): probs.append('CF')
        if r['zf']!=bool(efl&0x40): probs.append('ZF')
        if r['sf']!=bool(efl&0x80): probs.append('SF')
        if r['of']!=bool(efl&0x800): probs.append('OF')
    fp=struct.unpack('<8d',bytes(mem[0xff100:0xff140]))
    for x,y in zip(r['fp'],fp):
        x=float(x.replace('Infinity','inf'))
        if not (x==y or (math.isnan(x) and math.isnan(y)) or abs(x-y)<=1e-9*max(1,abs(y))): probs.append('fpu'); break
    mem[0xff100:0xff140]=b'\0'*0x40
    if zlib.crc32(bytes(mem[:0xff000]))!=r['crc']: probs.append('mem')
    if probs:
        bad+=1; kinds[probs[0]]+=1
        if shown<8: shown+=1; print(hex(c['a']),probs,' ; '.join(f'{i.mnemonic} {i.op_str}' for i in ins)[:260])
    else: ok+=1
print('ok',ok,'bad',bad,'skipped',skip,dict(kinds))
