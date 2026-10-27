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
| 当前包版本 | `1.4.0` |
| 源码 / Issues | `Whwitpohe/polylog` |

`publisher` 字段是目标发布身份，不代表已经在商店注册或完成验证。GitHub 登录与商店发布权限分别管理。
本次更名沿用版本号：Linyra 是新的扩展 ID，旧身份下已经发布的版本不会占用新 ID 的版本号。
历史 `v1.4.0` 标签和 GitHub Release 保留原来的 Polylog 包，不替换其附件或校验值。

## 切换安装

1. 安装新包 `whwitpohe.linyra-1.4.0.vsix`。
2. 禁用或卸载旧的 `lntvan166.polylog-git`，只保留一个版本启用，然后重新加载窗口。
3. 现有 `polylog.*` 设置和快捷键继续有效；筛选、布局等扩展私有状态按新 ID 单独保存，首次切换时可能需要重新调整。

内部命令、配置、视图、菜单上下文和 URI scheme 保留原标识。这些是兼容接口，不按产品改名批量替换。
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
npm run package -- --out whwitpohe.linyra-1.4.0.vsix
Get-FileHash .\whwitpohe.linyra-1.4.0.vsix -Algorithm SHA256
```

还需验证最低支持版 VS Code 1.85.0，检查解压后的包内容与隐私扫描；本地词表通过忽略文件提供，CI 通过 Secret 提供。
两个商店上传同一份经过验证的 VSIX，不分别重新构建。发布前确认包内 publisher/name/version 与上表一致。

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

## 发布后的验证

- 分别核对两个商店中 `whwitpohe.linyra` 的版本、名称、发布者、源码与 Issues 链接。
- 下载商店包，核对实际扩展 ID 和行为，再把 README 的“待发布”状态更新为实际商店链接。
- 独立 ID 不会让原版用户自动迁移；在更新说明中提供上述切换步骤。
- GitHub 的后续 Linyra Release 应使用新标签明确对应新源码提交，不能修改旧标签来覆盖旧产品包。
