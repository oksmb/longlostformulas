import pefile, capstone, re, collections, pickle
pe = pefile.PE('/mnt/user-data/uploads/MnMs.exe')
base = pe.OPTIONAL_HEADER.ImageBase
data = pe.get_memory_mapped_image()
text = [s for s in pe.sections if s.Name.startswith(b'.text')][0]
ts, te = base+text.VirtualAddress, base+text.VirtualAddress+text.Misc_VirtualSize
def cstr(va):
    o = va-base
    if o<0 or o>=len(data): return None
    e = data.find(b'\0', o)
    s = data[o:e]
    if 0<len(s)<80 and all(32<=c<127 for c in s): return s.decode()
    return None
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
md.skipdata = True
ins = list(md.disasm(bytes(data[ts-base:te-base]), ts))
print(len(ins), "instructions")
# name -> global: look for push imm(str) ... mov [abs], eax within next 6 ins
name2g = {}
for i, x in enumerate(ins):
    if x.mnemonic=='push' and x.op_str.startswith('0x'):
        s = cstr(int(x.op_str,16))
        if s and re.match(r'^(_?gr[A-Z]|gl[A-Z]|glu[A-Z]|wgl|_Bink|Direct)', s):
            for y in ins[i+1:i+8]:
                m = re.match(r'mov dword ptr \[(0x[0-9a-f]+)\], eax', y.mnemonic+' '+y.op_str)
                if m:
                    name2g[s]=int(m.group(1),16); break
print(len(name2g), "dynamic imports mapped")
g2name = {v:k for k,v in name2g.items()}
cnt = collections.Counter()
for x in ins:
    if x.mnemonic in('call','jmp') and 'dword ptr [0x' in x.op_str:
        m = re.search(r'\[(0x[0-9a-f]+)\]$', x.op_str)
        if m:
            a=int(m.group(1),16)
            if a in g2name: cnt[g2name[a]]+=1
    elif x.mnemonic=='mov' and re.search(r', dword ptr \[0x[0-9a-f]+\]$', x.op_str):
        a=int(re.search(r'\[(0x[0-9a-f]+)\]$', x.op_str).group(1),16)
        if a in g2name: cnt[g2name[a]]+=1
pickle.dump((name2g,cnt),open('xref.pkl','wb'))
for fam,pat in [('GL',r'^gl[A-Z]'),('GLU',r'^glu'),('WGL',r'^wgl'),('Glide',r'^_gr'),('Bink',r'^_Bink'),('DX',r'^Direct')]:
    used = {k:v for k,v in cnt.items() if re.match(pat,k)}
    tot = sum(1 for k in name2g if re.match(pat,k))
    print(f"\n== {fam}: {len(used)} used of {tot} loaded")
    print(', '.join(f"{k}({v})" for k,v in sorted(used.items(), key=lambda kv:-kv[1])))
