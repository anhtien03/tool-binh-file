/**
 * PrintKit Architecture V1 — ResourceStore & Temp Canvas Lifecycle (Checkpoint B)
 *
 * Manages all binary resources (Blob, File, Uint8Array, ArrayBuffer, ObjectURL)
 * outside App/React state so V1 state objects remain pure JSON + resourceId strings.
 *
 * Key invariants:
 *  - Full SHA-256 content deduplication (never trusts short prefix alone).
 *  - Deterministic refCount >= 0 (double-release and unknown IDs throw explicitly).
 *  - Lazy ObjectURL creation with automatic URL.revokeObjectURL on refCount === 0.
 *  - No mutable internal entries or Blob references exposed in metadata snapshots.
 *  - Temporary canvases are never stored; withTempCanvas() guarantees finally cleanup.
 */

export const RESOURCE_KINDS = Object.freeze([
  'source_file',
  'extracted_png',
  'thumbnail',
  'pdf_output',
]);

const VALID_KINDS = new Set(RESOURCE_KINDS);

export const TEMP_CANVAS_LIMITS = Object.freeze({
  maxEdgePx: 16384,
  maxTotalPixels: 64_000_000,
});

function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

async function defaultHashBytes(uint8) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new Error('ResourceStore: Web Crypto SHA-256 (crypto.subtle.digest) is unavailable in this environment');
  }
  // Pass exact slice only if view is a subrange of a larger ArrayBuffer
  const digestInput =
    uint8.byteOffset === 0 && uint8.byteLength === uint8.buffer.byteLength
      ? uint8.buffer
      : uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
  const hashBuf = await subtle.digest('SHA-256', digestInput);
  return bytesToHex(new Uint8Array(hashBuf));
}

function defaultCreateObjectURL(blob) {
  if (typeof globalThis.URL?.createObjectURL !== 'function') {
    throw new Error('ResourceStore: URL.createObjectURL is unavailable in this environment');
  }
  return globalThis.URL.createObjectURL(blob);
}

function defaultRevokeObjectURL(url) {
  if (typeof globalThis.URL?.revokeObjectURL === 'function') {
    globalThis.URL.revokeObjectURL(url);
  }
}

function defaultCanvasFactory() {
  if (typeof globalThis.document?.createElement !== 'function') {
    throw new Error('withTempCanvas: document.createElement is unavailable in this environment');
  }
  return globalThis.document.createElement('canvas');
}

function isBlobLike(input) {
  return typeof Blob !== 'undefined' && input instanceof Blob;
}

function isArrayBufferLike(input) {
  return input instanceof ArrayBuffer;
}

function isUint8ArrayLike(input) {
  return input instanceof Uint8Array;
}

/**
 * Normalize input into { blob, hashBytesView, byteLength, mimeType } without retaining
 * extra long-lived copies. The caller drops hashBytesView immediately after hashing.
 */
async function normalizeBinaryInput(input, explicitMimeType) {
  if (input === null || input === undefined) {
    throw new TypeError('ResourceStore: binary input is required (Blob, File, Uint8Array, or ArrayBuffer)');
  }

  if (isBlobLike(input)) {
    const mimeType = explicitMimeType || input.type || 'application/octet-stream';
    const tmpBuf = await input.arrayBuffer();
    const hashView = new Uint8Array(tmpBuf);
    // Keep the original Blob as the single canonical binary representation
    return {
      blob: input,
      hashView,
      byteLength: input.size,
      mimeType,
    };
  }

  if (isUint8ArrayLike(input)) {
    const mimeType = explicitMimeType || 'application/octet-stream';
    // Create one canonical Blob copy; do not mutate input and do not retain input reference
    const blob = new Blob([input], { type: mimeType });
    return {
      blob,
      hashView: input,
      byteLength: input.byteLength,
      mimeType,
    };
  }

  if (isArrayBufferLike(input)) {
    const mimeType = explicitMimeType || 'application/octet-stream';
    const hashView = new Uint8Array(input);
    const blob = new Blob([hashView], { type: mimeType });
    return {
      blob,
      hashView,
      byteLength: input.byteLength,
      mimeType,
    };
  }

  throw new TypeError('ResourceStore: unsupported binary input type (expected Blob, File, Uint8Array, or ArrayBuffer)');
}

function makeMetadataSnapshot(entry) {
  return Object.freeze({
    resourceId: entry.resourceId,
    kind: entry.kind,
    mimeType: entry.mimeType,
    byteLength: entry.byteLength,
    sha256: entry.sha256,
    ephemeral: entry.ephemeral,
    refCount: entry.refCount,
  });
}

/**
 * Guaranteed temporary canvas lifecycle helper.
 * Never registers the canvas in ResourceStore; always resets width/height to 0 in finally.
 */
export async function withTempCanvas(width, height, callback, options = {}) {
  if (typeof callback !== 'function') {
    throw new TypeError('withTempCanvas: callback must be a function');
  }
  const maxEdgePx = Number.isFinite(Number(options.maxEdgePx))
    ? Math.max(1, Number(options.maxEdgePx))
    : TEMP_CANVAS_LIMITS.maxEdgePx;
  const maxTotalPixels = Number.isFinite(Number(options.maxTotalPixels))
    ? Math.max(1, Number(options.maxTotalPixels))
    : TEMP_CANVAS_LIMITS.maxTotalPixels;

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new RangeError(`withTempCanvas: invalid dimensions (${width}x${height}); must be finite numbers > 0`);
  }
  const w = Math.ceil(width);
  const h = Math.ceil(height);
  if (w > maxEdgePx || h > maxEdgePx) {
    throw new RangeError(`withTempCanvas: dimension (${w}x${h}) exceeds safe edge limit (${maxEdgePx}px)`);
  }
  if (w * h > maxTotalPixels) {
    throw new RangeError(`withTempCanvas: total pixels (${w * h}) exceeds safe limit (${maxTotalPixels})`);
  }

  const factory = typeof options.canvasFactory === 'function' ? options.canvasFactory : defaultCanvasFactory;
  const canvas = factory();
  canvas.width = w;
  canvas.height = h;
  try {
    const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    return await callback(canvas, ctx);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Create an isolated ResourceStore instance (supports DI for deterministic testing).
 */
export function createResourceStore(deps = {}) {
  const hashBytes = typeof deps.hashBytes === 'function' ? deps.hashBytes : defaultHashBytes;
  const createUrlFn = typeof deps.createObjectURL === 'function' ? deps.createObjectURL : defaultCreateObjectURL;
  const revokeUrlFn = typeof deps.revokeObjectURL === 'function' ? deps.revokeObjectURL : defaultRevokeObjectURL;

  /** @type {Map<string, object>} resourceId -> internal entry */
  const entries = new Map();
  /** @type {Map<string, string>} full 64-char sha256 -> resourceId */
  const sha256ToId = new Map();

  function assertExistingEntry(resourceId, opName) {
    if (typeof resourceId !== 'string' || resourceId.length === 0) {
      throw new ReferenceError(`ResourceStore.${opName}: invalid resourceId`);
    }
    const entry = entries.get(resourceId);
    if (!entry) {
      throw new ReferenceError(`ResourceStore.${opName}: unknown or already-released resourceId "${resourceId}"`);
    }
    return entry;
  }

  function allocateDeterministicId(fullSha256) {
    // Primary readable deterministic ID from first 12 hex chars, verified against full SHA-256
    let candidate = `RES-${fullSha256.slice(0, 12)}`;
    const existing = entries.get(candidate);
    if (!existing || existing.sha256 === fullSha256) {
      return candidate;
    }
    // Prefix collision safeguard: expand prefix length until unique
    for (let len = 16; len <= fullSha256.length; len += 4) {
      candidate = `RES-${fullSha256.slice(0, len)}`;
      const hit = entries.get(candidate);
      if (!hit || hit.sha256 === fullSha256) return candidate;
    }
    let suffix = 1;
    while (entries.has(`RES-${fullSha256}-${suffix}`)) suffix++;
    return `RES-${fullSha256}-${suffix}`;
  }

  /**
   * Store or deduplicate a binary resource and increment its refCount by +1.
   * Returns a frozen JSON-safe metadata snapshot (never exposes Blob or internal entry).
   */
  async function acquire(input, options = {}) {
    const kind = options.kind;
    if (!VALID_KINDS.has(kind)) {
      throw new TypeError(`ResourceStore.acquire: invalid kind "${kind}" (expected one of: ${RESOURCE_KINDS.join(', ')})`);
    }
    const ephemeral = Boolean(options.ephemeral);
    const normalized = await normalizeBinaryInput(input, options.mimeType);
    let sha256;
    try {
      sha256 = String(await hashBytes(normalized.hashView)).toLowerCase();
    } finally {
      // Explicitly drop temporary hash view reference immediately after digest
      normalized.hashView = null;
    }

    if (!sha256 || sha256.length < 16) {
      throw new Error('ResourceStore.acquire: hashBytes returned an invalid SHA-256 digest');
    }

    // Deduplicate strictly by FULL SHA-256
    const existingId = sha256ToId.get(sha256);
    if (existingId && entries.has(existingId)) {
      const existing = entries.get(existingId);
      existing.refCount += 1;
      // If any active holder marks the resource non-ephemeral, keep it non-ephemeral
      if (!ephemeral && existing.ephemeral) {
        existing.ephemeral = false;
      }
      return makeMetadataSnapshot(existing);
    }

    const resourceId = allocateDeterministicId(sha256);
    const entry = {
      resourceId,
      kind,
      mimeType: normalized.mimeType,
      byteLength: normalized.byteLength,
      sha256,
      ephemeral,
      refCount: 1,
      blob: normalized.blob,
      objectUrl: null,
    };
    entries.set(resourceId, entry);
    sha256ToId.set(sha256, resourceId);
    return makeMetadataSnapshot(entry);
  }

  /**
   * Increment refCount of an existing resource by +1.
   */
  function retain(resourceId) {
    const entry = assertExistingEntry(resourceId, 'retain');
    entry.refCount += 1;
    return makeMetadataSnapshot(entry);
  }

  /**
   * Decrement refCount by -1. When refCount reaches 0, revokes ObjectURL and deletes Blob/entry.
   * Throws ReferenceError on unknown ID or double release (refCount never goes negative).
   */
  function release(resourceId) {
    const entry = assertExistingEntry(resourceId, 'release');
    if (entry.refCount <= 0) {
      throw new RangeError(`ResourceStore.release: refCount underflow detected for "${resourceId}"`);
    }
    entry.refCount -= 1;
    if (entry.refCount === 0) {
      if (entry.objectUrl !== null) {
        try {
          revokeUrlFn(entry.objectUrl);
        } finally {
          entry.objectUrl = null;
        }
      }
      entry.blob = null;
      entries.delete(resourceId);
      if (sha256ToId.get(entry.sha256) === resourceId) {
        sha256ToId.delete(entry.sha256);
      }
      return Object.freeze({ resourceId, refCount: 0, released: true });
    }
    return Object.freeze({ resourceId, refCount: entry.refCount, released: false });
  }

  /**
   * Return a frozen JSON-safe metadata snapshot, or null if not present.
   */
  function getMetadata(resourceId) {
    if (typeof resourceId !== 'string') return null;
    const entry = entries.get(resourceId);
    return entry ? makeMetadataSnapshot(entry) : null;
  }

  function has(resourceId) {
    return typeof resourceId === 'string' && entries.has(resourceId);
  }

  /**
   * Intentional binary access (never placed in App/React state).
   */
  function getBlob(resourceId) {
    const entry = assertExistingEntry(resourceId, 'getBlob');
    return entry.blob;
  }

  /**
   * Lazily create or reuse ObjectURL for an active resource.
   */
  function getObjectUrl(resourceId) {
    const entry = assertExistingEntry(resourceId, 'getObjectUrl');
    if (entry.objectUrl === null) {
      entry.objectUrl = createUrlFn(entry.blob);
    }
    return entry.objectUrl;
  }

  /**
   * Revoke the active ObjectURL while keeping the underlying Blob/resource retained.
   * A subsequent getObjectUrl() will lazily create a new URL.
   */
  function revokeObjectUrl(resourceId) {
    const entry = assertExistingEntry(resourceId, 'revokeObjectUrl');
    if (entry.objectUrl !== null) {
      const url = entry.objectUrl;
      entry.objectUrl = null;
      revokeUrlFn(url);
      return true;
    }
    return false;
  }

  /**
   * Deterministic replacement helper (e.g. pdf_output re-export):
   * acquires new resource first, then releases previousResourceId if provided.
   */
  async function replace(previousResourceId, newInput, options = {}) {
    const nextMeta = await acquire(newInput, options);
    if (previousResourceId) {
      release(previousResourceId);
    }
    return nextMeta;
  }

  /**
   * Read-only diagnostic statistics (never exposes internal Map or Blobs).
   */
  function getStats() {
    let totalBytes = 0;
    let liveObjectUrlCount = 0;
    let totalRefCount = 0;
    let ephemeralCount = 0;
    for (const entry of entries.values()) {
      totalBytes += entry.byteLength;
      if (entry.objectUrl !== null) liveObjectUrlCount++;
      totalRefCount += entry.refCount;
      if (entry.ephemeral) ephemeralCount++;
    }
    return Object.freeze({
      entryCount: entries.size,
      totalBytes,
      liveObjectUrlCount,
      totalRefCount,
      ephemeralCount,
    });
  }

  /**
   * Force-revoke all live ObjectURLs and release all entries (teardown/cleanup).
   */
  function dispose() {
    for (const entry of entries.values()) {
      if (entry.objectUrl !== null) {
        try {
          revokeUrlFn(entry.objectUrl);
        } finally {
          entry.objectUrl = null;
        }
      }
      entry.blob = null;
      entry.refCount = 0;
    }
    entries.clear();
    sha256ToId.clear();
  }

  return Object.freeze({
    acquire,
    retain,
    release,
    replace,
    getMetadata,
    has,
    getBlob,
    getObjectUrl,
    revokeObjectUrl,
    getStats,
    dispose,
    withTempCanvas,
  });
}
