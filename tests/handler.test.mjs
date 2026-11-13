import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../functions/replenishmentApi/handler.mjs';
test('health test works without legacy context fields or a logged-in identity', async () => {
  let identityCalls = 0;
  const main = createHandler(() => ({ auth: { getUserInfo() { identityCalls++; throw { code: 'INVALID_CONTEXT' }; } }, invoke: async (_, identity) => ({ status: 200, identity }) }));
  assert.deepEqual(await main({ path: '/health', method: 'GET' }, {}), { status: 200, identity: null });
  assert.equal(identityCalls, 0);
});
test('handler trusts runtime user info and ignores spoofed event identities', async () => {
  const main = createHandler(() => ({ auth: { getUserInfo: () => ({ uid: 'verified-runtime-user', isAnonymous: false }) }, invoke: async (_, identity) => identity }));
  assert.deepEqual(await main({ path: '/api/bootstrap', method: 'GET', uid: 'fake-admin', context: { uid: 'fake-admin' } }, {}), { uid: 'verified-runtime-user', anonymous: false });
});
test('handler preserves runtime anonymous marker', async () => {
  const main = createHandler(() => ({ auth: { getUserInfo: () => ({ uid: 'anon', isAnonymous: true }) }, invoke: async (_, identity) => identity }));
  assert.equal((await main({ path: '/api/state', method: 'GET' }, {})).anonymous, true);
});
test('startup errors return a safe stage and code without raw messages', async () => {
  const main = createHandler(() => { throw { code: 'ASSET_NOT_FOUND', message: 'PRIVATE_TOKEN_MUST_NOT_LEAK', stack: 'private data' }; });
  const result = await main({ path: '/health', method: 'GET' }, {});
  assert.equal(result.status, 500); assert.equal(result.data.stage, 'initialize'); assert.equal(result.data.code, 'ASSET_NOT_FOUND');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_TOKEN'));
});
test('identity lookup errors identify the failing stage', async () => {
  const main = createHandler(() => ({ auth: { getUserInfo() { throw { code: 'IDENTITY_UNAVAILABLE' }; } }, invoke: async () => assert.fail('must not invoke') }));
  const result = await main({ path: '/api/state', method: 'GET' }, {});
  assert.equal(result.data.stage, 'identity'); assert.equal(result.data.code, 'IDENTITY_UNAVAILABLE');
});
