/**
 * **建树时丢弃指向不存在路径的 refs**（0.3.49，用户口径："**丢弃吧**"）。
 *
 * ## 为什么建树路径要"丢"，而工具路径只"告警"
 *
 * `refs` 是**身份键**的输入（`identityKeyOf({ name, refs })`）：路径写错，
 * 下次建树就按错路径认节点 ⇒ **同一个功能点被认成两个**，树越建越乱。
 *
 * 两处策略**故意不同**：
 * - **建树（批量）**：模型一次给几十上百条，没人会逐条校对 ⇒ 假路径必须丢掉；
 * - **工具（人工）**：`pm_progress` / `patchNode` 那边"先声明后创建"是真需求，只告警、照写。
 *
 * 这条用例钉住"建树真的丢了"，并且**真路径一条都不许误伤**（这是最怕的回归）。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFakeContext, fakeAiStream } from './fake-host.ts';

test('建树：不存在的 refs 被丢弃，真实路径一条不误伤（0.3.49）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'pm-refs-'));
  /** 真存在的东西：一个目录 + 一个文件。 */
  mkdirSync(join(ws, 'src', 'biz'), { recursive: true });
  writeFileSync(join(ws, 'src', 'biz', 'main.ts'), 'export const x = 1;\n');
  writeFileSync(join(ws, 'README.md'), '# demo\n');

  const ctx = createFakeContext({ workspace: ws });
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
    board(sessionId?: string, root?: string): Promise<{
      nodes: Array<{ id: string; name: string; parentId: string | null; refs?: Array<{ target: string }> }>;
    }>;
  };
  service.noteWorkspaceRoot(ws);

  const json = JSON.stringify({
    projectName: '演示项目',
    nodes: [
      { name: '演示项目', kind: 'feature', parent: null, description: '本体', refs: ['README.md'] },
      {
        name: '体检业务办理',
        kind: 'feature',
        parent: 0,
        description: '业务',
        /** 一条真目录、一条真文件、两条编造的路径。 */
        refs: [
          { type: 'dir', target: 'src/biz' },
          { type: 'code', target: 'src/biz/main.ts' },
          { type: 'dir', target: '不存在的目录' },
          { type: 'code', target: 'src/biz/ghost.ts' },
        ],
      },
    ],
  });

  const built = await service.aiBuildTree({ stream: fakeAiStream(json), forceRebuild: true });
  assert.equal(built['status'], 'ok', `建树应当成功：${JSON.stringify(built).slice(0, 300)}`);
  const notes = JSON.stringify(built['notes'] ?? []);
  assert.match(notes, /丢弃了 2 条指向不存在路径的 refs/, `必须如实记下丢了几条：${notes.slice(0, 600)}`);

  const board = await service.board();
  const business = board.nodes.find((n) => n.name === '体检业务办理');
  assert.ok(business, '节点本身必须还在（只丢 refs，不丢节点）');
  const targets = (business.refs ?? []).map((ref) => ref.target).sort();
  assert.deepEqual(
    targets,
    ['src/biz', 'src/biz/main.ts'],
    '**真路径一条都不许误伤**，编造的必须没了',
  );
});
