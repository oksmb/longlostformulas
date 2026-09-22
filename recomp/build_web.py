import base64, json
import os; R=os.path.dirname(os.path.abspath(__file__))+'/'
import sys
ISO_BUILD = len(sys.argv) > 1 and sys.argv[1] == 'iso'
meta=json.load(open(R+'meta.json')); img=base64.b64encode(open(R+'image.bin','rb').read()).decode()
SHELL=open(R+'shell.html').read()
parts=[SHELL, '<script>/* webaudio-tinysynth 1.1.3, Apache-2.0, g200kg */\n'+open(R+'tinysynth.min.js').read()+'\n</script>\n<script>\n"use strict";\n(function(){\n']
for f in ['runtime.js','host.js','blocks.js','webgl.js','iso.js','filelist.js']:
    parts.append(open(R+f).read().replace("'use strict';",'').replace("if (typeof module !== 'undefined') module.exports = makeGL;",'').replace("if (typeof module !== 'undefined') module.exports = ISO;",'')+'\n')
parts.append('const META='+json.dumps(meta)+';\nconst IMAGE_B64="'+img+'";\nlet PLAT;\n')
parts.append(open(R+'main_web.js').read().replace('window.PLAT = {','PLAT = window.PLAT = {'))
parts.append('\n})();\n</script></body></html>')
out=''.join(parts); open(R+'../dist/lost-formulas-play.html','w').write(out); print(len(out)//1024,'KB')
