# Linyra 中文词表

`l10n/bundle.l10n.zh-cn.json`（运行时文案）和 `package.nls.zh-cn.json`（菜单、命令、设置）用同一套词。
新文案照这里写；`src/glossary.test.ts` 会拒绝左栏“不用”的词。

| English | 用 | 不用 | 说明 |
|---|---|---|---|
| check out / checkout | 签出 | 检出、切换 | “切换”只用于切换仓库组、切换 AI 模型这类不是 git checkout 的操作 |
| Check Out Revision | 签出此提交 | 签出此修订 | |
| Smart Checkout | 智能签出 | 智能检出 | |
| cherry-pick | 拣选 | 优选 | |
| stash | 储藏 | 贮藏 | |
| detached HEAD | 分离 HEAD | 游离 | |
| commit message | 提交信息 | 提交说明 | 包括“提交信息历史” |
| Copy Commit ID / SHA / Hash | 复制提交哈希 | 复制提交 ID | 搜索帮助里的 SHA 也写“哈希” |
| the Uncommitted side of the Log | “未提交”标签页 | 未提交视图、未提交侧栏 | 日志顶部 Commits / Uncommitted 切换的那一页 |
| Release… | 发版… | 发布… | release notes 写“发版说明” |
| Publish (a branch) | 推送到远程 | 发布 | unpublished：未推送到远程 |
| Topological order | 按分支结构 | 拓扑方式 | |
| Forget (a worktree whose folder is gone) | 清除记录 | 忘掉 | |
| Apply with Merge (a patch) | 用三方合并应用 | 合并应用 | |
| Patch series (git am in progress) | 补丁序列 | 补丁应用 | |
| “Log” inside a Chinese sentence | 日志 | Log | 产品名 Linyra 不译 |
| working-tree changes | 工作区更改 | 工作树更改 | **工作树** 只指 git worktree |
| Discard Changes | 放弃更改 | 回滚 | “回滚”读起来像撤销提交 |
| Untick (Repo List) | 取消勾选 | 从日志中隐藏 | |
| Always Hide (Settings) | 永久排除（写入设置） | 从 Linyra 中排除 | 写入 `linyra.excludeRepos` |
| Update Project | 更新项目 | | 方式：合并 / 变基 / 仅快进 |
| Require Every Word (search) | 每个词都要出现 | 匹配全部词语 | git 的 `--all-match` |

## 写法

- 先说会发生什么，再说怎么做：“{0}将离开 main（其中 2 个已推送到 origin/main）”，不写“请注意……”。
- 按钮写动作本身：合并、变基、仍然删除，不写“继续”“确定”。
- 失败提示：动作 + 仓库 + 原因 + 下一步，例如“无法在 acme-web 中推送 feature/x：远程有你本地没有的提交：先运行“更新项目”，再推送。”
- 数量和单位之间加空格：“3 个仓库”“4 个提交”。
