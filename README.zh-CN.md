# Linyra

**在一条时间线里查看工作区内所有仓库的 Git 历史。**

[English](https://github.com/Whwitpohe/polylog/blob/main/README.md) · [安装扩展](https://marketplace.visualstudio.com/items?itemName=whwitpohe.linyra) · [下载 VSIX](https://github.com/Whwitpohe/polylog/releases) · [反馈问题](https://github.com/Whwitpohe/polylog/issues)

一个需求改了前端、API、公共库和文档？搜索一次，就能看到所选仓库里的相关提交。
沿着真实分支图追踪合并，阅读完整提交说明，再用 VS Code 原生 Diff 核对每个文件。

![真实 VS Code 演示：一次搜索 ACME-142，查看四个仓库的相关提交并切换原生 Diff](https://raw.githubusercontent.com/Whwitpohe/polylog/main/media/v1.4.1/demo.gif)

演示使用六个中性的示例仓库和真实 Git 提交。静态图片均可打开查看原始分辨率。

## 安装与开始

在 Marketplace 搜索发布者 **whwitpohe** 的 **Linyra**，或执行：

```sh
code --install-extension whwitpohe.linyra
```

打开包含 Git 仓库的目录或多根工作区，执行命令 **Linyra: 打开合并日志**，
或点击底部 **Linyra** 标签。VS Code Git 已打开的仓库和工作区内发现的仓库会一起显示。

默认范围是**最近 24 小时、全部分支**。要找更早的提交，先把时间改为**全部时间**；
左侧仓库复选框可限制查看范围。使用其他扩展注册中心的编辑器，可以先从
[GitHub Releases](https://github.com/Whwitpohe/polylog/releases) 下载 VSIX 安装；Open VSX 尚未完成发布。

## 一次搜索，串起多个仓库的改动

输入需求编号、关键词或提交信息，各仓库结果集中展示，左侧色带标明所属仓库。
选择提交后，右侧同步显示更改文件；点击文件，在上方原生编辑器里查看差异。

![完整工作区：上方原生 Diff，下方多仓库日志、真实分支轨道与更改文件](https://raw.githubusercontent.com/Whwitpohe/polylog/main/media/v1.4.1/screenshot-log.png)

- **信息搜索与哈希定位。** 普通文字按提交信息匹配，不区分大小写。
  完整哈希或至少七位十六进制前缀可直接定位提交，`sha:abcd` 支持至少四位前缀。
  哈希定位在所选仓库内暂时忽略其他筛选，清空后恢复之前条件。
- **作者、分支都能搜索多选。** “我”读取各仓库配置的邮箱。
  多分支取历史并集，共同提交只显示一次；清空分支选择恢复全部本地／远程分支。
  不含所选分支的仓库会跳过，并显示数量。
- **路径与日期。** 路径支持相对于各仓库根目录的文件、文件夹或通配符；
  日期可选最近 24 小时、7 天、30 天、全部时间和自定义范围。
- **真实分叉与合并。** 图中彩色轨道连接同一仓库内的真实父提交。
  可按提交日期或拓扑排序，也可通过明确的图形控件折叠长线性历史，保留分支头、标签、分叉和合并。

![可搜索、多选的分支筛选器，同时选择 main 和 feature/saved-cards](https://raw.githubusercontent.com/Whwitpohe/polylog/main/media/v1.4.1/screenshot-branches.png)

## 看清完整提交说明

文件下方单独展示标题、正文段落、共同作者等尾注，以及作者／邮箱、时间、可复制哈希和仓库标记。
HEAD、本地分支、远程分支及标签带有对应图标和颜色；还能展开查看包含此提交的分支。

![完整提交正文、作者信息、多色引用图标与包含分支](https://raw.githubusercontent.com/Whwitpohe/polylog/main/media/v1.4.1/screenshot-details.png)

拖动文件列表和提交说明之间的分隔线调整高度，小箭头可隐藏／恢复说明，大小和显隐状态都会记住。
更改区工具栏保留**全部文件／更改文件**、展开／折叠、清除选择及提交操作菜单。
文件名和重命名旧路径沿用 Git 状态色，增删行数靠右对齐。

文件搜索支持名称、完整路径和重命名前路径；Enter 打开首个匹配，Escape 清空搜索。
在“全部文件”模式下，搜索范围仍为此提交的更改文件。

## 在多个仓库里比较两条分支

从日志工具栏或 **Linyra: 比较分支** 打开比较面板。
只需选择一次左右分支，就能查看所选仓库中各自的差异，并明确列出缺少分支的仓库。

![分支比较：仓库汇总、左右文件树和完整操作按钮](https://raw.githubusercontent.com/Whwitpohe/polylog/main/media/v1.4.1/screenshot-compare.png)

**文件／提交**模式、左右交换、刷新、分支搜索、收藏和最近使用都可直接操作。
左右侧还各自保留显示模式、相同内容过滤、展开／折叠、加载更多和右键菜单。
点击文件查看两条分支当前版本的原生 Diff；“自分叉以来的更改”用于核对此侧带来的内容。

日志／更改区与分支比较都支持左右或上下布局、拖动分隔线、明确的显示／隐藏按钮。
点击标题或右侧空白不会折叠整片视图；文件夹和提交树由小箭头或键盘操作展开。
“在编辑器中打开更改”还可打开单独可移动的更改标签。

## 日常使用的其他入口

| 功能 | 入口与用途 |
| --- | --- |
| **文件历史** | 在资源管理器、编辑器／标签或更改区右键文件，查看跟随重命名的历史。暂时放开搜索、作者和日期限制，退出时恢复。 |
| **合并查看更改** | Ctrl/⌘ 或 Shift 多选提交，支持跨仓库。同一文件汇总展示；可分离时只展示所选提交带来的改动，无法分离的重叠改动会提示。不会改写提交历史。 |
| **未提交改动** | 日志顶部“提交／未提交”切换，或打开独立未提交侧栏。跨仓库查看工作文件，通过明确命令暂存、取消暂存、丢弃和提交，接入 VS Code Git。 |
| **分支侧栏** | 左侧切换“仓库／分支”，浏览本地与远程分支、搜索和收藏。点击分支筛选日志；右键提供当前仓库的检出、新建、比较、重命名、合并、变基、工作树、获取、拉取、推送和删除操作。 |
| **仓库配置组** | 保存当前仓库选择，之后一键恢复；通过工作区 `polylog.profiles` 设置共享。 |
| **获取／拉取** | 按需获取，查看领先／落后数量，筛出落后仓库；批量拉取使用快进检查。 |
| **行归属与当前文件** | 原生 Diff／历史版本编辑器显示行归属；“打开文件”跳到工作区当前文件的相同行。 |
| **复制与远程链接** | 提交和文件右键菜单提供复制及支持的 Git 托管平台链接。 |

![文件历史与跟随选择的原生 Diff](https://raw.githubusercontent.com/Whwitpohe/polylog/main/media/v1.4.1/screenshot-file-history.png)

## 键盘、主题与语言

| 日志中的按键 | 操作 |
| --- | --- |
| `↑` / `↓`、`Home` / `End`、`PageUp` / `PageDown` | 切换提交，更改文件随之更新 |
| `Shift+↑` / `Shift+↓` | 多选提交 |
| `Enter` | 打开所选提交的第一个更改文件 |
| `/` 或 `Ctrl/Cmd+F` | 聚焦提交信息搜索 |
| `Esc` | 清空搜索，再返回列表 |

界面颜色和字体跟随 VS Code，支持浅色、深色及两种高对比度主题。
语言随编辑器显示语言切换，支持英文和简体中文，其他语言回退为英文。

![同一真实工作区的深色、浅色及两种高对比度主题](https://raw.githubusercontent.com/Whwitpohe/polylog/main/media/v1.4.1/screenshot-themes.png)

## 设置与运行要求

需要 **VS Code 1.85+** 和 **Git**。Git 路径依次采用 `git.path`、VS Code Git 找到的程序或 PATH 中的 Git。
查看历史、搜索与折叠不会写仓库；Git 操作只在明确选择对应命令时执行。

| 设置 | 默认值 | 用途 |
| --- | --- | --- |
| `polylog.pageSize` | `200` | 每仓库每页读取提交数量 |
| `polylog.maxConcurrency` | `16` | Git 最大并发数 |
| `polylog.scanDepth` | `2` | 工作区目录内的仓库发现深度 |
| `polylog.excludeRepos` | `[]` | 排除的仓库名／路径模式 |
| `polylog.profiles` | `{}` | 命名的仓库选择配置 |
| `polylog.blame` | `true` | 在 Diff 与历史版本中显示行归属 |

筛选条件交给 Git，读取结果分页合并；不维护持久化历史索引或数据库，不后台获取远程更新。
输入筛选有防抖，新查询会取消被替代的 Git 读取。

## 从 Polylog 切换

Linyra 基于 **lntvan166** 创建的 [Polylog](https://github.com/lntvan166/polylog) 独立维护，
扩展 ID 为 **`whwitpohe.linyra`**。切换时禁用或卸载 `lntvan166.polylog-git`，重新加载窗口，只启用一个版本。
已有 `polylog.*` 设置与快捷键继续使用；筛选和面板大小属于各扩展私有状态，首次切换可能需重新设置。

原 `v1.4.0` GitHub Release 保留历史 Polylog 安装包，后续 Linyra 版本使用与源码匹配的新标签和 VSIX 名称。

## 开发与许可证

参见[开发与发布](https://github.com/Whwitpohe/polylog/blob/main/docs/PUBLISHING.md)和
[演示素材录制说明](https://github.com/Whwitpohe/polylog/blob/main/dev/demo/README.md)。
问题和贡献可提交至 [Whwitpohe/polylog](https://github.com/Whwitpohe/polylog)。

**MIT**。保留 Polylog 原作者版权、[LICENSE](https://github.com/Whwitpohe/polylog/blob/main/LICENSE) 与第三方声明。
