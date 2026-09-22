// ---- The slice of OpenGL 1.1 the game uses, implemented on WebGL 2 ----
function makeGL(canvas, guestU8) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: true, depth: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  if (!gl) throw new Error('WebGL 2 is not available in this browser');
  const VS = `#version 300 es
  in vec3 aPos; in vec4 aCol; in vec3 aTex; uniform mat4 uMvp; out vec4 vCol; out vec3 vTex;
  void main(){ gl_Position = uMvp * vec4(aPos, 1.0); vCol = aCol; vTex = aTex; gl_PointSize = 1.0; }`;
  const FS = `#version 300 es
  precision highp float; in vec4 vCol; in vec3 vTex; uniform sampler2D uTex; uniform int uTexOn, uEnv, uAlphaFunc; uniform float uAlphaRef; out vec4 o;
  void main(){ vec4 c = vCol;
    if (uTexOn == 1) { vec4 t = texture(uTex, vTex.xy / vTex.z);
      if (uEnv == 0) c *= t; else if (uEnv == 1) c = t; else if (uEnv == 2) c = vec4(mix(c.rgb, t.rgb, t.a), c.a); else c = vec4(min(c.rgb + t.rgb, 1.0), c.a * t.a); }
    if (uAlphaFunc == 1 && !(c.a > uAlphaRef)) discard; if (uAlphaFunc == 2 && !(c.a >= uAlphaRef)) discard;
    if (uAlphaFunc == 3 && !(c.a < uAlphaRef)) discard; if (uAlphaFunc == 4 && !(c.a <= uAlphaRef)) discard;
    if (uAlphaFunc == 5 && !(c.a == uAlphaRef)) discard; if (uAlphaFunc == 6 && !(c.a != uAlphaRef)) discard; if (uAlphaFunc == 7) discard;
    o = c; }`;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  ['aPos', 'aCol', 'aTex'].forEach((n, i) => gl.bindAttribLocation(prog, i, n)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const U = {}; for (const n of ['uMvp', 'uTex', 'uTexOn', 'uEnv', 'uAlphaFunc', 'uAlphaRef']) U[n] = gl.getUniformLocation(prog, n);
  const STRIDE = 10, MAXV = 65536 * 3;
  const vdata = new Float32Array(MAXV * STRIDE); let nv = 0, batchMode = gl.TRIANGLES;
  const vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, vdata.byteLength, gl.DYNAMIC_DRAW);
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE * 4, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE * 4, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, STRIDE * 4, 28);

  const ident = () => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const mul = (a, b) => { const r = new Float64Array(16); for (let c = 0; c < 4; c++) for (let rw = 0; rw < 4; rw++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + rw] * b[c * 4 + k]; r[c * 4 + rw] = s; } return r; };
  const S = { mode: 0x1700, mv: ident(), pr: ident(), tx: ident(), mvpDirty: true, texOn: false, env: 0, alphaOn: false, alphaFunc: 0x207, alphaRef: 0, stateDirty: true,
    col: [1, 1, 1, 1], tc: [0, 0, 1], prim: 0, primStart: 0, bound: 0, unpackAlign: 4, stats: { draws: 0, verts: 0, texUploads: 0 } };
  const textures = new Map(); let nextTex = 1;
  const white = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, white); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  const tmp = []; // vertices of the primitive being assembled

  function flush() {
    if (!nv) return;
    if (S.mvpDirty) { gl.uniformMatrix4fv(U.uMvp, false, new Float32Array(mul(S.pr, S.mv))); S.mvpDirty = false; }
    if (S.stateDirty) {
      gl.uniform1i(U.uTexOn, S.texOn && S.bound ? 1 : 0); gl.uniform1i(U.uEnv, S.env);
      const af = S.alphaOn ? ({ 0x204: 1, 0x206: 2, 0x201: 3, 0x203: 4, 0x202: 5, 0x205: 6, 0x200: 7 }[S.alphaFunc] || 0) : 0;
      gl.uniform1i(U.uAlphaFunc, af); gl.uniform1f(U.uAlphaRef, S.alphaRef); S.stateDirty = false;
    }
    const t = textures.get(S.bound);
    if (t && t.mipDirty && t.wantsMips) { gl.generateMipmap(gl.TEXTURE_2D); t.mipDirty = false; }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, vdata, 0, nv * STRIDE);
    gl.drawArrays(batchMode, 0, nv); S.stats.draws++; S.stats.verts += nv; nv = 0;
  }
  function emit(v) { if (nv >= MAXV) flush(); vdata.set(v, nv * STRIDE); nv++; }
  function setBatch(mode) { if (batchMode !== mode) { flush(); batchMode = mode; } }

  function convert(w, h, fmt, type, p) {       // any supported client format -> tightly packed RGBA8
    const out = new Uint8Array(w * h * 4), m = guestU8;
    if (type === 0x1401) {
      const n = { 0x1907: 3, 0x1908: 4, 0x80e0: 3, 0x80e1: 4, 0x1909: 1, 0x190a: 2, 0x1906: 1 }[fmt];
      if (!n) throw new Error('texture format 0x' + fmt.toString(16));
      const row = (w * n + S.unpackAlign - 1) & ~(S.unpackAlign - 1), bgr = fmt === 0x80e0 || fmt === 0x80e1;
      for (let y = 0; y < h; y++) { let s = p + y * row, d = y * w * 4;
        for (let x = 0; x < w; x++, s += n, d += 4) {
          if (n >= 3) { out[d] = m[s + (bgr ? 2 : 0)]; out[d + 1] = m[s + 1]; out[d + 2] = m[s + (bgr ? 0 : 2)]; out[d + 3] = n === 4 ? m[s + 3] : 255; }
          else if (fmt === 0x1906) { out[d] = out[d + 1] = out[d + 2] = 255; out[d + 3] = m[s]; }
          else { out[d] = out[d + 1] = out[d + 2] = m[s]; out[d + 3] = n === 2 ? m[s + 1] : 255; } } }
      return out;
    }
    const row = (w * 2 + S.unpackAlign - 1) & ~(S.unpackAlign - 1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = p + y * row + x * 2, v = m[s] | (m[s + 1] << 8), d = (y * w + x) * 4; let r, g, b, a = 255;
      if (type === 0x8363) { r = (v >> 11) << 3; g = ((v >> 5) & 63) << 2; b = (v & 31) << 3; }
      else if (type === 0x8034) { r = (v >> 11) << 3; g = ((v >> 6) & 31) << 3; b = ((v >> 1) & 31) << 3; a = (v & 1) * 255; }
      else if (type === 0x8366) { a = (v >> 15) * 255; r = ((v >> 10) & 31) << 3; g = ((v >> 5) & 31) << 3; b = (v & 31) << 3; }
      else if (type === 0x8033) { r = (v >> 12) * 17; g = ((v >> 8) & 15) * 17; b = ((v >> 4) & 15) * 17; a = (v & 15) * 17; }
      else if (type === 0x8365) { a = (v >> 12) * 17; r = ((v >> 8) & 15) * 17; g = ((v >> 4) & 15) * 17; b = (v & 15) * 17; }
      else throw new Error('texture type 0x' + type.toString(16));
      if (fmt === 0x80e1 || fmt === 0x80e0) { if (type === 0x8363 || type === 0x8034 || type === 0x8033) { const t2 = r; r = b; b = t2; } }
      else if (type === 0x8366 || type === 0x8365) { const t2 = r; r = b; b = t2; }
      out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = a; }
    return out;
  }
  const CAP = { 0xb71: gl.DEPTH_TEST, 0xbe2: gl.BLEND, 0xb44: gl.CULL_FACE, 0xc11: gl.SCISSOR_TEST, 0xbd0: gl.DITHER };
  const api = {
    raw: gl, stats: S.stats, flush,
    glEnable(c) { api.cap(c, true); }, glDisable(c) { api.cap(c, false); },
    cap(c, on) { if (c === 0xde1) { if (S.texOn !== on) { flush(); S.texOn = on; S.stateDirty = true; } } else if (c === 0xbc0) { if (S.alphaOn !== on) { flush(); S.alphaOn = on; S.stateDirty = true; } } else if (CAP[c] !== undefined) { flush(); on ? gl.enable(CAP[c]) : gl.disable(CAP[c]); } },
    glBlendFunc(s, d) { flush(); gl.blendFunc(s, d); }, glDepthFunc(f) { flush(); gl.depthFunc(f); }, glDepthMask(m) { flush(); gl.depthMask(!!m); },
    glAlphaFunc(f, r) { flush(); S.alphaFunc = f; S.alphaRef = r; S.stateDirty = true; },
    glCullFace(m) { flush(); gl.cullFace(m); }, glFrontFace(m) { flush(); gl.frontFace(m); }, glShadeModel() {}, glPolygonMode() {}, glHint() {}, glDrawBuffer() {}, glReadBuffer() {},
    glScissor(x, y, w, h) { flush(); gl.scissor(x, y, w, h); }, glColorMask(r, g, b, a) { flush(); gl.colorMask(!!r, !!g, !!b, !!a); },
    glClearColor(r, g, b, a) { gl.clearColor(r, g, b, a); }, glClearDepth(d) { gl.clearDepth(d); }, glDepthRange(n, f) { flush(); gl.depthRange(n, f); },
    glClear(mask) { flush(); gl.clear(mask & (0x4000 | 0x100 | 0x400)); },
    glFlush() { flush(); }, glFinish() { flush(); },
    glViewport(x, y, w, h) { flush(); S.vp = [x, y, w, h]; api.applyViewport(); },
    applyViewport() { if (!S.vp) return; const sx = canvas.width / api.guestW, sy = canvas.height / api.guestH; gl.viewport(Math.round(S.vp[0] * sx), Math.round(S.vp[1] * sy), Math.round(S.vp[2] * sx), Math.round(S.vp[3] * sy)); },
    guestW: 640, guestH: 480,
    glMatrixMode(m) { S.mode = m; },
    cur() { return S.mode === 0x1701 ? 'pr' : S.mode === 0x1702 ? 'tx' : 'mv'; },
    glLoadIdentity() { flush(); S[api.cur()] = ident(); S.mvpDirty = true; },
    mulCur(m) { flush(); const k = api.cur(); S[k] = mul(S[k], m); S.mvpDirty = true; },
    glOrtho(l, r, b, t, n, f) { const m = ident(); m[0] = 2 / (r - l); m[5] = 2 / (t - b); m[10] = -2 / (f - n); m[12] = -(r + l) / (r - l); m[13] = -(t + b) / (t - b); m[14] = -(f + n) / (f - n); api.mulCur(m); },
    glTranslatef(x, y, z) { const m = ident(); m[12] = x; m[13] = y; m[14] = z; api.mulCur(m); },
    glScalef(x, y, z) { const m = ident(); m[0] = x; m[5] = y; m[10] = z; api.mulCur(m); },
    glColor4f(r, g, b, a) { S.col = [r, g, b, a]; },
    glTexCoord4f(s, t, r, q) { S.tc = [s, t, q]; },
    glBegin(prim) { S.prim = prim; tmp.length = 0; setBatch(prim <= 0 ? gl.POINTS : prim <= 3 ? gl.LINES : gl.TRIANGLES); },
    glVertex3f(x, y, z) {
      const v = [x, y, z, S.col[0], S.col[1], S.col[2], S.col[3], S.tc[0], S.tc[1], S.tc[2]], p = S.prim;
      if (p === 4 || p === 1 || p === 0) { emit(v); return; }
      tmp.push(v); const n = tmp.length;
      if (p === 5) { if (n >= 3) { if (n & 1) { emit(tmp[n - 3]); emit(tmp[n - 2]); } else { emit(tmp[n - 2]); emit(tmp[n - 3]); } emit(v); } }
      else if (p === 6 || p === 9) { if (n >= 3) { emit(tmp[0]); emit(tmp[n - 2]); emit(v); } }
      else if (p === 7) { if (n === 4) { emit(tmp[0]); emit(tmp[1]); emit(tmp[2]); emit(tmp[0]); emit(tmp[2]); emit(tmp[3]); tmp.length = 0; } }
      else if (p === 8) { if (n >= 4 && !(n & 1)) { emit(tmp[n - 4]); emit(tmp[n - 3]); emit(tmp[n - 1]); emit(tmp[n - 4]); emit(tmp[n - 1]); emit(tmp[n - 2]); } }
      else if (p === 3 || p === 2) { if (n >= 2) { emit(tmp[n - 2]); emit(v); } }
    },
    glEnd() { if (S.prim === 2 && tmp.length > 2) { emit(tmp[tmp.length - 1]); emit(tmp[0]); } tmp.length = 0; },
    genTexture() { const id = nextTex++; textures.set(id, { tex: gl.createTexture(), wantsMips: true, mipDirty: false, w: 0, h: 0 }); return id; },
    deleteTexture(id) { const t = textures.get(id); if (t) { flush(); gl.deleteTexture(t.tex); textures.delete(id); if (S.bound === id) S.bound = 0; } },
    glBindTexture(target, id) { if (S.bound === id) return; flush(); if (id && !textures.has(id)) textures.set(id, { tex: gl.createTexture(), wantsMips: true, mipDirty: false, w: 0, h: 0 }); S.bound = id; S.stateDirty = true; gl.bindTexture(gl.TEXTURE_2D, id ? textures.get(id).tex : white); },
    glPixelStorei(name, v) { if (name === 0xcf5) S.unpackAlign = v; },
    glTexImage2D(target, level, ifmt, w, h, fmt, type, p, mips) {
      if (level !== 0) return; flush(); const t = textures.get(S.bound); if (!t) return;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, p ? convert(w, h, fmt, type, p) : null); t.w = w; t.h = h; t.mipDirty = true; if (mips) t.wantsMips = true; S.stats.texUploads++;
    },
    glTexSubImage2D(target, level, x, y, w, h, fmt, type, p) { if (level !== 0) return; flush(); const t = textures.get(S.bound); if (!t) return; gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, convert(w, h, fmt, type, p)); t.mipDirty = true; S.stats.texUploads++; },
    glTexParameteri(target, pname, v) { flush(); const t = textures.get(S.bound);
      if (pname === 0x2801) { if (t) t.wantsMips = v >= 0x2700; gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, v); }
      else if (pname === 0x2800) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, v);
      else if (pname === 0x2802 || pname === 0x2803) gl.texParameteri(gl.TEXTURE_2D, pname, v === 0x2901 ? gl.REPEAT : gl.CLAMP_TO_EDGE); },
    glTexParameterf(target, pname, v) { api.glTexParameteri(target, pname, v | 0); },
    glTexEnvi(target, pname, v) { if (pname !== 0x2200) return; const e = { 0x2100: 0, 0x1e01: 1, 0x2101: 2, 0x104: 3, 0xbe2: 0 }[v]; if (e !== undefined && e !== S.env) { flush(); S.env = e; S.stateDirty = true; } },
    glTexEnvf(target, pname, v) { api.glTexEnvi(target, pname, v | 0); },
  };
  return api;
}
if (typeof module !== 'undefined') module.exports = makeGL;
