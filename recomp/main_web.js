// ---- browser front end: file loading, input, frame loop ----
(() => {
  const $ = (id) => document.getElementById(id);
  const logEl = $('log'), canvas = $('screen');
  const log = (s) => { const d = document.createElement('div'); d.textContent = s; logEl.appendChild(d); while (logEl.children.length > 400) logEl.firstChild.remove(); logEl.scrollTop = logEl.scrollHeight; };
  const busy = (msg) => { const o = $('overlay'); if (!o) return; o.hidden = !msg; if (msg) $('ovmsg').textContent = msg; };
  const pickerEnabled = (on) => $('picker').querySelectorAll('button,input').forEach(e => e.disabled = !on);
  function fail(msg) { busy(null); log(msg); $('picker').hidden = false; pickerEnabled(true); const a = $('adv'); if (a) a.open = true; $('status').textContent = msg; }
  const vfs = new Map();            // '\DATA\LEVEL01\L01P1.OFF' -> Uint8Array
  const DEFAULT_CFG = ['set G_ScreenX 640', 'set G_ScreenY 480', 'set G_BitDepth 32', 'set G_Refresh 60', 'set G_FullScreen 0', 'set G_Renderer 1', 'set G_Device 0', 'set G_Antialias 0', 'set G_Tripple 0', 'set G_Trilinear 1', 'set G_ModeNum 1', 'set G_RefNum 0', 'set G_CheatEnable 1', 'set G_VSync 0', 'set G_BinkHi 0', 'set G_BinkFitToScreen 1', 'set G_Quality 0', 'set G_SwapStereo 0',
    'set CTRL1_LEFT 203', 'set CTRL2_LEFT 75', 'set CTRL1_RIGHT 205', 'set CTRL2_RIGHT 77', 'set CTRL1_UP 200', 'set CTRL2_UP 72', 'set CTRL1_DOWN 208', 'set CTRL2_DOWN 80', 'set CTRL1_JUMP 57', 'set CTRL2_JUMP 36', 'set CTRLJ_JUMP 0', 'set CTRL1_ATTACK 56', 'set CTRL2_ATTACK 30', 'set CTRLJ_ATTACK 1', 'set CTRL1_INFO 59', 'set CTRL2_INFO -1', 'set CTRLJ_INFO 2', 'set CTRL1_MENU 50', 'set CTRL2_MENU -1', 'set CTRLJ_MENU 3', 'set VOLUME_SFX 80', 'set VOLUME_MIDI 20', ''].join('\r\n');
  const enc = (s) => Uint8Array.from(s, c => c.charCodeAt(0) & 255);
  const saveKey = (n) => 'lostformulas:' + n;
  const strip = (n) => n.replace(/^[A-Z]:/, '').replace(/^(?!\\)/, '\\');

  // ---- audio: DirectSound voices on Web Audio, MIDI music through a small built-in synthesizer ----
  let actx = null, synth = null, master = null; const midi = { file: null, playing: false, vol: 0.2 };
  const vec = (v) => v && v.every(Number.isFinite) && (v[0] || v[1] || v[2]);
  const audio = {
    init() { try { actx = new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); master = actx.createGain(); master.gain.value = 0.8; master.connect(actx.destination); } catch (e) { log('Audio is not available: ' + e.message); } },
    gainOf: (b) => Math.pow(10, Math.max(-10000, Math.min(0, b.vol)) / 2000),
    play(b, mem) {
      if (!actx || !b.bytes) return; audio.stop(b);
      const bps = b.bits / 8, frames = Math.floor(b.bytes / (bps * b.ch)); if (!frames) return;
      const buf = actx.createBuffer(b.ch, frames, Math.max(3000, Math.min(96000, b.rate)));
      for (let c = 0; c < b.ch; c++) { const out = buf.getChannelData(c); let p = b.data + c * bps;
        if (b.bits === 16) for (let i = 0; i < frames; i++, p += bps * b.ch) out[i] = ((mem[p] | (mem[p + 1] << 8)) << 16 >> 16) / 32768;
        else for (let i = 0; i < frames; i++, p += b.ch) out[i] = (mem[p] - 128) / 128; }
      const src = actx.createBufferSource(); src.buffer = buf; src.loop = b.loop; const g = actx.createGain(); src.connect(g);
      let last = g;
      if (b.is3d && b.mode !== 2) { const pn = actx.createPanner(); pn.panningModel = 'equalpower'; pn.distanceModel = 'inverse'; g.connect(pn); last = pn; b._pn = pn; }
      else if (actx.createStereoPanner) { const sp = actx.createStereoPanner(); g.connect(sp); last = sp; b._sp = sp; }
      last.connect(master); b._src = src; b._g = g; b._alive = true; src.onended = () => { if (b._src === src) b._alive = false; };
      audio.update(b); src.start();
    },
    stop(b) { if (b._src) { try { b._src.onended = null; b._src.stop(); } catch (e) {} b._src = null; } b._alive = false; b._pn = b._sp = null; },
    isPlaying: (b) => !!b._alive,
    update(b) {
      if (!b._src) return; b._g.gain.value = audio.gainOf(b); b._src.playbackRate.value = Math.max(0.05, Math.min(8, (b.freq || b.rate) / b.rate));
      if (b._sp) b._sp.pan.value = Math.max(-1, Math.min(1, b.pan / 5000));
      if (b._pn && vec(b.pos.map(v => v + 1e-9))) { const f = audio.df; b._pn.refDistance = Math.max(1e-3, b.minD * f); b._pn.maxDistance = Math.max(b._pn.refDistance, Math.min(1e9, b.maxD * f)); b._pn.setPosition(b.pos[0] * f, b.pos[1] * f, -b.pos[2] * f); }
    },
    df: 1,
    setListener(pos, front, top, df) { if (!actx) return; audio.df = df || 1; const L = actx.listener;
      if (pos && pos.every(Number.isFinite)) L.setPosition(pos[0] * audio.df, pos[1] * audio.df, -pos[2] * audio.df);
      if (vec(front) && vec(top)) L.setOrientation(front[0], front[1], -front[2], top[0], top[1], -top[2]); },
  };
  function setVolume(kind, v) { if (kind === 'wave') { if (master) master.gain.value = v; } else { midi.vol = v; if (synth) synth.setMasterVol(v * 1.2); } }
  function mci(id, msg, flags, parm) {
    if (msg === 0x803) { midi.file = strip(normPath(gstr(r32(parm + 12)))); w32(parm + 4, 1); return 0; }
    if (msg === 0x806) { const d = vfs.get(midi.file); if (!d || !actx) return 0;
      try { if (!synth) { synth = new WebAudioTinySynth({ quality: 1, useReverb: 0, voices: 48 }); synth.setAudioContext(actx); synth.setMasterVol(midi.vol * 1.2); }
        synth.stopMIDI(); synth.loadMIDI(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)); synth.setLoop(1); synth.playMIDI(); midi.playing = true; } catch (e) { log('Music could not start: ' + e.message); }
      return 0; }
    if (msg === 0x808 || msg === 0x804 || msg === 0x809) { if (synth && midi.playing) { try { synth.stopMIDI(); } catch (e) {} midi.playing = false; } return 0; }
    if (msg === 0x814) { w32(parm + 4, r32(parm + 8) === 4 ? (midi.playing ? 526 : 525) : 0); return 0; }
    return 0;
  }

  // ---- where the game files come from ----
  // Three sources feed one virtual file system: files sitting next to this page, an ISO (local file or web address),
  // or a folder the user picks. The first two arrive lazily: CreateFileA asks PLAT.pending() and the host layer
  // repeats the call each frame (RETRY) until the bytes are there, so the game simply waits on its loading screen.
  const disc = { src: null, table: null, root: '', dirs: new Map(), key: '' };
  const webf = { base: null, paths: new Map(), seen: new Set(), busy: new Set(), failed: new Set(), queue: [], inflight: 0 };
  const biks = new Map();           // '\DATA\CINELOW\LOGO0.BIK' -> File, when the user picked a folder
  const dirOf = (k) => k.slice(0, k.lastIndexOf('\\') + 1);
  const SKIP = /\.(BIK|EXE|DLL|ICO|INF|ISO)$/;
  const urlFor = (rel) => webf.base + rel.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');

  function idb(store) { return new Promise((ok) => { try { const r = indexedDB.open('lostformulas-disc', 2); r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains('dirs')) db.createObjectStore('dirs'); if (!db.objectStoreNames.contains('videos')) db.createObjectStore('videos'); }; r.onsuccess = () => ok(r.result); r.onerror = () => ok(null); } catch (e) { ok(null); } }); }
  async function idbGet(store, key) { const db = await idb(); if (!db) return null; return new Promise((ok) => { try { const q = db.transaction(store).objectStore(store).get(key); q.onsuccess = () => ok(q.result || null); q.onerror = () => ok(null); } catch (e) { ok(null); } }); }
  async function idbPut(store, key, val) { const db = await idb(); if (!db) return; try { db.transaction(store, 'readwrite').objectStore(store).put(val, key); } catch (e) {} }

  // --- files next to this page (or in a sub-folder), located through the retail CD's own file list ---
  function webPump() {
    while (webf.inflight < 6 && webf.queue.length) {
      const k = webf.queue.shift(); if (vfs.has(k) || webf.busy.has(k)) continue;
      webf.busy.add(k); webf.inflight++;
      fetch(urlFor(webf.paths.get(k))).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then(buf => { vfs.set(k, new Uint8Array(buf)); })
        .catch(e => { webf.failed.add(k); log('Could not load ' + k + ' (' + e.message + ')'); })
        .then(() => { webf.busy.delete(k); webf.inflight--; webPump(); });
    }
  }
  function webWant(k, urgent) {
    if (vfs.has(k) || webf.busy.has(k) || webf.failed.has(k) || !webf.paths.has(k)) return;
    const at = webf.queue.indexOf(k);
    if (at >= 0) { if (urgent && at > 0) { webf.queue.splice(at, 1); webf.queue.unshift(k); } return; }
    urgent ? webf.queue.unshift(k) : webf.queue.push(k); webPump();
  }
  function webPrefetchDir(dir) {
    if (webf.seen.has(dir)) return; webf.seen.add(dir);
    for (const k of webf.paths.keys()) if (dirOf(k) === dir && !SKIP.test(k)) webWant(k, false);
  }

  // --- a directory of an ISO, fetched as a few large spans ---
  async function loadDir(dir, label) {
    if (disc.dirs.has(dir)) return disc.dirs.get(dir).promise;
    const st = { state: 'loading' }; disc.dirs.set(dir, st);
    st.promise = (async () => {
      const entries = []; for (const [k, e] of disc.table) { if (k.startsWith(disc.root + dir) && !k.slice((disc.root + dir).length).includes('\\') && !SKIP.test(k)) entries.push({ path: k.slice(disc.root.length), off: e.off, size: e.size }); }
      const ckey = disc.key + '|' + dir; let files = await idbGet('dirs', ckey);
      if (files) log(`${label || dir}: ${files.length} files from this browser's cache.`);
      else { const t = performance.now(); const got = await ISO.fetchFiles(disc.src, entries, (d, tot) => busy(`Loading ${label || dir}: ${(d / 1048576).toFixed(1)} of ${(tot / 1048576).toFixed(1)} MB`));
        files = [...got]; log(`${label || dir}: ${files.length} files, ${(files.reduce((s, f) => s + f[1].length, 0) / 1048576).toFixed(1)} MB in ${((performance.now() - t) / 1000).toFixed(1)} s.`); idbPut('dirs', ckey, files); }
      for (const [k, d] of files) vfs.set(k, d); st.state = 'done'; busy(null);
    })().catch((e) => { st.state = 'failed'; busy(null); log(`Loading ${label || dir} failed: ${e.message}`); });
    return st.promise;
  }

  function filePending(name) {                     // called by the host layer for every CreateFileA
    const k = strip(name);
    if (vfs.has(k) || SKIP.test(k)) return false;
    if (disc.table) { if (!disc.table.has(disc.root + k)) return false; const dir = dirOf(k); loadDir(dir, dir.replace(/^\\DATA\\/, '').replace(/\\$/, '')); return disc.dirs.get(dir).state === 'loading'; }
    if (webf.base !== null) { if (!webf.paths.has(k) || webf.failed.has(k)) return false; webWant(k, true); webPrefetchDir(dirOf(k)); return !vfs.has(k); }
    return false;
  }
  // Read one file that is not part of normal game loading (the video files), whatever the source is.
  async function readAside(k) {
    if (vfs.has(k) && !SKIP.test(k)) return vfs.get(k);
    if (biks.has(k)) return new Uint8Array(await biks.get(k).arrayBuffer());
    if (disc.table && disc.table.has(disc.root + k)) { const e = disc.table.get(disc.root + k); const got = await ISO.fetchFiles(disc.src, [{ path: k, off: e.off, size: e.size }], (d, t) => busy(`Loading video: ${(d / 1048576).toFixed(1)} of ${(t / 1048576).toFixed(1)} MB`)); busy(null); return got.get(k) || null; }
    if (webf.base !== null && webf.paths.has(k)) { const r = await fetch(urlFor(webf.paths.get(k))); if (!r.ok) throw new Error('HTTP ' + r.status); return new Uint8Array(await r.arrayBuffer()); }
    return null;
  }

  // ---- cutscenes: the game's Bink files are decoded in the browser by ffmpeg.wasm and cached ----
  // No converted copies need to exist anywhere: the .bik is transcoded to WebM once per viewer, then kept in
  // IndexedDB. A pre-converted .webm/.mp4 alongside the game is still used directly when present.
  const FFCORE_DEFAULT = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js';
  const media = new Map();          // 'LOGO0' -> Blob/File, pre-converted copies the user supplied
  const ff = { worker: null, next: 1, jobs: new Map(), coreURL: null, core: null };
  function ffCoreURL() {
    if (ff.coreURL) return ff.coreURL;
    const q = new URLSearchParams(location.search).get('ffmpeg');
    ff.coreURL = q || (webf.base !== null ? new URL('ffmpeg-core.js', new URL(webf.base, location.href)).href : null) || FFCORE_DEFAULT;
    return ff.coreURL;
  }
  function ffStart() {
    if (ff.worker) return ff.worker;
    const src = `let core = null, ready = null;
      self.onmessage = async (e) => { const m = e.data;
        try {
          if (!ready) ready = (async () => {
            importScripts(URL.createObjectURL(new Blob([m.coreJS], { type: 'text/javascript' })));
            return await createFFmpegCore({ wasmBinary: m.wasmBinary, locateFile: (p) => (p.endsWith('.wasm') && m.wasmURL) ? m.wasmURL : p, print: (s) => postMessage({ log: s }), printErr: (s) => postMessage({ log: s }) });
          })();
          core = await ready;
          core.setLogger((x) => postMessage({ log: (x && x.message) || '' }));
          core.setTimeout(-1);
          core.FS.writeFile(m.name, m.data);
          const code = core.exec(...m.args);
          core.reset();
          if (code !== 0 && code !== undefined) throw new Error('the decoder reported error ' + code);
          const out = core.FS.readFile('out.webm');
          try { core.FS.unlink(m.name); core.FS.unlink('out.webm'); } catch (x) {}
          if (!out || !out.length) throw new Error('the decoder produced nothing');
          postMessage({ id: m.id, out }, [out.buffer]);
        } catch (err) { ready = null; postMessage({ id: m.id, error: String((err && err.message) || err) }); } };`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = (e) => { const d = e.data;
      if (d.log !== undefined) { const fm = /frame=\s*(\d+)/.exec(d.log); if (fm && ff.cur) busy(`Preparing the video (frame ${fm[1]}${ff.cur.frames ? ' of about ' + ff.cur.frames : ''})`); if (/Error|Invalid|No such|Unknown/i.test(d.log)) ff.lastErr = d.log; return; }
      const j = ff.jobs.get(d.id); if (!j) return; ff.jobs.delete(d.id);
      d.error ? j.rej(new Error(d.error + (ff.lastErr ? ' - ' + ff.lastErr : ''))) : j.ok(d.out);
    };
    w.onerror = (e) => { for (const j of ff.jobs.values()) j.rej(new Error('the video decoder could not start (' + (e.message || 'worker error') + ')')); ff.jobs.clear(); ff.worker = null; };
    ff.worker = w; return w;
  }
  async function ffCore() {                    // fetched here, not inside the worker, so the host's MIME types do not matter
    if (ff.core) return ff.core;
    const url = ffCoreURL(), wurl = url.replace(/\.js$/, '.wasm');
    busy('Fetching the video decoder (one time, about 32 MB)');
    const grab = async (u, how) => { const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + u); return how === 'text' ? r.text() : r.arrayBuffer(); };
    const [js, wasm] = await Promise.all([grab(url, 'text'), grab(wurl, 'bin')]);
    ff.core = { js, wasm }; return ff.core;
  }
  async function ffTranscode(name, data) {
    const core = await ffCore(), id = ff.next++;
    const args = ['-hide_banner', '-nostdin', '-i', name, '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1500k', '-c:a', 'libopus', '-b:a', '96k', '-f', 'webm', 'out.webm'];
    return new Promise((ok, rej) => { ff.jobs.set(id, { ok, rej });
      ffStart().postMessage({ id, coreJS: core.js, wasmBinary: core.wasm, name, data, args }, [data.buffer]); });
  }

  const vid = { el: null, state: 'none', stem: '', failed: new Set(), t0: 0 };
  async function prepareVideo(path, stem) {
    let blob = media.get(stem);
    if (!blob) {
      const raw = await readAside(strip(path));
      if (!raw || raw.length < 64) return null;                       // no such video: the game skips it, as it does without Bink
      const key = stem + ':' + raw.length;
      const cached = await idbGet('videos', key);
      if (cached) blob = new Blob([cached], { type: 'video/webm' });
      else {
        busy('Preparing the video (first time only)');
        ff.cur = { frames: 0 }; const t = performance.now();
        const out = await ffTranscode(stem + '.bik', raw);
        log(`Decoded ${stem}.bik in ${((performance.now() - t) / 1000).toFixed(1)} s (${(out.length / 1048576).toFixed(1)} MB kept in this browser).`);
        idbPut('videos', key, out); blob = new Blob([out], { type: 'video/webm' });
      }
    }
    busy(null); return blob;
  }
  const video = {
    open(path) {
      const stem = path.replace(/^.*[\\\/]/, '').replace(/\.[^.]*$/, '').toUpperCase();
      if (vid.failed.has(stem)) return 'none';
      if (vid.stem === stem) { if (vid.state !== 'pending') { const s = vid.state; if (s !== 'ready') video.close(); return s; } return 'pending'; }
      vid.stem = stem; vid.state = 'pending'; vid.t0 = performance.now();
      prepareVideo(path, stem).then((blob) => {
        if (vid.stem !== stem) return;
        if (!blob) { vid.state = 'none'; vid.failed.add(stem); return; }
        const el = document.createElement('video'); el.playsInline = true; el.className = 'cine'; el.src = URL.createObjectURL(blob);
        vid.el = el;
        el.addEventListener('loadedmetadata', () => { if (vid.el !== el) return; vid.state = 'ready'; const pr = el.play(); if (pr && pr.catch) pr.catch(() => { el.muted = true; el.play().catch(() => { vid.state = 'error'; }); }); });
        el.addEventListener('error', () => { if (vid.el !== el) return; vid.state = 'error'; });
        $('stage').appendChild(el);
      }).catch((e) => { if (vid.stem !== stem) return; vid.state = 'none'; vid.failed.add(stem); busy(null); log('Skipping the video for ' + stem + ': ' + e.message); });
      return 'pending';
    },
    duration: () => (vid.el && isFinite(vid.el.duration) ? vid.el.duration : 1),
    time: () => (vid.el ? vid.el.currentTime : 0),
    ended: () => !vid.el || vid.el.ended || vid.state === 'error',
    close() { if (vid.el) { try { vid.el.pause(); URL.revokeObjectURL(vid.el.src); } catch (e) {} vid.el.remove(); } vid.el = null; vid.state = 'none'; vid.stem = ''; canvas.focus(); },
  };

  async function startFromDisc(src) {
    try {
      pickerEnabled(false);
      log(src.kind === 'url' ? 'Reading the disc image index from ' + src.url : 'Reading the disc image.');
      busy('Reading the disc image');
      disc.src = src; disc.key = src.url; disc.table = await ISO.readTable(src, log);
      const anchor = [...disc.table.keys()].find(k => /\\DATA\\ROBOTS\\YELLOW\.GRP$/i.test(k));
      if (!anchor) throw new Error('DATA\\ROBOTS\\YELLOW.GRP is not on this disc image');
      disc.root = anchor.slice(0, anchor.length - '\\DATA\\ROBOTS\\YELLOW.GRP'.length);
      for (const d of ['BASEDATA', 'SOUND', 'ROBOTS', 'GROUPS', 'MUSIC']) await loadDir('\\DATA\\' + d + '\\', d);
      if ([...disc.dirs.values()].some(s => s.state === 'failed')) throw new Error('a start-up download failed (see above)');
      if (src.kind === 'url') log(`Start-up data ready; ${(src.bytesFetched() / 1048576).toFixed(1)} MB downloaded this session. Levels load when first entered.`);
      start();
    } catch (e) { fail('Could not read the disc image. ' + e.message + (e.name === 'TypeError' ? ' (a TypeError usually means the browser blocked the request: check the Network tab of the developer tools)' : '')); }
  }

  // Look for the game next to this page: an ISO, or the CD's files (possibly in a sub-folder).
  async function probe(url) { try { const r = await fetch(url, { method: 'HEAD' }); if (r.ok) return true; } catch (e) {} try { const r = await fetch(url, { headers: { Range: 'bytes=0-0' } }); return r.ok; } catch (e) { return false; } }
  async function autoStart() {
    const q = new URLSearchParams(location.search), here = location.href.replace(/[^\/]*$/, '');
    const isoParam = q.get('iso'), folder = q.get('game');
    if (isoParam) { startFromDisc(ISO.rangeSource(new URL(isoParam, here).href, log)); return true; }
    if (location.protocol === 'file:') return false;                  // fetch is blocked for local files
    busy('Looking for the game files');
    for (const base of (folder ? [folder.replace(/\/*$/, '/')] : ['', 'game/', 'cd/'])) {
      const root = new URL(base, here).href;
      if (await probe(root + 'DATA/ROBOTS/YELLOW.GRP')) {
        webf.base = root;
        for (const p of CDFILES) webf.paths.set('\\' + p.toUpperCase().replace(/\//g, '\\'), p);
        log('Found the game files at ' + root);
        for (const d of ['\\DATA\\BASEDATA\\', '\\DATA\\SOUND\\', '\\DATA\\ROBOTS\\', '\\DATA\\GROUPS\\', '\\DATA\\MUSIC\\']) webPrefetchDir(d);
        start(); return true;
      }
      for (const name of ['game.iso', 'lost-formulas.iso']) if (await probe(root + name)) { startFromDisc(ISO.rangeSource(root + name, log)); return true; }
    }
    return false;
  }

  const missing = new Set();

  let glapi = null, vclock = 100000, lastReal = performance.now();
  window.PLAT = {
    trace: false, cdDrive: 'D:', width: 640, height: 480, modules: ['opengl32.dll', 'glu32.dll', 'dsound.dll', 'binkw32.dll'], frames: 0,
    log, now: () => vclock + Math.min(100, performance.now() - lastReal),
    readFile(n) { const k = strip(n); let d = null;
      if (/^\\(SETUP\.CFG|PLAYERS\.LST)$/.test(k)) { try { const s = localStorage.getItem(saveKey(k)); if (s) d = Uint8Array.from(atob(s), c => c.charCodeAt(0)); } catch (e) {} }
      if (!d) d = vfs.get(k);
      if (d && k === '\\SETUP.CFG') d = enc(String.fromCharCode(...d).replace(/set G_Renderer \S+/, 'set G_Renderer 1').replace(/set G_FullScreen \S+/, 'set G_FullScreen 0').replace(/^\\\\?set G_DataPath.*$/m, ''));
      if (!d && !missing.has(k) && !/LOG\.TXT|PLAYERS\.LST/.test(k) && !(disc.table && disc.dirs.get(dirOf(k)) && disc.dirs.get(dirOf(k)).state === 'loading')) { missing.add(k); if (!/\\(LEVEL\d+|ROBOTS)\\[^\\]+\.(GRP|PFF)$/.test(k)) log('file not found: ' + k); } return d ? new Uint8Array(d) : null; },
    writeFile(n, d) { const k = strip(n); if (/LOG\.TXT$/.test(k)) { String.fromCharCode(...d).split(/\r?\n/).filter(Boolean).forEach(l => log('game log: ' + l)); return; }
      vfs.set(k, new Uint8Array(d)); try { localStorage.setItem(saveKey(k), btoa(String.fromCharCode(...d))); } catch (e) { if (!PLAT.warnedSave) { PLAT.warnedSave = true; log('Could not save to browser storage (' + e.message + '). Progress will last only until this tab is closed.'); } } },
    listDir(dir) { const pre = strip(dir), names = new Set([...vfs.keys()].filter(k => k.startsWith(pre) && !k.slice(pre.length).includes('\\')).map(k => k.slice(pre.length)));
      const add = (keys, off) => { for (const k of keys) if (k.startsWith(off + pre) && !k.slice((off + pre).length).includes('\\')) names.add(k.slice((off + pre).length)); };
      if (disc.table) add(disc.table.keys(), disc.root);
      if (webf.base !== null) add(webf.paths.keys(), ''); return [...names]; },
    swap() { PLAT.frames++; if (glapi) glapi.flush(); }, gl: null, mci, audio, setVolume, video, pending: filePending,
    fileSize(n) { const k = strip(n), d = vfs.get(k); if (d) return d.length; const e = disc.table && disc.table.get(disc.root + k); if (e) return e.size; return (webf.base !== null && webf.paths.has(k)) ? 0 : -1; },
  };

  // KeyboardEvent.code -> [virtual key, scancode, extended]
  const KEYS = { ArrowLeft: [0x25, 0x4b, 1], ArrowRight: [0x27, 0x4d, 1], ArrowUp: [0x26, 0x48, 1], ArrowDown: [0x28, 0x50, 1], Space: [0x20, 0x39, 0], Enter: [0x0d, 0x1c, 0], Escape: [0x1b, 0x01, 0], Backspace: [0x08, 0x0e, 0], Tab: [0x09, 0x0f, 0],
    AltLeft: [0x12, 0x38, 0], AltRight: [0x12, 0x38, 1], ControlLeft: [0x11, 0x1d, 0], ControlRight: [0x11, 0x1d, 1], ShiftLeft: [0x10, 0x2a, 0], ShiftRight: [0x10, 0x36, 0],
    Numpad4: [0x64, 0x4b, 0], Numpad6: [0x66, 0x4d, 0], Numpad8: [0x68, 0x48, 0], Numpad2: [0x62, 0x50, 0], Delete: [0x2e, 0x53, 1], Home: [0x24, 0x47, 1], End: [0x23, 0x4f, 1], PageUp: [0x21, 0x49, 1], PageDown: [0x22, 0x51, 1],
    Minus: [0xbd, 0x0c, 0], Equal: [0xbb, 0x0d, 0], Comma: [0xbc, 0x33, 0], Period: [0xbe, 0x34, 0], Slash: [0xbf, 0x35, 0], Semicolon: [0xba, 0x27, 0], Quote: [0xde, 0x28, 0], BracketLeft: [0xdb, 0x1a, 0], BracketRight: [0xdd, 0x1b, 0], Backquote: [0xc0, 0x29, 0], Backslash: [0xdc, 0x2b, 0] };
  'QWERTYUIOP'.split('').forEach((c, i) => KEYS['Key' + c] = [c.charCodeAt(0), 0x10 + i, 0]); 'ASDFGHJKL'.split('').forEach((c, i) => KEYS['Key' + c] = [c.charCodeAt(0), 0x1e + i, 0]); 'ZXCVBNM'.split('').forEach((c, i) => KEYS['Key' + c] = [c.charCodeAt(0), 0x2c + i, 0]);
  '1234567890'.split('').forEach((c, i) => KEYS['Digit' + c] = [c.charCodeAt(0), 0x02 + i, 0]);
  for (let i = 1; i <= 10; i++) KEYS['F' + i] = [0x6f + i, 0x3a + i, 0]; KEYS.F11 = [0x7a, 0x57, 0]; KEYS.F12 = [0x7b, 0x58, 0];
  const held = new Set();
  function key(e, down) {
    const k = KEYS[e.code]; if (!k || !running) return; e.preventDefault();
    const sys = k[0] === 0x12; const prev = held.has(e.code); down ? held.add(e.code) : held.delete(e.code);
    const lp = 1 | (k[1] << 16) | (k[2] << 24) | (down ? (prev ? 1 << 30 : 0) : (3 << 30));
    msgQueue.push({ msg: (down ? 0x100 : 0x101) + (sys ? 4 : 0), wp: k[0], lp: lp | 0 });
    if (down && e.key.length === 1 && !e.ctrlKey && !e.altKey) msgQueue.push({ msg: 0x102, wp: e.key.charCodeAt(0) & 255, lp: lp | 0 });
  }
  addEventListener('keydown', (e) => key(e, true)); addEventListener('keyup', (e) => key(e, false));
  addEventListener('blur', () => { for (const c of [...held]) key({ code: c, key: '', preventDefault() {} }, false); });

  PLAT.joy = () => { const pads = navigator.getGamepads ? navigator.getGamepads() : []; for (const g of pads) { if (!g || !g.connected) continue;
      const b = (i) => (g.buttons[i] && g.buttons[i].pressed) ? 1 : 0; let x = g.axes[0] || 0, y = g.axes[1] || 0;
      if (b(14)) x = -1; if (b(15)) x = 1; if (b(12)) y = -1; if (b(13)) y = 1;
      return { x: Math.round((x + 1) * 32767.5), y: Math.round((y + 1) * 32767.5), buttons: b(0) | ((b(2) | b(1)) << 1) | (b(3) << 2) | (b(9) << 3) }; } return null; };
  let running = false, pc = 0, fpsT = performance.now(), fpsN = 0, blocks0 = 0;
  function frame() {
    if (!running) return;
    { const t = performance.now(); vclock += Math.min(100, t - lastReal); lastReal = t; }
    try { yieldFlag = false; pc = run(pc); if (pc === STOP) { running = false; log('The game exited.'); return; } }
    catch (e) { running = false; log('Stopped: ' + e.message); $('status').textContent = 'Stopped. ' + e.message; console.error(e); return; }
    fpsN++; const now = performance.now();
    if (now - fpsT > 1000) { $('status').textContent = `${fpsN} fps, ${((icount - blocks0) / fpsN / 1000).toFixed(0)}k blocks per frame, ${glapi.stats.draws / fpsN | 0} draws, ${glapi.stats.verts / fpsN | 0} vertices`; fpsN = 0; fpsT = now; blocks0 = icount; glapi.stats.draws = glapi.stats.verts = 0; }
    requestAnimationFrame(frame);
  }
  function start() {
    if (!vfs.has('\\DATA\\ROBOTS\\YELLOW.GRP') && !webf.paths.has('\\DATA\\ROBOTS\\YELLOW.GRP')) { fail('That folder does not look like the game disc: DATA\\ROBOTS\\YELLOW.GRP is missing.'); return; }
    vfs.set('\\SETUP.CFG', enc(DEFAULT_CFG));          // browser storage, if present, takes priority in readFile
    audio.init(); glapi = makeGL(canvas, u8); PLAT.gl = glapi;
    const img = Uint8Array.from(atob(IMAGE_B64), c => c.charCodeAt(0));
    pc = bootGuest(img, META.base, META.entry, META.imports);
    running = true; $('picker').hidden = true; $('bar').hidden = false; busy(null); canvas.focus(); log('Starting the game.'); requestAnimationFrame(frame);
  }
  const isMedia = (n) => /\.(webm|mp4|m4v|ogv)$/i.test(n);
  const stemOf = (n) => n.replace(/^.*[\\\/]/, '').replace(/\.[^.]*$/, '').toUpperCase();
  async function addFiles(files) {
    pickerEnabled(false); busy('Reading the game folder');
    const all = [...files], list = all.filter(f => !/\.(bik|exe|dll)$/i.test(f.name) && !isMedia(f.name)); let total = list.reduce((s, f) => s + f.size, 0), done = 0;
    const pathOf = (f) => (f.webkitRelativePath || f._path || f.name).replace(/\//g, '\\').toUpperCase();
    const paths = list.map(pathOf);
    const anchor = paths.find(p => /(^|\\)DATA\\ROBOTS\\YELLOW\.GRP$/.test(p)); const root = anchor ? anchor.slice(0, anchor.length - 'DATA\\ROBOTS\\YELLOW.GRP'.length) : '';
    for (const f of all) { if (isMedia(f.name)) media.set(stemOf(f.name), f); else if (/\.bik$/i.test(f.name)) { const p = pathOf(f); if (!root || p.startsWith(root)) biks.set('\\' + p.slice(root.length), f); } }
    for (let i = 0; i < list.length; i++) { if (root && !paths[i].startsWith(root)) continue; const d = new Uint8Array(await list[i].arrayBuffer()); vfs.set('\\' + paths[i].slice(root.length), d); done += d.length; $('status').textContent = `Reading files: ${(done / 1048576).toFixed(0)} of ${(total / 1048576).toFixed(0)} MB`; }
    log(`Loaded ${vfs.size} files (${(done / 1048576).toFixed(0)} MB), ${biks.size} cutscenes, ${media.size} ready-converted videos.`); start();
  }
  $('dir').addEventListener('change', (e) => addFiles(e.target.files));
  if ($('isoGo')) {
    $('isoGo').addEventListener('click', () => { const u = $('isoUrl').value.trim(); if (!/^https?:\/\//i.test(u)) { log('Enter the full web address of a disc image first.'); return; } startFromDisc(ISO.rangeSource(u, log)); });
    try { const q = new URLSearchParams(location.search).get('iso'); if (q) { $('isoUrl').value = q; log('Disc image address taken from the page link. Press "Stream from this address" to start.'); } } catch (e) {}
    $('isoFile').addEventListener('change', (e) => e.target.files[0] && startFromDisc(ISO.fileSource(e.target.files[0])));
    $('isoClear').addEventListener('click', () => { try { indexedDB.deleteDatabase('lostformulas-disc'); log('Cached game data and prepared videos were cleared.'); } catch (e) {} });
    window.__startDisc = (url) => startFromDisc(ISO.rangeSource(url, log));
  }
  $('full').addEventListener('click', () => { try { const st = $('stage'); (st.requestFullscreen || st.webkitRequestFullscreen).call(st); } catch (e) { log('Fullscreen is not available here.'); } canvas.focus(); });
  $('reset').addEventListener('click', () => { try { Object.keys(localStorage).filter(k => k.startsWith('lostformulas:')).forEach(k => localStorage.removeItem(k)); log('Saved players and settings were cleared. Reload the page to start fresh.'); } catch (e) {} });
  window.__addRaw = (entries) => { for (const [p, b64] of entries) { const d = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); if (isMedia(p)) media.set(stemOf(p), new Blob([d], { type: /webm$/i.test(p) ? 'video/webm' : 'video/mp4' })); else vfs.set(p, d); } }; window.__start = start;
  window.__dbg = { r32, w32, r16, w16, u8, rf32, wf32, gstr, regs: () => ({ eax, ecx, edx, ebx, esp, ebp, esi, edi }), setLevel: (n) => w32(r32(0x481ecc) + 0x100, n - 1) };   // debugging hooks (see HANDOFF.md)
  window.__autoStart = autoStart;
  autoStart().then((ok) => { if (!ok) { busy(null); $('picker').hidden = false; const a = $('adv'); if (a) a.open = true;
    log(location.protocol === 'file:' ? 'This page was opened from a file, so it cannot look for the game files by itself. Choose them below.' : 'No game files were found next to this page. Choose them below.'); } });
  window.__state = () => ({ video: vid.state, running, frames: PLAT.frames, icount, missing: [...missing] });
})();
