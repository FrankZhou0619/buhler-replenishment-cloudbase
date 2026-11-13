import { API_VERSION } from './version.mjs';

export function createHandler(initialize) {
  return async function main(event, context) {
    const startedAt = Date.now();
    let stage = 'initialize';
    try {
      const backend = await initialize();
      // Health checks need no caller identity. Console tests may omit the
      // legacy environ/environment fields expected by getAuthContext(context).
      if (event?.path === '/health' && event?.method === 'GET') { stage = 'health'; return await backend.invoke(event, null); }
      stage = 'identity';
      // getUserInfo reads CloudBase's verified per-invocation runtime context.
      // Never use event.uid, event.context or a client-provided identity.
      const identity = backend.auth.getUserInfo();
      stage = 'request';
      return await backend.invoke(event, {
        uid: identity.uid, anonymous: Boolean(identity.isAnonymous),
        ...(identity.customUserId ? { customUserId: identity.customUserId } : {})
      }, startedAt);
    } catch (error) {
      // Restrict diagnostics to a stage and a safe code. SDK messages may
      // contain credentials or request contents, so never echo them.
      const code = String(error?.code || 'STARTUP_ERROR').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'STARTUP_ERROR';
      return { status: 500, data: { error: '后台启动或调用未完成，请按stage和code检查云函数部署。', stage, code, version: API_VERSION } };
    }
  };
}
