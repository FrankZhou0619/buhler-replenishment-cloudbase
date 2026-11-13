const fs = require('node:fs');
const path = require('node:path');
const { createService } = require('./service.mjs');
const { cloudStore } = require('./store.mjs');
const { createHandler } = require('./handler.mjs');
let backend;
exports.main = createHandler(() => {
  if (!backend) {
    // Initialization belongs inside the handler so runtime/asset problems
    // are returned as readable diagnostics rather than opaque platform errors.
    const cloudbase = require('@cloudbase/node-sdk');
    const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV, timeout: 20000 });
    const privateDir = path.join(__dirname, 'private');
    backend = {
      auth: app.auth(), store: cloudStore(app.database()),
      catalog: JSON.parse(fs.readFileSync(path.join(privateDir, 'catalog.json'), 'utf8')),
      layout: JSON.parse(fs.readFileSync(path.join(privateDir, 'layout.json'), 'utf8')),
      referenceImage: 'data:image/png;base64,' + fs.readFileSync(path.join(privateDir, 'rack-reference.png')).toString('base64')
    };
  }
  return { auth: backend.auth, invoke: createService({ ...backend, config: process.env }) };
});
