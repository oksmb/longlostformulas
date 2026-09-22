#!/bin/sh
# Rebuild the hand-off bundle from the working tree.
set -e
B=/home/claude/re/bundle/lost-formulas-web
rm -rf /home/claude/re/bundle; mkdir -p $B/recomp $B/tools/viewer $B/ghidra $B/dist
cp /home/claude/re/HANDOFF.md $B/
cd /home/claude/re/recomp
cp lift.py lift_v1.py runtime.js host.js webgl.js main_web.js main_node.js shell.html build_web.py make_image.py tinysynth.min.js meta.json difftest.py difftest.js dt2_gen.py dt2_run.js dt2_cmp.py webtest2.py webtest_site.py iso.js filelist.js rangeserver.py mkiso.py webtest_iso.py $B/recomp/
sed -i "s#'/mnt/user-data/outputs/lost-formulas-play.html'#R+'../dist/lost-formulas-play.html'#; s#R='/home/claude/re/recomp/'#import os; R=os.path.dirname(os.path.abspath(__file__))+'/'#" $B/recomp/build_web.py
cd /home/claude/re
cp lzss.py grpfmt.py hd.py xref.py package.sh $B/tools/; cp viewer/parser.js viewer/app.js viewer/head.html $B/tools/viewer/
cp gh/scripts/ExportC.java gh/labels.txt gh/funcs.txt gh/mnms.c $B/ghidra/
cp /mnt/user-data/outputs/lost-formulas-play.html /mnt/user-data/outputs/lost-formulas-viewer.html $B/dist/
cat > $B/README.txt <<'EOT'
Start with HANDOFF.md.
Not included on purpose: the game's exe and data files, image.bin and blocks.js (both are generated from your own MnMs.exe;
see HANDOFF.md section 2). dist/lost-formulas-play.html already contains a built copy of everything.
Paths inside some test scripts (/mnt/user-data/uploads, /home/claude/re/recomp) are from the original sandbox; adjust them.
EOT
rm -f /mnt/user-data/outputs/lost-formulas-source-bundle.zip
cd /home/claude/re/bundle && zip -q -r -9 /mnt/user-data/outputs/lost-formulas-source-bundle.zip lost-formulas-web
cp /home/claude/re/HANDOFF.md /mnt/user-data/outputs/HANDOFF.md
