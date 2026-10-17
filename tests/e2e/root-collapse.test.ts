/**
 * **分批建树后的根收拢**（0.3.41）。
 *
 * ## 为什么要单独一条
 *
 * 分批时**每一片各自成根**（片内是局部树），所以落库后会出现**两个**顶级节点：
 * 一个是"某个端"、一个是项目本体。这时候：
 *
 * - 提根 ⇒ 被 `C13：项目根唯一` 挡（0.3.38 真机原文）；
 * - 把端挂到本体下 ⇒ 不！等等 —— **这条路是通的**：
 *   `mergeRoots()` 一直在用 `reparentSubtree(根, 另一个根)`，
 *   成环检查从新父往上走、被搬的是根（祖先只有它自己）⇒ 永不成环，根数 2 → 1 也不触发 C13。
 *
 * 我在 0.3.40 断言过"事后归位做不到"，**那是错的**（只试了搬非根节点）。
 * 这条测试就钉住"两个根 ⇒ 降级端、扶本体"真的能落库成功。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFakeContext } from './fake-host.ts';

test('分批建树后：两个根要收拢成"项目本体当根、端降级"（0.3.41）', async () => {
  /** 两个顶层目录 ⇒ 截断后能切成 2 片（与 plugin-smoke 那条同一手法）。 */
  const workspace = mkdtempSync(join(tmpdir(), 'pm-collapse-'));
  for (const top of ['WebSite', 'MobileApp']) {
    mkdirSync(join(workspace, top), { recursive: true });
    writeFileSync(join(workspace, top, 'main.ts'), 'export const x = 1;\n');
  }

  const ctx = createFakeContext({ workspace });
  ctx.services.set('agentDefaultModel', {
    currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }),
  });
  ctx.services.set('llm', {
    stream: () => {
      throw new Error('本测试必须走注入的假流');
    },
  });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    aiBuildTree(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    board(sessionId?: string, root?: string): Promise<{
      nodes: Array<{ id: string; name: string; parentId: string | null }>;
    }>;
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
        /** 第一次整仓：空返回 ⇒ 触发按顶层目录分批。 */
        if (calls === 1) return streamOf('');
        const prompt = JSON.stringify(options.messages ?? []);
        /** 两片各自成根：一片是"某个端"，一片是项目本体。 */
        const isWeb = prompt.includes('WebSite');
        return streamOf(
          JSON.stringify({
            projectName: 'PEIS 体检管理系统',
            nodes: [
              {
                name: isWeb ? 'Web 服务端' : 'PEIS 体检管理系统',
                kind: 'feature',
                parent: null,
                description: isWeb ? '网站端' : '项目本体',
              },
              {
                name: isWeb ? '页面与布局' : '体检业务办理',
                kind: 'feature',
                parent: 0,
                description: '子功能',
              },
            ],
          }),
        );
      },
    },
  });

  assert.equal(built['status'], 'ok', `分批建树应当成功：${JSON.stringify(built).slice(0, 400)}`);
  assert.ok(calls >= 3, `应当走了分批（1 次整仓 + 2 片）：实际调用 ${calls} 次`);

  const board = await service.board();
  const roots = board.nodes.filter((n) => n.parentId === null);
  assert.equal(roots.length, 1, `**收拢后只能有一个根**：实际 ${JSON.stringify(roots.map((r) => r.name))}`);
  assert.equal(
    roots[0]?.name,
    'PEIS 体检管理系统',
    '**项目本体必须当根**（另一个根"Web 服务端"要降级到它下面）',
  );
  const demoted = board.nodes.find((n) => n.name === 'Web 服务端');
  assert.ok(demoted, '降级 ≠ 删除：端那个节点必须还在');
  assert.equal(demoted?.parentId, roots[0]?.id, '端要挂到项目本体下面');
  assert.equal(board.nodes.length, 4, '**一个节点都不许丢**（两片各 2 个）');

  ctx.disposeAll();
  rmSync(workspace, { recursive: true, force: true });
});
