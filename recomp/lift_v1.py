#!/usr/bin/env python3
"""Static recompiler: 32-bit x86 PE code -> JavaScript basic-block functions.

Every basic block becomes `function bXXXXXXXX(){ ...; return nextPc; }`.
A trampoline in the runtime calls blocks until pc becomes negative (host call) or a yield is requested.
All CPU state lives in module-level variables, the x86 stack lives in emulated memory, so execution can be
suspended between any two blocks (needed to hand control back to the browser once per frame).
"""
import sys, struct, json, collections
import pefile, capstone
from capstone import x86_const as X

R32 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi']
REGINFO = {}
for i, r in enumerate(R32):
    REGINFO[r] = (r, 32, 0)
for r, full in [('ax', 'eax'), ('cx', 'ecx'), ('dx', 'edx'), ('bx', 'ebx'), ('sp', 'esp'), ('bp', 'ebp'), ('si', 'esi'), ('di', 'edi')]:
    REGINFO[r] = (full, 16, 0)
for r, full in [('al', 'eax'), ('cl', 'ecx'), ('dl', 'edx'), ('bl', 'ebx')]:
    REGINFO[r] = (full, 8, 0)
for r, full in [('ah', 'eax'), ('ch', 'ecx'), ('dh', 'edx'), ('bh', 'ebx')]:
    REGINFO[r] = (full, 8, 8)

CC = {
    'o': 'of', 'no': '!of', 'b': 'cf', 'ae': '!cf', 'e': 'fr===0', 'ne': 'fr!==0', 'be': '(cf||fr===0)', 'a': '!(cf||fr===0)',
    's': 'fr<0', 'ns': 'fr>=0', 'p': 'par(fr)', 'np': '!par(fr)', 'l': '((fr<0)!==of)', 'ge': '((fr<0)===of)',
    'le': '(fr===0||(fr<0)!==of)', 'g': '!(fr===0||(fr<0)!==of)',
}
CCALIAS = {'z': 'e', 'nz': 'ne', 'c': 'b', 'nc': 'ae', 'nae': 'b', 'nb': 'ae', 'na': 'be', 'nbe': 'a', 'pe': 'p', 'po': 'np',
           'nge': 'l', 'nl': 'ge', 'ng': 'le', 'nle': 'g'}


def cc(name):
    name = CCALIAS.get(name, name)
    return CC[name]


class Lifter:
    def __init__(self, path):
        self.pe = pefile.PE(path)
        self.base = self.pe.OPTIONAL_HEADER.ImageBase
        self.image = bytes(self.pe.get_memory_mapped_image())
        t = self.pe.sections[0]
        self.ts = self.base + t.VirtualAddress
        self.te = self.ts + t.Misc_VirtualSize
        self.md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
        self.md.detail = True
        self.insn_cache = {}
        self.unsupported = collections.Counter()

    # ---------- decoding / discovery ----------
    def decode(self, addr):
        if addr in self.insn_cache:
            return self.insn_cache[addr]
        if not (self.ts <= addr < self.te):
            return None
        off = addr - self.base
        ins = next(self.md.disasm(self.image[off:off + 16], addr, 1), None)
        self.insn_cache[addr] = ins
        return ins

    def in_text(self, a):
        return self.ts <= a < self.te

    def discover(self, extra=()):
        leaders = set(extra)
        leaders.add(self.base + self.pe.OPTIONAL_HEADER.AddressOfEntryPoint)
        # any aligned dword in the image that points into .text is a potential code pointer (callbacks, jump tables, vtables)
        img = self.image
        for off in range(0, len(img) - 3, 4):
            v = struct.unpack_from('<I', img, off)[0]
            if self.in_text(v):
                leaders.add(v)
        work = list(leaders)
        seen = set()
        while work:
            a = work.pop()
            if a in seen:
                continue
            seen.add(a)
            pc = a
            while True:
                ins = self.decode(pc)
                if ins is None:
                    break
                nxt = pc + ins.size
                # immediates that look like code pointers
                for op in ins.operands:
                    if op.type == X.X86_OP_IMM and self.in_text(op.imm & 0xffffffff):
                        t = op.imm & 0xffffffff
                        if t not in seen:
                            leaders.add(t); work.append(t)
                    if op.type == X.X86_OP_MEM and op.mem.base == 0 and op.mem.index != 0 and ins.mnemonic == 'jmp':
                        tbl = op.mem.disp & 0xffffffff
                        while self.base <= tbl < self.base + len(img) - 4:
                            v = struct.unpack_from('<I', img, tbl - self.base)[0]
                            if not self.in_text(v):
                                break
                            if v not in seen:
                                leaders.add(v); work.append(v)
                            tbl += 4
                m = ins.mnemonic
                if m in ('ret', 'retf', 'jmp', 'int3', 'hlt') or m.startswith('j') or m in ('call', 'loop', 'loopne', 'loope', 'jecxz'):
                    if m != 'ret' and m != 'jmp' and m != 'int3' and m != 'hlt' and m != 'retf':
                        if nxt not in seen:
                            leaders.add(nxt); work.append(nxt)
                    break
                pc = nxt
        self.leaders = leaders
        return leaders

    # ---------- operand helpers ----------
    def ea(self, ins, op):
        m = op.mem
        parts = []
        if m.base:
            parts.append(ins.reg_name(m.base))
        if m.index:
            idx = ins.reg_name(m.index)
            parts.append(idx if m.scale == 1 else f'{idx}*{m.scale}')
        disp = m.disp
        if disp or not parts:
            parts.append(str(disp & 0xffffffff if not parts else disp))
        e = '+'.join(parts).replace('+-', '-')
        if m.segment == X.X86_REG_FS:
            e = f'FSB+{e}'
        return f'({e})|0' if len(parts) > 1 or m.segment else e

    def rd(self, ins, op, size=None):
        size = size or op.size * 8
        if op.type == X.X86_OP_REG:
            full, sz, sh = REGINFO[ins.reg_name(op.reg)]
            if sz == 32:
                return full
            if sz == 16:
                return f'(({full}<<16)>>16)'
            return f'(({full}<<{24 - sh})>>24)'
        if op.type == X.X86_OP_IMM:
            v = op.imm & ((1 << size) - 1)
            if v >= 1 << (size - 1):
                v -= 1 << size
            return str(v) if v >= 0 else f'({v})'
        a = self.ea(ins, op)
        if size == 32:
            return f'r32({a})'
        if size == 16:
            return f'rs16({a})'
        return f'i8[{a}]'

    def wr(self, ins, op, val, size=None):
        size = size or op.size * 8
        if op.type == X.X86_OP_REG:
            full, sz, sh = REGINFO[ins.reg_name(op.reg)]
            if sz == 32:
                return f'{full}=({val})|0;'
            if sz == 16:
                return f'{full}=({full}&-65536)|(({val})&65535);'
            mask = 0xff << sh
            return f'{full}=({full}&{~mask})|((({val})&255)<<{sh});' if sh else f'{full}=({full}&-256)|(({val})&255);'
        a = self.ea(ins, op)
        if size == 32:
            return f'w32({a},{val});'
        if size == 16:
            return f'w16({a},{val});'
        return f'u8[{a}]={val};'

    @staticmethod
    def sx(expr, size):
        if size == 32:
            return f'({expr})|0'
        return f'(({expr})<<{32 - size})>>{32 - size}'

    # ---------- x87 ----------
    def lift_fpu(self, ins, out):
        b = ins.bytes
        i = 0
        while b[i] in (0x9b, 0x66, 0x67, 0x2e, 0x36, 0x3e, 0x26, 0x64, 0x65):
            i += 1
        opc, modrm = b[i], b[i + 1]
        mod, reg, rm = modrm >> 6, (modrm >> 3) & 7, modrm & 7
        ST = lambda k: f'st[(ftop+{k})&7]' if k else 'st[ftop]'
        arith = ['+', '*', None, None, '-', 'r-', '/', 'r/']

        def ar(dst, a, b_, o):
            if o in ('+', '*', '-', '/'):
                return f'{dst}={a}{o}{b_};'
            return f'{dst}={b_}{o[1]}{a};'

        if mod != 3:
            memop = [o for o in ins.operands if o.type == X.X86_OP_MEM][0]
            a = self.ea(ins, memop)
            if opc in (0xd8, 0xdc, 0xda, 0xde):
                src = {0xd8: f'rf32({a})', 0xdc: f'rf64({a})', 0xda: f'r32({a})', 0xde: f'rs16({a})'}[opc]
                if reg in (2, 3):
                    out.append(f'fcom({ST(0)},{src});' + ('fpop();' if reg == 3 else ''))
                else:
                    out.append(ar(ST(0), ST(0), src, arith[reg]))
                return True
            if opc == 0xd9:
                if reg == 0: out.append(f'fpush(rf32({a}));')
                elif reg == 2: out.append(f'wf32({a},{ST(0)});')
                elif reg == 3: out.append(f'wf32({a},{ST(0)});fpop();')
                elif reg == 5: out.append(f'fcw=r16({a});')
                elif reg == 7: out.append(f'w16({a},fcw);')
                else: return False
                return True
            if opc == 0xdb:
                if reg == 0: out.append(f'fpush(r32({a}));')
                elif reg == 2: out.append(f'w32({a},fround({ST(0)}));')
                elif reg == 3: out.append(f'w32({a},fround({ST(0)}));fpop();')
                elif reg == 5: out.append(f'fpush(rf80({a}));')
                elif reg == 7: out.append(f'wf80({a},{ST(0)});fpop();')
                else: return False
                return True
            if opc == 0xdd:
                if reg == 0: out.append(f'fpush(rf64({a}));')
                elif reg == 2: out.append(f'wf64({a},{ST(0)});')
                elif reg == 3: out.append(f'wf64({a},{ST(0)});fpop();')
                elif reg == 7: out.append(f'w16({a},fsw());')
                else: return False
                return True
            if opc == 0xdf:
                if reg == 0: out.append(f'fpush(rs16({a}));')
                elif reg == 2: out.append(f'w16({a},fround({ST(0)}));')
                elif reg == 3: out.append(f'w16({a},fround({ST(0)}));fpop();')
                elif reg == 5: out.append(f'fpush(ri64({a}));')
                elif reg == 7: out.append(f'wi64({a},fround64({ST(0)}));fpop();')
                else: return False
                return True
            return False
        # register forms
        k = rm
        if opc == 0xd8:
            if reg in (2, 3): out.append(f'fcom({ST(0)},{ST(k)});' + ('fpop();' if reg == 3 else ''))
            else: out.append(ar(ST(0), ST(0), ST(k), arith[reg]))
            return True
        if opc == 0xd9:
            if reg == 0: out.append(f'fpush({ST(k)});')
            elif reg == 1: out.append(f'{{const t={ST(0)};{ST(0)}={ST(k)};{ST(k)}=t;}}')
            elif modrm == 0xd0: pass
            else:
                simple = {0xe0: f'{ST(0)}=-{ST(0)};', 0xe1: f'{ST(0)}=Math.abs({ST(0)});', 0xe4: f'fcom({ST(0)},0);',
                          0xe8: 'fpush(1);', 0xe9: 'fpush(Math.log2(10));', 0xea: 'fpush(Math.LOG2E);', 0xeb: 'fpush(Math.PI);',
                          0xec: 'fpush(Math.log10(2));', 0xed: 'fpush(Math.LN2);', 0xee: 'fpush(0);',
                          0xf0: f'{ST(0)}=Math.expm1({ST(0)}*Math.LN2);',
                          0xf1: f'{ST(1)}={ST(1)}*Math.log2({ST(0)});fpop();',
                          0xf2: f'{ST(0)}=Math.tan({ST(0)});fpush(1);fpsw&=~0x400;',
                          0xf3: f'{ST(1)}=Math.atan2({ST(1)},{ST(0)});fpop();',
                          0xf8: f'{ST(0)}={ST(0)}%{ST(1)};fpsw&=~0x400;', 0xf5: f'{ST(0)}=fprem1({ST(0)},{ST(1)});fpsw&=~0x400;',
                          0xfa: f'{ST(0)}=Math.sqrt({ST(0)});', 0xfb: f'{{const t={ST(0)};{ST(0)}=Math.sin(t);fpush(Math.cos(t));fpsw&=~0x400;}}',
                          0xfc: f'{ST(0)}=frnd({ST(0)});', 0xfd: f'{ST(0)}={ST(0)}*Math.pow(2,Math.trunc({ST(1)}));',
                          0xfe: f'{ST(0)}=Math.sin({ST(0)});fpsw&=~0x400;', 0xff: f'{ST(0)}=Math.cos({ST(0)});fpsw&=~0x400;',
                          0xe5: f'fxam({ST(0)});', 0xf6: 'ftop=(ftop-1)&7;', 0xf7: 'ftop=(ftop+1)&7;',
                          0xf4: f'{{const t={ST(0)},e=t===0?-Infinity:Math.floor(Math.log2(Math.abs(t)));{ST(0)}=e;fpush(t===0?t:t/Math.pow(2,e));}}',
                          0xf9: f'{ST(1)}={ST(1)}*Math.log2({ST(0)}+1);fpop();'}
                if modrm not in simple: return False
                out.append(simple[modrm])
            return True
        if opc == 0xda:
            if modrm == 0xe9: out.append(f'fcom({ST(0)},{ST(1)});fpop();fpop();'); return True
            return False
        if opc == 0xdb:
            if modrm == 0xe2: out.append('fpsw&=0x7f00;'); return True
            if modrm == 0xe3: out.append('fcw=0x37f;fpsw=0;ftop=0;'); return True
            return False
        if opc == 0xdc or opc == 0xde:
            pop = 'fpop();' if opc == 0xde else ''
            if opc == 0xde and modrm == 0xd9: out.append(f'fcom({ST(0)},{ST(1)});fpop();fpop();'); return True
            if reg in (2, 3):
                out.append(f'fcom({ST(0)},{ST(k)});' + ('fpop();' if reg == 3 else '')); return True
            # DC/DE: destination is st(i).  reg 4 = FSUBR: st(i)=st0-st(i); reg 5 = FSUB: st(i)=st(i)-st0; 6 = FDIVR, 7 = FDIV
            o = {0: '+', 1: '*', 4: 'r-', 5: '-', 6: 'r/', 7: '/'}[reg]
            out.append(ar(ST(k), ST(k), ST(0), o) + pop)
            return True
        if opc == 0xdd:
            if reg == 0: pass
            elif reg == 2: out.append(f'{ST(k)}={ST(0)};')
            elif reg == 3: out.append(f'{ST(k)}={ST(0)};fpop();')
            elif reg in (4, 5): out.append(f'fcom({ST(0)},{ST(k)});' + ('fpop();' if reg == 5 else ''))
            else: return False
            return True
        if opc == 0xdf:
            if modrm == 0xe0: out.append('eax=(eax&-65536)|fsw();'); return True
            return False
        return False

    # ---------- integer instructions ----------
    def lift_insn(self, ins, out):
        m = ins.mnemonic
        ops = ins.operands
        if m in ('wait', 'nop', 'fnop'):
            return True
        if 0xd8 <= [x for x in ins.bytes if x not in (0x9b, 0x66, 0x67, 0x2e, 0x36, 0x3e, 0x26, 0x64, 0x65)][0] <= 0xdf:
            return self.lift_fpu(ins, out)
        if m == 'wait' or m == 'nop' or m == 'fnop':
            return True
        rd, wr, sx = self.rd, self.wr, self.sx
        if m == 'mov':
            out.append(wr(ins, ops[0], rd(ins, ops[1], ops[0].size * 8))); return True
        if m == 'lea':
            out.append(wr(ins, ops[0], self.ea(ins, ops[1]))); return True
        if m in ('movzx', 'movsx'):
            ssz = ops[1].size * 8
            v = rd(ins, ops[1])
            if m == 'movzx':
                v = f'{v}&{(1 << ssz) - 1}'
            out.append(wr(ins, ops[0], v)); return True
        if m == 'push':
            sz = ops[0].size * 8
            v = rd(ins, ops[0])
            if sz == 16: return False
            out.append(f'{{const t={v};esp=(esp-4)|0;w32(esp,t);}}'); return True
        if m == 'pop':
            if ops[0].type == X.X86_OP_REG and ins.reg_name(ops[0].reg) == 'esp':
                out.append('esp=r32(esp);'); return True
            out.append(f'{{const t=r32(esp);esp=(esp+4)|0;{wr(ins, ops[0], "t")}}}'); return True
        if m == 'pushal':
            out.append('{const t=esp;for(const v of [eax,ecx,edx,ebx,t,ebp,esi,edi]){esp=(esp-4)|0;w32(esp,v);}}'); return True
        if m == 'popal':
            out.append('edi=r32(esp);esi=r32(esp+4);ebp=r32(esp+8);ebx=r32(esp+16);edx=r32(esp+20);ecx=r32(esp+24);eax=r32(esp+28);esp=(esp+32)|0;'); return True
        if m == 'leave':
            out.append('esp=ebp;ebp=r32(esp);esp=(esp+4)|0;'); return True
        if m in ('add', 'sub', 'cmp', 'adc', 'sbb'):
            sz = ops[0].size * 8
            a, b = rd(ins, ops[0]), rd(ins, ops[1], sz)
            if m in ('adc', 'sbb'):
                opx = '+' if m == 'adc' else '-'
                out.append(f'{{const a={a},b={b},c=cf?1:0,r={sx(f"a{opx}b{opx}c", sz)};')
                if m == 'adc':
                    out.append(f'cf=c?((r>>>0)<=(a>>>0)):((r>>>0)<(a>>>0));of=((a^r)&(b^r))<0;')
                else:
                    out.append(f'cf=c?((a>>>0)<=(b>>>0)):((a>>>0)<(b>>>0));of=((a^b)&(a^r))<0;')
                out.append(f'fr=r;{wr(ins, ops[0], "r")}}}')
                return True
            if m == 'add':
                out.append(f'{{const a={a},b={b},r={sx("a+b", sz)};cf=(r>>>0)<(a>>>0);of=((a^r)&(b^r))<0;fr=r;{wr(ins, ops[0], "r")}}}')
            else:
                w = wr(ins, ops[0], "r") if m == 'sub' else ''
                out.append(f'{{const a={a},b={b},r={sx("a-b", sz)};cf=(a>>>0)<(b>>>0);of=((a^b)&(a^r))<0;fr=r;{w}}}')
            return True
        if m in ('and', 'or', 'xor', 'test'):
            sz = ops[0].size * 8
            o = {'and': '&', 'or': '|', 'xor': '^', 'test': '&'}[m]
            if m == 'xor' and ops[1].type == X.X86_OP_REG and ops[0].type == X.X86_OP_REG and ops[0].reg == ops[1].reg:
                out.append(f'fr=0;cf=false;of=false;{wr(ins, ops[0], "0")}'); return True
            a, b = rd(ins, ops[0]), rd(ins, ops[1], sz)
            w = wr(ins, ops[0], 'fr') if m != 'test' else ''
            out.append(f'fr={a}{o}{b};cf=false;of=false;{w}'); return True
        if m in ('inc', 'dec'):
            sz = ops[0].size * 8
            a = rd(ins, ops[0])
            if m == 'inc':
                out.append(f'{{const a={a},r={sx("a+1", sz)};of=r<a;fr=r;{wr(ins, ops[0], "r")}}}')
            else:
                out.append(f'{{const a={a},r={sx("a-1", sz)};of=r>a;fr=r;{wr(ins, ops[0], "r")}}}')
            return True
        if m == 'neg':
            sz = ops[0].size * 8
            out.append(f'{{const a={rd(ins, ops[0])},r={sx("-a", sz)};cf=a!==0;of=(a&r)<0;fr=r;{wr(ins, ops[0], "r")}}}'); return True
        if m == 'not':
            out.append(wr(ins, ops[0], f'~{rd(ins, ops[0])}')); return True
        if m in ('shl', 'sal', 'shr', 'sar', 'rol', 'ror', 'rcr', 'rcl'):
            sz = ops[0].size * 8
            cnt = rd(ins, ops[1], 8) if len(ops) > 1 else '1'
            mask = (1 << sz) - 1
            a = rd(ins, ops[0])
            body = f'{{const n={cnt}&31;if(n){{const a={a};let r;'
            if m in ('shl', 'sal'):
                body += f'r={sx("a<<n", sz)};cf=((a>>>({sz}-n))&1)!==0;of=((r<0)!==cf);'
            elif m == 'shr':
                body += f'r={sx(f"(a&{mask})>>>n" if sz < 32 else "a>>>n", sz)};cf=((a>>>(n-1))&1)!==0;of=a<0;'
            elif m == 'sar':
                body += f'r=a>>n;cf=((a>>(n-1))&1)!==0;of=false;'
            elif m == 'rol':
                if sz != 32: return False
                body += 'r=(a<<n)|(a>>>(32-n));cf=(r&1)!==0;'
                out.append(body + f'{wr(ins, ops[0], "r")}}}}}'); return True
            elif m == 'ror':
                if sz != 32: return False
                body += 'r=(a>>>n)|(a<<(32-n));cf=r<0;'
                out.append(body + f'{wr(ins, ops[0], "r")}}}}}'); return True
            elif m == 'rcr':
                if sz != 32: return False
                body += 'if(n!==1)trap(0);r=(a>>>1)|(cf?-2147483648:0);cf=(a&1)!==0;'
                out.append(body + f'{wr(ins, ops[0], "r")}}}}}'); return True
            else:
                if sz != 32: return False
                body += 'if(n!==1)trap(0);r=(a<<1)|(cf?1:0);cf=a<0;'
                out.append(body + f'{wr(ins, ops[0], "r")}}}}}'); return True
            out.append(body + f'fr=r;{wr(ins, ops[0], "r")}}}}}'); return True
        if m in ('shld', 'shrd'):
            if ops[0].size != 4: return False
            a, b, cnt = rd(ins, ops[0]), rd(ins, ops[1]), rd(ins, ops[2], 8)
            if m == 'shld':
                out.append(f'{{const n={cnt}&31;if(n){{const a={a},b={b},r=(a<<n)|(b>>>(32-n));cf=((a>>>(32-n))&1)!==0;fr=r;{wr(ins, ops[0], "r")}}}}}')
            else:
                out.append(f'{{const n={cnt}&31;if(n){{const a={a},b={b},r=(a>>>n)|(b<<(32-n));cf=((a>>>(n-1))&1)!==0;fr=r;{wr(ins, ops[0], "r")}}}}}')
            return True
        if m == 'imul':
            if len(ops) == 1:
                sz = ops[0].size * 8
                if sz != 32: return False
                out.append(f'{{const p=BigInt(eax)*BigInt({rd(ins, ops[0])});eax=Number(BigInt.asIntN(32,p));edx=Number(BigInt.asIntN(32,p>>32n));cf=of=(BigInt(eax)!==p);}}'); return True
            if len(ops) == 2:
                a, b = rd(ins, ops[0]), rd(ins, ops[1])
            else:
                a, b = rd(ins, ops[1]), rd(ins, ops[2], ops[0].size * 8)
            sz = ops[0].size * 8
            if sz == 32:
                out.append(f'{{const a={a},b={b},r=Math.imul(a,b);cf=of=(r!==a*b);{wr(ins, ops[0], "r")}}}')
            else:
                out.append(f'{{const p={a}*{b},r={sx("p", sz)};cf=of=(r!==p);{wr(ins, ops[0], "r")}}}')
            return True
        if m == 'mul':
            sz = ops[0].size * 8
            if sz == 32:
                out.append(f'{{const p=BigInt(eax>>>0)*BigInt({rd(ins, ops[0])}>>>0);eax=Number(BigInt.asIntN(32,p));edx=Number(BigInt.asIntN(32,p>>32n));cf=of=edx!==0;}}'); return True
            if sz == 8:
                out.append(f'{{const p=(eax&255)*({rd(ins, ops[0])}&255);eax=(eax&-65536)|p;cf=of=(p>255);}}'); return True
            return False
        if m in ('div', 'idiv'):
            sz = ops[0].size * 8
            if sz != 32: return False
            d = rd(ins, ops[0])
            if m == 'div':
                out.append(f'{{const d=BigInt({d}>>>0),n=(BigInt(edx>>>0)<<32n)|BigInt(eax>>>0);if(d===0n)trap(1);eax=Number(BigInt.asIntN(32,n/d));edx=Number(BigInt.asIntN(32,n%d));}}')
            else:
                out.append(f'{{const d={d};if(d===0)trap(1);if(edx===(eax>>31)){{const n=eax;eax=(n/d)|0;edx=(n%d)|0;}}else{{const D=BigInt(d),n=(BigInt(edx)<<32n)|BigInt(eax>>>0);eax=Number(BigInt.asIntN(32,n/D));edx=Number(BigInt.asIntN(32,n%D));}}}}')
            return True
        if m == 'cdq':
            out.append('edx=eax>>31;'); return True
        if m == 'cwde':
            out.append('eax=(eax<<16)>>16;'); return True
        if m == 'cbw':
            out.append('eax=(eax&-65536)|(((eax<<24)>>24)&65535);'); return True
        if m == 'xchg':
            a, b = rd(ins, ops[0]), rd(ins, ops[1])
            out.append(f'{{const a={a},b={b};{wr(ins, ops[0], "b")}{wr(ins, ops[1], "a")}}}'); return True
        if m.startswith('set'):
            out.append(wr(ins, ops[0], f'({cc(m[3:])})?1:0')); return True
        if m.startswith('cmov'):
            out.append(f'if({cc(m[4:])}){{{wr(ins, ops[0], rd(ins, ops[1]))}}}'); return True
        if m == 'cld': out.append('df=1;'); return True
        if m == 'std': out.append('df=-1;'); return True
        if m == 'clc': out.append('cf=false;'); return True
        if m == 'stc': out.append('cf=true;'); return True
        if m == 'sahf':
            out.append('{const ah=(eax>>8)&255;cf=(ah&1)!==0;fr=(ah&0x40)?0:((ah&0x80)?-1:1);if(((ah&4)!==0)!==par(fr))fr=(ah&0x80)?-2:2;}'); return True
        if m == 'bt':
            if ops[0].type != X.X86_OP_REG: return False
            out.append(f'cf=(({rd(ins, ops[0])}>>>({rd(ins, ops[1], 8)}&31))&1)!==0;'); return True
        # string instructions
        base = m.replace('rep ', '').replace('repe ', '').replace('repne ', '')
        if base in ('movsb', 'movsw', 'movsd', 'stosb', 'stosw', 'stosd', 'scasb', 'cmpsb', 'lodsb', 'lodsd', 'scasd', 'scasw', 'cmpsd'):
            n = {'b': 1, 'w': 2, 'd': 4}[base[-1]]
            kind = base[:-1]
            rep = 'rep' if m.startswith('rep ') else ('repe' if m.startswith('repe ') else ('repne' if m.startswith('repne ') else ''))
            out.append(f'str_{kind}({n},{json.dumps(rep)});'); return True
        return False

    # ---------- blocks ----------
    def lift_block(self, start):
        out = []
        pc = start
        while True:
            ins = self.decode(pc)
            if ins is None:
                out.append(f'return trap2({pc});')
                break
            nxt = pc + ins.size
            m = ins.mnemonic
            ops = ins.operands
            if m == 'call':
                tgt = self.rd(ins, ops[0]) if ops[0].type != X.X86_OP_IMM else str(ops[0].imm & 0xffffffff)
                out.append(f'{{const t={tgt};esp=(esp-4)|0;w32(esp,{nxt});return t;}}')
                break
            if m == 'ret':
                extra = ops[0].imm if ops else 0
                out.append(f'{{const t=r32(esp);esp=(esp+{4 + extra})|0;return t;}}')
                break
            if m == 'jmp':
                tgt = self.rd(ins, ops[0]) if ops[0].type != X.X86_OP_IMM else str(ops[0].imm & 0xffffffff)
                out.append(f'return {tgt};')
                break
            if m == 'jecxz':
                out.append(f'return ecx===0?{ops[0].imm & 0xffffffff}:{nxt};'); break
            if m in ('loop', 'loopne', 'loope'):
                c = {'loop': 'ecx!==0', 'loopne': '(ecx!==0&&fr!==0)', 'loope': '(ecx!==0&&fr===0)'}[m]
                out.append(f'ecx=(ecx-1)|0;return {c}?{ops[0].imm & 0xffffffff}:{nxt};'); break
            if m.startswith('j'):
                out.append(f'return ({cc(m[1:])})?{ops[0].imm & 0xffffffff}:{nxt};')
                break
            ok = False
            try:
                ok = self.lift_insn(ins, out)
            except Exception as e:  # malformed operand combos in junk bytes
                ok = False
            if not ok:
                self.unsupported[m] += 1
                out.append(f'return trap2({pc});')
                break
            pc = nxt
            if pc in self.leaders:
                out.append(f'return {pc};')
                break
        return out

    def emit(self, path):
        blocks = sorted(self.leaders)
        with open(path, 'w') as f:
            f.write('// generated by lift.py - do not edit\n')
            for a in blocks:
                if not self.in_text(a):
                    continue
                body = ''.join(self.lift_block(a))
                f.write(f'function b{a:x}(){{{body}}}\n')
            f.write(f'const TB={self.ts},TE={self.te};\nconst T=new Array(TE-TB).fill(null);\n')
            for a in blocks:
                if self.in_text(a):
                    f.write(f'T[{a - self.ts}]=b{a:x};')
            f.write('\n')
        return len(blocks)


if __name__ == '__main__':
    L = Lifter(sys.argv[1])
    extra = [int(x, 16) for x in open(sys.argv[3]).read().split()] if len(sys.argv) > 3 else []
    L.discover(extra)
    n = L.emit(sys.argv[2])
    print(n, 'blocks;', 'unsupported:', dict(L.unsupported.most_common(25)))
