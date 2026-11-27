/**
 * PrintKit Architecture V1 — Final Production Validator Wrapper (Checkpoint G)
 *
 * Orchestrates final production decision WITHOUT modifying or reimplementing LOCKED 3.1.3:
 *   1. assertPlanFreshness()          -> blocks STALE_PLAN immediately
 *   2. ResourceStore integrity check  -> verifies resource exists, mime, byteLength, SHA-256
 *   3. LOCKED validateProductionPdf() -> 3.1.3 audit on actual PRINT.pdf & CUT.pdf bytes
 *   4. validateProductionPair()       -> cross-checks PRINT <-> CUT <-> Manifest <-> CutMaster
 *   5. validateCutSvgAgainstMaster()  -> optional CUT SVG cross-format geometry audit
 *   6. Final Decision: PASS | WARNING | BLOCK  -> productionReady boolean
 */

import { PDFDocument } from 'pdf-lib';
import { validateProductionPdf } from './pdfProductionValidator.js';
import { assertPlanFreshness } from './batchImpositionAdapter.js';
import {
  validateProductionPair,
  validateCutSvgAgainstMaster,
} from './productionPairValidator.js';
import { assertNoBinaryInState } from './v1Schema.js';

async function sha256Bytes(uint8) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new Error('finalProductionValidator: crypto.subtle.digest is unavailable');
  }
  const buf =
    uint8.byteOffset === 0 && uint8.byteLength === uint8.buffer.byteLength
      ? uint8.buffer
      : uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
  const digest = await subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Invoke LOCKED 3.1.3 validateProductionPdf() on every page of a 1-page or multi-sheet PDF
 * without duplicating any 3.1.3 logic or modifying pdfProductionValidator.js.
 */
async function runLocked313OnAllPages(pdfBytes, sheetSpecs, { expectArtwork, expectBleed, isCutRole }) {
  const doc = await PDFDocument.load(pdfBytes);
  const pages = doc.getPages();
  const perSheetReports = [];
  const errors = [];
  const warnings = [];

  for (let i = 0; i < pages.length; i++) {
    let singlePageBytes = pdfBytes;
    if (pages.length > 1) {
      const subDoc = await PDFDocument.create();
      const [copied] = await subDoc.copyPages(doc, [i]);
      subDoc.addPage(copied);
      singlePageBytes = await subDoc.save();
    }
    const spec = sheetSpecs[i] || {};
    const rep = await validateProductionPdf(singlePageBytes, {
      mode: 'sheet',
      expectedStickerCount: isCutRole ? spec.expectedCutCount ?? null : null,
      expectedSheetWidthMm: spec.widthMm ?? null,
      expectedSheetHeightMm: spec.heightMm ?? null,
      expectArtwork,
      expectBleed,
      dimToleranceMm: 0.05,
    });
    perSheetReports.push({ sheetIndex: i + 1, valid: rep.valid, errors: rep.errors, warnings: rep.warnings });
    for (const e of rep.errors) errors.push({ code: 'PDF_313_ERROR', message: `Page #${i + 1}: ${e}` });
    for (const w of rep.warnings) warnings.push(`Page #${i + 1}: ${w}`);
  }

  return {
    valid: pages.length > 0 && errors.length === 0,
    pageCount: pages.length,
    perSheetReports,
    errors,
    warnings,
  };
}

/**
 * Final Production Check (Gate 2) on an exported PRINT + CUT production pair.
 */
export async function finalProductionCheck({
  plan,
  jobs,
  output,
  resourceStore,
  sheetConfig = null,
  productionProfile = null,
  overridePrintBytes = null, // optional for controlled fault-injection tests (PDF1..PDF8)
  overrideCutBytes = null,
  cutSvgBytes = null,
  productionObjects = null,
}) {
  const errors = [];
  const warnings = [];

  // 1. Stale Plan Guard (NEVER validate a stale plan as production-ready)
  try {
    assertPlanFreshness(plan, jobs, sheetConfig, productionProfile);
  } catch (staleErr) {
    const res = {
      productionReady: false,
      status: 'BLOCK',
      print: null,
      cut: null,
      pair: null,
      svgCheck: null,
      resources: { valid: false, printOk: false, cutOk: false },
      errors: [{ code: staleErr?.code || 'STALE_PLAN', message: staleErr?.message || 'Plan is stale' }],
      warnings: [],
      metrics: {
        expectedPlacements: output?.manifest?.placements?.length || 0,
        printPlacements: 0,
        cutPlacements: 0,
        maxSerializedAlignmentDeltaMm: null,
        measurementType: 'SERIALIZED_GEOMETRY_DELTA',
      },
    };
    assertNoBinaryInState(res, 'finalCheckResult');
    return res;
  }

  // 2. Resource Integrity (exists, mimeType, byteLength > 0, actual SHA-256 == metadata SHA-256)
  const checkRes = async (ref, expectedMime, overrideBytes, role) => {
    if (!ref || !ref.resourceId || !resourceStore.has(ref.resourceId)) {
      errors.push({ code: 'MISSING_RESOURCE', message: `${role} resource "${ref?.resourceId}" is missing from ResourceStore` });
      return { ok: false, bytes: null };
    }
    const meta = resourceStore.getMetadata(ref.resourceId);
    const blob = resourceStore.getBlob(ref.resourceId);
    const bytes = overrideBytes ? new Uint8Array(overrideBytes) : new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength === 0) {
      errors.push({ code: 'EMPTY_RESOURCE', message: `${role} resource has 0 bytes` });
      return { ok: false, bytes: null };
    }
    if (expectedMime && meta.mimeType !== expectedMime) {
      errors.push({ code: 'MIME_MISMATCH', message: `${role} mimeType "${meta.mimeType}" != expected "${expectedMime}"` });
      return { ok: false, bytes: null };
    }
    const actualSha = await sha256Bytes(bytes);
    if (actualSha !== ref.sha256 || actualSha !== meta.sha256) {
      errors.push({
        code: 'RESOURCE_HASH_MISMATCH',
        message: `${role} bytes SHA-256 (${actualSha.slice(0, 12)}) does not match manifest/store (${ref.sha256.slice(0, 12)})`,
      });
      return { ok: false, bytes };
    }
    return { ok: true, bytes };
  };

  const printRes = await checkRes(output?.print, 'application/pdf', overridePrintBytes, 'PRINT');
  const cutRes = await checkRes(output?.cut, 'application/pdf', overrideCutBytes, 'CUT');
  const resourceCheck = { valid: printRes.ok && cutRes.ok, printOk: printRes.ok, cutOk: cutRes.ok };

  // 3. LOCKED 3.1.3 validateProductionPdf() on actual PRINT.pdf & CUT.pdf bytes
  const sheetSpecs = (output?.manifest?.sheets || []).map((s) => ({
    widthMm: s.widthMm,
    heightMm: s.heightMm,
    expectedCutCount: s.placementIds.length,
  }));

  let printValidation = null;
  let cutValidation = null;
  if (printRes.bytes) {
    try {
      printValidation = await runLocked313OnAllPages(printRes.bytes, sheetSpecs, {
        expectArtwork: true,
        expectBleed: false,
        isCutRole: false,
      });
      for (const e of printValidation.errors) errors.push(e);
      for (const w of printValidation.warnings) warnings.push(w);
    } catch (e) {
      errors.push({ code: 'INVALID_PRINT_PDF', message: `PRINT 3.1.3 failed: ${e.message}` });
    }
  }
  if (cutRes.bytes) {
    try {
      cutValidation = await runLocked313OnAllPages(cutRes.bytes, sheetSpecs, {
        expectArtwork: output?.manifest?.scope === 'CUT_PLUS_PRINT',
        expectBleed: false,
        isCutRole: true,
      });
      for (const e of cutValidation.errors) errors.push(e);
      for (const w of cutValidation.warnings) warnings.push(w);
    } catch (e) {
      errors.push({ code: 'INVALID_CUT_PDF', message: `CUT 3.1.3 failed: ${e.message}` });
    }
  }

  // 4. Pair Integrity Cross-Check (PRINT <-> CUT <-> Manifest <-> CutMaster)
  let pairValidation = null;
  if (printRes.bytes && cutRes.bytes) {
    pairValidation = await validateProductionPair({
      printPdfBytes: printRes.bytes,
      cutPdfBytes: cutRes.bytes,
      plan,
      cutMaster: output.cutMaster,
      manifest: output.manifest,
      scope: output.manifest.scope || 'CUT_ONLY',
      productionObjects,
    });
    for (const e of pairValidation.errors) errors.push(e);
    for (const w of pairValidation.warnings) warnings.push(w);
  }

  // 5. Optional CUT SVG cross-format audit
  let svgCheck = null;
  if (cutSvgBytes) {
    const firstSheetIdx = output?.manifest?.exportedSheetIndices?.[0] ?? 0;
    svgCheck = validateCutSvgAgainstMaster(cutSvgBytes, output.cutMaster, firstSheetIdx, output?.manifest?.scope || 'CUT_ONLY');
    for (const e of svgCheck.errors) errors.push(e);
  }

  // 6. Preserve upstream non-blocking warnings (e.g. LOCAL_CORNER_OVER from 3.1.2)
  for (const job of jobs) {
    if (!job.order?.included || job.order?.quantity <= 0) continue;
    if (job.validation?.readinessValidation?.status === 'WARNING') {
      warnings.push(`Job ${job.jobId}: ${(job.validation.readinessValidation.reasons || []).join('; ') || 'WARNING'}`);
    }
  }

  // 7. Final Decision (PASS | WARNING | BLOCK)
  const status = errors.length > 0 ? 'BLOCK' : warnings.length > 0 ? 'WARNING' : 'PASS';
  const productionReady = status === 'PASS' || status === 'WARNING';

  const finalReport = {
    productionReady,
    status,
    print: printValidation,
    cut: cutValidation,
    pair: pairValidation,
    svgCheck,
    resources: resourceCheck,
    errors,
    warnings,
    metrics: {
      expectedPlacements: pairValidation?.expectedPlacements ?? (output?.manifest?.placements?.length || 0),
      printPlacements: pairValidation?.printPlacements ?? 0,
      cutPlacements: pairValidation?.cutPlacements ?? 0,
      maxSerializedAlignmentDeltaMm: pairValidation?.maxSerializedAlignmentDeltaMm ?? null,
      measurementType: 'SERIALIZED_GEOMETRY_DELTA',
    },
  };

  assertNoBinaryInState(finalReport, 'finalCheckResult');
  return finalReport;
}

