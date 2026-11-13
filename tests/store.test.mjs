import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudStore } from '../functions/replenishmentApi/store.mjs';
import { AppError } from '../functions/replenishmentApi/service.mjs';
function fixture() {
  let saved = null, committed = 0, rolledBack = 0, starts = 0;
  let commitError = null;
  const document = (name, id, transaction = false) => ({
    name, id,
    async get() { return { data: saved ? (transaction ? { _id: id, ...saved } : [{ _id: id, ...saved }]) : (transaction ? null : []) }; },
    async set(data) { saved = data; return {}; }
  });
  const db = {
    collection(name) { return { doc(id) { return document(name, id); } }; },
    async startTransaction() { starts++; return {
      collection(name) { return { doc(id) { return document(name, id, true); } }; },
      async commit() { if (commitError) { const error = commitError; commitError = null; throw error; } committed++; },
      async rollback() { rolledBack++; }
    }; }
  };
  return { store: cloudStore(db), stats: () => ({ committed, rolledBack, starts, saved }), conflict() { commitError = { code: 'DATABASE_TRANSACTION_CONFLICT' }; } };
}
test('SDK store handles array reads, transaction snapshots, strips _id and returns callback result', async () => {
  const t = fixture(); assert.equal(await t.store.get('state', 'current'), null);
  await t.store.set('state', 'current', { _id: 'current', bins: {} });
  assert.deepEqual(await t.store.get('state', 'current'), { bins: {} });
  assert.equal(await t.store.transaction(async tx => { assert.deepEqual(await tx.get('state', 'current'), { bins: {} }); await tx.set('state', 'current', { _id: 'current', bins: { a: 1 } }); return 'committed-result'; }), 'committed-result');
  assert.equal(t.stats().committed, 1); assert.ok(!('_id' in t.stats().saved));
});
test('SDK store rolls back and never retries application failures', async () => {
  const t = fixture(); await assert.rejects(() => t.store.transaction(async () => { throw new AppError('stale', 409); }), /stale/);
  assert.deepEqual(t.stats(), { committed: 0, rolledBack: 1, starts: 1, saved: null });
});
test('SDK store retries a conflict and preserves successful return value', async () => {
  const t = fixture(); t.conflict(); assert.equal(await t.store.transaction(async () => 7), 7);
  assert.equal(t.stats().starts, 2); assert.equal(t.stats().rolledBack, 1); assert.equal(t.stats().committed, 1);
});
