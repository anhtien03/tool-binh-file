/**
 * PrintKit Architecture V1 — Canonical Schema Contracts, Factories & Validators (Checkpoint C)
 *
 * Pure data contracts & fail-fast validators — NO business engine logic, NO silent input clamping,
 * NO binary objects (Blob/Canvas/Uint8Array/ImageData) allowed inside V1 state objects.
 */

export const V1_SCHEMA_VERSION = 1;
export const ANALYSIS_VERSION = '1.0';
export const EXTRACTOR_VERSION = '1.0';
export const CUTLINE_ENGINE_VERSION = '3.1.2';
export const VALIDATOR_VERSION = '3.1.3';

export const ASSET_CLASSIFICATIONS = Object.freeze([
  'CLEAN_SINGLE',
  'CLEAN_MULTI_SHEET',
  'MOCKUP',
  'LOW_QUALITY',
  'INVALID',
]);

export const RECOMMENDED_ACTIONS = Object.freeze([
  'DIRECT_CUTLINE',
  'NEED_EXTRACTION',
  'NEED_REVIEW',
  'BLOCK',
]);

export const SHAPE_MODES = Object.freeze(['auto', 'circle', 'oval', 'rect']);
export const BLEED_MODES = Object.freeze(['precision', 'white_border', 'none']);
export const JOB_STATUSES = Object.freeze(['READY', 'WARNING', 'BLOCKED']);
export const DPI_STATUSES = Object.freeze(['OK', 'WARNING', 'FAIL']);
export const SOURCE_TYPES = Object.freeze(['pdf', 'image']);
export const EXTRACTION_STATUSES = Object.freeze(['NEED_EXTRACTION', 'NEED_REVIEW', 'APPROVED', 'REJECTED']);
export const ALLOWED_ROTATIONS = Object.freeze([0, 90, 180, 270]);

export class SchemaValidationError extends Error {
  constructor(message, { code = 'SCHEMA_VALIDATION_ERROR', field = null, value = undefined } = {}) {
    super(message);
    this.name = 'SchemaValidationError';
    this.code = code;
    this.field = field;
    this.value = value;
  }
}

// ============================================================================
// Fail-Fast Primitive Assertions (NEVER silently clamp invalid caller input)
// ============================================================================

function fail(field, message, value, code = 'INVALID_FIELD') {
  throw new SchemaValidationError(`${field}: ${message}`, { code, field, value });
}

function assertNonEmptyString(val, field) {
  if (typeof val !== 'string' || val.trim().length === 0) {
    fail(field, 'must be a non-empty string', val, 'REQUIRED_STRING');
  }
  return val;
}

function assertEnum(val, allowed, field) {
  if (!allowed.includes(val)) {
    fail(field, `must be one of [${allowed.join(', ')}]`, val, 'INVALID_ENUM');
  }
  return val;
}

function assertFiniteNumber(val, field) {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    fail(field, 'must be a finite number', val, 'INVALID_NUMBER');
  }
  return val;
}

function assertPositiveNumber(val, field) {
  assertFiniteNumber(val, field);
  if (val <= 0) fail(field, 'must be > 0', val, 'NON_POSITIVE_NUMBER');
  return val;
}

function assertNonNegativeNumber(val, field) {
  assertFiniteNumber(val, field);
  if (val < 0) fail(field, 'must be >= 0', val, 'NEGATIVE_NUMBER');
  return val;
}

function assertIntegerMin(val, min, field) {
  if (typeof val !== 'number' || !Number.isInteger(val) || val < min) {
    fail(field, `must be an integer >= ${min}`, val, 'INVALID_INTEGER');
  }
  return val;
}

function assertRange(val, min, max, field) {
  assertFiniteNumber(val, field);
  if (val < min || val > max) {
    fail(field, `must be within [${min}, ${max}]`, val, 'OUT_OF_RANGE');
  }
  return val;
}

function assertBoolean(val, field) {
  if (typeof val !== 'boolean') {
    fail(field, 'must be a boolean', val, 'INVALID_BOOLEAN');
  }
  return val;
}

function assertPositiveSize(size, field) {
  if (!size || typeof size !== 'object') fail(field, 'must be an object { w, h }', size, 'INVALID_OBJECT');
  assertPositiveNumber(size.w, `${field}.w`);
  assertPositiveNumber(size.h, `${field}.h`);
  return { w: size.w, h: size.h };
}

function assertValidRegionMm(region, field) {
  if (!region || typeof region !== 'object') fail(field, 'must be an object { x, y, w, h }', region, 'INVALID_OBJECT');
  assertNonNegativeNumber(region.x, `${field}.x`);
  assertNonNegativeNumber(region.y, `${field}.y`);
  assertPositiveNumber(region.w, `${field}.w`);
  assertPositiveNumber(region.h, `${field}.h`);
  return { x: region.x, y: region.y, w: region.w, h: region.h };
}

/**
 * Recursively guarantees that NO binary/DOM objects (Blob, File, Uint8Array, ArrayBuffer,
 * Canvas, ImageData, HTMLImageElement, ImageBitmap) leak into V1 JSON state.
 */
export function assertNoBinaryInState(obj, path = 'root', seen = new WeakSet()) {
  if (obj === null || obj === undefined || typeof obj !== 'object') return;
  if (typeof Blob !== 'undefined' && obj instanceof Blob) {
    fail(path, 'Blob/File is forbidden in V1 state (use resourceId via ResourceStore)', '[Blob]', 'BINARY_LEAK');
  }
  if (obj instanceof ArrayBuffer || ArrayBuffer.isView(obj)) {
    fail(path, 'ArrayBuffer/TypedArray is forbidden in V1 state (use resourceId via ResourceStore)', '[Binary]', 'BINARY_LEAK');
  }
  if (typeof ImageData !== 'undefined' && obj instanceof ImageData) {
    fail(path, 'ImageData is forbidden in V1 state', '[ImageData]', 'BINARY_LEAK');
  }
  if (typeof ImageBitmap !== 'undefined' && obj instanceof ImageBitmap) {
    fail(path, 'ImageBitmap is forbidden in V1 state', '[ImageBitmap]', 'BINARY_LEAK');
  }
  if (typeof HTMLCanvasElement !== 'undefined' && obj instanceof HTMLCanvasElement) {
    fail(path, 'HTMLCanvasElement is forbidden in V1 state', '[Canvas]', 'BINARY_LEAK');
  }
  if (typeof HTMLImageElement !== 'undefined' && obj instanceof HTMLImageElement) {
    fail(path, 'HTMLImageElement is forbidden in V1 state', '[Image]', 'BINARY_LEAK');
  }
  // Duck-type check for mock canvases/ImageData in headless Node tests
  if (typeof obj.getContext === 'function' && typeof obj.width === 'number' && typeof obj.height === 'number') {
    fail(path, 'Canvas-like object is forbidden in V1 state', '[CanvasLike]', 'BINARY_LEAK');
  }
  if (seen.has(obj)) return;
  seen.add(obj);
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) assertNoBinaryInState(obj[i], `${path}[${i}]`, seen);
  } else {
    for (const [k, v] of Object.entries(obj)) assertNoBinaryInState(v, `${path}.${k}`, seen);
  }
}

// ============================================================================
// Immutable Identity Generators (NEVER encode array index, targetSize, or quantity)
// ============================================================================

let idSeq = 0;
function randomToken(len = 6) {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(Math.ceil(len / 2));
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, len);
  }
  return Math.random().toString(16).slice(2, 2 + len).padEnd(len, '0');
}

export function createEntityId(prefix) {
  assertNonEmptyString(prefix, 'prefix');
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSeq.toString(36)}-${randomToken(6)}`;
}

export const createAssetId = () => createEntityId('AST');
export const createJobId = () => createEntityId('JOB');
export const createExtractionId = () => createEntityId('EXT');
export const createPlanId = () => createEntityId('PLAN');
export const createOutputId = () => createEntityId('OUT');

export function assertUniqueJobIds(jobs) {
  if (!Array.isArray(jobs)) fail('jobs', 'must be an array', jobs, 'INVALID_ARRAY');
  const seen = new Set();
  for (let i = 0; i < jobs.length; i++) {
    const id = jobs[i]?.jobId;
    assertNonEmptyString(id, `jobs[${i}].jobId`);
    if (seen.has(id)) {
      fail(`jobs[${i}].jobId`, `duplicate jobId "${id}"`, id, 'DUPLICATE_JOB_ID');
    }
    seen.add(id);
  }
}

// ============================================================================
// Canonical Deterministic Serialization & SHA-256 Hashing
// ============================================================================

export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalStringify(v)).join(',')}]`;
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
}

async function defaultSha256Text(text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new Error('v1Schema: crypto.subtle.digest is unavailable for SHA-256 hashing');
  }
  const encoded = new TextEncoder().encode(text);
  const digest = await subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compute deterministic cutInputHash covering ONLY inputs that can alter Canonical CUT:
 *   artworkContentHash, pageIndex, extractionId, cutConfig, cutlineEngineVersion.
 * Explicitly EXCLUDES quantity, targetSizeMm, sheetConfig, allowRotate, and BleedConfigV1.
 */
export async function computeCutInputHash(params, hashTextFn = defaultSha256Text) {
  const artworkContentHash = assertNonEmptyString(params?.artworkContentHash, 'artworkContentHash');
  const pageIndex = assertIntegerMin(params?.pageIndex ?? 1, 1, 'pageIndex');
  const extractionId = params?.extractionId ?? null;
  if (extractionId !== null) assertNonEmptyString(extractionId, 'extractionId');
  const cutConfig = validateCutConfigV1(params?.cutConfig);
  const cutlineEngineVersion = assertNonEmptyString(
    params?.cutlineEngineVersion ?? CUTLINE_ENGINE_VERSION,
    'cutlineEngineVersion'
  );
  const payload = canonicalStringify({
    artworkContentHash,
    pageIndex,
    extractionId,
    cutConfig,
    cutlineEngineVersion,
  });
  return await hashTextFn(payload);
}

// ============================================================================
// Revision Helpers (Explicit V1 Semantics)
// ============================================================================

export function nextCutRevision(prev = 0) {
  return assertIntegerMin(prev, 0, 'cutRevision') + 1;
}

export function nextProductionGeometryRevision(prev = 0) {
  return assertIntegerMin(prev, 0, 'productionGeometryRevision') + 1;
}

export function nextJobRevision(prev = 0) {
  return assertIntegerMin(prev, 0, 'jobRevision') + 1;
}

export function nextPlanRevision(prev = 0) {
  return assertIntegerMin(prev, 0, 'planRevision') + 1;
}

// ============================================================================
// Config Factories & Validators
// ============================================================================

export const DEFAULT_CUT_CONFIG_V1 = Object.freeze({
  shapeMode: 'auto',
  offsetMm: 0.5,
  mergeGapMm: 0.35,
  cornerAngleDeg: 130,
  smoothLevel: 1,
  simplifyMm: 0.18,
  minAreaMm2: 8.0,
  ignoreCornerMarks: true,
});

export const DEFAULT_BLEED_CONFIG_V1 = Object.freeze({
  bleedMode: 'precision',
  bleedOffsetMm: 1.5,
  offsetToleranceUnderMm: 0.15,
  offsetToleranceOverMm: 0.15,
});

export function validateCutConfigV1(input) {
  if (!input || typeof input !== 'object') fail('cutConfig', 'must be an object', input, 'INVALID_OBJECT');
  return Object.freeze({
    shapeMode: assertEnum(input.shapeMode, SHAPE_MODES, 'cutConfig.shapeMode'),
    offsetMm: assertRange(input.offsetMm, -10, 50, 'cutConfig.offsetMm'),
    mergeGapMm: assertRange(input.mergeGapMm, 0, 50, 'cutConfig.mergeGapMm'),
    cornerAngleDeg: assertRange(input.cornerAngleDeg, 30, 179, 'cutConfig.cornerAngleDeg'),
    smoothLevel: assertIntegerMin(input.smoothLevel, 0, 'cutConfig.smoothLevel'),
    simplifyMm: assertPositiveNumber(input.simplifyMm, 'cutConfig.simplifyMm'),
    minAreaMm2: assertPositiveNumber(input.minAreaMm2, 'cutConfig.minAreaMm2'),
    ignoreCornerMarks: assertBoolean(input.ignoreCornerMarks, 'cutConfig.ignoreCornerMarks'),
  });
}

export function createCutConfigV1(overrides = {}) {
  return validateCutConfigV1({ ...DEFAULT_CUT_CONFIG_V1, ...overrides });
}

export function validateBleedConfigV1(input) {
  if (!input || typeof input !== 'object') fail('bleedConfig', 'must be an object', input, 'INVALID_OBJECT');
  return Object.freeze({
    bleedMode: assertEnum(input.bleedMode, BLEED_MODES, 'bleedConfig.bleedMode'),
    bleedOffsetMm: assertNonNegativeNumber(input.bleedOffsetMm, 'bleedConfig.bleedOffsetMm'),
    offsetToleranceUnderMm: assertNonNegativeNumber(
      input.offsetToleranceUnderMm,
      'bleedConfig.offsetToleranceUnderMm'
    ),
    offsetToleranceOverMm: assertNonNegativeNumber(
      input.offsetToleranceOverMm,
      'bleedConfig.offsetToleranceOverMm'
    ),
  });
}

export function createBleedConfigV1(overrides = {}) {
  return validateBleedConfigV1({ ...DEFAULT_BLEED_CONFIG_V1, ...overrides });
}

// ============================================================================
// Entity Factories & Validators
// ============================================================================

export function validateSourceAssetV1(asset) {
  if (!asset || typeof asset !== 'object') fail('sourceAsset', 'must be an object', asset, 'INVALID_OBJECT');
  assertNoBinaryInState(asset, 'sourceAsset');
  if (asset.schemaVersion !== V1_SCHEMA_VERSION) {
    fail('sourceAsset.schemaVersion', `must be ${V1_SCHEMA_VERSION}`, asset.schemaVersion, 'INVALID_VERSION');
  }
  assertNonEmptyString(asset.assetId, 'sourceAsset.assetId');
  assertNonEmptyString(asset.fileName, 'sourceAsset.fileName');
  assertEnum(asset.sourceType, SOURCE_TYPES, 'sourceAsset.sourceType');
  assertIntegerMin(asset.pageCount, 1, 'sourceAsset.pageCount');
  assertNonEmptyString(asset.resourceId, 'sourceAsset.resourceId');
  assertNonEmptyString(asset.sourceHash, 'sourceAsset.sourceHash');
  assertPositiveSize(asset.pixelSize, 'sourceAsset.pixelSize');
  assertPositiveSize(asset.naturalSizeMm, 'sourceAsset.naturalSizeMm');

  if (!asset.analysis || typeof asset.analysis !== 'object') {
    fail('sourceAsset.analysis', 'must be an object', asset.analysis, 'INVALID_OBJECT');
  }
  assertNonEmptyString(asset.analysis.analysisVersion, 'sourceAsset.analysis.analysisVersion');
  assertEnum(asset.analysis.classification, ASSET_CLASSIFICATIONS, 'sourceAsset.analysis.classification');
  assertBoolean(asset.analysis.hasWhiteBorder, 'sourceAsset.analysis.hasWhiteBorder');
  assertNonNegativeNumber(asset.analysis.estimatedDpi, 'sourceAsset.analysis.estimatedDpi');
  assertRange(asset.analysis.confidence, 0, 1, 'sourceAsset.analysis.confidence');
  if (!Array.isArray(asset.analysis.reasons)) {
    fail('sourceAsset.analysis.reasons', 'must be an array', asset.analysis.reasons, 'INVALID_ARRAY');
  }

  if (!Array.isArray(asset.extractions)) {
    fail('sourceAsset.extractions', 'must be an array', asset.extractions, 'INVALID_ARRAY');
  }
  for (let i = 0; i < asset.extractions.length; i++) {
    const ext = asset.extractions[i];
    assertNonEmptyString(ext.extractionId, `sourceAsset.extractions[${i}].extractionId`);
    assertNonEmptyString(ext.extractorVersion, `sourceAsset.extractions[${i}].extractorVersion`);
    assertEnum(ext.status, EXTRACTION_STATUSES, `sourceAsset.extractions[${i}].status`);
  }
  return asset;
}

export function createSourceAssetV1(input) {
  const asset = {
    schemaVersion: V1_SCHEMA_VERSION,
    assetId: input.assetId ?? createAssetId(),
    fileName: input.fileName,
    sourceType: input.sourceType,
    pageCount: input.pageCount ?? 1,
    resourceId: input.resourceId,
    sourceHash: input.sourceHash,
    pixelSize: input.pixelSize,
    naturalSizeMm: input.naturalSizeMm,
    analysis: {
      analysisVersion: input.analysis?.analysisVersion ?? ANALYSIS_VERSION,
      classification: input.analysis?.classification,
      hasWhiteBorder: input.analysis?.hasWhiteBorder ?? false,
      estimatedDpi: input.analysis?.estimatedDpi,
      confidence: input.analysis?.confidence,
      reasons: Array.isArray(input.analysis?.reasons) ? [...input.analysis.reasons] : [],
      recommendedAction: input.analysis?.recommendedAction,
    },
    extractions: Array.isArray(input.extractions) ? input.extractions.map((e) => ({ ...e })) : [],
  };
  return validateSourceAssetV1(asset);
}

export function validateCanonicalCutV1(cut) {
  if (!cut || typeof cut !== 'object') fail('canonicalCut', 'must be an object', cut, 'INVALID_OBJECT');
  assertNoBinaryInState(cut, 'canonicalCut');
  assertNonEmptyString(cut.cutlineEngineVersion, 'canonicalCut.cutlineEngineVersion');
  assertNonEmptyString(cut.cutInputHash, 'canonicalCut.cutInputHash');
  assertIntegerMin(cut.cutRevision, 1, 'canonicalCut.cutRevision');
  assertPositiveSize(cut.naturalTrimMm, 'canonicalCut.naturalTrimMm');
  if (cut.naturalWhiteBorderMm !== null && cut.naturalWhiteBorderMm !== undefined) {
    assertNonNegativeNumber(cut.naturalWhiteBorderMm, 'canonicalCut.naturalWhiteBorderMm');
  }
  if (!cut.cutNaturalMm || (!Array.isArray(cut.cutNaturalMm) && !Array.isArray(cut.cutNaturalMm.beziersMm))) {
    fail('canonicalCut.cutNaturalMm', 'must be a valid contour object', cut.cutNaturalMm, 'INVALID_CONTOUR');
  }
  return cut;
}

export function createCanonicalCutV1(input) {
  return validateCanonicalCutV1({
    cutlineEngineVersion: input.cutlineEngineVersion ?? CUTLINE_ENGINE_VERSION,
    cutInputHash: input.cutInputHash,
    cutRevision: input.cutRevision ?? 1,
    naturalTrimMm: { w: input.naturalTrimMm?.w, h: input.naturalTrimMm?.h },
    naturalWhiteBorderMm: input.naturalWhiteBorderMm ?? null,
    cutNaturalMm: input.cutNaturalMm,
  });
}

export function validateProductionGeometryCacheV1(geo) {
  if (!geo || typeof geo !== 'object') fail('productionGeometry', 'must be an object', geo, 'INVALID_OBJECT');
  assertNoBinaryInState(geo, 'productionGeometry');
  assertNonEmptyString(geo.productionGeoHash, 'productionGeometry.productionGeoHash');
  assertIntegerMin(geo.productionGeometryRevision, 1, 'productionGeometry.productionGeometryRevision');
  assertPositiveSize(geo.targetSizeMm, 'productionGeometry.targetSizeMm');
  assertPositiveNumber(geo.scaleX, 'productionGeometry.scaleX');
  assertPositiveNumber(geo.scaleY, 'productionGeometry.scaleY');
  if (!geo.cutTargetMm) fail('productionGeometry.cutTargetMm', 'is required', geo.cutTargetMm, 'INVALID_CONTOUR');
  if (![0, 1, 2, 3].includes(geo.bleedTier)) {
    fail('productionGeometry.bleedTier', 'must be 0, 1, 2, or 3', geo.bleedTier, 'INVALID_ENUM');
  }
  if (geo.effectiveWhiteBorderMm !== null && geo.effectiveWhiteBorderMm !== undefined) {
    assertNonNegativeNumber(geo.effectiveWhiteBorderMm, 'productionGeometry.effectiveWhiteBorderMm');
  }
  return geo;
}

export function validateJobValidationV1(val) {
  if (!val || typeof val !== 'object') fail('validation', 'must be an object', val, 'INVALID_OBJECT');
  const gv = val.geometryValidation;
  if (!gv || typeof gv !== 'object') fail('validation.geometryValidation', 'must be an object', gv, 'INVALID_OBJECT');
  assertIntegerMin(gv.productionGeometryRevision, 0, 'validation.geometryValidation.productionGeometryRevision');
  assertBoolean(gv.geometryValid, 'validation.geometryValidation.geometryValid');
  assertBoolean(gv.offsetWithinTolerance, 'validation.geometryValidation.offsetWithinTolerance');
  assertEnum(gv.bleedStatus, ['PASS', 'WARNING', 'FAIL', 'NONE'], 'validation.geometryValidation.bleedStatus');
  assertEnum(
    gv.overClassification,
    ['NONE', 'LOCAL_CORNER_OVER', 'SUSTAINED_OVER'],
    'validation.geometryValidation.overClassification'
  );
  if (!Array.isArray(gv.reasons)) fail('validation.geometryValidation.reasons', 'must be an array', gv.reasons, 'INVALID_ARRAY');

  const rv = val.readinessValidation;
  if (!rv || typeof rv !== 'object') fail('validation.readinessValidation', 'must be an object', rv, 'INVALID_OBJECT');
  assertIntegerMin(rv.evaluatedJobRevision, 0, 'validation.readinessValidation.evaluatedJobRevision');
  assertNonNegativeNumber(rv.effectiveDpi, 'validation.readinessValidation.effectiveDpi');
  assertEnum(rv.dpiStatus, DPI_STATUSES, 'validation.readinessValidation.dpiStatus');
  assertBoolean(rv.nonUniformScale, 'validation.readinessValidation.nonUniformScale');
  assertEnum(rv.status, JOB_STATUSES, 'validation.readinessValidation.status');
  assertBoolean(rv.productionReady, 'validation.readinessValidation.productionReady');
  if (!Array.isArray(rv.reasons)) fail('validation.readinessValidation.reasons', 'must be an array', rv.reasons, 'INVALID_ARRAY');
  return val;
}

export function createInitialJobValidationV1(overrides = {}) {
  return validateJobValidationV1({
    geometryValidation: {
      productionGeometryRevision: 0,
      geometryValid: false,
      offsetWithinTolerance: false,
      bleedStatus: 'NONE',
      overClassification: 'NONE',
      metrics: null,
      reasons: [],
      ...(overrides.geometryValidation || {}),
    },
    readinessValidation: {
      evaluatedJobRevision: 0,
      effectiveDpi: 0,
      dpiStatus: 'FAIL',
      nonUniformScale: false,
      status: 'BLOCKED',
      productionReady: false,
      reasons: [],
      ...(overrides.readinessValidation || {}),
    },
  });
}

export function validateStickerJobV1(job) {
  if (!job || typeof job !== 'object') fail('stickerJob', 'must be an object', job, 'INVALID_OBJECT');
  assertNoBinaryInState(job, 'stickerJob');
  if (job.schemaVersion !== V1_SCHEMA_VERSION) {
    fail('stickerJob.schemaVersion', `must be ${V1_SCHEMA_VERSION}`, job.schemaVersion, 'INVALID_VERSION');
  }
  assertNonEmptyString(job.jobId, 'stickerJob.jobId');
  assertIntegerMin(job.jobRevision, 1, 'stickerJob.jobRevision');
  assertNonEmptyString(job.label, 'stickerJob.label');

  if (!job.origin || typeof job.origin !== 'object') fail('stickerJob.origin', 'must be an object', job.origin, 'INVALID_OBJECT');
  assertNonEmptyString(job.origin.sourceAssetId, 'stickerJob.origin.sourceAssetId');
  assertIntegerMin(job.origin.pageIndex, 1, 'stickerJob.origin.pageIndex');
  if (job.origin.extractionId !== null) assertNonEmptyString(job.origin.extractionId, 'stickerJob.origin.extractionId');
  assertIntegerMin(job.origin.sourceStickerIndex, 1, 'stickerJob.origin.sourceStickerIndex');
  assertValidRegionMm(job.origin.sourceRegionMm, 'stickerJob.origin.sourceRegionMm');

  if (!job.artworkRef || typeof job.artworkRef !== 'object') {
    fail('stickerJob.artworkRef', 'must be an object', job.artworkRef, 'INVALID_OBJECT');
  }
  assertNonEmptyString(job.artworkRef.resourceId, 'stickerJob.artworkRef.resourceId');
  if (job.artworkRef.thumbnailResourceId !== null) {
    assertNonEmptyString(job.artworkRef.thumbnailResourceId, 'stickerJob.artworkRef.thumbnailResourceId');
  }
  if (job.artworkRef.cropBoxMm !== null) {
    assertValidRegionMm(job.artworkRef.cropBoxMm, 'stickerJob.artworkRef.cropBoxMm');
  }

  validateCutConfigV1(job.cutConfig);
  validateBleedConfigV1(job.bleedConfig);
  if (job.canonicalCut !== null) validateCanonicalCutV1(job.canonicalCut);
  if (job.productionGeometry !== null) validateProductionGeometryCacheV1(job.productionGeometry);

  if (!job.order || typeof job.order !== 'object') fail('stickerJob.order', 'must be an object', job.order, 'INVALID_OBJECT');
  assertPositiveSize(job.order.targetSizeMm, 'stickerJob.order.targetSizeMm');
  assertBoolean(job.order.lockAspectRatio, 'stickerJob.order.lockAspectRatio');
  assertIntegerMin(job.order.quantity, 0, 'stickerJob.order.quantity');
  assertBoolean(job.order.allowRotate, 'stickerJob.order.allowRotate');
  assertBoolean(job.order.included, 'stickerJob.order.included');

  validateJobValidationV1(job.validation);
  return job;
}

export function createStickerJobV1(input) {
  const job = {
    schemaVersion: V1_SCHEMA_VERSION,
    jobId: input.jobId ?? createJobId(),
    jobRevision: input.jobRevision ?? 1,
    label: input.label,
    origin: {
      sourceAssetId: input.origin?.sourceAssetId,
      pageIndex: input.origin?.pageIndex ?? 1,
      extractionId: input.origin?.extractionId ?? null,
      sourceStickerIndex: input.origin?.sourceStickerIndex ?? 1,
      sourceRegionMm: input.origin?.sourceRegionMm,
    },
    artworkRef: {
      resourceId: input.artworkRef?.resourceId,
      thumbnailResourceId: input.artworkRef?.thumbnailResourceId ?? null,
      cropBoxMm: input.artworkRef?.cropBoxMm ?? null,
    },
    cutConfig: createCutConfigV1(input.cutConfig || {}),
    bleedConfig: createBleedConfigV1(input.bleedConfig || {}),
    canonicalCut: input.canonicalCut ?? null,
    productionGeometry: input.productionGeometry ?? null,
    order: {
      targetSizeMm: input.order?.targetSizeMm,
      lockAspectRatio: input.order?.lockAspectRatio ?? true,
      quantity: input.order?.quantity ?? 1,
      allowRotate: input.order?.allowRotate ?? true,
      included: input.order?.included ?? true,
    },
    validation: input.validation ? validateJobValidationV1(input.validation) : createInitialJobValidationV1(),
  };
  return validateStickerJobV1(job);
}

/**
 * Immutable update helpers that guarantee jobId and origin never mutate.
 */
export function updateStickerJobOrder(job, orderPatch) {
  validateStickerJobV1(job);
  const nextOrder = { ...job.order, ...orderPatch };
  const targetSizeChanged =
    nextOrder.targetSizeMm?.w !== job.order.targetSizeMm.w ||
    nextOrder.targetSizeMm?.h !== job.order.targetSizeMm.h;
  return validateStickerJobV1({
    ...job,
    jobId: job.jobId,
    origin: job.origin,
    jobRevision: targetSizeChanged ? nextJobRevision(job.jobRevision) : job.jobRevision,
    order: nextOrder,
  });
}

export function validateImpositionPlanV1(plan) {
  if (!plan || typeof plan !== 'object') fail('impositionPlan', 'must be an object', plan, 'INVALID_OBJECT');
  assertNoBinaryInState(plan, 'impositionPlan');
  if (plan.schemaVersion !== V1_SCHEMA_VERSION) {
    fail('impositionPlan.schemaVersion', `must be ${V1_SCHEMA_VERSION}`, plan.schemaVersion, 'INVALID_VERSION');
  }
  assertNonEmptyString(plan.planId, 'impositionPlan.planId');
  assertIntegerMin(plan.planRevision, 1, 'impositionPlan.planRevision');
  assertIntegerMin(plan.totalPlacedCopies, 0, 'impositionPlan.totalPlacedCopies');
  if (!Array.isArray(plan.sheets)) fail('impositionPlan.sheets', 'must be an array', plan.sheets, 'INVALID_ARRAY');
  const seenPlacementIds = new Set();
  for (let s = 0; s < plan.sheets.length; s++) {
    const sh = plan.sheets[s];
    assertIntegerMin(sh.sheetIndex, 1, `impositionPlan.sheets[${s}].sheetIndex`);
    if (!Array.isArray(sh.placements)) {
      fail(`impositionPlan.sheets[${s}].placements`, 'must be an array', sh.placements, 'INVALID_ARRAY');
    }
    for (let p = 0; p < sh.placements.length; p++) {
      const pl = sh.placements[p];
      assertNonEmptyString(pl.placementId, `sheets[${s}].placements[${p}].placementId`);
      if (seenPlacementIds.has(pl.placementId)) {
        fail(`sheets[${s}].placements[${p}].placementId`, `duplicate placementId "${pl.placementId}"`, pl.placementId, 'DUPLICATE_PLACEMENT_ID');
      }
      seenPlacementIds.add(pl.placementId);
      assertNonEmptyString(pl.jobId, `sheets[${s}].placements[${p}].jobId`);
      assertIntegerMin(pl.copyIndex, 1, `sheets[${s}].placements[${p}].copyIndex`);
      assertIntegerMin(pl.jobRevision, 1, `sheets[${s}].placements[${p}].jobRevision`);
      assertIntegerMin(pl.cutRevision, 1, `sheets[${s}].placements[${p}].cutRevision`);
      assertIntegerMin(pl.productionGeometryRevision, 1, `sheets[${s}].placements[${p}].productionGeometryRevision`);
      assertPositiveSize(pl.targetSizeMm, `sheets[${s}].placements[${p}].targetSizeMm`);
      assertEnum(pl.rotationDeg, ALLOWED_ROTATIONS, `sheets[${s}].placements[${p}].rotationDeg`);
      if (!Array.isArray(pl.rigidMatrixMm) || pl.rigidMatrixMm.length !== 6 || pl.rigidMatrixMm.some((v) => !Number.isFinite(v))) {
        fail(`sheets[${s}].placements[${p}].rigidMatrixMm`, 'must be a 6-element finite affine matrix', pl.rigidMatrixMm, 'INVALID_MATRIX');
      }
    }
  }
  return plan;
}

export function validateProductionOutputV1(output) {
  if (!output || typeof output !== 'object') fail('productionOutput', 'must be an object', output, 'INVALID_OBJECT');
  assertNoBinaryInState(output, 'productionOutput');
  if (output.schemaVersion !== V1_SCHEMA_VERSION) {
    fail('productionOutput.schemaVersion', `must be ${V1_SCHEMA_VERSION}`, output.schemaVersion, 'INVALID_VERSION');
  }
  assertNonEmptyString(output.outputId, 'productionOutput.outputId');
  assertNonEmptyString(output.planId, 'productionOutput.planId');
  assertIntegerMin(output.planRevision, 1, 'productionOutput.planRevision');
  assertNonEmptyString(output.validatorVersion, 'productionOutput.validatorVersion');
  assertNonEmptyString(output.printPdf?.resourceId, 'productionOutput.printPdf.resourceId');
  assertNonEmptyString(output.cutPdf?.resourceId, 'productionOutput.cutPdf.resourceId');
  assertBoolean(output.finalCheck?.productionReady, 'productionOutput.finalCheck.productionReady');
  return output;
}
