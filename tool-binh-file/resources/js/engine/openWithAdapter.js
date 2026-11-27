/**
 * PrintKit Architecture V1 — Open-With External App Handoff Adapter (Checkpoint F)
 *
 * Prepares 1:1 handoff artifacts for Adobe Illustrator / CorelDRAW directly from CutMasterV1:
 *  - NEVER recomputes Cutline or Imposition.
 *  - NEVER fakes desktop launch in browser/headless runtime: returns DESKTOP_HANDOFF_REQUIRED
 *    when no native desktop launcher is injected.
 */

import { exportCutMaster } from './cutVectorExporter.js';
import { assertNoBinaryInState } from './v1Schema.js';

export const EXTERNAL_APPS = Object.freeze(['ILLUSTRATOR', 'CORELDRAW']);

export class OpenWithError extends Error {
  constructor({ code, message, app = null }) {
    super(message);
    this.name = 'OpenWithError';
    this.stage = 'OPEN_WITH';
    this.code = code;
    this.app = app;
  }
}

/**
 * Prepare a handoff artifact from authoritative CutMasterV1 and attempt desktop handoff if launcher is available.
 */
export async function openWithExternalApp({
  app,
  cutMaster,
  resourceStore,
  format = 'PDF',
  scope = 'CUT_ONLY',
  sheetSelection = 'ALL',
  desktopLauncher = null, // optional native bridge in EXE/Electron runtime
  printOverlayRenderer = null,
}) {
  if (!EXTERNAL_APPS.includes(app)) {
    throw new OpenWithError({
      code: 'UNSUPPORTED_APP',
      app,
      message: `Unsupported external app "${app}" (expected ILLUSTRATOR or CORELDRAW)`,
    });
  }
  if (!cutMaster || !Array.isArray(cutMaster.sheets) || cutMaster.sheets.length === 0) {
    throw new OpenWithError({
      code: 'INVALID_CUT_MASTER',
      app,
      message: 'Valid CutMasterV1 is required for external app handoff',
    });
  }
  if (!resourceStore) {
    throw new OpenWithError({
      code: 'INVALID_INPUT',
      app,
      message: 'resourceStore is required to hold ephemeral handoff artifact',
    });
  }

  // Export directly from the SAME CutMasterV1 (0 Cutline calls, 0 Imposition calls)
  const exported = await exportCutMaster(cutMaster, {
    format,
    scope,
    sheetSelection,
    printOverlayRenderer,
  });

  const artifactMeta = await resourceStore.acquire(exported.bytes, {
    kind: 'pdf_output',
    mimeType: exported.mimeType,
    ephemeral: true,
  });

  const handoff = {
    app,
    planId: cutMaster.planId,
    planRevision: cutMaster.planRevision,
    format: exported.format,
    scope,
    exportedSheetIndices: exported.exportedSheetIndices,
    artifact: {
      resourceId: artifactMeta.resourceId,
      mimeType: artifactMeta.mimeType,
      sha256: artifactMeta.sha256,
      byteLength: artifactMeta.byteLength,
    },
  };

  if (typeof desktopLauncher !== 'function') {
    const res = {
      status: 'DESKTOP_HANDOFF_REQUIRED',
      launched: false,
      reason: 'Browser/headless runtime cannot launch desktop apps directly; handoff artifact is ready for download or desktop bridge.',
      handoff,
    };
    assertNoBinaryInState(res, 'openWithResult');
    return res;
  }

  await desktopLauncher(handoff);
  const res = {
    status: 'LAUNCHED',
    launched: true,
    reason: null,
    handoff,
  };
  assertNoBinaryInState(res, 'openWithResult');
  return res;
}
