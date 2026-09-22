// ---- CPU runtime for the statically recompiled MnMs.exe ----
'use strict';
const MEMSIZE = 0x20000000;                      // 512 MB flat guest address space
const mem = new ArrayBuffer(MEMSIZE);
const u8 = new Uint8Array(mem), i8 = new Int8Array(mem), u16 = new Uint16Array(mem), i16 = new Int16Array(mem);
const i32 = new Int32Array(mem), u32 = new Uint32Array(mem), f32 = new Float32Array(mem), f64 = new Float64Array(mem);
const dv = new DataView(mem);
let eax = 0, ecx = 0, edx = 0, ebx = 0, esp = 0, ebp = 0, esi = 0, edi = 0;
let fr = 0, cf = false, of = false, df = 1;
let ta = 0;                                       // scratch address used by inlined memory accesses
const st = new Float64Array(8); let ftop = 0, fpsw = 0, fcw = 0x27f;
const FSB = 0x7fe000;                             // fake thread information block
let yieldFlag = false, icount = 0, blockBudget = Infinity;

function r32(a) { return (a & 3) === 0 ? i32[a >> 2] : (u8[a] | (u8[a + 1] << 8) | (u8[a + 2] << 16) | (u8[a + 3] << 24)); }
function w32(a, v) { if ((a & 3) === 0) i32[a >> 2] = v; else { u8[a] = v; u8[a + 1] = v >> 8; u8[a + 2] = v >> 16; u8[a + 3] = v >> 24; } }
function r16(a) { return (a & 1) === 0 ? u16[a >> 1] : (u8[a] | (u8[a + 1] << 8)); }
function rs16(a) { return (a & 1) === 0 ? i16[a >> 1] : (((u8[a] | (u8[a + 1] << 8)) << 16) >> 16); }
function w16(a, v) { if ((a & 1) === 0) u16[a >> 1] = v; else { u8[a] = v; u8[a + 1] = v >> 8; } }
function rf32(a) { return (a & 3) === 0 ? f32[a >> 2] : dv.getFloat32(a, true); }
function wf32(a, v) { if ((a & 3) === 0) f32[a >> 2] = v; else dv.setFloat32(a, v, true); }
function rf64(a) { return (a & 7) === 0 ? f64[a >> 3] : dv.getFloat64(a, true); }
function wf64(a, v) { if ((a & 7) === 0) f64[a >> 3] = v; else dv.setFloat64(a, v, true); }
function ri64(a) { return Number(dv.getBigInt64(a, true)); }
function wi64(a, v) { dv.setBigInt64(a, v, true); }
function rf80(a) {
  const lo = dv.getUint32(a, true), hi = dv.getUint32(a + 4, true), se = dv.getUint16(a + 8, true);
  const e = se & 0x7fff, s = se & 0x8000 ? -1 : 1;
  if (e === 0 && lo === 0 && hi === 0) return s * 0;
  if (e === 0x7fff) return (hi << 1) === 0 && lo === 0 ? s * Infinity : NaN;
  return s * (hi * 4294967296 + lo) * Math.pow(2, e - 16383 - 63);
}
function wf80(a, v) {
  let s = 0; if (v < 0 || Object.is(v, -0)) { s = 0x8000; v = -v; }
  if (v === 0) { dv.setUint32(a, 0, true); dv.setUint32(a + 4, 0, true); dv.setUint16(a + 8, s, true); return; }
  if (!isFinite(v)) { dv.setUint32(a, 0, true); dv.setUint32(a + 4, isNaN(v) ? 0xc0000000 : 0x80000000, true); dv.setUint16(a + 8, s | 0x7fff, true); return; }
  let e = Math.floor(Math.log2(v)); let m = v / Math.pow(2, e); if (m >= 2) { m /= 2; e++; } if (m < 1) { m *= 2; e--; }
  const big = BigInt(Math.round(m * 4503599627370496)) << 11n;      // 52 fraction bits -> 63
  dv.setBigUint64(a, big, true); dv.setUint16(a + 8, s | (e + 16383), true);
}
function fpush(v) { ftop = (ftop - 1) & 7; st[ftop] = v; }
function fpop() { ftop = (ftop + 1) & 7; }
function fcom(a, b) { fpsw &= ~0x4500; if (a > b) return; if (a < b) fpsw |= 0x100; else if (a === b) fpsw |= 0x4000; else fpsw |= 0x4500; }
function fsw() { return (fpsw & 0xc7ff) | (ftop << 11); }
function fxam(v) { fpsw &= ~0x4700; if (v < 0 || Object.is(v, -0)) fpsw |= 0x200; if (isNaN(v)) fpsw |= 0x100; else if (!isFinite(v)) fpsw |= 0x500; else if (v === 0) fpsw |= 0x4000; else fpsw |= 0x400; }
function frnd(v) {
  switch ((fcw >> 10) & 3) {
    case 0: { const r = Math.round(v); return (Math.abs(v % 1) === 0.5 && (r % 2) !== 0) ? r - 1 : r; }
    case 1: return Math.floor(v);
    case 2: return Math.ceil(v);
    default: return Math.trunc(v);
  }
}
function fround(v) { const r = frnd(v); return (r >= -2147483648 && r <= 2147483647) ? r | 0 : -2147483648; }
function fround64(v) { const r = frnd(v); return (isFinite(r) && Math.abs(r) < 9.2e18) ? BigInt(r) : -(1n << 63n); }
function fprem1(a, b) { return a - b * Math.round(a / b); }
const PAR = new Uint8Array(256); for (let i = 0; i < 256; i++) { let p = 0, x = i; while (x) { p ^= x & 1; x >>= 1; } PAR[i] = p ^ 1; }
function par(v) { return PAR[v & 255] === 1; }

function str_movs(n, rep) {
  let cnt = rep ? ecx >>> 0 : 1; if (!cnt) return;
  const bytes = cnt * n;
  if (df === 1) { if (edi > esi && edi < esi + bytes) { for (let k = 0; k < bytes; k++) u8[edi + k] = u8[esi + k]; } else u8.copyWithin(edi, esi, esi + bytes); esi = (esi + bytes) | 0; edi = (edi + bytes) | 0; }
  else { for (let c = 0; c < cnt; c++) { for (let k = 0; k < n; k++) u8[edi + k] = u8[esi + k]; esi = (esi - n) | 0; edi = (edi - n) | 0; } }
  if (rep) ecx = 0;
}
function str_stos(n, rep) {
  let cnt = rep ? ecx >>> 0 : 1; if (!cnt) return;
  if (df === 1) {
    if (n === 1) u8.fill(eax & 255, edi, edi + cnt);
    else if (n === 4 && (edi & 3) === 0) i32.fill(eax, edi >> 2, (edi >> 2) + cnt);
    else for (let c = 0; c < cnt; c++) { if (n === 4) w32(edi + c * 4, eax); else w16(edi + c * 2, eax); }
    edi = (edi + cnt * n) | 0;
  } else for (let c = 0; c < cnt; c++) { if (n === 1) u8[edi] = eax; else if (n === 2) w16(edi, eax); else w32(edi, eax); edi = (edi - n) | 0; }
  if (rep) ecx = 0;
}
function rdn(a, n) { return n === 1 ? i8[a] : n === 2 ? rs16(a) : r32(a); }
function setsub(a, b, n) { const sh = 32 - n * 8, r = ((a - b) << sh) >> sh; cf = (a >>> 0) < (b >>> 0); of = ((a ^ b) & (a ^ r)) < 0; fr = r; }
function str_scas(n, rep) {
  const acc = n === 1 ? (eax << 24) >> 24 : n === 2 ? (eax << 16) >> 16 : eax;
  if (!rep) { setsub(acc, rdn(edi, n), n); edi = (edi + df * n) | 0; return; }
  while (ecx !== 0) { setsub(acc, rdn(edi, n), n); edi = (edi + df * n) | 0; ecx = (ecx - 1) | 0; if ((rep === 'repne') === (fr === 0)) break; }
}
function str_cmps(n, rep) {
  if (!rep) { setsub(rdn(esi, n), rdn(edi, n), n); esi = (esi + df * n) | 0; edi = (edi + df * n) | 0; return; }
  while (ecx !== 0) { setsub(rdn(esi, n), rdn(edi, n), n); esi = (esi + df * n) | 0; edi = (edi + df * n) | 0; ecx = (ecx - 1) | 0; if ((rep === 'repne') === (fr === 0)) break; }
}
function str_lods(n, rep) { const v = rdn(esi, n); if (n === 4) eax = v; else if (n === 2) eax = (eax & -65536) | (v & 65535); else eax = (eax & -256) | (v & 255); esi = (esi + df * n) | 0; }

class GuestTrap extends Error {}
function trap(code) { throw new GuestTrap(code === 1 ? 'divide by zero' : 'unsupported shift/rotate form'); }
function trap2(pc) { throw new GuestTrap('no translation for instruction at 0x' + (pc >>> 0).toString(16)); }

// Run guest code starting at pc until it returns to `until`, or until a host call asks to yield. Returns the pc to resume at.
const STOP = 0x7ffffff0 | 0;
let lastPc = 0;
function run(pc) {
  for (;;) {
    if (pc < 0) { pc = hostcall(pc & 0x7fffffff); if (yieldFlag) return pc; continue; }
    if (pc === STOP) return STOP;
    const f = T[pc - TB];
    if (f === null || f === undefined) throw new GuestTrap('jump to untranslated address 0x' + (pc >>> 0).toString(16) + ' (from block 0x' + (lastPc >>> 0).toString(16) + ')');
    lastPc = pc; if ((++icount & 0xfffff) === 0 && icount > blockBudget) throw new GuestTrap('block budget exhausted');
    pc = f();
  }
}
// Call a guest function from the host (window procedures and other callbacks). stdcall or cdecl: caller cleans nothing here.
function callGuest(addr, args) {
  const savedEsp = esp;
  for (let i = args.length - 1; i >= 0; i--) { esp = (esp - 4) | 0; w32(esp, args[i]); }
  esp = (esp - 4) | 0; w32(esp, STOP);
  const r = run(addr);
  if (r !== STOP) throw new GuestTrap('yield inside a host-to-guest callback');
  esp = savedEsp;
  return eax;
}
