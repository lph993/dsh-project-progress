/**
 * **0.3.50 的三个回归**（真机现场，全部是我造成的）。
 *
 * | 回归 | 真机现象 |
 * |---|---|
 * | 片数按 `⌈子片数/6⌉` 膨胀 | **23 片**、13 分钟、面板 `Failed to fetch` |
 * | `projectName` 被**最后一片**覆盖 | 项目名从「PEIS 体检管理系统」退化成 `"PEIS"` ⇒ 根判定/整形全带偏 |
 * | 各片根名字略有出入就**各建一个** | 树上多出「PEIS 体检信息系统」(14 子) 与「PEIS」(8 子) 两个包装层 |
 *
 * 三条都要有测试 —— 它们能溜过去，正是因为**当时没有测试**。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SHARD_MAX_COUNT, shardSkeleton, type ShardEntry } from '../../src/ai/shard.ts';
import { createFakeContext } from './fake-host.ts';

test('片数**不许因为子片多而膨胀**：31 个目录被切成上百子片，最终仍只有 6 片（0.3.50）', () => {
  /**
   * 真机形状：顶层 31 个目录，但 `Modules` / `Mobile` / `PEIS.Web` 这些大目录
   * 会被 `splitByTopDir` **再按二级目录切开** ⇒ `shards.length ≈ 138`。
   *
   * 我上一版用 `limit = max(6, ⌈138/6⌉) = 23` 去"避免一片混太多目录"，结果**把调用次数放大 4 倍**，
   * 真机 13 分钟、请求被断开。这条测试钉死"片数上限就是 6"。
   */
  const entries: ShardEntry[] = [];
  for (let dir = 0; dir < 31; dir += 1) {
    /** 每个顶层目录下放两个二级目录、各 45 个文件（> SHARD_MAX_FILES=40 ⇒ 会被再切）。 */
    for (const sub of ['a', 'b']) {
      for (let file = 0; file < 45; file += 1) {
        entries.push({ path: `dir${String(dir).padStart(2, '0')}/${sub}/f${file}.ts`, kind: 'file' });
      }
    }
  }
  const shards = shardSkeleton(entries);
  assert.ok(
    shards.length <= SHARD_MAX_COUNT,
    `片数必须受 ${SHARD_MAX_COUNT} 限制（真机曾膨胀到 23），实际 ${shards.length}`,
  );
  /** 一片都不许丢条目 —— 均衡装桶不能漏。 */
  const seen = shards.flatMap((shard) => shard.entries.map((entry) => entry.path));
  assert.equal(seen.length, entries.length, '并片不许丢内容');
});

test('分批：项目名**第一片说了算**，后面的不许覆盖（0.3.50）', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-name-'));
  for (const top of ['one', 'two']) {
    mkdirSync(join(workspace, top), { recursive: true });
    writeFileSync(join(workspace, top, 'main.ts'), 'export const x = 1;\n');
  }
  /** 两个"项目名根"名字同源但不同 —— 真机就是这样（片1 报管理系统、片N 报 PEIS）。 */
  for (const top of ['one', 'two']) {
    mkdirSync(join(workspace, top, 'src'), { recursive: true });
    writeFileSync(join(workspace, top, 'src', 'a.ts'), 'export const a = 1;\n');
  }

  const ctx = createFakeContext({ workspace });
  ctx.services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) });
  ctx.services.set('llm', { stream: () => { throw new Error('用注入的假流'); } });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    aiBuildTree(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    board(): Promise<{ projectName: string; nodes: Array<{ id: string; name: string; parentId: string | null }> }>;
  };
  service.noteWorkspaceRoot(workspace);

  let calls = 0;
  const streamOf = (text: string) =>
    (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: 'stop' };
    })();

  const built = await service.aiBuildTree({
    confirm: true,
    stream: {
      stream: (options: { messages?: unknown[] }) => {
        calls += 1;
        if (calls === 1) return streamOf('');
        const prompt = JSON.stringify(options.messages ?? []);
        const isOne = prompt.includes('one/');
        return streamOf(
          JSON.stringify(
            isOne
              ? {
                  /** 第一片报完整项目名。 */
                  projectName: 'PEIS 体检管理系统',
                  nodes: [
                    { name: 'PEIS 体检管理系统', kind: 'feature', parent: null, description: '本体' },
                    { name: '体检登记', kind: 'feature', parent: 0, description: '登记' },
                  ],
                }
              : {
                  /** 后面这片报个退化名（真机就是这么把项目名带偏的）。 */
                  projectName: 'PEIS',
                  nodes: [
                    { name: 'PEIS 体检信息系统', kind: 'feature', parent: null, description: '同源别名' },
                    { name: '报告打印', kind: 'feature', parent: 0, description: '打印' },
                  ],
                },
          ),
        );
      },
    },
  });
  assert.equal(built['status'], 'ok', `建树应当成功：${JSON.stringify(built).slice(0, 300)}`);

  const board = await service.board();
  assert.equal(
    board.projectName,
    'PEIS 体检管理系统',
    `**项目名必须取更具体（更长）的那个**，不许被短名覆盖（实际「${board.projectName}」）`,
  );

  /** 同源根必须**并到根上**，不许各建一个包装层。 */
  const roots = board.nodes.filter((n) => n.parentId === null);
  assert.equal(roots.length, 1, '只能有一个根');
  assert.equal(roots[0]?.name, 'PEIS 体检管理系统', '根是本体');
  const wrappers = board.nodes.filter(
    (n) => n.parentId !== null && /^PEIS/.test(n.name),
  );
  assert.deepEqual(
    wrappers.map((n) => n.name),
    [],
    '**同源的片根不许被建成子节点**（真机就是这两个包装层：PEIS 体检信息系统 14 子、PEIS 8 子）',
  );
  /** 两片的孩子都要挂到根下（内容不许丢）。 */
  for (const name of ['体检登记', '报告打印']) {
    const node = board.nodes.find((n) => n.name === name);
    assert.ok(node, `「${name}」不许丢`);
    assert.equal(node.parentId, roots[0]?.id, `「${name}」应当直接挂根下（被别名拉平了）`);
  }

  ctx.disposeAll();
  rmSync(workspace, { recursive: true, force: true });
});
