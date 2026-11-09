/*
 * ParticleCode codec — color-particle screen-to-camera data channel.
 *
 * Payload -> UTF-8 bytes -> 43-byte chunks -> framed blocks
 *   [id][total][session][len][payload...43][crc16 lo][crc16 hi] = 49 data bytes
 *   + 11 Reed-Solomon parity bytes over GF(256)               = 60-byte state
 * State -> 480 bits -> 160 3-bit symbols -> 160 particle colors.
 *
 * Palette: 6 hues (0/60/120/180/240/300 deg, s=1, v=0.88) + 2 grays (0.80 / 0.48).
 * White is reserved for the 4 corner anchors; near-black is background.
 *
 * Layout (unit square, y down): 160 slots from a seeded Poisson-disc sample
 * inside an ellipse (center-dense, no lattice). The point set is deterministic,
 * so encoder and decoder agree; discs/wander/dot-size adapt to local spacing.
 *   anchors: TL capsule bar + TR (0.955,0.055) BR (0.955,0.945) BL (0.045,0.945)
 *   hue-calibration satellites: red (0.32,0.055) green (0.50,0.055) blue (0.68,0.055)
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PC = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- constants
  const COLS = 16, ROWS = 10, SLOTS = COLS * ROWS;      // 160 slots
  const BITS_PER_SYM = 3;                               // 8 palette colors
  const STATE_BYTES = (SLOTS * BITS_PER_SYM) / 8;       // 60
  const RS_N = 60, RS_K = 49, RS_NSYM = RS_N - RS_K;    // RS(60,49), t = 5 byte errors
  const PAYLOAD = 43;                                   // usable bytes per block

  const SYMS = [
    { hue: 0 },   { hue: 60 }, { hue: 120 }, { hue: 180 },
    { hue: 240 }, { hue: 300 },
    { gray: 0.80 }, { gray: 0.48 }
  ];

  const LAYOUT = {
    // organic constellation: 160 slots from a seeded Poisson-disc sample inside
    // an ellipse (center-dense), generated below. No lattice — but the point
    // set is deterministic, so encoder and decoder agree by construction.
    gridX0: 0.10, gridY0: 0.12, gridX1: 0.90, gridY1: 0.88,   // slot bounds
    // TL marker is a solid white capsule bar — one blob, ~2.8x a single
    // anchor's area, rotation-invariant to detect by area ratio.
    bar: { c: [0.09, 0.055], len: 0.15, th: 0.062 },
    TR: [0.955, 0.055], BR: [0.955, 0.945], BL: [0.045, 0.945],
    anchorR: 0.032, satR: 0.014,
    sats: [
      { p: [0.32, 0.055], hue: 0 },
      { p: [0.50, 0.055], hue: 120 },
      { p: [0.68, 0.055], hue: 240 }
    ]
  };
  LAYOUT.TL = LAYOUT.bar.c; // the homography corner

  // ---- deterministic organic slot placement (seeded, shared by both ends) ----
  const SLOT_POS = (function () {
    let seed = 0x9E3779B9;
    const rnd = () => {
      seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    const pts = [];
    let minD = 0.052;
    while (pts.length < SLOTS && minD > 0.02) {
      pts.length = 0;
      let tries = 0;
      while (pts.length < SLOTS && tries++ < 80000) {
        const a = rnd() * 6.2832, rr = Math.pow(rnd(), 0.7);   // mild center bias
        const x = 0.5 + Math.cos(a) * rr * 0.40;
        const y = 0.5 + Math.sin(a) * rr * 0.35;
        let ok = true;
        for (let k = 0; k < pts.length; k++) {
          const dx = pts[k][0] - x, dy = pts[k][1] - y;
          if (dx * dx + dy * dy < minD * minD) { ok = false; break; }
        }
        if (ok) pts.push([x, y]);
      }
      minD *= 0.93;                                            // relax until 160 fit
    }
    return pts;
  })();

  // per-slot nearest-neighbour spacing → adaptive discs, wander and dot size
  const SLOT_MD = new Float64Array(SLOTS);
  (function () {
    for (let i = 0; i < SLOTS; i++) {
      let m = 1;
      for (let j = 0; j < SLOTS; j++) {
        if (j === i) continue;
        const d = Math.hypot(SLOT_POS[j][0] - SLOT_POS[i][0], SLOT_POS[j][1] - SLOT_POS[i][1]);
        if (d < m) m = d;
      }
      SLOT_MD[i] = m;
    }
  })();
  const MD_MEAN = SLOT_MD.reduce((a, b) => a + b, 0) / SLOTS;

  const slotHash = i => { const x = Math.sin((i + 1) * 91.3) * 47453.7; return x - Math.floor(x); };

  // per-slot depth in [0,1]: near particles render bigger, brighter and wander
  // further; far ones are small, dim and steady — a 3D parallax cue.
  function slotDepth(i) { return slotHash(i + 0.313); }

  function slotPos(i) { return SLOT_POS[i % SLOTS]; }
  function slotDiscR(i) { return 0.42 * SLOT_MD[i]; }           // sampling disc
  function slotAmp(i) { return 0.35 * SLOT_MD[i] * (0.5 + 0.6 * slotDepth(i)); }
  function dataR(i) {                                            // depth-sized, spacing-capped
    return Math.min(0.24 * MD_MEAN * (0.62 + 0.93 * slotDepth(i)), 0.56 * SLOT_MD[i]);
  }
  function cellPitch() { return MD_MEAN; }

  // ------------------------------------------------------------------ GF(256)
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const gmul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;
  const gdiv = (a, b) => {
    if (!b) throw new Error('div0');
    if (!a) return 0;
    return EXP[(LOG[a] + 255 - LOG[b]) % 255];
  };
  const gpow = (x, e) => x ? EXP[(LOG[x] * e) % 255] : 0;

  const GEN = (function () {  // generator poly, roots a^0..a^10, degree 11
    let g = [1];
    for (let i = 0; i < RS_NSYM; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= gmul(g[j], EXP[i]); }
      g = ng;
    }
    return g;
  })();

  function rsParity(data) {         // data: RS_K bytes -> RS_NSYM parity bytes
    const rem = new Uint8Array(RS_NSYM);
    for (let i = 0; i < data.length; i++) {
      const f = data[i] ^ rem[0];
      for (let j = 0; j < RS_NSYM - 1; j++) rem[j] = rem[j + 1];
      rem[RS_NSYM - 1] = 0;
      if (f) for (let j = 0; j < RS_NSYM; j++) rem[j] ^= gmul(GEN[j + 1], f);
    }
    return rem;
  }

  function polyEval(p, x) {          // p[0] = highest-degree coeff (codewords)
    let acc = 0;
    for (let i = 0; i < p.length; i++) acc = gmul(acc, x) ^ p[i];
    return acc;
  }
  function polyEvalAsc(p, x) {       // p[0] = constant coeff (sigma, omega)
    let acc = 0;
    for (let i = p.length - 1; i >= 0; i--) acc = gmul(acc, x) ^ p[i];
    return acc;
  }
  function polyMul(a, b) {
    const r = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++)
      for (let j = 0; j < b.length; j++) r[i + j] ^= gmul(a[i], b[j]);
    return r;
  }

  function rsDecode(cw) {           // cw: Uint8Array(RS_N), mutates in place
    const n = RS_N, nsym = RS_NSYM;
    const S = [];
    for (let j = 0; j < nsym; j++) S.push(polyEval(cw, EXP[j]));
    if (S.every(s => s === 0)) return { ok: true, nerr: 0 };
    // Berlekamp-Massey
    let L = 0, sigma = [1], B = [1], b = 1, m = 1;
    for (let r = 0; r < nsym; r++) {
      let d = S[r];
      for (let i = 1; i <= L && i < sigma.length; i++) d ^= gmul(sigma[i], S[r - i]);
      if (d === 0) { m++; }
      else {
        const coef = gdiv(d, b);
        const sh = new Array(m + B.length).fill(0);
        for (let i = 0; i < B.length; i++) sh[i + m] = gmul(B[i], coef);
        const ns2 = new Array(Math.max(sigma.length, sh.length)).fill(0);
        for (let i = 0; i < sigma.length; i++) ns2[i] ^= sigma[i];
        for (let i = 0; i < sh.length; i++) ns2[i] ^= sh[i];
        if (2 * L <= r) { const T = sigma.slice(); sigma = ns2; B = T; L = r + 1 - L; b = d; m = 1; }
        else { sigma = ns2; m++; }
      }
    }
    const nerr = sigma.length - 1;
    if (nerr < 1 || nerr > (nsym >> 1)) return { ok: false, why: 'deg' };
    // Chien search: position p (index into cw, cw[0] = x^(n-1) coeff)
    const errPos = [];
    for (let p = 0; p < n; p++) {
      const e = n - 1 - p;
      const xInv = e === 0 ? 1 : EXP[255 - e];
      if (polyEvalAsc(sigma, xInv) === 0) errPos.push(p);
    }
    if (errPos.length !== nerr) return { ok: false, why: 'chien' };
    // Forney (fcr = 0)
    const om = polyMul(S, sigma).slice(0, nsym);
    // char-2 formal derivative: L'(x) = L1 + L3 x^2 + L5 x^4 + ...  (coeff shift!)
    const sigd = new Array(Math.max(0, sigma.length - 1)).fill(0);
    for (let k = 0; k < sigd.length; k++) sigd[k] = (k % 2 === 0) ? sigma[k + 1] : 0;
    for (const p of errPos) {
      const e = n - 1 - p;
      const Xi = e === 0 ? 1 : EXP[e];
      const Xinv = e === 0 ? 1 : EXP[255 - e];
      const den = polyEvalAsc(sigd, Xinv);
      if (!den) return { ok: false, why: 'forney-den' };
      cw[p] ^= gmul(Xi, gdiv(polyEvalAsc(om, Xinv), den));
    }
    for (let j = 0; j < nsym; j++) if (polyEval(cw, EXP[j]) !== 0) return { ok: false, why: 'verify' };
    return { ok: true, nerr: errPos.length };
  }

  // --------------------------------------------------------------------- CRC
  function crc16(buf) {             // CRC-16/XMODEM
    let c = 0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i] << 8;
      for (let k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) : (c << 1);
    }
    return c & 0xffff;
  }

  // ----------------------------------------------------------------- framing
  // Block: [id][total][session][len][payload...43][crc16 lo][crc16 hi] = 49 bytes.
  // `session` increments on every sender-side text edit, so a live-typing
  // receiver can tell "same message" from "edited message" and drop stale blocks.
  function encodeMessage(text, session) {
    session = (session || 0) & 0xff;
    const bytes = new TextEncoder().encode(text);
    const total = Math.max(1, Math.ceil(bytes.length / PAYLOAD));
    const states = [];
    for (let id = 0; id < total; id++) {
      const chunk = bytes.slice(id * PAYLOAD, (id + 1) * PAYLOAD);
      const D = new Uint8Array(RS_K);
      D[0] = id; D[1] = total; D[2] = session; D[3] = chunk.length;
      D.set(chunk, 4);
      const crc = crc16(D.subarray(0, RS_K - 2));
      D[RS_K - 2] = crc & 0xff; D[RS_K - 1] = crc >>> 8;
      const st = new Uint8Array(RS_N);
      st.set(D);
      st.set(rsParity(D), RS_K);
      states.push(st);
    }
    return states;
  }

  function decodeState(st) {
    const cw = Uint8Array.from(st);
    const r = rsDecode(cw);
    if (!r.ok) return { ok: false, why: r.why || 'rs' };
    const id = cw[0], total = cw[1], session = cw[2], len = cw[3];
    if (total < 1 || total > 255 || id >= total || len > PAYLOAD) return { ok: false, why: 'hdr' };
    const crc = crc16(cw.subarray(0, RS_K - 2));
    if (cw[RS_K - 2] !== (crc & 0xff) || cw[RS_K - 1] !== (crc >>> 8)) return { ok: false, why: 'crc' };
    return { ok: true, id, total, session, len, payload: cw.slice(4, 4 + len), nerr: r.nerr };
  }

  // -------------------------------------------------------------- bit-packing
  function stateToSymbols(st) {     // 60 bytes -> 160 symbols (MSB-first, 3 bit)
    const syms = new Uint8Array(SLOTS);
    let buf = 0, bits = 0, si = 0;
    for (let i = 0; i < st.length; i++) {
      buf = (buf << 8) | st[i]; bits += 8;
      while (bits >= BITS_PER_SYM && si < SLOTS) {
        bits -= BITS_PER_SYM;
        syms[si++] = (buf >> bits) & 7;
      }
    }
    return syms;
  }
  function symbolsToState(syms) {
    const st = new Uint8Array(STATE_BYTES);
    let buf = 0, bits = 0, bi = 0;
    for (let i = 0; i < SLOTS; i++) {
      buf = (buf << BITS_PER_SYM) | syms[i]; bits += BITS_PER_SYM;
      if (bits >= 8) { bits -= 8; st[bi++] = (buf >> bits) & 0xff; }
    }
    return st;
  }

  // ---------------------------------------------------------------- geometry
  // Solve unit-square -> quad homography (8x8 Gaussian elimination, partial pivot).
  function solveHomography(src, dst) {  // src/dst: [[x,y]x4]
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [u, v] = src[i], [x, y] = dst[i];
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
    }
    for (let col = 0; col < 8; col++) {
      let piv = col;
      for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      if (Math.abs(A[piv][col]) < 1e-12) return null;
      [A[col], A[piv]] = [A[piv], A[col]];
      [b[col], b[piv]] = [b[piv], b[col]];
      for (let r = 0; r < 8; r++) {
        if (r === col) continue;
        const f = A[r][col] / A[col][col];
        for (let c = col; c < 8; c++) A[r][c] -= f * A[col][c];
        b[r] -= f * b[col];
      }
    }
    const h = new Float64Array(9);
    for (let i = 0; i < 8; i++) h[i] = b[i] / A[i][i];
    h[8] = 1;
    return (u, v) => {
      const d = h[6] * u + h[7] * v + 1;
      return [(h[0] * u + h[1] * v + h[2]) / d, (h[3] * u + h[4] * v + h[5]) / d];
    };
  }

  function hsvToRgb(h, s, v) {
    const f = (n) => {
      const k = (n + h / 60) % 6;
      return v - v * s * Math.max(Math.min(k, 4 - k, 1), 0);
    };
    return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
  }

  return {
    COLS, ROWS, SLOTS, STATE_BYTES, RS_N, RS_K, RS_NSYM, PAYLOAD,
    SYMS, LAYOUT, slotPos, slotDiscR, slotAmp, slotDepth, cellPitch, dataR,
    encodeMessage, decodeState, stateToSymbols, symbolsToState,
    solveHomography, hsvToRgb, crc16,
    _rs: { rsParity, rsDecode }
  };
});
