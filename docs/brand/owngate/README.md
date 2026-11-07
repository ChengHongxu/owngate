# OwnGate 标志

标志采用「私域通道」。以自有中心、边界和唯一开放通道表达「个人网络资产网关」。[d-private-domain.svg](d-private-domain.svg) 是正式图标的唯一几何来源；应用中的品牌标识直接引用网站 SVG 图标，避免维护两套图形。

正式资产使用深青 `#167D76`：透明背景的 SVG、包含 16/32/48px 三个尺寸的 ICO，以及浅色不透明背景的 180px 触屏图标。缓存版本统一为 `owngate-d-1`。

在工程根目录重新生成资产并进行 Chromium 验证：

```sh
node scripts/owngate-brand.mjs
```

仅验证当前资产：

```sh
node scripts/owngate-brand.mjs --check
```

脚本解码实际 SVG、ICO 和 PNG，检查源图一致性、ICO 尺寸、16/24/32/48px 留白及触屏图标不透明背景，并生成明暗主题和字标组合截图。预览和报告位于 `out/ui/owngate-d-brand/`。


脚本需要先安装项目依赖与 Playwright Chromium，参见[测试指南](../../guides/testing.md)。返回[文档导航](../../README.md)。
