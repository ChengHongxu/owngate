# 可信 TypeScript 适配器示例

这个示例面向自建 JSON API。它读取 `/api/records?page=1` 到 `page=3`，每页返回 `{ items: [{ id, title }], has_more }`。它没有真实站点账号，也不作为默认连接器加载。

源码位于 `packages/runtime-http/adapters/paged-json-example/adapter.mts`。运行 `pnpm --filter @owngate/runtime-http build` 会编译出此目录的 `adapter.mjs`；生产镜像把编译结果与清单一起打包。需要启用时，先审查代码，把 `manifest.example.yaml` 复制为 `manifest.yaml`，构建新镜像，再在后台添加连接与只读令牌。后台粘贴导入不支持安装代码适配器。

`run(capabilityId, input, ctx)` 使用 `HttpAdapter` 类型。上下文包含 `http.get`、`browser`（HTTP 下为 `undefined`）、`log` 和 `signal`。每个能力的请求 URL 必须与清单 `request.path` 或 `request.readonly_paths` 渲染后的 URL 完全匹配；路径不是通配符，每次调用最多 12 次 GET/HEAD。凭据由 server 代理注入，不传入适配器。只读调用、输出 schema、当前授权、脱敏和加密缓存仍经过统一入口。

代码适配器是随镜像审查发布的可信代码。生产 Compose 用独立容器和无特权子进程限制其资源与凭据访问；这不等于允许用户上传任意 Node.js 代码。开发模式的本机子进程用于调试，正式运行使用 Compose 隔离服务。
