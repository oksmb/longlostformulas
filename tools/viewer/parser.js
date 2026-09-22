// Asset loaders for M&M's: The Lost Formulas (Boston Animation, 2000)
// Formats worked out from the retail CD: GRPC/GRP1 model groups, OFFC level files.
const MnM = (() => {
  // Classic Okumura LZSS: 4 KB ring, 18-byte max match, flag bit 1 = literal.
  function lzss(src, start, outLen) {
    const N = 4096, F = 18, TH = 2;
    const ring = new Uint8Array(N);
    const out = new Uint8Array(outLen);
    let r = N - F, i = start, o = 0, flags = 0;
    const end = src.length;
    while (o < outLen && i < end) {
      flags >>= 1;
      if (!(flags & 0x100)) flags = src[i++] | 0xff00;
      if (flags & 1) {
        const c = src[i++]; out[o++] = c; ring[r] = c; r = (r + 1) & (N - 1);
      } else {
        const a = src[i++], b = src[i++];
        let pos = a | ((b & 0xf0) << 4);
        const len = (b & 0x0f) + TH + 1;
        for (let k = 0; k < len && o < outLen; k++) {
          const c = ring[(pos + k) & (N - 1)]; out[o++] = c; ring[r] = c; r = (r + 1) & (N - 1);
        }
      }
    }
    return out;
  }
  const str = (u8, off, n) => { let s = ''; for (let k = 0; k < n && u8[off + k]; k++) s += String.fromCharCode(u8[off + k]); return s; };
  const magic = u8 => str(u8, 0, 4);

  // stored BGR(A), bottom-up (OpenGL row order) -> RGBA frames
  function toRGBA(raw, off, w, h, bpp, frames) {
    const res = [];
    for (let f = 0; f < frames; f++) {
      const px = new Uint8Array(w * h * 4); let p = off + f * w * h * bpp;
      for (let k = 0; k < w * h; k++, p += bpp) {
        px[k * 4] = raw[p + 2]; px[k * 4 + 1] = raw[p + 1]; px[k * 4 + 2] = raw[p];
        px[k * 4 + 3] = bpp === 4 ? raw[p + 3] : 255;
      }
      res.push(px);
    }
    return res;
  }

  function readMeshes(u8, dv, tableOff, count) {
    const meshes = [];
    for (let m = 0; m < count; m++) {
      const b = tableOff + m * 0x2c;
      const nF = dv.getUint16(b + 4, true), nV = dv.getUint16(b + 6, true);
      const nFrames = Math.max(1, dv.getUint16(b + 8, true)), nUV = dv.getUint16(b + 10, true);
      const fOff = dv.getUint32(b + 12, true), uvOff = dv.getUint32(b + 16, true), vOff = dv.getUint32(b + 20, true);
      const meshTex = dv.getUint16(b + 0x1e, true);
      const stride = nF ? Math.round((uvOff - fOff) / nF) : 12;      // 12, 16 or 36 bytes per face
      if (![12, 16, 36].includes(stride)) throw new Error('Unexpected face record size ' + stride);
      const verts = new Float32Array(u8.buffer.slice(u8.byteOffset + vOff, u8.byteOffset + vOff + nV * nFrames * 12));
      const uvs = new Float32Array(u8.buffer.slice(u8.byteOffset + uvOff, u8.byteOffset + uvOff + nUV * 8));
      const vi = new Uint16Array(nF * 3), ti = new Uint16Array(nF * 3), tex = new Uint16Array(nF);
      const colors = stride === 36 ? new Uint8Array(nF * 12) : null;
      for (let f = 0; f < nF; f++) {
        const p = fOff + f * stride;
        for (let k = 0; k < 3; k++) { vi[f * 3 + k] = dv.getUint16(p + k * 2, true); ti[f * 3 + k] = dv.getUint16(p + 6 + k * 2, true); }
        tex[f] = stride >= 16 ? dv.getUint16(p + 14, true) : (meshTex === 0xffff ? 0 : meshTex);
        if (colors) colors.set(u8.subarray(p + 16, p + 28), f * 12);
      }
      meshes.push({ nF, nV, nFrames, nUV, stride, verts, uvs, vi, ti, tex, colors });
    }
    return meshes;
  }

  function parseGRP(u8in) {
    let u8 = u8in, packed = 0;
    if (magic(u8) === 'GRPC') {
      const dv0 = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      packed = u8.length; u8 = lzss(u8, 12, dv0.getUint32(4, true));
    }
    if (magic(u8) !== 'GRP1') throw new Error('Not a GRP file (expected GRPC or GRP1 header)');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const nTex = dv.getUint32(12, true), texOff = dv.getUint32(16, true);
    const nMesh = dv.getUint32(20, true), meshOff = dv.getUint32(24, true);
    const textures = [];
    for (let t = 0; t < nTex; t++) {
      const b = texOff + t * 0x58;
      const w = dv.getUint32(b + 0x1c, true), h = dv.getUint32(b + 0x20, true), fmt = dv.getUint32(b + 0x24, true);
      const frames = Math.max(1, dv.getUint32(b + 0x30, true)), dataOff = dv.getUint32(b + 0x54, true);
      const bpp = fmt === 0x8888 ? 4 : 3;
      textures.push({ name: str(u8, b + 4, 20), w, h, alpha: bpp === 4, fps: 8, frames: toRGBA(u8, dataOff, w, h, bpp, frames) });
    }
    // named animation ranges: name[24], first frame, last frame, frames per second
    const nAnim = dv.getUint32(28, true), animOff = dv.getUint32(32, true);
    const anims = [];
    for (let a = 0; a < nAnim; a++) {
      const b = animOff + a * 36;
      anims.push({ name: str(u8, b, 24), start: dv.getUint32(b + 24, true), end: dv.getUint32(b + 28, true), fps: dv.getFloat32(b + 32, true) || 15 });
    }
    // embedded sound effects: name[24], audible distance, loop flag, ..., data offset. Raw 16-bit mono PCM.
    const nSnd = dv.getUint32(36, true), sndOff = dv.getUint32(40, true);
    const sounds = [];
    for (let k = 0; k < nSnd; k++) {
      const b = sndOff + k * 0x30, off = dv.getUint32(b + 44, true);
      const next = k + 1 < nSnd ? dv.getUint32(b + 0x30 + 44, true) : sndOff;
      const n = Math.max(0, (next - off) >> 1);
      sounds.push({ name: str(u8, b, 24), range: dv.getFloat32(b + 24, true), loop: !!dv.getUint32(b + 28, true), pcm: new Int16Array(u8.buffer.slice(u8.byteOffset + off, u8.byteOffset + off + n * 2)) });
    }
    return { kind: 'GRP', packed, size: u8.length, textures, anims, sounds, meshes: readMeshes(u8, dv, meshOff, nMesh) };
  }

  function parseOFF(u8) {
    if (magic(u8) !== 'OFFC') throw new Error('Not an OFF level file (expected OFFC header)');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const nTex = dv.getUint32(12, true), texOff = dv.getUint32(16, true);
    const nMesh = dv.getUint32(20, true), meshOff = dv.getUint32(24, true);
    const textures = [];
    for (let t = 0; t < nTex; t++) {
      const b = texOff + t * 0x30;
      const w = dv.getUint32(b + 20, true), h = dv.getUint32(b + 24, true), a = dv.getUint32(b + 28, true);
      const frames = Math.max(1, dv.getUint32(b + 32, true)), rate = dv.getUint32(b + 36, true);
      const off = dv.getUint32(b + 44, true);
      const bpp = a === 0x8888 ? 4 : 3;
      const raw = lzss(u8, off, w * h * bpp * frames);   // every texture is LZSS-packed on its own
      textures.push({ name: str(u8, b + 4, 16), w, h, alpha: bpp === 4, fps: rate || 8, frames: toRGBA(raw, 0, w, h, bpp, frames) });
    }
    return { kind: 'OFF', packed: 0, size: u8.length, textures, meshes: readMeshes(u8, dv, meshOff, nMesh) };
  }

  // .LEV: a list of named chunks (name[16], size, data offset, record size, count)
  function parseLEV(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const chunks = {}; let pos = 0;
    while (pos + 32 <= u8.length) {
      const name = str(u8, pos, 16), size = dv.getUint32(pos + 16, true), off = dv.getUint32(pos + 20, true);
      if (!name || off !== pos + 32 || off + size > u8.length) break;
      chunks[name] = { off, size, rec: dv.getUint32(pos + 24, true), count: dv.getUint32(pos + 28, true) };
      pos = off + size;
    }
    if (!chunks['START LOCATION']) throw new Error('Not a level script (no START LOCATION chunk)');
    const so = chunks['START LOCATION'].off;
    const start = [dv.getFloat32(so, true), dv.getFloat32(so + 4, true), dv.getFloat32(so + 8, true)];
    const actors = [], ac = chunks['ACTORS LIST'];
    if (ac) {                                           // 216-byte record + 60 bytes per path key
      let p = ac.off; const end = ac.off + ac.size;
      while (p + 216 <= end) {
        const keys = dv.getUint16(p + 0xc4, true);
        actors.push({ name: str(u8, p, 16), group: str(u8, p + 0x54, 16), x: dv.getFloat32(p + 16, true), y: dv.getFloat32(p + 20, true), z: dv.getFloat32(p + 24, true), angle: dv.getUint16(p + 28, true) / 65536 * Math.PI * 2, keys });
        p += 216 + 60 * keys;
      }
    }
    return { kind: 'LEV', chunks, start, actors };
  }

  function parse(u8) {
    const m = magic(u8);
    if (m === 'GRPC' || m === 'GRP1') return parseGRP(u8);
    if (m === 'OFFC') return parseOFF(u8);
    if (m === 'STAR') return parseLEV(u8);
    throw new Error('Unrecognised header "' + m.replace(/[^ -~]/g, '?') + '". This viewer reads .GRP, .OFF and .LEV files from the DATA folder.');
  }
  return { parse, lzss };
})();
if (typeof module !== 'undefined') module.exports = MnM;
