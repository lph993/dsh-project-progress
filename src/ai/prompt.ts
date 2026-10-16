/**
 * AI 建树的提示词与成本估算（**纯函数**，可单测）。
 *
 * 两条硬要求贯穿全文：
 * 1. **节点必须是功能点或任务点**（FR-39j）——文件只能作为 `refs`，绝不建文件节点；
 * 2. 输出必须是**严格 JSON**，且 `weight` / `progress` / `priority` 的语义写死：
 *    - `weight` = 相对工作量（1..10，来自**对任务的判断**，不是代码量）；
 *    - `progress` = 完成度初判（0..1，**看代码现状**得出的初值，允许不给）；
 *    - `priority` = 优先级（1..10，**1 最高**，回答"未完成的先做哪个"，与工作量无关）。
 */

import type { NodeKind } from '../shared/types.ts';

/**
 * **单次建树的输出上限**默认值：**`0` = 跟随宿主/模型**（插件不设限）。
 *
 * 用户口径（原话）："**上限应该和 harness 参数持平**" + "上限太低，万一生成超了还要从头生成，
 * 更费 token 吧" —— 后者是关键：**被截断的代价是整轮重来**，比多给一点上限贵得多。
 *
 * 宿主那边的正解是 `LlmResolvedModelInfo.defaultMaxTokens`（"调用方省略 maxTokens 时由适配器
 * 落地的那个上限"，即模型设置里的"最大输出 token 数"，本机是 256K）。
 * 所以：**用户没显式设闸门时，我们根本不传 `maxTokens`**，让宿主按模型配置走；
 * 只是把宿主那个值读出来**用于显示与估算**（这样"每节点预算/预计输出"仍然算得出来）。
 */
export const DEFAULT_AI_MAX_OUTPUT_TOKENS = 0;

/**
 * **每个节点大约吐多少 token**（用于确认框里那句"预计输出约 X token"）。
 *
 * **取值依据（不是拍脑袋）**：真机实测给了一个**下界** —— 上限 8192 顶满、而"最多 60 个节点"
 * 这份要求仍没吐完（`max-tokens` 截断），说明每节点**至少** 8192/60 ≈ **136** token。
 * 所以取 **160**（略高于下界，留一点余量），宁可略高也不假装更省。
 *
 * 用户口径（明确授权粗估，原话）：**"不用精确，说了预估"** ——
 * 所以这里给估数，但**必须**：① 标明"粗估"；② 把算法一起写出来（节点数 × 每节点约多少），
 * 让人能自己判断这个数怎么来的；③ 与"上次实测"（FR-171）分开说，两个来源不许混。
 */
export const OUTPUT_TOKENS_PER_NODE_ESTIMATE = 160;

/** 仓库骨架里的一行（只含元数据，**不含文件内容**）。 */
export interface SkeletonEntry {
  /** 工作区相对路径（目录不带尾斜杠）。 */
  path: string;
  kind: 'dir' | 'file';
  sizeBytes?: number;
  /** 直接子文件数（目录才有）。 */
  fileCount?: number;
  /** 是否关键文件（package.json / README / tsconfig / 文档…）。 */
  keyFile?: boolean;
  /** 关键文件的签名（截断后的前若干行，来自"只读入口文件"这一级）。 */
  signature?: string;
}

export interface PromptInput {
  /** 项目名建议（来自 package.json 或目录名）。 */
  projectName: string;
  skeleton: readonly SkeletonEntry[];
  /** 最多产出多少节点（与面板/工具的节点上限一致）。 */
  maxNodes: number;
  /** 骨架是否因深度/数量上限被截断（必须如实告知模型）。 */
  truncated?: boolean;
  skipped?: number;
  /**
   * **本轮只给这些节点生成描述**（按名字匹配）。
   *
   * 用户口径："修剪树时已有简述和简报的不必再次要求 AI 生成…省 token"。
   * 传了它就在用户消息里列出清单，并告诉模型"其余节点的 `description` 一律省略"——
   * 省的是**模型的输出 token**（只靠落库时丢弃是不够的：那已经花掉了生成的钱）。
   *
   * 不传（`undefined`）= 按常规要求每个节点都给描述（首次建树用）。
   */
  describeOnly?: readonly string[] | undefined;
}

/** 系统提示词：把"不许做什么"写清楚，比"要做什么"更能省 token。 */
export const AI_TREE_SYSTEM_PROMPT = [
  '你是项目进度看板的建树助手。',
  '',
  '**输出格式（最优先；违反即视为失败）**：',
  '- 你的回复里**只有**一个 JSON 对象：第一个字符必须是 `{`，最后一个字符必须是 `}`。',
  '- 不要任何解释、前言、后记；不要 Markdown 代码围栏（不要 ```json）；不要写"好的"。',
  '- 键与字符串用双引号；不要注释；不要尾逗号。',
  '',
  '硬规则：',
  '1. 节点必须是「功能点」或「任务点」（kind: "feature" | "task"），**不是文件**。',
  '   文件的唯一用途是节点的 refs（工作区相对路径），禁止为单个文件建节点，',
  '   也禁止出现「其余 N 个文件」这类文件名语气的节点。',
  '2. 名称用中文、动宾或名词短语（如「登录与鉴权」「消息推送服务」「好友列表」），不要照抄目录名。',
  '3. **层级必须分下去，不许摊平**（用户实测投诉："树干越来越多树枝，每个树枝没有子枝桠，全是叶子"）：',
  '   - 根 1 个（parent: null）；',
  /**
   * ⚠️ **根必须是"项目本体"，不许是某一个端**（0.3.30，真机 PEIS 现场）。
   *
   * 那次建树的产物：根 = 「移动端外出登记」（一个**子应用**），而
   * 桌面端 / Web 门户 / AI 接口服务全被挂到了**移动端下面** —— 于是用户看到的是
   * "**PEIS 是个 web 应用，为什么会被判成 mobile 应用**"。
   *
   * 节点其实一个都不缺（Web、Blazor、桌面客户端都在树里），**错的是层级方向**：
   * 项目本体被降级成了某个端的子节点。而这条判据此前**根本没有** ——
   * 提示词只说了"根 1 个"，却随手举了"前端 / PC 后端 / mobile 后端 / 移动端 / Android"这一串
   * 并列的例子，模型很容易**把第一个提到的端当成根**。
   */
  '   - **根必须是「项目本体」，名称用项目名或"项目名+一句话"**（如「体检管理系统」「PEIS 体检信息系统」）；',
  '     **绝不许**把某一个端/子应用/模块当根（如把「移动端外出登记」「Web 前端」当根）——',
  '     那会让其余所有端都被挂到它下面，**层级方向整个反掉**；',
  /**
   * ⚠️ **"项目名不许再当一个子节点"**（0.3.33，真机 PEIS 第二次重建的现场）。
   *
   * 0.3.30 加了"根必须是项目本体"之后，模型**照做了**（根不再叫「移动端外出登记」），
   * 但产生了新的半成品形态：根叫「**Web 服务端与业务模块**」，而
   * **「PEIS 体检管理系统」成了根的一个子节点**，各端（Blazor 端 / 移动端应用 / 桌面表单客户端）
   * 被塞进那个子节点里 ⇒ 层级**仍差一层**，而且根名依然是"某个端"。
   *
   * 成因是**指代不足**：我说了"根用项目名"，却没说不许**另起一个叫项目名的子节点**。
   * 模型于是把两个身份**各占一个节点**（根=它以为的主端，子节点=项目名）。
   */
  '   - **项目名只能出现在根上**：既不许把某个端当根，**也不许**再建一个叫项目名的子节点',
  '     （如根叫「Web 服务端」、它下面又挂一个「XX 体检管理系统」）——那是把项目身份拆成了两个节点，',
  '     各端会被塞进那个子节点里，**白丢一层**；正确形态是：**根 = 项目名**，',
  '     **各端（Web / 移动端 / 桌面端 / 后台服务…）是根的直接子节点、彼此并列**；',
  '   - **根的直接子节点 = 项目的大功能**（用户口径："像具有前端后端移动端这种…按大功能分区，',
  '     要不然单一区太大"）。按项目**实际**的端/面来分，例如：前端 / PC 后端 / mobile 后端 /',
  '     移动端(H5·小程序) / Android / iOS / 数据与运维 …；**只有真的是一件事时才合并**',
  '     （例如没有独立 mobile 后端就别硬拆），也**不许**把除第一个之外的所有东西都挂到第一个大功能下',
  '     （那样画布上只有一个巨大的区）；',
  '   - **先判断这是"一个应用"还是"一个系统/多端工程"**：看 README、解决方案文件（`*.sln`）、',
  '     根 `package.json` 与顶层目录构成。多端工程就把**每个端作为并列的大功能**，',
  '     谁都不比谁高一层；',
  '   - **每个大功能要长成一棵自洽的树**（用户口径："一个独立功能是一颗大树，各自自洽"）：',
  '     大功能下面继续分「子功能 → 任务点」，**不要把它的枝桠当成与它平级的独立单元**；',
  '     跨大功能共用的东西（如公共数据模型）留在各自区里如实标注即可 ——',
  '     真需要跨区补充/改动时，由人在图上审核确认，**不要**为了让两个区"看起来共享"而把节点挂到根下；',
  '   - **任何节点的直接子节点不超过 6 个**；一个功能点要挂超过 5 个任务点时，**必须**先拆成 2–5 个',
  '     「子功能点」，再把任务点挂在子功能点下；',
  '   - 目标深度**至少 3 层**（根 → 大功能 → 子功能 → 任务点），宁可比现在深一层，也不要横向摊开；',
  '   - 叶节点＝可独立完成的任务点（一个人在一次改动里能做完的事），**不是文件**；',
  '   - 同一棵树里**不许给同一概念起两个名字**（如「宿主适配层」与「工作区与宿主适配层」算重复），也不许近义改写。',
  '   节点总数不超过 maxNodes；宁可粗一点，也不要堆无意义的小节点。',
  '4. weight 是**相对工作量**（数字 1–10，越大越重），依据是"这件事本身有多大"，',
  '   **不是**已有代码的行数或文件数；没把握就省略该字段。',
  '5. progress 是**完成度初判**（0–1），**每个节点都要给**。',
  '   为什么不能省略：省略与"确实没做"在存储和界面上**分不开** —— 看板会把它显示成 0%，',
  '   等于替用户猜了一个 0（这正是本插件明令禁止的事）。所以宁可给一个**带依据**的 0。',
  '   例如：核心逻辑写完且有测试 → 0.8；只有接口骨架 → 0.2；',
  '   **骨架里看不到这块的实现痕迹 → 给 0，并在 `note` 里写明依据**（如"未见实现"）。',
  '   数字是你的判断，不是宿主编的 —— 但必须是**你判断出来的**，不能留空。',
  '6. **description 是给这个节点补的描述**（用户诉求："AI 建树/修剪树/同步树时直接补充描述信息"）：',
  '   **每个节点都要给**，一句话讲清"这块要做什么/负责什么"（20–60 字，中文，具体到能照着干活）。',
  '   不要写"这是关于 X 的模块"这种正确的废话，也不要复述名字；',
  '   **注意与 `note` 区分**：`description` 回答"做什么"，`note` 回答"我凭什么这么判断"（可选）。',
  '7. priority 是**优先级**（整数 1–10，**1 最高**）：用来回答"未完成的这些里，**先做哪个**"。',
  '   依据是"它有多关键、卡不卡别人、是不是主路径"，**不是**它的工作量（那是 weight）。',
  '   请**尽量都给出**；实在判断不出就给 5（中位）。已完成的节点不需要考虑优先级。',
  '8. 不要输出任何"还需多久/预计工时"信息。',
  '',
  '输出 JSON 结构：',
  '{"projectName":"可选，项目名","nodes":[',
  '  {"name":"根功能名","kind":"feature","parent":null,"priority":3,',
  '   "description":"整个插件的宿主面与客户端面骨架","refs":[{"type":"dir","target":"src"}]},',
  '  {"name":"子功能","kind":"feature","parent":0,"weight":6,"priority":7,"progress":0.4,',
  '   "description":"登录态与权限校验，含会话续期","refs":[{"type":"dir","target":"src/auth"}],',
  '   "note":"可选：我凭什么这么判断"}]}',
  '说明：parent 是**该数组里父节点的下标**（根为 null；父必须出现在子之前）。',
].join('\n');

/** 渲染骨架文本（只有路径/大小/关键文件签名，不含整文件内容）。 */
export function renderSkeleton(input: PromptInput): string {
  const lines: string[] = [];
  const dirs = input.skeleton.filter((entry) => entry.kind === 'dir');
  const files = input.skeleton.filter((entry) => entry.kind === 'file');
  lines.push(`项目名建议：${input.projectName}`);
  lines.push(`目录（${dirs.length} 个）：`);
  for (const dir of dirs.slice(0, 120)) {
    const count = dir.fileCount === undefined ? '' : `（${dir.fileCount} 个直接文件）`;
    lines.push(`- ${dir.path}/${count}`);
  }
  lines.push('');
  lines.push(`文件（${files.length} 个，只列关键文件的内容签名）：`);
  /**
   * **关键文件必须排在最前面**（0.3.32，独立审查挖出的病灶）。
   *
   * 此前这里是 `files.slice(0, 60)` **纯按顺序取**，而顺序 = `allocFairly` 的遍历顺序 ——
   * `.vs` / `.codeartsdoer` / `.arts` 这类以点开头的目录名排在前面，会把
   * `README.md` / `PEIS.sln` / 根 `package.json` 挤到第 300 多位 ⇒ **判据材料到不了模型**。
   *
   * 这不是"宽松点更好"的问题：0.3.30 加的那条硬规则正是"**先看 README / `*.sln` / 根
   * `package.json` 判断这是一个应用还是多端工程**" —— 材料看不见，规则就是空的。
   *
   * 为什么**不是**把上限从 60 放宽：那会同时多塞噪声（实测前 60 个里有 28 个是
   * `.vs`/`.codeartsdoer`/`.arts`/`.vscode`）且更费 token。**优先**比**更多**对。
   */
  const keyEntries = files.filter((file) => file.keyFile === true);
  const restEntries = files.filter((file) => file.keyFile !== true);
  for (const file of [...keyEntries, ...restEntries].slice(0, 60)) {
    const size = file.sizeBytes === undefined ? '' : ` ${Math.round(file.sizeBytes / 1024)}KB`;
    lines.push(`- ${file.path}${size}`);
    if (file.signature !== undefined && file.signature.trim() !== '') {
      lines.push(`  签名：${file.signature.replace(/\s+/g, ' ').slice(0, 600)}`);
    }
  }
  if (input.truncated === true) {
    lines.push('');
    lines.push('注意：目录遍历因上限被截断，上面不是全部内容，请按可见部分给出骨架。');
  }
  if (input.skipped !== undefined && input.skipped > 0) {
    lines.push(`（另有 ${input.skipped} 个条目被排除/跳过，未列出）`);
  }
  return lines.join('\n');
}

/** 完整的用户消息（骨架 + 任务要求 + 上限）。 */
export function buildTreePrompt(input: PromptInput): string {
  const lines: string[] = [
    `请为下面这个仓库生成项目进度树（最多 ${input.maxNodes} 个节点）。`,
    '',
    renderSkeleton(input),
    '',
  ];
  /**
   * **只给缺描述的节点生成描述**（用户口径："修剪树时已有简述和简报的不必再次要求 AI 生成…省 token"）。
   *
   * 这一句直接决定模型的**输出长度**：清单外的节点连 `description` 字段都不用吐，
   * 省的是真金白银的输出 token（只在落库时丢弃是省不到的 —— 生成的钱已经花了）。
   */
  if (input.describeOnly !== undefined) {
    if (input.describeOnly.length === 0) {
      lines.push('**本轮所有节点都已有描述：请不要输出任何 `description` 字段**（省 token），');
      lines.push('但仍要按平时的要求给出节点、层级、weight / priority / progress。');
    } else {
      lines.push(
        `**本轮只有下列 ${input.describeOnly.length} 个节点需要 ` +
          `\`description\`（简述这块要做什么，20–60 字）：**`,
      );
      for (const name of input.describeOnly.slice(0, 60)) lines.push(`- ${name}`);
      if (input.describeOnly.length > 60) lines.push(`（另有 ${input.describeOnly.length - 60} 个，按同样规则）`);
      lines.push('');
      lines.push('**清单之外的节点：一律不要输出 `description` 字段**（它们已有描述，省 token）。');
    }
    lines.push('');
  }
  lines.push('请只输出 JSON。');
  return lines.join('\n');
}

/** AI 建树的成本估算结果（如实标注"粗估"）。 */
export interface AiEstimate {
  /** 发送给模型的骨架条目数（目录 + 关键文件）。 */
  entries: number;
  /** 关键文件签名的字节数（只有这一小部分会进提示词）。 */
  signatureBytes: number;
  /** 提示词字节数。 */
  promptBytes: number;
  /** 预计调用次数（建树 + 工作量 + 完成度初判合并在同一次调用里）。 */
  calls: number;
  /** 预计输入 token（按字节粗估）。 */
  inputTokens: number;
  /** 输出上限 token；**`undefined` = 跟随宿主**（读不到宿主值时才为空）。 */
  outputTokens?: number;
  /**
   * 这个上限从哪来：`plugin`（用户显式设了闸门）/ `host`（跟随宿主的模型配置）/
   * `unknown`（既没设、也读不到宿主值）。
   *
   * 界面必须据此措辞 —— "跟随宿主"和"我们自己设的"是两件事，混着说会让人以为插件在替模型设限。
   */
  outputLimitSource?: 'plugin' | 'host' | 'unknown';
  /** 预计总 token（粗估，用于成本提示）。 */
  totalTokens: number;
  /** 本次**要求模型最多建多少个节点**（`maxNodes`）；`0` = 未指定。 */
  maxNodes: number;
  /**
   * **预计输出 token（粗估）**：`maxNodes × OUTPUT_TOKENS_PER_NODE_ESTIMATE`。
   *
   * 用户口径："不用精确，说了预估" —— 给估数，但界面必须标明粗估并写出算法。
   */
  estimatedOutputTokens?: number;
  /**
   * **事前提示**：这个仓库的文件数超过单次请求的常规范围（`shouldShard`）。
   *
   * 它**只是提示**，不是判定 —— 真正的"要不要分批"看的是**失败了没有、能不能切**（FR-165）。
   * 放在确认框里是为了让用户**先知道风险**，而不是等被截断了才被告知。
   */
  likelyTooLarge?: boolean;
  /**
   * **上次建树实测**（FR-171）：最近一次成功且**提供方回报真实用量**的单次调用。
   *
   * 只有拿到真实 `usage` 才有值 —— 绝不用我们自己的粗估冒充"实测"（那比不说更糟）。
   */
  lastActual?: {
    at: string;
    inputTokens: number;
    outputTokens: number;
  };
  /**
   * **这次请求装不装得进模型的上下文窗口**（真机踩过：`maximum context length`）。
   *
   * 现场：输入 793147 + 输出上限 256000 = 1049147 > 窗口 1048576（超 571），
   * 请求被提供方直接拒掉 —— 而确认框当时只说"规模较大，建议先缩小扫描范围"，
   * 没有一个字提到"会超窗口"。
   *
   * 三个值要么来自宿主（`LlmResolvedModelInfo.context` / `defaultMaxTokens`），
   * 要么来自**提供方拒绝时的原话**（`learnContextWindow`）；两条都没有就**不给这个字段**
   * （界面照旧不承诺判断），绝不编一个窗口出来。
   *
   * 口径：这是**粗估判定**（token 换算按字节估），所以措辞必须留余地 ——
   * 说"很可能超"，不说"一定超"；反过来说"装得下"时也要标明是粗估。
   */
  context?: {
    /** 模型窗口（宿主披露值，或从提供方拒绝里学到的值）。 */
    windowTokens: number;
    /** 这个窗口值的来源（界面措辞要分开说，不能把"学来的"说成"宿主披露的"）。 */
    source: 'host' | 'learned';
    /** 输入 + 输出上限的粗估和。 */
    totalTokens: number;
    /** 粗估是否会超窗（`totalTokens > windowTokens`）。 */
    feasible: boolean;
  };
  /** 规模档位，用于 UI 给一句话判断。 */
  level: 'small' | 'medium' | 'large';
}

/**
 * 估算一次 AI 建树的规模。
 *
 * **只用手上已有的元数据**（条目数、签名字节、输出上限），
 * 不为了估成本去读文件（§9.5 T3）。token 换算按"混合中英、约 3 字节/token"粗估，
 * 结果一律标注为粗估 —— 估不准就说估不准。
 */
export function estimateAiBuild(input: {
  entries: number;
  signatureBytes: number;
  promptBytes: number;
  /**
   * 输出上限（token）。**省略 = 跟随宿主**（`AiEstimate.outputTokens` 随之为 undefined）。
   *
   * 注意这里**不再兜底成一个假数字**：早先 `maxOutputTokens=0` 会被兜成 4096，
   * 于是"跟随宿主"在界面上会显示成一个凭空的 4096。宁可显示"跟随宿主/未读到"，
   * 也不要编一个看起来精确的数。
   */
  maxOutputTokens?: number | undefined;
  /** 上限来源（见 `AiEstimate.outputLimitSource`）。 */
  outputLimitSource?: 'plugin' | 'host' | 'unknown';
  /**
   * 模型上下文窗口（宿主 `LlmResolvedModelInfo.context.contextWindow`）。
   * 读不到就省略 —— 那时**不做**"装不装得下"的判断（见 `AiEstimate.context`）。
   */
  contextWindow?: number | undefined;
  /**
   * 这条窗口值是**从哪来的**：
   * - `host`：宿主披露的（权威）；
   * - `learned`：**从提供方的拒绝里学到的**（真机踩过：这台宿主对该模型不披露窗口，
   *   而报错原文里写着真实窗口）—— 界面必须标明"学来的"，不能说成宿主披露的。
   */
  contextWindowSource?: 'host' | 'learned';
  /** 本次要求模型最多建多少个节点（用来算"每个节点有多少输出预算"）。 */
  maxNodes?: number;
  /** 事前提示：仓库文件数超过单次请求的常规范围（见 `AiEstimate.likelyTooLarge`）。 */
  likelyTooLarge?: boolean;
  /** 上次实测（提供方真实用量）；只透传，不做任何加工。 */
  lastActual?: { at: string; inputTokens: number; outputTokens: number };
  /**
   * **确定会分批**时的片数（骨架没把仓库装下 ⇒ `aiBuildTree` 直接分批，见批次 77/78）。
   *
   * 传了它就意味着"上面那些条目数/输入 token 是**按 N 片合计**的口径、实际会发 N 次调用"，
   * 描述里那几句"若被截断才分批重试"也必须换成"直接分批"—— 否则确认框会自相矛盾：
   * 一边写着"预计 1 次调用"，一边真的发 6 次（真机实测过这个谎）。
   */
  plannedShards?: number;
}): AiEstimate {
  const maxOutputTokens =
    input.maxOutputTokens !== undefined && Number.isFinite(input.maxOutputTokens) && input.maxOutputTokens > 0
      ? Math.round(input.maxOutputTokens)
      : undefined;
  const promptBytes = Number.isFinite(input.promptBytes) && input.promptBytes > 0 ? input.promptBytes : 0;
  const entries = Number.isFinite(input.entries) && input.entries > 0 ? Math.round(input.entries) : 0;
  const signatureBytes =
    Number.isFinite(input.signatureBytes) && input.signatureBytes > 0 ? Math.round(input.signatureBytes) : 0;
  const inputTokens = Math.ceil(promptBytes / 3);
  const totalTokens = inputTokens + (maxOutputTokens ?? 0);
  const maxNodes =
    input.maxNodes !== undefined && Number.isFinite(input.maxNodes) && input.maxNodes > 0
      ? Math.round(input.maxNodes)
      : 0;
  /**
   * **档位按"输入"判，不按"输入 + 输出上限"判**。
   *
   * 之前用 `inputTokens + maxOutputTokens` 判档：输出上限一调大（FR-81b 的默认值这次从 8192
   * 提到 32768），同一个仓库立刻从"规模中等"变成"规模较大，建议先缩小扫描范围" ——
   * 而它的**输入**一点没变。把"我们自己设的天花板"算进规模，等于让档位随设置漂移。
   */
  const level: AiEstimate['level'] =
    inputTokens < 8000 ? 'small' : inputTokens < 30000 ? 'medium' : 'large';
  /**
   * 「装不装得进窗口」的粗估判定：**输入粗估 + 输出上限** 与宿主披露的窗口比。
   * 窗口未知 ⇒ 不给这个字段（不承诺任何判断）。
   */
  const windowTokens =
    input.contextWindow !== undefined && Number.isFinite(input.contextWindow) && input.contextWindow > 0
      ? Math.round(input.contextWindow)
      : undefined;
  const context =
    windowTokens === undefined
      ? undefined
      : {
          windowTokens,
          source: input.contextWindowSource ?? 'host',
          totalTokens,
          feasible: totalTokens <= windowTokens,
        };
  return {
    entries,
    signatureBytes,
    promptBytes,
    calls:
      input.plannedShards !== undefined && input.plannedShards > 1
        ? Math.round(input.plannedShards)
        : 1,
    inputTokens,
    ...(maxOutputTokens !== undefined ? { outputTokens: maxOutputTokens } : {}),
    ...(input.outputLimitSource !== undefined ? { outputLimitSource: input.outputLimitSource } : {}),
    ...(context !== undefined ? { context } : {}),
    totalTokens,
    maxNodes,
    ...(maxNodes > 0
      ? { estimatedOutputTokens: maxNodes * OUTPUT_TOKENS_PER_NODE_ESTIMATE }
      : {}),
    ...(input.likelyTooLarge === true ? { likelyTooLarge: true } : {}),
    ...(input.lastActual !== undefined ? { lastActual: input.lastActual } : {}),
    level,
  };
}

/**
 * 档位的中文说明（面板成本提示用）。
 *
 * **这里只写"确定能算的"**：条目数、签名字节、次数、token 上限，以及
 * 「输出上限 ÷ 节点上限」这一步纯算术。**不给"预计会输出多少 token"这种假精确** ——
 * 模型吐多少字不由我们决定，说了就是编。
 *
 * 为什么非要把"输出上限"和"每节点预算"摆到台面上：真机实测踩过一次 ——
 * 确认框只写"预计 1 次调用、约 9767 token"，用户看不出那 9767 里 **8192 是硬上限**，
 * 也看不出"要建 60 个节点"意味着**每节点只有 136 token** 的预算，于是点了确认，
 * 模型输出到 max-tokens 被截断，整轮白花。
 */
export function describeEstimate(estimate: AiEstimate): string {
  const levelText =
    estimate.level === 'small'
      ? '规模小，成本很低'
      : estimate.level === 'medium'
        ? '规模中等'
        : '规模较大，建议先缩小扫描范围';
  /**
   * **上限措辞按来源分**（用户口径："上限应该和 harness 参数持平"）：
   * - `host`：跟随宿主的模型设置 —— 必须说清"这不是插件设的"，否则用户会以为插件在限它；
   * - `plugin`：用户自己在设置里设的闸门；
   * - `unknown`：既没设、也读不到宿主值 —— 如实说"未读到"，**不编一个数字**。
   */
  const perNode =
    estimate.outputTokens === undefined
      ? undefined
      : Math.floor(estimate.outputTokens / Math.max(1, estimate.maxNodes));
  const limitHead =
    estimate.outputTokens === undefined
      ? estimate.outputLimitSource === 'host' || estimate.outputLimitSource === 'unknown'
        ? '**输出上限：跟随宿主/模型设置**（插件不设限；没读到具体数值，所以不给每节点预算）'
        : '**输出上限：跟随宿主/模型设置**（未读到具体数值）'
      : estimate.outputLimitSource === 'host'
        ? `**输出上限 ${estimate.outputTokens} token**（**跟随宿主的模型设置**，不是插件设的；硬天花板，不是预期花费）`
        : `**输出上限 ${estimate.outputTokens} token**（插件设的预算闸门；硬天花板，不是预期花费）`;
  const budgetText =
    estimate.outputTokens === undefined || perNode === undefined
      ? `${limitHead}。`
      : estimate.maxNodes > 0
        ? `${limitHead}：本次要建最多 ${estimate.maxNodes} 个节点，` +
          `摊到每个节点只有 ${perNode} token（含名称/描述/引用/备注）。`
        : `${limitHead}。`;
  /**
   * **预计输出（粗估）**：用户口径是"不用精确，说了预估" —— 给数，但把算法摊开写，
   * 并且**与"上次实测"分开说**（一个是估的，一个是真发生过的）。
   */
  const estimatedOutputText =
    estimate.estimatedOutputTokens === undefined
      ? ''
      : `**预计输出约 ${estimate.estimatedOutputTokens} token（粗估）**` +
        `＝ ${estimate.maxNodes} 个节点 × 每节点约 ${OUTPUT_TOKENS_PER_NODE_ESTIMATE} token` +
        `（系数依据：实测上限 8192 顶满时 60 个节点仍没吐完，即每节点至少 136，取 160 留余量）。`;
  /**
   * **上次实测**（FR-171）：有真实用量就说，没有就不说 ——
   * 这一段存在的理由是"事前精确预计做不到"（宿主不固定分词器），
   * 但**上一次真的发生过什么**是硬事实，对"这次会不会顶到上限"比任何估算都有用。
   */
  const actual = estimate.lastActual;
  const actualText =
    actual === undefined
      ? ''
      : `上次建树实测（提供方回报，非预计）：一次调用输出 ${actual.outputTokens} token、输入 ${actual.inputTokens} token` +
        `（${actual.at.slice(0, 16).replace('T', ' ')}）。` +
        (estimate.outputTokens !== undefined && actual.outputTokens >= estimate.outputTokens
          ? `**上次就已经顶到当前上限了** —— 建议把输出上限调大，或让它按顶层目录分批。`
          : '');
  /**
   * **窗口判定**（真机踩过 `maximum context length`）：粗估的"输入 + 输出上限"与宿主披露的
   * 模型窗口比。读不到窗口就**一句话都不说**（不承诺判断）；读到了就直说，超了就警告。
   */
  const contextText =
    estimate.context === undefined
      ? ''
      : estimate.context.feasible
        ? `模型窗口 ${estimate.context.windowTokens} token${estimate.context.source === 'learned' ? '（从上次被拒的原话里学到的）' : ''}：**粗估装得下**` +
          `（输入 + 输出上限约 ${estimate.context.totalTokens} token）。`
        : `⚠️ **这次请求很可能超模型上下文窗口**：粗估合计 ${estimate.context.totalTokens} token` +
          `（输入 + 输出上限），而模型窗口只有 ${estimate.context.windowTokens} token` +
          `${estimate.context.source === 'learned' ? '（从上次被拒的原话里学到的）' : ''}` +
          ` —— 真机上这类请求会被提供方直接拒掉。**建议先缩小扫描范围**（或把输出上限调小），再发起。`;
  return (
    `${levelText}：将发送 ${estimate.entries} 个骨架条目` +
    `（关键文件签名 ${Math.round(estimate.signatureBytes / 1024)} KB），` +
    `**输入约 ${estimate.inputTokens} token**（粗估）、预计 ${estimate.calls} 次调用。` +
    budgetText +
    contextText +
    estimatedOutputText +
    actualText +
    (estimate.likelyTooLarge === true
      ? estimate.calls > 1
        ? `这个仓库的骨架没装下（只覆盖一部分）：**这次会直接按顶层目录分批（${estimate.calls} 片）**，不等失败再重试；上面的条目数与输入 token 是**按 ${estimate.calls} 片合计**的口径。`
        : '这个仓库的文件数超过单次请求的常规范围：**若这次输出被截断，会自动按顶层目录分批重试**（事前先说清楚，不等到失败才告诉你）。'
      : '') +
    '不发送整文件内容；建树、相对工作量与完成度初判在同一次调用里完成。' +
    (estimate.calls > 1
      ? `每片一次调用，共 ${estimate.calls} 次（片数有上限）。`
      : `若这次输出被截断，插件会自动按顶层目录**分批**重试（片数有上限），不会白花这一轮。`) +
    (estimate.outputTokens === undefined
      ? ''
      : `最坏情况合计约 ${estimate.totalTokens} token（输入 + 输出上限，仅用于估算上限）。`)
  );
}

/**
 * **从提供方的拒绝原话里学出模型窗口**（真机踩过：宿主不披露窗口，但报错里写着）。
 *
 * 真机原文（DeepSeek 的 `maximum context length`）：
 * ```
 * This model's maximum context length is 1048576 tokens. However, you requested
 * 1049147 tokens (793147 in the messages, 256000 in the completion).
 * ```
 *
 * 为什么需要这条退路：`LlmResolvedModelInfo.context.contextWindow` 是**可选**的，
 * 本机实测**没有**这个字段（`resolveModelInfo` 只回了 `defaultMaxTokens`）——
 * 没有它，"装不装得下"就永远判不了，同一个坑会再踩一次。
 * 而"提供方说你的窗口是 N"是**硬事实**（它就是这么判的），拿它当退路完全站得住。
 *
 * 口径（不猜）：
 * - 只认明确的 `maximum context length is N tokens` 句式；
 * - 学到的值必须落在 [`MIN_LEARNED_CONTEXT_WINDOW`, `MAX_LEARNED_CONTEXT_WINDOW`] 内，
 *   否则当作没解析出来（避免把乱七八糟的数字当窗口）；
 * - 返回 `undefined` 表示"没学到"，调用方照旧不做判断。
 */
export const MIN_LEARNED_CONTEXT_WINDOW = 100_000;
export const MAX_LEARNED_CONTEXT_WINDOW = 100_000_000;

export function learnContextWindow(message: string | undefined): number | undefined {
  if (message === undefined || message === '') return undefined;
  const match = /maximum context length is (\d+) tokens/i.exec(message);
  if (match?.[1] === undefined) return undefined;
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value)) return undefined;
  if (value < MIN_LEARNED_CONTEXT_WINDOW || value > MAX_LEARNED_CONTEXT_WINDOW) return undefined;
  return value;
}

/** 节点类型推断（模型没给 kind 时的兜底：有子节点=功能点，叶子=任务点）。 */export function inferKind(hasChildren: boolean): NodeKind {
  return hasChildren ? 'feature' : 'task';
}
