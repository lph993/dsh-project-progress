/**
 * **回合收尾时的"候选节点"挑选**（进度自动回写 ②：证据自动发现）。
 *
 * ## 为什么要有这一层
 *
 * 用户的原始质疑（2026-10-11）：
 * 「为什么不能在运行中自动处理进度呢，别人用难道也要手动告诉你需要刷新树了，不太合理吧」
 *
 * 实测现状（本会话自己的现场，不是推测）：32 个叶节点**全部卡在 0.50–0.70**、完成数为 **0**，
 * 整体比例长期冻在 0.649；而模型明明被系统提示词要求「收尾前用 `pm_report` 汇报」，
 * 仍然整轮不回写。原因不是"没有机制"——`boundary.ts` 早就在 `turn-end` 上动树了，
 * 但它只做 `pending → running`，**从不知道"这一回合有没有回写过"**，所以永远推不到收尾。
 *
 * ## 为什么不能让宿主直接算进度
 *
 * `session/prompt.ts` 写明了本项目的前提：宿主只能把 `pending` 推成 `running`
 * （那是**唯一有证据的推断**），**真正的数字只有干活的模型知道**。
 * 所以自动化的着力点只能是「**逼模型汇报**」，不能是「替模型决定汇报什么」——
 * 否则就是在事实源里灌猜测值，正是 `planBoundaryWriteback` 注释里否掉的那条路。
 *
 * ## 本模块做什么
 *
 * 纯函数：拿「本回合变动过的文件」×「该会话绑定的节点」，挑出**有证据该被重新评估**的候选。
 * 判据是"证据"，不是"猜测"：
 * 1. 节点声明了 `refs`（它负责的路径），且其中某条**覆盖**了本回合变动过的文件；
 * 2. 该节点还没做完（`done` / `removed` 排除）。
 *
 * 只输出**候选清单**，不含任何进度数字 —— 数字由模型看了提醒之后自己给。
 */

import { normalizeRefPath } from '../domain/identity.ts';
import type { Ref } from '../shared/types.ts';

/** 挑候选需要知道的最小事实（与 `BoundNode` 兼容，但只需这几项，便于单测直接构造）。 */
export interface CandidateNode {
  nodeId: string;
  name: string;
  refs?: readonly Ref[] | undefined;
  /** 已完成/已删除的节点不该再被推着走。 */
  done: boolean;
}

/** 一个候选：节点 + 命中它的变动文件（命中理由是"看得见"的，便于提醒里说清）。 */
export interface ReportCandidate {
  nodeId: string;
  name: string;
  /** 命中该节点的变动文件（已归一化，去重，最多 `MAX_HITS_PER_CANDIDATE` 条）。 */
  hits: string[];
  /** 命中总数（`hits` 被裁过时用来说明"还有多少"）。 */
  hitTotal: number;
}

/** 每个候选最多列几个命中文件（提醒是极简口径，列满就截断并说明）。 */
export const MAX_HITS_PER_CANDIDATE = 4;

/** 一条 ref 是否覆盖某个变动路径。 */
export function refCoversPath(ref: string, path: string): boolean {
  const dir = normalizeRefPath(ref);
  const file = normalizeRefPath(path);
  if (dir === '' || file === '') return false;
  if (file === dir) return true;
  return file.startsWith(`${dir}/`);
}

/**
 * 挑出"本回合有证据该被重新评估"的候选节点。
 *
 * 排序**必须确定**（同一输入 → 同一输出）：命中数多的优先，其次按 `nodeId`。
 * 理由与 `prompt.ts` 的动态事实一致 —— 输出顺序飘会让 diff 与缓存全是噪声。
 *
 * @param changedPaths 本回合变动过的工作区相对路径（可为任意分隔符，内部归一化）
 * @param nodes        该会话绑定的节点
 */
export function pickReportCandidates(
  changedPaths: readonly string[],
  nodes: readonly CandidateNode[],
): ReportCandidate[] {
  const changed = [...new Set(changedPaths.map(normalizeRefPath).filter((path) => path !== ''))];
  if (changed.length === 0) return [];

  const out: ReportCandidate[] = [];
  for (const node of nodes) {
    if (node.done) continue;
    const refs = (node.refs ?? []).map((ref) => ref.target);
    if (refs.length === 0) continue; // 没有引用的抽象节点无从判断，不猜
    const hits = changed.filter((path) => refs.some((ref) => refCoversPath(ref, path)));
    if (hits.length === 0) continue;
    out.push({
      nodeId: node.nodeId,
      name: node.name,
      hits: hits.slice(0, MAX_HITS_PER_CANDIDATE),
      hitTotal: hits.length,
    });
  }

  return out.sort((a, b) => b.hitTotal - a.hitTotal || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
}

/**
 * **落在树盲区**的变动文件：改了、但没有任何节点声明负责它。
 *
 * 为什么这条值得单独算：它回答的是**另一个问题** —— 不是"某个节点该更新了"，
 * 而是"**这段活树上根本没有节点**"。用户的原始质疑正是从这里来的：
 * 「这些是你刚加的，为什么需要我提醒你才行，插件却没起作用」——
 * 我做完一个功能、提交了、推送了，树上却没有它的落点，而这**本该被自动发现**。
 *
 * 判据完全靠事实：文件确实变了（宿主看得见）、它不在任何节点的 refs 里（树里读得到）。
 * 不含任何推测，也不产生数字。
 *
 * @param changedPaths 本回合变动过的工作区相对路径
 * @param nodes        该项目**全部**节点（不是某个会话订阅的那些）
 */
export function uncoveredPaths(
  changedPaths: readonly string[],
  nodes: readonly CandidateNode[],
): string[] {
  const changed = [...new Set(changedPaths.map(normalizeRefPath).filter((path) => path !== ''))];
  if (changed.length === 0) return [];
  const refs: string[] = [];
  for (const node of nodes) {
    if (node.done) continue;
    for (const ref of node.refs ?? []) refs.push(ref.target);
  }
  return changed.filter((path) => !refs.some((ref) => refCoversPath(ref, path)));
}

/** 每个"盲区"提醒最多列几个文件。 */
export const MAX_BLIND_SPOT_HITS = 6;

/**
 * 盲区提醒文本：改动落在树的覆盖范围之外 ⇒ 建议建节点。
 *
 * 口径与 `reportNudgeText` 一致（说清事实、给出工具、不许编数字），但**诉求不同**：
 * 前者是"更新已有节点"，这条是"树上缺节点"。两者可以同时出现，互不替代。
 */
export function blindSpotText(paths: readonly string[], limit = MAX_BLIND_SPOT_HITS): string | undefined {
  const clean = [...new Set(paths.map(normalizeRefPath).filter((path) => path !== ''))];
  if (clean.length === 0) return undefined;
  const shown = clean.slice(0, limit);
  const rest = clean.length - shown.length;
  const tail = rest > 0 ? ` 等 ${clean.length} 个文件` : '';
  return (
    `[pm] 本回合改动的这些文件**不属于任何已有节点**：${shown.join('、')}${tail}。` +
    '说明这段活树上没有落点 —— 如果没有对应节点，请用 pm_add 建一个（放在合适的枝下，' +
    '并把 refs 指向这些路径），别让进度靠人记得。'
  );
}

/**
 * 候选清单的单行提醒文本（沿用 `boundaryReminderText` 的极简口径）。
 *
 * 说清四件事：**哪些节点**有变动、**变了哪些文件**（证据）、**用什么工具**、**数字谁给**。
 * 最后一句是刻意的：不写数字、也不许模型编数字。
 */
export function reportNudgeText(candidates: readonly ReportCandidate[], limit = 8): string | undefined {
  if (candidates.length === 0) return undefined;
  const shown = candidates.slice(0, limit);
  const parts = shown.map((candidate) => {
    const more = candidate.hitTotal > candidate.hits.length ? ` 等 ${candidate.hitTotal} 个文件` : '';
    return `${candidate.name}（${candidate.hits.join('、')}${more}）`;
  });
  const rest = candidates.length - shown.length;
  const tail = rest > 0 ? `；另有 ${rest} 个节点本回合也有文件变动` : '';
  return (
    `[pm] 本回合有文件变动，但还没汇报进度。按引用关系可能是这些节点：${parts.join('；')}${tail}。` +
    '请用 pm_report 汇报实际进度（做完的 finish=true）；没有依据的数字不要写。'
  );
}
