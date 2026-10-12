/**
 * **refs 指向的路径到底存不存在**（0.3.2 新增）。
 *
 * ## 为什么要有这条检查
 *
 * 建树纪律里反复写的是"每个节点的 `refs` 要指向真实路径"，但工具侧**从不检查存在性**：
 * 逃逸校验有（`C7`：不许写出工作区），存在性校验没有 —— 不存在的相对路径被**静默接受**。
 * 真机后果（使用报告 §5.6 第 9 条原文）：
 *
 * - 误把 `watchTargets` 里的 `.pm` 当成真实路径写进 `refs`，工具照单全收；
 * - 库里长期留着 `miniapp/components`、`miniapp/services` 两条指向**不存在目录**的引用
 *   （旧模板树的遗留），而它们照样参与身份键 `identityKeyOf` 的计算。
 *
 * ## 为什么是 warn 而不是拒绝
 *
 * 存在性**不是权威判据**，不能拿它拦写入：
 * - 路径可能"先声明后创建"（先建节点占位、下一步再写代码），这在多会话/子代理并行时是正常的；
 * - 分支切换、目录改名会让一条**曾经正确**的引用暂时消失，此时拒绝写入等于让人无法修树；
 * - 只读挂载 / 权限异常也会让 `existsSync` 返回 false，那与"路径写错"是两回事。
 *
 * 所以口径是：**接受写入，但如实报出来**（`debugBus.warn` + 工具返回值里的 `missingRefTargets`），
 * 把"静默接受"改成"接受并留痕"。判据落在**工作区相对路径**上（绝对路径逃逸由 `C7` 先拦）。
 */

import type { Ref } from '../shared/types.ts';

/** 一条"refs 指向的路径不存在"的实测记录（进告警与工具返回值）。 */
export interface MissingRefTarget {
  /** 归一化后的工作区相对路径。 */
  target: string;
  /** `dir` / `code` —— 由 `refsFromPaths` 判定的类型（含 `.` 视为文件）。 */
  type: Ref['type'];
}

/**
 * 挑出**指向不存在路径**的 refs（纯函数：文件系统访问由调用方以 `pathExists` 注入）。
 *
 * 为什么把 `pathExists` 做成参数而不是在这里 `import { existsSync }`：
 * 这条判据是**纯逻辑**（哪些 ref 该被报出来、怎么排序），值得单测；
 * 而单测不该去建真实目录。注入之后，测试直接喂一个"哪些路径存在"的集合即可。
 *
 * 规则：
 * - 只查 `dir` / `code` 两类（`note` / `md` / `artifact` 由 AI 建树产出，不在本次范围）；
 * - 空路径跳过（`refsFromPaths` 已经过滤过，这里再兜一次，避免把 `''` 报成"缺失"）；
 * - 去重后按路径排序输出 —— 顺序稳定，便于比对与贴进报告。
 *
 * @param refs - 归一化后的引用（`refsFromPaths` 的产物）。
 * @param pathExists - 判某条**工作区相对路径**是否存在。
 * @returns 不存在的引用（可能为空数组）。
 */
export function missingRefTargets(
  refs: readonly Ref[],
  pathExists: (target: string) => boolean,
): MissingRefTarget[] {
  const missing = new Map<string, MissingRefTarget>();
  for (const ref of refs) {
    if (ref.type !== 'dir' && ref.type !== 'code') continue;
    const target = ref.target.trim();
    if (target === '') continue;
    if (pathExists(target)) continue;
    if (missing.has(target)) continue;
    missing.set(target, { target, type: ref.type });
  }
  return [...missing.values()].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
}

/**
 * 把缺失清单渲染成**一句能贴进诊断/返回值的话**（没有缺失时返回空串）。
 *
 * 单独成函数是为了让"文案只有一处"：诊断记录与工具返回值必须说同一件事，
 * 各写一遍迟早漂成两种说法（本项目在别处已经吃过这个亏）。
 *
 * @param missing - {@link missingRefTargets} 的结果。
 * @param limit - 最多列几条（默认 5），其余折叠成"等 N 条"。
 */
export function describeMissingRefTargets(missing: readonly MissingRefTarget[], limit = 5): string {
  if (missing.length === 0) return '';
  const shown = missing.slice(0, limit).map((entry) => entry.target);
  const rest = missing.length - shown.length;
  return `${shown.join('、')}${rest > 0 ? ` 等 ${missing.length} 条` : ''}`;
}
