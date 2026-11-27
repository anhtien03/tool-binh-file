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

// --- Zero-dependency 1D Vector Barcode Encoder (Code 128B, EAN-13, Code 39) ---

// Standard ISO/IEC 15417 Code 128 bar/space width patterns (indices 0..106)
const CODE128_PATTERNS = [
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
  '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
  '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
  '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
  '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
  '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
  '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
  '114131','311141','411131','211412','211214','211232','2331112',
];

// Standard ISO/IEC 15420 EAN-13 tables
const EAN_L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const EAN_G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
const EAN_R = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
const EAN_PARITY = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];

// Standard ISO/IEC 16388 Code 39 patterns (n=narrow, w=wide; alternating bar/space)
const CODE39_MAP = {
  '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw',
  '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
  'A': 'wnnnnwnnw', 'B': 'nnwnnwnnw', 'C': 'wnwnnwnnn', 'D': 'nnnnwwnnw', 'E': 'wnnnwwnnn',
  'F': 'nnwnwwnnn', 'G': 'nnnnnwwnw', 'H': 'wnnnnwwnn', 'I': 'nnwnnwwnn', 'J': 'nnnnwwwnn',
  'K': 'wnnnnnnww', 'L': 'nnwnnnnww', 'M': 'wnwnnnnwn', 'N': 'nnnnwnnww', 'O': 'wnnnwnnwn',
  'P': 'nnwnwnnwn', 'Q': 'nnnnnnwww', 'R': 'wnnnnnwwn', 'S': 'nnwnnnwwn', 'T': 'nnnnwnwwn',
  'U': 'wwnnnnnnw', 'V': 'nwwnnnnnw', 'W': 'wwwnnnnnn', 'X': 'nwnnwnnnw', 'Y': 'wwnnwnnnn',
  'Z': 'nwwnwnnnn', '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '$': 'nwnwnwnnn',
  '/': 'nwnwnnnwn', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn', '*': 'nwnnwnwnn',
};

function modulesToRuns(bits) {
  const runs = [];
  let i = 0;
  while (i < bits.length) {
    if (bits[i] === 1) {
      const start = i;
      while (i < bits.length && bits[i] === 1) i++;
      runs.push([start, i - start]);
    } else {
      i++;
    }
  }
  return { runs, totalCols: bits.length };
}

function encodeCode128B(raw) {
  const clean = String(raw || '0001')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '') || '0001';

  const codes = [104]; // Start Code B
  let checksum = 104;
  for (let i = 0; i < clean.length; i++) {
    const val = clean.charCodeAt(i) - 32;
    codes.push(val);
    checksum += val * (i + 1);
  }
  codes.push(checksum % 103);
  codes.push(106); // Stop

  const bits = [];
  for (const code of codes) {
    const pat = CODE128_PATTERNS[code];
    for (let i = 0; i < pat.length; i++) {
      const w = Number(pat[i]);
      const bit = i % 2 === 0 ? 1 : 0;
      for (let k = 0; k < w; k++) bits.push(bit);
    }
  }
  const { runs, totalCols } = modulesToRuns(bits);
  return { runs, totalCols, text: clean, symbology: 'code128' };
}

function encodeEan13(raw) {
  const digitsOnly = String(raw || '').replace(/\D/g, '');
  const base12 = (digitsOnly.length >= 12 ? digitsOnly.slice(0, 12) : digitsOnly.padStart(12, '0'));
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(base12[i]) * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  const full13 = base12 + String(check);

  const parity = EAN_PARITY[Number(full13[0])];
  let bitStr = '101'; // Left guard
  for (let i = 1; i <= 6; i++) {
    const d = Number(full13[i]);
    bitStr += parity[i - 1] === 'L' ? EAN_L[d] : EAN_G[d];
  }
  bitStr += '01010'; // Center guard
  for (let i = 7; i <= 12; i++) {
    bitStr += EAN_R[Number(full13[i])];
  }
  bitStr += '101'; // Right guard

  const bits = Array.from(bitStr, (c) => (c === '1' ? 1 : 0));
  const { runs, totalCols } = modulesToRuns(bits);
  return { runs, totalCols, text: full13, symbology: 'ean13' };
}

function encodeCode39(raw) {
  const clean = String(raw || '0001')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^0-9A-Z\-. $/+%]/g, '') || '0001';
  const wrapped = `*${clean}*`;
  const bits = [];
  for (let c = 0; c < wrapped.length; c++) {
    const pat = CODE39_MAP[wrapped[c]] || CODE39_MAP['0'];
    for (let i = 0; i < pat.length; i++) {
      const w = pat[i] === 'w' ? 2 : 1;
      const bit = i % 2 === 0 ? 1 : 0;
      for (let k = 0; k < w; k++) bits.push(bit);
    }
    if (c < wrapped.length - 1) bits.push(0); // inter-character narrow space
  }
  const { runs, totalCols } = modulesToRuns(bits);
  return { runs, totalCols, text: clean, symbology: 'code39' };
}

export function encodeBarcode1D(value, symbology = 'code128') {
  if (symbology === 'ean13') return encodeEan13(value);
  if (symbology === 'code39') return encodeCode39(value);
  return encodeCode128B(value);
}
