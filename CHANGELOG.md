# 变更记录

本文件记录**对外发布**的版本。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> **`0.1.0` 从未公开发布。** 它只是本仓库早期在 `dsh-project-manager` 这个名字下的内部版本号，
> npm 上没有它的任何发布记录。因此本文件从 **`0.2.0`（首个公开版本）** 起记录。

## [0.3.0] — 进度自动回写与自动发现

> 与 0.2.1 不同，这一版**确实带去了新功能**：0.2.1 与 0.2.0 的代码产物逐字节相同
> （只为修链接字段而发），此后落地的两批功能从未进入任何 npm 版本。

### 新增

- **进度自动回写（宿主批次 69）**：回合收尾时按**证据**催模型汇报进度，把"进度回写"
  从**靠模型自觉**变成机制保证。做法：
  - 新增 `src/session/report-candidate.ts`（纯函数）：按「本回合变动过的文件」×
    「节点自己声明的 `refs`」挑出**有证据**该被重新评估的候选节点，渲染成可执行的提醒；
  - `BoundNode` 增补 `refs`（边界层原先不知道节点负责哪些路径，无从判断）；
  - 新增 `tools/pre-execute` 证据采集钩子：记「写工具碰过哪些文件」与「本回合调过
    `pm_report`/`pm_finish` 没有」。**不查 git** —— git 分不出"哪次会话碰的"，
    而写工具必须过这道门，天然带会话归属；
  - 催促有上限：连续 3 次不回写就收手，避免提醒退化成白噪音。
  - 起因（实测）：树上 32 个叶节点**全部卡在 0.50–0.70、完成数为 0**，整体比例长期
    冻在 0.649。根因不是"没机制"—— `session/boundary.ts` 早在回合收尾时动树，但它只做
    `pending → running`，**从不知道这一回合有没有回写过**，所以永远推不到收尾。
- **自动发现：树上缺节点的「盲区」提醒（宿主批次 70）**：本回合改动的文件若
  **不属于任何节点的 `refs`**，回合收尾时提醒建节点（`pm_add` 并把 `refs` 指向这些路径，
  下次才不再是盲区）。判据全是事实（文件确实变了 + 树里读得到），不含推测、不产生数字。
  - 同时修掉批次 69 的一处前提错误：候选池原先取"该会话**订阅过**的节点"，
    而实际干活的人**从不订阅** ⇒ 提醒永不触发（AIG 那棵树因此冻了 8 小时）。
    改为取**整个项目**的节点。
- **`/pm/settings` 的 boundary 统计新增 `reportNudges` / `blindSpotNudges` /
  `lastNudgeActorId` / `nudgeArmed`**：两类提醒分开计数，"机制到底活着没有"看得见。
- **属性栏解释"黄底感叹号"**（`node-inspector.tsx`）：说明它表示"已完成但有遗留待处理"、
  **不等于异常**（红色 ✕），并说明办完更新简报后颜色会恢复；与画布 tooltip 口径一致。

### 修复

- **钉住扫描排除表的 glob 语义（**更正**：这一条原先写的是"补上 Python 生态"，那是错的）**：
  节点 `refs` 曾指向 `.venv/Lib/site-packages/aiohttp`、`.mypy_cache`、`__pycache__` 这类
  第三方依赖与缓存 —— 原排除表只排 JS 生态（`node_modules`/`dist`/`.next`…），Python 生态
  一个都没排。**但这一版实际只落了测试，排除项本身并没有补**（提交 `0fd8e63` 只改了
  `tests/domain/scanner.test.ts`）：实测钉住了两条 glob 语义 —— 一条 `**/x` **同时覆盖根层
  与任意嵌套层**，所以补排除项写这一种就够；且**不跨目录名**（`a/xnode_modules` 不算
  `a/*/node_modules`）。**后果在 2026-10-11 的 AIG 重建树上复现了**：`.venv`（该工作区有
  67233 个文件）与 `.mypy_cache` 仍然成了节点的 `refs`。补排除项与"AI 提议的 refs 也要过
  一遍排除表"见后续版本。

### 说明

- **底线不变：宿主绝不产生进度数字。** 自动化只作用在"逼模型汇报"这一环；`session/prompt.ts`
  已定前提 —— 宿主只能做有证据的推断（`pending → running`），真实数字只有干活的模型知道。
- **无破坏性变更**：工具数仍为 **32**，路由仍为 19 条，未删改任何设置项。
- **`HOST_BATCH` 70 → 71**：版本号由构建内联进宿主产物（`__PM_VERSION__`），
  故发布产物与批次 70 的开发产物不是同一份字节；与 0.2.1 时同理，靠这个数自证
  "诊断页说的到底是哪一份代码"。
- 基准宿主仍为 `@deepseek-ai/dsh` **0.1.5-rc.2**（本版本只在该版本上实测过）。
- 测试 **476 通过 / 0 失败**。

## [0.2.1] — 仓库改名后的元数据修正

### 修复

- **`repository` / `homepage` / `bugs` 指向已改名的仓库**：GitHub 仓库已改名为
  `dsh-project-progress`，0.2.0 发布时这三个字段仍写着旧名 `dsh-project-manager`。
  链接本身靠 GitHub 重定向仍可用，但 npm 页面上显示的是个已改名的旧名字。
  npm **不允许**修改已发布版本的元数据，因此只能靠新版本修正。

### 说明

- **代码无任何变更**：本版本与 0.2.0 的产物逐字节相同（`lib/index.js`、`lib/client.js`
  及 `HOST_BATCH` 均未改动），只为修正 `package.json` 里的链接字段而发。
  若你已装 0.2.0，**没有升级的必要**。

## [0.2.0] — 首个公开版本

### 变更

- **包名改为 `dsh-project-progress`**（原 `dsh-project-manager`）。
  原因：`dsh-project-manager` 在 npm 上已被他人占用（`hoyyang/dsh-project-manager` 0.4.0，与本项目无关）。
- 版本号 `0.1.0` → `0.2.0`。

> ⚠ **包名同时是本插件的运行时身份。** 若你此前装过旧名字的版本，必须先把 profile 里的挂载改掉
> （`dependencies` 与 `dsh.profile.bundles` 中的名字、以及 `node_modules` 下的目录名），
> 否则浏览器会抛 `bundle … loaded without registering "…" via __ModuleLoader__.load`。
> 宿主认领客户端 bundle 的规则是三者严格相等：**loader 行名 === 包目录名 === `package.json.name`**。

### 破坏性变更

- **工具数 33 → 32**：删除 `pm_scan`。
- **删除「扫描工作区 → 直接建树」整条产品路径**。目录不再是节点；建树改由 **AI 建树**承担
  （读目录骨架与关键文件签名，一次调用产出功能点 / 任务点 + 相对工作量 + 完成度初判，
  **先给成本再花 token**）。起因是真机上那棵树按**目录**建了出来，根因是替换草稿的判据
  `proposedNames.has(node.name)` 让"被模型提到过的目录名"免于清理，而骨架与真功能点
  共用名字与进度字段，只能靠名字猜。既然做不好，直接不要了。
- **删除两条路由**：`POST /pm/scan`、`POST /pm/scan/apply`。
- **删除四个设置项**：`scanMaxDepth`、`scanMaxChildrenPerDir`、`scanMaxNodes`、`scanInclude`。

### 修复

- **匿名读不再被别的会话带偏**（真 bug）：面板轮询此前会读到**别的**会话绑定的项目
  （写路径跟着全局 `pendingRoot`，且匿名读认可全局 `workspaceRootOverride`）。
  现在写路径一律跟随调用会话，匿名读只认 `lastSessionBound` / `lastAnonymousBound`。
- **门控写路径补上会话绑定**：`pm_pause` / `pm_hold` / `pm_resume` / `pm_release` 此前会去
  **别人的项目**里找节点，现在全部按调用会话解析工作区。
- **`maximum context length` 事前判断**：真正跑出过
  `maximum context length is 1048576 tokens … you requested 1049147 tokens`。
  现在 AI 调用前先估输入 + 输出上限是否装得进模型窗口，装不下就如实拒绝（`input-over-context`）
  或把输出压到窗口余量（`windowOverflow`）；宿主不披露窗口时，从提供方拒绝里**学会**窗口
  （`.pm/ai-usage.json` 的 `learnedContextWindow`，有上下界校验）。
- **疑似遗留的节点不再与"正常待办"长得一样**：未完成清单里的残留节点改为灰色虚线方块并带说明。
- **清理幽灵空项目**：零根节点 + 零节点的项目会被清掉（跳过当前绑定）。

### 新增

- **`pm_review` 节点审查**（FR-164）：待审标记 / 审查通过，父节点通过则整枝视为已审。
- **「删除此项目」清理入口**（`DELETE /pm/projects`）：两段式确认，且不允许删除当前绑定的项目；
  配套 `scripts/cleanup-storage.mjs` 可清理 KV 里**不可达**的历史记录（默认 dry-run，
  `--apply` 需显式给出项目与根节点，且先自动备份）。
- **`pm_consolidate` 重复枝合并**：只给方案（不改数据），确认后才执行先搬后删。
- **宿主批次自报**（`HOST_BATCH`）：诊断页显示"宿主批次 第 N 批"，用来区分"改了没用"与"跑的还是旧代码"。
  旧宿主没有这个字段时如实写"未知（宿主为旧版）"，**不猜**。

### 说明

- 基准宿主 `@deepseek-ai/dsh` **0.1.5-rc.2**（本版本只在该版本上实测过）。
- 安装：`dsh plugin --profile web add dsh-project-progress`，随后重启 `dsh web`。
- 代码仓库：<https://github.com/lph993/dsh-project-progress>

[0.3.0]: https://github.com/lph993/dsh-project-progress/releases/tag/v0.3.0
[0.2.1]: https://github.com/lph993/dsh-project-progress/releases/tag/v0.2.1
[0.2.0]: https://github.com/lph993/dsh-project-progress/releases/tag/v0.2.0
