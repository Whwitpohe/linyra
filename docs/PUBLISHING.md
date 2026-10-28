# Linyra 发布与迁移

Linyra 基于 [Polylog](https://github.com/lntvan166/polylog) 独立维护，原作者为 lntvan166。
保留原 MIT 版权声明、LICENSE 和 ThirdPartyNotices.txt；产品名称、发布者与问题反馈入口归当前维护者。

## 发布身份

| 项目 | 值 |
| --- | --- |
| 产品名 | Linyra |
| 英文展示名 | Linyra — Multi-Repo Git History |
| 中文展示名 | Linyra — 多仓库 Git 历史 |
| Publisher / Open VSX namespace | `whwitpohe` |
| package name | `linyra` |
| 完整扩展 ID | `whwitpohe.linyra` |
| 当前包版本 | `1.4.2` |
| 源码 / Issues | `Whwitpohe/polylog` |

Marketplace 已公开发布 [whwitpohe.linyra](https://marketplace.visualstudio.com/items?itemName=whwitpohe.linyra)。
Open VSX 已上传 1.4.2，但当前因命名空间未验证而未激活；不要将它列为公开可安装。
命名空间所有权申请：https://github.com/EclipseFdn/open-vsx.org/issues/14842 。
GitHub 登录与商店发布权限分别管理。Linyra 是新的扩展 ID，旧身份的版本不会占用新 ID 的版本号。
历史 `v1.4.0` 标签和 GitHub Release 保留原来的 Polylog 包，不替换其附件或校验值。

## 切换安装

1. 从 Marketplace 安装 `whwitpohe.linyra`，或安装新包 `whwitpohe.linyra-1.4.2.vsix`。
2. 禁用或卸载旧的 `lntvan166.polylog-git`，只保留一个版本启用，然后重新加载窗口。
3. 设置使用 `linyra.*`，不读取、注册或迁移旧 `polylog.*` 配置，也不改写现有配置文件。
   命令快捷键继续有效；筛选、布局等扩展私有状态按新 ID 单独保存，首次切换时可能需要重新调整。

公开配置使用 Linyra 自己的命名空间。内部命令、视图、菜单上下文和 URI scheme 保留原标识。
这些命令和视图是兼容接口，不随设置名称批量替换。
因此两份扩展不适合同时启用。此策略不删除任何现有命令或配置项，也不修改原扩展的私有状态数据库。

## 构建同一份商店包

```powershell
npm ci
npm test
npm run lint
npm run typecheck
npm run check:theme
npm run check:design
npm run check:denylist
npm run test:integration
npm run package -- --out whwitpohe.linyra-1.4.2.vsix
Get-FileHash .\whwitpohe.linyra-1.4.2.vsix -Algorithm SHA256
```

还需验证最低支持版 VS Code 1.85.0，检查解压后的包内容与隐私扫描；本地词表通过忽略文件提供，CI 通过 Secret 提供。
两个商店上传同一份经过验证的 VSIX，不分别重新构建。发布前确认包内 publisher/name/version 与上表一致。
完整本地检查命令之外，还需等待合并后 main CI 通过。图片使用版本目录和绝对 raw.githubusercontent.com
地址；先推送素材并核对响应，再更新商店。录制步骤见 [dev/demo/README.md](../dev/demo/README.md)。

## 品牌图标

- `media/icon-source.png` 是用户确认的配色原图：保留原 Polylog 的三线合流结构，改为紫／蓝／薄荷绿与深蓝底。两个 PNG 交付尺寸从此图直接缩放，不再次生成或重画。
- `media/icon.svg` 是同配色的可编辑矢量参考；图形继承原 Polylog，保留上游版权及来源，不作为新的原创图形声称。
- `media/icon.png` 是扩展商店使用的 256×256 PNG，随 VSIX 打包。
- `media/publisher-icon.png` 是发布者表单使用的 128×128 PNG，不放进 VSIX。
- `media/polylog.svg` 保留原三线合流的单色面板图形，通过 `currentColor` 跟随编辑器主题；文件名继续保持兼容。
- 更改品牌不改变编辑器的 Git 状态色、布局或任何功能入口。

## Visual Studio Marketplace

在 [Publisher 管理后台](https://marketplace.visualstudio.com/manage) 使用自己的 Microsoft 账号创建或管理 `whwitpohe` 发布者。
首次发布可以选择 New extension → Visual Studio Code，手动上传上面生成的 VSIX。
后续自动发布采用自己的授权，遵循 [VS Code 官方发布指南](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)。
不要使用原作者的发布者身份、账户或令牌。

## Open VSX

使用自己的 GitHub 账号登录 [Open VSX](https://open-vsx.org)，关联 Eclipse 账号并签署 Publisher Agreement。
创建自己的 `whwitpohe` namespace，按要求完成所有权验证；再上传同一份 VSIX。
参照 [发布指南](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions) 和
[命名空间管理指南](https://github.com/EclipseFdn/open-vsx.org/wiki/Managing-Namespaces)。

如果使用 CLI，令牌仅通过本机安全输入或 CI Secret 提供，不写进仓库、命令记录示例或聊天。

### 同步 GitHub Release 到 Open VSX

`.github/workflows/publish-open-vsx.yml` 在发布正式 GitHub Release 时同步已有的 VSIX，
也可在 Actions → Publish to Open VSX → Run workflow 输入版本标签手动补发。
流程要求对应源码的 main CI 已通过，下载 Release 中的 VSIX 和 `SHA256SUMS.txt`，
核对 GitHub 提供的 SHA-256、校验文件以及包内 publisher/name/version，再上传同一份包。
不重新构建，不变更版本、标签或历史 Release。重复执行会跳过已经发布的版本。

自动发布使用 Open VSX Trusted Publishing（OIDC），不需要存放长期发布令牌。
首次启用还需在命名空间审核通过、至少一个扩展版本激活后，由命名空间 owner
在 Open VSX → Settings → Trusted Publishers 添加以下绑定：

| 字段 | 值 |
| --- | --- |
| Namespace / Extension | `whwitpohe` / `linyra` |
| Provider | GitHub Actions |
| Organization or User name | `Whwitpohe` |
| Repository name | `polylog` |
| Workflow filename | `publish-open-vsx.yml` |
| Environment name | 留空 |

绑定完成前，工作流已准备好，但自动上传不会成功；不能据此声称自动发布已经启用。
首次 1.4.2 通过网页上传，文件 SHA-256 为
`4c94329977c0e79c4de09144bdf50b11cef62db948eac2ecf7c2a6d5ee250cc9`，与 GitHub Release 一致。
这套流程将已有 Release 同步到 Open VSX；Visual Studio Marketplace 仍沿用原发布方式。
官方说明：https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing 。

## 发布后的验证

- 分别核对两个商店中 `whwitpohe.linyra` 的版本、名称、发布者、源码与 Issues 链接。
- 下载商店包，核对实际扩展 ID、版本、说明和行为；只把实际发布成功的注册中心列为可用。
- 独立 ID 不会让原版用户自动迁移；在更新说明中提供上述切换步骤。
- GitHub 的后续 Linyra Release 应使用新标签明确对应新源码提交，不能修改旧标签来覆盖旧产品包。
