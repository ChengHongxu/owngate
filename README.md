# Webridge

> 将分散在不同网站上的资源与功能统一接入，为 MCP、CLI 和 Web 管理后台提供一致的接口。

网站接入一次，人、脚本和兼容的 AI 客户端都能使用其已授权能力。

## 文档

**只有两份有效文档**，其余历史文档已归档到 `archive/`（仅供追溯，不作为依据）。

| 文件 | 内容 |
|---|---|
| [`需求.md`](需求.md) | 要什么。产品定位、范围、三个入口、安全要求、明确不做的事 |
| [`设计方案.md`](设计方案.md) | 怎么做。**唯一实现依据**。开头是 13 条决策记录，然后是架构、协议、里程碑 |

实现中的任何架构偏离：**先改 `设计方案.md`，再改代码**。

## 核心承诺

**一处定义，三处可用。** 一项能力只用 JSON Schema 定义一次，MCP 工具、CLI 参数、后台表单全部从它生成。鉴权、脱敏、审计、缓存只在一个 `invoke()` 里实现一次。

## 技术栈

TypeScript 全栈，Node.js 24 LTS。

```
后端      Fastify + MCP 官方 TS SDK + SQLite(Drizzle) + Zod
浏览器    Playwright + Xvfb + CDP screencast（无 VNC）
前端      React + Vite + shadcn/ui + rjsf
部署      Docker Compose + Caddy（内部 CA，仅局域网）
```

## 里程碑

| 阶段 | 内容 |
|---|---|
| **M0** | 完整骨架：三入口跑通、权限/脱敏/审计/缓存/任务全部就位 |
| **M1** | 浏览器沙箱与远程登录（CDP 画面、扫码登录） |
| **M2** | 社交信息流：B站 / 小红书 / 知乎 / X |
| **M3** | HTTP 声明式清单与中转站（自建 newapi 双视角） |
| **M4** | 监控与邮件通知 |
| **M5** | 写操作框架（完整实现，不开放任何能力） |

## 开始之前

`设计方案.md` §16 列了三个**必须在写代码前实测**的项：

1. MCP 客户端能否信任 Caddy 的内部 CA（失败则退到 `webridge mcp` stdio 转发）
2. 二维码在 CDP 画面里能否扫出（有高清叠加方案，但要实测）
3. Chromium 沙箱能否在 Docker/WSL2 下启动（禁止 `--no-sandbox`）

## 开发环境

```bash
node --version    # >= 24
pnpm --version
docker compose version
```

```bash
pnpm install
pnpm dev                         # 本地开发
docker compose -f deploy/docker-compose.yml up    # 全栈
```

## 范围边界

单用户自用，仅局域网，不做多租户、不暴露公网、本期不开放写操作。完整清单见 `需求.md` §9。
