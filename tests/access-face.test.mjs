import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccess } from '../functions/replenishmentApi/access.mjs';
import { createFaceGateway } from '../functions/replenishmentApi/face-gateway.mjs';
import { createFaceProtocol } from '../functions/replenishmentApi/face-protocol.mjs';
import { createHandler } from '../functions/replenishmentApi/handler.mjs';
import { createService } from '../functions/replenishmentApi/service.mjs';
import { memoryStore } from './memory-store.mjs';

const manager = { uid: 'admin1' };
const worker = { uid: 'worker1' };
const colleague = { uid: 'worker2' };
const lead = { uid: 'lead1' };
const config = {
  APP_ADMIN_UIDS: manager.uid, APP_ALLOWED_UIDS: 'legacy1,worker2', APP_FACE_ENABLED: '1',
  APP_FACE_NOTICE: 'Synthetic test notice', APP_FACE_NOTICE_VERSION: 'test-1',
  APP_FACE_ORIGIN: 'https://dashboard.example.test'
};
const item = { BX: '1/1', L: 'ITEM', M: '测试', N: 'M6', BI: '20' };
const fakePhoto = Buffer.concat([Buffer.from([255,216,255]), Buffer.alloc(180, 4)]).toString('base64');
const fakeVideo = (i = 0) => Buffer.concat([Buffer.from('0000ftyp'), Buffer.alloc(100, i)]).toString('base64');

function setup() {
  let time = Date.now(), rev = 0;
  const store = memoryStore();
  const clock = () => new Date(time).toISOString();
  const access = createAccess({ store, config, clock });
  const api = createService({ store, catalog: [item], layout: [], config, clock });
  const tickets = [], compares = [];
  let faceResult = { Result: 'Success', Sim: 89, BestFrameBase64: fakePhoto };
  const provider = {
    actions: async () => '1,2',
    compare: async request => { compares.push(request); return faceResult; }
  };
  const protocol = createFaceProtocol({
    store, access, provider, encryptionKey: Buffer.alloc(32, 8), now: () => time,
    issueTicket: async user => { tickets.push(user); return 'signed-session-ticket'; }
  });
  const invoke = (path, body, identity = manager) => api({ path, method: body ? 'POST' : 'GET', body }, identity);
  const add = async (identity, role, enabled = true, username = identity.uid) => {
    const response = await invoke('/api/access/member', { uid: identity.uid, username, label: identity.uid, role, enabled, revision: rev });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    rev = response.data.revision;
    return response;
  };
  const changeFace = async (identity, action) => {
    rev = (await invoke('/api/access')).data.revision;
    const response = await invoke('/api/access/face', { uid: identity.uid, action, revision: rev });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    rev = response.data.revision;
  };
  const enroll = async (identity, value = 1) => {
    const { data: { grant }, status } = await invoke('/api/face/enroll', { consent: true, noticeVersion: config.APP_FACE_NOTICE_VERSION }, identity);
    assert.equal(status, 200);
    const start = await protocol.begin({ action: 'beginEnrollment', grant });
    await assert.rejects(protocol.begin({ action: 'beginEnrollment', grant }), { status: 409 });
    assert.deepEqual(await protocol.finish({ ...start, photo: fakePhoto, video: fakeVideo(value) }), { enrolled: true });
    rev = (await invoke('/api/access')).data.revision;
  };
  return { access, protocol, store, tickets, compares, invoke, add, changeFace, enroll,
    setResult: value => { faceResult = value; }, elapse: ms => { time += ms; } };
}

test('members of the same group retain separate identities and workers can undo only their own report', async () => {
  const t = setup();
  await t.add(worker, 'worker'); await t.add(colleague, 'worker'); await t.add(lead, 'lead');
  assert.equal((await t.invoke('/api/access', undefined, worker)).status, 403);
  assert.equal((await t.invoke('/api/access/member', { uid: 'worker1', username: 'worker1', label: 'Worker', role: 'admin', enabled: true, revision: 3 }, worker)).status, 403);
  const bin = (identity, target, expectedRevision, id) => t.invoke('/api/bin', { location: item.BX, target, expectedRevision, operationId: String(id).padStart(16, '0') }, identity);
  assert.equal((await bin(worker, 'pending', 0, 1)).status, 200);
  assert.equal((await bin(colleague, 'cancel', 1, 2)).status, 403);
  assert.equal((await t.invoke('/api/requests', { locations: [item.BX], operationId: 'dispatch-worker1' }, worker)).status, 403);
  assert.equal((await bin(worker, 'cancel', 1, 3)).status, 200);
  await bin(worker, 'pending', 2, 4);
  assert.equal((await t.invoke('/api/requests', { locations: [item.BX], operationId: 'dispatch-lead001' }, lead)).status, 200);
  await t.add(colleague, 'worker', false);
  assert.equal((await t.invoke('/api/state', undefined, colleague)).status, 403);
  assert.equal((await t.invoke('/api/bootstrap', undefined, { uid: 'legacy1' })).data.actor.role, 'operator');
});

test('correcting a UID preserves the member details, revokes the original identity and invalidates its face binding', async () => {
  const t = setup();
  await t.add(colleague, 'worker');
  await t.changeFace(colleague, 'allow');
  await t.enroll(colleague);
  const referenceId = t.access.faceReferenceId(colleague.uid);
  const { authId } = await t.store.get('state', referenceId);
  const faceIdentity = { uid: 'cloud-face-uid', customUserId: authId };
  const challenge = await t.protocol.begin({ action: 'beginLogin', username: colleague.uid });
  const before = (await t.invoke('/api/access')).data;
  const original = before.members.find(member => member.uid === colleague.uid);
  const reported = await t.invoke('/api/bin', {
    location: item.BX, target: 'pending', expectedRevision: 0, operationId: 'reported-before-uid-correction'
  }, colleague);
  assert.equal(reported.status, 200);
  const corrected = { uid: '9876543210123456789' };
  const result = await t.invoke('/api/access/member/save', {
    ...original, originalUid: colleague.uid, uid: corrected.uid, revision: before.revision
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.members.length, before.members.length);
  assert.ok(!result.data.members.some(member => member.uid === colleague.uid));
  assert.deepEqual(result.data.members.find(member => member.uid === corrected.uid), {
    ...original, uid: corrected.uid, faceStatus: 'off', enrolledAt: ''
  });
  assert.deepEqual(result.data.changes[0], {
    actorUid: manager.uid, previousUid: colleague.uid, uid: corrected.uid, action: '更正 UID',
    at: result.data.changes[0].at
  });
  assert.deepEqual(Object.keys(await t.store.get('state', referenceId)), ['erasedAt']);
  assert.equal((await t.invoke('/api/bootstrap', undefined, colleague)).status, 403);
  assert.equal((await t.invoke('/api/bootstrap', undefined, faceIdentity)).status, 401);
  assert.equal((await t.invoke('/api/bootstrap', undefined, corrected)).data.actor.role, 'worker');
  assert.equal((await t.store.get('state', 'current')).bins[item.BX].reported_by_uid, colleague.uid);
  await assert.rejects(t.protocol.finish({ ...challenge, video: fakeVideo(2) }), { status: 401 });
  assert.equal(t.tickets.length, 0);
});

test('deleting directory and environment members revokes access and permits an explicit re-add', async () => {
  const t = setup();
  await t.add(worker, 'worker');
  await t.changeFace(worker, 'allow');
  await t.enroll(worker);
  const referenceId = t.access.faceReferenceId(worker.uid);
  const { authId } = await t.store.get('state', referenceId);
  const legacy = { uid: 'legacy1' };
  let directory = (await t.invoke('/api/access')).data;
  for (const identity of [worker, legacy]) {
    const removed = await t.invoke('/api/access/member/remove', { uid: identity.uid, revision: directory.revision });
    assert.equal(removed.status, 200);
    directory = removed.data;
    assert.ok(!directory.members.some(row => row.uid === identity.uid));
    assert.equal(directory.changes[0].action, '删除人员');
    assert.equal((await t.invoke('/api/bootstrap', undefined, identity)).status, 403);
  }
  assert.deepEqual(Object.keys(await t.store.get('state', referenceId)), ['erasedAt']);
  assert.equal((await t.invoke('/api/bootstrap', undefined, { uid: 'cloud-face-uid', customUserId: authId })).status, 401);

  const added = await t.invoke('/api/access/member/save', {
    uid: legacy.uid, originalUid: null, username: 'restored_legacy', label: 'Re-added', role: 'refill', enabled: true,
    revision: directory.revision
  });
  assert.equal(added.status, 200);
  assert.equal((await t.invoke('/api/bootstrap', undefined, legacy)).data.actor.role, 'refill');
  const removedAgain = await t.invoke('/api/access/member/remove', { uid: legacy.uid, revision: added.data.revision });
  assert.equal(removedAgain.status, 200);
  assert.equal((await t.invoke('/api/bootstrap', undefined, legacy)).status, 403);
});

test('member changes reject duplicates, stale versions, unauthorized callers and removal of the configured administrator', async () => {
  const t = setup();
  await t.add(worker, 'worker');
  await t.add(lead, 'lead');
  const directory = (await t.invoke('/api/access')).data;
  const original = directory.members.find(member => member.uid === worker.uid);
  const save = (input, identity) => t.invoke('/api/access/member/save', {
    ...original, originalUid: worker.uid, uid: 'worker-new', revision: directory.revision, ...input
  }, identity);
  const remove = (uid, revision = directory.revision, identity) =>
    t.invoke('/api/access/member/remove', { uid, revision }, identity);
  assert.equal((await save({ uid: lead.uid })).status, 409);
  assert.equal((await save({ uid: 'legacy1' })).status, 409);
  assert.equal((await save({ username: 'ＬＥＡＤ１' })).status, 409);
  assert.equal((await save({ originalUid: null, uid: worker.uid })).status, 409);
  assert.equal((await save({ revision: directory.revision - 1 })).status, 409);
  assert.equal((await save({ originalUid: 'missing-member' })).status, 404);
  assert.equal((await save({}, worker)).status, 403);
  assert.equal((await save({ originalUid: manager.uid })).status, 403);
  assert.equal((await remove(manager.uid)).status, 403);
  assert.equal((await remove(lead.uid, directory.revision - 1)).status, 409);
  assert.equal((await remove(lead.uid, directory.revision, worker)).status, 403);
  assert.deepEqual((await t.invoke('/api/access')).data, directory);
  const [first, second] = await Promise.all([save({}), remove(worker.uid)]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  assert.equal((await t.invoke('/api/access')).data.revision, directory.revision + 1);
});

test('enrollment requires owner authorization and consent, encrypts reference, and issues a ticket only after live match', async () => {
  const t = setup();
  await t.add(worker, 'worker');
  assert.equal((await t.invoke('/api/face/enroll', { consent: true, noticeVersion: 'test-1' }, worker)).status, 403);
  await t.changeFace(worker, 'allow');
  assert.equal((await t.invoke('/api/face/enroll', { consent: false, noticeVersion: 'test-1' }, worker)).status, 400);
  await t.enroll(worker);
  assert.equal(t.tickets.length, 0);
  assert.ok(!t.store.dump().includes(fakePhoto));
  const directory = (await t.invoke('/api/access')).data;
  assert.equal(directory.members.find(row => row.uid === worker.uid).faceStatus, 'bound');
  assert.ok(!JSON.stringify(directory).includes('authId'));

  const bad = await t.protocol.begin({ action: 'beginLogin', username: worker.uid });
  t.setResult({ Result: 'Success', Sim: 69 });
  await assert.rejects(t.protocol.finish({ ...bad, video: fakeVideo(2) }), { status: 401 });
  assert.equal(t.tickets.length, 0);
  await assert.rejects(t.protocol.finish({ ...bad, video: fakeVideo(3) }), { status: 409 });
  const good = await t.protocol.begin({ action: 'beginLogin', username: worker.uid });
  t.setResult({ Result: 'Success', Sim: 98 });
  assert.equal((await t.protocol.finish({ ...good, photo: 'ignored', video: fakeVideo(4) })).ticket, 'signed-session-ticket');
  assert.equal(t.compares.at(-1).photo, fakePhoto);
  const identity = { uid: 'cloud-new-uid', customUserId: t.tickets[0] };
  const response = await t.invoke('/api/bootstrap', undefined, identity);
  assert.deepEqual(response.data.actor, { uid: worker.uid, label: worker.uid, role: 'worker', authMethod: 'face' });
  const replay = await t.protocol.begin({ action: 'beginLogin', username: worker.uid });
  await assert.rejects(t.protocol.finish({ ...replay, video: fakeVideo(4) }), { status: 401 });
  assert.equal(t.tickets.length, 1);
  await t.add(worker, 'lead');
  assert.equal((await t.invoke('/api/bootstrap', undefined, identity)).data.actor.role, 'lead');
  await t.invoke('/api/face/withdraw', {}, identity);
  assert.equal((await t.invoke('/api/bootstrap', undefined, identity)).status, 401);
  assert.equal((await t.invoke('/api/bootstrap', undefined, worker)).data.actor.role, 'lead');
  assert.deepEqual(Object.keys(await t.store.get('state', t.access.faceReferenceId(worker.uid))), ['erasedAt']);
});

test('an expired request, reset enrollment grant, or unknown user cannot obtain a ticket', async () => {
  const t = setup();
  await t.add(worker, 'worker');
  await t.changeFace(worker, 'allow');
  const { data: { grant } } = await t.invoke('/api/face/enroll', { consent: true, noticeVersion: 'test-1' }, worker);
  await t.changeFace(worker, 'reset');
  await assert.rejects(t.protocol.begin({ action: 'beginEnrollment', grant }), { status: 409 });
  const unknown = await t.protocol.begin({ action: 'beginLogin', username: 'someone' });
  assert.deepEqual(Object.keys(unknown), ['challenge', 'actions', 'expiresInSeconds']);
  await assert.rejects(t.protocol.finish({ ...unknown, video: fakeVideo() }), { status: 401 });
  const expired = await t.protocol.begin({ action: 'beginLogin', username: 'someone' });
  t.elapse(125_000);
  await assert.rejects(t.protocol.finish({ ...expired, video: fakeVideo() }), { status: 409 });
  assert.equal(t.compares.length, 0);
  assert.equal(t.tickets.length, 0);
  for (let i = 0; i < 3; i++) await t.protocol.begin({ action: 'beginLogin', username: 'someone' });
  await assert.rejects(t.protocol.begin({ action: 'beginLogin', username: 'someone' }), { status: 429 });
});

test('HTTP gateway scopes CORS and accepts only face operations, and function ignores caller-provided identities', async () => {
  const t = setup();
  const gateway = createFaceGateway(() => t.protocol, config);
  const call = (action, origin = config.APP_FACE_ORIGIN) => gateway({
    path: '/face-login', httpMethod: 'POST', headers: { Origin: origin },
    body: JSON.stringify({ action, username: 'worker1' })
  });
  assert.equal((await call('beginLogin', 'https://other.example.test')).statusCode, 403);
  assert.equal((await call('/api/bootstrap')).statusCode, 400);
  const accepted = await call('beginLogin');
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.headers['Access-Control-Allow-Origin'], config.APP_FACE_ORIGIN);
  assert.equal(accepted.headers['Cache-Control'], 'no-store');
  const handler = createHandler(() => ({ auth: { getUserInfo: () => ({ uid: 'worker1', customUserId: 'face_verified' }) }, invoke: (_, identity) => identity }));
  assert.deepEqual(await handler({ uid: 'admin1', customUserId: 'face_fake' }), { uid: 'worker1', customUserId: 'face_verified', anonymous: false });
});
