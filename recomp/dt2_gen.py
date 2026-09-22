import random, struct, json, sys
from lift import Lifter
N=int(sys.argv[1]); random.seed(int(sys.argv[2]))
L=Lifter('/mnt/user-data/uploads/MnMs.exe'); L.discover()
SCR=0x2000000
blocks=[a for a in sorted(L.leaders) if L.in_text(a) and a<0x450000]
cases=[]
for _ in range(N):
    a=random.choice(blocks)
    regs=[(SCR+random.randrange(0x10000,0xe0000,4)) for _ in range(8)]
    for k in random.sample(range(8),3):
        if k not in (4,5): regs[k]=random.choice([0,1,2,5,0x7fffffff,0x80000000,0xffffffff,random.getrandbits(32),random.getrandbits(8),random.getrandbits(16)])
    cases.append(dict(a=a,regs=regs))
json.dump(cases,open('cases2.json','w'))
