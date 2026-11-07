# 离线维护与恢复

先完成[部署](../../deploy/README.md)，以下命令均在仓库根目录执行，使用默认 Compose 项目。自定义项目需要在每条命令中沿用同一 `-p` 参数。

## 准备维护


维护前停止 server 并备份数据；数据库租约会拒绝在线并行维护。server 镜像已包含 CLI，可用 `docker compose run --no-deps` 在同一数据卷上执行。`run` 启动的是一次性维护进程，不能同时启动常驻 server。

审计记录输入摘要；数据库、浏览器 profile 和备份仍包含敏感数据，应按相同保密要求保存。重置是逻辑删除，不能代替备份和存储介质的安全管理。

忘记密码时，用编辑器把新密码写入单独的 0600 文件，属主 UID 1000，避免把密码放在命令参数或 shell 历史里：

```sh
docker compose -f deploy/docker-compose.yml stop server
docker compose -f deploy/docker-compose.yml run --rm --no-deps \
  -v "$PWD/recovery-password:/run/recovery-password:ro" \
  server node apps/cli/dist/bin.js admin reset-password \
  --db /data/owngate.db --username admin --password-file /run/recovery-password
docker compose -f deploy/docker-compose.yml up -d server
```

此命令原子重置密码、撤销会话并追加审计。需要同时重置丢失的 Passkey 时，显式加 `--reset-passkeys`；它保留 TOTP。完成后删除临时密码文件。TOTP 丢失但仍有 Passkey 时，可使用密码加 Passkey 登录，再在安全设置重新绑定。

轮换主密钥时，准备一个仅 UID 1000 可写的私有目录（下面使用 `deploy/rekey`），将数据库与当前密钥分别备份，再执行：

```sh
docker compose -f deploy/docker-compose.yml stop server
docker compose -f deploy/docker-compose.yml run --rm --no-deps \
  -v "$PWD/deploy/rekey:/run/rekey" \
  server node apps/cli/dist/bin.js vault rekey \
  --db /data/owngate.db --old-key-file /run/secrets/master_key \
  --new-key-file /run/rekey/master_key.next
```

新密钥文件在数据库事务前创建并同步到磁盘。成功后，把 `master_key.next` 以 0600 / UID 1000 安装为 `deploy/secrets/master_key`，确认没有旧的 `MASTER_KEY_HEX` 环境变量覆盖文件，再启动 server。保留旧密钥用于解密旧备份。失败时事务回滚，不删除任一密钥文件；确认使用的数据库与密钥配对后再恢复服务。不要把密钥目录打包进数据库备份。

主密钥丢失时无法恢复原密文。确定接受数据丢失后，先停止 **server 和 browser**，备份数据库与 profile 卷，再显式运行 `vault reset`。数据库租约只能阻止 server 并行访问，不能代替停止 browser。维护进程必须挂载当前部署实际使用的 profile 卷；以下命令使用默认项目名 `owngate`，若修改了项目名或卷配置，先确认并替换已有的真实卷名，不能用新建空卷代替。

如果原 `deploy/secrets/master_key` 文件已经丢失，需在停机后先按首次部署的方式生成新文件并设为 0600 / UID 1000，使 Compose 能挂载 secret。重置命令不读取旧密钥；完成重置前保持服务停机，避免用新密钥启动旧数据库。

```sh
docker compose -f deploy/docker-compose.yml stop server browser
docker volume inspect owngate_browser-profiles && \
docker compose -f deploy/docker-compose.yml run --rm --no-deps \
  -v owngate_browser-profiles:/profiles \
  server node apps/cli/dist/bin.js vault reset \
  --db /data/owngate.db --profiles-dir /profiles --confirm
```

成功输出 `status: vault_reset` 后，将新的主密钥以 0600 / UID 1000 安装到 `deploy/secrets/master_key`（已准备新文件时沿用），确认环境变量没有覆盖它，再启动 server/browser。管理员密码、Passkey、客户端令牌与授权、连接配置、扩展及审计保留；TOTP、凭据、缓存、SMTP/监控配置和浏览器登录态清除。任务和提案保留元数据，原输入与结果丢弃；所有连接暂停，写操作继续关闭。重新登录，配置 MFA、凭据和通知，逐项验证后再恢复连接。

命令先隔离 profile，再原子提交数据库重置，提交后删除隔离内容。非零退出时按错误提示处理：数据库回滚会尝试恢复 profile；`COMMITTED` 表示已提交，需保持两服务停机并清理报告的隔离目录；`UNKNOWN` 表示提交结果尚未确认，需核查 `vault.reset` 审计，确认结果前不能恢复旧 profile。中断遗留的隔离目录会阻止直接重跑。重置属于逻辑删除，旧备份、SQLite/WAL 和磁盘残留仍须按原敏感数据管理。


## 备份与恢复原则

数据库、主密钥和浏览器 profile 必须配套管理。停止写入后备份 SQLite 数据卷与 profile 卷，将主密钥单独保存，并记录对应版本与配置。不要直接复制正在写入的 SQLite 主文件而遗漏 WAL。

恢复时保持服务停机，恢复匹配的数据库、主密钥和 profile，再启动并逐项检查管理员登录、解密、客户端授权和真实查询。健康接口返回 200 不能证明备份已可恢复；应在隔离环境定期演练。

返回[文档导航](../README.md)。
