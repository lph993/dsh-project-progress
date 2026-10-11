/**
 * 骨架采集的两个契约（2026-10-11 补）。
 *
 * ① **预算按顶层目录公平分配** —— 不许出现"某个巨子树吃满预算、别的顶层一条都进不去"。
 * ② 截断时**如实带出** `coverage` 与 `droppedTops` —— 不然用户只能猜"树里为什么没有 server/"。
 *
 * ## 现场（AIG 工作区，2026-10-11）
 *
 * 800 条骨架里 `aitest` 493 + `nrfunc` 242（**92%**），而 `server`（7 个 crate）、`docs`
 * （立项与里程碑）、`prototypes`、`review`、`scripts`、`uper` **一条都没进模型** ——
 * 建出来的树上自然没有它们。那不是模型判断"这些不重要"，是它**根本看不到**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { allocateFairly, collectSkeleton } from '../../src/ai/skeleton.ts';

const dir = (path: string): { path: string; kind: 'dir' } => ({ path, kind: 'dir' });

test('公平分配：巨子树不许把别的顶层挤没', () => {
  const items = [
    ...Array.from({ length: 5000 }, (_, i) => dir(`aitest/f${i}`)),
    ...Array.from({ length: 242 }, (_, i) => dir(`nrfunc/f${i}`)),
    dir('server/crates'),
    dir('docs/立项.md'),
    dir('prototypes/x'),
  ];
  const { picked, coverage } = allocateFairly(items, 400);
  assert.equal(picked.length, 400, '必须刚好用完预算');

  const kept = new Map(coverage.map((row) => [row.top, row.kept]));
  for (const name of ['aitest', 'nrfunc', 'server', 'docs', 'prototypes']) {
    assert.ok((kept.get(name) ?? 0) > 0, `${name} 必须至少进一条（旧实现里它可能一条都进不去）`);
  }
  assert.ok(
    (kept.get('aitest') ?? 0) <= 200,
    `巨子树不许独占：aitest 最多拿一半，实际 ${kept.get('aitest')}`,
  );
});

test('公平分配：结果可复现（AI 缓存键要可信）', () => {
  const items = [dir('b/x'), dir('a/y'), dir('a/z'), dir('c/w')];
  const one = allocateFairly(items, 3).picked.map((item) => item.path);
  const two = allocateFairly(items, 3).picked.map((item) => item.path);
  assert.deepEqual(one, two);
});

test('collectSkeleton：保底让"条目少但有内容"的顶层不被丢掉', async () => {
  const entries = [
    ...Array.from({ length: 900 }, (_, i) => ({ path: `big/f${i}`, kind: 'file' as const })),
    { path: 'server/main.rs', kind: 'file' as const },
  ];
  const result = await collectSkeleton({ root: '.', entries, maxEntries: 10 });
  assert.equal(result.truncated, true);

  const kept = new Map(result.coverage.map((row) => [row.top, row.kept]));
  assert.equal(kept.get('server'), 1, `server 只有 1 条，必须保住：${JSON.stringify(result.coverage)}`);
  assert.equal(kept.get('big'), 9, '剩余预算才轮到巨子树');
  assert.deepEqual(result.droppedTops, [], '这次没有顶层被丢掉');
});

test('collectSkeleton：预算不够分时，如实报出哪些顶层一条都没进', async () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({
    path: `t${String(i).padStart(2, '0')}/x.rs`,
    kind: 'file' as const,
  }));
  const result = await collectSkeleton({ root: '.', entries, maxEntries: 5 });
  assert.equal(result.truncated, true);
  assert.equal(result.droppedTops.length, 15, JSON.stringify(result.coverage));
  assert.deepEqual(result.droppedTops.slice(0, 3), ['t05', 't06', 't07'], '从后往前缺，顺序稳定');
});

test('collectSkeleton：分批时目录的"N 个文件"按完整遍历统计（不按片各算一份）', async () => {
  const full = [
    { path: 'aitest/models', kind: 'dir' as const },
    { path: 'aitest/models/a.bin', kind: 'file' as const },
    { path: 'aitest/models/b.bin', kind: 'file' as const },
    { path: 'aitest/models/c.bin', kind: 'file' as const },
    { path: 'aitest/py/x.py', kind: 'file' as const },
  ];
  // 这一片只拿到"目录 + py 里那个文件"，但目录计数要看**完整**结果，
  // 否则提示词里会写成"aitest/models (0 个文件)"，把数说小、误导模型。
  const shard = await collectSkeleton({
    root: '.',
    entries: [full[0]!, full[4]!],
    countSource: full,
  });
  const dir = shard.skeleton.find((entry) => entry.kind === 'dir' && entry.path === 'aitest/models');
  assert.equal(dir?.fileCount, 3, `目录计数要按完整结果：${JSON.stringify(dir)}`);
});
