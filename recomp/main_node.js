// node harness: runs the recompiled game headless with stubbed GL, to bring up the Win32 layer
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, 'gamefs');
const vfs = new Map();
(function walk(dir, rel) { for (const n of fs.readdirSync(dir)) { const p = path.join(dir, n), r = rel + '\\' + n.toUpperCase(); if (fs.statSync(p).isDirectory()) walk(p, r); else vfs.set(r, p); } })(ROOT, '');
const mem2 = new Map(); const glCount = {}; let frames = 0, clock = 1000;
const glStub = { _n: 0, genTexture: () => ++glStub._n, deleteTexture: () => {} };
for (const k of ['glEnable','glDisable','glBlendFunc','glDepthFunc','glDepthMask','glBegin','glEnd','glMatrixMode','glLoadIdentity','glClear','glFlush','glFinish','glViewport','glHint','glBindTexture','glTexParameteri','glTexEnvi','glPixelStorei','glCullFace','glFrontFace','glShadeModel','glPolygonMode','glScissor','glColorMask','glDrawBuffer','glReadBuffer','glTexParameterf','glTexEnvf','glAlphaFunc','glVertex3f','glTexCoord4f','glColor4f','glClearColor','glClearDepth','glDepthRange','glOrtho','glTranslatef','glScalef','glTexImage2D','glTexSubImage2D']) { glCount[k] = 0; glStub[k] = () => { glCount[k]++; }; }
const strip = (n) => n.replace(/^[A-Z]:/, '').replace(/^(?!\\)/, '\\');
const PLAT = {
  trace: !!process.env.TRACE, cdDrive: 'D:', setVolume: (k, v) => console.log('[host] volume ' + k + ' = ' + v.toFixed(2) + ' at frame ' + PLAT.frames), slowArgs: !!process.env.SLOWARGS, noJoy: !!process.env.NOJOY, width: 640, height: 480, modules: (process.env.MODULES || 'opengl32.dll,glu32.dll,dsound.dll').split(','),
  log: (s) => console.log('[host] ' + s), now: () => clock,
  readFile: (n) => { if (mem2.has(strip(n))) return new Uint8Array(mem2.get(strip(n))); const p = vfs.get(strip(n)); return p ? new Uint8Array(fs.readFileSync(p)) : null; },
  writeFile: (n, d) => { mem2.set(strip(n), new Uint8Array(d)); console.log('[host] write ' + n + ' ' + d.length + ' bytes at frame ' + PLAT.frames); if (/LOG/.test(n)) console.log(Buffer.from(d).toString('latin1').split('\n').map(l => '   LOG| ' + l).join('\n')); },
  listDir: (d) => { const pre = strip(d); return [...vfs.keys()].filter(k => k.startsWith(pre) && !k.slice(pre.length).includes('\\')).map(k => k.slice(pre.length)); },
  glCount, frames: 0, swap: () => { PLAT.frames++; clock += 16; }, gl: glStub, mci: () => 1, audio: new Proxy({}, { get: (t, k) => (k === 'isPlaying' ? (() => false) : ((b) => { if (k === 'play') PLAT.sndCount = (PLAT.sndCount || 0) + 1; })) }),
};
const src = ['runtime.js', 'host.js', process.env.BLOCKS || 'blocks.js'].map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n') + `
const meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'meta.json')));
let pc = bootGuest(fs.readFileSync(path.join(__dirname, 'image.bin')), meta.base, meta.entry, meta.imports);
blockBudget = +(process.env.BUDGET || 3e8);
const maxFrames = +(process.env.FRAMES || 5), t0 = Date.now();
try {
  const script = (process.env.KEYSCRIPT || '').split(',').filter(Boolean).map(s => s.split(':')); // frame:vk:scan[:char]
  while (PLAT.frames < maxFrames) { yieldFlag = false;
    if (PLAT.frames === maxFrames - 300) { PLAT.lastT = Date.now(); PLAT.lastI = icount; PLAT.lastV = PLAT.glCount.glVertex3f || 0; }
    for (const s of script) { if (+s[0] === PLAT.frames) { const vk = +s[1], sc = ((+s[2] & 255)) | ((+s[2] & 256) << 0); msgQueue.push({ msg: 0x100, wp: vk, lp: 1 | ((sc & 255) << 16) | ((sc & 256) << 16) }); if (s[3]) msgQueue.push({ msg: 0x102, wp: +s[3], lp: 1 | (sc << 16) }); msgQueue.push({ msg: 0x101, wp: vk, lp: (1 | (sc << 16) | (3 << 30)) | 0 }); s[0] = -1; } } pc = run(pc); if (pc === STOP) { console.log('guest returned from entry point'); break; } }
  console.log('ran', PLAT.frames, 'frames,', icount, 'blocks in', Date.now() - t0, 'ms');
} catch (e) { console.log('STOPPED:', e.message, '| last block 0x' + (lastPc>>>0).toString(16), 'frames', PLAT.frames, 'blocks', icount); if (!(e instanceof GuestTrap) && !(e instanceof GuestExit)) console.log(e.stack.split('\\n').slice(0,4).join('\\n')); }
if (PLAT.lastT) console.log('last 300 frames:', ((Date.now() - PLAT.lastT) / 300).toFixed(2), 'ms/frame,', ((icount - PLAT.lastI) / 300 / 1000 | 0) + 'k blocks/frame,', (((PLAT.glCount.glVertex3f || 0) - PLAT.lastV) / 300 | 0), 'verts/frame'); console.log('sounds played:', PLAT.sndCount || 0); console.log('GL calls:', JSON.stringify(PLAT.glCount));
if (PLAT.trace) console.log('API calls:', JSON.stringify([...callLog].sort((a,b)=>b[1]-a[1]).slice(0,40)));
`;
new Function('require', 'process', 'fs', 'path', '__dirname', 'PLAT', src)(require, process, fs, path, __dirname, PLAT);
