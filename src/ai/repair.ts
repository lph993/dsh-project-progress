/**
 * **AI 树修复的提示词**（0.3.21，用户口径："整理规则算法，算法不行让 AI 上…直接 AI 生成树和修复维护树"）。
 *
 * ## 为什么规则不够（这是本文件存在的理由）
 *
 * `domain/consolidate.ts` 的规则式整理只做三件**机械**事：
 * - `move`：节点被"引用重叠/同名"判定为错位；
 * - `fold`：**refs 互为子集**（字符串集合判定）的并列副本合并；
 * - `delete`：被删者的 refs **逐条被覆盖**的空壳。
 *
 * 这些判据的共同点是**可机械核对** —— 好处是不撒谎，坏处是**大量真问题它看不见**：
 *
 * | 真问题 | 规则为什么看不见 |
 * |---|---|
 * | 两个枝讲同一件事、但 refs 写法不同（`src/a` vs `src/a/index.ts`） | 子集判定只看字符串集合 |
 * | 一个功能点被塞进两个不同父下（层级错位） | 规则没法判断"该挂哪" |
 * | 名字不准 / 描述过时 | 不是结构问题 |
 * | 该合并的是**语义**（"登录"与"认证入口"） | 需要理解业务 |
 * | 该拆的功能点（把 5 件事塞进一个节点） | 需要理解内容 |
 *
 * 所以：**机械部分继续用规则**（它便宜、可核对、不撒谎），
 * **语义部分交给模型**——本文件负责把树渲染成提示词，并**强制模型给出可执行的封闭动作集**。
 *
 * ## 纪律（与 `prompt.ts` 同一套）
 *
 * 1. **只输出 JSON**，每个动作只许引用 `nodeId` 白名单里的 id（防它编出不存在的节点）；
 * 2. **破坏性动作仍然走审批通道**：模型只**提议**，执行前照旧要过确认（用户明确要求保留那条）；
 * 3. **不许编**：拿不准就放进 `uncertain`，而不是硬给一个动作。
 */

/** 渲染给模型的一个节点（只带判断需要的事实，不带实现细节）。 */
export interface RepairNodeView {
  id: string;
  name: string;
  /** 父节点 id（`null` = 顶级）。 */
  parentId: string | null;
  kind: string;
  /** 树深（0 = 顶级），帮模型理解层级。 */
  depth: number;
  progress: number;
  state: string;
  description?: string;
  /** 工作区相对路径（已归一化）。 */
  refs: readonly string[];
  /** 直接子节点数。 */
  childCount: number;
}

export interface RepairPromptInput {
  projectName: string;
  nodes: readonly RepairNodeView[];
  /** 规则式整理已经算出的机械动作（让模型**不要重复提议**同一件事）。 */
  mechanicalActions: readonly { kind: string; nodeId: string; name: string; reason: string }[];
  /** 规则式整理只报告、不处置的观察（例如"部分重叠"）——交给模型判断。 */
  notes: readonly string[];
}

/** 允许的动作集（**封闭**：模型不许发明新的动作类型）。 */
export const REPAIR_ACTION_KINDS = [
  'merge', // 把 nodeId 合并进 intoNodeId（语义重复）
  'move', // 把 nodeId 挂到 toParentId 下（层级错位）
  'rename', // 改名字（newName）
  'describe', // 补/改描述（newDescription）
  'split', // 一个节点装了多件事 ⇒ 建议拆（给出 children 的名字清单）
  'delete', // 空壳/无意义节点（需说明理由）
] as const;

export const AI_REPAIR_SYSTEM_PROMPT = [
  '你是项目进度树的**维护者**。给你一棵树和一批机械判据算出来的整理动作，',
  '你的任务是找出**机械判据看不见的语义问题**，并给出可执行的动作。',
  '',
  '## 你要找的（按价值排序）',
  '1. **语义重复**：两个节点在讲同一件事（哪怕 refs 写法不同、名字不完全一样）⇒ `merge`；',
  '2. **层级错位**：某个功能点挂错了父（它明显属于另一枝）⇒ `move`；',
  '3. **名不副实 / 描述过时**：名字与内容不符、描述已经不成立 ⇒ `rename` / `describe`；',
  '4. **该拆的**：一个节点里塞了多件互不相关的事 ⇒ `split`（给出建议的子节点名）；',
  '5. **空壳**：没有任何 refs、没有描述、进度为 0、且名字没有信息量 ⇒ `delete`。',
  '',
  '## 硬性纪律（违反即整份输出作废）',
  '- **只输出一个 JSON 对象**，不要解释、不要 markdown 代码块围栏；',
  '- 每个动作里的 id **必须**来自我给你的清单，**一个字符都不许自己造**；',
  '- `kind` 只能取这几值之一：' + REPAIR_ACTION_KINDS.join(' / ') + '；',
  '- **不要重复提议**我已经列在"机械判据已算出的动作"里的同一件事；',
  '- **拿不准的不要硬给动作**：放进 `uncertain`（写清为什么拿不准），宁可少提。',
  '',
  '## 输出格式',
  '{',
  '  "summary": "一句话总述你对这棵树健康状况的判断",',
  '  "actions": [',
  '    { "kind": "merge", "nodeId": "...", "intoNodeId": "...", "reason": "为什么是同一件事" },',
  '    { "kind": "move", "nodeId": "...", "toParentId": "...", "reason": "为什么该挂那里" },',
  '    { "kind": "rename", "nodeId": "...", "newName": "...", "reason": "..." },',
  '    { "kind": "describe", "nodeId": "...", "newDescription": "...", "reason": "..." },',
  '    { "kind": "split", "nodeId": "...", "suggestedChildren": ["...", "..."], "reason": "..." },',
  '    { "kind": "delete", "nodeId": "...", "reason": "为什么它是空壳" }',
  '  ],',
  '  "uncertain": [ { "nodeIds": ["..."], "question": "你为什么拿不准" } ]',
  '}',
].join('\n');

/** 把树渲染成提示词正文（**确定性顺序**：按 depth、再按名称，保证同输入同提示词 ⇒ 可缓存）。 */
export function buildRepairPrompt(input: RepairPromptInput): string {
  const lines: string[] = [];
  lines.push(`项目：${input.projectName}`);
  lines.push(`节点总数：${input.nodes.length}`);
  lines.push('');
  lines.push('## 树（缩进表示层级；`#id` 是动作里必须原样引用的 id）');
  const sorted = [...input.nodes].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
  for (const node of sorted) {
    const indent = '  '.repeat(node.depth);
    const bits = [
      `${indent}- ${node.name}`,
      `[#${node.id}]`,
      `(${node.kind}, ${node.state}, 进度 ${Math.round(node.progress * 100)}%, 子 ${node.childCount})`,
    ];
    lines.push(bits.join(' '));
    if (node.description !== undefined && node.description !== '') {
      lines.push(`${indent}    简述：${node.description}`);
    }
    if (node.refs.length > 0) {
      lines.push(`${indent}    refs：${node.refs.join('、')}`);
    }
  }
  lines.push('');
  lines.push('## 机械判据已算出的动作（**不要重复提议这些**）');
  if (input.mechanicalActions.length === 0) lines.push('（无）');
  for (const action of input.mechanicalActions) {
    lines.push(`- ${action.kind}：${action.name} [#${action.nodeId}] —— ${action.reason}`);
  }
  lines.push('');
  lines.push('## 机械判据只报告、未处置的观察（交给你判断）');
  if (input.notes.length === 0) lines.push('（无）');
  for (const note of input.notes) lines.push(`- ${note}`);
  lines.push('');
  lines.push('现在按系统提示的格式输出那个 JSON 对象。');
  return lines.join('\n');
}
