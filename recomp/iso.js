// ---- ISO 9660 reader over random-access sources (HTTP range requests or a local File) ----
// Files on an ISO are stored contiguous and uncompressed, so a path -> (offset, size) table is all that is needed
// to pull individual game files straight out of a remote disc image.
const ISO = (() => {
  function rangeSource(url, log) {
    let total = 0;
    return { kind: 'url', url, bytesFetched: () => total,
      async read(off, len, allowShort) {
        const ctl = new AbortController();
        const r = await fetch(url, { headers: { Range: `bytes=${off}-${off + len - 1}` }, signal: ctl.signal, mode: 'cors', credentials: 'omit' });
        if (r.status === 200) { ctl.abort(); throw new Error('the server ignored the Range header and started sending the whole 613 MB image'); }
        if (r.status !== 206) throw new Error('HTTP ' + r.status + ' from the image host');
        const b = new Uint8Array(await r.arrayBuffer()); total += b.length;
        if (b.length !== len && !(allowShort && b.length > 0 && b.length < len)) throw new Error(`asked for ${len} bytes, received ${b.length}`);
        return b;
      } };
  }
  function fileSource(file) { return { kind: 'file', url: 'local:' + file.name + ':' + file.size, bytesFetched: () => 0, async read(off, len) { return new Uint8Array(await file.slice(off, off + len).arrayBuffer()); } }; }

  // small aligned block cache so that walking directories costs only a few requests
  function cached(src, block = 1 << 20) {
    const blocks = new Map();
    return async (off, len) => {
      const out = new Uint8Array(len); let done = 0;
      while (done < len) { const p = off + done, bi = Math.floor(p / block);
        if (!blocks.has(bi)) { const pr = src.read(bi * block, block, true); pr.catch(() => blocks.delete(bi)); blocks.set(bi, pr); }
        const b = await blocks.get(bi);
        if (p - bi * block >= b.length) throw new Error('read past the end of the disc image');
        const o = p - bi * block, n = Math.min(len - done, b.length - o); out.set(b.subarray(o, o + n), done); done += n; }
      return out;
    };
  }
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  async function readTable(src, log) {
    const rd = cached(src), desc = await rd(16 * 2048, 16 * 2048);
    let primary = null, joliet = null;
    for (let i = 0; i < 16; i++) { const d = desc.subarray(i * 2048, (i + 1) * 2048), id = String.fromCharCode(...d.subarray(1, 6));
      if (id !== 'CD001') break; if (d[0] === 255) break;
      if (d[0] === 1 && !primary) primary = d;
      if (d[0] === 2 && d[88] === 0x25 && d[89] === 0x2f && [0x40, 0x43, 0x45].includes(d[90])) joliet = d; }
    if (!primary) throw new Error('no ISO 9660 volume descriptor found at sector 16 (is this really an ISO image?)');
    const vd = joliet || primary, isJ = !!joliet, table = new Map();
    const decode = (b) => { if (!isJ) return String.fromCharCode(...b); let s = ''; for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]); return s; };
    async function walk(lba, size, path, depth) {
      if (depth > 12) return; const d = await rd(lba * 2048, size); let p = 0;
      while (p < size) { const len = d[p]; if (!len) { p = (Math.floor(p / 2048) + 1) * 2048; continue; }
        const ext = u32(d, p + 2), sz = u32(d, p + 10), flags = d[p + 25], nl = d[p + 32], nb = d.subarray(p + 33, p + 33 + nl); p += len;
        if (nl === 1 && (nb[0] === 0 || nb[0] === 1)) continue;
        const name = decode(nb).replace(/;\d+$/, '').replace(/\.$/, '').toUpperCase();
        if (flags & 2) await walk(ext, sz, path + '\\' + name, depth + 1); else table.set(path + '\\' + name, { off: ext * 2048, size: sz }); }
    }
    await walk(u32(vd, 156 + 2), u32(vd, 156 + 10), '', 0);
    if (log) log(`Disc image: ${table.size} files listed (${isJ ? 'Joliet' : 'ISO 9660'} names).`);
    return table;
  }

  // Fetch a set of files with as few requests as possible: neighbouring files are merged into spans.
  async function fetchFiles(src, entries, onProgress, gap = 512 << 10, maxSpan = 16 << 20, parallel = 3) {
    const list = entries.filter(e => e.size > 0).sort((a, b) => a.off - b.off), spans = [];
    for (const e of list) { const s = spans[spans.length - 1];
      if (s && e.off - s.end <= gap && e.off + e.size - s.off <= maxSpan) { s.end = Math.max(s.end, e.off + e.size); s.files.push(e); } else spans.push({ off: e.off, end: e.off + e.size, files: [e] }); }
    const total = spans.reduce((t, s) => t + s.end - s.off, 0), out = new Map(); let done = 0, next = 0;
    for (const e of entries) if (e.size === 0) out.set(e.path, new Uint8Array(0));
    async function worker() { while (next < spans.length) { const s = spans[next++]; let b, tries = 0;
        for (;;) { try { b = await src.read(s.off, s.end - s.off); break; } catch (err) { if (++tries >= 3) throw err; await new Promise(r => setTimeout(r, 800 * tries)); } }
        for (const f of s.files) out.set(f.path, b.slice(f.off - s.off, f.off - s.off + f.size)); done += s.end - s.off; if (onProgress) onProgress(done, total); } }
    await Promise.all(Array.from({ length: Math.min(parallel, spans.length) }, worker));
    return out;
  }
  return { rangeSource, fileSource, readTable, fetchFiles };
})();
if (typeof module !== 'undefined') module.exports = ISO;
