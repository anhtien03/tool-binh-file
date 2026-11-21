import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, decodePDFRawStream } from 'pdf-lib';
import { MM_TO_PT } from './impositionEngine.js';

const CUT_SPOT_REGEX = /cut|die|contour|kiss|perf|thru/i;

function mulMat(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

function applyMat(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function sampleCubicBezier(p0, p1, p2, p3, steps = 12) {
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0];
    const y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1];
    pts.push([x, y]);
  }
  return pts;
}

/**
 * Resolve ColorSpace resource names that represent a CutContour / DieCut Spot Color
 */
function collectCutColorSpaces(resources, context) {
  const cutCS = new Set();
  if (!resources || !(resources instanceof PDFDict)) return cutCS;

  const csDict = resources.lookupMaybe(PDFName.of('ColorSpace'), PDFDict);
  if (!csDict) return cutCS;

  for (const [key, val] of csDict.entries()) {
    const csName = key instanceof PDFName ? key.decodeText() : String(key).replace(/^\//, '');
    let resolved = val;
    if (resolved instanceof PDFRef) resolved = context.lookup(resolved);
    if (resolved instanceof PDFArray && resolved.size() >= 2) {
      const kind = resolved.get(0);
      const kindStr = kind instanceof PDFName ? kind.decodeText() : '';
      if (kindStr === 'Separation') {
        const spot = resolved.get(1);
        const spotName = spot instanceof PDFName ? spot.decodeText() : '';
        if (CUT_SPOT_REGEX.test(spotName)) {
          cutCS.add(csName);
        }
      } else if (kindStr === 'DeviceN') {
        const namesArr = resolved.lookupMaybe(1, PDFArray);
        if (namesArr) {
          for (let i = 0; i < namesArr.size(); i++) {
            const n = namesArr.get(i);
            const s = n instanceof PDFName ? n.decodeText() : '';
            if (CUT_SPOT_REGEX.test(s)) cutCS.add(csName);
          }
        }
      }
    }
  }
  return cutCS;
}

/**
 * Tokenize a decoded PDF content stream into numbers, names (/X), strings, and operators
 */
function tokenizeContentStream(bytes) {
  const str = new TextDecoder('latin1').decode(bytes);
  const tokens = [];
  let i = 0;
  const n = str.length;

  while (i < n) {
    const ch = str[i];
    if (ch <= ' ') {
      i++;
      continue;
    }
    if (ch === '%') {
      while (i < n && str[i] !== '\n' && str[i] !== '\r') i++;
      continue;
    }
    if (ch === '(') {
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        if (str[i] === '\\') i += 2;
        else {
          if (str[i] === '(') depth++;
          else if (str[i] === ')') depth--;
          i++;
        }
      }
      tokens.push({ type: 'str', val: '' });
      continue;
    }
    if (ch === '<' && str[i + 1] === '<') {
      i += 2;
      tokens.push({ type: 'dictOpen', val: '<<' });
      continue;
    }
    if (ch === '>' && str[i + 1] === '>') {
      i += 2;
      tokens.push({ type: 'dictClose', val: '>>' });
      continue;
    }
    if (ch === '<') {
      i++;
      while (i < n && str[i] !== '>') i++;
      i++;
      tokens.push({ type: 'str', val: '' });
      continue;
    }
    if (ch === '[' || ch === ']') {
      tokens.push({ type: 'punct', val: ch });
      i++;
      continue;
    }
    if (ch === '/') {
      i++;
      const start = i;
      while (i < n && str[i] > ' ' && !'[]()<>{}/%'.includes(str[i])) i++;
      tokens.push({ type: 'name', val: str.slice(start, i) });
      continue;
    }
    const start = i;
    while (i < n && str[i] > ' ' && !'[]()<>{}/%'.includes(str[i])) i++;
    const word = str.slice(start, i);
    const num = Number(word);
    if (word !== '' && !Number.isNaN(num)) {
      tokens.push({ type: 'num', val: num });
    } else {
      tokens.push({ type: 'op', val: word });
    }
  }
  return tokens;
}

function getStreamBytes(obj, context) {
  if (!obj) return new Uint8Array(0);
  const resolved = obj instanceof PDFRef ? context.lookup(obj) : obj;
  if (!resolved) return new Uint8Array(0);
  if (resolved instanceof PDFArray) {
    const chunks = [];
    let total = 0;
    for (let i = 0; i < resolved.size(); i++) {
      const b = getStreamBytes(resolved.get(i), context);
      chunks.push(b);
      total += b.length + 1;
    }
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
      merged[off++] = 32; // space separator
    }
    return merged;
  }
  try {
    return decodePDFRawStream(resolved).decode();
  } catch {
    return resolved.contents || new Uint8Array(0);
  }
}

/**
 * Extract CutContour vector paths from a single PDFPage (returned in mm, origin top-left of MediaBox)
 */
export function extractCutContoursFromPdfPage(pdfDoc, page) {
  const context = pdfDoc.context;
  const mediaBox = page.getMediaBox();
  const pageH = mediaBox.height;

  const spotPaths = [];
  const magentaFallbackPaths = [];

  const processStream = (streamObj, resources, initialCtm, depth = 0) => {
    if (depth > 8) return;
    const bytes = getStreamBytes(streamObj, context);
    if (!bytes || bytes.length === 0) return;

    const cutCS = collectCutColorSpaces(resources, context);
    const tokens = tokenizeContentStream(bytes);
    const operands = [];

    const stack = [];
    let state = {
      ctm: initialCtm,
      strokeCS: '',
      isCutSpotStroke: false,
      isMagentaStroke: false,
    };

    let currentSubpaths = [];
    let curPath = [];
    let curX = 0, curY = 0;

    const finishPath = (doStroke) => {
      if (doStroke && currentSubpaths.length > 0) {
        if (state.isCutSpotStroke) {
          currentSubpaths.forEach((sp) => spotPaths.push(sp));
        } else if (state.isMagentaStroke) {
          currentSubpaths.forEach((sp) => magentaFallbackPaths.push(sp));
        }
      }
      currentSubpaths = [];
      curPath = [];
    };

    for (const tok of tokens) {
      if (tok.type !== 'op') {
        operands.push(tok);
        continue;
      }

      const op = tok.val;
      const nums = () => operands.filter((o) => o.type === 'num').map((o) => o.val);

      switch (op) {
        case 'q':
          stack.push({ ...state, ctm: [...state.ctm] });
          break;
        case 'Q':
          if (stack.length > 0) state = stack.pop();
          break;
        case 'cm': {
          const a = nums();
          if (a.length >= 6) {
            state.ctm = mulMat(a.slice(-6), state.ctm);
          }
          break;
        }
        case 'CS': {
          const last = operands[operands.length - 1];
          if (last && last.type === 'name') {
            state.strokeCS = last.val;
            state.isCutSpotStroke = cutCS.has(last.val);
            if (!state.isCutSpotStroke) state.isMagentaStroke = false;
          }
          break;
        }
        case 'K': {
          // DeviceCMYK stroke color: 0 1 0 0 K = pure Magenta
          const a = nums();
          if (a.length >= 4) {
            const [c, m, y, k] = a.slice(-4);
            state.isCutSpotStroke = false;
            state.isMagentaStroke = c <= 0.05 && m >= 0.9 && y <= 0.05 && k <= 0.05;
          }
          break;
        }
        case 'G':
        case 'RG':
          state.isCutSpotStroke = false;
          state.isMagentaStroke = false;
          break;
        case 'SC':
        case 'SCN': {
          if (cutCS.has(state.strokeCS)) {
            state.isCutSpotStroke = true;
          }
          break;
        }
        case 'm': {
          const a = nums();
          if (a.length >= 2) {
            if (curPath.length >= 2) currentSubpaths.push({ pts: curPath, closed: false });
            [curX, curY] = [a[a.length - 2], a[a.length - 1]];
            curPath = [applyMat(state.ctm, curX, curY)];
          }
          break;
        }
        case 'l': {
          const a = nums();
          if (a.length >= 2) {
            [curX, curY] = [a[a.length - 2], a[a.length - 1]];
            curPath.push(applyMat(state.ctm, curX, curY));
          }
          break;
        }
        case 'c': {
          const a = nums();
          if (a.length >= 6) {
            const [x1, y1, x2, y2, x3, y3] = a.slice(-6);
            const p0 = applyMat(state.ctm, curX, curY);
            const p1 = applyMat(state.ctm, x1, y1);
            const p2 = applyMat(state.ctm, x2, y2);
            const p3 = applyMat(state.ctm, x3, y3);
            curPath.push(...sampleCubicBezier(p0, p1, p2, p3, 10));
            curX = x3;
            curY = y3;
          }
          break;
        }
        case 'v': {
          const a = nums();
          if (a.length >= 4) {
            const [x2, y2, x3, y3] = a.slice(-4);
            const p0 = applyMat(state.ctm, curX, curY);
            const p2 = applyMat(state.ctm, x2, y2);
            const p3 = applyMat(state.ctm, x3, y3);
            curPath.push(...sampleCubicBezier(p0, p0, p2, p3, 10));
            curX = x3;
            curY = y3;
          }
          break;
        }
        case 'y': {
          const a = nums();
          if (a.length >= 4) {
            const [x1, y1, x3, y3] = a.slice(-4);
            const p0 = applyMat(state.ctm, curX, curY);
            const p1 = applyMat(state.ctm, x1, y1);
            const p3 = applyMat(state.ctm, x3, y3);
            curPath.push(...sampleCubicBezier(p0, p1, p3, p3, 10));
            curX = x3;
            curY = y3;
          }
          break;
        }
        case 'h': {
          if (curPath.length >= 2) {
            currentSubpaths.push({ pts: curPath, closed: true });
            curPath = [];
          }
          break;
        }
        case 're': {
          const a = nums();
          if (a.length >= 4) {
            const [rx, ry, rw, rh] = a.slice(-4);
            const rectPts = [
              applyMat(state.ctm, rx, ry),
              applyMat(state.ctm, rx + rw, ry),
              applyMat(state.ctm, rx + rw, ry + rh),
              applyMat(state.ctm, rx, ry + rh),
            ];
            currentSubpaths.push({ pts: rectPts, closed: true });
            curX = rx;
            curY = ry;
          }
          break;
        }
        case 'S':
        case 's':
        case 'B':
        case 'b':
        case 'B*':
        case 'b*': {
          if (curPath.length >= 2) {
            currentSubpaths.push({ pts: curPath, closed: op === 's' || op === 'b' || op === 'b*' });
            curPath = [];
          }
          finishPath(true);
          break;
        }
        case 'f':
        case 'F':
        case 'f*':
        case 'n':
          finishPath(false);
          break;
        case 'Do': {
          const last = operands[operands.length - 1];
          if (last && last.type === 'name' && resources instanceof PDFDict) {
            const xoDict = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
            const xo = xoDict?.lookup(PDFName.of(last.val));
            if (xo && xo.dict) {
              const subType = xo.dict.lookup(PDFName.of('Subtype'));
              if (subType instanceof PDFName && subType.decodeText() === 'Form') {
                const matArr = xo.dict.lookupMaybe(PDFName.of('Matrix'), PDFArray);
                let formCtm = state.ctm;
                if (matArr && matArr.size() >= 6) {
                  const fm = [];
                  for (let m = 0; m < 6; m++) fm.push(matArr.get(m).asNumber());
                  formCtm = mulMat(fm, state.ctm);
                }
                const formRes = xo.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) || resources;
                processStream(xo, formRes, formCtm, depth + 1);
              }
            }
          }
          break;
        }
        default:
          break;
      }
      operands.length = 0;
    }
  };

  const contents = page.node.get(PDFName.of('Contents'));
  const resources = page.node.lookupMaybe(PDFName.of('Resources'), PDFDict);
  if (contents) {
    processStream(contents, resources, [1, 0, 0, 1, 0, 0], 0);
  }

  const chosen = spotPaths.length > 0 ? spotPaths : magentaFallbackPaths;
  // Convert PDF points (bottom-left MediaBox) -> mm (top-left MediaBox)
  return chosen.map((sp) => ({
    closed: sp.closed,
    ptsMm: sp.pts.map(([x, y]) => [
      Math.round(((x - mediaBox.x) / MM_TO_PT) * 1000) / 1000,
      Math.round(((mediaBox.y + pageH - y) / MM_TO_PT) * 1000) / 1000,
    ]),
  }));
}
