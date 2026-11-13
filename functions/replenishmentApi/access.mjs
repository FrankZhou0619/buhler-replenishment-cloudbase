import { createHash, randomBytes } from 'node:crypto';
import { permits, roleLabels } from '../../shared/access.mjs';
import { fail } from './app-error.mjs';

const groupKeys = [
  ['APP_ADMIN_UIDS', 'admin'], ['APP_INSPECTOR_UIDS', 'inspector'],
  ['APP_REFILL_UIDS', 'refill'], ['APP_ALLOWED_UIDS', 'operator']
];
const directoryId = 'access-directory';
const faceReferenceId = uid => 'face-reference-' + createHash('sha256').update(uid).digest('hex');
const uidText = value => typeof value === 'string' ? value.trim() : '';
export const normalizeUsername = value => typeof value === 'string' ? value.trim().normalize('NFKC').toLowerCase() : '';
const freshFace = (allowed = false) => ({
  allowed, enrollmentId: allowed ? randomBytes(12).toString('hex') : '',
  authId: '', enrolledAt: '', consentVersion: '', consentAt: ''
});
const getMember = (directory, uid) => directory.members.find(member => member.uid === uid);
const publicMember = member => ({
  uid: member.uid, username: member.username, label: member.label, role: member.role, enabled: member.enabled,
  faceStatus: member.face.authId ? 'bound' : member.face.allowed ? 'ready' : 'off', enrolledAt: member.face.enrolledAt
});

export function createAccess({ store, config = {}, clock = () => new Date().toISOString() }) {
  const rescueAdmins = new Set();
  const legacy = new Map();
  let labels = {};
  try { labels = JSON.parse(config.APP_USER_LABELS || '{}') || {}; } catch { /* UID is the fallback label. */ }
  for (const [key, role] of groupKeys) {
    for (const uid of String(config[key] || '').split(/[;,，；\s]+/).filter(Boolean)) {
      if (role === 'admin') rescueAdmins.add(uid);
      if (legacy.has(uid)) continue;
      legacy.set(uid, {
        uid, username: '', label: typeof labels[uid] === 'string' ? labels[uid].slice(0, 60) : uid,
        role, enabled: true, face: freshFace()
      });
    }
  }
  const configured = rescueAdmins.size > 0;
  const faceEnabled = config.APP_FACE_ENABLED === '1';
  const notice = config.APP_FACE_NOTICE?.trim().slice(0, 3500) || '';
  const noticeVersion = config.APP_FACE_NOTICE_VERSION?.trim().slice(0, 60) || '';
  const faceConfigured = faceEnabled && Boolean(notice && noticeVersion);
  const read = async (target = store) => await target?.get('state', directoryId) || { revision: 0, members: [], changes: [] };
  const legacyMember = (directory, uid) =>
    !rescueAdmins.has(uid) && directory.revokedLegacyUids?.includes(uid) ? undefined : legacy.get(uid);
  const effectiveMember = (directory, uid) => getMember(directory, uid) || legacyMember(directory, uid);
  const effectiveRole = member => rescueAdmins.has(member.uid) ? 'admin' : member.role;

  function recordChange(directory, actorUid, uid, action, previousUid) {
    directory.revision++;
    const change = { actorUid, uid, action, at: clock(), ...(previousUid ? { previousUid } : {}) };
    directory.changes = [change, ...directory.changes].slice(0, 100);
  }

  async function revokeMembership(tx, directory, member) {
    // A deleted legacy member must not fall back to an environment-variable grant.
    if (legacy.has(member.uid) && !directory.revokedLegacyUids?.includes(member.uid)) {
      directory.revokedLegacyUids = [...(directory.revokedLegacyUids || []), member.uid];
    }
    if (member.face.authId) await tx.set('state', faceReferenceId(member.uid), { erasedAt: clock() });
  }

  function requireAdmin(directory, actor) {
    const member = effectiveMember(directory, actor.uid);
    fail(!member?.enabled || !permits(effectiveRole(member), 'manage'), '只有管理员可以修改人员与权限。', 403);
    fail(actor.authMethod === 'face' && member.face.authId !== actor.faceAuthId, '刷脸登录已失效，请使用账号密码重新登录。', 401);
  }

  async function authorize(identity) {
    fail(!identity?.uid || identity.anonymous, '请先登录。', 401);
    fail(!configured, '后台尚未配置APP_ADMIN_UIDS。请管理员在云函数环境变量填写首个管理员UID。', 503);
    const directory = await read();
    const custom = typeof identity.customUserId === 'string' ? identity.customUserId : '';
    const face = custom.startsWith('face_');
    if (face) {
      const member = faceConfigured && directory.members.find(row => row.enabled && row.face.allowed &&
        row.face.authId === custom && row.face.consentVersion === noticeVersion);
      fail(!member, '刷脸登录已失效，请使用账号密码重新登录。', 401);
      return { uid: member.uid, role: effectiveRole(member), label: member.label, authMethod: 'face', faceAuthId: custom };
    }
    const member = effectiveMember(directory, String(identity.uid));
    fail(!member?.enabled, '此账号未加入权限组或已停用，请联系管理员。', 403);
    return { uid: member.uid, role: effectiveRole(member), label: member.label, authMethod: 'password' };
  }

  function directoryView(directory) {
    const members = new Map([...legacy].filter(([uid]) => legacyMember(directory, uid)));
    for (const member of directory.members) members.set(member.uid, member);
    return {
      revision: directory.revision, faceConfigured,
      members: [...members.values()].map(member => ({
        ...publicMember(member), role: effectiveRole(member), protected: rescueAdmins.has(member.uid)
      })),
      changes: directory.changes
    };
  }

  async function overview(actor) {
    const directory = await read();
    requireAdmin(directory, actor);
    return directoryView(directory);
  }

  async function editMember(actor, input, { upsert = false } = {}) {
    const uid = uidText(input.uid);
    const originalUid = upsert ? uid : input.originalUid === null ? null : uidText(input.originalUid);
    const username = typeof input.username === 'string' ? input.username.trim() : '';
    const usernameKey = normalizeUsername(username);
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    fail(!/^[a-zA-Z0-9_.-]{4,128}$/.test(uid) || !usernameKey || usernameKey.length > 128 || /[\p{C}\s]/u.test(usernameKey) || !label || label.length > 60, '请填写完整用户 UID、CloudBase 登录账号与姓名。');
    fail(!Object.hasOwn(roleLabels, input.role) || typeof input.enabled !== 'boolean', '请填写有效的权限组与启用状态。');
    fail(originalUid === '', '请选择要编辑的人员。');
    return store.transaction(async tx => {
      const directory = await read(tx);
      requireAdmin(directory, actor);
      fail(input.revision !== directory.revision, '人员设置已更新，请刷新后再保存。', 409);
      const uidChanged = originalUid !== null && originalUid !== uid;
      fail(uidChanged && rescueAdmins.has(originalUid), '由 APP_ADMIN_UIDS 授权的管理员 UID 须在云函数配置中管理。', 403);
      const stored = getMember(directory, originalUid);
      const current = stored || legacyMember(directory, originalUid);
      fail(!upsert && originalUid !== null && !current, '该人员已移除，请刷新名单。', 404);
      fail(originalUid !== uid && effectiveMember(directory, uid), '该 UID 已关联其他人员。请核对后重新输入。', 409);
      fail(rescueAdmins.has(uid) && (!input.enabled || input.role !== 'admin'), '由 APP_ADMIN_UIDS 授权的管理员须在云函数配置中管理。');
      fail(directory.members.some(row => row.uid !== originalUid && normalizeUsername(row.username) === usernameKey), '登录账号已关联到其他人员。', 409);

      const member = {
        uid, username, label, role: input.role, enabled: input.enabled,
        face: input.enabled && !uidChanged ? current?.face || freshFace() : freshFace()
      };
      if (uidChanged) await revokeMembership(tx, directory, current);
      else if (!input.enabled && current?.face.authId) await tx.set('state', faceReferenceId(uid), { erasedAt: clock() });

      directory.members = stored
        ? directory.members.map(row => row.uid === originalUid ? member : row)
        : [...directory.members, member];
      const previouslyAssigned = upsert ? stored : current;
      const action = uidChanged ? '更正 UID' : previouslyAssigned ? '更新人员权限' : '加入权限组';
      recordChange(directory, actor.uid, uid, action, uidChanged ? originalUid : undefined);
      await tx.set('state', directoryId, directory);
      return upsert ? { member: publicMember(member), revision: directory.revision } : directoryView(directory);
    });
  }

  async function removeMember(actor, input) {
    const uid = uidText(input.uid);
    fail(!uid, '请选择要删除的人员。');
    return store.transaction(async tx => {
      const directory = await read(tx);
      requireAdmin(directory, actor);
      fail(input.revision !== directory.revision, '人员设置已更新，请刷新后再删除。', 409);
      fail(rescueAdmins.has(uid), '由 APP_ADMIN_UIDS 授权的管理员须在云函数配置中管理。', 403);
      const member = effectiveMember(directory, uid);
      fail(!member, '该人员已移除，请刷新名单。', 404);
      await revokeMembership(tx, directory, member);
      directory.members = directory.members.filter(row => row.uid !== uid);
      recordChange(directory, actor.uid, uid, '删除人员');
      await tx.set('state', directoryId, directory);
      return directoryView(directory);
    });
  }

  async function editFace(actor, input, self = false) {
    const uid = self ? actor.uid : input.uid;
    const action = self ? 'disable' : input.action;
    fail(!['allow', 'reset', 'disable'].includes(action), '人脸设置操作无效。');
    if (action !== 'disable') fail(!faceConfigured, '人脸登录尚未配置。', 503);
    return store.transaction(async tx => {
      const directory = await read(tx);
      if (!self) {
        requireAdmin(directory, actor);
        fail(input.revision !== directory.revision, '人员设置已更新，请刷新后再保存。', 409);
      }
      const member = getMember(directory, uid);
      fail(!member?.enabled, '请先保存并启用该人员的账号与权限组。', 404);
      fail(action === 'allow' && member.face.authId, '该账号已绑定人脸。', 409);
      if (action !== 'allow') await tx.set('state', faceReferenceId(uid), { erasedAt: clock() });
      member.face = freshFace(action !== 'disable');
      recordChange(directory, actor.uid, uid, { allow: '开放录入', reset: '重置人脸', disable: '停用并移除人脸' }[action]);
      await tx.set('state', directoryId, directory);
      return { member: publicMember(member), revision: directory.revision };
    });
  }

  async function ownFace(actor) {
    const member = getMember(await read(), actor.uid);
    return {
      faceConfigured, status: member ? publicMember(member).faceStatus : 'off',
      username: member?.username || '', label: actor.label, uid: actor.uid,
      enrolledAt: member?.face.enrolledAt || '',
      noticeChanged: Boolean(member?.face.authId && member.face.consentVersion !== noticeVersion),
      canEnroll: faceConfigured && actor.authMethod === 'password' && Boolean(member?.enabled && member.face.allowed && !member.face.authId),
      notice, noticeVersion
    };
  }

  function enrollmentMember(directory, uid) {
    const member = getMember(directory, uid);
    fail(!faceConfigured || !member?.enabled || !member.face.allowed || member.face.authId, '当前账号的录入授权已失效。', 403);
    return member;
  }

  async function saveReference(challenge, encrypted) {
    return store.transaction(async tx => {
      const directory = await read(tx);
      const member = enrollmentMember(directory, challenge.uid);
      fail(member.face.enrollmentId !== challenge.enrollmentId || noticeVersion !== challenge.noticeVersion, '录入授权已更新，请重新录入。', 409);
      member.face = {
        allowed: true, enrollmentId: '', authId: 'face_' + randomBytes(12).toString('hex'), enrolledAt: clock(),
        consentVersion: noticeVersion, consentAt: challenge.consentAt
      };
      await tx.set('state', faceReferenceId(member.uid), { authId: member.face.authId, encrypted });
      recordChange(directory, member.uid, member.uid, '完成人脸录入');
      await tx.set('state', directoryId, directory);
      return { enrolled: true };
    });
  }

  function loginMember(directory, username) {
    return directory.members.find(member => member.enabled && member.face.allowed && member.face.authId &&
      member.face.consentVersion === noticeVersion && normalizeUsername(member.username) === normalizeUsername(username));
  }

  return {
    configured, faceConfigured, notice, noticeVersion, read, authorize, overview, editMember, removeMember, editFace, ownFace,
    enrollmentMember, saveReference, loginMember, faceReferenceId
  };
}
