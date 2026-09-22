(() => {
  const $ = id => document.getElementById(id);
  const canvas = $('gl');
  const fail = msg => { $('err').hidden = false; $('err').textContent = msg; };
  if (typeof THREE === 'undefined') return fail('The 3D library failed to load. Check your connection and reload.');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 1, 1e6);
  camera.up.set(0, 0, 1);                                    // the game's world is Z-up
  const viewColor = () => new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--view').trim() || '#120b07');
  let root = null, asset = null, parts = [], animTex = [], wire = false, showActors = true, actorRoot = null;
  let mode = 'orbit', playing = true, frame = 0, frameAcc = 0, range = { start: 0, end: 0, fps: 15 };
  const orbit = { target: new THREE.Vector3(), dist: 100, yaw: -0.9, pitch: 0.35 };
  const fly = { pos: new THREE.Vector3(), yaw: 0, pitch: -0.15, speed: 3000 };
  let home = null, audio = null, playingSrc = null;
  const keys = new Set();

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight, r = renderer.getPixelRatio();
    if (canvas.width !== Math.floor(w * r) || canvas.height !== Math.floor(h * r)) { renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); }
  }

  function prepare(a) {                                       // upload an asset's textures once
    if (a.three) return a;
    a.three = a.textures.map(t => {
      const tex = new THREE.DataTexture(t.frames[0].slice(), t.w, t.h, THREE.RGBAFormat);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
      tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); tex.needsUpdate = true;
      if (t.frames.length > 1) animTex.push({ tex, src: t, acc: 0, cur: 0 });
      return tex;
    });
    return a;
  }

  // Turn meshes into one Group; faces are regrouped by texture and un-indexed (UVs are per face corner).
  function buildGroup(a, meshFilter, frameNo, collect) {
    prepare(a); const group = new THREE.Group();
    a.meshes.forEach((m, mi) => {
      if (meshFilter >= 0 && mi !== meshFilter) return;
      const byTex = new Map();
      for (let f = 0; f < m.nF; f++) { const k = m.tex[f]; (byTex.get(k) || byTex.set(k, []).get(k)).push(f); }
      const base = (Math.min(frameNo, m.nFrames - 1)) * m.nV * 3;
      for (const [ti, faces] of byTex) {
        const n = faces.length * 3, pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), col = m.colors ? new Float32Array(n * 3) : null, vmap = new Uint32Array(n);
        faces.forEach((f, j) => { for (let k = 0; k < 3; k++) {
          const o = j * 3 + k, v = m.vi[f * 3 + k], t = m.ti[f * 3 + k]; vmap[o] = v;
          pos[o * 3] = m.verts[base + v * 3]; pos[o * 3 + 1] = m.verts[base + v * 3 + 1]; pos[o * 3 + 2] = m.verts[base + v * 3 + 2];
          uv[o * 2] = m.uvs[t * 2]; uv[o * 2 + 1] = m.uvs[t * 2 + 1];
          if (col) { const c = f * 12 + k * 4; col[o * 3] = m.colors[c] / 255; col[o * 3 + 1] = m.colors[c + 1] / 255; col[o * 3 + 2] = m.colors[c + 2] / 255; }
        } });
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        const t = a.textures[ti];
        const mat = new THREE.MeshBasicMaterial({ map: t ? a.three[ti] : null, vertexColors: !!col, side: THREE.DoubleSide, transparent: !!(t && t.alpha), depthWrite: !(t && t.alpha), wireframe: wire });
        const mesh = new THREE.Mesh(g, mat); mesh.frustumCulled = false; if (t && t.alpha) mesh.renderOrder = 1;
        group.add(mesh); if (collect) collect.push({ mesh, src: m, vmap });
      }
    });
    return group;
  }

  function dispose(g) { if (!g) return; scene.remove(g); g.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); }

  function setFrame(fr) {
    frame = fr;
    for (const p of parts) {
      const m = p.src; if (m.nFrames < 2) continue;
      const base = (fr % m.nFrames) * m.nV * 3, pos = p.mesh.geometry.attributes.position, arr = pos.array;
      for (let o = 0; o < p.vmap.length; o++) { const s = base + p.vmap[o] * 3; arr[o * 3] = m.verts[s]; arr[o * 3 + 1] = m.verts[s + 1]; arr[o * 3 + 2] = m.verts[s + 2]; }
      pos.needsUpdate = true;
    }
    $('frame').value = fr; $('frameNo').textContent = fr;
  }

  function frameModel() {
    const box = new THREE.Box3(), v = new THREE.Vector3();
    for (const m of new Set(parts.map(p => p.src))) { const b = range.start * m.nV * 3; for (let i = 0; i < m.nV; i++) box.expandByPoint(v.set(m.verts[b + i * 3] || 0, m.verts[b + i * 3 + 1] || 0, m.verts[b + i * 3 + 2] || 0)); }
    const size = box.getSize(new THREE.Vector3()).length() || 100;
    box.getCenter(orbit.target); orbit.dist = size * 1.1; orbit.yaw = -0.9; orbit.pitch = 0.35;
    camera.near = size / 500; camera.far = size * 50; camera.updateProjectionMatrix();
    home = { ...orbit, target: orbit.target.clone() };
  }

  function frameLevel(m, lev) {
    if (lev) { fly.pos.set(lev.start[0], lev.start[1], lev.start[2] + 250); const a = lev.actors[0]; fly.yaw = a ? Math.atan2(a.y - lev.start[1], a.x - lev.start[0]) : 0; fly.pitch = -0.1; }
    else {   // no script: start above the first ordinary-sized polygon and look along the following ones
      const c = f => { const p = new THREE.Vector3(); for (let k = 0; k < 3; k++) { const v = m.vi[f * 3 + k]; p.x += m.verts[v * 3] / 3; p.y += m.verts[v * 3 + 1] / 3; p.z += m.verts[v * 3 + 2] / 3; } return p; };
      const span = f => { let mn = Infinity, mx = -Infinity; for (let k = 0; k < 3; k++) { const x = m.verts[m.vi[f * 3 + k] * 3]; mn = Math.min(mn, x); mx = Math.max(mx, x); } return mx - mn; };
      let f0 = 0; while (f0 < m.nF - 1 && span(f0) > 5000) f0++;
      const a = c(f0), b = new THREE.Vector3(); let n = 0;
      for (let f = f0 + 1; f < Math.min(m.nF, f0 + 400); f++) if (span(f) < 5000) { b.add(c(f)); n++; }
      if (n) b.multiplyScalar(1 / n); else b.copy(a).add(new THREE.Vector3(1, 0, 0));
      fly.pos.copy(a).add(new THREE.Vector3(0, 0, 900)); fly.yaw = Math.atan2(b.y - a.y, b.x - a.x); fly.pitch = -0.2;
    }
    fly.speed = 3000; camera.near = 5; camera.far = 2e6; camera.updateProjectionMatrix();
    home = { pos: fly.pos.clone(), yaw: fly.yaw, pitch: fly.pitch };
  }

  function placeActors(lev, lib) {
    dispose(actorRoot); actorRoot = new THREE.Group(); scene.add(actorRoot); actorRoot.visible = showActors;
    const templates = new Map(), marker = new THREE.OctahedronGeometry(60), markMat = new THREE.MeshBasicMaterial({ color: 0xffd21f, wireframe: true });
    let placed = 0; const missing = new Map();
    for (const a of lev.actors) {
      const key = a.group.toUpperCase(), src = lib.get(key); let obj;
      if (src) {
        if (!templates.has(key)) { const an = src.anims.find(x => x.name !== 'SHADOW'); templates.set(key, buildGroup(src, 0, an && an.start < src.meshes[0].nFrames ? an.start : 0)); }
        obj = templates.get(key).clone(); obj.rotation.z = a.angle; placed++;
      } else { obj = new THREE.Mesh(marker, markMat); missing.set(a.group, (missing.get(a.group) || 0) + 1); }
      obj.position.set(a.x, a.y, a.z); actorRoot.add(obj);
    }
    return { placed, missing };
  }

  const stats = rows => $('stats').innerHTML = rows.map(r => `<dt>${r[0]}</dt><dd>${r[1]}</dd>`).join('');
  function thumbs(a) {
    const th = $('thumbs'); th.innerHTML = ''; const max = 48;
    a.textures.slice(0, max).forEach(t => { const c = document.createElement('canvas'); c.width = t.w; c.height = t.h; c.title = `${t.name} (${t.w}×${t.h}${t.frames.length > 1 ? ', ' + t.frames.length + ' frames' : ''})`;
      const x = c.getContext('2d'), img = x.createImageData(t.w, t.h); for (let y = 0; y < t.h; y++) img.data.set(t.frames[0].subarray((t.h - 1 - y) * t.w * 4, (t.h - y) * t.w * 4), y * t.w * 4); x.putImageData(img, 0, 0); th.appendChild(c); });
    $('texTitle').textContent = a.textures.length > max ? `Textures (first ${max} of ${a.textures.length})` : 'Textures'; $('texBox').hidden = !a.textures.length;
  }

  function reset() { dispose(root); dispose(actorRoot); root = actorRoot = null; parts = []; animTex = []; stopSound(); ['meshBox', 'animBox', 'sndBox', 'actorBox', 'texBox'].forEach(id => $(id).hidden = true); }

  function showModel(a, name) {
    reset(); asset = a; mode = 'orbit';
    const sel = $('meshSel'); sel.innerHTML = '';
    a.meshes.forEach((m, i) => sel.add(new Option(`Mesh ${i + 1}: ${m.nF} triangles, ${m.nFrames} frame${m.nFrames > 1 ? 's' : ''}`, i)));
    if (a.meshes.length > 1) sel.add(new Option('All meshes together', -1));
    $('meshBox').hidden = a.meshes.length < 2;
    $('fname').textContent = name;
    const rows = [['Type', 'Model group'], ['Triangles', a.meshes.reduce((s, m) => s + m.nF, 0).toLocaleString()], ['Textures', a.textures.length], ['Named animations', a.anims.length], ['Sound effects', a.sounds.length]];
    if (a.packed) rows.push(['Compression', `LZSS, ${(a.packed / 1024).toFixed(0)} KB to ${(a.size / 1024).toFixed(0)} KB`]);
    stats(rows); thumbs(a);
    const sb = $('sounds'); sb.innerHTML = '';
    a.sounds.filter(s => s.pcm.length > 8).forEach(s => { const b = document.createElement('button'); b.className = 'quiet'; b.type = 'button'; b.textContent = s.name; b.title = `${(s.pcm.length / 22050).toFixed(2)} s${s.loop ? ', loops in game' : ''}`; b.onclick = () => playSound(s); sb.appendChild(b); });
    $('sndBox').hidden = !sb.children.length;
    pickMesh(0);
    $('hint').textContent = 'Drag to rotate, scroll to zoom.';
  }

  function pickMesh(i) {
    $('meshSel').value = i; dispose(root); parts = []; root = buildGroup(asset, i, 0, parts); scene.add(root);
    const maxF = Math.max(...parts.map(p => p.src.nFrames)), as = $('animSel'); as.innerHTML = '';
    as.add(new Option(`All ${maxF} frames`, -1));
    asset.anims.forEach((an, k) => { if (an.end < maxF && (i < 0 || asset.meshes.length < 2 || an.end > 1 || maxF <= 8)) as.add(new Option(`${an.name} (${an.end - an.start + 1} frames, ${an.fps} fps)`, k)); });
    $('animBox').hidden = maxF < 2; $('animSel').hidden = as.options.length < 2; $('frame').max = maxF - 1;
    const first = [...as.options].find(o => /RUN|MOVE|WALK/i.test(o.text)); pickAnim(first ? +first.value : -1); frameModel();
  }

  function pickAnim(k) {
    $('animSel').value = k; const maxF = +$('frame').max + 1, an = asset.anims[k];
    range = an ? { start: an.start, end: an.end, fps: an.fps } : { start: 0, end: maxF - 1, fps: 15 };
    playing = true; $('play').textContent = 'Pause'; setFrame(range.start);
  }

  function showLevel(a, name, lev, lib) {
    reset(); asset = a; mode = 'fly'; root = buildGroup(a, -1, 0, parts); scene.add(root);
    $('fname').textContent = name + (lev ? ' with level script' : '');
    const rows = [['Type', 'Level geometry'], ['Triangles', a.meshes.reduce((s, m) => s + m.nF, 0).toLocaleString()], ['Textures', a.textures.length], ['Animated textures', a.textures.filter(t => t.frames.length > 1).length], ['Baked vertex lighting', a.meshes.some(m => m.colors) ? 'Yes' : 'No']];
    if (lev) {
      const r = placeActors(lev, lib);
      rows.push(['Actors in script', lev.actors.length], ['Actors on moving paths', lev.actors.filter(x => x.keys).length], ['Shown as models', r.placed], ['Shown as markers', lev.actors.length - r.placed]);
      $('actorBox').hidden = false;
      const list = [...r.missing].sort((x, y) => y[1] - x[1]);
      $('missing').textContent = list.length ? `Add these model files to see more actors: ${list.slice(0, 14).map(x => x[0] + '.GRP').join(', ')}${list.length > 14 ? ` and ${list.length - 14} more` : ''}. Models sit in DATA\\GROUPS, DATA\\ROBOTS and the level's own folder.` : 'Every actor has its model.';
    }
    stats(rows); thumbs(a); frameLevel(a.meshes[0], lev);
    $('hint').textContent = 'Drag to look around. W A S D to fly, Q and E for down and up, hold Shift to go faster, scroll to change speed.';
  }

  function stopSound() { if (playingSrc) { try { playingSrc.stop(); } catch (e) {} playingSrc = null; } }
  function playSound(s) {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)(); stopSound();
    const buf = audio.createBuffer(1, s.pcm.length, 22050), ch = buf.getChannelData(0);
    for (let i = 0; i < s.pcm.length; i++) ch[i] = s.pcm[i] / 32768;
    const src = audio.createBufferSource(); src.buffer = buf; src.connect(audio.destination); src.start(); playingSrc = src;
  }

  async function loadFiles(files) {
    $('err').hidden = true; files = [...files].filter(f => /\.(grp|off|lev)$/i.test(f.name));
    if (!files.length) return fail('None of those files is a .GRP, .OFF or .LEV file.');
    const lib = new Map(); let level = null, lev = null, levName = '', bad = [];
    const stem = n => n.replace(/\.[^.]+$/, '').toUpperCase();
    for (const f of files) {
      try { const a = MnM.parse(new Uint8Array(await f.arrayBuffer()));
        if (a.kind === 'OFF') { if (!level || stem(f.name) === levName) level = { a, name: f.name }; }
        else if (a.kind === 'LEV') { lev = a; levName = stem(f.name); }
        else lib.set(stem(f.name), Object.assign(a, { fileName: f.name }));
      } catch (e) { bad.push(`${f.name}: ${e.message}`); }
    }
    if (lev && files.filter(f => /\.off$/i.test(f.name)).length > 1) {           // several parts dropped: prefer the geometry matching the script
      const match = files.find(f => /\.off$/i.test(f.name) && stem(f.name) === levName);
      if (match && stem(level.name) !== levName) level = { a: MnM.parse(new Uint8Array(await match.arrayBuffer())), name: match.name };
    }
    if (level) showLevel(level.a, level.name, lev, lib);
    else if (lib.size) { const a = lib.values().next().value; showModel(a, a.fileName + (lib.size > 1 ? ` (first of ${lib.size} models)` : '')); }
    else if (lev) return fail('A level script needs its geometry. Add the .OFF file with the same name, for example L01P1.OFF with L01P1.LEV.');
    ['info', 'viewBox', 'hint'].forEach(id => $(id).hidden = false); $('empty').hidden = true;
    if (bad.length) fail(`Could not open ${bad.length} file${bad.length > 1 ? 's' : ''}. ${bad[0]}`);
  }

  async function filesFromDrop(dt) {                          // supports dropped folders
    const out = [], walk = async e => { if (e.isFile) out.push(await new Promise((ok, no) => e.file(ok, no))); else if (e.isDirectory) { const rd = e.createReader(); let batch; do { batch = await new Promise((ok, no) => rd.readEntries(ok, no)); for (const c of batch) await walk(c); } while (batch.length); } };
    const entries = [...(dt.items || [])].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if (!entries.length) return [...dt.files];
    for (const e of entries) await walk(e); return out;
  }

  $('file').addEventListener('change', e => e.target.files.length && loadFiles(e.target.files));
  $('dir').addEventListener('change', e => e.target.files.length && loadFiles(e.target.files));
  addEventListener('dragover', e => { e.preventDefault(); $('drop').classList.add('over'); });
  addEventListener('dragleave', () => $('drop').classList.remove('over'));
  addEventListener('drop', async e => { e.preventDefault(); $('drop').classList.remove('over'); try { loadFiles(await filesFromDrop(e.dataTransfer)); } catch (x) { fail('Could not read the dropped items. ' + x.message); } });
  $('meshSel').addEventListener('change', e => pickMesh(+e.target.value));
  $('animSel').addEventListener('change', e => pickAnim(+e.target.value));
  $('play').addEventListener('click', () => { playing = !playing; $('play').textContent = playing ? 'Pause' : 'Play'; });
  $('frame').addEventListener('input', e => { playing = false; $('play').textContent = 'Play'; setFrame(+e.target.value); });
  $('wire').addEventListener('click', () => { wire = !wire; $('wire').textContent = wire ? 'Show textures' : 'Show wireframe'; scene.traverse(o => { if (o.material && o.material.map !== undefined && o.geometry.type === 'BufferGeometry') o.material.wireframe = wire; }); });
  $('actors').addEventListener('click', () => { showActors = !showActors; $('actors').textContent = showActors ? 'Hide actors' : 'Show actors'; if (actorRoot) actorRoot.visible = showActors; });
  $('reset').addEventListener('click', () => { if (!home) return; if (mode === 'orbit') Object.assign(orbit, home, { target: home.target.clone() }); else { fly.pos.copy(home.pos); fly.yaw = home.yaw; fly.pitch = home.pitch; } });
  let drag = null;
  canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', () => drag = null);
  canvas.addEventListener('pointermove', e => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag = { x: e.clientX, y: e.clientY };
    const o = mode === 'orbit' ? orbit : fly, s = mode === 'orbit' ? 1 : -1; o.yaw -= dx * 0.005; o.pitch = Math.max(-1.5, Math.min(1.5, o.pitch + s * dy * 0.005)); });
  canvas.addEventListener('wheel', e => { e.preventDefault(); const k = Math.exp(e.deltaY * 0.001); if (mode === 'orbit') orbit.dist *= k; else fly.speed = Math.max(100, Math.min(60000, fly.speed / k)); }, { passive: false });
  addEventListener('keydown', e => { if (!/INPUT|SELECT/.test(e.target.tagName)) keys.add(e.code); });
  addEventListener('keyup', e => keys.delete(e.code)); addEventListener('blur', () => keys.clear());

  let last = performance.now();
  function tick(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now; resize(); renderer.setClearColor(viewColor());
    if (root) {
      if (playing && mode === 'orbit' && range.end > range.start) { frameAcc += dt * range.fps; if (frameAcc >= 1) { const n = range.end - range.start + 1; setFrame(range.start + ((frame - range.start + Math.floor(frameAcc)) % n + n) % n); frameAcc %= 1; } }
      for (const a of animTex) { a.acc += dt * a.src.fps; if (a.acc >= 1) { a.cur = (a.cur + Math.floor(a.acc)) % a.src.frames.length; a.acc %= 1; a.tex.image.data.set(a.src.frames[a.cur]); a.tex.needsUpdate = true; } }
      if (mode === 'orbit') { const cp = Math.cos(orbit.pitch);
        camera.position.set(orbit.target.x + orbit.dist * cp * Math.cos(orbit.yaw), orbit.target.y + orbit.dist * cp * Math.sin(orbit.yaw), orbit.target.z + orbit.dist * Math.sin(orbit.pitch)); camera.lookAt(orbit.target);
      } else { const cp = Math.cos(fly.pitch), fwd = new THREE.Vector3(cp * Math.cos(fly.yaw), cp * Math.sin(fly.yaw), Math.sin(fly.pitch)), right = new THREE.Vector3(Math.sin(fly.yaw), -Math.cos(fly.yaw), 0);
        const v = fly.speed * dt * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4 : 1);
        if (keys.has('KeyW') || keys.has('ArrowUp')) fly.pos.addScaledVector(fwd, v); if (keys.has('KeyS') || keys.has('ArrowDown')) fly.pos.addScaledVector(fwd, -v);
        if (keys.has('KeyD') || keys.has('ArrowRight')) fly.pos.addScaledVector(right, v); if (keys.has('KeyA') || keys.has('ArrowLeft')) fly.pos.addScaledVector(right, -v);
        if (keys.has('KeyE')) fly.pos.z += v; if (keys.has('KeyQ')) fly.pos.z -= v;
        camera.position.copy(fly.pos); camera.lookAt(fly.pos.clone().add(fwd)); }
    }
    renderer.render(scene, camera); requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
