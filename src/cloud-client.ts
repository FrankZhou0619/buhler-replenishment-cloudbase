import cloudbase from '@cloudbase/js-sdk';
let app: ReturnType<typeof cloudbase.init>;
let functionName = 'replenishmentApi';
let faceLoginUrl = '';
export async function initialize() {
  const response = await fetch('./config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('未找到config.json，请检查静态文件是否上传到网站根目录。');
  const config = await response.json();
  if (!config.envId || !config.publishableKey || config.publishableKey.includes('请填写')) throw new Error('请先在config.json填写环境ID和Publishable Key。Publishable Key是公开访问标识，请勿填写SecretKey或服务端API Key。');
  functionName = config.functionName || 'replenishmentApi';
  if (typeof config.faceLoginUrl === 'string' && config.faceLoginUrl) {
    try {
      const url = new URL(config.faceLoginUrl);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) faceLoginUrl = url.href;
    } catch { /* The account/password flow is still available. */ }
  }
  app = cloudbase.init({ env: config.envId, region: config.region || 'ap-shanghai', accessKey: config.publishableKey, persistence: 'session', timeout: 65000 });
  const { data, error } = await app.auth().getSession();
  if (error) return false;
  return Boolean(data?.session);
}
export async function signIn(username: string, password: string) {
  const { error } = await app.auth().signInWithPassword({ username: username.trim(), password });
  if (error) throw new Error('登录未完成，请核对账号密码、登录方式和安全域名设置。');
}
export const faceLoginAvailable = () => Boolean(faceLoginUrl);

export async function faceGateway<T>(body: object, signal: AbortSignal) {
  if (!faceLoginUrl) throw new Error('人脸核验入口尚未配置。');
  const response = await fetch(faceLoginUrl, {
    method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(50_000)])
  });
  const result = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok || !result || result.error) throw new Error(result?.error || '人脸核验未完成，请检查核验入口或使用账号密码。');
  return result;
}

export async function signInWithFaceTicket(ticket: string) {
  if (typeof ticket !== 'string' || !ticket) throw new Error('核验服务未返回登录凭证。');
  try {
    const auth = app.auth();
    const result = await auth.signInWithCustomTicket(async () => ticket);
    if (result && 'error' in result && result.error) throw result.error;
    const { data, error } = await auth.getSession();
    if (error || !data?.session) throw error || new Error('Missing session');
  } catch {
    throw new Error('人脸核验已完成，CloudBase 登录会话建立失败。请使用账号密码并联系管理员。');
  }
}
export async function signOut() {
  const result = await app.auth().signOut();
  if (result && 'error' in result && result.error) throw new Error('退出未完成，请关闭此页面并清除该网站登录信息。');
}
export async function apiFetch(path: string, options: RequestInit = {}) {
  let call;
  try { call = await app.callFunction({ name: functionName, data: { path, method: options.method || 'GET', body: options.body ? JSON.parse(String(options.body)) : {} } }); }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) : '';
    throw new Error(`云函数调用未完成${code ? `（${code}）` : ''}。请检查函数部署、安全域名和调用权限。`);
  }
  const result = typeof call.result === 'string' ? JSON.parse(call.result) : call.result;
  if (!result || !Number.isInteger(result.status)) throw new Error('云函数未返回有效结果，请检查函数名称、运行日志和调用权限。');
  if (result.status === 401) window.dispatchEvent(new Event('cloudbase-session-expired'));
  return new Response(JSON.stringify(result.data), { status: result.status, headers: { 'Content-Type': 'application/json' } });
}
