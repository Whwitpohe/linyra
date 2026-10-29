# Log 体验、搜索与 AI：实施计划（2026-10-29）

这份计划汇总了 2026-10-29 设计评审定下的全部改动：视觉打磨、工作树更改、分支胶囊、悬停卡片、作者首字母与头像、文件历史、GitLens 式搜索语法、AI 配置与 AI 功能。它也是并行开发的分工表，每个工作流（A–H）的负责人只改自己名下的文件，接口按第 1 节的约定。

**先读：** 仓库根目录的 `CLAUDE.md`（五条硬约束、惯例），`PRODUCT.md`（视觉与语气），本文件。硬约束摘要：

1. **不做索引、缓存、数据库。** 过滤一律下推成 `git log` 参数，JS 只合并已经过滤好的流。算的是 git **进程数**：VS Code 的 Git 已经知道的不再问 git，一个步骤改不了的东西不再重读。只放内存、只活一个会话的小查找表（比如头像）允许。
2. **颜色和字体只来自 `--vscode-*` 变量。** 不写死十六进制，不打包字体，暗色、浅色、高对比都要对。`npm run check:theme` 会检查。
3. **中性示例数据。** 只用 `acme-web`、`acme-api`、`acme-libs`、`origin/release-1.4`，作者 `dana` / `rin`。截图、测试、文档里不得出现任何真实的公司、仓库、服务、分支、工单名。
4. **不阻塞扩展宿主。** 一切异步，输入防抖 250ms，筛选变化时杀掉进行中的进程。
5. **不发版。** 不改 `package.json` 版本号，不动 `CHANGELOG.md`，不 tag，不 publish。

所有面向用户的文案都要走 `localize()`，并在 `l10n/bundle.l10n.zh-cn.json` 里补中文（`src/i18n.test.ts` 会检查每个静态 key）；设置和命令标题写进 `package.nls.json` 与 `package.nls.zh-cn.json`。语气按 PRODUCT.md：短、平实、说清原因和办法，不用感叹号。

---

## 1. 架构与公共模块（已在基础提交里）

| 模块 | 作用 | 使用方 |
|---|---|---|
| `src/initials.ts` | `initials(name)`：英文取首尾两个词的首字母，CJK 取最后一个字 | A、C、H |
| `src/changeKinds.ts` | `kindCounts(files)` 按路径去重，统计新增 / 修改 / 删除 / 重命名的文件数；另有 `sumKinds`、`lineTotals`、`totalFiles` | B、C、D |
| `src/webview/ui/counts.ts` (+css) | `renderCounts(kinds)` 画出 `+3 ✎2 −1 →1`；`renderLines(a, d)` 画出 `+12 −3`；`countsLabel()` 生成无障碍名称 | B、C、D |
| `src/webview/ui/pill.ts` (+css) | `renderPill(segments, context)` 画分段式分支胶囊，`PillSegment` 包含 local / remote / tag / base / detached、current、ahead / behind、unpublished；颜色取 VS Code 的 `scmGraph.*` 主题色，旧版 VS Code 有回退 | B、C |
| `src/webview/ui/authorDisc.ts` (+css) | 作者圆盘：`authorDiscSvg`（画在图里）、`authorDiscHtml`（悬停卡片用）；头像注册表：`setAvatars`、`avatarFor`、`onAvatars` | A、C、H |
| `src/ai/types.ts`、`src/ai/index.ts` | AI 契约：`AiProfile`、`AiProvider`、`AiRequest/Response/Turn/Tool`、`AiService`、`AiError`；`registerAi()` / `aiService()` | F 实现，G 使用 |
| `dev/harness` | `HARNESS_PORT` 环境变量：每个 worktree 跑自己的 harness 和 `npm run test:ui` | 所有人 |
| `scripts/gen-codicons.mjs` | 新增图标：edit、cloud、cloud-upload、arrow-up/down/right、sparkle、whole-word、check-all、diff-*、target、search、calendar、key、settings-gear、lightbulb、wand、loading、comment-discussion | 所有人（`codiconElement(name)`） |

**设计原则（每个工作流都要遵守）：**

- **纯模块承载逻辑**，不引用 `vscode`、不碰 DOM，测试写在这里（`*.test.ts`，plain `assert` + `console.log("ok - …")`，`scripts/run-unit.mjs` 会自动发现）。碰 VS Code 或 DOM 的模块保持很薄。
- **新功能各自放进新文件**（宿主侧 `src/<feature>.ts`，webview 侧 `src/webview/<feature>.ts`，样式由该模块自己 `import "./x.css"`）。`logView.ts`、`main.ts`、`list.ts`、`protocol.ts` 这类共享热点文件只加几行接线代码，便于合并。
- **package.json、nls、l10n 的新条目追加在对应数组或对象的末尾**，hunk 保持小。
- **harness 的模拟数据**放进 `dev/harness/mock/<feature>.ts`，`shim.ts` 只加一行接线。
- **性能**：
  - 虚拟列表中的一行只在它画的内容变了时才重建，每行图形节点数保持在个位数。
  - 新开 git 进程前先问"这个答案是不是已经有了"；只对屏幕上的行按需请求；指针移开、筛选变化时 abort。
  - 改动视觉或滚动相关代码后，跑 `node dev/perf/scrollBench.mjs` 做对比。
- **无障碍**：图标按钮要有 aria-label；新出现的弹层可以用 Esc 关掉，不抢焦点；高对比主题用描边代替填充。

---

## 2. 分工

| 工作流 | 内容 | 分支 / worktree | harness 端口 |
|---|---|---|---|
| A | 视觉打磨 + 图节点（首字母圆盘） | `feat/log-ux-polish` · `.claude/worktrees/polish` | 5181 |
| B | 工作树更改（图一融入图二、图三） | `feat/log-ux-worktree` · `.claude/worktrees/worktree` | 5182 |
| C | 分支胶囊 + 提交悬停卡片 | `feat/log-ux-refs` · `.claude/worktrees/refs` | 5183 |
| D | 文件历史 | `feat/log-ux-history` · `.claude/worktrees/history` | 5184 |
| E | GitLens 式搜索语法 | `feat/log-ux-search` · `.claude/worktrees/search` | 5185 |
| F | AI 核心：协议、配置、模型、思考程度 | `feat/log-ux-ai-core` · `.claude/worktrees/ai-core` | 5186 |
| G | AI 功能 | `feat/log-ux-ai-features` · `.claude/worktrees/ai-features` | 5187 |
| H | 头像（默认只向远程主机请求） | `feat/log-ux-avatars` · `.claude/worktrees/avatars` | 5188 |

**文件归属**（"主"表示主要由该工作流改动；共享热点文件各自只加接线代码）：

- A 主：`src/webview/graph.ts`、`src/webview/styles.css` 中 repo-band / row / graph / 窄屏 / header-actions 这几段、`src/webview/changes/*`
- B 主：`src/workingTree.ts`、`src/uncommittedStore.ts`、`src/uncommittedModel.ts`、`src/webview/workList.ts`（以及新的 `workList.css`，并把 `styles.css` 里 work-row 那一段搬过去）、`src/commitModel.ts`、`src/commitPanel.ts`
- C 主：`src/commitReferences.ts`、`src/webview/list.ts` 的 refs 单元格、新的 `src/webview/hoverCard.ts`、`src/hoverModel.ts`（纯）、`src/hoverDetail.ts`（宿主）
- D 主：`src/webview/empty.ts`、`src/webview/html.ts` 的 modebar、`src/gitLog.ts` 的历史解析、`src/filterModel.ts` 的 `historyArgs`、新的 `src/webview/history.ts`、`history.css`
- E 主：新的 `src/searchQuery.ts`（纯）、`src/filterModel.ts` 的 `logArgs`、`src/logQuery.ts`、`src/webview/filters.ts`、`src/webview/suggest*.ts`、新的 `src/webview/searchBox.ts`、`search.css`
- F 主：`src/ai/**`（types.ts 的修改要在报告里说明）、`package.json` 的 `linyra.ai.*` 设置
- G 主：`src/ai/features/**`、`src/webview/commit/*`（AI 生成提交信息按钮）
- H 主：新的 `src/avatarModel.ts`（纯）、`src/avatars.ts`（宿主）、`src/webview/html.ts` 的 CSP、`linyra.avatars*` 设置

**git 规则（每个子代理）：**
- 只在自己的 worktree 里工作，先确认 `git branch --show-current`。
- 只用 `git add <files>` 和 `git commit`；不 checkout、switch、reset、rebase、stash、merge、push，不新建分支。
- 提交身份用仓库本地配置（Whwitpohe），提交信息末尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 每完成一个可验证的步骤就提交一次。

**验收（每个工作流交付前都要跑）：**
- `npm run lint`、`npm run typecheck`、`npm run test:unit`、`npm run check:theme`、`npm run check:denylist`（没有 `.denylist` 时允许跳过）
- `HARNESS_PORT=<端口> npm run test:ui`：已有规格全绿，新功能加 Playwright 规格（`dev/harness/tests/*.spec.mjs`）
- 暗色、浅色、高对比暗、高对比浅四种主题和中英文下的 harness 截图，存到 `.playwright-mcp/review/<工作流>/`
- 报告：做了什么、改了哪些文件、和别的工作流的接口、没完成或没验证的部分、截图路径

---

## 3. 各工作流规格

### A. 视觉打磨 + 图节点

1. **仓库列**：每行的着色色块改成 3px 连续色条加仓库名（正文色）。同一仓库的连续行共用一条色条，换仓库时上下各留 3px 间隙。高对比主题下，色条和名字都不再加描边框。`.repo-band`、`.chip` 在 Log 行里的用法都要改。窄屏下只留色条。
2. **图节点**：
   - 普通提交画作者首字母圆盘（`authorDiscSvg`）：环是仓库色，粗环表示我的提交（`props.me` 里该仓库的邮箱）。
   - 合并提交保持现在的小空心点。
   - 可折叠段的 ⊟ 只在悬停该节点时出现，取代圆盘；已折叠的 ⊞ 一直显示。
   - 第一条泳道的起点从 x=6 挪到 9，避免圆盘被切掉；泳道间距按 16px 的圆盘重新核算。
   - 每行的 SVG 节点数保持在个位数（路径仍然按颜色合并）。
3. **提交详情**（`changes/*`）：
   - 标题用 UI 字体、半粗、正文色；正文保留等宽字体。
   - 元信息用次要色，日期和邮箱不断行；仓库色块统一成 8px。
   - 引用改用 `renderPill`；"在 N 个分支中"的列表用 UI 字体。
   - 分区标题改成 VS Code 面板标题样式（11px、大写、粗体、codicon chevron），去掉 `▾` 字符和拖拽小横杠，去掉重复的边线。
   - 父提交 hash 可以点击，点击后在 Log 里选中它（没加载到的话给出提示）。
4. **窄面板 bug**：`@media (max-width: 720px)` 改成 `@container (max-width: 720px)`（`.log` 已经是容器）。窄的时候隐藏引用，为标题留出空间。
5. **按下态**：工具栏切换按钮改用 `--vscode-actionBar-toggledBackground`（回退 `inputOption-activeBackground`），不加描边；高对比主题保留描边。Log 和 Changes 两处都改。
6. **文件列表增删分色**：Changes 文件行的 `+N` 和 `−N` 分别用 add 色和 delete 色，可以改用 `renderLines`。

验收：截图对比第一轮评审的问题都已消失；滚动基准（`scrollBench`）不比基础提交差。

### B. 工作树更改（GitLens WIP 行的样式融入 Uncommitted 行和 Commit 侧栏）

**数据：零额外进程。**
- 新增 `workingTree.ts` 的 `branchOf(stdout)`，解析现成的 `git status --porcelain=v2 --branch` 输出中的 `# branch.head`、`# branch.upstream`、`# branch.ab`。
- `RepoWork` 加可选字段 `branch?: { name: string | null; upstream: string | null; ahead: number; behind: number }`（`name` 为 null 表示 detached）。
- 另一个会话的 1.7.0 版仓库列表会复用这个解析器，所以它是**唯一的**分支解析函数，接口要稳定。
- 对 VS Code Git 认为干净、因而没跑 git 的仓库，这些仓库本来就不出现在 Uncommitted 行里，不用补数据。

**Uncommitted 行（图二）：**
- 一行依次是：仓库 chip、计数（`renderCounts`，`+143 ✎3 −1`）、文件名预览（去掉"N 个文件 ·"前缀，数量已经由计数给出）、"已暂存"标签、分支胶囊（`renderPill`，`⎇ develop ↑1 ↓2`；同步时显示 ☁；没有上游时写"未发布"）、编辑时间。
- **保留进度条**（维护者要求），放在计数下方或旁边，按当前视觉调好。
- 删掉"N 个新增"标签（和计数重复）。
- 头部总计（`work-totals`）换成跨仓库汇总的计数；行数统计放进 tooltip。
- 协议：`WorkRow` 加 `counts: KindCounts`、`branch`；`tags` 只保留已暂存那一个；`meter` 字段可以继续沿用，或改成从 `counts` 推出。

**Commit 侧栏（图三，原生 TreeView）：**
- "更改"列表节点用 `ThemeIcon("diff-modified", gitDecoration.modifiedResourceForeground)`，"未受版本控制的文件"列表节点用 `ThemeIcon("diff-added", gitDecoration.untrackedResourceForeground)`。
- 仓库节点的说明文字改成 `develop ↑1 · 3 个文件`。
- 仓库节点和列表节点的 tooltip 改成 `MarkdownString`（`supportThemeIcons`），内容是 `$(git-branch) develop · $(cloud) origin/develop · ↑1`，再加一行 `$(edit) 3  $(diff-added) 143`。

验收：`workingTree.test.ts` 覆盖 branchOf 的各种情况（detached、无上游、只有 ahead、初始提交前）；`uncommittedModel` 和 `commitModel` 的测试更新；Playwright 规格覆盖 Uncommitted 行。

### C. 分支胶囊 + 提交悬停卡片

**分支胶囊：**
- `commitReferences.ts`：新增 `refGroups(refs, headBranch?)`，返回结构化的 `PillSegment[][]`。把本地分支和同名、指向同一提交的远程分支并成一个胶囊（`develop | origin`），标签单独成胶囊，HEAD 只有 detached 时才单独显示。`referenceLabels` 由它取代，老调用点一并迁移。
- Log 行的 refs 单元格改用 `renderPill`。当前分支加粗，并带上游状态，数据来自 webview 已有的 `sync` 消息（`byRepo` 的 ahead/behind）。窄的时候显示 `+N` 溢出。
- 胶囊左键：在仓库列表里定位到这个分支，复用已有消息；没有的话只加一条 `revealBranch` 消息，不改 `repoPane.ts` 的结构。
- 胶囊右键：`data-vscode-context` 设 `webviewSection: "refPill"`，带 `repoId`、`ref`、`kind`（local / remote / tag）、`current`。package.json 的 webview/context 加上仓库列表里已有的分支命令（检出、合并到当前、变基、推送、拉取、与当前比较、复制名称），命令要接受这个参数形状。
- **合并目标**：只对 HEAD 那一行按需计算，在悬停卡片里显示"合并目标 origin/main · 领先 N 个提交"，旁边给一个"比较"按钮，打开 Compare Branches 并预填两侧。远程默认分支用 `git symbolic-ref --short refs/remotes/<upstream remote>/HEAD`，计数用 `rev-list --left-right --count`；两个进程，结果只放内存，HEAD 移动后作废。

**悬停卡片**（新的 `src/webview/hoverCard.ts`）：
- 视觉：`--vscode-editorHoverWidget-*` 主题色，加阴影。
- 时机：指针停在行上（主题、节点、作者）500ms 后出现，移开、滚动、按键、失焦时消失。指针可以移进卡片里（复制、点链接），不抢焦点。
- 内容先用行里已有的数据**立即**画出：`authorDiscHtml`、作者（自己的提交显示"你"）、相对时间加括号里的绝对时间、可点击复制的 hash、仓库名和色条、分支胶囊。
- 然后用**一次** `git show`（复用 `commitDetail.ts` 的 `showArgs` / `parseShow`）补上：完整正文、`renderCounts` 和"N 个文件已更改"、`renderLines`。
- 指针移开就 abort（杀进程）；不做跨悬停的缓存（约束 1）。
- 卡片底部的操作链接：复制 hash、在远程打开、比较（HEAD 行）。为 G 预留一个"解释"链接，执行命令 `linyra.ai.explainCommit`（命令不存在时隐藏）。
- 去掉行内原来的 `title` 提示，避免出现两个提示。
- 纯函数放进 `src/hoverModel.ts`（格式化、时间、"你"的判断）并配测试。

验收：Playwright 规格覆盖悬停出现、移开取消、内容；harness 里补上悬停详情的模拟回复（`dev/harness/mock/hover.ts`）。

### D. 文件历史

1. **入口**：
   - Commit 侧栏中**所有**文件都显示"文件历史"（`viewItem =~ /^commitFile\./`）。
   - Changes 树、Commit 侧栏的文件夹上加"文件夹历史"：新命令 `linyra.folderHistory`，复用 Log 的路径筛选（Path 输入框），不另开模式。
   - 从来没提交过的文件给出专门的空状态："还没有提交过。提交后这里会出现它的历史。"如果这个路径以前存在过（删除后又新建），照常显示历史。
2. **头部**：
   - 去掉单独那一行 modebar，把它并进 log-header，放在 Commits/Uncommitted 开关的位置，做成胶囊 `[⟲ src/client.ts · acme-web ×]`（× 退出）。
   - 文件历史里隐藏 Uncommitted 开关和"按仓库分组"。
3. **仓库窗格**：去掉 50% 半透明，保持 `inert`，高亮当前文件所在的仓库。
4. **仓库列**：只剩一个仓库，所以只留色条。
5. **每行显示这个文件在该提交里的变化**：
   - 状态字母 A/M/D/R（带颜色）和这个文件的 `+N −N`；重命名时次要色显示 `← 旧路径`。
   - 需要在 `historyArgs` 里加 `--numstat`（或改成 `--numstat` 加 `--summary`）。先按约束 1 测量，在报告里给出数字。
6. **顶部"未提交的更改"行**：
   - 如果这个文件有未提交改动，在列表最上面加一行虚线节点（数据来自 `uncommittedStore`，零额外进程）。
   - 点击打开 HEAD 和工作树的差异。
7. **多选两行** → 打开这个文件在这两个版本之间的差异，取代 Combined Changes。
8. 行的右键菜单加"在此版本查看 Blame"，复用现有 blame。

验收：
- `gitLog.test.ts`、`filterModel.test.ts` 覆盖新的解析和参数。
- harness 的模拟数据真正按文件筛选（`dev/harness/mock/history.ts`）。
- Playwright 规格覆盖头部胶囊、状态列、未提交行。
- `src/integration/log.itest.ts` 加一个用例。

### E. GitLens 式搜索语法

规则照 GitLens 19.5 的源码，对齐它的操作符表：

| 操作符（别名） | git 参数 | 说明 |
|---|---|---|
| 裸词、`message:`（`=:`） | `--grep`（多个值是"或"；打开"全部匹配"时加 `--all-match`） | 看起来像 7–40 位十六进制的裸词视为 `commit:` |
| `-message:` | `--grep` + `--invert-grep` | 不能和 `message:` 同时使用，否则报错 |
| `author:`（`@:`） | `--author` | `@me` 换成"我"的身份；开头的 `@` 去掉 |
| `committer:` | `--committer` | 支持 `@me` |
| `commit:`（`#:`） | 现有的 hash 查找 | |
| `file:`（`?:`） | pathspec | 带引号表示精确路径；含 `**` 用 `:(glob)`；含通配符原样传；其余用 `*x*`；没开"区分大小写"时加 `:(icase)` |
| `change:`（`~:`） | `-S`（开正则时用 `-G`） | 代价高，须和日期一起下推；在报告里测量 |
| `type:`（`is:`） | `merge` → `--merges`；`tip` → `--simplify-by-decoration`；`wip` → 切到 Uncommitted 侧；`stash` 不做 | |
| `after:`（`since:`、`>:`） / `before:`（`until:`、`<:`） | `--since` / `--until` | 接受 `2026-10-01`、`1.week.ago`、`yesterday` |
| `ref:`（`^:`） | 用该引用或区间 `a..b` 取代 `--all` | 只对拥有该引用的仓库生效，其余仓库跳过（multi-repo 语义） |
| **Linyra 新增** `repo:` | 仓库子集 | 和仓库窗格的勾选取交集 |

- 开关：区分大小写（Aa）、**全词匹配**（ab，新增，作用于正则时套 `\b…\b`）、正则（.*）、**全部匹配**（✓✓，新增）。和 GitLens 一样：用到 `--grep`、`--author`、`--committer` 时，按开关加 `--extended-regexp` 或 `--fixed-strings`，以及 `--regexp-ignore-case`。
- 解析器 `src/searchQuery.ts` 是纯模块：
  - 输入框文本 → `{ operations, errors, ranges }`。
  - 再加开关 → git 参数、pathspec 和 Linyra 筛选（`repoIds`、`hash`、`mode`）。
  - 测试覆盖每个操作符、引号、别名、`@me`、错误。
- **自动补全弹层**（复用 `suggest.ts` 的样式和键盘交互）：
  - 焦点在输入框且为空时，或正在输入操作符时，列出操作符、说明和别名（像截图那样）。
  - 输入值时补全：`author:` 补作者，`ref:` 补分支和标签，`repo:` 补仓库名，`type:` 补可选值。
- **搜索历史**：光标在末尾、补全列表没打开时，↑↓ 翻看最近 50 条（webview state，按工作区）。
- 输入时照旧 250ms 防抖实时筛选，Enter 立即执行。操作符还没写值时不发查询。错误显示在输入框下方，`aria-invalid`。
- 和现有筛选控件（作者选择器、分支选择器、路径、日期、仓库勾选）的关系是"与"：两者都生效。
- **✨ 自然语言开关**：打开后，输入框中的文字发给宿主（`{ type: "aiSearch", text }`）。宿主执行命令 `linyra.ai.translateSearch`（由 G 注册），得到操作符查询后替换进输入框并执行。命令不存在或 AI 未配置时，开关显示为不可用，并提示去配置。
- harness 的 `matching()` 改用 `searchQuery.ts` 来解析模拟数据（`dev/harness/mock/search.ts`）。

验收：单测覆盖；Playwright 规格覆盖补全弹层、操作符、历史；`log.itest.ts` 加一个真实 git 用例（`author:`、`file:`、`ref:`）。

### F. AI 核心

- **协议适配器** `src/ai/providers/`：
  - **OpenAI 兼容**（`openai.ts`）：`GET {base}/models`、`POST {base}/chat/completions`，SSE 流式，tools 用 function calling，`reasoning_effort`（只在选了级别时发送），JSON 模式用 `response_format: { type: "json_object" }`。不发 temperature。
  - **Anthropic**（`anthropic.ts`）：按 claude-api 技能的要求，**使用官方 SDK `@anthropic-ai/sdk`**（新增依赖，esbuild 打进扩展），不手写 HTTP。
    - `client.models.list()` 列模型，`client.messages.stream()` 流式。
    - 思考：`thinking: { type: "adaptive" }`（当前模型）；深度用 `output_config: { effort }`（low/medium/high/xhigh/max，"default" 时不发）。不发 `budget_tokens`，不发 temperature/top_p/top_k（2026-10-21 起会返回 400）。
    - 工具循环里把 assistant 的 content 原样回传（`raw`）。
    - 处理 `stop_reason: "refusal"`。
    - 对第一方 API（api.anthropic.com）上的 claude-fable-5-1、claude-opus-5-5、claude-opus-5、claude-sonnet-5-5 默认开启 `fallbacks: "default"`（beta `server-side-fallback-2026-07-01`），其他 baseUrl 不开；在设置说明里写明。
    - 默认模型 `claude-opus-5-5`。
    - 具体字段以技能文档为准：Agent 先调用 Skill `claude-api` 读 TypeScript 部分。
  - **Gemini**（`gemini.ts`）：`GET {base}/models`（`x-goog-api-key`），`:streamGenerateContent?alt=sse`；思考用 `generationConfig.thinkingConfig`（`thinkingLevel` 或 `thinkingBudget`，按模型而定，实现前查官方文档确认）；工具用 `functionDeclarations`；回传 thought signature（`raw`）。
- **配置入口**：命令 `Linyra: Configure AI…`（QuickPick 多步）：
  1. 选择协议
  2. 填 Base URL（按协议预填默认值）
  3. 填 API Key（密码输入，存进 `SecretStorage`；本地服务可以留空）
  4. 拉取模型（显示进度，失败时说清原因）
  5. 选择模型（可搜索）
  6. 选择思考程度（只列该模型支持的级别，未知时全列，外加"默认"）
  7. 测试连接
- 可以保存多个配置（设置 `linyra.ai.profiles`，**不含密钥**），用 `linyra.ai.activeProfile` 选择当前配置。
- 另有命令：`Linyra: Switch AI Model…`（快速切换配置、模型、思考程度）、`Linyra: Remove AI Profile…`。Log 的"更多"菜单里加上这几项。
- **服务** `src/ai/service.ts` 实现 `AiService`：
  - `linyra.ai.enabled`（默认 false；首次使用 AI 功能时引导去配置）。
  - `linyra.ai.exclude`：glob 列表，默认排除锁文件、`*.min.*`、`dist/`、`out/`、`build/`、`node_modules/`、`.env*`、`*.pem`、`*.key`。
  - `linyra.ai.maxPromptTokens`：提示词超过阈值时先确认（粗估：字符数 / 4）。
  - `present()`：`linyra-ai:` 虚拟文档，配合 `markdown.showPreview` 流式更新，进度通知可以取消。
  - 错误统一映射成 `AiError`（401 → 密钥无效，429 → 限流，网络 / 代理 / 证书错误要说清原因）。
- **网络**：走 VS Code 打过补丁的 fetch 或 https，以便支持代理和系统证书；超时可取消；不阻塞宿主。
- **测试**：每个适配器都要测请求体映射、SSE 解析、工具调用往返、错误映射（用 mock fetch），以及 `service` 的配置流程纯逻辑（`src/ai/profileModel.ts`）。

### G. AI 功能（`src/ai/features/*`，只通过 `aiService()` 调用 AI）

每个功能都是一个命令，挂在对应的菜单或按钮上，输出用 `present()` 或写回原位置。**任何写入仓库的动作，执行前都要模态确认，并列出具体会做什么。**

1. **AI 搜索**：`linyra.ai.translateSearch(text) → string`。用 JSON 输出把自然语言翻译成 E 节的操作符查询；仓库名、作者、分支作为上下文给模型（只给名字，不给内容）。
2. **解释提交**：`linyra.ai.explainCommit`。支持单个和多选（多选时合成一个 Combined 视图）。挂在 Log 行右键（webviewSection `commit`）、Changes 标题栏、悬停卡片的链接。输入是 diff（遵守 exclude 和大小阈值）加提交信息。
3. **解释工作区更改**：`linyra.ai.explainWip`。挂在 Uncommitted 行右键（`uncommitted`）、Commit 侧栏标题栏。可以跨多个勾选的仓库。
4. **解释未推送的提交**：挂在仓库右键、HEAD 胶囊右键。
5. **解释分支或比较**：挂在 `refPill` 右键（"与当前分支相比做了什么"）。
6. **生成提交信息**：Commit 侧栏消息框旁加 ✨ 按钮（`src/webview/commit/*`），根据勾选的文件跨仓库生成一条信息，流式填进输入框，用户可以撤销。`linyra.ai.commitMessageInstructions` 设置自定义要求。
7. **生成暂存信息**：Stash Changes… 流程里提供"AI 生成"。
8. **生成变更日志或发布说明**：在 Log 多选提交后、从 Compare 的"复制为发布说明"旁边触发（只加菜单项和宿主命令，不改 compare webview）。按 feat/fix/其他分组，可以复制或插入。
9. **审查更改**：`linyra.ai.review`，作用于工作区、提交或分支差异，输出按严重程度排序的问题列表，每条带文件和行号链接。
10. **AI 解决冲突（合并）**：
    - 仓库处于 merge、rebase 或 cherry-pick 冲突状态时，命令 `linyra.ai.resolveConflicts`：对每个冲突文件读 base/ours/theirs（`git show :1:/:2:/:3:`），让模型给出合并结果。
    - 用 diff 编辑器展示"建议内容 ↔ 当前冲突文件"，用户逐个接受（写文件，再 `git add`）或交给 VS Code 合并编辑器。不自动 continue。
    - Compare 的"预测冲突"旁边加"解释冲突"（只读）。
11. **Ask AI（程序能做的一切）**：命令 `Linyra: Ask AI…`，外加 Log 头部的 ✨ 按钮。
    - 自然语言请求 → 工具调用。工具表 `src/ai/features/tools.ts` 覆盖 Linyra 的操作：筛选 Log、搜索、选中提交、获取 / 拉取 / 推送、跨仓库检出、新建或合并分支、比较分支、暂存、打开文件历史、解释、生成提交信息等。
    - 只读工具直接执行；写入工具汇总成一个确认框，列出"在哪些仓库做什么"，确认后才执行，并且**走现有命令**（不另写 git 逻辑）。
    - 每轮最多 8 次工具调用；可以取消。
- **测试**：每个功能的提示词组装、输出解析、工具表 schema、确认清单生成都是纯函数，用假 `AiService` 测。

### H. 头像（默认只向远程主机请求）

- **纯模块** `src/avatarModel.ts`：
  - 解析 GitHub noreply 邮箱（`<id>+<login>@users.noreply.github.com`、`<login>@users.noreply.github.com`）→ `https://avatars.githubusercontent.com/u/<id>?s=<size>`。
  - GitLab 的 `GET {host}/api/v4/avatar?email=<e>&size=<n>` → JSON `avatar_url`。返回的地址如果指向用户没打开的外部服务（gravatar、libravatar），或者是默认占位图，直接丢弃。
  - Gravatar：`sha256(email)`、`d=404`。
  - 自定义地址模板：`{md5}` `{sha256}` `{email}` `{size}`。
  - 根据仓库的 remote 主机判断某个邮箱能问哪些来源（复用 `remoteUrl.ts` 的解析）。
- **宿主侧** `src/avatars.ts`：
  - 用 VS Code 打过补丁的 https 请求，下载图片后转成 `data:` URI。
  - 只为屏幕上可见的行请求，并发 4，超时 3s；结果只放内存。
  - 某个主机返回 401/403 或跳到登录页时熔断，本次会话不再请求它。
  - 批量发给 webview：`{ type: "avatars", byEmail }` → `setAvatars()`；`onAvatars` 触发可见行重绘。
- **设置**：
  - `linyra.avatars`：`off` / `remote` / `remote+gravatar`，默认 `remote`。
  - `linyra.avatars.hosts`：`{ "<host>": "gitlab" | "github" }`，告诉 Linyra 自建实例是什么类型。
  - `linyra.avatars.urlTemplate`。
- **CSP**：Log 的 `img-src` 加 `data:`。
- **测试**：avatarModel 覆盖各种邮箱、主机、模板、丢弃规则；熔断逻辑也要测（纯状态机）。

---

## 4. 菜单上下文键约定（`data-vscode-context` / `viewItem`）

| 位置 | webviewSection / viewItem | 字段 |
|---|---|---|
| Log 提交行 | `commit`（已有）/ `historyCommit`（已有） | repoId、sha、head、behind |
| Uncommitted 行 | `uncommitted`（已有） | repoId、canStage、hasStaged、hasChanges |
| 分支胶囊 | `refPill`（新，C） | repoId、ref、kind、current |
| Changes 文件行 | `changesRow`（已有） | viewItem |
| Commit 侧栏 | `commitList*`、`commitRepo*`、`commitFolder*`、`commitFile.*`（已有） | |

## 5. 不做的事

- GitLens 的创建 PR、Launchpad、关联问题、MCP、AI 积分：属于托管平台集成，是非目标。
- 重组提交、自动 rebase：交互式 rebase 是非目标。
- 自己的合并或冲突编辑器：冲突由 VS Code 的合并编辑器处理；AI 只给建议，由用户确认。
- `type:stash` 搜索：Log 不显示 stash。
- 后台索引，或任何跨会话的持久缓存。

## 6. 集成顺序

1. 基础提交（本文件和第 1 节的模块）→ 各工作流从这里分出。
2. A、B、C、D、E、F、G、H 并行开发。
3. 合并到 `feat/log-ux-integration`，顺序是 A → B → C → D → E → F → H → G。package.json 和 l10n 用 JSON 感知的方式合并。每合一个分支跑一次全量验收。
4. 第二轮接线：G 的功能挂到 A/C/E 的界面上（详情面板的"解释"、悬停卡片链接、✨ 搜索），然后更新 UI Map（`dev/ui-map/index.html`），给新部件命名。
5. 全量验收：lint、typecheck、unit、itest、test:ui、四种主题截图、滚动和启动基准。然后交给维护者审阅，并通知另一个会话（1.7.0）可以在此基础上继续。
