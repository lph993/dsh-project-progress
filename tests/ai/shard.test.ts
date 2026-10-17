/**
 * 分批建树的**分片逻辑**单测（用户口径："由于项目大了可能出现空返回情况，需要分批处理"）。
 *
 * 这一层是纯函数，所以"要不要分、怎么分、会不会丢内容"都能在这里钉死 ——
 * 不必靠"造一个大仓库跑一次真模型"去碰运气。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SHARD_MAX_COUNT,
  SHARD_MAX_FILES,
  SHARD_MAX_GROUPS_PER_SHARD,
  SHARD_THRESHOLD_FILES,
  shardSkeleton,
  shouldShard,
  topDirOf,
  type ShardEntry,
} from '../../src/ai/shard.ts';

const file = (path: string): ShardEntry => ({ path, kind: 'file' });
const dir = (path: string): ShardEntry => ({ path, kind: 'dir' });

test('topDirOf：取顶层目录；根下散文件归到空串', () => {
  assert.equal(topDirOf('src/a/b.ts'), 'src');
  assert.equal(topDirOf('src/a'), 'src');
  assert.equal(topDirOf('README.md'), '');
  assert.equal(topDirOf('./src\\a\\b.ts'), 'src', '反斜杠与 ./ 前缀都要归一');
});

test('shouldShard：只按**文件**数判断（目录本身几乎不占 token）', () => {
  const manyDirs = Array.from({ length: 200 }, (_, i) => dir(`d${i}`));
  assert.equal(shouldShard(manyDirs), false, '200 个目录不该触发分批');
  const fewFiles = Array.from({ length: SHARD_THRESHOLD_FILES }, (_, i) => file(`src/f${i}.ts`));
  assert.equal(shouldShard(fewFiles), false, '刚好到阈值不分');
  assert.equal(shouldShard([...fewFiles, file('src/extra.ts')]), true, '超过阈值要分');
});

test('shardSkeleton：按顶层目录分片，同目录的文件留在同一片', () => {
  const entries: ShardEntry[] = [
    dir('src'),
    file('src/a.ts'),
    file('src/b.ts'),
    dir('docs'),
    file('docs/a.md'),
    file('README.md'),
  ];
  const shards = shardSkeleton(entries);
  const byRoot = new Map(shards.map((shard) => [shard.rootDir, shard.entries.map((e) => e.path)]));
  assert.deepEqual(byRoot.get('src'), ['src', 'src/a.ts', 'src/b.ts'], 'src 的文件必须聚在一片');
  assert.deepEqual(byRoot.get('docs'), ['docs', 'docs/a.md']);
  // 根下的散文件单独成一片（rootDir 为空串），不能丢
  assert.ok(shards.some((shard) => shard.rootDir === '' && shard.entries.some((e) => e.path === 'README.md')));
});

test('shardSkeleton：**不丢条目** —— 所有输入条目都必须出现在某个片里', () => {
  const entries: ShardEntry[] = [
    dir('src'),
    ...Array.from({ length: 50 }, (_, i) => file(`src/a/f${i}.ts`)),
    ...Array.from({ length: 50 }, (_, i) => file(`src/b/f${i}.ts`)),
    file('README.md'),
  ];
  const shards = shardSkeleton(entries);
  const seen = shards.flatMap((shard) => shard.entries.map((entry) => entry.path));
  assert.equal(seen.length, entries.length, '分片前后条目数必须一致（分批不许悄悄丢内容）');
  for (const entry of entries) assert.ok(seen.includes(entry.path), `${entry.path} 丢了`);
});

test('shardSkeleton：单目录超大 → 按第二级目录再拆（"代码都在 src/ 下"也不至于只有一片）', () => {
  const entries: ShardEntry[] = [
    dir('src'),
    ...Array.from({ length: SHARD_MAX_FILES + 5 }, (_, i) => file(`src/client/f${i}.ts`)),
    ...Array.from({ length: SHARD_MAX_FILES + 5 }, (_, i) => file(`src/server/f${i}.ts`)),
  ];
  const shards = shardSkeleton(entries);
  assert.ok(shards.length >= 2, `超大目录应被拆开，实际 ${shards.length} 片`);
  assert.ok(
    shards.some((shard) => shard.rootDir === 'src/client') && shards.some((shard) => shard.rootDir === 'src/server'),
    '第二级目录要成为分片单位',
  );
});

test('shardSkeleton：只有目录没有文件的组不产出空片', () => {
  const shards = shardSkeleton([dir('empty-dir'), dir('also-empty')]);
  assert.equal(shards.length, 0, '没有文件就没有必要单独问模型（省一次调用）');
});

// ── 片数上限（每次调用都带一份系统提示词，片数越多固定开销越大）──────

test('片数收口：顶层目录很多时并到上限以内，且**一片都不许丢条目**', () => {
  // 10 个顶层目录 × 5 个文件 = 50 个文件（会切出 10 片）
  const entries: ShardEntry[] = [];
  for (let index = 0; index < 10; index += 1) {
    for (let fileIndex = 0; fileIndex < 5; fileIndex += 1) entries.push(file(`top${index}/f${fileIndex}.ts`));
  }
  const shards = shardSkeleton(entries);
  assert.equal(shards.length, SHARD_MAX_COUNT, `片数必须收到上限 ${SHARD_MAX_COUNT}，实际 ${shards.length}`);
  const seen = shards.flatMap((shard) => shard.entries.map((entry) => entry.path));
  assert.equal(seen.length, entries.length, '并片不许丢内容');
  for (const entry of entries) assert.ok(seen.includes(entry.path), `${entry.path} 在并片时丢了`);
  /**
   * 旧断言是"**最后一片**必须标出它合并了多个目录" —— 那是旧策略（前 N-1 片各自一个目录、
   * 其余全并进最后一片）的产物。现在改成**均衡分配**，每一片都可能是多目录，
   * 所以真正的判据是：**凡是合并过的片都必须如实标出**，没合并的片不许瞎标。
   */
  for (const shard of shards) {
    const groups = new Set(shard.entries.map((entry) => entry.path.split('/')[0]));
    if (groups.size > 1) {
      assert.ok(
        shard.rootDir.includes('等'),
        `「${shard.rootDir}」合并了 ${groups.size} 个目录，必须标明（不能假装只有一个目录）`,
      );
    } else {
      assert.ok(!shard.rootDir.includes('等'), `「${shard.rootDir}」只有一个目录，不该标"等 N 个目录"`);
    }
  }
});

test('片数收口：**每片最多 SHARD_MAX_GROUPS_PER_SHARD 个顶层目录**（0.3.45 真机病灶）', () => {
  /**
   * 真机现场：25 个顶层目录、`SHARD_MAX_COUNT = 6`。
   *
   * 旧策略留下 5 片各 1 个目录，**其余 20 个目录全并成一片** —— 模型被要求把 20 个
   * 互不相关的目录组织成一棵树，只能串成链，于是产出 8 层深的管道
   * （从「职业健康业务模块」串到「Blazor 组件库」）。
   *
   * 现在必须是**均衡分配**：片数不合规就多切几片，但每片目录数受控。
   */
  const entries: ShardEntry[] = [];
  for (let index = 0; index < 25; index += 1) entries.push(file(`dir${String(index).padStart(2, '0')}/f.ts`));
  const shards = shardSkeleton(entries);
  for (const shard of shards) {
    const groups = new Set(shard.entries.map((entry) => entry.path.split('/')[0]));
    assert.ok(
      groups.size <= SHARD_MAX_GROUPS_PER_SHARD,
      `每片最多 ${SHARD_MAX_GROUPS_PER_SHARD} 个目录，实际「${shard.rootDir}」有 ${groups.size} 个`,
    );
  }
  /** 片数也要合理：25/6 ⇒ 至少 5 片，且不该爆到 25 片。 */
  assert.ok(shards.length >= 5 && shards.length <= 6, `片数应当在 5~6，实际 ${shards.length}`);
  const seen = shards.flatMap((shard) => shard.entries.map((entry) => entry.path));
  assert.equal(seen.length, entries.length, '**一片都不许丢条目**');
});

test('片数收口：先保大目录 —— 最大的那一片不会被并掉', () => {
  const entries: ShardEntry[] = [
    ...Array.from({ length: 40 }, (_, i) => file(`big/f${i}.ts`)),
    ...Array.from({ length: 2 }, (_, i) => file(`small${i}/f.ts`)),
  ];
  const shards = shardSkeleton(entries, { maxShards: 3 });
  assert.equal(shards.length, 3);
  assert.equal(shards[0]?.rootDir, 'big', '大目录排在前面且不被并');
  assert.equal(shards[0]?.entries.length, 40, '大目录的条目一个不少');
});

test('片数收口：maxShards=1 时退化成一整片（不丢条目）', () => {
  const entries: ShardEntry[] = [file('a/f.ts'), file('b/f.ts'), file('c/f.ts')];
  const shards = shardSkeleton(entries, { maxShards: 1 });
  assert.equal(shards.length, 1);
  assert.equal(shards[0]?.entries.length, 3);
});
