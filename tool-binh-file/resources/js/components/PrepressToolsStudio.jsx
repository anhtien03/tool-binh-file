import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { MM_TO_PT, PAPER_SIZES } from '../engine/impositionEngine';
import { encodeBarcode1D, encodeQrMatrix, parseTabularData } from '../engine/vdpEngine';
import { useDragPan } from '../hooks/useDragPan';
import { PkIcon } from './PrintKitUI';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const SAMPLE_CSV = `MaThe,HoTen,ChucVu,LinkQR
PK-001,Nguyen Van An,Truong phong In,https://printkit.vn/id/PK-001
PK-002,Tran Thi Binh,Thiet ke Che ban,https://printkit.vn/id/PK-002
PK-003,Le Hoang Minh,Ky thuat may be,https://printkit.vn/id/PK-003
PK-004,Pham Quoc Cuong,Dieu hanh san xuat,https://printkit.vn/id/PK-004`;

function hexToPdfRgb(hex) {
  const clean = String(hex || '#dc2626').replace('#', '');
  const r = parseInt(clean.slice(0, 2) || 'dc', 16) / 255;
  const g = parseInt(clean.slice(2, 4) || '26', 16) / 255;
  const b = parseInt(clean.slice(4, 6) || '26', 16) / 255;
  return rgb(r, g, b);
}

// Strip Vietnamese accents for StandardFonts.Helvetica safety in pdf-lib
function toAsciiSafe(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

export default function PrepressToolsStudio({
  activeTool = 'numbering',
  initialFile,
  onSharedFileChange,
  onSendToImpose,
  imposeSummary,
  imposeSheetDim,
  settingsCollapsed = false,
  onToggleSettings,
  isFocusMode = false,
  onToggleFocusMode,
}) {
  const [sourceFile, setSourceFile] = useState(null);
  const [pdfBytes, setPdfBytes] = useState(null);
  const [pageInfo, setPageInfo] = useState(null); // { widthMm, heightMm, dataUrl, numPages, pagesMeta }
  const [loading, setLoading] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [error, setError] = useState(null);
  const [zoom, setZoom] = useState(1.0);

  // 1. Numbering state
  const [numPrefix, setNumPrefix] = useState('No. ');
  const [numStart, setNumStart] = useState(1);
  const [numEnd, setNumEnd] = useState(100);
  const [numPad, setNumPad] = useState(5);
  const [numSuffix, setNumSuffix] = useState('');
  const [numStep, setNumStep] = useState(1);
  const [numFontPt, setNumFontPt] = useState(14);
  const [numColor, setNumColor] = useState('#dc2626');
  const [numRotate, setNumRotate] = useState(0);
  const [numXmm, setNumXmm] = useState(15);
  const [numYmm, setNumYmm] = useState(12);
  const [numCutAndStack, setNumCutAndStack] = useState(false);
  const [numSheetKey, setNumSheetKey] = useState('D330x480');
  const [numGutterMm, setNumGutterMm] = useState(2);
  const [numBarcodeSymbology, setNumBarcodeSymbology] = useState('none'); // 'none' | 'code128' | 'ean13' | 'code39'
  const [numBarWidthMm, setNumBarWidthMm] = useState(36);
  const [numBarHeightMm, setNumBarHeightMm] = useState(12);
  const [numBarShowText, setNumBarShowText] = useState(true);

  // 2. VDP state
  const [vdpRawText, setVdpRawText] = useState(SAMPLE_CSV);
  const [vdpPreviewRow, setVdpPreviewRow] = useState(0);
  const [vdpFields, setVdpFields] = useState([
    { id: 'f1', type: 'text', col: 'HoTen', xMm: 18, yMm: 22, fontSizePt: 13, color: '#17212F', qrSizeMm: 18 },
    { id: 'f2', type: 'text', col: 'MaThe', xMm: 18, yMm: 30, fontSizePt: 10, color: '#087F5B', qrSizeMm: 18 },
    { id: 'f3', type: 'qr', col: 'LinkQR', xMm: 62, yMm: 14, fontSizePt: 11, color: '#17212F', qrSizeMm: 18 },
  ]);
  const [activeVdpFieldId, setActiveVdpFieldId] = useState('f1');

  // 3. Preflight report state
  const [preflightReport, setPreflightReport] = useState(null);
  const panViewport = useDragPan();

  // 4. Print Quote state
  const [quoteQty, setQuoteQty] = useState(1000);
  const [paperCostPerSheet, setPaperCostPerSheet] = useState(1800);
  const [printCostPerSide, setPrintCostPerSide] = useState(1200);
  const [laminationType, setLaminationType] = useState('matte'); // 'none' | 'matte' | 'gloss'
  const [lamCostPerSheet, setLamCostPerSheet] = useState(600);
  const [finishingCost, setFinishingCost] = useState(80000);
  const [wastePct, setWastePct] = useState(5);
  const [profitPct, setProfitPct] = useState(30);
  const [duplexSides, setDuplexSides] = useState(2);
  const [copiedQuote, setCopiedQuote] = useState(false);

  const canvasPreviewRef = useRef(null);

  const parsedVdp = useMemo(() => parseTabularData(vdpRawText), [vdpRawText]);

  const handleUpload = async (file, notifyParent = true) => {
    if (!file) return;
    setLoading(true);
    setError(null);
    setSourceFile(file);
    if (notifyParent && onSharedFileChange) onSharedFileChange(file);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setPdfBytes(bytes);
      const isLocal = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost';
      const pdf = await pdfjsLib.getDocument({
        data: bytes.slice(),
        cMapUrl: isLocal ? '/cmaps/' : 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: isLocal
          ? '/standard_fonts/'
          : 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/standard_fonts/',
      }).promise;

      const p1 = await pdf.getPage(1);
      const vp1 = p1.getViewport({ scale: 1.0 });
      const wMm = Math.round((vp1.width / MM_TO_PT) * 10) / 10;
      const hMm = Math.round((vp1.height / MM_TO_PT) * 10) / 10;
      const scale = Math.min(2.0, 900 / Math.max(1, vp1.width, vp1.height));
      const vp = p1.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      await p1.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;

      setPageInfo({
        widthMm: wMm,
        heightMm: hMm,
        dataUrl: c.toDataURL('image/jpeg', 0.9),
        numPages: pdf.numPages,
      });
      setNumXmm(Math.max(4, Math.round(wMm * 0.65)));
      setNumYmm(Math.max(6, Math.round(hMm * 0.2)));
    } catch (e) {
      console.error(e);
      setError('Không thể đọc file PDF này.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialFile && initialFile !== sourceFile) {
      handleUpload(initialFile, false);
    }
  }, [initialFile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Run Preflight automatically when entering Preflight tool with a PDF loaded
  useEffect(() => {
    if (activeTool !== 'preflight' || !pdfBytes) return;
    let cancelled = false;
    const runScan = async () => {
      setLoading(true);
      setProgressText('Đang kiểm tra Preflight từng trang...');
      try {
        const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
        const pages = doc.getPages();
        const isLocal = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost';
        const pdf = await pdfjsLib.getDocument({
          data: pdfBytes.slice(),
          cMapUrl: isLocal ? '/cmaps/' : 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/cmaps/',
          cMapPacked: true,
        }).promise;

        const pageResults = [];
        const baseW = pages[0]?.getMediaBox().width || 0;
        const baseH = pages[0]?.getMediaBox().height || 0;
        let hasRgb = false;
        let hasCmyk = false;
        let missingTrimCount = 0;
        let sizeMismatchCount = 0;
        let lowEdgeSafeCount = 0;

        for (let i = 0; i < pages.length; i++) {
          if (cancelled) return;
          const p = pages[i];
          const mb = p.getMediaBox();
          let hasTrim = false;
          try {
            const tb = p.getTrimBox();
            if (tb && (Math.abs(tb.width - mb.width) > 0.5 || Math.abs(tb.height - mb.height) > 0.5)) {
              hasTrim = true;
            }
          } catch {
            // ignore
          }
          if (!hasTrim) missingTrimCount++;
          if (Math.abs(mb.width - baseW) > 1.5 || Math.abs(mb.height - baseH) > 1.5) {
            sizeMismatchCount++;
          }

          // Inspect raw stream operators for RGB vs CMYK color operators
          let pageColorSpace = 'CMYK / Chuẩn';
          try {
            const rawBytes = p.node?.Contents?.()?.asUint8Array?.();
            if (rawBytes) {
              const txt = new TextDecoder('latin1').decode(rawBytes.slice(0, 60000));
              if (/\s(rg|RG)\b/.test(txt)) {
                hasRgb = true;
                pageColorSpace = 'Có RGB (cần chuyển CMYK)';
              } else if (/\s(k|K)\b/.test(txt)) {
                hasCmyk = true;
              }
            }
          } catch {
            // ignore stream parse
          }

          // Check ink near edge (< 2.5mm) via rasterized sample
          let edgeRisk = false;
          try {
            const jp = await pdf.getPage(i + 1);
            const vp = jp.getViewport({ scale: 0.75 });
            const c = document.createElement('canvas');
            c.width = Math.max(20, Math.round(vp.width));
            c.height = Math.max(20, Math.round(vp.height));
            await jp.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            const wMm = mb.width / MM_TO_PT;
            const px25 = Math.max(2, Math.round((2.5 / Math.max(1, wMm)) * c.width));
            let darkBorderHits = 0;
            for (let x = 0; x < c.width; x += 3) {
              const idxTop = (px25 * c.width + x) * 4;
              if (d[idxTop] < 210 || d[idxTop + 1] < 210 || d[idxTop + 2] < 210) darkBorderHits++;
            }
            if (darkBorderHits > c.width * 0.08 && !hasTrim) {
              edgeRisk = true;
              lowEdgeSafeCount++;
            }
          } catch {
            // ignore
          }

          pageResults.push({
            pageNum: i + 1,
            wMm: Math.round((mb.width / MM_TO_PT) * 10) / 10,
            hMm: Math.round((mb.height / MM_TO_PT) * 10) / 10,
            hasTrim,
            colorSpace: pageColorSpace,
            edgeRisk,
          });
        }

        if (!cancelled) {
          setPreflightReport({
            totalPages: pages.length,
            hasRgb,
            hasCmyk,
            missingTrimCount,
            sizeMismatchCount,
            lowEdgeSafeCount,
            pageResults,
          });
        }
      } catch (e) {
        console.error(e);
      } finally {
        if (!cancelled) {
          setLoading(false);
          setProgressText('');
        }
      }
    };
    runScan();
    return () => {
      cancelled = true;
    };
  }, [activeTool, pdfBytes]);

  const formatNumberStr = (val) => {
    const absStr = String(Math.abs(val)).padStart(Math.max(1, Number(numPad) || 1), '0');
    return `${numPrefix}${val < 0 ? '-' : ''}${absStr}${numSuffix}`;
  };

  // Helper to draw crisp vector 1D barcode onto a pdf-lib page (top-left anchored at xPt, yTopPt)
  const drawBarcodeOnPdfPage = (pg, value, symbology, xPt, yTopPt, widthMm, heightMm, colorHex, showText, font) => {
    const bc = encodeBarcode1D(value, symbology);
    const wPt = Math.max(12, Number(widthMm) || 36) * MM_TO_PT;
    const hPt = Math.max(5, Number(heightMm) || 12) * MM_TO_PT;
    const textHpt = showText ? Math.max(6, Math.min(9.5, hPt * 0.28)) : 0;
    const barsHpt = Math.max(4, hPt - (showText ? textHpt + 2 : 0));
    const qzPt = Math.min(wPt * 0.08, 2.5 * MM_TO_PT);
    const innerW = Math.max(4, wPt - qzPt * 2);
    const modW = innerW / Math.max(1, bc.totalCols);
    const barColor = hexToPdfRgb(colorHex || '#000000');

    // White quiet-zone backing for reliable scanning
    pg.drawRectangle({
      x: xPt,
      y: yTopPt - hPt,
      width: wPt,
      height: hPt,
      color: rgb(1, 1, 1),
    });

    for (const [startCol, runCols] of bc.runs) {
      pg.drawRectangle({
        x: xPt + qzPt + startCol * modW,
        y: yTopPt - barsHpt,
        width: runCols * modW,
        height: barsHpt,
        color: barColor,
      });
    }

    if (showText && font) {
      const label = toAsciiSafe(bc.text);
      const txtW = font.widthOfTextAtSize(label, textHpt);
      pg.drawText(label, {
        x: xPt + Math.max(qzPt, (wPt - txtW) / 2),
        y: yTopPt - hPt + 1.5,
        size: textHpt,
        font,
        color: barColor,
      });
    }
  };

  // Export Numbering PDF (Sequential pages OR Cut & Stack imposed sheets)
  const handleExportNumbering = async (sendToImpose = false) => {
    if (!pdfBytes || !pageInfo) return;
    setLoading(true);
    setProgressText('Đang tạo các trang đánh số nhảy...');
    try {
      const srcDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      const outDoc = await PDFDocument.create();
      const font = await outDoc.embedFont(StandardFonts.HelveticaBold);
      const step = Math.max(1, parseInt(numStep, 10) || 1);
      const start = parseInt(numStart, 10) || 1;
      const end = Math.max(start, parseInt(numEnd, 10) || start);
      const numbers = [];
      for (let n = start; n <= end && numbers.length < 3000; n += step) {
        numbers.push(n);
      }

      const [srcPage0] = srcDoc.getPages();
      const { width: sw, height: sh } = srcPage0.getSize();
      const fontSize = Math.max(6, Number(numFontPt) || 12);
      const textColor = hexToPdfRgb(numColor);

      if (numCutAndStack && !sendToImpose) {
        // Cut & Stack imposition onto selected press sheet
        const sheetInfo = PAPER_SIZES[numSheetKey] || PAPER_SIZES.D330x480;
        const sheetWpt = sheetInfo.width * MM_TO_PT;
        const sheetHpt = sheetInfo.height * MM_TO_PT;
        const marginPt = 8 * MM_TO_PT;
        const gapPt = Math.max(0, Number(numGutterMm) || 0) * MM_TO_PT;
        const cols = Math.max(1, Math.floor((sheetWpt - 2 * marginPt + gapPt) / (sw + gapPt)));
        const rows = Math.max(1, Math.floor((sheetHpt - 2 * marginPt + gapPt) / (sh + gapPt)));
        const perSheet = cols * rows;
        const numSheets = Math.ceil(numbers.length / perSheet);
        const embedded0 = await outDoc.embedPage(srcPage0);

        const blockW = cols * sw + (cols - 1) * gapPt;
        const blockH = rows * sh + (rows - 1) * gapPt;
        const ox = (sheetWpt - blockW) / 2;
        const oyTop = (sheetHpt + blockH) / 2;

        for (let s = 0; s < numSheets; s++) {
          const sheetPage = outDoc.addPage([sheetWpt, sheetHpt]);
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const slotIdx = r * cols + c;
              // Cut & Stack index: slot k on sheet s gets index (slotIdx * numSheets + s)
              const itemIdx = slotIdx * numSheets + s;
              if (itemIdx >= numbers.length) continue;

              const px = ox + c * (sw + gapPt);
              const py = oyTop - (r + 1) * sh - r * gapPt;
              sheetPage.drawPage(embedded0, { x: px, y: py, width: sw, height: sh });

              const txt = toAsciiSafe(formatNumberStr(numbers[itemIdx]));
              if (numBarcodeSymbology !== 'none') {
                drawBarcodeOnPdfPage(
                  sheetPage,
                  txt,
                  numBarcodeSymbology,
                  px + numXmm * MM_TO_PT,
                  py + sh - numYmm * MM_TO_PT,
                  numBarWidthMm,
                  numBarHeightMm,
                  numColor,
                  numBarShowText,
                  font
                );
              } else {
                sheetPage.drawText(txt, {
                  x: px + numXmm * MM_TO_PT,
                  y: py + sh - numYmm * MM_TO_PT,
                  size: fontSize,
                  font,
                  color: textColor,
                  rotate: degrees(Number(numRotate) || 0),
                });
              }
            }
          }
        }
      } else {
        // One PDF page per number
        const embedded0 = await outDoc.embedPage(srcPage0);
        for (let i = 0; i < numbers.length; i++) {
          const pg = outDoc.addPage([sw, sh]);
          pg.drawPage(embedded0, { x: 0, y: 0, width: sw, height: sh });
          const txt = toAsciiSafe(formatNumberStr(numbers[i]));
          if (numBarcodeSymbology !== 'none') {
            drawBarcodeOnPdfPage(
              pg,
              txt,
              numBarcodeSymbology,
              numXmm * MM_TO_PT,
              sh - numYmm * MM_TO_PT,
              numBarWidthMm,
              numBarHeightMm,
              numColor,
              numBarShowText,
              font
            );
          } else {
            pg.drawText(txt, {
              x: numXmm * MM_TO_PT,
              y: sh - numYmm * MM_TO_PT,
              size: fontSize,
              font,
              color: textColor,
              rotate: degrees(Number(numRotate) || 0),
            });
          }
        }
      }

      const outBytes = await outDoc.save();
      const base = (sourceFile?.name || 'Numbering').replace(/\.pdf$/i, '');
      const outName = `${numCutAndStack ? 'CutStack_' : 'SoNhay_'}${base}.pdf`;

      if (sendToImpose && onSendToImpose) {
        onSendToImpose(new File([outBytes], outName, { type: 'application/pdf' }));
      } else {
        const blob = new Blob([outBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = outName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      console.error(e);
      setError('Lỗi khi xuất file chạy số nhảy.');
    } finally {
      setLoading(false);
      setProgressText('');
    }
  };

  // Export VDP PDF (each CSV row = 1 customized PDF page with text + crisp vector QR)
  const handleExportVdp = async (sendToImpose = false) => {
    if (!pdfBytes || parsedVdp.rows.length === 0) return;
    setLoading(true);
    setProgressText(`Đang trộn ${parsedVdp.rows.length} dòng dữ liệu...`);
    try {
      const srcDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      const outDoc = await PDFDocument.create();
      const font = await outDoc.embedFont(StandardFonts.HelveticaBold);
      const [srcPage0] = srcDoc.getPages();
      const { width: sw, height: sh } = srcPage0.getSize();
      const embedded0 = await outDoc.embedPage(srcPage0);

      for (const row of parsedVdp.rows.slice(0, 2000)) {
        const pg = outDoc.addPage([sw, sh]);
        pg.drawPage(embedded0, { x: 0, y: 0, width: sw, height: sh });

        for (const f of vdpFields) {
          const val = String(row[f.col] ?? '');
          if (!val) continue;
          const xPt = f.xMm * MM_TO_PT;
          const yTopPt = sh - f.yMm * MM_TO_PT;

          if (f.type === 'qr') {
            const mat = encodeQrMatrix(val);
            const n = mat.length;
            const qrPt = Math.max(6, Number(f.qrSizeMm) || 16) * MM_TO_PT;
            const cell = qrPt / n;
            // White quiet-zone backing
            pg.drawRectangle({
              x: xPt - cell,
              y: yTopPt - qrPt - cell,
              width: qrPt + cell * 2,
              height: qrPt + cell * 2,
              color: rgb(1, 1, 1),
            });
            const qrColor = hexToPdfRgb(f.color || '#17212F');
            for (let r = 0; r < n; r++) {
              for (let c = 0; c < n; c++) {
                if (mat[r][c] === 1) {
                  pg.drawRectangle({
                    x: xPt + c * cell,
                    y: yTopPt - (r + 1) * cell,
                    width: cell + 0.05,
                    height: cell + 0.05,
                    color: qrColor,
                  });
                }
              }
            }
          } else if (f.type === 'barcode') {
            drawBarcodeOnPdfPage(
              pg,
              val,
              f.barcodeSymbology || 'code128',
              xPt,
              yTopPt,
              f.barWidthMm || 38,
              f.barHeightMm || 12,
              f.color || '#000000',
              f.showText !== false,
              font
            );
          } else {
            pg.drawText(toAsciiSafe(val), {
              x: xPt,
              y: yTopPt,
              size: Math.max(5, Number(f.fontSizePt) || 11),
              font,
              color: hexToPdfRgb(f.color || '#17212F'),
            });
          }
        }
      }

      const outBytes = await outDoc.save();
      const base = (sourceFile?.name || 'VDP').replace(/\.pdf$/i, '');
      const outName = `VDP_${base}.pdf`;
      if (sendToImpose && onSendToImpose) {
        onSendToImpose(new File([outBytes], outName, { type: 'application/pdf' }));
      } else {
        const blob = new Blob([outBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = outName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      console.error(e);
      setError('Lỗi khi xuất file trộn dữ liệu VDP.');
    } finally {
      setLoading(false);
      setProgressText('');
    }
  };

  // Quote math
  const itemsPerSheet = Math.max(1, imposeSummary?.itemsPerSheet || 20);
  const netSheets = Math.ceil(Math.max(1, quoteQty) / itemsPerSheet);
  const totalSheetsWithWaste = Math.ceil(netSheets * (1 + Math.max(0, wastePct) / 100));
  const totalPaperCost = totalSheetsWithWaste * paperCostPerSheet;
  const totalPrintCost = totalSheetsWithWaste * duplexSides * printCostPerSide;
  const totalLamCost = laminationType === 'none' ? 0 : totalSheetsWithWaste * lamCostPerSheet;
  const baseCost = totalPaperCost + totalPrintCost + totalLamCost + finishingCost;
  const sellPrice = Math.round(baseCost * (1 + Math.max(0, profitPct) / 100));
  const unitSellPrice = Math.round(sellPrice / Math.max(1, quoteQty));

  const formatVnd = (n) => `${Math.round(n).toLocaleString('vi-VN')} đ`;

  const handleCanvasClickPlace = (e) => {
    if (!pageInfo) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickXmm = Math.round((((e.clientX - rect.left) / Math.max(1, rect.width)) * pageInfo.widthMm) * 10) / 10;
    const clickYmm = Math.round((((e.clientY - rect.top) / Math.max(1, rect.height)) * pageInfo.heightMm) * 10) / 10;
    if (activeTool === 'numbering') {
      setNumXmm(clickXmm);
      setNumYmm(clickYmm);
    } else if (activeTool === 'vdp') {
      setVdpFields((prev) =>
        prev.map((f) => (f.id === activeVdpFieldId ? { ...f, xMm: clickXmm, yMm: clickYmm } : f))
      );
    }
  };

  return (
    <div className="flex flex-1 min-w-0 h-full overflow-hidden">
      {/* LEFT: WORKSPACE VIEW */}
      <main className="flex-1 min-w-0 bg-[#52565E] flex flex-col overflow-hidden">
        <div className="min-h-[40px] px-3 py-1 bg-[#F8FAFC] border-b border-[#E2E8F0] flex flex-wrap items-center justify-between gap-2 shrink-0 select-none">
          <div className="flex items-center gap-2 text-xs">
            <span className="px-2 py-0.5 rounded bg-[#DDF5EC] text-[#064E3B] font-bold">
              {activeTool === 'numbering'
                ? 'CHẠY SỐ NHẢY (NUMBERING)'
                : activeTool === 'vdp'
                ? 'TRỘN DỮ LIỆU VDP (EXCEL / QR)'
                : activeTool === 'preflight'
                ? 'PREFLIGHT KIỂM TRA LỖI FILE IN'
                : 'BÁO GIÁ & GIÁ THÀNH IN'}
            </span>
            {pageInfo && (
              <span className="px-2 py-0.5 rounded bg-white border border-[#E2E8F0] text-[#17212F] font-mono font-semibold">
                {pageInfo.widthMm} × {pageInfo.heightMm} mm · {pageInfo.numPages} trang
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            {(activeTool === 'numbering' || activeTool === 'vdp') && pageInfo && (
              <div className="flex items-center gap-1.5 text-xs font-mono">
                <span className="text-[11px] font-sans text-[#64748B] hidden md:inline">
                  Bấm lên bản vẽ để đặt vị trí
                </span>
                <button
                  onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.2) * 100) / 100))}
                  className="w-6 h-6 rounded bg-white border border-[#E2E8F0] hover:bg-[#F3F5F7] cursor-pointer"
                >
                  −
                </button>
                <span className="min-w-[42px] text-center font-bold text-[#087F5B]">{Math.round(zoom * 100)}%</span>
                <button
                  onClick={() => setZoom((z) => Math.min(4, Math.round((z + 0.2) * 100) / 100))}
                  className="w-6 h-6 rounded bg-white border border-[#E2E8F0] hover:bg-[#F3F5F7] cursor-pointer"
                >
                  +
                </button>
              </div>
            )}
            {isFocusMode && typeof onToggleFocusMode === 'function' && (
              <button
                type="button"
                onClick={onToggleFocusMode}
                title="Thoát Focus Mode và khôi phục bảng điều khiển (Esc)"
                className="h-7 px-2.5 rounded-md bg-[#0F172A] hover:bg-[#1E293B] text-white text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer shadow-xs transition-colors"
              >
                <PkIcon name="close" className="w-3 h-3" />
                <span>Thoát Focus (Esc)</span>
              </button>
            )}
            {!isFocusMode && settingsCollapsed && typeof onToggleSettings === 'function' && (
              <button
                type="button"
                onClick={onToggleSettings}
                title="Mở lại bảng thông số"
                className="h-7 px-2.5 rounded-md bg-white hover:bg-[#DDF5EC] border border-[#087F5B]/40 text-[#064E3B] text-[11px] font-semibold flex items-center gap-1 cursor-pointer shadow-2xs transition-colors"
              >
                <PkIcon name="chevronsLeft" className="w-3.5 h-3.5 text-[#087F5B]" />
                <span>Thông số</span>
              </button>
            )}
          </div>
        </div>

        {error && <div className="px-3 py-1.5 bg-rose-50 border-b border-rose-200 text-[#DC4545] text-xs">{error}</div>}

        <div
          ref={panViewport.ref}
          onMouseDown={panViewport.onMouseDown}
          className={`relative flex-1 overflow-auto p-6 flex bg-[#52565E] select-none ${
            panViewport.isPanning ? 'cursor-grabbing' : 'cursor-grab'
          }`}
        >
          {loading && (
            <div className="fixed inset-0 z-50 bg-slate-900/45 backdrop-blur-2xs flex items-center justify-center p-4">
              <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl px-6 py-5 flex items-center gap-3">
                <div className="w-6 h-6 rounded-full border-3 border-[#087F5B] border-t-transparent animate-spin" />
                <span className="text-xs font-bold text-[#17212F]">{progressText || 'Đang xử lý...'}</span>
              </div>
            </div>
          )}

          {activeTool === 'quote' ? (
            /* PRINT QUOTE DASHBOARD CARD ON PASTEBOARD */
            <div className="m-auto w-full max-w-2xl bg-white rounded-xl border border-[#E2E8F0] shadow-2xl p-6 flex flex-col gap-5 shrink-0">
              <div className="flex items-center justify-between border-b border-[#E2E8F0] pb-3">
                <div>
                  <h2 className="text-base font-bold text-[#17212F]">Bảng Dự Toán Giá Thành &amp; Báo Giá In</h2>
                  <p className="text-xs text-[#64748B]">
                    Tự động đồng bộ từ kết quả bình bài ({itemsPerSheet} con/tờ · Khổ{' '}
                    {imposeSheetDim ? `${imposeSheetDim.width}×${imposeSheetDim.height}mm` : '330×480mm'})
                  </p>
                </div>
                <span className="px-2.5 py-1 rounded-md bg-[#DDF5EC] text-[#064E3B] text-xs font-mono font-bold">
                  {totalSheetsWithWaste} tờ (gồm {wastePct}% bù hao)
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 rounded-lg bg-[#F3F5F7] border border-[#E2E8F0]">
                  <div className="text-[11px] text-[#64748B]">Giấy thực tế</div>
                  <div className="text-sm font-bold text-[#17212F] font-mono mt-0.5">{netSheets} tờ</div>
                </div>
                <div className="p-3 rounded-lg bg-[#F3F5F7] border border-[#E2E8F0]">
                  <div className="text-[11px] text-[#64748B]">Tổng giấy + bù hao</div>
                  <div className="text-sm font-bold text-[#087F5B] font-mono mt-0.5">{totalSheetsWithWaste} tờ</div>
                </div>
                <div className="p-3 rounded-lg bg-[#F3F5F7] border border-[#E2E8F0]">
                  <div className="text-[11px] text-[#64748B]">Tổng giá vốn</div>
                  <div className="text-sm font-bold text-[#17212F] font-mono mt-0.5">{formatVnd(baseCost)}</div>
                </div>
                <div className="p-3 rounded-lg bg-[#DDF5EC] border border-[#087F5B]/30">
                  <div className="text-[11px] text-[#064E3B] font-semibold">Đơn giá bán / sp</div>
                  <div className="text-sm font-extrabold text-[#064E3B] font-mono mt-0.5">{formatVnd(unitSellPrice)}</div>
                </div>
              </div>

              <div className="border border-[#E2E8F0] rounded-lg overflow-hidden text-xs">
                <div className="grid grid-cols-3 bg-[#F8FAFC] px-3.5 py-2 font-bold text-[#475569] border-b border-[#E2E8F0]">
                  <span>Hạng mục chi phí</span>
                  <span className="text-right">Đơn giá / SL</span>
                  <span className="text-right">Thành tiền</span>
                </div>
                <div className="divide-y divide-[#E2E8F0]">
                  <div className="grid grid-cols-3 px-3.5 py-2">
                    <span>Tiền giấy in</span>
                    <span className="text-right font-mono text-[#64748B]">{totalSheetsWithWaste} × {paperCostPerSheet.toLocaleString()}</span>
                    <span className="text-right font-mono font-semibold">{formatVnd(totalPaperCost)}</span>
                  </div>
                  <div className="grid grid-cols-3 px-3.5 py-2">
                    <span>Công in ({duplexSides} mặt)</span>
                    <span className="text-right font-mono text-[#64748B]">{totalSheetsWithWaste * duplexSides} lượt × {printCostPerSide.toLocaleString()}</span>
                    <span className="text-right font-mono font-semibold">{formatVnd(totalPrintCost)}</span>
                  </div>
                  <div className="grid grid-cols-3 px-3.5 py-2">
                    <span>Cán màng ({laminationType === 'none' ? 'Không' : laminationType === 'matte' ? 'Mờ' : 'Bóng'})</span>
                    <span className="text-right font-mono text-[#64748B]">{laminationType === 'none' ? '0' : `${totalSheetsWithWaste} × ${lamCostPerSheet.toLocaleString()}`}</span>
                    <span className="text-right font-mono font-semibold">{formatVnd(totalLamCost)}</span>
                  </div>
                  <div className="grid grid-cols-3 px-3.5 py-2">
                    <span>Gia công (Xén / Bế / Đóng cuốn)</span>
                    <span className="text-right font-mono text-[#64748B]">Trọn gói</span>
                    <span className="text-right font-mono font-semibold">{formatVnd(finishingCost)}</span>
                  </div>
                  <div className="grid grid-cols-3 px-3.5 py-2.5 bg-[#F8FAFC] font-bold text-sm">
                    <span className="text-[#064E3B]">TỔNG GIÁ BÁN ({quoteQty.toLocaleString()} sp)</span>
                    <span className="text-right font-mono text-xs text-[#64748B] self-center">Lãi {profitPct}%</span>
                    <span className="text-right font-mono text-[#087F5B]">{formatVnd(sellPrice)}</span>
                  </div>
                </div>
              </div>
            </div>
          ) : !pageInfo ? (
            <label className="m-auto cursor-pointer bg-white rounded-xl border-2 border-dashed border-[#CBD5E1] hover:border-[#087F5B] p-9 max-w-md w-full flex flex-col items-center gap-2.5 text-center shadow-2xl">
              <span className="text-sm font-bold text-[#17212F]">Mở file PDF để chạy {activeTool === 'preflight' ? 'Preflight' : activeTool === 'vdp' ? 'VDP' : 'Số nhảy'}</span>
              <span className="text-xs text-[#64748B]">Chọn file PDF mẫu từ máy tính hoặc quay lại bàn chính để mở file dùng chung.</span>
              <span className="mt-1 px-4 py-2 rounded-lg bg-[#087F5B] text-white text-xs font-semibold">Mở file PDF</span>
              <input type="file" accept=".pdf,application/pdf" className="hidden" onChange={(e) => handleUpload(e.target.files?.[0])} />
            </label>
          ) : activeTool === 'preflight' ? (
            /* PREFLIGHT REPORT CARDS */
            <div className="m-auto w-full max-w-3xl bg-white rounded-xl border border-[#E2E8F0] shadow-2xl p-5 flex flex-col gap-4 shrink-0">
              <div className="flex items-center justify-between border-b border-[#E2E8F0] pb-3">
                <div>
                  <h2 className="text-sm font-bold text-[#17212F]">Báo cáo Kiểm tra File In (Preflight)</h2>
                  <p className="text-xs text-[#64748B]">{sourceFile?.name} · {preflightReport?.totalPages || pageInfo.numPages} trang</p>
                </div>
              </div>
              {preflightReport && (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
                    <div className={`p-3 rounded-lg border ${preflightReport.sizeMismatchCount > 0 ? 'bg-rose-50 border-rose-200 text-[#DC4545]' : 'bg-[#DDF5EC] border-[#087F5B]/30 text-[#064E3B]'}`}>
                      <div className="font-bold">{preflightReport.sizeMismatchCount === 0 ? 'Đạt' : 'Cảnh báo'}</div>
                      <div className="text-[11px] mt-0.5">Đồng nhất khổ ({preflightReport.sizeMismatchCount} lệch)</div>
                    </div>
                    <div className={`p-3 rounded-lg border ${preflightReport.missingTrimCount > 0 ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-[#DDF5EC] border-[#087F5B]/30 text-[#064E3B]'}`}>
                      <div className="font-bold">{preflightReport.missingTrimCount === 0 ? 'Đạt' : 'Thiếu TrimBox'}</div>
                      <div className="text-[11px] mt-0.5">{preflightReport.missingTrimCount}/{preflightReport.totalPages} trang chưa có Bleed</div>
                    </div>
                    <div className={`p-3 rounded-lg border ${preflightReport.hasRgb ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-[#DDF5EC] border-[#087F5B]/30 text-[#064E3B]'}`}>
                      <div className="font-bold">{preflightReport.hasRgb ? 'Có hệ màu RGB' : 'Chuẩn CMYK'}</div>
                      <div className="text-[11px] mt-0.5">{preflightReport.hasRgb ? 'Nên kiểm tra lại màu in' : 'Không phát hiện RGB vector'}</div>
                    </div>
                    <div className={`p-3 rounded-lg border ${preflightReport.lowEdgeSafeCount > 0 ? 'bg-rose-50 border-rose-200 text-[#DC4545]' : 'bg-[#DDF5EC] border-[#087F5B]/30 text-[#064E3B]'}`}>
                      <div className="font-bold">{preflightReport.lowEdgeSafeCount === 0 ? 'An toàn' : 'Sát mép cắt'}</div>
                      <div className="text-[11px] mt-0.5">{preflightReport.lowEdgeSafeCount} trang có chi tiết sát lề</div>
                    </div>
                  </div>
                  <div className="max-h-[380px] overflow-y-auto border border-[#E2E8F0] rounded-lg text-xs">
                    <table className="w-full text-left">
                      <thead className="bg-[#F8FAFC] text-[#475569] border-b border-[#E2E8F0] sticky top-0">
                        <tr>
                          <th className="px-3 py-2">Trang</th>
                          <th className="px-3 py-2">Kích thước</th>
                          <th className="px-3 py-2">TrimBox / Bleed</th>
                          <th className="px-3 py-2">Hệ màu</th>
                          <th className="px-3 py-2">Vùng an toàn</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#E2E8F0]">
                        {preflightReport.pageResults.map((pr) => (
                          <tr key={pr.pageNum} className="hover:bg-[#F3F5F7]">
                            <td className="px-3 py-1.5 font-mono font-bold">#{pr.pageNum}</td>
                            <td className="px-3 py-1.5 font-mono">{pr.wMm} × {pr.hMm} mm</td>
                            <td className="px-3 py-1.5">{pr.hasTrim ? <span className="text-[#087F5B] font-semibold">Có TrimBox</span> : <span className="text-amber-600">Chưa có</span>}</td>
                            <td className="px-3 py-1.5">{pr.colorSpace}</td>
                            <td className="px-3 py-1.5">{pr.edgeRisk ? <span className="text-[#DC4545] font-semibold">Sát mép (&lt;2.5mm)</span> : <span className="text-[#087F5B]">Ổn định</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          ) : (
            /* INTERACTIVE PAGE PREVIEW FOR NUMBERING & VDP */
            (() => {
              const scale = (440 / Math.max(pageInfo.widthMm, pageInfo.heightMm)) * zoom;
              const wPx = Math.round(pageInfo.widthMm * scale);
              const hPx = Math.round(pageInfo.heightMm * scale);
              const previewRow = parsedVdp.rows[Math.min(vdpPreviewRow, Math.max(0, parsedVdp.rows.length - 1))] || {};

              return (
                <div
                  ref={canvasPreviewRef}
                  onClick={handleCanvasClickPlace}
                  className="m-auto relative bg-white cursor-crosshair select-none shrink-0"
                  style={{ width: wPx, height: hPx, boxShadow: '0 14px 36px rgba(0,0,0,0.4)' }}
                >
                  <img src={pageInfo.dataUrl} alt="Mẫu PDF" className="w-full h-full block pointer-events-none" />

                  {activeTool === 'numbering' &&
                    (numBarcodeSymbology !== 'none' ? (
                      (() => {
                        const bc = encodeBarcode1D(formatNumberStr(numStart), numBarcodeSymbology);
                        const bW = Math.max(40, (Number(numBarWidthMm) || 36) * scale);
                        const bH = Math.max(18, (Number(numBarHeightMm) || 12) * scale);
                        const txtH = numBarShowText ? Math.max(9, Math.min(13, bH * 0.28)) : 0;
                        const barsH = Math.max(8, bH - txtH - 4);
                        return (
                          <div
                            className="absolute bg-white pointer-events-none border border-dashed border-[#087F5B] flex flex-col items-center justify-between px-1 py-0.5"
                            style={{ left: `${numXmm * scale}px`, top: `${numYmm * scale}px`, width: bW, height: bH }}
                          >
                            <svg width="100%" height={barsH} viewBox={`0 0 ${bc.totalCols} 10`} preserveAspectRatio="none">
                              {bc.runs.map(([sx, sw], idx) => (
                                <rect key={idx} x={sx} y={0} width={sw} height={10} fill={numColor || '#000000'} />
                              ))}
                            </svg>
                            {numBarShowText && (
                              <span className="font-mono font-bold leading-none truncate max-w-full" style={{ fontSize: `${txtH}px`, color: numColor || '#000000' }}>
                                {bc.text}
                              </span>
                            )}
                          </div>
                        );
                      })()
                    ) : (
                      <div
                        className="absolute font-mono font-bold whitespace-nowrap pointer-events-none border border-dashed border-[#087F5B] bg-white/75 px-1"
                        style={{
                          left: `${numXmm * scale}px`,
                          top: `${numYmm * scale}px`,
                          fontSize: `${Math.max(8, (numFontPt / MM_TO_PT) * scale)}px`,
                          color: numColor,
                          transform: `translateY(-85%) rotate(${-numRotate}deg)`,
                          transformOrigin: 'left bottom',
                        }}
                      >
                        {formatNumberStr(numStart)}
                      </div>
                    ))}

                  {activeTool === 'vdp' &&
                    vdpFields.map((f) => {
                      const val = String(previewRow[f.col] ?? `[${f.col}]`);
                      const isSel = f.id === activeVdpFieldId;
                      if (f.type === 'barcode') {
                        const bc = encodeBarcode1D(val, f.barcodeSymbology || 'code128');
                        const bW = Math.max(40, (Number(f.barWidthMm) || 38) * scale);
                        const bH = Math.max(18, (Number(f.barHeightMm) || 12) * scale);
                        const showTxt = f.showText !== false;
                        const txtH = showTxt ? Math.max(9, Math.min(13, bH * 0.28)) : 0;
                        const barsH = Math.max(8, bH - txtH - 4);
                        return (
                          <div
                            key={f.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveVdpFieldId(f.id);
                            }}
                            className={`absolute bg-white flex flex-col items-center justify-between px-1 py-0.5 cursor-pointer ${
                              isSel ? 'ring-2 ring-[#087F5B]' : 'ring-1 ring-slate-300'
                            }`}
                            style={{ left: `${f.xMm * scale}px`, top: `${f.yMm * scale}px`, width: bW, height: bH }}
                          >
                            <svg width="100%" height={barsH} viewBox={`0 0 ${bc.totalCols} 10`} preserveAspectRatio="none">
                              {bc.runs.map(([sx, sw], idx) => (
                                <rect key={idx} x={sx} y={0} width={sw} height={10} fill={f.color || '#000000'} />
                              ))}
                            </svg>
                            {showTxt && (
                              <span className="font-mono font-bold leading-none truncate max-w-full" style={{ fontSize: `${txtH}px`, color: f.color || '#000000' }}>
                                {bc.text}
                              </span>
                            )}
                          </div>
                        );
                      }
                      if (f.type === 'qr') {
                        const mat = encodeQrMatrix(val);
                        const qrPx = Math.max(18, f.qrSizeMm * scale);
                        const cell = qrPx / mat.length;
                        return (
                          <div
                            key={f.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveVdpFieldId(f.id);
                            }}
                            className={`absolute bg-white p-0.5 cursor-pointer ${isSel ? 'ring-2 ring-[#087F5B]' : 'ring-1 ring-slate-300'}`}
                            style={{ left: `${f.xMm * scale}px`, top: `${f.yMm * scale}px`, width: qrPx, height: qrPx }}
                          >
                            <svg width={qrPx - 4} height={qrPx - 4} viewBox={`0 0 ${mat.length} ${mat.length}`}>
                              {mat.map((row, r) =>
                                row.map((v, c) =>
                                  v === 1 ? <rect key={`${r}-${c}`} x={c} y={r} width={1} height={1} fill={f.color || '#17212F'} /> : null
                                )
                              )}
                            </svg>
                          </div>
                        );
                      }
                      return (
                        <div
                          key={f.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveVdpFieldId(f.id);
                          }}
                          className={`absolute font-sans font-bold whitespace-nowrap px-1 cursor-pointer ${
                            isSel ? 'ring-2 ring-[#087F5B] bg-[#DDF5EC]/60' : 'border border-dashed border-slate-400 bg-white/70'
                          }`}
                          style={{
                            left: `${f.xMm * scale}px`,
                            top: `${f.yMm * scale}px`,
                            fontSize: `${Math.max(8, (f.fontSizePt / MM_TO_PT) * scale)}px`,
                            color: f.color || '#17212F',
                            transform: 'translateY(-85%)',
                          }}
                        >
                          {val}
                        </div>
                      );
                    })}
                </div>
              );
            })()
          )}
        </div>
      </main>

      {/* RIGHT: SETTINGS PANEL (CSS-hidden on collapse/Focus) */}
      <aside
        className={`${
          settingsCollapsed || isFocusMode
            ? 'hidden'
            : 'w-[288px] xl:w-[320px] flex'
        } pk-panel-transition bg-white border-l border-[#E2E8F0] p-3.5 flex-col gap-3 overflow-y-auto h-full shrink-0`}
      >
        <div className="flex items-start justify-between gap-2 border-b border-[#E2E8F0] pb-2">
          <div className="min-w-0">
            <div className="text-[11.5px] font-extrabold text-[#17212F] uppercase truncate">
              {activeTool === 'numbering'
                ? 'Chạy số nhảy tự động'
                : activeTool === 'vdp'
                ? 'Trộn dữ liệu biến đổi (VDP)'
                : activeTool === 'preflight'
                ? 'Preflight chuẩn in'
                : 'Báo giá & Giá thành in'}
            </div>
            <div className="text-[11px] text-[#64748B] mt-0.5">
              {activeTool === 'numbering'
                ? 'Đánh số vé, phiếu bảo hành, hóa đơn & xếp Cut & Stack'
                : activeTool === 'vdp'
                ? 'Đổ danh sách Excel/CSV & mã QR Code vector lên mẫu PDF'
                : activeTool === 'preflight'
                ? 'Quét lỗi kích thước, TrimBox, RGB và vùng an toàn mép cắt'
                : 'Tính nhanh giá vốn & đơn giá bán dựa trên số tờ bình'}
            </div>
          </div>
          {typeof onToggleSettings === 'function' && (
            <button
              type="button"
              onClick={onToggleSettings}
              title="Thu gọn bảng thông số (»)"
              className="w-7 h-7 rounded-md bg-[#F8FAFC] hover:bg-[#DDF5EC] border border-[#E2E8F0] hover:border-[#087F5B]/40 text-[#64748B] hover:text-[#087F5B] flex items-center justify-center cursor-pointer transition-colors shrink-0"
            >
              <PkIcon name="chevronsRight" className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {activeTool === 'numbering' && (
          <>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <label className="text-[10px] text-[#64748B]">Tiền tố</label>
                <input type="text" value={numPrefix} onChange={(e) => setNumPrefix(e.target.value)} className="w-full border border-[#E2E8F0] rounded-md px-2 py-1.5 font-mono text-xs" />
              </div>
              <div>
                <label className="text-[10px] text-[#64748B]">Hậu tố</label>
                <input type="text" value={numSuffix} onChange={(e) => setNumSuffix(e.target.value)} className="w-full border border-[#E2E8F0] rounded-md px-2 py-1.5 font-mono text-xs" />
              </div>
              <div>
                <label className="text-[10px] text-[#64748B]">Từ số</label>
                <input type="number" value={numStart} onChange={(e) => setNumStart(parseInt(e.target.value, 10) || 1)} className="w-full border border-[#E2E8F0] rounded-md px-2 py-1.5 font-mono text-xs" />
              </div>
              <div>
                <label className="text-[10px] text-[#64748B]">Đến số</label>
                <input type="number" value={numEnd} onChange={(e) => setNumEnd(parseInt(e.target.value, 10) || 1)} className="w-full border border-[#E2E8F0] rounded-md px-2 py-1.5 font-mono text-xs" />
              </div>
              <div>
                <label className="text-[10px] text-[#64748B]">Số chữ số (đệm 0)</label>
                <input type="number" min="1" max="10" value={numPad} onChange={(e) => setNumPad(parseInt(e.target.value, 10) || 1)} className="w-full border border-[#E2E8F0] rounded-md px-2 py-1.5 font-mono text-xs" />
              </div>
              <div>
                <label className="text-[10px] text-[#64748B]">Bước nhảy</label>
                <input type="number" min="1" value={numStep} onChange={(e) => setNumStep(parseInt(e.target.value, 10) || 1)} className="w-full border border-[#E2E8F0] rounded-md px-2 py-1.5 font-mono text-xs" />
              </div>
              <div>
                <label className="text-[10px] text-[#64748B]">Tọa độ X (mm)</label>
                <input type="number" step="0.5" value={numXmm} onChange={(e) => setNumXmm(parseFloat(e.target.value) || 0)} className="w-full border border-[#E2E8F0] rounded-md px-2 py-1.5 font-mono text-xs" />
              </div>
              <div>
                <label className="text-[10px] text-[#64748B]">Tọa độ Y (mm)</label>
                <input type="number" step="0.5" value={numYmm} onChange={(e) => setNumYmm(parseFloat(e.target.value) || 0)} className="w-full border border-[#E2E8F0] rounded-md px-2 py-1.5 font-mono text-xs" />
              </div>
              <div>
                <label className="text-[10px] text-[#64748B]">Cỡ chữ (pt)</label>
                <input type="number" min="6" max="72" value={numFontPt} onChange={(e) => setNumFontPt(parseFloat(e.target.value) || 12)} className="w-full border border-[#E2E8F0] rounded-md px-2 py-1.5 font-mono text-xs" />
              </div>
              <div>
                <label className="text-[10px] text-[#64748B]">Màu &amp; Xoay</label>
                <div className="flex gap-1">
                  <input type="color" value={numColor} onChange={(e) => setNumColor(e.target.value)} className="w-9 h-8 border border-[#E2E8F0] rounded-md cursor-pointer" />
                  <select value={numRotate} onChange={(e) => setNumRotate(Number(e.target.value))} className="flex-1 border border-[#E2E8F0] rounded-md px-1 text-xs">
                    <option value={0}>0°</option>
                    <option value={90}>90°</option>
                    <option value={180}>180°</option>
                    <option value={270}>270°</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1.5 p-2.5 rounded-lg bg-[#F8FAFC] border border-[#E2E8F0] text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-[#17212F]">Định dạng Barcode 1D</span>
                <select
                  value={numBarcodeSymbology}
                  onChange={(e) => {
                    const v = e.target.value;
                    setNumBarcodeSymbology(v);
                    if (v !== 'none' && numColor === '#dc2626') setNumColor('#000000');
                  }}
                  className="border border-[#E2E8F0] bg-white rounded-md px-2 py-1 text-xs font-semibold"
                >
                  <option value="none">Chỉ chữ số</option>
                  <option value="code128">Code 128 (Phổ biến)</option>
                  <option value="ean13">EAN-13 (13 số)</option>
                  <option value="code39">Code 39</option>
                </select>
              </div>
              {numBarcodeSymbology !== 'none' && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] text-[#64748B]">Rộng mã (mm)</label>
                      <input type="number" min="12" value={numBarWidthMm} onChange={(e) => setNumBarWidthMm(parseFloat(e.target.value) || 36)} className="w-full bg-white border border-[#E2E8F0] rounded-md px-2 py-1 font-mono text-xs" />
                    </div>
                    <div>
                      <label className="text-[10px] text-[#64748B]">Cao mã (mm)</label>
                      <input type="number" min="5" value={numBarHeightMm} onChange={(e) => setNumBarHeightMm(parseFloat(e.target.value) || 12)} className="w-full bg-white border border-[#E2E8F0] rounded-md px-2 py-1 font-mono text-xs" />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-[11px] text-[#475569] cursor-pointer">
                    <input type="checkbox" checked={numBarShowText} onChange={(e) => setNumBarShowText(e.target.checked)} />
                    Hiện dãy số bên dưới mã vạch
                  </label>
                </>
              )}
            </div>

            <label className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-[#F3F5F7] border border-[#E2E8F0] text-xs cursor-pointer">
              <span className="font-semibold text-[#17212F]">Bình chồng cắt (Cut &amp; Stack)</span>
              <input type="checkbox" checked={numCutAndStack} onChange={(e) => setNumCutAndStack(e.target.checked)} />
            </label>

            {numCutAndStack && (
              <div className="grid grid-cols-2 gap-2 text-xs">
                <select value={numSheetKey} onChange={(e) => setNumSheetKey(e.target.value)} className="border border-[#E2E8F0] rounded-md px-2 py-1.5 text-xs">
                  <option value="D330x480">330 × 480 mm</option>
                  <option value="SRA3">SRA3 (320 × 450)</option>
                  <option value="A3">A3 (297 × 420)</option>
                </select>
                <input type="number" min="0" step="0.5" value={numGutterMm} onChange={(e) => setNumGutterMm(parseFloat(e.target.value) || 0)} placeholder="Hở (mm)" className="border border-[#E2E8F0] rounded-md px-2 py-1.5 font-mono text-xs" />
              </div>
            )}

            <div className="mt-auto pt-3 border-t border-[#E2E8F0] flex flex-col gap-2">
              <button onClick={() => handleExportNumbering(true)} disabled={loading || !pdfBytes} className="w-full py-2.5 rounded-lg bg-[#087F5B] hover:bg-[#064E3B] text-white text-xs font-semibold cursor-pointer disabled:opacity-40">
                Áp dụng &amp; Đưa sang Bình Bài
              </button>
              <button onClick={() => handleExportNumbering(false)} disabled={loading || !pdfBytes} className="w-full py-2 rounded-lg bg-[#17212F] hover:bg-slate-800 text-white text-xs font-semibold cursor-pointer disabled:opacity-40">
                Xuất PDF Số Nhảy {numCutAndStack ? '(Cut & Stack)' : ''}
              </button>
            </div>
          </>
        )}

        {activeTool === 'vdp' && (
          <>
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-bold text-[#17212F]">Dữ liệu CSV / Dán từ Excel ({parsedVdp.rows.length} dòng)</label>
                <label className="text-[11px] font-semibold text-[#087F5B] hover:underline cursor-pointer">
                  + Nạp file .CSV
                  <input
                    type="file"
                    accept=".csv,.txt"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) setVdpRawText(await f.text());
                    }}
                  />
                </label>
              </div>
              <textarea
                rows={4}
                value={vdpRawText}
                onChange={(e) => setVdpRawText(e.target.value)}
                className="w-full border border-[#E2E8F0] rounded-md p-2 text-[11px] font-mono bg-[#F8FAFC]"
              />
            </div>

            {parsedVdp.rows.length > 0 && (
              <div className="flex items-center justify-between bg-[#F3F5F7] px-2.5 py-1.5 rounded-md text-xs">
                <span className="text-[#64748B]">Xem trước dòng:</span>
                <div className="flex items-center gap-1.5 font-mono">
                  <button onClick={() => setVdpPreviewRow((r) => Math.max(0, r - 1))} className="px-2 py-0.5 bg-white border border-[#E2E8F0] rounded cursor-pointer">‹</button>
                  <span className="font-bold text-[#087F5B]">{vdpPreviewRow + 1}/{parsedVdp.rows.length}</span>
                  <button onClick={() => setVdpPreviewRow((r) => Math.min(parsedVdp.rows.length - 1, r + 1))} className="px-2 py-0.5 bg-white border border-[#E2E8F0] rounded cursor-pointer">›</button>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between pt-1">
              <span className="text-xs font-bold text-[#17212F]">Các trường đặt lên mẫu</span>
              <div className="flex gap-1">
                <button
                  onClick={() => {
                    const id = `f-${Date.now()}`;
                    setVdpFields((p) => [...p, { id, type: 'text', col: parsedVdp.headers[0] || '', xMm: 20, yMm: 20, fontSizePt: 11, color: '#17212F', qrSizeMm: 16 }]);
                    setActiveVdpFieldId(id);
                  }}
                  className="px-2 py-1 rounded bg-[#DDF5EC] text-[#064E3B] text-[10px] font-bold cursor-pointer"
                >
                  + Chữ
                </button>
                <button
                  onClick={() => {
                    const id = `qr-${Date.now()}`;
                    setVdpFields((p) => [...p, { id, type: 'qr', col: parsedVdp.headers[parsedVdp.headers.length - 1] || '', xMm: 50, yMm: 15, fontSizePt: 11, color: '#17212F', qrSizeMm: 16 }]);
                    setActiveVdpFieldId(id);
                  }}
                  className="px-2 py-1 rounded bg-[#F3F5F7] border border-[#E2E8F0] text-[#17212F] text-[10px] font-bold cursor-pointer"
                >
                  + QR
                </button>
                <button
                  onClick={() => {
                    const id = `bar-${Date.now()}`;
                    setVdpFields((p) => [
                      ...p,
                      {
                        id,
                        type: 'barcode',
                        col: parsedVdp.headers[0] || '',
                        xMm: 15,
                        yMm: 36,
                        barcodeSymbology: 'code128',
                        barWidthMm: 38,
                        barHeightMm: 12,
                        showText: true,
                        color: '#000000',
                      },
                    ]);
                    setActiveVdpFieldId(id);
                  }}
                  className="px-2 py-1 rounded bg-[#17212F] text-white text-[10px] font-bold cursor-pointer"
                >
                  + Barcode
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              {vdpFields.map((f) => {
                const active = f.id === activeVdpFieldId;
                return (
                  <div
                    key={f.id}
                    onClick={() => setActiveVdpFieldId(f.id)}
                    className={`p-2 rounded-lg border text-xs cursor-pointer flex flex-col gap-1.5 ${
                      active ? 'border-[#087F5B] bg-[#DDF5EC]/30' : 'border-[#E2E8F0] bg-white'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="px-1.5 py-0.5 rounded bg-slate-100 text-[10px] font-bold">
                        {f.type === 'qr' ? 'QR' : f.type === 'barcode' ? 'BAR' : 'TEXT'}
                      </span>
                      <select
                        value={f.col}
                        onChange={(e) => setVdpFields((p) => p.map((x) => (x.id === f.id ? { ...x, col: e.target.value } : x)))}
                        className="flex-1 border border-[#E2E8F0] rounded px-1.5 py-0.5 text-xs bg-white"
                      >
                        {parsedVdp.headers.map((h) => (
                          <option key={h} value={h}>{h}</option>
                        ))}
                      </select>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setVdpFields((p) => p.filter((x) => x.id !== f.id));
                        }}
                        className="text-rose-500 font-bold px-1 cursor-pointer"
                      >
                        ×
                      </button>
                    </div>
                    {active && (
                      <>
                        <div className="grid grid-cols-3 gap-1.5 text-[11px] font-mono">
                          <input type="number" value={f.xMm} onChange={(e) => setVdpFields((p) => p.map((x) => (x.id === f.id ? { ...x, xMm: parseFloat(e.target.value) || 0 } : x)))} className="border border-[#E2E8F0] rounded px-1.5 py-0.5 bg-white" title="X mm" />
                          <input type="number" value={f.yMm} onChange={(e) => setVdpFields((p) => p.map((x) => (x.id === f.id ? { ...x, yMm: parseFloat(e.target.value) || 0 } : x)))} className="border border-[#E2E8F0] rounded px-1.5 py-0.5 bg-white" title="Y mm" />
                          {f.type === 'qr' ? (
                            <input type="number" min="6" value={f.qrSizeMm} onChange={(e) => setVdpFields((p) => p.map((x) => (x.id === f.id ? { ...x, qrSizeMm: parseFloat(e.target.value) || 12 } : x)))} className="border border-[#E2E8F0] rounded px-1.5 py-0.5 bg-white" title="Cỡ QR mm" />
                          ) : f.type === 'barcode' ? (
                            <input type="number" min="12" value={f.barWidthMm || 38} onChange={(e) => setVdpFields((p) => p.map((x) => (x.id === f.id ? { ...x, barWidthMm: parseFloat(e.target.value) || 38 } : x)))} className="border border-[#E2E8F0] rounded px-1.5 py-0.5 bg-white" title="Rộng mã mm" />
                          ) : (
                            <input type="number" min="5" value={f.fontSizePt} onChange={(e) => setVdpFields((p) => p.map((x) => (x.id === f.id ? { ...x, fontSizePt: parseFloat(e.target.value) || 10 } : x)))} className="border border-[#E2E8F0] rounded px-1.5 py-0.5 bg-white" title="Cỡ chữ pt" />
                          )}
                        </div>
                        {f.type === 'barcode' && (
                          <div className="flex flex-col gap-1.5 pt-1 border-t border-slate-200/70">
                            <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                              <select
                                value={f.barcodeSymbology || 'code128'}
                                onChange={(e) => setVdpFields((p) => p.map((x) => (x.id === f.id ? { ...x, barcodeSymbology: e.target.value } : x)))}
                                className="border border-[#E2E8F0] rounded px-1.5 py-0.5 bg-white"
                              >
                                <option value="code128">Code 128</option>
                                <option value="ean13">EAN-13</option>
                                <option value="code39">Code 39</option>
                              </select>
                              <input
                                type="number"
                                min="5"
                                value={f.barHeightMm || 12}
                                onChange={(e) => setVdpFields((p) => p.map((x) => (x.id === f.id ? { ...x, barHeightMm: parseFloat(e.target.value) || 12 } : x)))}
                                className="border border-[#E2E8F0] rounded px-1.5 py-0.5 bg-white font-mono"
                                title="Cao mã mm"
                              />
                            </div>
                            <label className="flex items-center gap-1.5 text-[11px] text-[#475569] cursor-pointer">
                              <input
                                type="checkbox"
                                checked={f.showText !== false}
                                onChange={(e) => setVdpFields((p) => p.map((x) => (x.id === f.id ? { ...x, showText: e.target.checked } : x)))}
                              />
                              Hiện chữ dưới mã vạch
                            </label>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mt-auto pt-3 border-t border-[#E2E8F0] flex flex-col gap-2">
              <button onClick={() => handleExportVdp(true)} disabled={loading || !pdfBytes || parsedVdp.rows.length === 0} className="w-full py-2.5 rounded-lg bg-[#087F5B] hover:bg-[#064E3B] text-white text-xs font-semibold cursor-pointer disabled:opacity-40">
                Trộn &amp; Đưa sang Bình Bài
              </button>
              <button onClick={() => handleExportVdp(false)} disabled={loading || !pdfBytes || parsedVdp.rows.length === 0} className="w-full py-2 rounded-lg bg-[#17212F] hover:bg-slate-800 text-white text-xs font-semibold cursor-pointer disabled:opacity-40">
                Xuất PDF VDP ({parsedVdp.rows.length} trang)
              </button>
            </div>
          </>
        )}

        {activeTool === 'preflight' && (
          <div className="flex flex-col gap-2.5 text-xs text-[#64748B]">
            <p>Công cụ tự động kiểm tra:</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>Kích thước đồng nhất giữa các trang</li>
              <li>Tình trạng thiếu TrimBox / Bleed</li>
              <li>Phát hiện màu RGB trong lệnh vẽ PDF</li>
              <li>Chi tiết đồ họa quá sát mép cắt (&lt;2.5 mm)</li>
            </ul>
            <label className="mt-2 w-full py-2 rounded-lg bg-[#087F5B] hover:bg-[#064E3B] text-white text-xs font-semibold text-center cursor-pointer">
              Chọn file PDF khác để kiểm tra
              <input type="file" accept=".pdf,application/pdf" className="hidden" onChange={(e) => handleUpload(e.target.files?.[0])} />
            </label>
          </div>
        )}

        {activeTool === 'quote' && (
          <>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <label className="text-[10px] text-[#64748B]">Số lượng cần in (SP)</label>
                <input type="number" min="1" value={quoteQty} onChange={(e) => setQuoteQty(Math.max(1, parseInt(e.target.value, 10) || 1))} className="w-full border border-[#E2E8F0] rounded-md px-2 py-1.5 font-mono font-bold" />
              </div>
              <div>
                <label className="text-[10px] text-[#64748B]">Số mặt in</label>
                <select value={duplexSides} onChange={(e) => setDuplexSides(Number(e.target.value))} className="w-full border border-[#E2E8F0] rounded-md px-2 py-1.5">
                  <option value={1}>1 Mặt</option>
                  <option value={2}>2 Mặt</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] text-[#64748B]">Giá giấy (đ/tờ)</label>
                <input type="number" step="100" value={paperCostPerSheet} onChange={(e) => setPaperCostPerSheet(Math.max(0, parseInt(e.target.value, 10) || 0))} className="w-full border border-[#E2E8F0] rounded-md px-2 py-1.5 font-mono" />
              </div>
              <div>
                <label className="text-[10px] text-[#64748B]">Công in (đ/mặt)</label>
                <input type="number" step="100" value={printCostPerSide} onChange={(e) => setPrintCostPerSide(Math.max(0, parseInt(e.target.value, 10) || 0))} className="w-full border border-[#E2E8F0] rounded-md px-2 py-1.5 font-mono" />
              </div>
              <div>
                <label className="text-[10px] text-[#64748B]">Cán màng</label>
                <select value={laminationType} onChange={(e) => setLaminationType(e.target.value)} className="w-full border border-[#E2E8F0] rounded-md px-2 py-1.5">
                  <option value="none">Không cán</option>
                  <option value="matte">Cán mờ</option>
                  <option value="gloss">Cán bóng</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] text-[#64748B]">Giá cán (đ/tờ)</label>
                <input type="number" step="100" disabled={laminationType === 'none'} value={lamCostPerSheet} onChange={(e) => setLamCostPerSheet(Math.max(0, parseInt(e.target.value, 10) || 0))} className="w-full border border-[#E2E8F0] rounded-md px-2 py-1.5 font-mono disabled:bg-slate-50" />
              </div>
              <div>
                <label className="text-[10px] text-[#64748B]">Gia công (Xén/Bế)</label>
                <input type="number" step="10000" value={finishingCost} onChange={(e) => setFinishingCost(Math.max(0, parseInt(e.target.value, 10) || 0))} className="w-full border border-[#E2E8F0] rounded-md px-2 py-1.5 font-mono" />
              </div>
              <div>
                <label className="text-[10px] text-[#64748B]">Bù hao (%) / Lãi (%)</label>
                <div className="flex gap-1">
                  <input type="number" min="0" value={wastePct} onChange={(e) => setWastePct(Math.max(0, parseFloat(e.target.value) || 0))} className="w-1/2 border border-[#E2E8F0] rounded-md px-1.5 py-1.5 font-mono" />
                  <input type="number" min="0" value={profitPct} onChange={(e) => setProfitPct(Math.max(0, parseFloat(e.target.value) || 0))} className="w-1/2 border border-[#E2E8F0] rounded-md px-1.5 py-1.5 font-mono" />
                </div>
              </div>
            </div>

            <div className="mt-auto pt-3 border-t border-[#E2E8F0]">
              <button
                onClick={() => {
                  const msg = `BÁO GIÁ IN ẤN (PrintKit)\n- Số lượng: ${quoteQty.toLocaleString()} sp (${itemsPerSheet} con/tờ)\n- Tổng tiền: ${formatVnd(sellPrice)} (${formatVnd(unitSellPrice)}/sp)`;
                  navigator.clipboard?.writeText(msg);
                  setCopiedQuote(true);
                  setTimeout(() => setCopiedQuote(false), 2000);
                }}
                className="w-full py-2.5 rounded-lg bg-[#087F5B] hover:bg-[#064E3B] text-white text-xs font-semibold cursor-pointer"
              >
                {copiedQuote ? 'Đã sao chép báo giá!' : 'Sao chép báo giá gửi khách'}
              </button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
