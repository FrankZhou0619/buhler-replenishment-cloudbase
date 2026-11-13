const cloudbase = require('@cloudbase/node-sdk');
const { faceid } = require('tencentcloud-sdk-nodejs-faceid');
const { createAccess } = require('../replenishmentApi/access.mjs');
const { createFaceGateway } = require('../replenishmentApi/face-gateway.mjs');
const { createFaceProtocol } = require('../replenishmentApi/face-protocol.mjs');
const { cloudStore } = require('../replenishmentApi/store.mjs');
const { AppError } = require('../replenishmentApi/app-error.mjs');

const config = process.env;
let protocol;

function initialize() {
  if (protocol) return protocol;
  const base = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV, timeout: 4000 });
  const store = cloudStore(base.database());
  const access = createAccess({ store, config });
  const credentials = JSON.parse(config.APP_FACE_CUSTOM_LOGIN_JSON || '{}');
  const key = Buffer.from(config.APP_FACE_ENCRYPTION_KEY || '', 'base64');
  if (!access.faceConfigured || !config.APP_FACE_SECRET_ID || !config.APP_FACE_SECRET_KEY ||
    key.length !== 32 || !credentials.env_id || !credentials.private_key || !credentials.private_key_id) {
    throw new AppError('刷脸登录暂不可用，请使用账号密码。', 503);
  }
  const signer = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV, credentials }).auth();
  const client = new faceid.v20180301.Client({
    credential: { secretId: config.APP_FACE_SECRET_ID, secretKey: config.APP_FACE_SECRET_KEY },
    region: config.APP_FACE_REGION || 'ap-shanghai',
    profile: { httpProfile: { endpoint: 'faceid.tencentcloudapi.com', reqTimeout: 22 } }
  });
  protocol = createFaceProtocol({
    store, access, encryptionKey: key,
    issueTicket: uid => signer.createTicket(uid, { expire: Date.now() + 8 * 60 * 60 * 1000 }),
    provider: {
      async actions() {
        const response = await client.GetActionSequence({});
        return response.ActionSequence;
      },
      async compare({ video, photo, sequence }) {
        return client.LivenessCompare({ LivenessType: 'ACTION', ValidateData: sequence, VideoBase64: video, ImageBase64: photo });
      }
    }
  });
  return protocol;
}

exports.main = createFaceGateway(initialize, config);
