# Bühler Wuxi · 腾讯云部署指南

适用 **v1.4.1**，部署到你现有的上海 CloudBase 环境 `buhler-demo`。Windows 上用文件资源管理器解压、用记事本改配置、用浏览器上传即可，无需安装 Node.js。

从 v1.4.0 升级时，先部署业务云函数，再更新静态网页。解压外层 `Buhler_CloudBase_Shanghai_v1.4.1.zip` 后，打开《操作说明.html》。已启用刷脸的环境可继续使用现有核验函数。首次启用刷脸时，按第 2 节配置。

| 包内文件 | 操作 |
| --- | --- |
| `02-replenishmentApi.zip` | 整个 ZIP 上传到现有 `replenishmentApi` 云函数 |
| `01-frontend.zip` | 解压，将网站文件上传到静态网站托管 |
| `06-faceLoginApi.zip` | 开通刷脸时，将整个 ZIP 上传到 `faceLoginApi` |

## 1. 更新现有看板

### 1.1 更新业务云函数

1. 打开 CloudBase 控制台，选择 **上海 → buhler-demo**，确认页面顶部显示该环境。[打开控制台](https://tcb.cloud.tencent.com/dev)
2. 打开 **云函数 / 托管 → 函数管理 → replenishmentApi → 函数代码 → 上传代码**。选择 `02-replenishmentApi.zip`，点击 **部署**。使用普通云函数、原 Node.js 20.19 运行时和执行方法 `index.main`。如原函数使用兼容的 Node.js 22，可继续使用。依赖已打包。
3. 在 **函数配置 → 环境变量** 检查 `APP_ADMIN_UIDS`。值填 **身份认证 → 用户管理**中管理员账号的 **用户 ID**，用复制按钮取完整值。例如，若继续使用 `demo_admin`，复制这一行的用户 ID。已有管理员和邮件环境变量应随升级保留。
4. 点函数页面右上角的 **测试**，将下方事件粘贴到编辑框，再点 **运行测试**。结果应有 `status: 200`、`data.version: cloudbase-1.4.1` 和 `data.authorizationConfigured: true`。

```json
{"path":"/health","method":"GET"}
```

你已有的 `replenishment_state`、`replenishment_orders`、`replenishment_ops` 三个集合继续使用，5S 和人员记录会写入其中的独立文档。升级时直接使用原集合与账号。

### 1.2 上传网站

1. 解压 `01-frontend.zip`。进入 **静态网站托管 → 文件管理**，打开网站根目录。
2. 先上传 `app-v1.4.1-wuxi.js`、`app-v1.4.1-wuxi.css` 和 `app-v1.4.1-wuxi.js.LEGAL.txt`，最后上传并覆盖 `index.html`。沿用现有 `config.json`。
3. 根目录没有 `config.json` 时，用记事本打开 `config.example.json`，另存为 `config.json`。将保存类型选为「所有文件」。用控制台复制的 **环境 ID** 和 **环境配置 → API Key → Publishable Key** 替换示例值，再上传这个文件。`faceLoginUrl` 暂填空字符串。
4. 打开现有看板 HTTPS 地址，用管理员账号密码登录。看到左侧 **V1.4.1**，顶部显示「共享状态已同步」，表示前端与业务接口已接通。若登录请求出现跨域错误，检查 **HTTP 网关 → 跨域设置** 是否包含看板的实际域名。

### 1.3 给员工分组

在 **CloudBase → 身份认证 → 用户管理** 创建或找到员工账号，复制其 **用户 ID**。再进入看板左侧 **人员与权限 → 添加已开通的人员**，填写用户 ID、实际登录用户名、姓名和权限组，点击 **保存权限**。每个人用自己的账号，同组可以添加多个人。

| 权限组 | 日常操作 |
| --- | --- |
| 现场工人 | 报缺、撤销本人未成单的报缺，登记 5S 完成与整改完成 |
| 布勒线长 | 巡检、处理未成单报缺、生成清单和发邮件，检查 5S 并提出整改 |
| 补料员 | 单盒、勾选多盒或全部确认补满，查看 5S 记录 |
| 项目管理员 | 管理人员、人脸、货架与邮件设置，也能执行上述业务操作 |

### 1.4 更正 UID 或删除人员

1. **更正 UID**。在「人员与权限」点对应行的「编辑人员」，从 CloudBase「身份认证 → 用户管理」复制正确 UID 后保存。姓名、登录用户名和权限组会保留，旧 UID 的看板权限和人脸绑定会撤销。需要刷脸时，请重新开放录入。系统会拦截已被其他人员使用的 UID。
2. **删除人员**。点对应行的「删除人员」并确认。人员会从看板名单移除，看板权限和人脸绑定会撤销。补料及 5S 历史保留，CloudBase 登录账号由腾讯云控制台单独管理。
3. **查看变更记录**。更正时会显示旧 UID 和新 UID。由 `APP_ADMIN_UIDS` 指定的基础管理员 UID 在云函数环境变量中管理。

## 2. 配置刷脸登录

**先看函数超时。** CloudBase 免费体验版的云函数上限固定为 **3 秒**。第 1 部分可先用密码验收。本包的 `faceLoginApi` 联调建议设 **45 秒**，需要当前环境支持调整超时，再按实际核验耗时确认。人脸核身服务单独开通并计量。[腾讯云套餐配额](https://cloud.tencent.com/document/product/876/127357) · [人脸核身计费与试用](https://cloud.tencent.com/document/product/1007/45878)

### 2.1 准备两种凭证

1. 在腾讯云搜索 **人脸核身**，按控制台提示申请开通 **PaaS 的活体人脸比对（自传照片）**。本包调用 `GetActionSequence` 和 `LivenessCompare`，用现场视频和登记照片比对。为核验函数准备有这两项权限的腾讯云 **SecretId 和 SecretKey**。[接入指引](https://cloud.tencent.com/document/product/1007/56811) · [活体人脸比对](https://cloud.tencent.com/document/product/1007/31819)
2. 回到同一个 CloudBase 环境，打开 **身份认证 → 登录方式 → 自定义登录**，启用并下载 **私钥 JSON**。已有同环境私钥时可沿用；重新生成会让旧私钥在腾讯云规定的过渡期后失效。[CloudBase 自定义登录](https://docs.cloudbase.net/authentication-v2/method/custom-login)

### 2.2 部署核验函数并填写变量

在 **云函数 → 函数管理** 新建 **普通云函数** `faceLoginApi`，选择 Node.js 20.19 或 22，执行方法 `index.main`。上传并部署 `06-faceLoginApi.zip`。若之前已经建过该函数，直接上传更新。在 **函数配置** 中启用公网访问并设定超时。

在各自的 **函数配置 → 编辑 → 环境变量** 逐行添加以下变量并保存。业务函数已填过的 `APP_ADMIN_UIDS` 可直接沿用。

| 变量 | 填到哪里 | 值 |
| --- | --- | --- |
| `APP_ADMIN_UIDS` | 两个函数 | 同一份管理员用户 ID 列表 |
| `APP_FACE_ENABLED` | 两个函数 | `1` |
| `APP_FACE_NOTICE_VERSION` | 两个函数 | 首次填 `1`，两处保持一致 |
| `APP_FACE_NOTICE` | 两个函数 | 同一份人脸信息处理说明，写明处理方和联系方式、用途、腾讯云比对、保存期限与撤回方式 |
| `APP_FACE_ORIGIN` | 仅 `faceLoginApi` | 看板网址的协议和域名，如 `https://你的看板域名`，末尾不加斜杠 |
| `APP_FACE_SECRET_ID` | 仅 `faceLoginApi` | 2.1 准备的腾讯云 SecretId |
| `APP_FACE_SECRET_KEY` | 仅 `faceLoginApi` | 2.1 准备的腾讯云 SecretKey |
| `APP_FACE_CUSTOM_LOGIN_JSON` | 仅 `faceLoginApi` | 2.1 下载的完整私钥 JSON，以单行填入 |
| `APP_FACE_ENCRYPTION_KEY` | 仅 `faceLoginApi` | 32 字节随机密钥的 Base64 值，生成一次后备份 |

**生成密钥和整理私钥。** 浏览器版《操作说明.html》提供本机工具，生成加密密钥，或将下载的私钥 JSON 转成单行。用浏览器打开解压后的文件即可。服务端密钥与私钥只填在函数环境变量中。已有参考图时保留原加密密钥，否则需要重新录入。若控制台提示变量总长度超限，将私钥转为单行并精简告知文字，保留必填事项。[云函数变量配额](https://cloud.tencent.com/document/product/583/11637)

### 2.3 把网页连到核验函数

1. 打开 **HTTP 网关 → 域名及路由 → 新建**。选择该环境的 HTTP 网关域名，路径填 `/face-login`，关联资源选「云函数」，函数选 `faceLoginApi`，版本选 `$LATEST`。这一条是登录前的核验入口，网关「身份认证」开关设为关闭。函数只接收核验请求，业务函数 `replenishmentApi` 继续校验登录身份和权限。若该环境使用了自定义网关鉴权策略，只对该域名的 `/face-login` 核验路由做对应放行。[HTTP 网关配置](https://docs.cloudbase.net/service/access-cloud-function) · [云函数访问控制](https://docs.cloudbase.net/cloud-function/security-rules)
2. 在 **HTTP 网关 → 跨域设置** 允许看板实际域名。若你在公司 VPN 下打开看板，现场终端也需要能访问新网关域名。
3. 编辑静态托管根目录已有的 `config.json`。保留环境 ID、地区、函数名和 Publishable Key，将 `faceLoginUrl` 填成 **HTTP 网关 HTTPS 域名 + /face-login**。上传覆盖 `config.json` 后刷新看板。

```json
{
  "envId": "从 CloudBase 控制台复制你的环境 ID",
  "region": "ap-shanghai",
  "functionName": "replenishmentApi",
  "publishableKey": "沿用当前的 Publishable Key",
  "faceLoginUrl": "https://你的HTTP网关域名/face-login"
}
```

## 3. 录入并验证第一个账号

1. **管理员**用密码登录看板，在 **人员与权限**保存员工完整资料，然后点该员工的 **开放录入**。
2. **员工本人**用自己的账号密码登录，打开 **我的登录方式**，阅读说明并单独同意后，点 **打开前置摄像头 → 开始录制并核验**，按提示完成动作。显示「已绑定」即登记成功。使用支持 MP4 录制的桌面 Chrome 或 Edge，在 HTTPS 看板页面允许摄像头。
3. 退出看板，选 **人脸识别登录**，输入同一个用户名，再按上述方式打开摄像头并录制。核验通过后直接进入看板。核对右上角姓名和该账号的业务权限。员工可在「我的登录方式」撤回，管理员可停用并移除人脸。

本包将本次录制视频经核验函数发送到腾讯云，业务库保存加密参考图。真实员工试点前，按适用要求完成人脸信息处理告知与评估，并继续提供密码登录。[人脸识别技术应用安全管理办法](https://www.cac.gov.cn/2025-03/21/c_1744174262156096.htm)

## 部署后核对

| 看到的情况 | 先检查哪里 |
| --- | --- |
| 登录后提示账号未加入权限组 | `APP_ADMIN_UIDS` 是否是管理员账号的用户 ID，或在看板「人员与权限」中保存员工账号 |
| 云函数测试显示 `[object Object]` | 打开函数「日志」，按测试时间查看调用。先核对已点「部署」、函数名、入口 `index.main`。登录页和「共享状态已同步」分别验证前端与业务接口 |
| 刷脸页提示入口未配置 | 根目录 `config.json` 的 `faceLoginUrl`、文件名和新版首页缓存 |
| 无法开放录入或核验服务不可用 | 两个函数的管理员 UID、刷脸开关和告知配置是否一致。再看核验函数的网关路径、跨域、私钥、人脸服务权限和超时 |
| 能开摄像头但提示核验未通过 | 用已登记的同一用户名，在光线足够的地方重试。动作顺序按页面提示，必要时在「人员与权限」重置后重新登记 |

这版已合入测试站第 13 版的人员 UID 更正和删除。VMI、用量预警及样机备料的 Excel 试算在演示页面内运行。配置货架的「发布到看板」会将管理员确认的布局同步到实际终端。

## 只在环境为空时补做

如果是一个全新的 CloudBase 环境，先启用 **身份认证 → 用户名密码登录**并创建管理员。在 **文档型数据库**中建立上述三个集合，把集合客户端权限设为「无权限」。若选的是 PostgreSQL 环境，则在 PostgreSQL 的 Document 编辑器按提示启用 `pgdoc`，再建集合。随后按第 1 步部署。调用业务函数的权限配置参考包内 `04-function-rules.json`，已有规则时只合并对应函数条目。默认物料和货架已随业务函数打包。

完整源码在 `03-source.zip`，货架导入示例是 `05-Layout_Configuration_Example.xlsx`。静态托管的文件按第 1.2 步上传即可。
