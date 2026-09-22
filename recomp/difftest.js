const fs = require('fs'), zlib = require('zlib');
const src = fs.readFileSync('runtime.js', 'utf8') + '\nfunction hostcall(){throw new Error("host")}\n' + fs.readFileSync('blocks.js', 'utf8') + `
const cases = JSON.parse(fs.readFileSync('cases.json')), scratch = fs.readFileSync('scratch.bin'), image = fs.readFileSync('image.bin');
const SCR = 0x2000000; let bad = 0, shown = 0; const byM = {};
for (const c of cases) {
  u8.set(image, 0x400000); u8.set(scratch, SCR);
  ftop = 0; fpsw = 0; fcw = 0x27f; for (let i = 0; i < 8; i++) fpush(f64[(SCR + 0xff000 + 8 * (7 - i)) >> 3]);
  [eax, ecx, edx, ebx, esp, ebp, esi, edi] = c.regs.map(v => v | 0); fr = 1; cf = false; of = false; df = 1;
  let pc, err = null;
  try { pc = T[c.a - TB](); } catch (e) { err = e.message; }
  const out = [eax, ecx, edx, ebx, esp, ebp, esi, edi].map(v => v >>> 0), probs = [];
  if (err) probs.push('exception ' + err);
  else {
    if ((pc >>> 0) !== c.end) probs.push('pc ' + (pc >>> 0).toString(16) + ' vs ' + c.end.toString(16));
    out.forEach((v, i) => { const mk = (i === 0 && c.sw) ? ~0x3800 : -1; if ((v & mk) !== (c.out[i] & mk)) probs.push(['eax','ecx','edx','ebx','esp','ebp','esi','edi'][i] + ' ' + v.toString(16) + ' vs ' + c.out[i].toString(16)); });
    if (c.cmpflags) { const e = c.efl; if (cf !== !!(e & 1)) probs.push('CF'); if ((fr === 0) !== !!(e & 0x40)) probs.push('ZF'); if ((fr < 0) !== !!(e & 0x80)) probs.push('SF'); if (of !== !!(e & 0x800)) probs.push('OF'); }
    for (let i = 0; i < 8; i++) { const v = st[(ftop + i) & 7], w = Number(String(c.fp[i]).replace('inf','Infinity').replace('nan','NaN')); if (!(v === w || (isNaN(v) && isNaN(w)) || Math.abs(v - w) <= 1e-9 * Math.max(1, Math.abs(w)))) { probs.push('st' + i + ' ' + v + ' vs ' + w); break; } }
    for (let i = 0; i < 0x40; i++) u8[SCR + 0xff100 + i] = 0;
    const crc = zlib.crc32 ? zlib.crc32(u8.subarray(SCR, SCR + 0xff000)) : 0;
    if (zlib.crc32 && crc !== c.crc) probs.push('memory differs');
  }
  if (probs.length) { bad++; const k = probs[0].split(' ')[0]; byM[k] = (byM[k] || 0) + 1; if (shown++ < +(process.argv[2] || 12)) console.log((c.a).toString(16), probs.slice(0, 3).join(', '), '|', c.text.slice(0, 230)); }
}
console.log(cases.length, 'cases,', bad, 'mismatches', JSON.stringify(byM));
`;
new Function('require', 'process', 'fs', 'zlib', src)(require, process, fs, zlib);
