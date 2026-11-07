# 验证代码、浏览器与部署

本指南在仓库根目录执行，前置环境见[贡献指南](../../CONTRIBUTING.md)。自动化使用临时数据库、密钥和本地夹具，不能据此声称目标平台或现有实例已经验收。

## 基础检查

```sh
pnpm build
pnpm typecheck
pnpm typecheck:tests
pnpm test
```

构建先产生内部包依赖需要的产物。`typecheck:tests` 额外检查测试源码；常规类型检查不能替代它。工作区测试使用 Vitest，egress 也有 Node 测试。没有额外的 lint 规则要求。

只修改一个区域时可以缩小测试范围，例如：

```sh
pnpm --filter @owngate/server exec vitest run test/connection-status.test.ts
pnpm --filter @owngate/web exec vitest run test/query-result.test.ts
```

## 安装与调用浏览器

浏览器自动化使用 Playwright 驱动 Chromium。依赖由工作区管理，系统依赖与浏览器可通过以下命令安装：

```sh
pnpm --filter @owngate/browser exec playwright install --with-deps chromium
```

Linux 默认浏览器缓存通常在 `~/.cache/ms-playwright`；设置 `PLAYWRIGHT_BROWSERS_PATH` 时使用指定目录。生产镜像的安装位置以 [browser Dockerfile](../../apps/browser/Dockerfile) 为准，不依赖宿主浏览器。OwnGate 的受管登录通过 CDP screencast 传送画面，自动化 smoke 则直接使用 Playwright 的 `chromium.launch`、页面 API、响应夹具和截图能力。

运行需要显式启用的真实 Chromium 回归：

```sh
OWNGATE_REAL_BROWSER_TEST=1 pnpm --filter @owngate/browser exec vitest run test/social-browser.test.ts test/egress-browser.test.ts
OWNGATE_REAL_BROWSER_TEST=1 pnpm --filter @owngate/browser-runtime exec vitest run test/screencast-browser.test.ts
```

这里的“真实 Chromium”表示运行浏览器进程；站点返回仍可被本地夹具截获，不表示测试使用真实平台账号。

## UI 验收

先完成 `pnpm build` 和 Chromium 安装。脚本启动临时服务或拦截本地 API，用断言和截图验证交互：

```sh
node scripts/product-ui-smoke.mjs --out out/ui/product
node scripts/auth-ui-smoke.mjs --out out/ui/auth
node scripts/ui-state-smoke.mjs --out out/ui/states
```

| 修改范围 | 对应脚本（`scripts/` 下） |
|---|---|
| 能力卡片与查询弹窗 | `connection-ui-smoke.mjs` |
| 连接验证和认证状态 | `connection-status-ui-smoke.mjs` |
| Schema 与结果展示 | `presentation-ui-smoke.mjs` |
| 客户端授权与接入方法 | `client-grants-ui-smoke.mjs` |
| 响应式布局与弹窗 | `spatial-ui-smoke.mjs` |
| 账户设置与主题 | `settings-ui-smoke.mjs` |
| 远程画面与二维码刷新 | `remote-login-ui-smoke.mjs` |
| 帮助弹层 | `help-ui-smoke.mjs` |

实际运行相关脚本后打开 `out/ui/` 下的 PNG，检查桌面与窄屏布局、文字截断、空态、错误态和弹窗。不要只依据脚本退出码判断视觉设计。

产品与状态脚本主要使用合成 API；认证脚本使用真实本地 server、临时数据库和 Chromium 虚拟 WebAuthn 设备。虚拟设备不能证明实体 Passkey、Windows Hello 或目标 HTTPS 证书可用。

## 容器隔离验收

需要运行中的 Docker Engine 和 Compose v2：

```sh
node scripts/deploy-smoke.mjs --build
node scripts/browser-smoke.mjs --build
node scripts/http-runtime-smoke.mjs --build
```

这些脚本使用一次性容器和数据，不读取已有的 `deploy/.env`、数据库、profile 或密钥。它们分别检查生产 server 的非 root 启动与持久化、headed Chromium 的沙箱及受控出网、HTTP runtime 的签名 RPC 与无特权子进程隔离。

CI 配置见 [.github/workflows/ci.yml](../../.github/workflows/ci.yml)。修改验证脚本时同步检查工作流中的命令和产物路径。

## 真实环境验收

真实平台验收应另列环境、站点版本、客户端授权、调用能力、结果状态与未完成项目。先从管理员能力页取得一次结果，再用专用受限客户端分别验证 REST、CLI 或 MCP，不能用 worker 直调成功代替客户端授权链路。

真实手机扫码、实体认证器、SMTP 投递、长期运行和恢复演练需在目标环境完成。日志与报告必须去掉账号身份、金额、内容正文、Cookie 和令牌；原始私有证据留在 Git 忽略目录。当前已知边界见[产品范围](../explanation/product-scope.md)。
