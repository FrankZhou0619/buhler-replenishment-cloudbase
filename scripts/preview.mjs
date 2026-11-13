// INTERNAL QA ONLY: no actual CloudBase login and no outgoing email.
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService } from '../functions/replenishmentApi/service.mjs';
import { memoryStore } from '../tests/memory-store.mjs';
const root = process.cwd();
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir('.preview', { recursive: true });
await build({ entryPoints: ['src/main.tsx'], outfile: '.preview/app.js', bundle: true, minify: true, jsx: 'automatic', target: ['es2022'], alias: { '@': path.join(root, 'src'), '@cloud-client': path.join(root, 'tests/preview-client.ts') }, define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: JSON.stringify(version) } });
const html = await readFile('dist/frontend/index.html', 'utf8');
await writeFile('.preview/index.html', html.replaceAll(`app-v${version}-wuxi`, 'app'));
const service = createService({
  store: memoryStore(), catalog: JSON.parse(await readFile('private/catalog.json')), layout: JSON.parse(await readFile('private/layout.json')),
  referenceImage: 'data:image/png;base64,' + (await readFile('private/rack-reference.png')).toString('base64'),
  config: { APP_ADMIN_UIDS: 'preview-admin', APP_USER_LABELS: '{"preview-admin":"本地测试管理员"}',
    APP_FACE_ENABLED: '1', APP_FACE_NOTICE_VERSION: 'preview', APP_FACE_NOTICE: '此页使用模拟账号验证界面。' },
  fetchImpl: async () => new Response(null, { status: 202, headers: { 'x-message-id': 'PREVIEW_ONLY_NO_EMAIL_SENT' } })
});
const args = process.argv.slice(2), option = (key, fallback) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : fallback; };
const port = Number(option('--port', process.env.PORT || '4173')), host = option('--host', '0.0.0.0');
createServer(async (req, res) => {
  try {
    if (req.url === '/preview-api' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 300000) throw new Error('limit'); }
      const value = await service(JSON.parse(body), { uid: 'preview-admin' });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); return;
    }
    const file = new URL(req.url, 'http://localhost').pathname;
    if (!['/', '/index.html', '/app.js', '/app.css'].includes(file)) { res.writeHead(404); res.end(); return; }
    const data = await readFile(path.join('.preview', file === '/' ? 'index.html' : file.slice(1)));
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(data);
  } catch { res.writeHead(500); res.end('Preview request failed'); }
}).listen(port, host, () => console.log(`Local QA preview on ${host}:${port}; mocked login and providers only.`));
