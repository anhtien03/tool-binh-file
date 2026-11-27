# CHECKPOINT G — FINAL PRODUCTION VALIDATION + PAIR INTEGRITY + FAULT INJECTION + PRODUCTION STRESS (✅ PASS)

> **Status:** `32/32 PASSED` (`0` failed) | **Regression B–F.1:** `ALL PASSED` | **Vite Build:** `✓ built in 2.96s`
> **Locked Files Modified:** `0 / 14` (`bleedContourEngine.js`, `pdfProductionValidator.js`, `resourceStore.js`, `v1Schema.js`, `assetAnalyzer.js`, `cutlineV1Adapter.js`, `productionGeometry.js`, `batchJobOrchestrator.js`, `batchImpositionAdapter.js`, `cutVectorExporter.js`, `productionOutput.js`, `openWithAdapter.js`, `impositionEngine.js`, `pdfExporter.js` đều nguyên vẹn).
> **Measurement Honesty:** Toàn bộ sai số căn chỉnh báo cáo là **`SERIALIZED_GEOMETRY_DELTA`** (đọc ngược toán tử vector/CTM từ bytes `PRINT.pdf`, `CUT.pdf`, `CUT.svg`), **không** tuyên bố sai số cắt cơ khí thực tế của máy cắt.

---

## A. Files Created

- `resources/js/engine/productionPairValidator.js` — Đọc & kiểm chéo bytes thực tế của `PRINT.pdf`, `CUT.pdf`, `CUT.svg` với `ImpositionPlanV1`, `CutMasterV1`, `Manifest` và `productionObjects`.
- `resources/js/engine/finalProductionValidator.js` — Gate 2 Final Production Check: gói `assertPlanFreshness()`, kiểm toàn vẹn `ResourceStore` + SHA-256, gọi trực tiếp LOCKED 3.1.3 `validateProductionPdf()` trên từng trang thực tế, chạy `validateProductionPair()` + `validateCutSvgAgainstMaster()`, và quyết định `PASS | WARNING | BLOCK`.
- `scratch/test_v1_checkpoint_g.mjs` — Bộ test tự động 32 ca (`G1–G24`, `FI1–FI5`, `PDF1–PDF8`, `Fish-13`, `Stress-200`, `Determinism`, `Locked File Audit`).

---

## B. Final Validator API

- Entry point: `finalProductionCheck({ plan, jobs, output, resourceStore, sheetConfig?, productionProfile?, overridePrintBytes?, overrideCutBytes?, cutSvgBytes?, productionObjects? })`
- Output JSON-safe (`assertNoBinaryInState` kiểm chứng không rò rỉ binary):
  - `{ productionReady, status: 'PASS' | 'WARNING' | 'BLOCK', print, cut, pair, svgCheck, resources, errors, warnings, metrics: { expectedPlacements, printPlacements, cutPlacements, maxSerializedAlignmentDeltaMm, measurementType: 'SERIALIZED_GEOMETRY_DELTA' } }`
- Không tạo geometry mới, không sửa CUT/BLEED, không bình tem lại, không sửa PRINT mapping.

---

## C. 3.1.3 Wrapper (`pdfProductionValidator.js` 🔒)

- Không chỉnh sửa hay sao chép lại logic `pdfProductionValidator.js`.
- `runLocked313OnAllPages()` tách từng trang PDF thành 1-page slice khi `pages.length > 1` rồi gọi trực tiếp `validateProductionPdf(singlePageBytes, { mode: 'sheet', expectedStickerCount, expectedSheetWidthMm, expectedSheetHeightMm, expectArtwork, expectBleed: false, dimToleranceMm: 0.05 })`.
- `PRINT.pdf`: `expectArtwork: true, isCutRole: false`.
- `CUT.pdf`: `expectArtwork: scope === 'CUT_PLUS_PRINT', isCutRole: true` (kiểm đủ số đường Magenta CUT khép kín, 4-Box, vector bounds).

---

## D. Actual PDF Validation

- Kiểm chứng trên bytes PDF thật lấy từ `ResourceStore` (sau `doc.save()`), giải mã FlateDecode stream bằng `pdf-lib`:
  - `inspectSerializedCutPage(page)`: phân tích `0 1 0 0 K` + `m/l/c/S|s` (tọa độ sheet-mm Y-down), đếm `XObject` (phát hiện raster lọt vào `CUT_ONLY`), đọc ô mark đen (`0 0 0 1 k` / `0 0 0 rg` + `cm` + `m/l/.../f` hoặc `re`).
  - `inspectSerializedPrintPage(page)`: phân tích clip-path bounds, CTM `cm`, toán tử vẽ `Do`, `XObject`, và mark đen.

---

## E. Pair Integrity (`PRINT.pdf` ↔ `CUT.pdf` ↔ `Manifest` ↔ `CutMaster`)

- Kiểm đủ 6 trục:
  1. `pageCountMatch` (`PAIR_PAGE_MISMATCH`)
  2. `pageSizesMatch` (`PAIR_PAGE_SIZE_MISMATCH`, tolerance `<= 0.015 mm`)
  3. `pageOrderMatch` (`PAIR_PAGE_ORDER_MISMATCH` khi trang CUT khớp layout của tờ khác)
  4. `placementCompleteness` (`MISSING_CUT_PLACEMENT`, `DUPLICATE_CUT_PLACEMENT`, `MISSING_PRINT_PLACEMENT`, `DUPLICATE_PRINT_PLACEMENT`, `CUT_VECTOR_MISSING`)
  5. `alignmentPassed` (`PAIR_ALIGNMENT_MISMATCH`)
  6. `marksPassed` (`MARKS_MISMATCH`)
- Extension point `productionObjects`: danh sách V1 chỉ chấp nhận `KNOWN_PRODUCTION_OBJECTS = ['registrationMarks']`; mọi object lạ (ví dụ `paperGuides`) bị chặn rõ bằng `UNSUPPORTED_PRODUCTION_OBJECT`.

---

## F. Serialized Alignment (`SERIALIZED_GEOMETRY_DELTA`)

- So sánh trực tiếp tọa độ vector Magenta giải mã từ `CUT.pdf` với `CutMasterV1` và đối chiếu `PRINT.pdf` clip-path bao trùm đúng từng đường CUT:
  - `0° / 90° / 180° / 270°` (`G8`): **`maxDelta = 0.0000 mm`** (`<= 0.01 mm`)
  - `50% / 100% / 200%` (`G9`): **`maxDelta = 0.0000 mm`** (`<= 0.01 mm`)
  - `Fish-13`: **`maxDelta = 0.0000 mm`** (`<= 0.01 mm`)
  - `Stress-200` (10 sheets, 401 copies): **`maxDelta = 0.0000 mm`** (`<= 0.01 mm`)

---

## G. Registration Marks

- `PRODUCTION_PROFILES.GENERIC` (`G6`): xác minh đúng 4 dấu góc trên cả `PRINT.pdf` và `CUT.pdf` (vị trí `xMm, yMm` và kích thước `sizeMm` sai số `<= 0.02 mm`). Giữ trung thực `GENERIC != GRAPHTEC / CAMERACUT`.
- `PRODUCTION_PROFILES.NONE` (`G10`): xác minh đúng **`0` marks** trên cả `PRINT.pdf` và `CUT.pdf`.

---

## H. Resource Integrity & Stale Plan Guard

- `STALE_PLAN` (`G13`): sửa `quantity` của job sau khi lập plan → `assertPlanFreshness()` chặn ngay với `status: 'BLOCK', productionReady: false, code: 'STALE_PLAN'`.
- `MISSING_RESOURCE` (`G14`): `resourceId` không tồn tại trong `ResourceStore` → `BLOCK` với `MISSING_RESOURCE`.
- `RESOURCE_HASH_MISMATCH` (`PDF8/G15`): can thiệp 1 byte sau khi tính SHA-256 → `BLOCK` với `RESOURCE_HASH_MISMATCH`.

---

## I. CUT SVG Cross-Format Validation (`G23`)

- `validateCutSvgAgainstMaster()` đọc bytes thực tế của `CUT.svg`: kiểm `<svg>`, `width`/`height` mm, `viewBox`, cấm `NaN`/`Infinity`, cấm `<image>` khi `CUT_ONLY`, đếm số `<path>`, và đối chiếu bounds từng `<path>` với `CutMasterV1`.
- Kết quả `G23`: `paths = 4`, `maxDeltaMm = 0 mm` (`<= 0.01 mm`), `PASS`.
- Định dạng `AI`: giữ nguyên `FORMAT_NOT_SUPPORTED` (không giả lập).

---

## J. Fault Injection — 3.1.2 Real (`FI1–FI5` trên file 13 con cá)

Chạy trực tiếp `extractStickerContoursFromImage()` với `options.__faultInjector` thật trên `media_1795511405721_32f2a004.pdf` (`330 × 390 mm`, 13 tem):

| Case | Kịch bản tiêm lỗi thật | Kết quả thực tế |
|---|---|---|
| `FI1` | Tier 1 fail trên Tem `#5` | Tier 2 được gọi (`method=polygon-offset-fallback`), 12 tem còn lại giữ nguyên status/method (`PASS`) |
| `FI2` | Tier 1 + Tier 2 fail trên Tem `#5` | Tạo đúng Tier 3 sentinel thật (`tier=3, status='FAIL', bleedContoursMm[4].invalid=true`) (`PASS`) |
| `FI3` | Có 1 tem rơi xuống Tier 3 | `validation.productionReady === false`, `failCount === 1` (`PASS`) |
| `FI4` | Cô lập lỗi 1 tem | `12/13` tem còn lại vẫn hợp lệ (`PASS`/`WARNING`) (`PASS`) |
| `FI5` | Bảo toàn đồng bộ chỉ mục CUT/BLEED | `contoursMm.length === 13`, `bleedContoursMm.length === 13`, index `#4` là invalid sentinel, `#6..#13` không lệch (`PASS`) |

---

## K. Corrupted PDF Fault Injection (`PDF1–PDF8`)

| Case | Lỗi tiêm vào artifact PDF thực tế | Quyết định | Error Code trả về |
|---|---|---|---|
| `PDF1/G16` | Xóa 1 đường CUT Magenta khỏi `CUT.pdf` | `BLOCK` | `MISSING_CUT_PLACEMENT` |
| `PDF2/G17` | Xóa 1 lệnh vẽ ảnh `Do` khỏi `PRINT.pdf` | `BLOCK` | `MISSING_PRINT_PLACEMENT` |
| `PDF3/G18` | Tăng `MediaBox` của `CUT.pdf` thêm `+1.0 mm` | `BLOCK` | `PAIR_PAGE_SIZE_MISMATCH` |
| `PDF4/G19` | Dịch chuyển 1 đường CUT `+0.5 mm` trục X | `BLOCK` | `PAIR_ALIGNMENT_MISMATCH` (`delta=0.5 mm`) |
| `PDF5/G20` | Nhân bản thêm 1 đường CUT trong `CUT.pdf` | `BLOCK` | `DUPLICATE_CUT_PLACEMENT` |
| `PDF6/G21` | Hoán đổi thứ tự trang `CUT.pdf` (multi-sheet) | `BLOCK` | `PAIR_PAGE_ORDER_MISMATCH` (`PDF6-EXACT`) / placement mismatch |
| `PDF7/G22` | Thay `CUT.pdf` bằng ảnh raster PNG (xóa vector CUT) | `BLOCK` | `CUT_VECTOR_MISSING` |
| `PDF8/G15` | Sửa đổi 1 byte sau khi lưu SHA-256 | `BLOCK` | `RESOURCE_HASH_MISMATCH` |

---

## L. 13-Tem Fish Final Production Test (`FISH-13`)

- Đầu vào: PDF thật 13 con cá (`330 × 390 mm`, `bleedOffsetMm = 1.5 mm`, `offsetMm = 0.5 mm`, `mergeGapMm = 2.5 mm`).
- Kết quả end-to-end qua toàn pipeline V1 (`C → D → F → G`):
  - `13` jobs (`4 READY` + `9 WARNING` do `LOCAL_CORNER_OVER` từ 3.1.2).
  - `expectedPlacements = 13`, `printPlacements = 13`, `cutPlacements = 13` (`0` silent loss).
  - `maxSerializedAlignmentDeltaMm = 0 mm`.
  - Quyết định cuối: **`status = 'WARNING', productionReady = true`** (bảo toàn đầy đủ cảnh báo non-blocking, không tự hạ thành `PASS` ảo và không chặn oan).

---

## M. Multi-Sheet & 200-Job Production Stress (`STRESS-200`)

- Cấu hình: `200` distinct `StickerJobV1` (`100` job có Precision BLEED `1.5 mm` + `100` job `bleed=0`), tổng **`401` copies**, bình trên **`10` tờ** (`320 × 450 mm`, `allowRotate = true`, `GENERIC` marks).
- Kết quả:
  - Toàn bộ `10/10` tờ qua LOCKED 3.1.3 + `validateProductionPair()` không lỗi (`status = 'PASS'`, `errors = 0`).
  - `expected = 401`, `print = 401`, `cut = 401`, `maxSerializedAlignmentDeltaMm = 0 mm`.
  - Chạy `finalProductionCheck()` 2 lần liên tiếp cho kết quả JSON **byte-identical** (`determinism = PASS`).
  - Tổng thời gian chạy toàn chu trình (tạo 200 job + bình 10 tờ + xuất PRINT/CUT PDF + chạy 2 lần Final Check): **`5,535 ms`**.

---

## N. Final Decision Matrix

| Điều kiện | `status` | `productionReady` |
|---|---|---|
| `errors.length === 0 && warnings.length === 0` | `PASS` | `true` |
| `errors.length === 0 && warnings.length > 0` (vd `LOCAL_CORNER_OVER`) | `WARNING` | `true` |
| `errors.length > 0` (`STALE_PLAN`, `MISSING_RESOURCE`, `RESOURCE_HASH_MISMATCH`, `PDF_313_ERROR`, `PAIR_*`, `MISSING_*`, `DUPLICATE_*`, `CUT_VECTOR_MISSING`, `MARKS_MISMATCH`, `UNSUPPORTED_PRODUCTION_OBJECT`) | `BLOCK` | `false` |

---

## O. Tests & Build Verification

- **Checkpoint G (`test_v1_checkpoint_g.mjs`):** `32/32 PASSED` (`0` failed)
- **Full Regression B–F.1:**
  - `B`: `12/12 PASSED`
  - `C`: `20/20 PASSED`
  - `C.1`: `PASS`
  - `D`: `19/19 PASSED`
  - `E`: `20/20 PASSED`
  - `F`: `27/27 PASSED`
  - `F.1`: `ALL PASSED` (`0.000000 mm`)
- **Vite Production Build:** `npm --prefix tool-binh-file run build` → `✓ 211 modules transformed`, `✓ built in 2.96s` (`0` errors).

---

## P. Deviations / Conflicts

- **Không có `ARCHITECTURE_CONFLICT`.**
- **Không sửa bất kỳ file LOCKED nào (`0/14`).**
- **Không triển khai các hạng mục ngoài phạm vi V1:** chưa làm UI (`BatchStudio.jsx`), chưa làm `Graphtec`/`CameraCut`, chưa làm `Paper Guides`, chưa làm `AI` native writer (`FORMAT_NOT_SUPPORTED`).
- **Sẵn sàng khóa `CORE PRODUCTION V1` khi được duyệt.**

---

# Checkpoint H.1 — Additive Production Planning Foundation (Integrated)

> **Schema Version:** `H1.1` (`H1_PLANNING_VERSION`) | **Mode:** Pure, additive (physical millimetres)
> **Locked Files Modified:** `0` — Zero edits to any locked B–G engine or UI file (`bleedContourEngine.js`, `pdfProductionValidator.js`, `resourceStore.js`, `v1Schema.js`, `assetAnalyzer.js`, `cutlineV1Adapter.js`, `productionGeometry.js`, `batchJobOrchestrator.js`, `batchImpositionAdapter.js`, `cutVectorExporter.js`, `productionOutput.js`, `openWithAdapter.js`, `productionPairValidator.js`, `finalProductionValidator.js`, `impositionEngine.js`, `pdfExporter.js`, `resources/js/components/*.jsx`).

## Files Added

- `resources/js/engine/productionPlanningH1.js` — Pure additive production planning module (`H1.1`): spacing policy normalization, sheet template normalization, quantity ledger planning (`copiesPerRun × runCount`), and conservative rectangular grid capacity estimation.
- `tests/productionPlanningH1.test.mjs` — Standalone unit test suite (`node --test`) verifying H1.1 spacing policies, template validation, quantity ledger accounting, overflow/duplicate guards, and grid capacity estimation.

## H1.1 Schema & Boundaries

- **Exports:** `H1_PLANNING_VERSION`, `ProductionPlanningError`, `normalizeSpacingPolicy()`, `normalizeSheetTemplate()`, `buildProductionRunPlan()`, `estimateUniformGridCapacity()`.
- **Spacing Policy:** Separates CUT gap (`cutGapMm`) from BLEED clearance (`bleedOutsetMm`, `bleedClearanceMm`, `bleedPolicy: 'allow_overlap' | 'enforce_clearance'`). `allow_overlap` never relaxes `cutGapMm`; `enforce_clearance` enforces `max(cutGapMm, 2 * bleedOutsetMm + bleedClearanceMm)`. Always marks `needsContourValidation: true`.
- **Quantity Ledger (`buildProductionRunPlan`):** Pure template-level aggregation (`copiesPerRun * runCount`) against an explicit `jobs` catalog without expanding individual placements. Reports per-job `EXACT | SHORT | EXCESS` and plan-level `QUANTITY_MATCH | QUANTITY_MISMATCH` with safe-integer overflow protection.
- **Grid Capacity (`estimateUniformGridCapacity`):** Conservative rectangular bounding-box estimate (`method: 'RECTANGULAR_GRID_ESTIMATE'`, optional `90°` rotation); not a contour nesting guarantee.
- **Explicit Non-Claims / Boundaries:** Does **not** emit `ImpositionPlanV1`, does **not** perform geometric/contour validation or PDF/CUT output checks, and explicitly sets `geometryValidated: false`, `outputValidated: false`, `machineVerified: false`.



---

# CHECKPOINT H.2 — PRODUCTION PLANNING INTEGRATION + GRID PACKING (✅ H.2 PASS)

> **Status:** `H2-01..H2-17 PASS` + **L0110.063 Real Vector Fixture Cross-Check (`<= 0.01 mm`)** | **Regression H.1 + B–G:** `ALL PASSED` | **Vite Build:** `✓ built in 2.78s`
> **Locked Files Modified:** `0 / 17` (toàn bộ SHA-256 trước & sau trùng khớp 100%).
> **Measurement Honesty:** Mọi sai số căn chỉnh trên bytes xuất là **`SERIALIZED_GEOMETRY_DELTA`** (không tuyên bố `0 mm` sai số cắt cơ khí).

## 1. Files Created (Additive — 0 Locked Files Modified)
- `resources/js/engine/gridPackingH2.js` — Bộ xếp lưới 2D xác định đơn vị mm (`rows`, `columns`, `pitchXmm`, `pitchYmm`, `originXmm`, `originYmm`, `centerX`, `centerY`, `allowRotate`, partial grid, multi-SKU deterministic order, safe area, `GRID_CAPACITY_EXCEEDED`, dùng chung `buildRigidMatrixMm`/`isRigidMatrixMm`).
- `resources/js/engine/productionPlanValidatorH2.js` — Kiểm định hình học contour thực tế (`exactPolygonDistanceMm` trên `beziersMm` đã biến đổi, không chỉ bbox): `CUT_COLLISION`, `BLEED_STRICT_VIOLATION`, `BLEED_OVERLAP_UNVERIFIED`, và `assertBatchFreshnessH2()` chặn `STALE_PLAN` khi thay đổi job, template hoặc `runCount`.
- `resources/js/engine/productionPlanningAdapterH2.js` — Cầu nối `H.1 → Grid Packing → ONE Shared ImpositionPlanV1` (`SheetTemplate × RunCount` không nhân bản placement, `updateBatchRunCountsH2`, `expandPhysicalSheetsH2`, `exportAndValidateBatchH2` gọi trực tiếp LOCKED F & G).
- `tests/productionPlanningH2.test.mjs` — Bộ kiểm thử tự động `H2-01..H2-15` + đối chiếu trực tiếp 7 file khuôn thật `L0110.063_-_NMST_-_khuon_be_TRANG_1..7.ai`.

## 2. Kết quả kiểm thử H2-01 đến H2-17
- `H2-01..H2-04`: `PASS` (`7` mẫu trang × `14` `runCount` = `98` tờ vật lý, `693` placement vật lý duy nhất, `9,702` tem thành phẩm, `9×11 = 99` tem/tờ, `copyIndex` 1-based `1..99`, hỗ trợ `expandPhysicalSheetsH2()` ra `98` tờ khi cần).
- `H2-05`: `PASS` (lưới thiếu ô cuối `95/99` tạo đúng `95` placement, `0` tem giả).
- `H2-06`: `PASS` (`100 > 99` → `BLOCK` với `GRID_CAPACITY_EXCEEDED`).
- `H2-07`: `PASS` (`CUT` vi phạm `cutGapMm` → `BLOCK` với `CUT_COLLISION`).
- `H2-08`: `PASS` (`bleedPolicy='strict'` vi phạm `bleedClearanceMm` → `BLOCK` với `BLEED_STRICT_VIOLATION`).
- `H2-09`: `PASS` (`allow_overlap` chưa xác nhận → `BLOCK` với `BLEED_OVERLAP_UNVERIFIED`; có `bleedOverlapConfirmed: true` + `bleedOverlapJustification` → `PASS` kèm warning).
- `H2-10`: `PASS` (thay đổi `job` hoặc `template` → `STALE_PLAN`).
- `H2-11`: `PASS` (thay đổi `runCount` → vô hiệu hóa `batchFreshnessHash` / manifest cũ, tọa độ vật lý `impositionPlan.sheets` giữ nguyên 100%).
- `H2-12`: `PASS` (qua LOCKED `exportProductionOutputs` + `finalProductionCheck` 3.1.3 + Pair Integrity: `status='PASS'`, `6/6/6` placements, `SERIALIZED_GEOMETRY_DELTA <= 0.01 mm`).
- `H2-13`: `PASS` (Determinism: `planHash`, `batchFreshnessHash`, `sheets` trùng khớp 100% qua 2 lần chạy).
- `H2-14`: `PASS` (Multi-SKU `SKU-A` `4×5=20`, `SKU-B` `2×5=10`, tổng `30` tem từ `6` placement vật lý).
- `L0110.063 Real Fixture`: `PASS` (đọc trực tiếp vector `/OC /MC2` trong 7 file `TRANG_1..7.ai`, toàn bộ `693` placement khớp `<= 0.01 mm`).
- `H2-15`: `PASS` (`17/17` file LOCKED trùng khớp SHA-256 trước/sau).
- `H2-16`: `PASS` (Regression `H.1 12/12`, `B 12/12`, `C 20/20`, `C.1 PASS`, `D 19/19`, `E 20/20`, `F 27/27`, `F.1 0.000000mm`, `G 32/32`).A
- `H2-17`: `PASS` (`npm run build` → `✓ built in 2.78s`, `0` lỗi).


---

# CHECKPOINT H.2.1 — PRODUCTION SAFETY HARDENING (✅ ENGINE PASS | UI NOT WIRED)

> **Status:** `H.2.1 ENGINE PASS` | **`UI NOT WIRED`** | **Locked Files Modified:** `0 / 17` (SHA-256 100% khớp) | **Vite Build:** `✓ built in 2.35s`

## 1. Các bản vá đã áp dụng
- **Freshness Security (`productionPlanValidatorH2.js`, `productionPlanningAdapterH2.js`):**
  - Xuất `computeBatchFreshnessHashH2()` dùng chung giữa adapter & validator.
  - `assertBatchFreshnessH2()` chuyển sang **FAIL-CLOSED (`async`)**:
    - Thiếu / `null` `currentRunCounts` (và không có `sheetTemplates` hợp lệ) → **BLOCK (`MISSING_RUN_COUNTS`)**.
    - Đổi `runCount` (`14 → 20`) → **BLOCK (`STALE_PLAN`)**.
    - Truyền `expectedOrderManifest` cũ (`14 copy`) cho batch mới (`20 copy`) → **BLOCK (`STALE_PLAN`)**.
    - Sửa tay `batchFreshnessHash` trong manifest → **BLOCK (`MANIFEST_HASH_MISMATCH`)**.
  - **Giới hạn kiến trúc trung thực (Bypass trực tiếp LOCKED F/G):** Nếu caller bỏ qua `exportAndValidateBatchH2()` và truyền thẳng `batchPlan.impositionPlan` vào LOCKED `exportProductionOutputs()` + `finalProductionCheck()` sau khi đổi `runCount` bên ngoài (không đổi `job.order.quantity`), LOCKED F/G **không phát hiện được** vì F/G không có trường `runCount`/`batchFreshnessHash`. Khắc phục bằng quy ước bắt buộc đi qua `exportAndValidateBatchH2()`, hoặc ở đợt mở khóa F/G có duyệt sẽ bổ sung kiểm `plan.extensions.batchFreshnessHash` vào `assertPlanFreshness()`.
- **BLEED Overlap Honesty:**
  - Tách tường minh `policyStatus: 'POLICY_ACCEPTED_COLOR_UNVERIFIED'` và `artworkColorVerified: false` trên cả `validateTemplateContoursH2()`, `productionOrderManifest.bleedPolicy`, và `exportAndValidateBatchH2().finalCheck` (`status: 'WARNING'`, giữ nguyên cảnh báo xuyên suốt, không tuyên bố đã xác minh màu).
- **AI Geometry Test (`L0110.063`):**
  - Đọc trực tiếp **56 đoạn cubic Bézier thật** của 99 tem/trang từ `/OC /MC2` trong 7 file `TRANG_1..7.ai`, sắp xếp xác định theo hàng–cột `(row 0..10, col 0..8)`, ghép cặp **1-1 không dùng nearest-neighbor**, kiểm chứng `> 150,000` điểm mẫu Bézier trên 693 tem: đạt cả `GRID_ORIGIN_ALIGNMENT_PASS` và **`FULL_CONTOUR_GEOMETRY_PASS` (`<= 0.01 mm`)**.


---

# CHECKPOINT H.2.2 — PRODUCTION BLEED GEOMETRY SAFETY (✅ ENGINE PASS | UI NOT WIRED)

> **Status:** `H22-01..H22-18 PASS` | **`UI NOT WIRED`** | **Locked Files Modified:** `0 / 17` (SHA-256 100% khớp) | **Vite Build:** `✓ built in 2.46s`

## 1. Files Created / Extended
- **Created:** `resources/js/engine/productionBleedSafetyH22.js` — Flatness-controlled de Casteljau Bézier tessellation (`0.002 mm` default, fail-closed `GEOMETRY_UNVERIFIED`), exact two-way `Interior(BLEED_A) ∩ Interior(CUT_B)` intrusion test (`BLEED_INTRUDES_NEIGHBOR_CUT`), exact `CUT_COLLISION` vs `CUT_GAP_VIOLATION`, scanline overlap area & regions, and real print color metadata verifier (`DeviceCMYK`/`ICCBased_CMYK`/`Separation`, `opacity=1`, `blendMode=Normal`, `overprint=false`, `spotColor`, `zOrderVerified=true`; rejects RGB preview).
- **Extended (non-locked):** `resources/js/engine/productionPlanValidatorH2.js` & `resources/js/engine/productionPlanningAdapterH2.js` (`vH2.2`) — propagates `geometryStatus`, `colorStatus`, `policyStatus`, `productionStatus`, `artworkColorVerified` through manifest and final report without suppressing warnings.
- **Created:** `tests/productionBleedSafetyH22.test.mjs` — `H22-01..H22-17` + `0.083 mm` boundary intrusion negative tests + full 7-page real `L0110.063` Bézier contour audit.

## 2. Kết quả kiểm toán 7 trang thật L0110.063 (`H22-15`, `693` CUT 56-Bézier + `693` BLEED 52-Bézier, `flatness=0.005 mm`)
| Trang | Tem | Min CUT Gap (mm) | Min BLEED→Neighbor CUT (mm) | Cặp Overlap | Tổng DT Overlap (mm²) | Intrusions | Color Status |
|---|---:|---:|---:|---:|---:|---:|---|
| P1 (3%) | 99 | 2.4357 | 0.4354 | 88 | 467.99 | 0 | `GEOMETRY_SAFE_COLOR_VERIFIED` |
| P2 (5%) | 99 | 2.0830 | 0.0828 | 88 | 631.61 | 0 | `GEOMETRY_SAFE_COLOR_VERIFIED` |
| P3 (10%) | 99 | 2.4278 | 0.4277 | 88 | 471.50 | 0 | `GEOMETRY_SAFE_COLOR_VERIFIED` |
| P4 (15%) | 99 | 2.7101 | 0.7100 | 88 | 347.16 | 0 | `GEOMETRY_SAFE_COLOR_VERIFIED` |
| P5 (20%) | 99 | 2.4359 | 0.4360 | 88 | 467.76 | 0 | `GEOMETRY_SAFE_COLOR_VERIFIED` |
| P6 (25%) | 99 | 2.5533 | 0.5531 | 88 | 416.24 | 0 | `GEOMETRY_SAFE_COLOR_VERIFIED` |
| P7 (30%) | 99 | 2.2140 | 0.2140 | 88 | 565.47 | 0 | `GEOMETRY_SAFE_COLOR_VERIFIED` |


---

# SCALLOPED CONTOUR — GIAI ĐOẠN A: PDF VECTOR CONTOUR IMPORT (✅ PASS)

> **Status:** `PHASE A PASS` (`5/5` test groups) | **Locked Files Modified:** `0 / 17` (SHA-256 100% khớp) | **Max Full-Curve Delta (693 tem × 56 Bézier vs L0110.063):** **`0.000536 mm`** (`0.536 µm`)

## 1. Files Created (Additive — 0 Locked Files Modified)
- `resources/js/engine/pdfVectorContourImporter.js` — Bộ đọc contour vector trực tiếp từ PDF stream: giữ đầy đủ CTM stack (`q`/`Q`/`cm`), giữ nguyên cubic Bézier (`M`/`L`/`C`/`v`/`y`), lọc OCG `/OFF`, phân biệt biên nền kem ngoài cùng với viền đỏ trang trí bên trong bằng **topological containment forest** + paint operator (`fill` vs `stroke`), fail-safe trả `FALLBACK_TO_RASTER` / `CONFIRMATION_REQUIRED` khi mơ hồ.
- `tests/pdfVectorContourImporter.test.mjs` — `A1..A6` (8 trang khách = 792 tem, 7 trang đối chiếu khuôn xưởng `L0110.063` = 693 tem, multi-layer `.ai`, negative tests raster-only & stroke-only, SHA-256 17 file LOCKED).

## 2. Kết quả đối chiếu toàn đường cong 7 trang `L0110.063` (`A2`)
- **Tổng số tem đối chiếu:** `693` tem (`7` trang × `99` tem × `56` đoạn cubic Bézier/tem).
- **Độ sâu khe lõm bảo toàn (`valleyDepth`):** **`0.6949 mm`** (100% khớp khuôn xưởng).
- **Sai số tối đa trên toàn đường cong (Full-Curve Delta):** **`0.000536 mm`** (`P1–P7`: `0.000407 mm` đến `0.000536 mm`).
- **Viền đỏ trang trí (`18.025 mm`) bị nhầm thành CUT:** **`0 / 792`** (loại chính xác `99` viền đỏ/trang).


---

# SCALLOPED CONTOUR — GIAI ĐOẠN B: HIGH DETAIL FREEFORM CHO RASTER (⚠️ PARTIAL — THIẾU FIXTURE WEBP & YẾN SÀO)

> **Status:** `PHASE B ENGINE & UI PASS` (`5/5` test groups trên bộ mẫu hiện có) | **Kết luận tổng thể theo tiêu chí 8:** **`PARTIAL`** (do thiếu file gốc `CutContour_z3833721139430-2164e3ed3e755742eb38cd17a4af6792.webp` và `tem yến sào` trong workspace) | **Controlled Unlock:** Chỉ mở khóa duy nhất `bleedContourEngine.js` trong nhánh opt-in `detailMode === 'high'` (`16/16` file LOCKED còn lại SHA-256 100% không đổi) | **Vite Build:** `✓ built in 4.07s`

## 1. Phạm vi thay đổi (Controlled Unlock)
- **`resources/js/engine/bleedContourEngine.js`** (mở khóa có kiểm soát — **nhánh `standard` giữ nguyên 100% hành vi**):
  - Thêm `taubinSmoothDenseLoop(pts, passes=2, lambda=0.33, mu=-0.33)`: làm mượt không co rút (zero-shrinkage Taubin fairing) để tách nhiễu răng cưa 1px khỏi khe lõm cánh hoa thật.
  - Cập nhật `fitCornerPreservingBezier(..., { detailMode = 'standard' })`: khi `detailMode === 'high' && !preserveOffset`, dùng Taubin fairing thay Gaussian fairing, bỏ `anchorPasses` Laplacian co lõm, nới trần `rdpTol` xuống `[0.04, 0.08] mm` và `minEdgeMm = 0.22 mm`.
  - Cập nhật `extractStickerContoursFromImage(..., { detailMode = 'standard' })`: khi `detailMode === 'high'`, đặt `minSmoothBallPx = 0` và bỏ qua morphological closing `1.25 mm` (giãn/co trực tiếp theo `itemOffsetPx` hoặc giữ nguyên `locFg` khi `|itemOffsetPx| <= 0.2 px`).
  - SHA-256 `bleedContourEngine.js`:
    - Baseline trước Phase B: `b62e30a8922b6f1d03195b0bb87d2bc03e5a79b26cbc8248fbd0d0f362e47338`
    - Sau Phase B: `4ac146dab4e1701faf02fedb2fba1462d7d4a0bdc0c62dead47ed19f37a17c6a`
- **`resources/js/components/BleedAndContourStudio.jsx`**:
  - Nối state `detailMode` (`'standard'` mặc định | `'high'`) vào `extractStickerContoursFromImage` và hiển thị dropdown chọn **Độ chi tiết đường bế (Freeform)** khi `shapeMode === 'auto'`.
- **`tests/highDetailFreeformPhaseB.test.mjs`**:
  - Bộ test `PB-01..PB-05` + xuất ảnh SVG so sánh trước/sau (`phase_b_high_detail_overlay.svg`).

## 2. Số liệu trước–sau (`Giảm 3%` 12 cánh hoa raster @ 300 DPI, `offset=0`, `bleed=+2.0 mm`)
| Chỉ số | Ground Truth (PDF 56-Bézier) | `standard` (Trước) | `high` (Sau) |
|---|---:|---:|---:|
| Độ sâu khe lõm TB (`avgValley`) | `0.6919 mm` | `0.3885 mm` (mất 43.8%) | **`0.7461 mm`** (12/12 khe rõ nét) |
| Độ sâu khe lõm nhỏ nhất (`minValley`) | `0.6892 mm` | `0.2652 mm` | **`0.5821 mm`** |
| Sai số trung bình mép CUT (`mean`) | `0.0000 mm` | `0.1124 mm` | **`0.0369 mm`** (-67.2%, < 0.5 px) |
| Sai số tối đa mép CUT (`Hausdorff`) | `0.0000 mm` | `0.2612 mm` | **`0.2165 mm`** |
| Phình bất thường (`outwardBulge`) | `0.0000 mm` | — | **`0.0675 mm`** |
| Góc gãy tiếp tuyến lớn nhất (`maxTangentJump`) | — | — | **`0.36°`** (`0` điểm gãy > 15°) |
| Sai số pháp tuyến BLEED (`target 2.000 mm`) | `2.0000 mm` | — | `min 1.9238 / avg 2.0339 / max 2.1308 mm` |
| Số đoạn cubic Bézier (CUT / BLEED) | `56 / 52` | `41 / —` | **`56 / 61`** |
| Tự giao (CUT / BLEED) | `0 / 0` | `0 / 0` | **`0 / 0`** |


---

# CHECKPOINT K (B3.1.1) — UI BRIDGE & BÌNH BÀI BẾ TEM V1 (PHƯƠNG ÁN A — ✅ PASS)

> **Status:** `CHECKPOINT K PASS` (`3/3` test groups) | **UI Wired:** Nút **"Bình bài Bế Tem (V1 chuẩn Bézier)"** trong `BleedAndContourStudio.jsx` → `ProductionImposeV1Modal.jsx` | **Locked Engine Files Modified:** `0 / 17` (SHA-256 100% giữ nguyên) | **Vite Build:** `✓ built in 2.93s`

## 1. Files Created / Updated (Additive — 0 Locked Files Modified)
- **Created:** `resources/js/engine/checkpointKUiBridge.js` — Hardened B3.1.1 UI bridge (`createCheckpointKBatch`, `exportCheckpointKBatch`, `releaseCheckpointKOutput`, `buildStudioStickerJobsV1`, `suggestGridForSheet`) với kiểm tra `uiSnapshot` (`canonicalStringify`), `checkCropAssets`, `allow_overlap` + lý do bắt buộc, khóa `cutFormat === 'PDF'`, phân tách `PASS`/`WARNING`/`FINAL_CHECK_BLOCK`.
- **Created:** `resources/js/components/ProductionImposeV1Modal.jsx` — Modal bình tem sản xuất PrintKit V1 trực tiếp từ `BleedAndContourStudio`: giữ nguyên 100% cubic Bézier gốc, vô hiệu hóa `checkpoint` ngay khi thay đổi thông số, yêu cầu xác nhận trên `WARNING`, chặn tải và tự `release` `ResourceStore` khi `BLOCK`.
- **Updated:** `resources/js/components/BleedAndContourStudio.jsx` — Nối nút **"Bình bài Bế Tem (V1 chuẩn Bézier)"** mở `ProductionImposeV1Modal` với canvas artwork sạch (không vẽ nét hồng/xanh) và `contoursMm` gốc.
- **Created:** `tests/checkpointKUiBridge.test.mjs` — `CK-01..CK-06`.

## 2. Kết quả kiểm chứng trên mẫu thật Yến Sào 42 tem (`330 × 390 mm`, `6 × 7`, `CK-01`)
| Chỉ số | Luồng Legacy (`impositionEngine` + `pdfExporter`) | Luồng PrintKit V1 (Checkpoint K — Phương án A) |
|---|---:|---:|
| Số tem / tờ | `42` | **`42`** |
| Số đoạn cubic Bézier / tem trong `FILE BE` | `54` (bị tái nội suy) | **`84`** (giữ nguyên 100% gốc) |
| Độ sâu 15 khe lõm trung bình (`avgValley`) | `0.501 mm` (mất **64.2%**) | **`1.3996 mm`** (gốc `1.3996 mm`, **lệch `0.00000 mm`**) |
| `FinalProductionValidator` (3.1.3 + Pair Delta) | Không chạy | **`PASS`** (`releaseAllowed: true`) |
| Số file LOCKED bị sửa | — | **`0 / 17`** (SHA-256 khớp 100%) |


---

# V1-A1..V1-A5 — VECTOR FIRST PIPELINE, STUDIO INTEGRATION & POST-EXPORT CUT.PDF VERIFICATION (✅ PASS)

> **Status:** `46/46 TESTS PASSED` (`0` failed across all 7 suites) | **Locked Engine Files Modified:** `0 / 17` (SHA-256 100% unchanged) | **Vite Build:** `✓ built in 3.52s`

## 1. Files Created / Updated (Additive — 0 Locked Files Modified)
- **Updated (`V1-A1`):** `resources/js/engine/pdfVectorContourImporter.js` — Loại bỏ hoàn toàn phụ thuộc Node `Buffer` (thay bằng `bytesToLatin1` an toàn trên trình duyệt), bổ sung phân loại 4 trạng thái nguồn gốc (`CONTOUR_PROVENANCE`: `VECTOR_ORIGINAL`, `VECTOR_TRANSFORMED`, `RASTER_DERIVED`, `VECTOR_IMPORT_REJECTED`), kiểm độ tin cậy nghiêm ngặt (Điểm A: từ chối PDF trộn raster+vector không có layer CUT, PDF chỉ có stroke mơ hồ, và path vector chồng lấn nhau), lưu chiều hướng contour (`winding: CW | CCW`) và hệ tọa độ (`SHEET_MM_Y_DOWN`).
- **Created (`V1-A2`):** `resources/js/engine/vectorFirstPipeline.js` — Điều phối Vector First Pipeline (`runVectorFirstPdfImport`, `resolveVectorFirstContours`, `convertVectorContourToStudioPoly`, `buildCanonicalCutsFromVectorResult`):
  - Điểm B: `|offsetMm| < 0.01` bảo toàn `VECTOR_ORIGINAL`; `|offsetMm| >= 0.01` áp dụng **controlled vector offset** (`VECTOR_TRANSFORMED`) thay vì tự động rơi về raster; trường hợp không hỗ trợ (ví dụ ép hình `shapeMode !== 'auto'` hoặc offset gây tự giao) trả về `CONFIRM_RASTER_FOR_TRANSFORM` yêu cầu người dùng xác nhận.
  - Điểm C: Giữ đầy đủ contract `CanonicalCutV1` (hệ tọa độ, thứ tự segment, chiều `winding`, `closed: true`, quan hệ contour–job, metadata nguồn JSON-safe) và truyền đúng đối tượng polygon+Bézier vào `precisionBleedFromCut()` mà không làm biến đổi `beziersMm` gốc.
- **Updated (`V1-A3`):** `resources/js/components/BleedAndContourStudio.jsx` — Tích hợp luồng Vector First cho PDF (tự đặt `offsetMm = 0` khi nhập PDF vector hợp lệ để giữ `PDF VECTOR — ORIGINAL`), giữ nguyên luồng High Detail / Standard cho ảnh PNG/JPG/WebP và PDF raster, hiển thị rõ badge nguồn gốc (`PDF VECTOR — ORIGINAL`, `PDF VECTOR — TRANSFORMED`, `RASTER — HIGH DETAIL`, `RASTER FALLBACK`, `VECTOR IMPORT REJECTED`) cùng lý do fallback, DPI thực tế và nút xác nhận chuyển Raster.
- **Updated (`V1-A4`):** `resources/js/engine/checkpointKUiBridge.js` (xác nhận đã export `buildStudioStickerJobsV1`, bổ sung bảo toàn provenance + kẹp an toàn `cropBoxMm` + gắn chặn tự động bởi `verifyExportedCutPdfGeometry` trong `exportCheckpointKBatch`) và `resources/js/components/ProductionImposeV1Modal.jsx` (hỗ trợ chế độ giữ toàn bộ `N` tem riêng biệt trên trang, ví dụ `99/99` tem `Giảm 3%`, hiển thị badge nguồn gốc và bảng kiểm định sau xuất `CUT.pdf`).
- **Created (`V1-A5`):** `resources/js/engine/postExportGeometryVerifier.js` (Điểm D: đọc ngược bytes `CUT.pdf` thực tế không dùng `Buffer`, hỗ trợ compound subpaths + toán tử `s`/`b` + ký hiệu khoa học, nghịch đảo ma trận cứng `rigidMatrixMm` từng vị trí, đo số lượng contour, số đoạn Bézier, khép kín, tự giao, Hausdorff, mean delta, hồ sơ độ sâu khe lõm 72 tia xuyên tâm, khấc gợn tiếp tuyến mới theo từng điểm nối, khoảng cách CUT-CUT nhỏ nhất kèm phát hiện giao cắt/lồng nhau thực sự và BLEED; trả về `BLOCK` khi vượt ngưỡng) và `tests/vectorFirstEndToEnd.test.mjs` (`E2E-01..E2E-08`).

## 2. Kết quả kiểm định thực tế trên `CUT.pdf` mẫu `Giảm 3%` (`99` tem × `56` đoạn Bézier, `320 × 330 mm`, `9 × 11`, `E2E-04`)
| Chỉ số kiểm định trên `CUT.pdf` thực tế | Kết quả đo được | Ngưỡng chấp nhận | Trạng thái |
|---|---:|---:|---|
| Số contour đọc lại từ `CUT.pdf` | **`99 / 99`** (0 path trang trí) | `99 / 99` | ✅ PASS |
| Số contour khép kín / tự giao | **`99 / 99`** · **`0`** tự giao | `99/99` · `0` | ✅ PASS |
| Sai khác số đoạn Bézier (`56`/tem) | **`0`** | `0` | ✅ PASS |
| Sai lệch Hausdorff tối đa (sau nghịch đảo `rigidMatrixMm`) | **`0.0001 mm`** | `≤ 0.0200 mm` | ✅ PASS |
| Sai lệch trung bình (`meanDeviationMm`) | **`0.0000 mm`** | `≤ 0.0080 mm` | ✅ PASS |
| Sai lệch độ sâu khe lõm 72 tia (`maxValleyDepthDeltaMm`) | **`0.0001 mm`** | `≤ 0.0150 mm` | ✅ PASS |
| Khấc gợn tiếp tuyến mới (`newKinksCount`) | **`0`** | `0` | ✅ PASS |
| Khoảng cách CUT-CUT nhỏ nhất (`minCutGapMm`) | **`2.2000 mm`** (`0` va chạm) | `≥ 2.1500 mm` | ✅ PASS |
| Kiểm tra BLEED (`bleedCheckedCount / bleedInvalidCount`) | **`99 / 0`** | `99 / 0` | ✅ PASS |
| `FinalProductionValidator` (PRINT + CUT alignment) | **`PASS`** (`releaseAllowed: true`) | `PASS` | ✅ PASS |
| Kiểm tra tiêm lỗi `CUT.pdf` giả (`E2E-05`) | **`BLOCK`** (`passed: false`) | `BLOCK` | ✅ PASS |
| Kiểm toán SHA-256 17 file LOCKED (`E2E-06`) | **`17 / 17` nguyên vẹn** | `17 / 17` | ✅ PASS |


---

# BÌNH TEM BẾ V1 TRỰC TIẾP TRONG `PdfEditor.jsx` + `PdfCanvasPreview.jsx` (✅ PASS)

> **Status:** `STICKER TAB V1 PASS` (`4/4` test groups + `50/50` tổng toàn bộ suite) | **UI Preserved:** Giữ nguyên 100% giao diện & thao tác tab **Bình Tem Bế** hiện tại (không mở popup) | **Locked Engine Files Modified:** `0 / 17` (SHA-256 100% giữ nguyên) | **Vite Build:** `✓ built in 3.90s`

## 1. Kiến trúc nối thẳng (Single Authoritative V1/H.2 Plan)
- **Created:** `resources/js/engine/stickerTabV1Adapter.js` — Adapter cầu nối trực tiếp tab Bình Tem Bế (`PdfEditor.jsx`) với `checkpointKUiBridge.js` (H.2 + H.2.2 + G + Post-Export `CUT.pdf` Verification):
  - `buildV1StickerTabPlan`: sinh **1 kế hoạch duy nhất** (`checkpoint.batchPlan.impositionPlan` + `previewPlan`) đảm bảo Preview (`PdfCanvasPreview.jsx`) và Export (`PRINT.pdf` + `CUT.pdf`) dùng chung 100% tọa độ, ma trận cứng, đường Bézier CUT/BLEED và boong.
  - `checkV1StickerConfigCompatibility`: chặn minh bạch các tùy chọn chưa được V1 hỗ trợ (`honeycomb`, `nesting` xoay góc lẻ, `clusterSplit`, `guillotine`, ép hình `stickerShape !== 'pdfContour'`, xuất `.SVG`) — **tuyệt đối không âm thầm rơi về legacy**.
  - `exportV1StickerTabOutputs`: gọi `exportCheckpointKBatch(..., { verifyExportedCutPdf: true })` và tự `releaseCheckpointKOutput` khi hoàn tất hoặc bị `BLOCK`.
- **Updated:** `resources/js/components/BleedAndContourStudio.jsx` — Nút **Bình bài Bế Tem** truyền trực tiếp `{ cleanArtworkCanvas, cleanArtworkBytes, sourceSizeMm, contoursMm, bleedOffsetMm, contourProvenance, sourceFileName }` sang tab **Bình Tem Bế** (`activeStudio = 'sticker'`), không mở popup.
- **Updated:** `resources/js/components/PdfEditor.jsx` & `resources/js/components/PdfCanvasPreview.jsx` — Giữ nguyên giao diện cũ; vẽ trực tiếp đường cong cubic Bézier thật (`kind: 'bezier'`) và clip artwork sạch theo biên `bleedBeziersMm` trên Preview; hiển thị kết quả hậu kiểm `CUT.pdf` ngay sau xuất.
- **Created:** `tests/stickerTabV1Adapter.test.mjs` — `STV1-01..STV1-04`.

## 2. Kết quả kiểm chứng thực tế (`STV1-01..STV1-04`)
- **Gia Hưng 15 cánh (`330 × 390 mm`, `6 × 7 = 42` tem):** Preview `42 × 84` Bézier, Export **`PASS`**, Hậu kiểm `CUT.pdf` **`PASS`** (`Hausdorff = 0 mm`, `valleyDelta = 0 mm`, `newKinks = 0`).
- **Giảm 3% (`320 × 330 mm`, `9 × 11 = 99` tem PDF vector):** Preview `99 × 56` Bézier, Export **`PASS`**, Hậu kiểm `CUT.pdf` **`PASS`** (`exportedContours = 99/99`, `segmentMismatches = 0`, `newKinks = 0`).
- **Chặn tùy chọn chưa hỗ trợ V1 (`STV1-03`):** `honeycomb`, `nesting`, `clusterSplit`, `guillotine`, `stickerShape !== 'pdfContour'`, `SVG` đều báo rõ & chặn, không fallback legacy.
- **SHA-256 Lock Audit (`STV1-04`):** `17 / 17` file engine LOCKED không đổi.


---

## Single Sticker Pipeline V1 — Nghiệm thu gộp 1 luồng duy nhất (2026-11-26)

Toàn bộ luồng tem bế (`BleedAndContourStudio.jsx` → `PdfEditor.jsx` + `PdfCanvasPreview.jsx`) đã được hợp nhất về **1 pipeline V1/H.2 duy nhất** với cache hình học có version (`stickerPipelineCache.js`) và xuất tách từng file CUT PDF theo trang (`exportV1StickerBatchBundle`).

### Thay đổi kiến trúc & file
- **Mới:** `resources/js/engine/stickerPipelineCache.js` — tách biệt hình học bất biến (`exactGeometryKey` IEEE-754 + `productionGeoHash` của LOCKED `productionGeometry.js`) khỏi metadata theo job (`jobId`, `sourceAssetId`, `artworkRef.resourceId`, `cropBoxMm`); đo chính xác `bleedEngineCalls`, `geoCacheHits`, `jobSetHits`, `layoutComputations`, `lastLayoutMs`.
- **Cập nhật:**
  - `resources/js/engine/checkpointKUiBridge.js`: tích hợp `pipelineCache` và `computeExactGeometryKey` vào `buildStudioStickerJobsV1`.
  - `resources/js/engine/stickerTabV1Adapter.js`: cache `jobSet` theo `sourceBatchKey` (đổi khổ giấy / lề / khoảng cách / boong / runCount chỉ tính lại H.2 layout với **0 lần gọi `precisionBleedFromCut`**), bổ sung `exportV1StickerBatchBundle` xuất **1 `PRINT.pdf` nhiều trang + N file `CUT_TRANG_1..N.pdf` riêng** và hậu kiểm độc lập từng file CUT (MediaBox, CropBox, 4 boong, Bézier, Hausdorff, valley depth, 0 kinks, 0 collisions) + tự động giải phóng `ResourceStore` trong `finally`.
  - `resources/js/engine/productionBleedSafetyH22.js`: tối ưu thuật toán toán học không mất độ chính xác (edge-bbox pruning + seeding `minSq` trong `exactDisjointPolygonDistanceMm`, kiểm tra `pointInPolygonRay` trước trong `pointStrictlyInsidePolygon`, và `WeakMap` cache tessellation theo reference contour), giảm thời gian kiểm định layout 693 tem (7 tờ) từ **57.99 giây** xuống còn **~5.6 giây** (~10× nhanh hơn, giữ nguyên 100% kết quả chính xác).
  - `resources/js/components/BleedAndContourStudio.jsx`: ngừng import/render `ProductionImposeV1Modal.jsx` (vẫn giữ nguyên file trên ổ đĩa theo Điều kiện 1), khóa nút legacy "Bình lồng ghép tự do" có thông báo rõ ràng.
  - `resources/js/components/PdfEditor.jsx`: gắn `v1PipelineCacheRef`, chỉ khóa các tùy chọn chưa hỗ trợ (`nesting`, `honeycomb`, `rect`/`circle`/`oval`, `clusterSplit`, `guillotine`, `.SVG`) khi đang ở phiên Sticker V1 (không ảnh hưởng `namecard`/`booklet`/`grid`), và xuất tách `TRANG_1..N` file CUT khi nhiều trang.
- **Kiểm thử nghiệm thu (`tests/singleStickerPipelineV1.test.mjs`):** `6/6 PASS` (tổng hồi quy 7 bộ test V1: `30/30 PASS`, `npm run build` thành công `3.62s`):
  - **`SPV1-01` (File khách 8 trang → 7 trang `3%–30%`, `693` tem, 1 `PRINT.pdf` 7 trang + 7 `CUT_TRANG_1..7.pdf`):** `distinctGeometryKeyCount = 99`, **`bleedEngineCalls = 99`** (`geoCacheHits = 594`, giảm **85.7%** số lần gọi BLEED mà không lượng tử hóa CUT), 7 `sourceAssetId` & 7 `artworkRef.resourceId` bảo toàn riêng biệt, Preview = Export 100% cùng tọa độ, cả 7 file `CUT_TRANG_1..7.pdf` đều **PASS** hậu kiểm độc lập (`maxHausdorff = 0.0001mm`, `maxValleyDelta = 0.0001mm`, `0` kinks, `0` collisions, khớp MediaBox `320×330mm` của 7 file `.ai` tham chiếu `L0110.063`).
  - **`SPV1-02` (5 thao tác đổi layout: khổ giấy, lề, gutter, boong, runCount):** **`bleedEngineCalls` tăng `+0`** (giữ nguyên `99`), `jobSetHits = 5`, `avgLayoutMs = 5608.13ms` cho toàn bộ 693 tem (7 tờ) trên Node.js (giảm ~10× so với `57,988ms` trước tối ưu).
  - **`SPV1-03` (Cache invalidation):** đổi tập trang nguồn (`1–3` → `1–2`) miss `jobSet` nhưng vẫn hit `prodGeoByHash` (`+0` BLEED); đổi `bleedOffsetMm` (`2.0` → `1.5`) miss `prodGeoByHash` và tính lại đúng `11` BLEED mới.
  - **`SPV1-04` (An toàn phiên & cleanup):** từ chối `STALE_PLAN` khi `runCount` lệch, chặn `.SVG` legacy, `0` resource rò rỉ trong `ResourceStore`.
  - **`SPV1-05` (RAM):** `heapUsed = 498.37MB`, `RSS = 658.93MB` sau toàn bộ benchmark 693 tem + 5 lần đổi layout + xuất bundle 7 tờ.
  - **`SPV1-06` (Lock & Scope Audit):** `ProductionImposeV1Modal` tách khỏi `BleedAndContourStudio` (file vẫn giữ nguyên), bình lưới non-V1 hoạt động bình thường, **`17 / 17` file engine LOCKED giữ nguyên SHA-256 100%**.

### Hoàn thiện đồng bộ điều khiển Bình Tem Bế V1 (`SPV1-07`, 2026-11-26)
- **Đồng bộ hoàn chỉnh 100% điều khiển V1 (`stickerTabV1Adapter.js`, `PdfEditor.jsx`, `PdfCanvasPreview.jsx`):**
  - `alignment` (`top` / `center` / `bottom`) → dịch chuyển đúng tọa độ H.2 trên cả Preview và PRINT/CUT PDF (`yTop=15 < yCenter=72.8658 < yBottom=126.231 mm`).
  - `pontMarginMm` & `pontSizeMm` → cập nhật trực tiếp `productionProfile` (`markInsetMm`, `markSizeMm`) và 4 boong góc trên Preview (`pontMarks`) + PRINT/CUT PDF.
  - `stickerQtyInput`, số lượng từng trang (`v1PageRunCounts` / `runCountByPage`) và `quantityByPage` (mẫu đơn) → phản ánh đúng `physicalSheets`, `sheet.runCount`, `productionOrderManifest.runCountsByTemplateId`, và `currentRunCounts` khi xuất (`14 + 5 + 2 = 21 tờ`, mẫu đơn `10 tem/1 tờ` và `300 tem/2 tờ`).
  - Cột `Trang V1` bên trái hiển thị đúng `Trang V1 (7/8)` và danh sách 7 trang chọn sản xuất (không nhầm với 8 trang nguồn), ẩn gọn các mục Legacy chưa hỗ trợ (`ĐƠN VỊ BÌNH`, `TÁC VỤ`, `CÁCH XẾP`, `DAO BẾ`, `CÁCH CHIA CỤM`, `DẤU XÉN`, `.SVG`) chỉ trong chế độ Sticker V1.
  - Sửa lỗi hiển thị Preview V1 (`rigidMatrixMm[4]/[5]`, `marks`, `pontMarks` `cx/cy/size`) — hiển thị đầy đủ 99 tem + đường bế đỏ + 4 boong góc.
- **Kiểm thử:** `tests/singleStickerPipelineV1.test.mjs` **7/7 PASS** (`SPV1-01..SPV1-07`, `+0` lần gọi `precisionBleedFromCut` khi đổi alignment/pont/runCount, `17/17` file LOCKED giữ nguyên SHA-256), `npm run build` thành công (`4.51s`).

### Chuẩn hóa đầu ra giống xưởng AI (`300 DPI`, Hở ngang/dọc X/Y, Boong chữ L Graphtec & Slug Line)
- [BleedAndContourStudio.jsx](file:///c:/Source/Binh_file/tool-binh-file/resources/js/components/BleedAndContourStudio.jsx): nâng `renderScale` chuyển trang đa trang lên **300 DPI** (`Math.min(300 / 72, 4200 / maxDim)`).
- [PdfEditor.jsx](file:///c:/Source/Binh_file/tool-binh-file/resources/js/components/PdfEditor.jsx) & [stickerTabV1Adapter.js](file:///c:/Source/Binh_file/tool-binh-file/resources/js/engine/stickerTabV1Adapter.js): tách riêng ô **Hở ngang (`X`)** và **Hở dọc (`Y`)** nối thẳng vào `gridSpec.pitchXmm` / `pitchYmm`; bổ sung hậu-stamp không chạm 17 file LOCKED (`stampShopMarksAndSlugOnPage`) vẽ **boong chữ L Graphtec (`┌ ┐ └ ┘`) / tròn 5mm / tròn rỗng** trên cả PRINT & CUT PDF và **dòng Slug Line đầu tờ** trên PRINT PDF, chạy `verifyExportedCutPdfGeometry` sau khi stamp (`7/7 PASS`, `17/17` LOCKED SHA-256 không đổi, `vite build` `4.37s`).

### Sửa lỗi nền trắng chồng BLEED & lỗi lệch trang vector đa trang (`2026-11-26`)
- [contourBleedFill.js](file:///c:/Source/Binh_file/tool-binh-file/resources/js/engine/contourBleedFill.js): đổi nền `buildBleedFilledExportCanvas` từ `#ffffff` sang **trong suốt (`ctx.clearRect`)** + nét an toàn `0.35 mm`, đảm bảo `99/99` ảnh tem trong PRINT PDF có `SMask` trong suốt, hết hoàn toàn lỗi mảng trắng che cầu nối nền kem (`[40..45] px` đều 100%).
- [BleedAndContourStudio.jsx](file:///c:/Source/Binh_file/tool-binh-file/resources/js/components/BleedAndContourStudio.jsx):
  - **Sửa lỗi gốc lệch CUT/artwork đa trang:** dòng gọi `runVectorFirstPdfImport(pdfBytesRef.current, pNum)` trước đó truyền số `pNum` thay vì object `{ pageNumber: pNum, minAreaMm2 }`, khiến mọi trang `2..N` khi chuyển đa trang bị nhận nhầm contour vector của **Trang 1** (`c0.minX = 5.145 mm` thay vì Trang 2 `6.558 mm`, gây lệch `-1.41 mm` ở cột 1 và `+1.41 mm` ở cột 9). Đã sửa sang `{ pageNumber: pNum, minAreaMm2 }` kèm guard kiểm tra `vecRes.pageNumber === pNum`.
  - Bỏ làm tròn `0.1 mm` cho `pgWmm/pgHmm` (`vp1.width / MM_TO_PT`, `vp1.height / MM_TO_PT`) và thêm `pdfPageCacheRef` cache từng trang đã bóc để chuyển qua lại giữa các trang (Trang 1 ↔ 7) tức thì và dùng lại khi chuyển sang Bình Tem V1.

### Phân biệt trạng thái Load PDF vs Bóc tách Bù Xén theo từng trang (`studioMultiPageState.js`, `2026-11-26`)
- **Mới:** [studioMultiPageState.js](file:///c:/Source/Binh_file/tool-binh-file/resources/js/engine/studioMultiPageState.js) — State machine 4 trạng thái rõ ràng theo từng trang (`PDF_LOADED` → `PREVIEW_READY` → `CUT_READY` → `BLEED_READY`, cộng `NO_CUT`/`ERROR`), `validatePageOwnership` chặn tuyệt đối dùng nhầm contour của trang/file khác, `getEffectivePageStage` tự hạ `BLEED_READY → CUT_READY` khi đổi thông số bù xén mà giữ nguyên `Preview + CUT`, và `partitionPagesForHandoff` chỉ cho chuyển sang Bình Tem các trang đạt đủ `Artwork–CUT–BLEED` kèm cảnh báo chi tiết các trang chưa xử lý / không có đường bế.
- **Cập nhật:** [BleedAndContourStudio.jsx](file:///c:/Source/Binh_file/tool-binh-file/resources/js/components/BleedAndContourStudio.jsx) — Mở PDF chỉ bóc Trang 1 trước (Trang `2..N` hiện `PDF Loaded`), thêm bảng pill trạng thái từng trang (`T1..TN`), nút **"Bóc tách tất cả (N trang)"** / **"Cập nhật BLEED (K trang)"** có thanh tiến độ & nút **Dừng**, và chặn chuyển trang chưa bóc / cảnh báo rõ trang bỏ qua khi bấm **Bình bài Bế Tem**.
- **Kiểm thử:** [studioMultiPageState.test.mjs](file:///c:/Source/Binh_file/tool-binh-file/tests/studioMultiPageState.test.mjs) (`MPS-01..MPS-05` trên file PDF 8 trang thật `Decal sticker pdf.pdf`, `17/17` file engine LOCKED không đổi).

### Machine Compatibility PrintKit V1 (Die-Cut Tờ 5mm & Graphtec ARMS Type 1/2 + Xuất `.ai` phân lớp, `2026-11-26`)
- **Mới (Additive — 0 / 17 file engine LOCKED bị sửa):**
  - [machineCompatibilityProfiles.js](file:///c:/Source/Binh_file/tool-binh-file/resources/js/engine/machineCompatibilityProfiles.js): Định nghĩa `LAYER_ROLES` (`RegMark`, `CutLine`, `Crease`, `Bleed`, `Design`) và 3 Machine Profiles (`diecut_sheet_5mm`, `graphtec_arms_t1`, `graphtec_arms_t2`) + `getMarkQuietZoneRectsMm`.
  - [machineCompatibilityValidator.js](file:///c:/Source/Binh_file/tool-binh-file/resources/js/engine/machineCompatibilityValidator.js): Kiểm định trực tiếp stream CUT PDF (khép kín, chỉ stroke không fill, 0 contour trùng, Spot Color `/Separation /CutContour`), vùng an toàn cảm biến (Quiet Zone), khổ vật liệu & tương thích phần mềm; tách biệt 2 báo cáo `PASS/WARNING/FAIL` riêng cho **Hình học (`geometryReport`)** và **Tương thích máy (`machineReport`)**.
  - [layeredAiExporter.js](file:///c:/Source/Binh_file/tool-binh-file/resources/js/engine/layeredAiExporter.js): Xuất file `.ai` phân lớp chuẩn PDF OCG (`RegMark`, `CutLine` với Spot Color `CutContour`, `Crease`, `Bleed` nét đứt Cyan, `Design` khớp `0.000 mm`) mở trực tiếp trên Adobe Illustrator.
- **Cập nhật (Non-LOCKED):** [stickerTabV1Adapter.js](file:///c:/Source/Binh_file/tool-binh-file/resources/js/engine/stickerTabV1Adapter.js), [PdfEditor.jsx](file:///c:/Source/Binh_file/tool-binh-file/resources/js/components/PdfEditor.jsx), [PdfCanvasPreview.jsx](file:///c:/Source/Binh_file/tool-binh-file/resources/js/components/PdfCanvasPreview.jsx) — thêm bộ chọn **Chuẩn máy bế**, checkbox **Spot Color `CutContour`**, khung **Quiet Zone** trên Preview, nút **Xuất File AI phân lớp (.ai)**, và hiển thị song song 2 trạng thái **Hình học** vs **Tương thích máy**.
- **Kiểm thử:** [machineCompatibilityV1.test.mjs](file:///c:/Source/Binh_file/tool-binh-file/tests/machineCompatibilityV1.test.mjs) (`MC-01..MC-04`).

### Đợt 1 — Bleed & Contour Studio V1 (Chỉnh sửa trực tiếp, 4 chế độ Dieline & Cô lập Chữ ký Đa trang, `2026-11-26`)
- **Bước 0 (Khôi phục Baseline LOCKED):** Khôi phục `pdfExporter.js` về đúng SHA-256 LOCKED (`a77d15366d0fa35331046d01f9e1060e237a662d776cb75aff7d7a69f5ce1edd`) kèm bản sao lưu; xác minh **`17 / 17` file engine LOCKED** giữ nguyên SHA-256 100%.
- **Mới (Additive — 0 / 17 file engine LOCKED bị sửa):**
  - [contourEditHelpers.js](file:///c:/Source/Binh_file/tool-binh-file/resources/js/engine/contourEditHelpers.js): Helper hình học & chỉnh sửa không phá hủy ảnh gốc (`hitTestStickerAtMm`, `filterContoursByScope`, `resolveDielineModeContours` cho 4 chế độ `original` / `png_alpha` / `bleed_edge` / `none`, `preprocessCanvasForTracing` khử bóng + mặt nạ xóa/giữ thủ công, `mergeSelectedContours` theo `compIdx`, `applyCornerRoundingMm` bo góc cubic Bézier, `mapSliderControlsToTracerParams`).
  - [phase1BleedStudioV1.test.mjs](file:///c:/Source/Binh_file/tool-binh-file/tests/phase1BleedStudioV1.test.mjs): `P1-01..P1-08` (hit-test trực tiếp, phạm vi chọn & gộp theo `compIdx`, 4 chế độ Dieline, xử lý vùng thủ công không phá hủy, vô hiệu hóa chữ ký, PDF đa trang thật `Decal sticker pdf.pdf`, kiểm toán `17/17` SHA-256 LOCKED, và cô lập chữ ký per-page vs global).
- **Cập nhật (Non-LOCKED):**
  - [studioMultiPageState.js](file:///c:/Source/Binh_file/tool-binh-file/resources/js/engine/studioMultiPageState.js): Tách riêng **`computeGlobalBleedSettingsSignature`** (16 thông số toàn cục dùng chung các trang) và **`computePageEditSignature`** (5 trạng thái chỉnh sửa riêng từng trang: `perStickerOverrides`, `manualMaskRevision`, `mergedGroups`, `selectionScope`, `selectedIndices`), giữ tương thích ngược `computeBleedSettingsSignature`; cập nhật `getEffectivePageStage` và `partitionPagesForHandoff` kiểm chéo cả `bleedSignature` toàn cục và `pageEditSignature` theo từng trang.
  - [BleedAndContourStudio.jsx](file:///c:/Source/Binh_file/tool-binh-file/resources/js/components/BleedAndContourStudio.jsx): Tích hợp chọn trực tiếp trên canvas, chọn phạm vi ("Toàn trang" / "Đối tượng đang chọn"), 4 chế độ Dieline, công cụ cọ xóa/giữ thủ công, gộp đường bế, bo góc, lưu/khôi phục chỉnh sửa riêng từng trang (bao gồm `selectionScope`) trong `pdfPageCacheRef`, và tách `currentGlobalBleedSig` khỏi `activePageEditSig` để chỉnh Trang 1 rồi chuyển sang Trang 2 vẫn giữ cả 2 trang `BLEED_READY` khi chuyển sang Bình Tem, trong khi đổi thông số toàn cục (`bleedOffsetMm`) vẫn hạ các trang cũ về `CUT_READY`.
- **Kiểm thử & Build:** `28/28 PASS` (`phase1BleedStudioV1` 8/8 + `studioMultiPageState` 5/5 + `machineCompatibilityV1` 4/4 + `stickerTabV1Adapter` 4/4 + `singleStickerPipelineV1` 7/7), **`17/17` LOCKED SHA-256 khớp 100%**, `npm run build` (`vite build`) thành công trong `3.36s`.

### Đợt 2 — Hoàn thiện Bình Tem V1 & Sản xuất (`workflowAuditCompletionV1`, `2026-11-27`)
- **Mới / Cập nhật (Non-LOCKED — 0 / 17 file engine LOCKED bị sửa):**
  - [stickerTabV1Adapter.js](file:///c:/Source/Binh_file/tool-binh-file/resources/js/engine/stickerTabV1Adapter.js):
    - Sửa `fingerprintContours()` băm toàn bộ mọi contour trong `contoursMm` theo `cmd.to` / `cmd.c1` / `cmd.c2` (không bỏ sót contour giữa và không đọc `.p0`), đồng thời nối `cache.getBatchPlan()` / `cache.setBatchPlan()` theo khóa layout đầy đủ (trả thẳng từ cache khi lặp lại cùng layout).
    - Nối `marginIncludesMarks` (`true`: `Math.max(markClearance, margin)`; `false`: `markClearance + margin`) với `markClearance = markInsetMm + markSizeMm / 2 + quietZoneMm` lấy từ machine profile đang hoạt động (fallback `+2 mm`).
    - Nối đủ chế độ Bình Tem V1: `stickerUnit` (`single` vs `sheet`), `collation` (`stepAndRepeat` S&R vs `sequential` N-Up Multi-SKU qua `gridPackingH2.js`), `stickerLayout` (`simple` 0° vs `optimal` so sánh sức chứa 0°/90° và truyền rõ `gridSpec.rotationDeg`).
    - Cho phép `stickerTrimMarks === 'guillotine'`; sinh `v1TrimMarks` (dấu xén ngoài lưới, tránh quiet zone) và `paperGuides` (8 đoạn thanh canh giấy 4 mép tờ khi `showPaperGuides === true`) dùng chung 1:1 giữa Preview và `stampShopMarksAndSlugOnPage` trên PRINT PDF (giữ CUT PDF thuần đường bế + 4 boong).
    - Đồng bộ 100% `slugText` (`formatV1SlugText`) giữa Preview và PRINT PDF (ẩn hoàn toàn khi `!showSlugLine`).
    - Xuất `buildProductionReportV1(v1PlanState, exportResult)` tạo báo cáo sản xuất JSON đầy đủ.
  - [PdfEditor.jsx](file:///c:/Source/Binh_file/tool-binh-file/resources/js/components/PdfEditor.jsx): Thêm preset `D320x330` trong dropdown khổ giấy; mở lại các điều khiển `ĐƠN VỊ BÌNH` (`single`/`sheet`), `TÁC VỤ` (`stepAndRepeat`/`sequential`), `CÁCH XẾP` (`optimal`/`simple`, giữ `honeycomb`/`nesting` khóa kèm chú thích V1), `DẤU XÉN` (`none`/`guillotine`); thêm toggle `Thanh canh giấy (Paper Guides)` (`showPaperGuides`), sửa `isSingleContourMode` hỗ trợ PDF nhiều trang 1 tem/trang, thêm `whitespace-nowrap shrink-0` cho badge `PASS/WARNING/FAIL`, thêm nút `📋 Xuất Report sản xuất (JSON)` và bộ `Lưu / Tải / Xóa cấu hình mẫu` (`localStorage` key `printkit_v1_sticker_presets`).
  - [PdfCanvasPreview.jsx](file:///c:/Source/Binh_file/tool-binh-file/resources/js/components/PdfCanvasPreview.jsx): Vẽ `activeSheet.slugText` ở đỉnh giữa khớp PRINT PDF (ẩn khi `!activeSheet.slugText`), vẽ `activeSheet.v1TrimMarks` và `activeSheet.paperGuides` khớp 1:1 với PRINT PDF, và đồng bộ chiều xoay `90° CW` cho `v1Placement`.
  - [workflowAuditCompletionV1.test.mjs](file:///c:/Source/Binh_file/tool-binh-file/tests/workflowAuditCompletionV1.test.mjs): Bộ test `W2-01..W2-06` kiểm chứng toàn bộ tính năng Đợt 2 + PDF thật `Decal sticker pdf.pdf` (`99` tem/trang) + kiểm toán `17/17` SHA-256 LOCKED.
- **Kiểm thử & Build:** **`35 / 35` PASS (`0` fail)** (`workflowAuditCompletionV1` 6/6 + `phase1BleedStudioV1` 9/9 + `studioMultiPageState` 5/5 + `machineCompatibilityV1` 4/4 + `stickerTabV1Adapter` 4/4 + `singleStickerPipelineV1` 7/7), **`17 / 17` LOCKED SHA-256 nguyên vẹn 100%**, `npm run build` (`vite build`) thành công trong `3.17s`.

### Giai đoạn 3 & Giai đoạn 4 — Xem kết quả IN/BẾ theo cặp (PrynX) & Bình tem thông minh (`2026-11-27`)
- **Mới (Additive — 0 / 17 file engine LOCKED bị sửa):**
  - [pairPreviewEngine.js](file:///c:/Source/Binh_file/tool-binh-file/resources/js/engine/pairPreviewEngine.js): Engine thuần cho Giai đoạn 3 (`PAIR_VIEW_MODES`: `sideBySide`/`overlay`/`single`, `computeSyncedScrollPosition`, `computeSyncedZoom`, `analyzeArtworkCutOverlay` đo lệch tâm/lệch biên/lệch boong/min Bleed giữa Artwork và CUT, `buildPairThumbnailsModel` tạo thumbnail cặp IN + SVG vector BẾ theo từng tờ, `computePreviewPlanParitySignature` & `checkPreviewVsExportParity` kiểm tra sai lệch giữa Preview và PDF xuất cả trạng thái `STALE_EXPORT_VS_PREVIEW` lẫn byte-level `PAGE_COUNT_MISMATCH`, `SHEET_SIZE_MISMATCH`, `PLACEMENT_COUNT_MISMATCH`, `GEOMETRY_DEVIATION_EXCEEDED`).
  - [smartImpositionPlanner.js](file:///c:/Source/Binh_file/tool-binh-file/resources/js/engine/smartImpositionPlanner.js): Engine bình tem thông minh cho Giai đoạn 4 (`ROTATION_MODES`: `none`/`rot90`/`rot180`/`rot90_180`, `CLUSTER_MODES`: `none`/`by_model`/`by_quantity`/`by_order`, `generateSmartImpositionOptions` xếp tối ưu theo kích thước contour thực tế, hỗ trợ S&R, N-Up và **Hỗn hợp S&R + N-Up**, tự xoay `0°/90°/180°` khi được phép, tính & xếp hạng nhiều phương án bình kèm chỉ số `stickersPerSheet`, `physicalSheetsNeeded`, `wasteAreaCm2`, `wastePct`, `utilizationPct`, `overrunStickers` và `clusters`).
  - [phase3And4PairAndSmartImposition.test.mjs](file:///c:/Source/Binh_file/tool-binh-file/tests/phase3And4PairAndSmartImposition.test.mjs): Bộ test `P3-01..P3-04` & `P4-01..P4-05` (9 test: đồng bộ cuộn/zoom, kiểm lệch chồng lớp kèm tiêm lỗi + tờ trống + CUT path lỗi, Pair Thumbnails SVG, đối chiếu Preview↔PDF xuất kèm tiêm lỗi `STALE_EXPORT_VS_PREVIEW`/`SHEET_SIZE_MISMATCH`/`PLACEMENT_COUNT_MISMATCH`, xếp hạng đa phương án `0°/90°/180°` + xuất thật `180°`, hỗn hợp S&R+N-Up, chia cụm theo mẫu/số lượng/đơn hàng, khóa xoay `allowRotationMode='none'`, đồng bộ `selectedOptionId`/`runCountByPage`/null-qty ranking, và kiểm toán `17/17` SHA-256 LOCKED).
- **Cập nhật (Non-LOCKED — 1 shared `BatchPlan` duy nhất cho Preview & Export):**
  - [stickerTabV1Adapter.js](file:///c:/Source/Binh_file/tool-binh-file/resources/js/engine/stickerTabV1Adapter.js): Nối `smartImpositionPlanner.js` (`collation: 'mixed'`, `allowRotationMode`, `smartClusterMode`, `selectedImpositionOptionId`, `orderIdByPage`) và `pairPreviewEngine.js` (`previewParitySignature`, `overlayBySheet`, `previewParity` sau xuất trong `exportV1StickerBatchBundle`, mở rộng `buildProductionReportV1` giữ tương thích `PrintKitProductionReportV1.0` kèm `wasteMetrics`, `clusters`, `previewParity`).
  - [PdfCanvasPreview.jsx](file:///c:/Source/Binh_file/tool-binh-file/resources/js/components/PdfCanvasPreview.jsx): Giao diện xem cặp **PRINT | CUT cạnh nhau kiểu PrynX** với 2 viewport cuộn & kéo tay đồng bộ + zoom đồng bộ + con trỏ chữ thập đồng bộ, chế độ **Chồng lớp Kiểm lệch** (chỉnh độ mờ Artwork, màu nét CUT tương phản, hiện Bleed + thanh đo lệch mm trực tiếp), và banner cảnh báo **Sai lệch Preview ↔ PDF xuất**.
  - [PdfEditor.jsx](file:///c:/Source/Binh_file/tool-binh-file/resources/js/components/PdfEditor.jsx): Thanh chuyển nhanh `IN | BẾ` / `Chồng lớp` / `Đơn`, **Thumbnail theo từng cặp trang** (mini IN + mini vector CUT SVG + Δ lệch + nhãn cụm), bộ chọn **TÁC VỤ** (`mixed`), **XOAY TEM (`0°/90°/180°`)**, **CHIA CỤM** (mẫu / số lượng / đơn hàng có ô nhập mã đơn), bảng chọn **Phương án bình thông minh** và KPI **Hiệu suất & Giấy dư**.
