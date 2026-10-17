/**
 * **覆盖回填**（0.3.53）：提示词只能"希望"模型别漏目录，这里用程序保证补上。
 *
 * ## 现场
 *
 * 0.3.52 在分批话术里写了硬规则"每个目录都必须至少有一个节点覆盖"，
 * 真机把覆盖缺口从 **13 个降到 8 个** —— 有效但**不可靠**：`Mobile`（791 项、整个移动端）
 * 仍然一条 refs 都没有。
 *
 * 原因是每片分摊到的**节点预算**有限，模型在紧张时就挑"看着重要"的目录、把其余整块跳过。
 * 所以改成：建树后**算一次覆盖**，缺的目录**补一次调用**（只喂缺的那几个）。
 *
 * 这条用例钉三件事：
 * 1. **有缺口 ⇒ 多发一次调用**，并且补完真的覆盖上了；
 * 2. **没缺口 ⇒ 一次都不发**（这条路径平时不花钱）；
 * 3. 回填的节点**挂到既有根下**，不另起根。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFakeContext } from './fake-host.ts';

const streamOf = (text: string) =>
  (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: 'stop' };
  })();

test('覆盖回填：有目录完全没覆盖 ⇒ 补一次调用并覆盖上（0.3.53）', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-backfill-'));
  /** 两个顶层目录 ⇒ 能切成 2 片；模型只为 `one` 建节点、故意漏掉 `two`。 */
  for (const top of ['one', 'two']) {
    mkdirSync(join(workspace, top, 'src'), { recursive: true });
    writeFileSync(join(workspace, top, 'src', 'main.ts'), 'export const x = 1;\n');
  }

  const ctx = createFakeContext({ workspace });
  ctx.services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) });
  ctx.services.set('llm', {
    stream: () => {
      throw new Error('用注入的假流');
    },
  });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    aiBuildTree(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    board(): Promise<{ projectName: string; nodes: Array<{ id: string; name: string; parentId: string | null; refs?: Array<{ target: string }> }> }>;
  };
  service.noteWorkspaceRoot(workspace);

  let calls = 0;
  let backfillCalls = 0;
  const built = await service.aiBuildTree({
    confirm: true,
    stream: {
      stream: (options: { messages?: unknown[] }) => {
        const prompt = JSON.stringify(options.messages ?? []);
        calls += 1;

        /** ① 首调空返回 ⇒ 触发分批。 */
        if (calls === 1) return streamOf('');

        /** ② 覆盖回填那次：提示词里有"补漏"标记 ⇒ 为缺的目录各给节点。 */
        if (prompt.includes('补漏') || prompt.includes('补漏')) {
          backfillCalls += 1;
          return streamOf(
            JSON.stringify({
              projectName: '演示项目',
              nodes: [
                { name: '目录 two 的入口服务', kind: 'feature', parent: null, description: 'two 的入口', refs: [{ type: 'dir', target: 'two/src' }] },
              ],
            }),
          );
        }

        /** ③ 常规分片：只为 one 建节点，**故意漏掉 two**。 */
        const isOne = prompt.includes('one/');
        return streamOf(
          JSON.stringify({
            projectName: '演示项目',
            nodes: isOne
              ? [
                  { name: '演示项目', kind: 'feature', parent: null, description: '本体' },
                  { name: '目录 one 的业务', kind: 'feature', parent: 0, description: 'one 的业务', refs: [{ type: 'dir', target: 'one/src' }] },
                ]
              : [
                  /** two 这片模型啥也没建（模拟"预算紧张就整块跳过"）。 */
                  { name: '演示项目', kind: 'feature', parent: null, description: '本体' },
                ],
          }),
        );
      },
    },
  });

  assert.equal(built['status'], 'ok', `建树应当成功：${JSON.stringify(built).slice(0, 400)}`);
  const notes = JSON.stringify(built['notes'] ?? []);
  assert.equal(backfillCalls, 1, `有缺口时**必须补一次调用**（实际 ${backfillCalls} 次）：${notes.slice(0, 500)}`);
  assert.match(notes, /覆盖回填/, '建树说明里要写明做了回填');

  const board = await service.board();
  /**
   * ⚠️ **主建树的节点不许被回填清掉**（0.3.53 我自己踩的坑）。
   *
   * `applyAiTree` 里判的是 `options?.replaceAutoDraft !== false` —— **不传等于 true**，
   * 会清掉"没人动过的自动节点"，而刚建完的节点全是这种状态。
   * 我第一版没传，e2e 里 `board()` 直接返回 **0 个节点**：回填把整棵树清空了。
   * 这要是上真机就是"点一次重建、树没了"。
   */
  assert.ok(
    board.nodes.length >= 3,
    `主建树的节点必须还在（实际只剩 ${board.nodes.length} 个：${JSON.stringify(board.nodes.map((n) => n.name))}）`,
  );
  assert.ok(
    board.nodes.some((n) => n.name === '目录 one 的业务'),
    '**主建树建的节点不许被回填清掉**（这是 replaceAutoDraft 那个坑）',
  );
  const roots = board.nodes.filter((n) => n.parentId === null);
  assert.equal(roots.length, 1, '**回填不许另起一个根**');
  const allRefs = board.nodes.flatMap((n) => (n.refs ?? []).map((r) => String(r.target).replace(/\\/g, '/')));
  assert.ok(
    allRefs.some((r) => r === 'two' || r.startsWith('two/')),
    `回填后 \`two\` 必须有 refs 覆盖（实际 refs：${allRefs.join(', ')}）`,
  );

  ctx.disposeAll();
  rmSync(workspace, { recursive: true, force: true });
});

test('覆盖回填：没有缺口时**一次调用都不发**（这条路径平时不该花钱）', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-backfill2-'));
  for (const top of ['one', 'two']) {
    mkdirSync(join(workspace, top, 'src'), { recursive: true });
    writeFileSync(join(workspace, top, 'src', 'main.ts'), 'export const x = 1;\n');
  }

  const ctx = createFakeContext({ workspace });
  ctx.services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) });
  ctx.services.set('llm', {
    stream: () => {
      throw new Error('用注入的假流');
    },
  });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    aiBuildTree(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  service.noteWorkspaceRoot(workspace);

  let calls = 0;
  let backfillCalls = 0;
  const built = await service.aiBuildTree({
    confirm: true,
    stream: {
      stream: (options: { messages?: unknown[] }) => {
        const prompt = JSON.stringify(options.messages ?? []);
        calls += 1;
        if (calls === 1) return streamOf('');
        if (prompt.includes('补漏')) {
          backfillCalls += 1;
          return streamOf(JSON.stringify({ projectName: '演示项目', nodes: [] }));
        }
        /** 两片**都**给了 refs ⇒ 没有缺口。 */
        return streamOf(
          JSON.stringify({
            projectName: '演示项目',
            nodes: [
              { name: '演示项目', kind: 'feature', parent: null, description: '本体' },
              { name: '两块区域', kind: 'feature', parent: 0, description: '覆盖两片', refs: [{ type: 'dir', target: 'one/src' }, { type: 'dir', target: 'two/src' }] },
            ],
          }),
        );
      },
    },
  });

  assert.equal(built['status'], 'ok', `建树应当成功：${JSON.stringify(built).slice(0, 300)}`);
  assert.equal(backfillCalls, 0, '没有缺口时**不许发回填调用**（否则每次都多花钱）');

  ctx.disposeAll();
  rmSync(workspace, { recursive: true, force: true });
});

test('顺序：**先回填、再归拢**（否则回填会把根下分支撑爆）—— 0.3.54', async () => {
  /**
   * 真机 0.3.53 现场：回填把 9 个原本没覆盖的目录各建了节点、**全挂在根下**
   * ⇒ 根的直接子节点从 6 涨到 **15**（`too-many-children`）。
   * 覆盖补上了，形状却被它破坏了。
   *
   * 归拢的职责本来就是"根下分支太多 ⇒ 按功能并成几组"，所以顺序必须是
   * **先回填（补内容）→ 再归拢（收形状）**。
   *
   * 这条用例用一个"5 个目录、全部没覆盖"的小仓验证：
   * 回填必须发生在归拢**之前**（用调用顺序断言），且最终根下分支数受控。
   */
  const workspace = mkdtempSync(join(tmpdir(), 'pm-order-'));
  const tops = ['d1', 'd2', 'd3', 'd4', 'd5'];
  for (const top of tops) {
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
    board(): Promise<{ nodes: Array<{ id: string; name: string; parentId: string | null; refs?: Array<{ target: string }> }> }>;
  };
  service.noteWorkspaceRoot(workspace);

  const order: string[] = [];
  let calls = 0;
  const built = await service.aiBuildTree({
    confirm: true,
    stream: {
      stream: (options: { messages?: unknown[] }) => {
        const prompt = JSON.stringify(options.messages ?? []);
        calls += 1;
        if (calls === 1) return streamOf('');

        /** 覆盖回填：为**每个缺的目录**给一个节点（真机就是这样把根撑爆的）。 */
        if (prompt.includes('补漏')) {
          order.push('backfill');
          const dirs = [...prompt.matchAll(/- (d[1-5])/g)].map((m) => m[1]);
          const unique = [...new Set(dirs)];
          return streamOf(
            JSON.stringify({
              projectName: '顺序演示',
              nodes: unique.map((dir) => ({
                name: `${dir} 的功能`,
                kind: 'feature',
                parent: null,
                description: `${dir} 的区域`,
                refs: [{ type: 'dir', target: dir }],
              })),
            }),
          );
        }

        /** 归拢：把这些分支并成 2 组。 */
        if (prompt.includes('branchIds')) {
          order.push('regroup');
          const pairs = [...prompt.matchAll(/- id=([0-9a-f-]{8,})\s+「([^」]+)」/g)].map((m) => ({ id: m[1], name: m[2] }));
          const half = Math.floor(pairs.length / 2);
          return streamOf(
            JSON.stringify({
              summary: '并成两组',
              groups: [
                { name: '甲组', description: '前半', branchIds: pairs.slice(0, half).map((p) => p.id) },
                { name: '乙组', description: '后半', branchIds: pairs.slice(half).map((p) => p.id) },
              ].filter((group) => group.branchIds.length >= 2),
            }),
          );
        }

        /** 常规分片：只给根，一个 refs 都不给（制造覆盖缺口）。 */
        order.push('shard');
        return streamOf(
          JSON.stringify({
            projectName: '顺序演示',
            nodes: [{ name: '顺序演示', kind: 'feature', parent: null, description: '本体' }],
          }),
        );
      },
    },
  });

  assert.equal(built['status'], 'ok', `建树应当成功：${JSON.stringify(built).slice(0, 300)}`);
  const firstBackfill = order.indexOf('backfill');
  const firstRegroup = order.indexOf('regroup');
  assert.ok(firstBackfill >= 0, `必须发生覆盖回填（order=${order.join(',')}）`);
  assert.ok(firstRegroup >= 0, `必须发生按功能归拢（order=${order.join(',')}）`);
  assert.ok(
    firstBackfill < firstRegroup,
    `**回填必须在归拢之前**（实际顺序 ${order.join(' → ')}）—— 反了就没人收拾被撑爆的根`,
  );

  const board = await service.board();
  const roots = board.nodes.filter((n) => n.parentId === null);
  assert.equal(roots.length, 1, '只能有一个根');
  const rootKids = board.nodes.filter((n) => n.parentId === roots[0]?.id);
  assert.ok(
    rootKids.length <= 6,
    `根的直接子节点必须受控（≤6），实际 ${rootKids.length}：${JSON.stringify(rootKids.map((n) => n.name))}`,
  );

  ctx.disposeAll();
  rmSync(workspace, { recursive: true, force: true });
});
