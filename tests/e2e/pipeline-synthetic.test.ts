/**
 * **整条建树流水线的系统级验证**（0.3.47）。
 *
 * ## 为什么需要它
 *
 * 0.3.44–0.3.46 分三次修了三处：根判定口径、分片均衡与分批话术、跨片按功能归拢。
 * 它们**各自有测试**，但真机上是一起跑的 —— 单看每一处都对，合起来仍可能出问题
 * （典型：分片变多了，归拢看到的分支就变多；归拢建了组，根的子节点数就变了）。
 *
 * 而**重建一次要花三十万 token**，所以我宁愿在这里用假模型把整条链路跑一遍，
 * 也不要让你再撞一次。
 *
 * ## 这个用例造的是什么
 *
 * 一个**PEIS 形状**的合成仓库：24 个顶层目录 × 5 个文件 = 120 个文件
 * （超过 `SHARD_THRESHOLD_FILES = 80` ⇒ 必然分批）。
 *
 * 假模型按"真实模型的样子"回话：
 * - 每片给出**目录形状**的树（根=项目名，子节点=这片里的目录名）—— 真机就是这样；
 * - 归拢那次调用从提示词里抠出真实分支 id，回一份**功能分组**。
 *
 * ## 验的是什么（都是"真机出过问题"的那几件事）
 *
 * 1. **每片的目录数受控**（0.3.45 的病灶：一片吞 20 个目录 ⇒ 串成 8 层链）；
 * 2. **根 = 项目本体**（0.3.44 的病灶：根是某个端/次像的那个）；
 * 3. **不串链**：最深层级不该因为"片多"而暴涨；
 * 4. **按功能归拢真的落地**：建出功能命名的组、分支搬进去；
 * 5. **一个分支都不丢**：24 个目录全在树上。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFakeContext } from './fake-host.ts';

/** PEIS 形状的顶层目录（24 个，够触发分批）。 */
const TOPS = [
  'BlazorLayui', 'DataR', 'InterfaceAdapter', 'Mobile', 'Modules', 'PEIS.Adapter',
  'PEIS.AIApi', 'PEIS.Base', 'PEIS.Code', 'PEIS.DataBase', 'PEIS.Domain', 'PEIS.Events',
  'PEIS.FormReg', 'PEIS.FormsOut', 'PEIS.Test', 'PEIS.Web', 'PrintingPlatform', 'RootForms',
  'TimerServer', 'docs', 'scripts', 'tools', 'assets', 'config',
];

test('整条流水线：24 个顶层目录的分批建树 ⇒ 不串链、根是本体、按功能归拢', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-pipeline-'));
  for (const top of TOPS) {
    mkdirSync(join(workspace, top), { recursive: true });
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(join(workspace, top, `f${index}.ts`), `export const v${index} = ${index};\n`);
    }
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
      nodes: Array<{ id: string; name: string; parentId: string | null; refs?: Array<{ target: string }> }>;
    }>;
  };
  service.noteWorkspaceRoot(workspace);

  /** 记录每次调用的性质，用来验证"每片目录数受控"。 */
  const shardGroupsSeen: number[] = [];
  let buildCalls = 0;
  let regroupCalls = 0;

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
        const prompt = JSON.stringify(options.messages ?? []);

        /** ① 归拢那一次：抠出真实 id，回功能分组。 */
        if (prompt.includes('branchIds')) {
          regroupCalls += 1;
          const pairs = [...prompt.matchAll(/- id=([0-9a-f-]{8,})\s+「([^」]+)」/g)].map((m) => ({
            id: m[1] as string,
            name: m[2] as string,
          }));
          /**
           * 按"目录名像什么"分三组（模拟模型按功能判断）。
           * 只收够 2 个以上的组 —— 校验要求每组 ≥2，否则整份作废。
           */
          const web = pairs.filter((pair) => /^PEIS\.(Web|Base|Code|Test)$|Blazor|RootForms/.test(pair.name));
          const mobile = pairs.filter((pair) => /Mobile|FormsOut|FormReg|PrintingPlatform/.test(pair.name));
          const rest = pairs.filter((pair) => !web.includes(pair) && !mobile.includes(pair));
          const groups = [
            { name: '体检业务与门户', description: '面向业务与网站的界面', branchIds: web.map((p) => p.id) },
            { name: '移动与外检客户端', description: '外出登记与打印客户端', branchIds: mobile.map((p) => p.id) },
            { name: '数据与运维支撑', description: '数据访问、定时任务与构建发布', branchIds: rest.map((p) => p.id) },
          ].filter((group) => group.branchIds.length >= 2);
          return streamOf(JSON.stringify({ summary: '按功能归拢', groups }));
        }

        /**
         * ② 建树：首调返回空串触发分批；之后每片返回**目录形状**的树（真机就是这形状）。
         */
        buildCalls += 1;
        if (buildCalls === 1) return streamOf('');

        /** 从提示词里读出这片覆盖了哪些目录（`- dirName/（5 个直接文件）`）。 */
        const dirs = [...prompt.matchAll(/- ([A-Za-z][A-Za-z0-9._-]*)\/\uff08/g)].map((m) => m[1] as string);
        const unique = [...new Set(dirs)];
        shardGroupsSeen.push(unique.length);

        return streamOf(
          JSON.stringify({
            projectName: 'PEIS 体检管理系统',
            nodes: [
              { name: 'PEIS 体检管理系统', kind: 'feature', parent: null, description: '项目本体' },
              ...unique.map((dir) => ({
                name: dir,
                kind: 'feature',
                parent: 0,
                description: `${dir} 目录`,
                refs: [{ type: 'dir', target: dir }],
              })),
            ],
          }),
        );
      },
    },
  });

  assert.equal(built['status'], 'ok', `建树应当成功：${JSON.stringify(built).slice(0, 400)}`);
  const notes = JSON.stringify(built['notes'] ?? []);
  console.log('[PROBE] 建树调用次数 =', buildCalls, ' 归拢调用 =', regroupCalls);
  console.log('[PROBE] 每片目录数 =', JSON.stringify(shardGroupsSeen));
  console.log('[PROBE] notes =', notes.slice(0, 600));

  /** ① 每片目录数受控（0.3.45 的核心不变量）。 */
  assert.ok(shardGroupsSeen.length >= 2, '必须真的走了分批');
  for (const count of shardGroupsSeen) {
    assert.ok(count <= 6, `每片最多 6 个目录，实际有一片带了 ${count} 个`);
  }

  /** ② 根 = 项目本体（0.3.44 的核心不变量）。 */
  const board = await service.board();
  const roots = board.nodes.filter((n) => n.parentId === null);
  assert.equal(roots.length, 1, '只能有一个根');
  assert.equal(roots[0]?.name, 'PEIS 体检管理系统', '根必须是项目本体');
  const root = roots[0];

  /** ③ 不串链：任何节点的直接子节点数不该是"一长串单子"导致的深度暴涨。 */
  const depthOf = new Map<string, number>();
  const walk = (id: string, depth: number): void => {
    depthOf.set(id, depth);
    for (const child of board.nodes.filter((n) => n.parentId === id)) walk(child.id, depth + 1);
  };
  walk(root.id, 0);
  const maxDepth = Math.max(...depthOf.values());
  assert.ok(maxDepth <= 4, `层级不该超过 4（真机串链时到过 8）：实际 ${maxDepth}`);
  /** 单子链（一个节点只有一个子节点、且该子节点也只有一个）出现超过 1 次就算串链。 */
  let chainLinks = 0;
  for (const node of board.nodes) {
    const kids = board.nodes.filter((n) => n.parentId === node.id);
    if (kids.length !== 1) continue;
    const grandKids = board.nodes.filter((n) => n.parentId === (kids[0]?.id ?? ''));
    if (grandKids.length === 1) chainLinks += 1;
  }
  assert.ok(chainLinks <= 1, `不该出现成串的单子链（实际 ${chainLinks} 处）`);

  /** ④ 按功能归拢真的落地。 */
  const groupNames = ['体检业务与门户', '移动与外检客户端', '数据与运维支撑'];
  const groups = groupNames
    .map((name) => board.nodes.find((n) => n.name === name))
    .filter((node): node is NonNullable<typeof node> => node !== undefined);
  assert.ok(groups.length >= 2, `至少要建出 2 个功能组：实际 ${JSON.stringify(groups.map((g) => g.name))}`);
  for (const group of groups) assert.equal(group.parentId, root.id, `组「${group.name}」应当挂在根下`);
  assert.match(notes, /按功能归拢/, '建树说明里必须写明做了归拢');

  /** ⑤ 一个分支都不丢：24 个目录名都还在树上。 */
  for (const top of TOPS) {
    assert.ok(
      board.nodes.some((n) => n.name === top),
      `目录「${top}」不许在分片/归拢过程中丢掉`,
    );
  }

  ctx.disposeAll();
  rmSync(workspace, { recursive: true, force: true });
});
