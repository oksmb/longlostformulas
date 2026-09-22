const fs = require('fs'), zlib = require('zlib');
const src = fs.readFileSync('runtime.js', 'utf8') + '\nfunction hostcall(){throw new Error("host")}\n' + fs.readFileSync('blocks.js', 'utf8') + `
const cases = JSON.parse(fs.readFileSync('cases2.json')), scratch = fs.readFileSync('scratch.bin'), image = fs.readFileSync('image.bin'), SCR = 0x2000000, res = [];
for (const c of cases) {
  u8.set(image, 0x400000); u8.set(scratch, SCR); ftop = 0; fpsw = 0; fcw = 0x27f; for (let i = 0; i < 8; i++) fpush(f64[(SCR + 0xff000 + 8 * (7 - i)) >> 3]);
  [eax, ecx, edx, ebx, esp, ebp, esi, edi] = c.regs.map(v => v | 0); fr = 1; cf = false; of = false; df = 1; let pc = null, err = null;
  try { pc = T[c.a - TB](); } catch (e) { err = e.message; }
  const fp = []; for (let i = 0; i < 8; i++) fp.push(String(st[(ftop + i) & 7]));
  res.push({ pc: pc === null ? null : pc >>> 0, err, out: [eax, ecx, edx, ebx, esp, ebp, esi, edi].map(v => v >>> 0), cf, zf: fr === 0, sf: fr < 0, of, fp, crc: zlib.crc32(u8.subarray(SCR, SCR + 0xff000)) });
}
fs.writeFileSync('res2.json', JSON.stringify(res));`;
new Function('require', 'fs', 'zlib', src)(require, fs, zlib);
