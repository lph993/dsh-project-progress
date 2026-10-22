/**
 * **覆盖回填的落点核对不许"自证"**（0.3.62）。
 *
 * 原来是 `ensureLanding(this.boundRoot)` —— 拿自己校验自己：落点核对的意义是
 * "项目根 vs 本次仓库"，两个参数都取 `boundRoot` 时永远相等，于是这道核对形同虚设。
 * 0.3.61 的交接文档已如实登记过这一点，这版把它修掉。
 *
 * 现在：调用方（`aiBuildTreeSharded`）知道本次 `root` 并显式传入；
 * **拿不到时必须如实说出来**，不许假装核对过。
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

test('回填拿不到"本次仓库"时必须如实说明（而不是自证通过）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'pm-backfill-'));
  for (const top of ['one', 'two']) {
    mkdirSync(join(ws, top), { recursive: true });
    writeFileSync(join(ws, top, 'a.ts'), 'export const a = 1;\n');
  }
  const ctx = createFakeContext({ workspace: ws });
  ctx.services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) });
  ctx.services.set('llm', {
    stream: () => {
      throw new Error('fake');
    },
  });
  const mod = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await mod.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    board(): Promise<unknown>;
    backfillCoverage(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  service.noteWorkspaceRoot(ws);
  await service.board();

  /** 空树 ⇒ 两个目录都算缺口 ⇒ 回填会真的跑；模型返回空树，只观察 reason。 */
  const out = await service.backfillCoverage({
    route: { provider: 'p', model: 'm' },
    stream: { stream: () => streamOf(JSON.stringify({ projectName: 'X', nodes: [{ name: '一区', parent: null, description: '覆盖 one', refs: [{ type: 'dir', target: 'one' }] }] })) },
  });
  const text = JSON.stringify(out);
  assert.match(
    text,
    /等于没核对|退回当前绑定/,
    `**没给本次仓库时必须如实说明**（实际：${text.slice(0, 300)}）`,
  );

  /** 给了 `expectRoot` ⇒ 不许再出现那句"没核对"。 */
  const withRoot = await service.backfillCoverage({
    route: { provider: 'p', model: 'm' },
    expectRoot: ws,
    stream: { stream: () => streamOf(JSON.stringify({ projectName: 'X', nodes: [{ name: '一区', parent: null, description: '覆盖 one', refs: [{ type: 'dir', target: 'one' }] }] })) },
  });
  assert.doesNotMatch(
    JSON.stringify(withRoot),
    /等于没核对/,
    '传了本次仓库就不该再说"没核对"',
  );

  ctx.disposeAll();
  rmSync(ws, { recursive: true, force: true });
});
