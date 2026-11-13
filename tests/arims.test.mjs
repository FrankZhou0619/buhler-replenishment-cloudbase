import assert from 'node:assert/strict';
import test from 'node:test';
import { ARIMS_BASE } from '../functions/replenishmentApi/arims.mjs';
import { createService } from '../functions/replenishmentApi/service.mjs';

const admin = { uid: 'admin' };
const token = 'local-session-value';
const login = { action: 'login', username: 'local test user', password: 'local-pw & "引号"' };
const stocklist = { action: 'stocklist', token, customerId: 'TEST-1' };

function setup(fetchImpl) {
  const invoke = createService({
    catalog: [], config: { APP_ADMIN_UIDS: 'admin', APP_ALLOWED_UIDS: 'operator' }, fetchImpl
  });
  return (body, identity = admin, startedAt) => invoke(
    { path: '/api/arims', method: 'POST', uid: admin.uid, body }, identity, startedAt
  );
}

test('ARIMS requires a verified admin and rejects a customer path traversal before calling upstream', async () => {
  let calls = 0;
  const run = setup(async () => { calls++; });
  assert.equal((await run(login, null)).status, 401);
  assert.equal((await run(login, { ...admin, anonymous: true })).status, 401);
  assert.equal((await run(login, { uid: 'operator' })).status, 403);
  assert.equal((await run({ ...stocklist, customerId: '../auth/logout' })).status, 400);
  assert.equal(calls, 0);
});

test('ARIMS forwards form credentials only to the fixed URL and redacts them in diagnostics', async () => {
  const run = setup(async (url, options) => {
    assert.equal(url, `${ARIMS_BASE}/auth/login`);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(new URLSearchParams(options.body).get('user'), login.username);
    assert.equal(new URLSearchParams(options.body).get('password'), login.password);
    return Response.json({
      authentication: token,
      permissions: ['REST_STOCK_LIST'],
      debug: login.password
    }, { headers: { 'x-request-id': token, 'set-cookie': 'private-cookie' } });
  });
  const { status, data: { token: loginToken, ...data } } = await run(login);
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(loginToken, token);
  assert.deepEqual(data.permissions, ['REST_STOCK_LIST']);
  const diagnostics = JSON.stringify(data);
  for (const secret of [token, 'local-pw', 'private-cookie']) {
    assert.ok(!diagnostics.includes(secret));
  }
});

test('stocklist and logout preserve ARIMS HTTP status without invalidating the CloudBase session', async () => {
  const xml = '<root><item><customerItemNumber>TEST-1</customerItemNumber></item></root>';
  const run = setup(async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.body, undefined);
    if (url.endsWith('/stocklist/TEST-1')) {
      assert.equal(options.method, 'GET');
      return new Response(xml);
    }
    assert.equal(url, `${ARIMS_BASE}/auth/logout`);
    assert.equal(options.method, 'POST');
    return new Response(token, { status: 401 });
  });
  const stock = await run(stocklist);
  assert.equal(stock.data.responseBody, xml);
  assert.equal(stock.data.upstreamStatus, 200);
  const expired = await run({ action: 'logout', token });
  assert.equal(expired.status, 200);
  assert.equal(expired.data.upstreamStatus, 401);
  assert.equal(expired.data.code, 'UPSTREAM_HTTP');
  assert.ok(!JSON.stringify(expired).includes(token));
});

test('ARIMS reports a bounded response and respects the remaining invocation budget', async () => {
  const tooLarge = await setup(async () => new Response('x'.repeat(1024 * 1024 + 1)))(stocklist);
  assert.equal(tooLarge.data.code, 'RESPONSE_TOO_LARGE');
  assert.equal(tooLarge.data.upstreamStatus, 200);

  let calls = 0;
  const waiting = setup(async (_url, options) => {
    calls++;
    return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  });
  assert.equal((await waiting(stocklist, admin, Date.now() - 3000)).data.code, 'UPSTREAM_TIMEOUT');
  assert.equal(calls, 0);
  const timeout = await waiting(stocklist, admin, Date.now() - 2300);
  assert.equal(timeout.status, 504);
  assert.equal(timeout.data.code, 'UPSTREAM_TIMEOUT');
  assert.equal(calls, 1);
});
