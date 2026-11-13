import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createService } from '../functions/replenishmentApi/service.mjs';
import { autoLayout, retainLayout, validateCatalog, validateLayout } from '../shared/board-layout.mjs';
import { memoryStore } from './memory-store.mjs';

const catalog = JSON.parse(await readFile(new URL('../private/catalog.json', import.meta.url)));
const layout = JSON.parse(await readFile(new URL('../private/layout.json', import.meta.url)));
const admin = { uid: 'admin' }, inspector = { uid: 'inspector' };
const newItem = { L: 'TEST-PART', M: '测试料盒', N: 'M 6', BI: '80', BX: '21/3-4', row: 2 };
let sequence = 0;
const op = () => 'layout_test_' + String(++sequence).padStart(16, '0');

function fixture() {
  const store = memoryStore();
  const call = createService({ store, catalog, layout, referenceImage: 'BASE_IMAGE', config: {
    APP_ADMIN_UIDS: 'admin', APP_INSPECTOR_UIDS: 'inspector'
  } });
  const get = (path, body = {}) => call({ method: 'GET', path, body }, admin);
  const post = (path, body, identity = admin) => call({ method: 'POST', path, body }, identity);
  return { get, post, store };
}
const payload = (items, revision = 0) => ({
  catalog: items, layout: autoLayout(items), layoutRevision: revision, source: 'warehouse.xlsx', operationId: op()
});

test('baseline, exact spans and all 16 racks can be generated from the original BX list', () => {
  const clean = validateCatalog(catalog);
  assert.deepEqual(validateLayout(layout, clean), validateLayout(retainLayout(layout, clean), clean));
  const original = validateLayout(layout, clean);
  const fullWidth = original.find(r => r.rack === 10).cells.find(c => c.location === '10/25');
  assert.deepEqual(fullWidth, { location: '10/25', row: 5, col: 1, span: 12, rowSpan: 2 });
  const generated = validateLayout(autoLayout(clean, 6), clean);
  assert.equal(generated.length, 16);
  assert.equal(generated.flatMap(r => r.cells).length, 257);
  assert.equal(generated.find(r => r.rack === 5).cells.find(c => c.location === '5/13-14').span, 4);
});

test('validation catches duplicate and overlapping BX, missing matches, and overlapping or out-of-bounds cells', () => {
  const alias = { ...newItem, BX: '021／03–04', row: 3 };
  assert.throws(() => validateCatalog([newItem, alias]), /重复/);
  assert.throws(() => validateCatalog([newItem, { ...newItem, BX: '21/4' }]), /编号区间重叠/);
  assert.throws(() => validateCatalog([{ ...newItem, BX: '45218', BI: '' }]), /BX 无效/);
  const incoming = validateCatalog([newItem, { ...newItem, BX: '21/5' }]);
  const draw = autoLayout(incoming);
  const group = draw[0], [first, second] = group.cells;
  assert.throws(() => validateLayout([{ ...group, cells: [first, { ...second, col: first.col }] }], incoming), /网格重叠/);
  assert.throws(() => validateLayout([{ ...group, cells: [{ ...first, col: 12 }] }], incoming), /层、列或跨格无效/);
  assert.throws(() => validateLayout([{ ...group, cells: [{ ...first, location: '21/1' }] }], incoming), /无法匹配/);
});

test('only an administrator can publish, a stale version conflicts, and other terminals receive a coherent snapshot', async () => {
  const t = fixture();
  const next = payload([newItem]);
  assert.equal((await t.post('/api/layout', next, inspector)).status, 403);
  const other = payload([{ ...newItem, L: 'TEST-PART-OTHER' }]);
  const results = await Promise.all([t.post('/api/layout', next), t.post('/api/layout', other)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const winner = results[0].status === 200 ? next : other;
  assert.equal((await t.post('/api/layout', winner)).data.replay, true);
  const snapshot = (await t.get('/api/state', { layoutRevision: 0 })).data;
  assert.equal(snapshot.layoutRevision, 1);
  assert.equal(snapshot.board.catalog[0].L, winner.catalog[0].L);
  assert.equal(snapshot.events[0].action, 'layout');
  assert.equal((await t.get('/api/state', { layoutRevision: 1 })).data.board, undefined);
  assert.equal((await t.get('/api/bootstrap')).data.catalog[0].BX, newItem.BX);
});

test('import protects open bins, keeps order snapshots, and routes new bins through reporting and refill', async () => {
  const t = fixture(), old = catalog[0];
  const report = (BX, layoutRevision, expectedRevision = 0, target = 'pending') =>
    t.post('/api/bin', { location: BX, layoutRevision, expectedRevision, target, operationId: op() });
  assert.equal((await report(old.BX, 0)).status, 200);
  const existingOrder = (await t.post('/api/requests', { locations: [old.BX], layoutRevision: 0, operationId: op() })).data.id;
  for (const candidate of [[newItem], [{ ...old, L: 'MOVED' }, newItem], [{ ...old, BI: '999' }, newItem]]) {
    assert.equal((await t.post('/api/layout', payload(candidate))).status, 409);
  }
  const update = payload([{ ...old, M: '更新后的描述' }, newItem]);
  assert.equal((await t.post('/api/layout', update)).status, 200);
  assert.equal((await report(newItem.BX, 0)).status, 409);
  assert.equal((await report(newItem.BX, 1)).status, 200);
  const state = (await t.get('/api/state', { layoutRevision: 0 })).data;
  assert.equal(state.bins.find(b => b.location === old.BX).request_id, existingOrder);
  assert.deepEqual(state.orders[0].items[0], old);
  const newOrder = await t.post('/api/requests', { locations: [newItem.BX], layoutRevision: 1, operationId: op() });
  assert.equal(newOrder.status, 200);
  assert.deepEqual((await t.store.get('orders', newOrder.data.id)).items[0], newItem);
  assert.equal((await report(newItem.BX, 1, 2, 'full')).status, 200);
});
