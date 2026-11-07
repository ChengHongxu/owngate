# 发布一个版本

本指南面向仓库维护者。发布流程将版本 tag 对应的源码构建为 Linux amd64 镜像，在隔离测试通过后推送到 GitHub Container Registry（GHCR），并创建带部署包的 GitHub Release。使用已发布版本的用户请阅读[发布包部署说明](../../deploy/release-README.md)。

## 准备仓库

启用 GitHub Actions，并确认仓库策略允许发布工作流获得 `contents: write` 和 `packages: write`。发布使用当前仓库的 `GITHUB_TOKEN`，无需额外保存 GHCR 访问令牌。普通 CI 保留只读权限。

首次发布后，在 GHCR 的包设置中确认以下四个包已关联仓库并允许工作流访问；提供给用户匿名拉取时，将四个包的可见性设为 Public。公开源码仓库并不保证新建镜像包自动公开。

```text
ghcr.io/<owner>/owngate-server:<version>
ghcr.io/<owner>/owngate-browser:<version>
ghcr.io/<owner>/owngate-http-runtime:<version>
ghcr.io/<owner>/owngate-egress:<version>
```

`<owner>` 是 GitHub 仓库所有者的小写名称，`<version>` 不含 tag 的 `v` 前缀。Web 静态资源包含在 server 镜像中。当前不发布 ARM64、npm 包或桌面安装包，也不自动部署服务。

## 推送版本 tag

先完成并提交版本修改，运行[测试指南](testing.md)中的检查。准备 Release 说明，注明数据库变化、升级要求和已知限制。确认工作区与当前提交后，为将要发布的提交打 tag：

```sh
git status
git tag -a v0.1.0 -m "OwnGate 0.1.0"
git push origin v0.1.0
```

把示例版本替换为本次未使用的版本。tag 采用 `v` 加语义化版本，例如 `v0.1.0` 或 `v0.2.0-rc.1`。不接受 `+build` 元数据，避免不合法的 Docker 标签。预发布版本自动标为 prerelease。不要重建已经发布的版本 tag；修复后使用新版本。

推送 tag 后，发布工作流复用 CI 完成源码与浏览器检查，再构建四个镜像，用实际镜像执行服务启动、浏览器和 HTTP 执行隔离测试。只有这些检查通过才推送版本镜像并创建 Release。普通提交和 PR 只运行 CI；没有自动更新的 `latest` 镜像标签。

## 检查发布结果

确认工作流成功，并在 GitHub Release 查看部署包和校验文件：

```text
owngate-deploy-0.1.0.tar.gz
SHA256SUMS
```

部署包只包含 `compose.yaml`、`.env.example`、`nginx.example.conf` 和 `README.md`。Compose 引用固定版本的四个镜像，没有源码构建步骤，也不包含数据库、密钥或客户端令牌。校验文件用于检查部署压缩包是否完整，不代替对发布来源的确认。

下载部署包，在全新目录按随包 README 验证拉取与首次启动。确认匿名用户能读取四个镜像，并检查 Release 中生成的更新说明，补充实际的升级步骤与已知限制。发布中断可能留下部分已上传的镜像；以成功完成的 Release 为对外交付依据，排查失败后重跑原提交的工作流。

用户升级必须保留 `.env`、密钥与持久数据。数据库可能发生升级，回退前需要匹配版本的备份，不能仅更换镜像标签。完整维护要求见[离线维护](maintenance.md)。返回[文档导航](../README.md)。
