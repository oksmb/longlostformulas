// ---- Win32 host layer: the recompiled game talks to these functions instead of Windows ----
// Platform services are injected through `PLAT` (file system, GL, audio, clock, log).
const HOSTS = [];                 // id -> {name, n, f}
const HOSTBYNAME = new Map();
function hostAddr(name) {
  let id = HOSTBYNAME.get(name);
  if (id === undefined) {
    const impl = API[name];
    id = HOSTS.length; HOSTS.push({ name, n: impl ? impl.n : 0, f: impl ? impl.f : null }); HOSTBYNAME.set(name, id);
  }
  return (0x80000000 + id * 4) | 0;
}
const callLog = new Map();
const RETRY = Symbol('retry');
function hostcall(code) {
  const h = HOSTS[code >> 2];
  if (!h) throw new GuestTrap('bad host call ' + code);
  if (!h.f) throw new GuestTrap('unimplemented API ' + h.name + ' (args ' + [0, 1, 2, 3, 4, 5].map(i => (r32(esp + 4 + i * 4) >>> 0).toString(16)).join(',') + ')');
  if (PLAT.trace) callLog.set(h.name, (callLog.get(h.name) || 0) + 1);
  const sp = esp, a = sp + 4;
  let r;
  switch (h.n) {                                // read only as many stack arguments as the API takes (hot path: GL calls)
    case 0: r = h.f(); break;
    case 1: r = h.f(i32[a >> 2]); break;
    case 2: r = h.f(i32[a >> 2], i32[(a + 4) >> 2]); break;
    case 3: r = h.f(i32[a >> 2], i32[(a + 4) >> 2], i32[(a + 8) >> 2]); break;
    case 4: r = h.f(i32[a >> 2], i32[(a + 4) >> 2], i32[(a + 8) >> 2], i32[(a + 12) >> 2]); break;
    default: r = h.f(r32(a), r32(a + 4), r32(a + 8), r32(a + 12), r32(a + 16), r32(a + 20), r32(a + 24), r32(a + 28), r32(a + 32), r32(a + 36), r32(a + 40), r32(a + 44));
  }
  if (r === RETRY) { yieldFlag = true; return (0x80000000 + code) | 0; }   // call again next frame, stack untouched
  if (r !== undefined) eax = r | 0;
  if (esp !== sp) return r32(esp);             // the API switched stacks/unwound (ExitProcess etc.)
  const ret = r32(sp);
  esp = (sp + 4 + (h.n > 0 ? h.n * 4 : 0)) | 0;
  return ret;
}
function gstr(a, max = 4096) { if (!a) return ''; let s = ''; for (let i = 0; i < max; i++) { const c = u8[a + i]; if (!c) break; s += String.fromCharCode(c); } return s; }
function wstr(a, s, max = 1 << 30) { let i = 0; for (; i < s.length && i < max - 1; i++) u8[a + i] = s.charCodeAt(i) & 255; u8[a + i] = 0; return i; }

// ---- guest heap: size classes for small blocks, first-fit with coalescing for large ones ----
let heapTop = 0x1000000; const HEAPEND = 0x1f000000; const freeLists = new Map();
const BIG = 4096; let bigFree = [];                     // sorted [addr,size] spans (header included)
function galloc(size, zero) {
  size = Math.max(16, (size + 15) & ~15); let p = 0;
  if (size < BIG) { const fl = freeLists.get(size); if (fl && fl.length) p = fl.pop(); }
  else { const need = size + 16;
    for (let i = 0; i < bigFree.length; i++) { const s = bigFree[i]; if (s[1] >= need) { p = s[0] + 16; if (s[1] - need >= BIG + 16) { s[0] += need; s[1] -= need; } else { size = s[1] - 16; bigFree.splice(i, 1); } i32[(p - 16) >> 2] = size; break; } } }
  if (!p) { p = heapTop + 16; heapTop += size + 16; if (heapTop > HEAPEND) throw new GuestTrap('guest heap exhausted'); i32[(p - 16) >> 2] = size; }
  if (zero) u8.fill(0, p, p + size);
  return p;
}
function gfree(p) {
  if (!p) return; const size = i32[(p - 16) >> 2];
  if (size < BIG) { let fl = freeLists.get(size); if (!fl) freeLists.set(size, fl = []); fl.push(p); return; }
  let a = p - 16, n = size + 16, lo = 0, hi = bigFree.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (bigFree[m][0] < a) lo = m + 1; else hi = m; }
  if (lo < bigFree.length && a + n === bigFree[lo][0]) { n += bigFree[lo][1]; bigFree.splice(lo, 1); }
  if (lo > 0 && bigFree[lo - 1][0] + bigFree[lo - 1][1] === a) { bigFree[lo - 1][1] += n; a = bigFree[lo - 1][0]; n = bigFree[lo - 1][1]; lo--; } else bigFree.splice(lo, 0, [a, n]);
  if (a + n === heapTop) { heapTop = a; bigFree.splice(lo, 1); }
}
function gsize(p) { return i32[(p - 16) >> 2]; }

// ---- files ----
const handles = new Map(); let nextHandle = 0x100;
let cwd = 'D:';
function normPath(p) {
  p = p.replace(/\//g, '\\');
  if (!/^[A-Za-z]:/.test(p)) p = (p.startsWith('\\') ? cwd.slice(0, 2) : cwd + '\\') + p;
  const parts = []; for (const s of p.split('\\')) { if (s === '' || s === '.') continue; if (s === '..') parts.pop(); else parts.push(s); }
  return parts.join('\\').toUpperCase();
}
let lastError = 0;
const msgQueue = [];
let wndProc = 0, hwndMain = 0, quit = false;
const wndClasses = new Map();
const keysDown = new Set();

function fmtWsprintf(fmt, argp) {
  let out = '', i = 0;
  while (i < fmt.length) {
    const c = fmt[i++];
    if (c !== '%') { out += c; continue; }
    let flags = '', width = '', prec = '';
    while ('-0# +'.includes(fmt[i])) flags += fmt[i++];
    while (/\d/.test(fmt[i])) width += fmt[i++];
    if (fmt[i] === '.') { i++; while (/\d/.test(fmt[i])) prec += fmt[i++]; }
    while ('lhw'.includes(fmt[i])) i++;
    const t = fmt[i++]; let s;
    if (t === '%') { out += '%'; continue; }
    const v = r32(argp); argp += 4;
    if (t === 'd' || t === 'i') s = String(v); else if (t === 'u') s = String(v >>> 0);
    else if (t === 'x') s = (v >>> 0).toString(16); else if (t === 'X') s = (v >>> 0).toString(16).toUpperCase();
    else if (t === 'c') s = String.fromCharCode(v & 255); else if (t === 's') { s = gstr(v); if (prec) s = s.slice(0, +prec); }
    else s = '?';
    if (prec && 'diuxX'.includes(t)) s = s.replace(/^(-?)(\d+)$/, (m, sg, d) => sg + d.padStart(+prec, '0'));
    if (width) s = flags.includes('-') ? s.padEnd(+width) : (flags.includes('0') && t !== 's' ? s.replace(/^(-?)(.*)$/, (m, sg, d) => sg + d.padStart(+width - sg.length, '0')) : s.padStart(+width));
    out += s;
  }
  return out;
}

const API = {};
const def = (name, n, f) => { API[name] = { n, f }; };
const ret0 = () => 0, ret1 = () => 1;

// ---- KERNEL32 ----
def('GetVersion', 0, () => 0xc0000a04 | 0);                        // Windows 98
def('GetCommandLineA', 0, () => { const p = galloc(64); wstr(p, '"C:\\MNMS\\MnMs.exe"'); return p; });
def('GetStartupInfoA', 1, (p) => { u8.fill(0, p, p + 68); w32(p, 68); });
def('GetModuleHandleA', 1, () => 0x400000);
def('GetModuleFileNameA', 3, (h, buf, n) => wstr(buf, 'C:\\MNMS\\MnMs.exe', n));
def('GetEnvironmentStrings', 0, () => { const p = galloc(16, true); return p; });
def('GetEnvironmentStringsW', 0, () => galloc(16, true));
def('FreeEnvironmentStringsA', 1, ret1); def('FreeEnvironmentStringsW', 1, ret1);
def('GetStdHandle', 1, (n) => 0); def('GetFileType', 1, () => 0); def('SetHandleCount', 1, (n) => n); def('SetStdHandle', 2, ret1);
def('GetACP', 0, () => 1252); def('GetOEMCP', 0, () => 437);
def('GetCPInfo', 2, (cp, p) => { u8.fill(0, p, p + 20); w32(p, 1); u8[p + 4] = 0x3f; return 1; });
def('GetStringTypeA', 5, (lc, type, src, n, out) => { if (n < 0) n = gstr(src).length + 1; for (let i = 0; i < n; i++) w16(out + i * 2, ctype(u8[src + i])); return 1; });
def('GetStringTypeW', 4, (type, src, n, out) => { if (n < 0) { n = 0; while (r16(src + n * 2)) n++; n++; } for (let i = 0; i < n; i++) w16(out + i * 2, ctype(r16(src + i * 2) & 255)); return 1; });
function ctype(c) { let t = 0; if (c >= 65 && c <= 90) t |= 0x101; if (c >= 97 && c <= 122) t |= 0x102; if (c >= 48 && c <= 57) t |= 0x84; if (c === 32) t |= 0x48; if (c >= 9 && c <= 13) t |= 0x28; if (c < 32 || c === 127) t |= 0x20; if ((c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)) t |= 0x10; if ((c >= 65 && c <= 70) || (c >= 97 && c <= 102)) t |= 0x80; return t; }
def('LCMapStringA', 6, (lc, flags, src, n, dst, dn) => { if (n < 0) n = gstr(src).length + 1; if (!dn) return n; for (let i = 0; i < n && i < dn; i++) { let c = u8[src + i]; if (flags & 0x100) { if (c >= 65 && c <= 90) c += 32; } else if (flags & 0x200) { if (c >= 97 && c <= 122) c -= 32; } u8[dst + i] = c; } return n; });
def('LCMapStringW', 6, (lc, flags, src, n, dst, dn) => { if (n < 0) { n = 0; while (r16(src + n * 2)) n++; n++; } if (!dn) return n; for (let i = 0; i < n && i < dn; i++) { let c = r16(src + i * 2); if (flags & 0x100) { if (c >= 65 && c <= 90) c += 32; } else if (flags & 0x200) { if (c >= 97 && c <= 122) c -= 32; } w16(dst + i * 2, c); } return n; });
def('MultiByteToWideChar', 6, (cp, fl, src, n, dst, dn) => { if (n < 0) n = gstr(src).length + 1; if (!dn) return n; for (let i = 0; i < n && i < dn; i++) w16(dst + i * 2, u8[src + i]); return Math.min(n, dn); });
def('WideCharToMultiByte', 8, (cp, fl, src, n, dst, dn) => { if (n < 0) { n = 0; while (r16(src + n * 2)) n++; n++; } if (!dn) return n; for (let i = 0; i < n && i < dn; i++) u8[dst + i] = r16(src + i * 2); return Math.min(n, dn); });
def('HeapCreate', 3, () => 0x10000); def('HeapDestroy', 1, ret1);
def('HeapAlloc', 3, (h, flags, size) => galloc(size >>> 0, flags & 8));
def('HeapFree', 3, (h, flags, p) => { gfree(p); return 1; });
def('HeapReAlloc', 4, (h, flags, p, size) => { size >>>= 0; const old = gsize(p); if (size <= old) return p; const q = galloc(size, flags & 8); u8.copyWithin(q, p, p + old); gfree(p); return q; });
def('VirtualAlloc', 4, (addr, size, type, prot) => { if (addr) return addr; size = ((size >>> 0) + 0xffff) & ~0xffff; heapTop = (heapTop + 0xffff) & ~0xffff; const p = heapTop; heapTop += size; if (heapTop > HEAPEND) throw new GuestTrap('guest heap exhausted (VirtualAlloc)'); u8.fill(0, p, p + size); return p; });
def('VirtualFree', 3, ret1);
def('GlobalMemoryStatus', 1, (p) => { w32(p, 32); w32(p + 4, 30); w32(p + 8, 128 << 20); w32(p + 12, 96 << 20); w32(p + 16, 512 << 20); w32(p + 20, 400 << 20); w32(p + 24, 0x7ffe0000); w32(p + 28, 0x70000000); });
def('GetLastError', 0, () => lastError);
def('GetCurrentProcess', 0, () => -1);
def('ExitProcess', 1, (code) => { quit = true; throw new GuestExit(code); });
def('TerminateProcess', 2, (h, code) => { quit = true; throw new GuestExit(code); });
def('UnhandledExceptionFilter', 1, ret0);
def('IsProcessorFeaturePresent', 1, ret0);
def('RtlUnwind', 4, ret0);
def('Sleep', 1, ret0);
def('CreateMutexA', 3, () => { lastError = 0; return 0x55; }); def('ReleaseMutex', 1, ret1);
def('lstrcpynA', 3, (dst, src, n) => { wstr(dst, gstr(src), n); return dst; });
def('GetCurrentDirectoryA', 2, (n, buf) => wstr(buf, cwd.length === 2 ? cwd + '\\' : cwd, n));
def('SetCurrentDirectoryA', 1, (p) => { cwd = normPath(gstr(p)); return 1; });
def('GetFullPathNameA', 4, (name, n, buf, filePart) => { const s = normPath(gstr(name)); wstr(buf, s, n); if (filePart) w32(filePart, buf + s.lastIndexOf('\\') + 1); return s.length; });
def('GetDriveTypeA', 1, (p) => { const s = p ? gstr(p).toUpperCase() : cwd; return s.startsWith(PLAT.cdDrive) ? 5 : (s.startsWith('C:') ? 3 : 1); });
def('SetFileAttributesA', 2, (p) => (normPath(gstr(p)).startsWith(PLAT.cdDrive) ? 0 : 1));
def('CreateFileA', 7, (pname, access, share, sa, disp, flags, tmpl) => {
  const name = normPath(gstr(pname));
  if (PLAT.pending && PLAT.pending(name)) return RETRY;          // still downloading: ask again next frame
  let data = PLAT.readFile(name);
  if (PLAT.trace) PLAT.log('CreateFile ' + name + (data ? '' : '  (not found)') + ' disp=' + disp + ' access=' + (access >>> 0).toString(16));
  const writing = (access & 0x40000000) !== 0;
  if (!data) { if (!writing || disp === 3) { lastError = 2; return -1; } data = new Uint8Array(0); }
  if (writing && (disp === 2 || disp === 5)) data = new Uint8Array(0);
  const h = nextHandle++; handles.set(h, { name, data, pos: 0, writing, dirty: false });
  return h;
});
def('ReadFile', 5, (h, buf, n, pread, ov) => { const f = handles.get(h); if (!f) { if (pread) w32(pread, 0); return 0; } n >>>= 0; const k = Math.max(0, Math.min(n, f.data.length - f.pos)); u8.set(f.data.subarray(f.pos, f.pos + k), buf); f.pos += k; if (pread) w32(pread, k); return 1; });
def('WriteFile', 5, (h, buf, n, pw, ov) => { const f = handles.get(h); if (!f) return 0; n >>>= 0; if (f.pos + n > f.data.length) { const d = new Uint8Array(f.pos + n); d.set(f.data); f.data = d; } f.data.set(u8.subarray(buf, buf + n), f.pos); f.pos += n; f.dirty = true; if (pw) w32(pw, n); return 1; });
def('SetFilePointer', 4, (h, dist, phigh, method) => { const f = handles.get(h); if (!f) return -1; f.pos = (method === 0 ? 0 : method === 1 ? f.pos : f.data.length) + dist; return f.pos; });
def('GetFileSize', 2, (h, phigh) => { const f = handles.get(h); if (phigh) w32(phigh, 0); return f ? f.data.length : -1; });
def('CloseHandle', 1, (h) => { const f = handles.get(h); if (f) { if (f.dirty) PLAT.writeFile(f.name, f.data); handles.delete(h); } return 1; });
def('FlushFileBuffers', 1, ret1);
def('GetFileInformationByHandle', 2, (h, p) => { const f = handles.get(h); u8.fill(0, p, p + 52); w32(p, 0x80); if (f) w32(p + 36, f.data.length); w32(p + 40, 1); return 1; });
def('FileTimeToSystemTime', 2, (ft, st_) => { u8.fill(0, st_, st_ + 16); w16(st_, 2000); w16(st_ + 2, 9); w16(st_ + 6, 9); return 1; });
const finds = new Map();
function fillFind(p, name, size) { u8.fill(0, p, p + 320); w32(p, 0x80); w32(p + 32, size); wstr(p + 44, name, 260); }
def('FindFirstFileA', 2, (ppat, out) => { const pat = normPath(gstr(ppat)); const dir = pat.slice(0, pat.lastIndexOf('\\') + 1), mask = pat.slice(dir.length);
  const re = new RegExp('^' + mask.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  const list = PLAT.listDir(dir).filter(n => re.test(n)); if (PLAT.trace) PLAT.log('FindFirstFile ' + pat + ' -> ' + list.length);
  if (!list.length) { lastError = 2; return -1; } const h = nextHandle++; finds.set(h, { dir, list, i: 1 }); let size = PLAT.fileSize ? PLAT.fileSize(dir + list[0]) : -1; if (size < 0) { const d = PLAT.readFile(dir + list[0]); size = d ? d.length : 0; } fillFind(out, list[0], size); return h; });
def('FindClose', 1, (h) => { finds.delete(h); return 1; });
const modules = new Map(); let nextModule = 0x10000000;
def('LoadLibraryA', 1, (p) => { const name = gstr(p).toLowerCase().replace(/^.*\\/, ''); const ok = PLAT.modules.includes(name); if (PLAT.trace) PLAT.log('LoadLibrary ' + name + (ok ? '' : ' -> not available')); if (!ok) { lastError = 126; return 0; } if (!modules.has(name)) { modules.set(name, nextModule); nextModule += 0x10000; } return modules.get(name); });
def('FreeLibrary', 1, ret1);
def('GetProcAddress', 2, (h, pname) => { const raw = gstr(pname), name = raw.replace(/^_/, '').replace(/@\d+$/, ''), m = /@(\d+)$/.exec(raw);
  if (!API[name] && m && /^Bink/.test(name)) def(name, (+m[1]) >> 2, ret0);
  return hostAddr(name); });

// ---- USER32 ----
def('wsprintfA', -1, (buf, fmt) => wstr(buf, fmtWsprintf(gstr(fmt), esp + 12)));
def('MessageBoxA', 4, (h, text, cap, type) => { PLAT.log('MessageBox [' + gstr(cap) + '] ' + gstr(text)); return 1; });
def('RegisterClassA', 1, (p) => { const name = gstr(r32(p + 36)); wndClasses.set(name, r32(p + 4)); return 0xc001; });
def('LoadIconA', 2, () => 1); def('LoadCursorA', 2, () => 1);
def('CreateWindowExA', 12, (ex, cls, title, style, x, y, w, h, parent, menu, inst, param) => { wndProc = wndClasses.get(gstr(cls)) || 0; hwndMain = 0x1234; PLAT.log('CreateWindow "' + gstr(title) + '" ' + w + 'x' + h); if (wndProc) callGuest(wndProc, [hwndMain, 1, 0, 0]); return hwndMain; });
def('ShowWindow', 2, (h) => { if (wndProc) { callGuest(wndProc, [h, 0x1c, 1, 0]); callGuest(wndProc, [h, 6, 1, 0]); callGuest(wndProc, [h, 7, 0, 0]); } return 0; });
def('UpdateWindow', 1, ret1); def('SetWindowPos', 7, ret1); def('SetWindowLongA', 3, ret0); def('SetCapture', 1, ret0); def('ReleaseCapture', 0, ret1);
def('SetCursorPos', 2, ret1); def('ShowCursor', 1, ret0); def('GetFocus', 0, () => hwndMain); def('ClientToScreen', 2, ret1);
def('GetClientRect', 2, (h, p) => { w32(p, 0); w32(p + 4, 0); w32(p + 8, PLAT.width); w32(p + 12, PLAT.height); return 1; });
def('GetWindowRect', 2, (h, p) => { w32(p, 0); w32(p + 4, 0); w32(p + 8, PLAT.width); w32(p + 12, PLAT.height); return 1; });
def('GetDC', 1, () => 0x77); def('ReleaseDC', 2, ret1);
def('DefWindowProcA', 4, (h, msg) => (msg === 0x81 ? 1 : 0));
function putMsg(p, m) { w32(p, hwndMain); w32(p + 4, m.msg); w32(p + 8, m.wp); w32(p + 12, m.lp); w32(p + 16, PLAT.now() | 0); w32(p + 20, 0); w32(p + 24, 0); }
def('PeekMessageA', 5, (p, h, lo, hi, remove) => { if (!msgQueue.length) return 0; putMsg(p, remove & 1 ? msgQueue.shift() : msgQueue[0]); return 1; });
def('GetMessageA', 4, (p) => { if (!msgQueue.length) { putMsg(p, { msg: 0, wp: 0, lp: 0 }); return 1; } const m = msgQueue.shift(); putMsg(p, m); return m.msg === 0x12 ? 0 : 1; });
def('TranslateMessage', 1, ret0);
def('DispatchMessageA', 1, (p) => (wndProc ? callGuest(wndProc, [r32(p), r32(p + 4), r32(p + 8), r32(p + 12)]) : 0));
def('PostQuitMessage', 1, (code) => { msgQueue.push({ msg: 0x12, wp: code, lp: 0 }); });
def('ChangeDisplaySettingsA', 2, ret0);
def('EnumDisplaySettingsA', 3, (dev, i, p) => { const modes = [[640, 480, 16], [640, 480, 32], [800, 600, 16], [800, 600, 32], [1024, 768, 16], [1024, 768, 32]]; if (i < 0 || i >= modes.length) return 0; w32(p + 104, modes[i][2]); w32(p + 108, modes[i][0]); w32(p + 112, modes[i][1]); w32(p + 120, 60); return 1; });

// ---- GDI32 / WGL ----
def('ChoosePixelFormat', 2, () => 1); def('SetPixelFormat', 3, ret1); def('CreateSolidBrush', 1, () => 2);
def('DescribePixelFormat', 4, (dc, i, n, p) => { if (p) { u8.fill(0, p, p + 40); w16(p, 40); w16(p + 2, 1); w32(p + 4, 0x25); u8[p + 9] = 32; u8[p + 23] = 24; } return 1; });
def('SwapBuffers', 1, () => { PLAT.swap(); yieldFlag = true; return 1; });
def('wglSwapBuffers', 1, () => { PLAT.swap(); yieldFlag = true; return 1; });
def('wglCreateContext', 1, () => 0x99); def('wglMakeCurrent', 2, ret1); def('wglDeleteContext', 1, ret1); def('wglGetProcAddress', 1, ret0);
def('wglChoosePixelFormat', 2, () => 1); def('wglSetPixelFormat', 3, ret1); def('wglDescribePixelFormat', 4, API.DescribePixelFormat.f);
def('wglSwapIntervalEXT', 1, ret1); def('wglGetSwapIntervalEXT', 0, ret0);

// ---- WINMM ----
def('timeGetTime', 0, () => PLAT.now() | 0);
// One joystick is always reported (the game only probes at start-up); PLAT.joy() supplies live state or a centred stick.
def('joyGetNumDevs', 0, () => 1);
def('joyGetPosEx', 2, (id, p) => { if (id !== 0) return 167; const j = PLAT.joy ? PLAT.joy() : null; w32(p + 8, j ? j.x : 32767); w32(p + 12, j ? j.y : 32767); w32(p + 16, 32767); w32(p + 20, 32767); w32(p + 24, 32767); w32(p + 28, 32767); w32(p + 32, j ? j.buttons : 0); w32(p + 36, 0); w32(p + 40, 0xffff); return 0; });
def('joyGetDevCapsA', 3, (id, p, n) => { if (id !== 0) return 167; u8.fill(0, p, p + Math.min(n, 0x194)); wstr(p + 4, 'Browser gamepad', 32); for (let o = 36; o <= 56; o += 8) { w32(p + o, 0); w32(p + o + 4, 65535); } w32(p + 60, 8); w32(p + 64, 10); w32(p + 68, 1000); return 0; });
// Mixer: the game sets the system wave-out (0x1008) and synthesizer (0x1004) volumes through this API.
// Line ids: 1 = speakers, 0x100 = wave out, 0x101 = MIDI synth. The volume control id equals its line id.
const mixerVol = { 0x100: 65535, 0x101: 65535 };
def('mixerOpen', 5, (ph) => { if (ph) w32(ph, 0x4d58); return 0; }); def('mixerClose', 1, ret0);
def('mixerGetLineInfoA', 3, (hm, p, flags) => {
  const kind = flags & 0xf;
  if (kind === 3) { w32(p + 4, 0); w32(p + 12, 1); w32(p + 28, 2); w32(p + 32, 2); w32(p + 36, 1); return 0; }          // by component type (speakers)
  if (kind === 1) { const i = r32(p + 8); if (i < 0 || i > 1) return 1024; w32(p + 12, 0x100 + i); w32(p + 24, i === 0 ? 0x1008 : 0x1004); w32(p + 28, 2); w32(p + 32, 0); w32(p + 36, 1); return 0; }
  w32(p + 28, 1); w32(p + 32, 0); return 1024;
});
def('mixerGetLineControlsA', 3, (hm, p, flags) => { const line = r32(p + 4), c = r32(p + 20); if (mixerVol[line] === undefined || !c) return 1025;
  u8.fill(0, c, c + 0x94); w32(c, 0x94); w32(c + 4, line); w32(c + 8, 0x50030001); w32(c + 12, 1); wstr(c + 20, 'Volume', 16); wstr(c + 36, 'Volume', 64); w32(c + 100, 0); w32(c + 104, 65535); w32(c + 124, 192); return 0; });
def('mixerGetControlDetailsA', 3, (hm, p) => { const id = r32(p + 4), n = Math.max(1, r32(p + 8)), d = r32(p + 20); if (mixerVol[id] === undefined) return 1025; for (let i = 0; i < n; i++) w32(d + i * 4, mixerVol[id]); return 0; });
def('mixerSetControlDetails', 3, (hm, p) => { const id = r32(p + 4), d = r32(p + 20); if (mixerVol[id] === undefined) return 1025; mixerVol[id] = r32(d) & 0xffff; if (PLAT.setVolume) PLAT.setVolume(id === 0x100 ? 'wave' : 'midi', mixerVol[id] / 65535); return 0; });
def('mciSendCommandA', 4, (id, msg, flags, parm) => PLAT.mci(id, msg, flags, parm)); def('mciGetErrorStringA', 3, (e, buf, n) => { wstr(buf, 'mci error', n); return 1; });

class GuestExit extends Error { constructor(code) { super('guest exited with code ' + code); this.code = code; } }

// ---- OpenGL 1.1 subset: forwarded to PLAT.gl ----
const G = (name, n, f) => def(name, n, f || ((...a) => { PLAT.gl[name](...a.slice(0, n)); }));
const F = (v) => { i32[0x7fd000 >> 2] = v; return f32[0x7fd000 >> 2]; };      // reinterpret a stack dword as float
const D = (lo, hi) => { i32[0x7fd000 >> 2] = lo; i32[0x7fd004 >> 2] = hi; return f64[0x7fd000 >> 3]; };
G('glEnable', 1); G('glDisable', 1); G('glBlendFunc', 2); G('glDepthFunc', 1); G('glDepthMask', 1); G('glBegin', 1); G('glEnd', 0); G('glMatrixMode', 1); G('glLoadIdentity', 0);
G('glClear', 1); G('glFlush', 0); G('glFinish', 0); G('glViewport', 4); G('glHint', 2); G('glBindTexture', 2); G('glTexParameteri', 3); G('glTexEnvi', 3); G('glPixelStorei', 2); G('glCullFace', 1); G('glFrontFace', 1); G('glShadeModel', 1); G('glPolygonMode', 2);
G('glScissor', 4); G('glColorMask', 4); G('glDrawBuffer', 1); G('glReadBuffer', 1);
G('glTexParameterf', 3, (t, p, v) => PLAT.gl.glTexParameterf(t, p, F(v))); G('glTexEnvf', 3, (t, p, v) => PLAT.gl.glTexEnvf(t, p, F(v)));
G('glAlphaFunc', 2, (f, r) => PLAT.gl.glAlphaFunc(f, F(r)));
G('glVertex3f', 3, (x, y, z) => PLAT.gl.glVertex3f(F(x), F(y), F(z))); G('glVertex2f', 2, (x, y) => PLAT.gl.glVertex3f(F(x), F(y), 0));
G('glVertex3fv', 1, (p) => PLAT.gl.glVertex3f(rf32(p), rf32(p + 4), rf32(p + 8)));
G('glTexCoord2f', 2, (s, t) => PLAT.gl.glTexCoord4f(F(s), F(t), 0, 1)); G('glTexCoord4fv', 1, (p) => PLAT.gl.glTexCoord4f(rf32(p), rf32(p + 4), rf32(p + 8), rf32(p + 12)));
G('glTexCoord2fv', 1, (p) => PLAT.gl.glTexCoord4f(rf32(p), rf32(p + 4), 0, 1));
G('glColor4f', 4, (r, g, b, a) => PLAT.gl.glColor4f(F(r), F(g), F(b), F(a))); G('glColor3f', 3, (r, g, b) => PLAT.gl.glColor4f(F(r), F(g), F(b), 1));
G('glColor4ub', 4, (r, g, b, a) => PLAT.gl.glColor4f((r & 255) / 255, (g & 255) / 255, (b & 255) / 255, (a & 255) / 255));
G('glColor4ubv', 1, (p) => PLAT.gl.glColor4f(u8[p] / 255, u8[p + 1] / 255, u8[p + 2] / 255, u8[p + 3] / 255));
G('glColor3ub', 3, (r, g, b) => PLAT.gl.glColor4f((r & 255) / 255, (g & 255) / 255, (b & 255) / 255, 1));
G('glClearColor', 4, (r, g, b, a) => PLAT.gl.glClearColor(F(r), F(g), F(b), F(a)));
G('glClearDepth', 2, (lo, hi) => PLAT.gl.glClearDepth(D(lo, hi)));
G('glDepthRange', 4, (a, b, c, d) => PLAT.gl.glDepthRange(D(a, b), D(c, d)));
G('glOrtho', 12, (a, b, c, d, e, f, g, h, i, j, k, l) => PLAT.gl.glOrtho(D(a, b), D(c, d), D(e, f), D(g, h), D(i, j), D(k, l)));
G('glTranslatef', 3, (x, y, z) => PLAT.gl.glTranslatef(F(x), F(y), F(z))); G('glScalef', 3, (x, y, z) => PLAT.gl.glScalef(F(x), F(y), F(z)));
G('glGenTextures', 2, (n, p) => { for (let i = 0; i < n; i++) w32(p + i * 4, PLAT.gl.genTexture()); });
G('glDeleteTextures', 2, (n, p) => { for (let i = 0; i < n; i++) PLAT.gl.deleteTexture(r32(p + i * 4)); });
G('glTexImage2D', 9, (target, level, ifmt, w, h, border, fmt, type, p) => PLAT.gl.glTexImage2D(target, level, ifmt, w, h, fmt, type, p));
G('glTexSubImage2D', 9, (target, level, x, y, w, h, fmt, type, p) => PLAT.gl.glTexSubImage2D(target, level, x, y, w, h, fmt, type, p));
G('gluBuild2DMipmaps', 7, (target, ifmt, w, h, fmt, type, p) => { PLAT.gl.glTexImage2D(target, 0, ifmt, w, h, fmt, type, p, true); return 0; });
G('glGetError', 0, ret0);
const glStrings = new Map();
G('glGetString', 1, (name) => { if (!glStrings.has(name)) { const s = { 0x1f00: 'Lost Formulas Web', 0x1f01: 'WebGL bridge', 0x1f02: '1.1.0', 0x1f03: 'GL_EXT_bgra GL_EXT_texture_env_add' }[name] || ''; const p = galloc(s.length + 1); wstr(p, s); glStrings.set(name, p); } return glStrings.get(name); });
G('glGetIntegerv', 2, (name, p) => { w32(p, name === 0x0d33 ? 1024 : 0); });
G('glGetFloatv', 2, (name, p) => { wf32(p, 0); });

function bootGuest(image, imageBase, entry, imports) {
  u8.set(image, imageBase);
  for (const [iatAddr, name] of imports) w32(iatAddr, hostAddr(name));
  // thread information block: SEH chain end, stack limits
  w32(FSB, -1); w32(FSB + 4, 0x1ff00000); w32(FSB + 8, 0x1f100000); w32(FSB + 0x18, FSB);
  esp = 0x1fefff00; w32(esp, STOP);
  return entry;
}

// ---- COM helper + DirectSound (with DirectSound3D) ----
function makeCom(name, methods) {           // methods: [[nargs including this, fn(this,...)] ...]
  const vt = galloc(methods.length * 4);
  methods.forEach((m, i) => { const key = name + '#' + i; API[key] = { n: m[0], f: m[1] || (() => { if (PLAT.trace) PLAT.log('COM stub ' + key); return 0; }) }; w32(vt + i * 4, hostAddr(key)); });
  return () => { const o = galloc(8, true); w32(o, vt); return o; };
}
const dsBuffers = new Map();                // COM object address -> state
let dsListenerObj = 0, dsDistanceFactor = 1;
const E_NOINTERFACE = 0x80004002 | 0;
const guidHex = (p) => Array.from(u8.subarray(p, p + 16), b => b.toString(16).padStart(2, '0')).join('');
function dsVoice(b) { return PLAT.audio; }
let newDSBuffer, newDS3DBuffer, newDSListener, newDS;
function initDSound() {
  if (newDS) return;
  const A = () => PLAT.audio;
  newDSListener = makeCom('IDirectSound3DListener', [[3], [1, () => 1], [1, () => 0],
    [2, (t, p) => { u8.fill(0, p + 4, p + 64); wf32(p + 36, 1); wf32(p + 44, 1); wf32(p + 52, dsDistanceFactor); wf32(p + 56, 1); wf32(p + 60, 1); return 0; }],
    [2], [2], [3], [2], [2], [2],
    [3, (t, p) => { dsDistanceFactor = rf32(p + 52) || 1; A().setListener([rf32(p + 4), rf32(p + 8), rf32(p + 12)], [rf32(p + 28), rf32(p + 32), rf32(p + 36)], [rf32(p + 40), rf32(p + 44), rf32(p + 48)], dsDistanceFactor); return 0; }],
    [3, (t, f) => { dsDistanceFactor = F(f) || 1; return 0; }], [3], [8, (t, fx, fy, fz, tx, ty, tz) => { A().setListener(null, [F(fx), F(fy), F(fz)], [F(tx), F(ty), F(tz)], dsDistanceFactor); return 0; }],
    [5, (t, x, y, z) => { A().setListener([F(x), F(y), F(z)], null, null, dsDistanceFactor); return 0; }], [3], [5], [1]]);
  const owner = (t) => dsBuffers.get(r32(t + 4));
  newDS3DBuffer = makeCom('IDirectSound3DBuffer', [[3], [1, () => 1], [1, () => 0],
    [2, (t, p) => { const b = owner(t); u8.fill(0, p + 4, p + 64); if (b) { wf32(p + 4, b.pos[0]); wf32(p + 8, b.pos[1]); wf32(p + 12, b.pos[2]); wf32(p + 52, b.minD); wf32(p + 56, b.maxD); w32(p + 60, b.mode); } w32(p + 28, 360); w32(p + 32, 360); return 0; }],
    [3], [2], [2], [2, (t, p) => { wf32(p, owner(t).maxD); return 0; }], [2, (t, p) => { wf32(p, owner(t).minD); return 0; }], [2, (t, p) => { w32(p, owner(t).mode); return 0; }], [2], [2],
    [3, (t, p) => { const b = owner(t); b.pos = [rf32(p + 4), rf32(p + 8), rf32(p + 12)]; b.minD = rf32(p + 52); b.maxD = rf32(p + 56); b.mode = r32(p + 60); b.is3d = true; A().update(b); return 0; }],
    [4], [5], [3], [3, (t, d) => { const b = owner(t); b.maxD = F(d); A().update(b); return 0; }], [3, (t, d) => { const b = owner(t); b.minD = F(d); A().update(b); return 0; }],
    [3, (t, m) => { const b = owner(t); b.mode = m; A().update(b); return 0; }], [5, (t, x, y, z) => { const b = owner(t); b.pos = [F(x), F(y), F(z)]; b.is3d = true; A().update(b); return 0; }], [5]]);
  const B = (t) => dsBuffers.get(t);
  function createBuffer(desc, shareFrom) {
    const o = newDSBuffer(); let b;
    if (shareFrom) b = Object.assign({}, shareFrom, { obj: o, voice: 0, playing: false, obj3d: 0 });
    else { const flags = r32(desc + 4), bytes = r32(desc + 8), fmt = r32(desc + 16);
      b = { obj: o, primary: !!(flags & 1), flags, bytes, data: bytes ? galloc(bytes, true) : 0, ch: fmt ? r16(fmt + 2) : 2, rate: fmt ? r32(fmt + 4) : 22050, bits: fmt ? r16(fmt + 14) : 16, vol: 0, pan: 0, freq: 0, loop: false, playing: false, pos: [0, 0, 0], minD: 1, maxD: 1e9, mode: 0, is3d: false, obj3d: 0, startT: 0 }; }
    dsBuffers.set(o, b); return o;
  }
  newDSBuffer = makeCom('IDirectSoundBuffer', [
    [3, (t, iid, out) => { const b = B(t), g = guidHex(iid);
      if (g.startsWith('86fa9a27')) { if (!b.obj3d) { b.obj3d = newDS3DBuffer(); w32(b.obj3d + 4, t); } b.is3d = true; w32(out, b.obj3d); return 0; }
      if (g.startsWith('84fa9a27')) { if (!dsListenerObj) dsListenerObj = newDSListener(); w32(out, dsListenerObj); return 0; }
      if (PLAT.trace) PLAT.log('DS buffer QI ' + g); w32(out, 0); return E_NOINTERFACE; }],
    [1, () => 2], [1, (t) => { const b = B(t); if (b && !b.primary) { A().stop(b); b.playing = false; } return 0; }],
    [2, (t, p) => { const b = B(t); w32(p + 4, b.flags); w32(p + 8, b.bytes); w32(p + 12, 0); w32(p + 16, 0); return 0; }],
    [3, (t, pp, pw) => { const b = B(t); let pos = 0; if (b.playing) pos = (Math.floor((PLAT.now() - b.startT) / 1000 * (b.freq || b.rate)) * (b.ch * b.bits / 8)) % Math.max(1, b.bytes); if (pp) w32(pp, pos); if (pw) w32(pw, pos); return 0; }],
    [4, (t, p, n, pn) => { const b = B(t); if (p) { w16(p, 1); w16(p + 2, b.ch); w32(p + 4, b.rate); w32(p + 8, b.rate * b.ch * b.bits / 8); w16(p + 12, b.ch * b.bits / 8); w16(p + 14, b.bits); w16(p + 16, 0); } if (pn) w32(pn, 18); return 0; }],
    [2, (t, p) => { w32(p, B(t).vol); return 0; }], [2, (t, p) => { w32(p, B(t).pan); return 0; }], [2, (t, p) => { w32(p, B(t).freq || B(t).rate); return 0; }],
    [2, (t, p) => { const b = B(t); if (b.playing && !b.loop && !A().isPlaying(b)) b.playing = false; w32(p, b.playing ? (b.loop ? 5 : 1) : 0); return 0; }],
    [3],
    [8, (t, off, n, p1, n1, p2, n2, fl) => { const b = B(t); if (fl & 2) { off = 0; n = b.bytes; } n = Math.min(n >>> 0, b.bytes); const first = Math.min(n, b.bytes - off); w32(p1, b.data + off); w32(n1, first); if (p2) w32(p2, first < n ? b.data : 0); if (n2) w32(n2, n - first); return 0; }],
    [4, (t, r1, r2, flags) => { const b = B(t); if (b.primary) return 0; b.loop = !!(flags & 1); b.playing = true; b.startT = PLAT.now(); A().play(b, u8); return 0; }],
    [2, () => 0], [2, (t, fmt) => { const b = B(t); if (fmt) { b.ch = r16(fmt + 2); b.rate = r32(fmt + 4); b.bits = r16(fmt + 14); } return 0; }],
    [2, (t, v) => { const b = B(t); b.vol = v; A().update(b); return 0; }], [2, (t, v) => { const b = B(t); b.pan = v; A().update(b); return 0; }], [2, (t, v) => { const b = B(t); b.freq = v; A().update(b); return 0; }],
    [1, (t) => { const b = B(t); b.playing = false; A().stop(b); return 0; }], [5, () => 0], [1, () => 0]]);
  newDS = makeCom('IDirectSound', [[3], [1, () => 1], [1, () => 0],
    [4, (t, desc, out) => { w32(out, createBuffer(desc)); return 0; }],
    [2, (t, p) => { const n = r32(p); u8.fill(0, p + 4, p + n); w32(p + 4, 0xf5f); w32(p + 8, 8000); w32(p + 12, 48000); w32(p + 16, 1); return 0; }],
    [3, (t, src, out) => { w32(out, createBuffer(0, B(src))); return 0; }],
    [3, () => 0], [1], [2, (t, p) => { w32(p, 4); return 0; }], [2], [2]]);
}
def('DirectSoundCreate', 3, (guid, out) => { initDSound(); w32(out, newDS()); return 0; });

// ---- Bink video, emulated at the API level ----
// The real decoder is not run. If the user has a converted copy of the video (same name, .webm/.mp4), PLAT.video plays it
// in an overlay above the canvas and the game's playback loop is fed a BINK structure with matching frame counts and timing.
const BINK_FPS = 15; let binkObj = 0, binkFrame = 0;
def('BinkSetSoundSystem', 2, ret1); def('BinkOpenDirectSound', 1, ret1); def('BinkSetSoundOnOff', 2, ret1); def('BinkSetSoundTrack', 1, ret0); def('BinkSetVolume', 3, ret0);
def('BinkOpen', 2, (pname, flags) => {
  if (!PLAT.video) return 0;
  const st = PLAT.video.open(gstr(pname));
  if (st === 'pending') return RETRY;
  if (st !== 'ready') return 0;
  if (!binkObj) binkObj = galloc(0x400, true); else u8.fill(0, binkObj, binkObj + 0x400);
  const frames = Math.max(2, Math.ceil(PLAT.video.duration() * BINK_FPS));
  w32(binkObj, 320); w32(binkObj + 4, 240); w32(binkObj + 8, frames); w32(binkObj + 12, 1); w32(binkObj + 16, 1); w32(binkObj + 20, BINK_FPS); w32(binkObj + 24, 1);
  binkFrame = 1; return binkObj;
});
def('BinkWait', 1, () => { if (!PLAT.video || PLAT.video.ended() || PLAT.video.time() * BINK_FPS >= binkFrame) return 0; yieldFlag = true; return 1; });
def('BinkDoFrame', 1, ret0);
def('BinkNextFrame', 1, (b) => { binkFrame++; w32(b + 12, binkFrame); });
def('BinkCopyToBuffer', 7, ret0); def('BinkCopyToBufferRect', 11, ret0);
def('BinkClose', 1, () => { if (PLAT.video) PLAT.video.close(); }); def('BinkBufferClose', 1, ret0); def('BinkDDSurfaceType', 1, () => 3);
def('BinkGoto', 3, ret0); def('BinkPause', 2, ret0); def('BinkGetError', 0, ret0);
