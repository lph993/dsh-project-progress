/**
 * **跨片按功能归拢**必须真的落到树上（0.3.46）。
 *
 * ## 为什么必须有一条"真跑"的 e2e
 *
 * 这一步会**真的新增节点、真的搬分支**。只靠纯函数测试（`tests/ai/regroup.test.ts`）
 * 只能证明"判据对"，证明不了"接线对" —— 而 0.3.40 的教训正是：
 * **我写了诊断、写了测试，真机一跑才发现代码从没被执行过。**
 *
 * 所以这条用例造一次**分批建树**（首调空返回触发分批，与 `plugin-smoke` 同一手法），
 * 让两片各产出一批**目录形状**的分支，然后看归拢有没有：
 *
 * - 建出功能命名的组节点；
 * - 把分支搬进组里；
 * - **一个分支都不丢**。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFakeContext } from './fake-host.ts';

test('分批建树后：按功能归拢真的建组并搬分支（0.3.46）', async () => {
  /** 两个顶层目录 ⇒ 截断后能切成 2 片。 */
  const workspace = mkdtempSync(join(tmpdir(), 'pm-regroup-'));
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

  /** 每片产出一批**目录形状**的分支（根都是项目名，applyAiTree 会把它们并到既有根下）。 */
  const shardTrees: Record<string, unknown> = {
    WebSite: {
      projectName: 'PEIS 体检管理系统',
      nodes: [
        { name: 'PEIS 体检管理系统', kind: 'feature', parent: null, description: '项目本体' },
        { name: 'PEIS.Web', kind: 'feature', parent: 0, description: '网站目录', refs: [{ type: 'dir', target: 'WebSite' }] },
        { name: 'PEIS.Base', kind: 'feature', parent: 0, description: '基础目录', refs: [{ type: 'dir', target: 'WebSite/base' }] },
        { name: 'BlazorLayui', kind: 'feature', parent: 0, description: '组件库', refs: [{ type: 'dir', target: 'WebSite/blazor' }] },
      ],
    },
    MobileApp: {
      projectName: 'PEIS 体检管理系统',
      nodes: [
        { name: 'PEIS 体检管理系统', kind: 'feature', parent: null, description: '项目本体' },
        { name: 'Mobile', kind: 'feature', parent: 0, description: '移动端目录', refs: [{ type: 'dir', target: 'MobileApp' }] },
        { name: 'PEIS.FormsOut', kind: 'feature', parent: 0, description: '外检客户端', refs: [{ type: 'dir', target: 'MobileApp/forms' }] },
        { name: 'PEIS.DataBase', kind: 'feature', parent: 0, description: '数据访问', refs: [{ type: 'dir', target: 'MobileApp/db' }] },
      ],
    },
  };

  const built = await service.aiBuildTree({
    confirm: true,
    stream: {
      stream: (options: { messages?: unknown[] }) => {
        calls += 1;
        /** 第一次整仓：空返回 ⇒ 触发按顶层目录分批。 */
        if (calls === 1) return streamOf('');
        const prompt = JSON.stringify(options.messages ?? []);
        /** 归拢那次调用：提示词里有 `branchIds` 的格式说明 ⇒ 回一份分组方案。 */
        if (prompt.includes('branchIds')) {
          /**
           * **从提示词里抠出真实的分支 id**（`- id=<uuid>  「名字」`）。
           *
           * 为什么要这样：这套 e2e 的价值就在"真跑一遍"。用占位 id 会被
           * `validateRegroupPlan` 的"id 不在待归拢列表"挡掉 —— 那只能证明校验有效，
           * **证明不了归拢真的搬了节点**。
           */
          const pairs = [...prompt.matchAll(/- id=([0-9a-f-]{8,})\s+「([^」]+)」/g)].map((m) => ({
            id: m[1] as string,
            name: m[2] as string,
          }));
          const pick = (names: string[]): string[] =>
            pairs.filter((pair) => names.includes(pair.name)).map((pair) => pair.id);
          /** 目录名 ⇒ 功能名。两组各 2 个以上分支（校验要求每组 ≥2）。 */
          const business = pick(['PEIS.Web', 'Mobile', 'PEIS.FormsOut']);
          const base = pick(['PEIS.DataBase', 'BlazorLayui', 'PEIS.Base']);
          return streamOf(
            JSON.stringify({
              summary: '把目录分支按业务功能归拢',
              groups: [
                { name: '体检业务办理', description: '面向业务人员的主流程', branchIds: business },
                { name: '基础技术底座', description: '通用能力与基础库', branchIds: base },
              ],
            }),
          );
        }
        const key = prompt.includes('WebSite') ? 'WebSite' : 'MobileApp';
        return streamOf(JSON.stringify(shardTrees[key]));
      },
    },
  });

  assert.equal(built['status'], 'ok', `建树应当成功：${JSON.stringify(built).slice(0, 400)}`);
  const notes = JSON.stringify(built['notes'] ?? []);
  console.log('[PROBE] notes =', notes.slice(0, 700));

  const board = await service.board();
  const roots = board.nodes.filter((n) => n.parentId === null);
  assert.equal(roots.length, 1, '只能有一个根');
  const root = roots[0];

  /** 分支必须还在（归拢只搬不改，一个都不许丢）。 */
  for (const name of ['PEIS.Web', 'PEIS.Base', 'BlazorLayui', 'Mobile', 'PEIS.FormsOut', 'PEIS.DataBase']) {
    assert.ok(
      board.nodes.some((n) => n.name === name),
      `分支「${name}」不许在归拢里丢掉`,
    );
  }

  /**
   * **真正的验收：目录形状的分支被搬进了功能命名的组**。
   *
   * 不验这条的话，这条 e2e 就只是"跑完没崩" —— 而 0.3.40 的教训正是
   * "我改了代码 ≠ 行为变了"。
   */
  const business = board.nodes.find((n) => n.name === '体检业务办理');
  const base = board.nodes.find((n) => n.name === '基础技术底座');
  assert.ok(business, '必须建出功能组「体检业务办理」');
  assert.ok(base, '必须建出功能组「基础技术底座」');
  assert.equal(business.parentId, root.id, '组节点挂在根下面');
  assert.equal(base.parentId, root.id, '组节点挂在根下面');

  /** 各分支被搬进对应的组。 */
  const parentNameOf = (name: string): string | undefined => {
    const node = board.nodes.find((n) => n.name === name);
    if (!node || node.parentId === null) return undefined;
    return board.nodes.find((n) => n.id === node.parentId)?.name;
  };
  for (const name of ['PEIS.Web', 'Mobile', 'PEIS.FormsOut']) {
    assert.equal(parentNameOf(name), '体检业务办理', `「${name}」应当被归入「体检业务办理」`);
  }
  for (const name of ['PEIS.DataBase', 'BlazorLayui', 'PEIS.Base']) {
    assert.equal(parentNameOf(name), '基础技术底座', `「${name}」应当被归入「基础技术底座」`);
  }

  /** 归拢的结果要出现在建树说明里（用户看得到）。 */
  assert.match(notes, /按功能归拢/, '建树结果里必须写明做了归拢');

  ctx.disposeAll();
  rmSync(workspace, { recursive: true, force: true });
});
