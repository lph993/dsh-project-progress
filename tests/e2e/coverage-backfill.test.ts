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
