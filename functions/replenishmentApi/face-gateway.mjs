import { AppError, fail } from './app-error.mjs';
import { MAX_FACE_BODY } from './face-protocol.mjs';

export function createFaceGateway(initialize, config = {}) {
  const siteOrigin = config.APP_FACE_ORIGIN?.trim() || '';
  const route = config.APP_FACE_ROUTE || '/face-login';
  return async function face(event) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin' };
    const reply = (statusCode, data) => ({ statusCode, headers, body: data ? JSON.stringify(data) : '' });
    try {
      const origin = Object.entries(event?.headers || {}).find(([name]) => name.toLowerCase() === 'origin')?.[1];
      fail(!/^https:\/\/[^/]+$/.test(siteOrigin) || origin !== siteOrigin, '来源未经授权。', 403);
      headers['Access-Control-Allow-Origin'] = siteOrigin;
      headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type';
      fail(event.path !== route, '接口不存在。', 404);
      if (event.httpMethod === 'OPTIONS') return reply(204);
      fail(event.httpMethod !== 'POST', '请求方法无效。', 405);
      fail(typeof event.body !== 'string' || event.body.length > MAX_FACE_BODY * (event.isBase64Encoded ? 1.4 : 1), '请求体过大。', 413);
      const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
      fail(Buffer.byteLength(raw) > MAX_FACE_BODY, '请求体过大。', 413);
      let body;
      try { body = JSON.parse(raw); } catch { throw new AppError('请求格式无效。'); }
      fail(!body || typeof body !== 'object' || Array.isArray(body), '请求格式无效。');
      const protocol = await initialize();
      if (body.action === 'beginLogin' || body.action === 'beginEnrollment') return reply(200, await protocol.begin(body));
      if (body.action === 'finish') return reply(200, await protocol.finish(body));
      return reply(400, { error: '请求操作无效。' });
    } catch (error) {
      if (error instanceof AppError) return reply(error.status, { error: error.message });
      return reply(503, { error: '核验服务暂不可用，请使用账号密码或稍后重试。' });
    }
  };
}
