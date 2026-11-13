// Fixed-destination, stateless ARIMS bridge. Credentials are never persisted or logged.
export const ARIMS_BASE = 'https://arims.bossard.com/arims/rest_stockinfo/v1';
const REQUEST_LIMIT = 32 * 1024;
const RESPONSE_LIMIT = 1024 * 1024;
const RESULT_LIMIT = 2 * RESPONSE_LIMIT;
const MAX_UPSTREAM_MS = 1800;
const INVOCATION_BUDGET_MS = 2400;
const SAFE_HEADERS = ['content-type', 'content-length', 'retry-after', 'x-request-id', 'x-correlation-id'];
const SENSITIVE_KEY = /^(authentication|authorization|password|secret|token|access_?token|refresh_?token|id_?token|cookie|set-cookie)$/i;
class LimitError extends Error {}

async function limitedText(body, limit) {
  if (!body) return { text: '', bytes: 0 };
  const reader = body.getReader(), decoder = new TextDecoder();
  const parts = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new LimitError(); }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return { text: parts.join(''), bytes };
  } finally { reader.releaseLock(); }
}

function reply(data, status = 200) {
  return { status, data };
}
function redact(text, secrets) {
  const patterns = [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)
    .map(secret => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return patterns.length ? text.replace(new RegExp(patterns.join('|'), 'g'), '[已隐藏]') : text;
}
function safeJson(value) {
  if (Array.isArray(value)) return value.map(safeJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? '[已隐藏]' : safeJson(item)]));
  return value;
}
function httpHint(status) {
  if (status === 401) return 'ARIMS 拒绝认证。请核对账号密码，或重新登录获取有效会话。';
  if (status === 403) return 'ARIMS 拒绝访问。请核对库存清单权限和该客户的数据访问范围。';
  if (status === 404) return 'ARIMS 未找到资源。请核对客户编号及接口地址，以响应正文为准。';
  if (status === 429) return 'ARIMS 请求过于频繁，请稍后再试。';
  if (status >= 300 && status < 400) return 'ARIMS 返回了重定向。调试请求未跟随跳转，请确认接口地址是否变更。';
  return `ARIMS 返回 HTTP ${status}，请查看响应正文。`;
}

export async function invokeArims(body, fetcher, invocationStartedAt) {
  const started = Date.now();
  let method = '', url = '', summary = '';
  const fail = (error, code, status, extra = {}) => reply({
    ok: false, error, code, method, url, requestSummary: summary,
    elapsedMs: Date.now() - started, ...extra
  }, status);
  if (Buffer.byteLength(JSON.stringify(body)) > REQUEST_LIMIT) {
    return fail('请求内容超过 32 KB。', 'INVALID_BODY', 413);
  }
  const headers = {};
  let upstreamBody;
  let secrets = [];
  if (body.action === 'login') {
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || username.length > 200 || !password || password.length > 2048) return fail('请填写有效的 ARIMS 用户名和密码。', 'CREDENTIALS_REQUIRED', 400);
    method = 'POST'; url = `${ARIMS_BASE}/auth/login`;
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    upstreamBody = new URLSearchParams({ user: username, password }).toString();
    summary = 'Body: x-www-form-urlencoded\nuser=[已隐藏]\npassword=[已隐藏]';
    secrets = [username, password, encodeURIComponent(username), encodeURIComponent(password)];
    for (const secret of [username, password]) {
      secrets.push(new URLSearchParams({ value: secret }).toString().slice(6), JSON.stringify(secret).slice(1, -1));
    }
  } else if (body.action === 'stocklist' || body.action === 'logout') {
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token || token.length > 20_000 || /[\s\u0000-\u001f\u007f]/.test(token)) return fail('请先登录，获取有效的会话 Token。', 'TOKEN_REQUIRED', 400);
    headers.Authorization = `Bearer ${token}`; secrets = [token];
    summary = 'Authorization: Bearer [已隐藏]\nBody: none';
    if (body.action === 'stocklist') {
      const customerId = typeof body.customerId === 'string' ? body.customerId.trim() : '';
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(customerId)) return fail('请填写客户编号，支持字母、数字、短横线和下划线。', 'CUSTOMER_ID_REQUIRED', 400);
      method = 'GET'; url = `${ARIMS_BASE}/stocklist/${encodeURIComponent(customerId)}`;
    } else { method = 'POST'; url = `${ARIMS_BASE}/auth/logout`; }
  } else return fail('不支持的接口操作。', 'INVALID_ACTION', 400);
  const timeoutMs = Math.min(MAX_UPSTREAM_MS, INVOCATION_BUDGET_MS - (Date.now() - invocationStartedAt));
  if (timeoutMs <= 0) {
    return fail('云函数启动已占用本次调试时间。请稍后重试。', 'UPSTREAM_TIMEOUT', 504);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let upstreamStatus;
  try {
    const upstream = await fetcher(url, { method, headers, body: upstreamBody, redirect: 'manual', signal: controller.signal });
    upstreamStatus = upstream.status;
    const content = await limitedText(upstream.body, RESPONSE_LIMIT);
    let parsed = null;
    let jsonValue;
    try {
      jsonValue = JSON.parse(content.text);
      if (jsonValue && typeof jsonValue === 'object' && !Array.isArray(jsonValue)) parsed = jsonValue;
    } catch { /* XML and plain-text responses are also valid diagnostics. */ }
    const token = body.action === 'login' && parsed && typeof parsed.authentication === 'string' ? parsed.authentication.trim() : '';
    // Only the explicit login token field can carry the secret to page memory.
    // Diagnostic bodies, including failure bodies, are always redacted.
    secrets.push(token);
    const responseBody = redact(jsonValue === undefined ? content.text : JSON.stringify(safeJson(jsonValue)), secrets);
    const upstreamHeaders = {};
    for (const key of SAFE_HEADERS) {
      const value = upstream.headers.get(key);
      if (value) upstreamHeaders[key] = redact(value, secrets);
    }
    const common = { method, url, requestSummary: summary, elapsedMs: Date.now() - started, upstreamStatus, upstreamHeaders, responseBody, sizeBytes: content.bytes };
    if (Buffer.byteLength(JSON.stringify(common)) > RESULT_LIMIT) throw new LimitError();
    if (!upstream.ok) return reply({ ...common, ok: false, code: 'UPSTREAM_HTTP', error: httpHint(upstream.status) });
    if (body.action === 'login' && (!token || token.length > 20_000 || /[\s\u0000-\u001f\u007f]/.test(token))) return reply({ ...common, ok: false, code: 'TOKEN_NOT_FOUND', error: 'HTTP 请求成功，但响应中没有有效的 authentication 字段。请核对 ARIMS 当前接口定义。' });
    const permissions = Array.isArray(parsed?.permissions)
      ? parsed.permissions.filter(p => typeof p === 'string').slice(0, 100).map(p => redact(p.slice(0, 200), secrets))
      : [];
    return reply({ ...common, ok: true, ...(body.action === 'login' ? { token, permissions } : {}) });
  } catch (error) {
    const details = { upstreamStatus };
    if (error instanceof LimitError) return fail('ARIMS 响应超出云函数调试页的容量上限。可在 Postman 保存 XML 后导入。', 'RESPONSE_TOO_LARGE', 502, details);
    if (controller.signal.aborted) return fail('ARIMS 响应超出云函数的等待时间。可稍后重试，或在 Postman 调试。', 'UPSTREAM_TIMEOUT', 504, details);
    const message = upstreamStatus
      ? '后台已收到 ARIMS HTTP 状态，读取响应时出错。'
      : '后台未能连接 ARIMS，未收到 HTTP 响应。请检查服务可达性或稍后重试。';
    return fail(message, 'UPSTREAM_CONNECTION', 502, details);
  } finally { clearTimeout(timer); }
}
