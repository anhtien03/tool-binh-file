import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProductionRunPlan, normalizeSpacingPolicy, estimateUniformGridCapacity, ProductionPlanningError } from '../resources/js/engine/productionPlanningH1.js';
const placement = (jobId, placementId, copiesPerRun = 1) => ({ jobId, placementId, copiesPerRun });
const template = (templateId, runCount, placements) => ({ templateId, runCount, sheetWidthMm: 320, sheetHeightMm: 330, placements });
const plan = (jobs, sheetTemplates, spacingPolicy) => buildProductionRunPlan({ jobs, sheetTemplates, spacingPolicy });
test('72 SKUs × 200: 3 templates × 200 runs, 600 sheets, 14,400 stickers', () => {
 const jobs = Array.from({ length: 72 }, (_, i) => ({ jobId: `SKU-${i+1}`, requestedQuantity: 200 }));
 const sheets = Array.from({ length: 3 }, (_, t) => template(`T${t}`, 200, Array.from({ length: 24 }, (_, i) => placement(`SKU-${t*24+i+1}`, `P${i}`))));
 const result = plan(jobs, sheets);
 assert.equal(result.physicalSheetCount, 600);
 assert.equal(result.ledger.reduce((n, r) => n + r.producedQuantity, 0), 14400);
 assert.equal(result.status, 'QUANTITY_MATCH');
 assert.equal(result.sheetTemplates.reduce((n, t) => n + t.placements.length, 0), 72);
});
test('multiple placements of same SKU and multiple templates aggregate correctly', () => {
 const result = plan([{jobId:'A',requestedQuantity:9}], [template('T1',2,[placement('A','P1',2),placement('A','P2')]),template('T2',3,[placement('A','P3')])]);
 assert.equal(result.ledger[0].producedQuantity,9);
});
test('short and excess quantity are not falsely marked ready', () => {
 const result = plan([{jobId:'A',requestedQuantity:2},{jobId:'B',requestedQuantity:1}], [template('T',1,[placement('A','P1'),placement('B','P2',2)])]);
 assert.equal(result.status,'QUANTITY_MISMATCH');
 assert.deepEqual(result.ledger.map(x=>x.status),['SHORT','EXCESS']);
});
test('bleed overlap policy does not silently change CUT gap', () => {
 assert.equal(normalizeSpacingPolicy({cutGapMm:2,bleedOutsetMm:1.5}).conservativeBboxGapMm,2);
 assert.equal(normalizeSpacingPolicy({cutGapMm:2,bleedOutsetMm:1.5,bleedPolicy:'enforce_clearance'}).conservativeBboxGapMm,3);
});
test('grid estimate is deterministic and not geometry-certified', () => {
 const x = estimateUniformGridCapacity({sheetWidthMm:320,sheetHeightMm:330,itemWidthMm:20,itemHeightMm:20,spacingPolicy:{cutGapMm:2}});
 assert.equal(x.columns,14);assert.equal(x.rows,15);assert.equal(x.capacity,210);assert.equal(x.geometryValidated,false);
});
test('unknown SKU blocks', () => assert.throws(() => plan([{jobId:'A',requestedQuantity:1}], [template('T',1,[placement('B','P')])]), {code:'UNKNOWN_JOB'}));
test('duplicate placement blocks', () => assert.throws(() => plan([{jobId:'A',requestedQuantity:1}], [template('T',1,[placement('A','P'),placement('A','P')])]), {code:'DUPLICATE_PLACEMENT'}));
test('duplicate template blocks', () => assert.throws(() => plan([{jobId:'A',requestedQuantity:1}], [template('T',1,[placement('A','P')]),template('T',1,[placement('A','Q')])]), {code:'DUPLICATE_TEMPLATE'}));
test('invalid numbers block rather than coercing', () => assert.throws(() => plan([{jobId:'A',requestedQuantity:1}], [template('T',1,[placement('A','P')])],{cutGapMm:NaN}), {code:'INVALID_CONFIG'}));
test('overflow blocks', () => assert.throws(() => plan([{jobId:'A',requestedQuantity:1}], [template('T',Number.MAX_SAFE_INTEGER,[placement('A','P',2)])]), {code:'QUANTITY_OVERFLOW'}));
test('invalid sheet margins block', () => assert.throws(() => plan([{jobId:'A',requestedQuantity:1}], [{...template('T',1,[placement('A','P')]),marginsMm:{left:200,right:200}}]), {code:'INVALID_CONFIG'}));
test('no implicit production readiness', () => {
 const r=plan([{jobId:'A',requestedQuantity:1}],[template('T',1,[placement('A','P')])]);
 assert.equal(r.geometryValidated,false);assert.equal(r.outputValidated,false);assert.equal(r.machineVerified,false);
});
