# 文档导航

第一次使用从「首次使用」开始；维护实例和修改工程分别使用下面的运维与贡献者入口。

## 使用 OwnGate

| 文档 | 解决的问题 |
|---|---|
| [部署](../deploy/README.md) | 配置密钥、域名、HTTPS 和容器 |
| [首次使用](guides/first-query.md) | 从管理员账户到第一次获准查询 |
| [客户端接入](guides/connect-clients.md) | 把同一套授权用于 MCP、CLI 和 HTTP API |
| [离线维护](guides/maintenance.md) | 备份、密码恢复、密钥轮换和凭据重置 |
| [扩展导入](extensions.md) | 安装自己的声明式 HTTP / OpenAPI 连接器 |

## 查阅规格

| 文档 | 内容 |
|---|---|
| [客户端接口](reference/client-interfaces.md) | CLI 选择器、REST 路径、MCP 工具与结果语义 |
| [扩展格式](reference/extensions.md) | 支持的 OpenAPI 子集、展示与组合视图声明 |
| [New API 接口范围](../connectors/newapi/README.md) | 路由、角色、单位与渠道比较约束 |
| [部署配置示例](../deploy/.env.example) | 环境变量及用途；密钥挂载见 Compose 配置 |

## 理解设计

- [架构与信任边界](explanation/architecture.md)：服务职责、数据调用路径与凭据隔离。
- [产品范围与实现边界](explanation/product-scope.md)：哪些功能已经实现，哪些场景仍需真实环境验证。

## 参与开发

- [贡献指南](../CONTRIBUTING.md)：准备开发环境、定位代码、提交修改。
- [测试指南](guides/testing.md)：单元测试、浏览器验收、容器隔离和证据范围。
- [品牌资源](brand/owngate/README.md)：当前标志与资源重新生成方式。

文档随代码维护。用户操作放在指南，协议与字段放在参考，设计理由放在解释；开发记录和本机私有验收文件不作为产品文档。
