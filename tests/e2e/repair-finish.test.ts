/**
 * **AI 修复也必须看终止原因**（0.3.61）。
 *
 * 0.3.60 把"取消/报错/撞上限"的分类修进了建树路径，但修复（`aiPlanRepair`）与归拢
 * （`regroupShardedBranches`）各自手写的 for-await **从不读 `finish`**。后果里最隐蔽的一条：
 * `finish=max-tokens` 且已吐出的 JSON 恰好配平 ⇒ **半份动作清单被当成完整方案**返回给面板，
 * 用户照着确认，执行的就是一组残缺的动作。
 *
 * 这条测试打的就是这个形状：一份**语法上完全合法**的方案 + 撞上限的终止原因，
 * 必须判 `truncated` 而不是 `ok`。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFakeContext } from './fake-host.ts';

test('修复方案撞上输出上限 ⇒ 必须报 truncated，哪怕 JSON 配平', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-repair-finish-'));
  mkdirSync(join(workspace, 'web'), { recursive: true });
  writeFileSync(join(workspace, 'web', 'index.ts'), 'export const a = 1;\n');

  const ctx = createFakeContext({ workspace });
  ctx.services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) });
  ctx.services.set('llm', { stream: () => { throw new Error('用注入的假流'); } });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    aiPlanRepair(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  service.noteWorkspaceRoot(workspace);

  /** 语法完全合法的一份方案（能通过 `parseRepairPlan`），但终止原因是撞上限。 */
  const plan = JSON.stringify({ summary: '看起来没问题', actions: [] });
  const result = await service.aiPlanRepair({
    stream: {
      stream: () =>
        (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: plan };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: plan } };
          yield { type: 'finish', reason: 'max-tokens' };
        })(),
    },
  });

  assert.equal(
    result['status'],
    'error',
    `撞上限不许报成功（实际：${JSON.stringify(result).slice(0, 300)}）`,
  );
  assert.equal(result['reason'], 'truncated', '原因必须是 truncated（半份方案不当完整）');

  ctx.disposeAll();
  rmSync(workspace, { recursive: true, force: true });
});
