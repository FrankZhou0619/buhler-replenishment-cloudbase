import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createService, recipients, csv } from '../functions/replenishmentApi/service.mjs';
import { memoryStore } from './memory-store.mjs';
const catalog = JSON.parse(await readFile(new URL('../private/catalog.json', import.meta.url)));
const layout = JSON.parse(await readFile(new URL('../private/layout.json', import.meta.url)));
const admin = { uid: 'admin' }, inspector = { uid: 'inspector' }, refill = { uid: 'refill' }, other = { uid: 'operator' };
const token = 'TEST_ONLY_TOKEN_NOT_A_REAL_CREDENTIAL';
let seq = 0;
const op = () => `operation_${String(++seq).padStart(16, '0')}`;
function setup(options = {}) {
  const store = memoryStore(), calls = [];
  const service = createService({ store, catalog, layout, referenceImage: 'PRIVATE_IMAGE', config: { APP_ADMIN_UIDS: 'admin', APP_INSPECTOR_UIDS: 'inspector', APP_REFILL_UIDS: 'refill', APP_ALLOWED_UIDS: 'operator', APP_USER_LABELS: '{"admin":"Frank"}', ...options.config }, fetchImpl: options.fetchImpl || (async (url, init) => { calls.push({ url, ...JSON.parse(init.body) }); return new Response(null, { status: 202, headers: { 'x-message-id': `message-${calls.length}` } }); }), clock: () => '2026-11-03T09:00:00.000Z' });
  const invoke = (path, body, identity = admin, method = body === undefined ? 'GET' : 'POST') => service({ path, method, body }, identity);
  const pending = (location, identity = admin, expectedRevision = 0) => invoke('/api/bin', { location, target: 'pending', expectedRevision, operationId: op(), operator: 'SPOOF' }, identity);
  const settings = (identity = admin) => invoke('/api/settings', { recipients: 'one@example.invalid; two@example.invalid', mailFrom: 'sender@example.invalid', mailFromName: '测试补料' }, identity);
  const order = async (locations = [catalog[0].BX]) => { for (const loc of locations) assert.equal((await pending(loc)).status, 200); const result = await invoke('/api/requests', { locations, operationId: op() }); assert.equal(result.status, 200); return result.data.id; };
  return { store, calls, invoke, pending, settings, order };
}
test('private bootstrap rejects absent, anonymous and unapproved callers', async () => {
  const t = setup();
  for (const identity of [{}, { uid: 'admin', anonymous: true }, { uid: 'stranger' }]) {
    const result = await t.invoke('/api/bootstrap', undefined, identity);
    assert.ok([401, 403].includes(result.status)); assert.ok(!JSON.stringify(result).includes(catalog[0].L));
  }
  const result = await t.invoke('/api/bootstrap'); assert.equal(result.data.catalog.length, 257); assert.equal(result.data.actor.label, 'Frank');
});
test('master data retains 257 unique locations and 210 mapped cells', () => {
  assert.equal(new Set(catalog.map(i => i.BX)).size, 257);
  const cells = layout.flatMap(r => r.cells); assert.equal(cells.length, 210); assert.equal(new Set(cells.map(c => c.location)).size, 210);
  assert.ok(cells.every(c => catalog.some(i => i.BX === c.location)));
});
test('unconfigured admin denies every data operation', async () => {
  const t = setup({ config: { APP_ADMIN_UIDS: '' } }); assert.equal((await t.invoke('/api/state')).status, 503);
});
test('server ignores a spoofed operator name', async () => {
  const t = setup(); await t.pending(catalog[0].BX); const state = await t.invoke('/api/state');
  assert.equal(state.data.events[0].actor_uid, 'admin'); assert.equal(state.data.events[0].operator, 'Frank'); assert.ok(!t.store.dump().includes('SPOOF'));
});
test('roles enforce inspector/refill capabilities and admin-only settings', async () => {
  const t = setup(), location = catalog[0].BX;
  assert.equal((await t.pending(location, refill)).status, 403);
  assert.equal((await t.pending(location, inspector)).status, 200);
  assert.equal((await t.invoke('/api/bin', { location, target: 'full', expectedRevision: 1, operationId: op() }, inspector)).status, 403);
  assert.equal((await t.settings(other)).status, 403);
  assert.equal((await t.invoke('/api/bin', { location, target: 'full', expectedRevision: 1, operationId: op() }, refill)).status, 200);
});
test('stale revisions and concurrent reports cannot overwrite newer changes', async () => {
  const t = setup(), location = catalog[0].BX;
  const results = await Promise.all([t.pending(location), t.pending(location, other)]);
  assert.deepEqual(results.map(v => v.status).sort(), [200, 409]);
  assert.equal((await t.invoke('/api/state')).data.bins[0].revision, 1);
});
test('operation retries are idempotent and tied to actor and payload', async () => {
  const t = setup(), body = { location: catalog[0].BX, target: 'pending', expectedRevision: 0, operationId: op() };
  assert.equal((await t.invoke('/api/bin', body)).status, 200);
  assert.equal((await t.invoke('/api/bin', body)).data.replay, true);
  assert.equal((await t.invoke('/api/bin', body, other)).status, 409);
  assert.equal((await t.invoke('/api/bin', { ...body, location: catalog[1].BX })).status, 409);
});
test('order creation is atomic, uses server catalog and fixed administrator recipients', async () => {
  const t = setup(); await t.settings(); await t.pending(catalog[0].BX);
  const failed = await t.invoke('/api/requests', { locations: [catalog[0].BX, catalog[1].BX], operationId: op() });
  assert.equal(failed.status, 409); assert.equal((await t.invoke('/api/state')).data.bins[0].request_id, null);
  const created = await t.invoke('/api/requests', { locations: [catalog[0].BX], operationId: op(), recipients: 'attacker@example.invalid', items: [{ L: 'SPOOF' }] });
  const row = await t.store.get('orders', created.data.id);
  assert.deepEqual(row.items, [catalog[0]]); assert.equal(row.recipient, 'one@example.invalid; two@example.invalid');
});
test('all 257 bins fit one short transaction, and order snapshot survives replenishment', async () => {
  const t = setup(), locations = catalog.map(i => i.BX);
  for (const loc of locations) await t.pending(loc);
  t.store.resetCount();
  const created = await t.invoke('/api/requests', { locations, operationId: op() }); assert.equal(created.status, 200); assert.ok(t.store.count() < 15);
  const location = locations[0];
  assert.equal((await t.invoke('/api/bin', { location, target: 'cancel', expectedRevision: 2, operationId: op() })).status, 409);
  await t.invoke('/api/bin', { location, target: 'full', expectedRevision: 2, operationId: op() }, refill);
  const row = await t.store.get('orders', created.data.id); assert.equal(row.items.length, 257); assert.equal(row.completed_locations.length, 1);
  const state = await t.invoke('/api/state'); assert.equal(state.data.todayCompleted, 1); assert.equal(state.data.orders[0].completed_count, 1);
});
test('batch refill updates an order and daily counts once, and rejects unauthorized or stale writes', async () => {
  const t = setup();
  const locations = catalog.slice(0, 3).map(item => item.BX);
  const orderId = await t.order(locations);
  const bins = locations.slice(0, 2).map(location => ({ location, expectedRevision: 2 }));
  const request = { bins, layoutRevision: 0, operationId: op() };
  assert.equal((await t.invoke('/api/bin/confirm', request, inspector)).status, 403);
  assert.equal((await t.invoke('/api/bin/confirm', { ...request, bins: [bins[0], { ...bins[1], expectedRevision: 1 }] }, refill)).status, 409);
  assert.equal((await t.invoke('/api/state')).data.todayCompleted, 0);
  assert.equal((await t.invoke('/api/bin/confirm', request, refill)).data.count, 2);
  assert.equal((await t.invoke('/api/bin/confirm', request, refill)).data.replay, true);
  const state = (await t.invoke('/api/state')).data;
  assert.equal(state.todayCompleted, 2);
  assert.equal(state.bins.find(bin => bin.location === locations[2]).status, 'pending');
  assert.deepEqual((await t.store.get('orders', orderId)).completed_locations, locations.slice(0, 2));
  assert.equal(state.events.filter(event => event.action === 'full').length, 2);
});
test('batch refill handles unassigned and off-layout bins, and refuses mixed-order submissions atomically', async () => {
  const t = setup();
  const mapped = new Set(layout.flatMap(rack => rack.cells.map(cell => cell.location)));
  const offLayout = catalog.find(item => !mapped.has(item.BX)).BX;
  const other = catalog.find(item => item.BX !== offLayout).BX;
  await t.order([other]);
  await t.pending(offLayout);
  const request = { bins: [{ location: offLayout, expectedRevision: 1 }], layoutRevision: 0, operationId: op() };
  assert.equal((await t.invoke('/api/bin/confirm', { ...request, bins: [...request.bins, { location: other, expectedRevision: 2 }] }, refill)).status, 409);
  assert.equal((await t.invoke('/api/state')).data.todayCompleted, 0);
  assert.equal((await t.invoke('/api/bin/confirm', request, refill)).data.count, 1);
});
test('5S preserves the current rack, trusted operator and approval order through rework', async () => {
  const t = setup({ config: { APP_USER_LABELS: '{"admin":"Frank","operator":"清洁人员","inspector":"布勒线长"}' } });
  const rack = layout[0].rack;
  const latest = () => t.invoke('/api/five-s', { rack, layoutRevision: 0 });
  const read = (rackValue = rack, layoutRevision = 0) => t.invoke('/api/five-s', { rack: rackValue, layoutRevision }, admin, 'GET');
  assert.deepEqual((await read()).data, { latest: [], history: [] });
  assert.equal((await read(999)).status, 400);
  assert.equal((await read(rack, 1)).status, 409);
  const complete = { id: op(), rack, layoutRevision: 0, action: 'complete', expectedId: null, operator: 'SPOOF' };
  assert.equal((await t.invoke('/api/five-s', complete, refill)).status, 403);
  assert.equal((await t.invoke('/api/five-s', complete, other)).data.event.operator, '清洁人员');
  assert.equal((await t.invoke('/api/five-s', complete, other)).data.replay, true);
  assert.equal((await t.invoke('/api/five-s', { ...complete, id: op() }, other)).status, 409);
  const review = { ...complete, id: op(), action: 'rework', expectedId: complete.id };
  assert.equal((await t.invoke('/api/five-s', { ...review, note: '货架需清洁' }, other)).status, 403);
  assert.equal((await t.invoke('/api/five-s', review, inspector)).status, 400);
  assert.equal((await t.invoke('/api/five-s', { ...review, note: '货架需清洁' }, inspector)).status, 200);
  const correct = { ...complete, id: op(), action: 'correct', expectedId: review.id };
  assert.equal((await t.invoke('/api/five-s', correct, other)).status, 200);
  const pass = { ...complete, id: op(), action: 'pass', expectedId: correct.id };
  assert.equal((await t.invoke('/api/five-s', pass, inspector)).status, 200);
  const records = (await read()).data;
  assert.deepEqual(records.latest, [{ id: pass.id, rack, action: 'pass' }]);
  assert.deepEqual(records.history.map(event => event.action), ['pass', 'correct', 'rework', 'complete']);
  assert.ok(!t.store.dump().includes('SPOOF'));
  assert.equal((await t.store.get('state', `five-s-rack-${rack}`)).history[0].actor_uid, 'inspector');
});
test('two recipients get separate submissions and no credentials are persisted', async () => {
  const t = setup(); await t.settings(); const id = await t.order();
  assert.equal((await t.invoke(`/api/requests/${id}/send`, { apiToken: token })).status, 200);
  assert.equal(t.calls.length, 2); assert.ok(t.calls.every(c => c.to.length === 1 && c.attachments.length === 1));
  assert.equal(t.calls[0].to[0].email, 'one@example.invalid'); assert.equal(t.calls[1].to[0].email, 'two@example.invalid');
  assert.ok(!t.store.dump().includes(token));
  assert.equal((await t.invoke(`/api/requests/${id}/send`, { apiToken: token })).data.alreadySent, true); assert.equal(t.calls.length, 2);
});
test('partial success commits receipts and retry skips already-submitted recipient', async () => {
  const targets = []; let count = 0;
  const t = setup({ fetchImpl: async (_, init) => { const email = JSON.parse(init.body).to[0].email; targets.push(email); count++; return count === 2 ? Response.json({ message: 'The to recipient limit is exceeded. #MS42205' }, { status: 422 }) : new Response(null, { status: 202, headers: { 'x-message-id': `id-${count}` } }); } });
  await t.settings(); const id = await t.order();
  assert.equal((await t.invoke(`/api/requests/${id}/send`, { apiToken: token })).status, 502);
  assert.equal((await t.store.get('orders', id)).status, 'partial');
  assert.equal((await t.invoke(`/api/requests/${id}/send`, { apiToken: token })).status, 200);
  assert.deepEqual(targets, ['one@example.invalid', 'two@example.invalid', 'two@example.invalid']);
});
test('unknown provider result blocks blind retries', async () => {
  let count = 0; const t = setup({ fetchImpl: async () => { count++; throw new Error('network'); } });
  await t.settings(); const id = await t.order();
  assert.equal((await t.invoke(`/api/requests/${id}/send`, { apiToken: token })).status, 502);
  assert.equal((await t.store.get('orders', id)).status, 'uncertain');
  assert.equal((await t.invoke(`/api/requests/${id}/send`, { apiToken: token })).status, 409); assert.equal(count, 1);
});
test('provider 5xx or 202 without receipt is treated as unknown', async () => {
  for (const status of [500, 202]) {
    const t = setup({ fetchImpl: async () => new Response(null, { status }) }); await t.settings(); const id = await t.order();
    await t.invoke(`/api/requests/${id}/send`, { apiToken: token }); assert.equal((await t.store.get('orders', id)).status, 'uncertain');
  }
});
test('provider failures redact token from persisted errors', async () => {
  const t = setup({ fetchImpl: async () => Response.json({ message: `Authorization Bearer ${token}` }, { status: 422 }) });
  await t.settings(); const id = await t.order(); await t.invoke(`/api/requests/${id}/send`, { apiToken: token });
  assert.ok(!t.store.dump().includes(token));
});
test('settings reject persisted tokens, malformed addresses and arbitrary recipient changes', async () => {
  const t = setup(); assert.equal((await t.invoke('/api/settings', { apiToken: token })).status, 400);
  assert.throws(() => recipients('two emails @example.invalid')); assert.equal(recipients('A@b.invalid； a@b.invalid, c@d.invalid'), 'A@b.invalid; c@d.invalid');
  await t.settings(); const id = await t.order();
  assert.equal((await t.invoke(`/api/requests/${id}/send`, { apiToken: token, recipients: 'attacker@example.invalid' })).status, 409); assert.equal(t.calls.length, 0);
});
test('CSV preserves the five specified columns and escapes formula-like strings', () => {
  const value = csv([{ L: '=1+2', M: 'a,"b"', N: 'M 6', BI: '10', BX: '1/1' }]);
  assert.ok(value.startsWith('\ufeff')); assert.ok(value.includes('"\'=1+2"')); assert.ok(value.includes('"a,""b"""'));
  assert.equal(value.split('\r\n')[0].split(',').length, 5);
});
