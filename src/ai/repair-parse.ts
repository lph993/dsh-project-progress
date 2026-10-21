/**
 * **解析并校验 AI 的修复方案**（0.3.21）。
 *
 * ## 这一层的职责只有两件：**不许编**、**不许越界**
 *
 * 模型给的 JSON 不能直接进执行路径。本文件做两道闸：
 *
 * 1. **id 白名单**：动作里出现的每个 id 必须在"我发给它的那份清单"里 ——
 *    模型编一个不存在的 nodeId，动作当场作废（并如实记进 `rejected`，不静默丢）；
 * 2. **动作集封闭**：`kind` 只许取 `REPAIR_ACTION_KINDS`；每种动作必填字段缺失即作废。
 *
 * ## 为什么作废要"记下来"而不是丢掉
 *
 * 用户要看到"AI 提了什么、其中哪些没被采纳、为什么"。静默丢弃会让面板看起来"AI 什么都没提"，
 * 而实际上它提了、只是不可执行 —— 那是两种完全不同的结论（一个是"树没问题"，
 * 一个是"AI 在编"），必须能分辨。
 *
 * ## 破坏性动作的定位
 *
 * 解析出来的动作**只是提议**。`delete` / `merge` 这类照旧要走既有的确认通道
 * （用户明确要求保留"动功能点要审批"）。本层不执行任何东西。
 */
import { REPAIR_ACTION_KINDS } from './repair.ts';

/** 一条被采纳的动作。 */
export type RepairAction =
  | { kind: 'merge'; nodeId: string; intoNodeId: string; reason: string }
  | { kind: 'move'; nodeId: string; toParentId: string; reason: string }
  | { kind: 'rename'; nodeId: string; newName: string; reason: string }
  | { kind: 'describe'; nodeId: string; newDescription: string; reason: string }
  | { kind: 'split'; nodeId: string; suggestedChildren: string[]; reason: string }
  | { kind: 'delete'; nodeId: string; reason: string };

export interface RepairParseResult {
  /** 一句话总述（模型给的；缺失时给空串，不编）。 */
  summary: string;
  actions: RepairAction[];
  /** 模型自己说拿不准的（原样保留，供人判断）。 */
  uncertain: Array<{ nodeIds: string[]; question: string }>;
  /** **被拒的动作**（id 不在白名单 / 字段缺失 / kind 非法）—— 如实回告，不静默丢。 */
  rejected: Array<{ reason: string; raw: unknown }>;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/** 从模型输出里抠出 JSON（容忍它套了 markdown 围栏或前后有闲话）。 */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(withoutFence);
  } catch {
    // 退路：取第一个 { 到最后一个 } 之间的内容（模型可能前后写了话）
    const start = withoutFence.indexOf('{');
    const end = withoutFence.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(withoutFence.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

/**
 * 解析模型输出。
 *
 * @param text - 模型的原始文本（可能带围栏/闲话）。
 * @param knownIds - **白名单**：我发给它的那份节点 id 清单。
 */
export function parseRepairPlan(text: string, knownIds: readonly string[]): RepairParseResult {
  const result: RepairParseResult = { summary: '', actions: [], uncertain: [], rejected: [] };
  const parsed = extractJsonObject(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    result.rejected.push({ reason: '模型输出不是 JSON 对象', raw: text.slice(0, 400) });
    return result;
  }
  const obj = parsed as Record<string, unknown>;
  result.summary = isNonEmptyString(obj['summary']) ? obj['summary'] : '';

  const known = new Set(knownIds);
  /**
   * **id 归一**（0.3.59，子代理审查发现）。
   *
   * 提示词把节点渲染成 `- 名字 [#pm_xxx]` 并明写「`#id` 是动作里必须原样引用的 id」，
   * 但这里原来只收**裸 id** —— 模型照提示词写成 `"#pm_xxx"`（或 `"[#pm_xxx]"`）时，
   * 全部动作会以「nodeId 不在清单里（不许编）」被拒 ⇒ 面板说"AI 提了但都在编"，
   * 而真相是**我们的提示词和解析器各说各话**。修复方案只有这一个执行入口，
   * 一条都过不去时整个功能等于失效。
   *
   * 只剥**包装**（`#`、`[` `]`），不做模糊匹配 —— 真正的编造 id 照样要被拒。
   */
  const stripIdWrapping = (value: string): string =>
    value
      .trim()
      .replace(/^\[/, '')
      .replace(/^#/, '')
      .replace(/\]$/, '')
      .trim();
  const actions = Array.isArray(obj['actions']) ? obj['actions'] : [];
  for (const raw of actions) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      result.rejected.push({ reason: '动作不是对象', raw });
      continue;
    }
    const action = raw as Record<string, unknown>;
    const kind = action['kind'];
    if (typeof kind !== 'string' || !(REPAIR_ACTION_KINDS as readonly string[]).includes(kind)) {
      result.rejected.push({ reason: `非法的动作类型：${String(kind)}`, raw });
      continue;
    }
    const rawNodeId = action['nodeId'];
    const nodeId = isNonEmptyString(rawNodeId) ? stripIdWrapping(rawNodeId) : rawNodeId;
    if (!isNonEmptyString(nodeId) || !known.has(nodeId)) {
      result.rejected.push({ reason: `nodeId 不在清单里（不许编）：${String(rawNodeId)}`, raw });
      continue;
    }
    const reason = isNonEmptyString(action['reason']) ? action['reason'] : '(模型未给理由)';
    if (kind === 'merge') {
      const rawInto = action['intoNodeId'];
      const into = isNonEmptyString(rawInto) ? stripIdWrapping(rawInto) : rawInto;
      if (!isNonEmptyString(into) || !known.has(into)) {
        result.rejected.push({ reason: `merge 的目标不在清单里：${String(rawInto)}`, raw });
        continue;
      }
      if (into === nodeId) {
        result.rejected.push({ reason: 'merge 的目标就是它自己', raw });
        continue;
      }
      result.actions.push({ kind: 'merge', nodeId, intoNodeId: into, reason });
      continue;
    }
    if (kind === 'move') {
      const rawTo = action['toParentId'];
      const to = isNonEmptyString(rawTo) ? stripIdWrapping(rawTo) : rawTo;
      if (!isNonEmptyString(to) || !known.has(to)) {
        result.rejected.push({ reason: `move 的目标父不在清单里：${String(rawTo)}`, raw });
        continue;
      }
      if (to === nodeId) {
        result.rejected.push({ reason: 'move 的目标父就是它自己', raw });
        continue;
      }
      result.actions.push({ kind: 'move', nodeId, toParentId: to, reason });
      continue;
    }
    if (kind === 'rename') {
      const name = action['newName'];
      if (!isNonEmptyString(name)) {
        result.rejected.push({ reason: 'rename 缺 newName', raw });
        continue;
      }
      result.actions.push({ kind: 'rename', nodeId, newName: name.trim(), reason });
      continue;
    }
    if (kind === 'describe') {
      const desc = action['newDescription'];
      if (!isNonEmptyString(desc)) {
        result.rejected.push({ reason: 'describe 缺 newDescription', raw });
        continue;
      }
      result.actions.push({ kind: 'describe', nodeId, newDescription: desc.trim(), reason });
      continue;
    }
    if (kind === 'split') {
      const kids = Array.isArray(action['suggestedChildren'])
        ? action['suggestedChildren'].filter(isNonEmptyString).map((s) => s.trim())
        : [];
      if (kids.length === 0) {
        result.rejected.push({ reason: 'split 没给 suggestedChildren', raw });
        continue;
      }
      result.actions.push({ kind: 'split', nodeId, suggestedChildren: kids, reason });
      continue;
    }
    // delete
    result.actions.push({ kind: 'delete', nodeId, reason });
  }

  const uncertain = Array.isArray(obj['uncertain']) ? obj['uncertain'] : [];
  for (const raw of uncertain) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const ids = Array.isArray(item['nodeIds'])
      ? item['nodeIds'].filter(isNonEmptyString).filter((id) => known.has(id))
      : [];
    const question = isNonEmptyString(item['question']) ? item['question'] : '';
    /**
     * **"拿不准"也必须挂在真实节点上**：一个 `nodeIds` 全是编造 id 的疑问，
     * 在界面上**无从定位**（用户不知道该去看哪），留着只会变成噪声。
     * 所以这种情况**丢掉、但记进 `rejected` 留痕** —— 不能静默消失，
     * 否则"AI 什么都没说"与"AI 说了但都没法定位"这两种结论就分不开了。
     */
    if (ids.length === 0) {
      if (question !== '') {
        result.rejected.push({ reason: `uncertain 的 nodeIds 全都不可定位（编造或为空）：${question}`, raw });
      }
      continue;
    }
    result.uncertain.push({ nodeIds: ids, question });
  }

  return result;
}
