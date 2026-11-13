from pathlib import Path
from html import escape
import argparse
import re
import json
import zipfile
import hashlib

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--layout-example', type=Path)
parser.add_argument('--release-date', default='2026-11-13')
args = parser.parse_args()
release = root / 'release'
release.mkdir(exist_ok=True)
md = (root / 'README.md').read_text()
version = json.loads((root / 'package.json').read_text())['version']
release_date = args.release_date

def inline(value):
    value = escape(value)
    value = re.sub(r'`([^`]+)`', r'<code>\1</code>', value)
    value = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', value)
    return re.sub(r'\[([^\]]+)\]\((https://[^)]+)\)', r'<a href="\2" target="_blank" rel="noopener">\1</a>', value)

parts, lines, i = [], md.splitlines(), 0
while i < len(lines):
    line = lines[i]
    if not line.strip():
        i += 1
        continue
    if line.startswith('```'):
        block, i = [], i + 1
        while i < len(lines) and not lines[i].startswith('```'):
            block.append(lines[i])
            i += 1
        parts.append('<pre><code>' + escape('\n'.join(block)) + '</code></pre>')
        i += 1
        continue
    if line.startswith('|'):
        rows = []
        while i < len(lines) and lines[i].startswith('|'):
            rows.append([cell.strip() for cell in lines[i].strip('|').split('|')])
            i += 1
        parts.append('<div class="scroll"><table><thead><tr>' + ''.join('<th>' + inline(x) + '</th>' for x in rows[0]) + '</tr></thead><tbody>' + ''.join('<tr>' + ''.join('<td>' + inline(x) + '</td>' for x in row) + '</tr>' for row in rows[2:]) + '</tbody></table></div>')
        continue
    match = re.match(r'^(#{1,3}) (.+)$', line)
    if match:
        level = len(match[1])
        heading = match[2]
        section_ids = {'1. 更新现有看板': 'update', '2. 配置刷脸登录': 'face',
                       '3. 录入并验证第一个账号': 'enroll', '部署后核对': 'verify'}
        anchor = f' id="{section_ids[heading]}"' if heading in section_ids else ''
        parts.append(f'<h{level}{anchor}>' + inline(heading) + f'</h{level}>')
        if level == 1:
            parts.append('<nav aria-label="部署步骤"><a href="#update">1. 更新看板</a><a href="#face">2. 配置刷脸</a><a href="#enroll">3. 录入并试登录</a><a href="#verify">部署后核对</a></nav>')
        i += 1
        continue
    if re.match(r'^\d+\. ', line) or line.startswith('- '):
        ordered = bool(re.match(r'^\d+\. ', line))
        tag, pattern = ('ol', r'^\d+\. ') if ordered else ('ul', r'^- ')
        items = []
        while i < len(lines) and re.match(pattern, lines[i]):
            items.append(re.sub(pattern, '', lines[i]))
            i += 1
        parts.append('<' + tag + '>' + ''.join('<li>' + inline(item) + '</li>' for item in items) + '</' + tag + '>')
        continue
    paragraph = []
    while i < len(lines) and lines[i].strip():
        paragraph.append(lines[i])
        i += 1
    parts.append('<p>' + inline(' '.join(paragraph)) + '</p>')
    if paragraph[0].startswith('**生成密钥和整理私钥。**'):
        parts.append('''<details class="local-tools"><summary>打开本机配置工具</summary>
<p>所有操作在本机浏览器完成。结果会在刷新或关闭此页后清除。</p>
<div class="tool-row">
  <button type="button" id="generate-key">生成加密密钥</button>
  <label for="key-output">APP_FACE_ENCRYPTION_KEY</label>
  <input id="key-output" type="password" readonly autocomplete="off" spellcheck="false" />
  <button type="button" data-copy="key-output" disabled>复制密钥</button>
</div>
<div class="tool-row">
  <label for="private-json">选择腾讯云下载的私钥 JSON</label>
  <input id="private-json" type="file" accept=".json,application/json" />
  <label for="json-output">APP_FACE_CUSTOM_LOGIN_JSON</label>
  <input id="json-output" type="password" readonly autocomplete="off" spellcheck="false" />
  <button type="button" data-copy="json-output" disabled>复制单行 JSON</button>
</div>
<p id="tool-status" role="status"></p>
</details>''')

style = '''body{margin:0;background:#f3f6fa;color:#25374c;font:15px/1.85 "Microsoft YaHei",system-ui,sans-serif}main{max-width:980px;margin:32px auto;background:white;padding:44px 54px;border-radius:12px;box-shadow:0 3px 22px #1935530c}h1{font-size:29px;line-height:1.45;color:#193853;margin:0 0 24px}h2{font-size:20px;color:#235e94;border-top:1px solid #e2e9f1;padding-top:25px;margin-top:34px}p,li{overflow-wrap:anywhere}li{margin-bottom:9px}a{color:#2366a3}strong{font-weight:650}code{background:#eef3f8;padding:2px 5px;border-radius:3px;font-size:13px}pre{padding:18px;background:#172c43;color:#eaf3ff;border-radius:7px;overflow:auto;white-space:pre-wrap}pre code{background:none;padding:0}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px;line-height:1.7;margin:18px 0}th,td{padding:11px 13px;text-align:left;vertical-align:top;border:1px solid #dde5ef}th{background:#eef4fa;white-space:nowrap}td:first-child{color:#235e94}footer{color:#8292a4;text-align:center;margin:35px 0;font-size:12px}@media(max-width:700px){main{margin:0;border-radius:0;padding:28px 20px}h1{font-size:25px}body{font-size:14px}}@media print{body{background:white}main{margin:0;padding:0;box-shadow:none}h2{break-after:avoid}tr{break-inside:avoid}a{color:inherit}}'''
style += '''nav{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 22px}nav a{padding:5px 10px;border:1px solid #dbe6f2;border-radius:6px;background:#f6f9fd;text-decoration:none}h3{margin-top:24px;color:#264d73;font-size:17px}.local-tools{margin:14px 0 22px;border:1px solid #dbe6f2;border-radius:8px;background:#f7fafc;padding:12px 16px}.local-tools summary{cursor:pointer;font-weight:650}.local-tools p{margin:8px 0}.tool-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:10px 0}.tool-row input,.tool-row button{font:inherit}.tool-row input[readonly]{width:min(100%,280px);border:1px solid #cad9e7;border-radius:5px;padding:5px 8px}.tool-row button{color:#174672;background:white;border:1px solid #cad9e7;border-radius:6px;padding:4px 10px;cursor:pointer}.tool-row button:disabled{opacity:.45;cursor:default}@media print{.local-tools{display:none}}'''
tools_script = '''<script>
'use strict';
const byId = id => document.getElementById(id);
const report = message => { byId('tool-status').textContent = message; };
function setOutput(id, value) {
  byId(id).value = value;
  document.querySelector('[data-copy="' + id + '"]').disabled = !value;
}
byId('generate-key').addEventListener('click', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  setOutput('key-output', btoa(String.fromCharCode(...bytes)));
  byId('generate-key').disabled = true;
  report('加密密钥已生成。请复制到核验函数并妥善备份。');
});
byId('private-json').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  setOutput('json-output', '');
  if (!file) return;
  try {
    if (file.size > 64 * 1024) throw new Error();
    const data = JSON.parse(await file.text());
    if (!data || !['env_id', 'private_key_id', 'private_key'].every(key => typeof data[key] === 'string' && data[key])) {
      throw new Error();
    }
    setOutput('json-output', JSON.stringify(data));
    report('私钥已整理为单行 JSON。请复制到核验函数环境变量。');
  } catch {
    report('文件无法读取或缺少私钥字段。请选择该环境下载的原始 JSON。');
  }
});
for (const button of document.querySelectorAll('button[data-copy]')) {
  button.addEventListener('click', async () => {
    const field = byId(button.dataset.copy);
    try {
      await navigator.clipboard.writeText(field.value);
      report('已复制。');
    } catch {
      field.select();
      report('已选中，请按 Ctrl+C 复制。');
    }
  });
}
</script>'''
html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bühler Wuxi · 腾讯云部署指南</title><style>' + style + '</style></head><body><main>' + ''.join(parts) + '</main><footer>Bühler · CloudBase ' + version + ' · ' + release_date + '</footer>' + tools_script + '</body></html>'
(root / '操作说明.html').write_text(html, encoding='utf-8')

def zip_tree(source, destination):
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as target:
        for file in sorted(source.rglob('*')):
            if file.is_file():
                target.write(file, file.relative_to(source))

zip_tree(root / 'dist/frontend', release / '01-frontend.zip')
zip_tree(root / 'dist/function', release / '02-replenishmentApi.zip')
zip_tree(root / 'dist/face-function', release / '06-faceLoginApi.zip')
with zipfile.ZipFile(release / '03-source.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as target:
    for folder in ['src', 'private', 'functions', 'shared', 'scripts', 'tests']:
        for file in sorted((root / folder).rglob('*')):
            if file.is_file() and '__pycache__' not in file.parts:
                target.write(file, file.relative_to(root))
    for name in ['package.json', 'package-lock.json', 'tsconfig.json', 'config.example.json', 'README.md', '04-function-rules.json', 'health.json']:
        target.write(root / name, name)
for name in ['README.md', '操作说明.html', '04-function-rules.json', 'health.json']:
    (release / name).write_bytes((root / name).read_bytes())
if args.layout_example:
    (release / '05-Layout_Configuration_Example.xlsx').write_bytes(args.layout_example.read_bytes())
(release / '先读我.txt').write_text(
    f'CloudBase 上海部署包 {version}（{release_date}）\n\n'
    '双击打开“操作说明.html”。先更新看板，再按需配置刷脸。电脑无需安装 Node.js。\n\n'
    '先将 02-replenishmentApi.zip 上传到现有的 replenishmentApi 函数并点击部署。'
    f'使用 health.json 验证，正常版本号是 cloudbase-{version}。\n\n'
    '再将 01-frontend.zip 解压后上传静态网站文件，最后覆盖 index.html。保留已配置的 config.json。\n\n'
    '用管理员账号打开“人员与权限”，可以编辑 UID 或删除人员。已有配置和集合继续使用。\n\n'
    '启用刷脸时单独部署 06-faceLoginApi.zip，按“配置刷脸登录”填写凭证、HTTP 网关和前端地址。'
    '配置完成后让本人录入并逐一验证。\n',
    encoding='utf-8-sig'
)
manifest = {
    'version': version,
    'built_at': release_date,
    'target_region': 'ap-shanghai',
    'live_cloudbase_verified': False,
    'live_faceid_verified': False,
    'live_arims_verified': False,
    'real_email_sent': False,
    'free_trial_mail_compatible': False,
    'test_site_version': 13,
    'test_site_commit': '97536a81506577f9ddb4a458711dde2147a7ed1f',
    'sha256': {
        file.name: hashlib.sha256(file.read_bytes()).hexdigest()
        for file in sorted(release.iterdir()) if file.is_file() and file.name != 'checksums.json'
    }
}
(release / 'checksums.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
out = root.parent / ('Buhler_CloudBase_Shanghai_v' + version + '.zip')
zip_tree(release, out)
with zipfile.ZipFile(out) as target:
    assert target.testzip() is None
print(json.dumps({'file': str(out), 'size_bytes': out.stat().st_size, 'backend_version': manifest['version']}, ensure_ascii=False))
