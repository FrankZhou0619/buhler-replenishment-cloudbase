import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto';
import { AppError, fail } from './app-error.mjs';
import { normalizeUsername } from './access.mjs';

export const MAX_FACE_BODY = 1_500_000;
const VIDEO_LIMIT = 1_250_000;
const PHOTO_LIMIT = 180_000;
const expiryMs = 2 * 60_000;
const rateWindow = 10 * 60_000;
const id = () => randomBytes(24).toString('hex');
const digest = value => createHash('sha256').update(value).digest('hex');
const tokenPattern = /^[0-9a-f]{48}$/;
const verifyError = '人脸核验未通过，请重新发起或使用账号密码。';

function decoded(value, max) {
  fail(typeof value !== 'string' || value.length > max || !value.length || value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value), '录入文件格式或大小无效，请重拍。', 400);
  const bytes = Buffer.from(value, 'base64');
  fail(bytes.toString('base64') !== value, '录入文件编码无效，请重拍。');
  return bytes;
}

function checkVideo(video) {
  const bytes = decoded(video, VIDEO_LIMIT);
  fail(bytes.length < 64 || bytes.toString('ascii', 4, 8) !== 'ftyp', '请使用支持 MP4 录制的 Chrome 或 Edge 重拍。');
  return digest(bytes);
}

function checkPhoto(image) {
  const bytes = decoded(image, PHOTO_LIMIT);
  fail(bytes.length < 64 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff, '参考画面无法读取，请重拍。');
  return bytes;
}

function encrypt(key, uid, bytes) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(uid));
  const value = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), value: value.toString('base64') };
}

function decrypt(key, uid, encrypted) {
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'));
    cipher.setAAD(Buffer.from(uid));
    cipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
    return Buffer.concat([cipher.update(Buffer.from(encrypted.value, 'base64')), cipher.final()]).toString('base64');
  } catch {
    throw new AppError('人脸凭据无法读取，请用账号密码登录并联系管理员。', 503);
  }
}

export function createFaceProtocol({ store, access, provider, issueTicket, encryptionKey, now = Date.now }) {
  const ready = () => {
    fail(!access.configured || !access.faceConfigured || !provider || !issueTicket || encryptionKey?.length !== 32,
      '刷脸登录暂不可用，请使用账号密码。', 503);
  };

  async function withSessions(update) {
    return store.transaction(async tx => {
      const data = await tx.get('state', 'face-sessions') || { grants: [], challenges: [], attempts: [], videos: [] };
      const time = now();
      for (const key of ['grants', 'challenges', 'attempts', 'videos']) data[key] = data[key].filter(row => row.expiresAt > time);
      const result = await update(data, tx, time);
      await tx.set('state', 'face-sessions', data);
      return result;
    });
  }

  function limit(data, key, time) {
    fail(data.attempts.length >= 60 || data.attempts.filter(row => row.key === key).length >= 5,
      '尝试次数较多，请稍后重试或使用账号密码。', 429);
    data.attempts.push({ key, expiresAt: time + rateWindow });
  }

  async function enrollmentGrant(actor, input) {
    fail(!access.faceConfigured, '人脸登录尚未配置。', 503);
    fail(actor.authMethod !== 'password', '请先使用账号密码登录，再录入人脸。', 403);
    fail(input.consent !== true || input.noticeVersion !== access.noticeVersion, '请先阅读并确认本次人脸信息处理说明。');
    const token = id();
    await withSessions(async (data, tx, time) => {
      const directory = await access.read(tx);
      const member = access.enrollmentMember(directory, actor.uid);
      data.grants = data.grants.filter(row => row.uid !== actor.uid);
      fail(data.grants.length >= 100, '录入请求较多，请稍后重试。', 429);
      data.grants.push({
        key: digest(token), uid: actor.uid, enrollmentId: member.face.enrollmentId,
        expiresAt: time + expiryMs, consentAt: new Date(time).toISOString(), noticeVersion: access.noticeVersion
      });
    });
    return { grant: token };
  }

  async function begin(input) {
    ready();
    const enrolling = input.action === 'beginEnrollment';
    const username = normalizeUsername(input.username);
    if (enrolling) fail(typeof input.grant !== 'string' || !tokenPattern.test(input.grant), '录入请求无效或已过期。');
    else fail(!username || username.length > 128, '请输入账号。');
    const binding = await withSessions(async (data, tx, time) => {
      const directory = await access.read(tx);
      if (enrolling) {
        const key = digest(input.grant);
        const grant = data.grants.find(row => row.key === key);
        fail(!grant || grant.noticeVersion !== access.noticeVersion, '录入请求已过期，请重新发起。', 409);
        const member = access.enrollmentMember(directory, grant.uid);
        fail(member.face.enrollmentId !== grant.enrollmentId, '录入授权已更新，请重新发起。', 409);
        data.grants = data.grants.filter(row => row.key !== key);
        limit(data, digest('enroll:' + grant.uid), time);
        return { mode: 'enroll', uid: grant.uid, enrollmentId: grant.enrollmentId, noticeVersion: grant.noticeVersion, consentAt: grant.consentAt };
      }
      limit(data, digest('login:' + username), time);
      const member = access.loginMember(directory, username);
      return { mode: 'login', uid: member?.uid || '', authId: member?.face.authId || '', username };
    });

    // The response has the same shape for unregistered or disabled accounts.
    const sequence = binding.uid ? await provider.actions() : ['1,2', '2,1'][randomInt(2)];
    fail(!/^(1,2|2,1)$/.test(sequence), '核验服务未返回可用动作，请重试。', 502);
    const challenge = id();
    await withSessions((data, _tx, time) => {
      data.challenges.push({ ...binding, key: digest(challenge), sequence, expiresAt: time + expiryMs });
    });
    return { challenge, actions: sequence.split(','), expiresInSeconds: expiryMs / 1000 };
  }

  async function finish(input) {
    ready();
    fail(typeof input.challenge !== 'string' || !tokenPattern.test(input.challenge), '核验请求无效或已过期。', 409);
    const videoHash = checkVideo(input.video);
    const { challenge, replay } = await withSessions((data, _tx, time) => {
      const key = digest(input.challenge);
      const challenge = data.challenges.find(row => row.key === key);
      fail(!challenge, '核验请求已使用或过期，请重新发起。', 409);
      data.challenges = data.challenges.filter(row => row.key !== key);
      const replay = data.videos.some(row => row.key === videoHash);
      if (challenge.uid && !replay) data.videos.push({ key: videoHash, expiresAt: time + rateWindow });
      return { challenge, replay };
    });
    fail(replay || !challenge.uid, verifyError, 401);

    const directory = await access.read();
    let reference;
    if (challenge.mode === 'enroll') {
      const member = access.enrollmentMember(directory, challenge.uid);
      fail(member.face.enrollmentId !== challenge.enrollmentId || access.noticeVersion !== challenge.noticeVersion, '录入授权已更新，请重新录入。', 409);
      checkPhoto(input.photo);
      reference = input.photo;
    } else {
      const member = access.loginMember(directory, challenge.username);
      fail(!member || member.uid !== challenge.uid || member.face.authId !== challenge.authId, verifyError, 401);
      const saved = await store.get('state', access.faceReferenceId(challenge.uid));
      fail(saved?.authId !== challenge.authId || !saved.encrypted, verifyError, 401);
      reference = decrypt(encryptionKey, challenge.uid, saved.encrypted);
    }

    const result = await provider.compare({ video: input.video, photo: reference, sequence: challenge.sequence });
    fail(result.Result !== 'Success' || typeof result.Sim !== 'number' || !Number.isFinite(result.Sim) ||
      result.Sim < 70 || result.Sim > 100, verifyError, 401);
    if (challenge.mode === 'enroll') {
      let best = checkPhoto(reference);
      if (result.BestFrameBase64) {
        try { best = checkPhoto(result.BestFrameBase64); } catch { /* The already verified reference is usable. */ }
      }
      return access.saveReference(challenge, encrypt(encryptionKey, challenge.uid, best));
    }

    const member = access.loginMember(await access.read(), challenge.username);
    fail(!member || member.uid !== challenge.uid || member.face.authId !== challenge.authId, verifyError, 401);
    return { ticket: await issueTicket(challenge.authId) };
  }

  return { enrollmentGrant, begin, finish };
}
