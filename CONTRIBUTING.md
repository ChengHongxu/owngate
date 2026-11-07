# 参与 OwnGate 开发

欢迎修复问题、完善连接器和改善文档。当前处于开发阶段，修改应围绕实际产品路径，及时移除废弃实现；不为已经删除的试验功能保留兼容入口。

## 准备环境

需要 Node.js 24+ 和 pnpm 11，锁定版本见 [package.json](package.json)。克隆仓库后执行：

```sh
pnpm install --frozen-lockfile
pnpm build
```

首次本地启动前，在仓库根目录为开发数据生成持久主密钥：

```sh
mkdir -p out/dev
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))" > out/dev/master_key
chmod 0600 out/dev/master_key
export MASTER_KEY_HEX_FILE="$PWD/out/dev/master_key"
export DB_PATH="$PWD/out/dev/owngate.db"
export OWNGATE_ORIGIN=http://localhost:3000
export OWNGATE_RP_ID=localhost
export WEB_ROOT="$PWD/apps/web/dist"
export CONNECTORS_DIR="$PWD/connectors"
pnpm dev
```

生成密钥的命令只在首次运行，不能对已有开发数据库覆盖密钥。未配置持久主密钥时开发服务使用临时密钥，重启后原密文无法解密。

`pnpm dev` 监听的是 server 编译产物 `dist/main.js`；修改 TypeScript 后需要重新构建对应包，它不会自动编译源码。服务监听 3000；直接运行 Node 时服务绑定所有网卡，请在可信开发环境运行，或使用 Compose 的端口限制。

需要前端热更新时，另开终端执行：

```sh
pnpm --filter @owngate/web dev
```

Vite 默认端口为 5173，代理后台到本机 3000。使用这个地址进行真实认证时，应将 server 的 `OWNGATE_ORIGIN` 同步为 `http://localhost:5173` 并重启；RP ID 仍为 `localhost`。同一实例的后台 Origin 应保持一致。

本机 server 默认配置不能替代 browser、egress 和 HTTP runtime。要验证真实站点访问与隔离，请按[部署指南](deploy/README.md)启动完整 Compose 环境；只开发组件可使用[测试指南](docs/guides/testing.md)中的隔离夹具。

## 找到代码

| 修改内容 | 主要位置 |
|---|---|
| 统一调用、结果、权限与错误分类 | `packages/core` |
| HTTP / MCP / 后台接口和调度 | `apps/server` |
| 页面、表单、结果展示 | `apps/web` |
| CLI 和 MCP stdio 桥接 | `apps/cli` |
| 浏览器会话、站点采集 | `apps/browser`、`packages/browser-runtime` |
| 清单、OpenAPI、展示格式 | `packages/connector-runtime`、`connectors` |
| 数据和加密 | `packages/db`、`packages/vault` |
| 容器与出网隔离 | `deploy`、`services/egress-proxy`、`packages/runtime-http` |

先阅读[架构](docs/explanation/architecture.md)和相关接口契约。新增平台优先使用清单声明，不在通用页面中按连接器 ID 添加专属按钮或硬编码业务字段。可信代码适配器可参考[分页适配器](connectors/paged-json-example/README.md)。

## 验证修改

```sh
pnpm build
pnpm typecheck
pnpm typecheck:tests
pnpm test
```

这是基础检查。涉及远程登录、浏览器采集、权限或容器边界时，还需要相应的[浏览器与容器检查](docs/guides/testing.md)。UI 修改请运行相关 Playwright smoke，检查桌面和窄屏截图；截图与报告保存在 `out/ui/`，不提交账号数据和生成报告。

使用本地夹具验证契约、异常和权限边界。真实平台检查使用明确授权的账号与低频只读请求，不能重置平台预算或通过重试绕过风控。说明检查使用了模拟 API、真实 Chromium、隔离容器还是真实平台，分别报告结果。

## 提交修改

提交前检查 `git diff --check` 与暂存内容。不要提交 `.env`、密钥、客户端令牌、数据库、浏览器 profile、业务响应或个人截图。新增文件同时检查是否被构建与容器上下文正确包含。

提交说明应描述触发问题和修改后的行为。Pull Request 附上相关验证命令与结果；有尚未测试的真实环境边界时直接说明。避免把开发对话、临时绝对路径或过往测试次数写入产品文档。

用户步骤放在指南，协议字段放在参考，设计理由放在解释。更新功能时同步修改对应文档，并从[文档导航](docs/README.md)提供入口；不要建立没有内容的分类目录。
