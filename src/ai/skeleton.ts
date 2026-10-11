/**
 * 采集"给模型看的仓库骨架"（阶段 A 的合法产物，§9.5 T4/T8）。
 *
 * 三条纪律：
 * 1. **不读整文件**：只有关键文件读一小段（`MAX_SIGNATURE_BYTES`）做签名；
 * 2. **不为了估成本读盘**：条目数与字节数都来自已有的遍历结果；
 * 3. **如实标注截断**：深度/数量上限命中时把 `truncated` 与 `skipped` 带出去。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isKeyFileName } from '../domain/scanner.ts';
import type { SkeletonEntry } from './prompt.ts';

/** 单个关键文件最多读多少字节做签名（"只读入口文件"这一级的硬上限）。 */
export const MAX_SIGNATURE_BYTES = 4 * 1024;

/** 最多给几个关键文件做签名（再多收益递减、成本线性上升）。 */
export const MAX_SIGNATURE_FILES = 12;

export interface SkeletonInput {
  root: string;
  entries: ReadonlyArray<{
    path: string;
    kind: 'file' | 'dir';
    sizeBytes?: number;
    /** 修改时间（遍历时同一次 stat 拿到的；增量判定用）。 */
    mtimeMs?: number;
  }>;
  maxEntries?: number;
  /**
   * 只用于统计"目录的直接子文件数"的完整遍历结果。
   *
   * 分批路径必须传它：每片只拿到自己那部分条目，若按片统计，提示词里
   * `目录 (N 个文件)` 会变成"这一片里的文件数"，比真实值小、会误导模型。
   */
  countSource?: ReadonlyArray<{ path: string; kind: 'file' | 'dir' }>;
}

export interface SkeletonResult {
  skeleton: SkeletonEntry[];
  signatureBytes: number;
  truncated: boolean;
  /** 关键文件签名读取失败的路径（如实记录，不假装读过）。 */
  unreadable: string[];
  /** 各顶层目录"总共多少 / 进了多少"（如实报告，供上层警示）。 */
  coverage: SkeletonCoverage[];
  /**
   * **有内容、但一条都没进骨架**的顶层目录。
   *
   * 为什么必须带出来：骨架被截断时，这些区域对模型**根本不存在** ——
   * 建出来的树上当然不会有它们。不报出来的话，用户看到的是"树里没有 server/"，
   * 只能猜是模型判断错了（真机现场就是这么误判的）。
   */
  droppedTops: string[];
}

export interface SkeletonCoverage {
  /** 顶层目录名（`(根)` 表示工作区根下的直接条目）。 */
  top: string;
  total: number;
  kept: number;
}

/** 一条路径属于哪个顶层目录（用于公平分配与覆盖率报告）。 */
function topOf(path: string): string {
  const slash = path.indexOf('/');
  return slash < 0 ? '(根)' : path.slice(0, slash);
}

/**
 * 按**顶层目录**公平分配预算。
 *
 * ## 为什么不能直接 `slice(0, maxEntries)`
 *
 * 真机现场（AIG 工作区，2026-10-11）：`aitest` 有 2.3 万个文件、`nrfunc` 有 242 个目录 ——
 * 按"谁先被走到谁吃满"切前 400 条，这两个子树就吃掉了 **92%** 的预算，于是
 * `server/`（7 个 crate 的服务端）、`docs/`（立项与里程碑文档）、`prototypes/` 等
 * **6 个顶层目录一条都没进模型**；建出来的树上自然一个节点都没有它们。
 * 那不是模型判断"这些不重要"，是它**根本看不到**。
 *
 * ## 口径
 *
 * ① 先给每个顶层**保底** `floor(预算 / 顶层数)`，谁也饿不死；
 * ② 剩余预算**轮转**分给还有余量的顶层 —— 刻意**不按体量比例**：体量大的已经靠"条目多"
 *    占过便宜了，再按比例分会重新变成一家独大；
 * ③ 组内保持原有顺序（遍历顺序即优先级），输出按顶层名排序，结果**可复现**（缓存键可信）。
 */
export function allocateFairly<T extends { path: string }>(
  items: readonly T[],
  budget: number,
): { picked: T[]; coverage: SkeletonCoverage[] } {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = topOf(item.path);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [item]);
    else list.push(item);
  }
  const names = [...groups.keys()].sort();
  const perGroup = Math.max(1, Math.floor(budget / Math.max(1, names.length)));
  const taken = new Map<string, number>();
  const picked: T[] = [];

  // ① 保底：每个顶层先拿 min(保底额, 它自己的条目数, 剩余预算)
  for (const name of names) {
    const list = groups.get(name) as T[];
    const take = Math.max(0, Math.min(perGroup, list.length, budget - picked.length));
    for (let index = 0; index < take; index += 1) picked.push(list[index] as T);
    taken.set(name, take);
  }
  // ② 轮转填满剩余预算
  let progressed = true;
  while (picked.length < budget && progressed) {
    progressed = false;
    for (const name of names) {
      if (picked.length >= budget) break;
      const list = groups.get(name) as T[];
      const already = taken.get(name) ?? 0;
      if (already >= list.length) continue;
      picked.push(list[already] as T);
      taken.set(name, already + 1);
      progressed = true;
    }
  }

  const coverage = names.map((name) => ({
    top: name,
    total: (groups.get(name) as T[]).length,
    kept: taken.get(name) ?? 0,
  }));
  return { picked, coverage };
}

/** 单次骨架的条目上限（目录、文件各自一份预算）。分批路径**每片各用一份**。 */
export const DEFAULT_MAX_SKELETON_ENTRIES = 400;

/** 采集骨架：目录 + 关键文件（含签名）。 */
export async function collectSkeleton(input: SkeletonInput): Promise<SkeletonResult> {
  const maxEntries = input.maxEntries ?? DEFAULT_MAX_SKELETON_ENTRIES;
  const dirs = input.entries.filter((entry) => entry.kind === 'dir');
  const files = input.entries.filter((entry) => entry.kind === 'file');

  // 目录的直接子文件数（只数元数据，不读内容）；分批路径按**完整**遍历结果统计
  const fileCountByDir = new Map<string, number>();
  for (const file of (input.countSource ?? input.entries).filter((entry) => entry.kind === 'file')) {
    const parent = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
    fileCountByDir.set(parent, (fileCountByDir.get(parent) ?? 0) + 1);
  }

  // 目录与文件**各自**按顶层公平分配（两者预算独立，与原来的 slice 口径一致）
  const dirAlloc = allocateFairly(dirs, maxEntries);
  const fileAlloc = allocateFairly(files, maxEntries);

  const skeleton: SkeletonEntry[] = [];
  for (const dir of dirAlloc.picked) {
    skeleton.push({
      path: dir.path,
      kind: 'dir',
      fileCount: fileCountByDir.get(dir.path) ?? 0,
    });
  }
  for (const file of fileAlloc.picked) {
    skeleton.push({
      path: file.path,
      kind: 'file',
      ...(file.sizeBytes !== undefined ? { sizeBytes: file.sizeBytes } : {}),
      // 带上修改时间：AI 缓存判增量用（只有 size 会漏掉同尺寸改动，见 `ai/cache.ts`）
      ...(file.mtimeMs !== undefined ? { mtimeMs: file.mtimeMs } : {}),
    });
  }

  // 关键文件签名：只读前 MAX_SIGNATURE_BYTES 字节
  const keyFiles = files
    .filter((file) => isKeyFileName(file.path.split('/').pop() ?? file.path))
    .slice(0, MAX_SIGNATURE_FILES);
  let signatureBytes = 0;
  const unreadable: string[] = [];
  for (const file of keyFiles) {
    try {
      const text = await readFile(join(input.root, file.path), 'utf8');
      const signature = text.slice(0, MAX_SIGNATURE_BYTES);
      signatureBytes += Buffer.byteLength(signature, 'utf8');
      const entry = skeleton.find(
        (item) => item.kind === 'file' && item.path === file.path,
      );
      if (entry) {
        entry.keyFile = true;
        entry.signature = signature;
      }
    } catch {
      unreadable.push(file.path);
    }
  }

  // 覆盖率按顶层合并（目录 + 文件一起看，才是"这个区域有没有进模型"）
  const merged = new Map<string, SkeletonCoverage>();
  for (const row of [...dirAlloc.coverage, ...fileAlloc.coverage]) {
    const current = merged.get(row.top) ?? { top: row.top, total: 0, kept: 0 };
    merged.set(row.top, {
      top: row.top,
      total: current.total + row.total,
      kept: current.kept + row.kept,
    });
  }
  const coverage = [...merged.values()].sort((a, b) => a.top.localeCompare(b.top));
  const droppedTops = coverage.filter((row) => row.total > 0 && row.kept === 0).map((row) => row.top);
  const truncated = dirAlloc.picked.length < dirs.length || fileAlloc.picked.length < files.length;

  return { skeleton, signatureBytes, truncated, unreadable, coverage, droppedTops };
}
