/**
 * Zero-dependency Offline QR Code (Byte mode, Version 1-4, ECC-L) + CSV Parser
 * for PrintKit Variable Data Printing (VDP) & Numbering.
 */

// --- Lightweight QR Code Encoder (Byte mode, Error Correction L) ---
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(deg) {
  let poly = [1];
  for (let i = 0; i < deg; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const res = new Uint8Array(data.length + ecLen);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        res[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return res.slice(data.length);
}

// Version specs for ECC-L: [version, totalDataBytes, ecBytes]
const QR_VER_L = [
  [1, 19, 7],
  [2, 34, 10],
  [3, 55, 15],
  [4, 80, 20],
  [5, 108, 26],
];

const ALIGN_POS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
};

export function encodeQrMatrix(text) {
  const utf8 = new TextEncoder().encode(String(text || ' '));
  let spec = QR_VER_L.find(([, cap]) => utf8.length + 2 <= cap);
  const bytes = spec ? utf8 : utf8.slice(0, 106);
  if (!spec) spec = QR_VER_L[QR_VER_L.length - 1];

  const [ver, dataCap, ecLen] = spec;
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);
  pushBits(0, Math.min(4, dataCap * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const dataBytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    dataBytes.push(v);
  }
  const pad = [0xec, 0x11];
  let pi = 0;
  while (dataBytes.length < dataCap) {
    dataBytes.push(pad[pi++ % 2]);
  }

  const ec = rsEncode(dataBytes, ecLen);
  const allBytes = [...dataBytes, ...ec];
  const size = ver * 4 + 17;
  const mod = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));

  const setFixed = (r, c, v) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      mod[r][c] = v ? 1 : 0;
      reserved[r][c] = 1;
    }
  };

  const drawFinder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr, c = c0 + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const on =
          (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
          (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) ||
          (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
        setFixed(r, c, on);
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  const ap = ALIGN_POS[ver];
  for (const r of ap) {
    for (const c of ap) {
      if (reserved[r][c]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const on = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
          setFixed(r + dr, c + dc, on);
        }
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    setFixed(6, i, i % 2 === 0);
    setFixed(i, 6, i % 2 === 0);
  }
  setFixed(size - 8, 8, 1);

  // Reserve format info
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      reserved[8][i] = 1;
      reserved[i][8] = 1;
    }
  }
  for (let i = size - 8; i < size; i++) {
    reserved[8][i] = 1;
    reserved[i][8] = 1;
  }

  // Place data bits (mask 0: (r + c) % 2 === 0)
  let bitIdx = 0;
  const totalBits = allBytes.length * 8;
  let up = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col--;
    for (let step = 0; step < size; step++) {
      const r = up ? size - 1 - step : step;
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (!reserved[r][c]) {
          let b = 0;
          if (bitIdx < totalBits) {
            b = (allBytes[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
            bitIdx++;
          }
          mod[r][c] = b ^ ((r + c) % 2 === 0 ? 1 : 0);
        }
      }
    }
    up = !up;
  }

  // Format info for ECC-L (01) + Mask 0 (000) -> 15-bit BCH: 111011111000100
  const fmtBits = '111011111000100';
  for (let i = 0; i < 15; i++) {
    const bit = fmtBits[i] === '1' ? 1 : 0;
    if (i < 6) mod[i][8] = bit;
    else if (i < 8) mod[i + 1][8] = bit;
    else mod[size - 15 + i][8] = bit;

    if (i < 8) mod[8][size - 1 - i] = bit;
    else if (i < 9) mod[8][15 - i] = bit;
    else mod[8][14 - i] = bit;
  }

  return mod;
}

/**
 * Parse CSV or Tab-separated (pasted from Excel) text into { headers, rows }.
 */
export function parseTabularData(rawText) {
  const lines = String(rawText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const splitLine = (line) => {
    if (delimiter === '\t') return line.split('\t').map((s) => s.trim());
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };

  const headers = splitLine(lines[0]).map((h, i) => h || `Cot_${i + 1}`);
  const rows = lines.slice(1).map((line) => {
    const vals = splitLine(line);
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = vals[i] ?? '';
    });
    return obj;
  });

  return { headers, rows };
}
