# Linyra 发布与迁移

Linyra 基于 [Polylog](https://github.com/lntvan166/polylog) 独立维护，原作者为 lntvan166。
保留原 MIT 版权声明、LICENSE 和 ThirdPartyNotices.txt；产品名称、发布者与问题反馈入口归当前维护者。

## 发布身份

| 项目 | 值 |
| --- | --- |
| 产品名 | Linyra |
| 英文展示名 | Linyra — Multi-Repo Git Log |
| 中文展示名 | Linyra — 多仓库 Git 日志 |
| Publisher / Open VSX namespace | `whwitpohe` |
| package name | `linyra` |
| 完整扩展 ID | `whwitpohe.linyra` |
| 当前包版本 | `1.7.0` |
| 源码 / Issues | `Whwitpohe/linyra` |

Marketplace 已公开发布 [whwitpohe.linyra](https://marketplace.visualstudio.com/items?itemName=whwitpohe.linyra)。
Open VSX 当前因命名空间未验证而未激活；不要将它列为公开可安装。
命名空间所有权申请：https://github.com/EclipseFdn/open-vsx.org/issues/14842 。
GitHub 登录与商店发布权限分别管理。Linyra 是新的扩展 ID，旧身份的版本不会占用新 ID 的版本号。
历史 `v1.4.0` 标签和 GitHub Release 保留原来的 Polylog 包，不替换其附件或校验值。

## 切换安装

1. 从 Marketplace 安装 `whwitpohe.linyra`，或安装新包 `whwitpohe.linyra-1.7.0.vsix`。
2. 重新加载窗口。命令、视图、上下文和 URI 均使用 Linyra 标识，可与 `lntvan166.polylog-git` 共存。
3. 设置使用 `linyra.*`，不读取、注册或迁移旧 `polylog.*` 配置，也不改写现有配置文件。
   自定义快捷键改用 `linyra.*` 命令；不再注册 `polylog.*` 命令别名。

公开配置和内部标识均使用 Linyra 命名空间。激活时只在 `whwitpohe.linyra` 自己的
workspaceState/globalState 内，将旧版 Linyra 的 `polylog.*` 键迁移为 `linyra.*`，保留筛选、
布局及收藏，优先保留已存在的新键，写入成功后清理旧键。不打开或修改原扩展的私有状态数据库。
视图 ID 已变更，自定义视图停靠位置可能需要重新调整；旧 `polylog:` 历史编辑器需从 Linyra 重新打开。

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
npm run package -- --out whwitpohe.linyra-1.7.0.vsix
Get-FileHash .\whwitpohe.linyra-1.7.0.vsix -Algorithm SHA256
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
- `media/linyra.svg` 保留原三线合流的单色面板图形，通过 `currentColor` 跟随编辑器主题。
- 更改品牌不改变编辑器的 Git 状态色、布局或任何功能入口。

## Visual Studio Marketplace

在 [Publisher 管理后台](https://marketplace.visualstudio.com/manage) 使用自己的 Microsoft 账号创建或管理 `whwitpohe` 发布者。
首次发布可以选择 New extension → Visual Studio Code，手动上传上面生成的 VSIX。

### 发布 GitHub Release 即自动发布（Trusted Publishing）

`.github/workflows/publish-marketplace.yml` 在正式 GitHub Release 发布时运行，也可在
Actions → Publish to the VS Code Marketplace → Run workflow 输入版本标签手动补发。
它核对 Release、对应源码的 main CI、附件 SHA-256 与 `SHA256SUMS.txt`、包内 publisher/name/version，
再用 `vsce publish --oidc --skip-duplicate` 上传同一份包。不存放任何令牌：
Marketplace 发布者后台 → Trusted Publishing 中的策略 `linyra-github-releases` 信任以下来源：

| 字段 | 值 |
| --- | --- |
| Provider | GitHub Actions |
| Repository owner / Repository | `Whwitpohe` / `linyra` |
| Workflow | `publish-marketplace.yml` |
| Environment | 留空 |

改名工作流文件或仓库后要同步修改策略。已发布的版本会认证后跳过，重复运行无害。

### 网页上传（自动发布失败时的备用方式，1.4.x 与 1.5.0 用过）

不需要令牌，只需要一个已登录维护者 Microsoft 账号的浏览器：

1. 打开 https://marketplace.visualstudio.com/manage/publishers/whwitpohe 。
2. Linyra 一行 → **More Actions…** → **Update**。
3. 选择经过验证的 `whwitpohe.linyra-X.Y.Z.vsix`，确认对话框显示该文件名，点 **Upload**。
4. 该行显示 `旧版本 Verifying X.Y.Z`，Microsoft 扫描约 5 分钟；`npx vsce show whwitpohe.linyra` 显示新版本即已上线。

同一版本号不能重复上传；扫描被拒只能发新的补丁版本。
CLI 方式（`vsce publish`）需要 Azure DevOps 的 Marketplace 令牌；本机存的令牌已过期（`vsce verify-pat` 报 TF400813），
网页上传不受影响。令牌只由维护者本人生成和输入，不写进仓库、聊天或脚本。

### GitHub Release

每个版本都在 GitHub 创建 Release：标题 `Linyra X.Y.Z`，正文为 `— 日期` 加 CHANGELOG 对应段落，
附件为同一份 VSIX 与 `SHA256SUMS.txt`（`<sha256>  <文件名>`），设为 latest。
发布后核对 GitHub 给出的附件 SHA-256 与本地包一致。Release 发布会触发上面的 Marketplace 发布和下面的 Open VSX 同步。
完整操作步骤（Claude 发版时照做）见 `.claude/skills/release/SKILL.md`。
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
| Repository name | `linyra` |
| Workflow filename | `publish-open-vsx.yml` |
| Environment name | 留空 |

命名空间未验证或尚无激活版本时，工作流在摘要中说明等待原因并跳过上传，不把它报告为发布成功。
服务不可访问和已开始上传后的错误仍使流程失败。命名空间审核通过、扩展激活后，仍需完成上述绑定；
绑定完成前不能据此声称自动发布已经启用。
首次 1.4.2 通过网页上传，文件 SHA-256 为
`4c94329977c0e79c4de09144bdf50b11cef62db948eac2ecf7c2a6d5ee250cc9`，与 GitHub Release 一致。
这套流程将已有 Release 同步到 Open VSX；Marketplace 由 publish-marketplace.yml 以同样方式发布。
官方说明：https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing 。

## 发布后的验证

- 分别核对两个商店中 `whwitpohe.linyra` 的版本、名称、发布者、源码与 Issues 链接。
- 下载商店包，核对实际扩展 ID、版本、说明和行为；只把实际发布成功的注册中心列为可用。
- 独立 ID 不会让原版用户自动迁移；在更新说明中提供上述切换步骤。
- GitHub 的后续 Linyra Release 应使用新标签明确对应新源码提交，不能修改旧标签来覆盖旧产品包。
