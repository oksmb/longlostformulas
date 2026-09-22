import os, sys, pycdlib
root='/home/claude/re/recomp/gamefs'; iso=pycdlib.PyCdlib(); iso.new(interchange_level=4, joliet=3)
made=set()
for d,_,fs in os.walk(root):
    rel=os.path.relpath(d,root); parts=[] if rel=='.' else rel.split('/')
    for i in range(1,len(parts)+1):
        p='/'+'/'.join(parts[:i])
        if p not in made: iso.add_directory(iso_path=p.upper(), joliet_path=p); made.add(p)
    for f in fs:
        if f.lower().endswith('.exe'): continue
        jp='/'+'/'.join(parts+[f]); iso.add_file(os.path.join(d,f), iso_path=jp.upper()+';1', joliet_path=jp)
iso.write('/tmp/test.iso'); iso.close(); print(os.path.getsize('/tmp/test.iso')//1048576,'MB')
