#!/usr/bin/env python3
"""Differential test: run random basic blocks in Unicorn and in the generated JS, compare results."""
import random, struct, json, subprocess, sys
from unicorn import *
from unicorn.x86_const import *
from lift import Lifter, X
N = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
random.seed(int(sys.argv[2]) if len(sys.argv) > 2 else 1)
L = Lifter('/mnt/user-data/uploads/MnMs.exe'); L.discover()
SCR, SCRSZ = 0x2000000, 0x100000
STUB = 0x3000000
scratch = bytes(random.getrandbits(8) for _ in range(0x4000)) * (SCRSZ // 0x4000)
# make scratch floats sane: fill second half with random float32/float64 values
fl = bytearray(scratch)
for o in range(0x80000, 0x100000, 8):
    struct.pack_into('<d', fl, o, random.uniform(-1000, 1000))
for o in range(0x40000, 0x80000, 4):
    struct.pack_into('<f', fl, o, random.uniform(-1000, 1000))
scratch = bytes(fl)
open('scratch.bin', 'wb').write(scratch)
REGS = [UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EDX, UC_X86_REG_EBX, UC_X86_REG_ESP, UC_X86_REG_EBP, UC_X86_REG_ESI, UC_X86_REG_EDI]
SAFE = {'add', 'sub', 'cmp', 'test', 'and', 'or', 'xor', 'inc', 'dec', 'neg', 'adc', 'sbb'}
FLAGGY = SAFE | {'shl', 'shr', 'sar', 'sal', 'imul', 'mul', 'div', 'idiv', 'rol', 'ror', 'rcr', 'rcl', 'shld', 'shrd', 'bt', 'sahf', 'scasb', 'cmpsb', 'repne scasb', 'repe cmpsb', 'popfd'}
# stubs: load 8 doubles / store 8 doubles (tbyte would be better but doubles are what JS has)
load = b''.join(b'\xdd\x05' + struct.pack('<I', SCR + 0xff000 + 8 * (7 - i)) for i in range(8))
store = b''.join(b'\xdd\x1d' + struct.pack('<I', SCR + 0xff100 + 8 * i) for i in range(8))
blocks = [a for a in sorted(L.leaders) if L.in_text(a) and a < 0x450000]
cases = []
mu = Uc(UC_ARCH_X86, UC_MODE_32)
mu.mem_map(L.base, (len(L.image) + 0xfff) & ~0xfff); mu.mem_map(SCR, SCRSZ); mu.mem_map(STUB, 0x1000)
mu.mem_write(STUB, load + b'\x90' * 4); mu.mem_write(STUB + 0x100, store + b'\x90' * 4)
tried = 0
while len(cases) < N and tried < N * 6:
    tried += 1
    a = random.choice(blocks)
    # collect block instructions
    pc, insns = a, []
    while True:
        ins = L.decode(pc)
        if ins is None: break
        insns.append(ins); pc += ins.size
        m = ins.mnemonic
        if m in ('ret', 'jmp', 'call', 'int3', 'hlt', 'jecxz') or m.startswith('j') or m.startswith('loop') or pc in L.leaders: break
    if not insns or len(insns) > 40: continue
    if any(i.mnemonic in ('in', 'out', 'int3', 'hlt', 'pushfd', 'popfd', 'sti', 'cli') or 'fs:' in i.op_str for i in insns): continue
    regs = [(SCR + random.randrange(0x10000, 0xe0000, 4)) for _ in range(8)]
    for k in random.sample(range(8), 3):
        if k not in (4, 5): regs[k] = random.choice([0, 1, 2, 5, 0x7fffffff, 0x80000000, 0xffffffff, random.getrandbits(32), random.getrandbits(8), random.getrandbits(16)])
    mu.mem_write(L.base, L.image); mu.mem_write(SCR, scratch)
    try:
        mu.reg_write(UC_X86_REG_ESP, SCR + 0x8000)
        mu.emu_start(STUB, STUB + len(load))
        for r, v in zip(REGS, regs): mu.reg_write(r, v)
        mu.reg_write(UC_X86_REG_EFLAGS, 0x202 | 0x400 * 0)
        last = insns[-1]
        if len(insns) > 1: mu.emu_start(a, last.address)
        mu.emu_start(last.address, 0xffffffff, count=1) if not last.mnemonic.startswith('rep') else mu.emu_start(last.address, last.address + last.size)
        end = mu.reg_read(UC_X86_REG_EIP)
        out = [mu.reg_read(r) for r in REGS]; efl = mu.reg_read(UC_X86_REG_EFLAGS)
        mu.reg_write(UC_X86_REG_ESP, SCR + 0x8000)
        mu.emu_start(STUB + 0x100, STUB + 0x100 + len(store))
    except UcError as e:
        continue
    memsum = mu.mem_read(SCR, SCRSZ)
    import zlib
    flagm = [i.mnemonic for i in insns if i.mnemonic in FLAGGY or i.mnemonic.replace('rep ', '').replace('repe ', '').replace('repne ', '') in ('scasb', 'cmpsb', 'scasd', 'cmpsd')]
    cmpflags = bool(flagm) and flagm[-1] in SAFE
    cases.append(dict(sw=any(i.mnemonic=='fnstsw' for i in insns), a=a, n=len(insns), regs=regs, out=out, end=end, efl=efl, cmpflags=cmpflags, crc=zlib.crc32(bytes(memsum[:0xff000])),
                      fp=[repr(v) for v in struct.unpack('<8d', bytes(memsum[0xff100:0xff140]))], text=' ; '.join(f'{i.mnemonic} {i.op_str}' for i in insns)))
json.dump(cases, open('cases.json', 'w'))
print(len(cases), 'cases generated')
