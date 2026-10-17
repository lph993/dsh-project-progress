/**
 * **跨片按功能归拢**（0.3.46）。
 *
 * ## 它要解决的问题
 *
 * 分批建树后，每片产出的是"目录那一片"的分支 ⇒ 整棵树是**目录形状**的。
 * 用户原则（`docs/开发须知.md` §0.0）：
 *
 * > "不能按目录…目录只是好分类，代表功能具有严重局限性。"
 * > "切分单位 ≠ 树的分支单位，合并时必须按功能归拢。"
 *
 * 0.3.45 解决了"一片吞 20 个目录被串成链"，但**没有**解决"分支名/层级仍是目录形状"。
 * 这一步补的正是后者：拿"根 + 它的直接子节点"去问模型
 * **"这些分支按业务功能应该怎么归拢"**，然后把它给的分组落到树上。
 *
 * ## 为什么单独一个提示词，不复用 `aiPlanRepair`
 *
 * `aiPlanRepair` 是**通用排错**（找重复/错位/过时，动作集含 delete/split），
 * 输出大、判据多、还得靠人确认。而这里要的只是**一件事**：
 *
 * > "把根下面这 N 个分支分成几组，每组起个功能名"
 *
 * 输出小（一个分组表）⇒ 解析可靠、可以自动应用；动作只涉及 move/create，**不删任何东西**。
 *
 * ## 纪律（可核对的硬约束，写在 {@link validateRegroupPlan} 里）
 *
 * 1. **每个分支必须且只能出现在一个组里** —— 少一个就丢内容，多一个就是重复搬；
 * 2. 组数 2..6（1 组等于没归拢；太多等于把树又摊平）；
 * 3. 每组至少 2 个分支（1 个分支的"组"只是白加一层包装 —— 正是用户明确要消掉的东西）；
 * 4. 组名不许与项目名同源（那是根的名字，不该在中间再出现一次）；
 * 5. 组名不许互相重复。
 *
 * 任一条不满足 ⇒ **整份方案作废**（不做部分应用：半套归拢比不归拢更难理解）。
 */

/** 一个待归拢的分支（根的某个直接子节点）。 */
export interface RegroupBranch {
  id: string;
  name: string;
  /** 它自己这条 refs（给模型判断"这块是什么"）。最多取前几条。 */
  refs: readonly string[];
  /** 直接子节点数（让模型知道这块有多大）。 */
  childCount: number;
  description?: string;
}

export interface RegroupGroup {
  name: string;
  description?: string;
  branchIds: string[];
}

export interface RegroupPlan {
  groups: RegroupGroup[];
  summary?: string;
}

export type RegroupProposal =
  | { ok: true; plan: RegroupPlan }
  | { ok: false; reason: string; rejected: string[] };

/** 组数上下限（见文件头纪律 2）。 */
export const MIN_REGROUP_GROUPS = 2;
export const MAX_REGROUP_GROUPS = 6;

/** 送给模型的系统提示词。 */
export const AI_REGROUP_SYSTEM_PROMPT = [
  '你是项目进度看板的"树归拢"助手。',
  '',
  '你的任务**只有一件**：把用户给出的这些并列分支，按**业务功能**重新分成几组。',
  '',
  '硬规则：',
  '1. **按功能分，不按目录分**。分组名要能回答"这块要做什么"（如「体检业务办理」「移动端」「基础技术底座」），',
  '   **不要**用目录名/技术分层名（`PEIS.Web`、`Modules`、`Controllers`、`Common`、`Utils` 都不许当组名）。',
  '2. **每个分支必须且只能被分到一个组**。不许漏、不许重复。',
  `3. 组数 ${MIN_REGROUP_GROUPS}–${MAX_REGROUP_GROUPS} 组。`,
  '4. **每组至少 2 个分支** —— 只含 1 个分支的"组"只是在中间白加一层，不许产生。',
  '5. 组名不许与项目名相同或近似（项目名只该是根）。',
  '6. 拿不准就把那个分支**单独留一组**也行——但那样它就不会被搬动，宁可少动也不要乱动。',
  '',
  '输出格式（**只有**一个 JSON 对象，第一个字符 `{`，最后一个 `}`，不要代码围栏、不要解释）：',
  '{',
  '  "summary": "一句话说明这次怎么归拢的",',
  '  "groups": [',
  '    { "name": "组名", "description": "这块要做什么（20-60 字）", "branchIds": ["分支id", "分支id"] }',
  '  ]',
  '}',
].join('\n');

/** 渲染发给模型的用户消息。 */
export function buildRegroupPrompt(input: {
  projectName: string;
  branches: readonly RegroupBranch[];
}): string {
  const lines: string[] = [];
  lines.push(`项目名：${input.projectName}`);
  lines.push('');
  lines.push(
    `下面是项目根下的 **${input.branches.length} 个并列分支**（它们来自分批建树，` +
      '原先按仓库目录切开，所以名字和层级可能带目录影子）。',
  );
  lines.push('请按**业务功能**把它们分成几组：');
  lines.push('');
  for (const branch of input.branches) {
    lines.push(`- id=${branch.id}  「${branch.name}」  子节点 ${branch.childCount} 个`);
    if (branch.description !== undefined && branch.description.trim() !== '') {
      lines.push(`    描述：${branch.description.trim().slice(0, 120)}`);
    }
    if (branch.refs.length > 0) {
      lines.push(`    涉及：${branch.refs.slice(0, 5).join('、')}`);
    }
  }
  lines.push('');
  lines.push('只输出那一个 JSON 对象。`branchIds` 里只能用上面出现过的 id，一处不漏、一处不重。');
  return lines.join('\n');
}

/** 从模型输出里抠出 JSON 对象（容忍代码围栏与前后废话）。 */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 解析模型输出。**只做结构解析，不做业务校验**（校验在 {@link validateRegroupPlan}）。
 */
export function parseRegroupPlan(text: string): { groups: RegroupGroup[]; summary?: string; rejected: string[] } {
  const rejected: string[] = [];
  const json = extractJsonObject(text);
  if (json === undefined || typeof json !== 'object' || json === null) {
    return { groups: [], rejected: ['输出不是可解析的 JSON 对象'] };
  }
  const record = json as Record<string, unknown>;
  const rawGroups = record['groups'];
  if (!Array.isArray(rawGroups)) {
    return { groups: [], rejected: ['缺少 groups 数组'] };
  }
  const groups: RegroupGroup[] = [];
  for (const [index, raw] of rawGroups.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      rejected.push(`第 ${index + 1} 组不是对象`);
      continue;
    }
    const group = raw as Record<string, unknown>;
    const name = typeof group['name'] === 'string' ? group['name'].trim() : '';
    if (name === '') {
      rejected.push(`第 ${index + 1} 组缺少 name`);
      continue;
    }
    const ids = Array.isArray(group['branchIds'])
      ? group['branchIds'].filter((id): id is string => typeof id === 'string').map((id) => id.trim())
      : [];
    if (ids.length === 0) {
      rejected.push(`「${name}」没有 branchIds`);
      continue;
    }
    const description = typeof group['description'] === 'string' ? group['description'].trim() : undefined;
    groups.push({
      name,
      ...(description !== undefined && description !== '' ? { description } : {}),
      branchIds: ids,
    });
  }
  const summary = typeof record['summary'] === 'string' ? record['summary'].trim() : undefined;
  return { groups, ...(summary !== undefined && summary !== '' ? { summary } : {}), rejected };
}

/** 取名字核心串（去括号注释/空白/分隔符），用于"必须由项目名独立"这类判断。 */
function coreOf(name: string): string {
  return name
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[\s·・\-—_/\\]+/g, '')
    .trim();
}

/**
 * **校验并规整**模型给的分组方案。任一条不满足 ⇒ 整份作废（见文件头纪律）。
 */
export function validateRegroupPlan(
  groups: readonly RegroupGroup[],
  branches: readonly RegroupBranch[],
  projectName: string,
): RegroupProposal {
  const rejected: string[] = [];
  if (groups.length < MIN_REGROUP_GROUPS) {
    return { ok: false, reason: `只给了 ${groups.length} 组（至少 ${MIN_REGROUP_GROUPS} 组）`, rejected };
  }
  if (groups.length > MAX_REGROUP_GROUPS) {
    return { ok: false, reason: `给了 ${groups.length} 组（最多 ${MAX_REGROUP_GROUPS} 组）`, rejected };
  }

  const known = new Map(branches.map((branch) => [branch.id, branch]));
  const seen = new Map<string, string>();
  const projectCore = coreOf(projectName);
  const groupNames = new Set<string>();

  for (const group of groups) {
    const trimmed = group.name.trim();
    /** 纪律 4：组名不许与项目名同源（核心串互相包含就算同名）。 */
    const groupCore = coreOf(trimmed);
    if (
      projectCore.length >= 4 &&
      groupCore.length >= 4 &&
      (groupCore.includes(projectCore) || projectCore.includes(groupCore))
    ) {
      return { ok: false, reason: `组名「${trimmed}」与项目名「${projectName}」重复（项目名只该是根）`, rejected };
    }
    /** 纪律 5：组名不许互相重复。 */
    if (groupNames.has(groupCore)) {
      return { ok: false, reason: `组名「${trimmed}」重复出现`, rejected };
    }
    groupNames.add(groupCore);
    /** 纪律 3：每组至少 2 个分支。 */
    if (group.branchIds.length < 2) {
      return {
        ok: false,
        reason: `「${trimmed}」只有 ${group.branchIds.length} 个分支（每组建至少要 2 个，否则只是白加一层）`,
        rejected,
      };
    }
    for (const id of group.branchIds) {
      const branch = known.get(id);
      if (branch === undefined) {
        return { ok: false, reason: `分支 id「${id}」不在待归拢列表里`, rejected };
      }
      /** 纪律 1：一个分支只能进一个组。 */
      const already = seen.get(id);
      if (already !== undefined) {
        return { ok: false, reason: `分支「${branch.name}」同时被分进「${already}」和「${trimmed}」`, rejected };
      }
      seen.set(id, trimmed);
    }
  }

  /**
   * 纪律 1 的另一半：**没被分配的 branch 怎么办**。
   *
   * 它们**保持原位**（不搬），这是安全的默认 —— 而不是"必须全部覆盖"。
   * 为什么：模型漏掉一个分支时，整份方案作废会白烧一次调用；
   * 而"漏掉的那个留在根下"不会丢内容、也不会造出错误的父子关系。
   * 但**要如实告诉调用方有多少个没被归拢**。
   */
  const dropped = branches.filter((branch) => !seen.has(branch.id));
  for (const branch of dropped) {
    rejected.push(`「${branch.name}」没有被归进任何组，保持原位`);
  }
  return {
    ok: true,
    plan: {
      groups: groups.map((group) => ({
        name: group.name.trim(),
        ...(group.description !== undefined ? { description: group.description } : {}),
        branchIds: [...group.branchIds],
      })),
    },
  };
}
