/**
 * `note`（未完成节点"还差什么"）在领域层的落库契约 —— 0.3.2 新增。
 *
 * 为什么值得单独钉死：这个字段的价值全在"**能被读回来**"。真机教训（`kv-port` 的注释里
 * 记着两次）：`identity` / `stale` 都曾经"类型里有、落库时没有"，于是功能看起来实现了、
 * 却永远不生效 —— 症状（建树老新建、进度推不动）离根因（少写一行白名单）很远，查起来极贵。
 *
 * 这里钉三件事：
 * 1. `note` 写进去了；
 * 2. `noteUpdatedAt` **自动**打上（与 `descriptionUpdatedAt` 同一纪律，不许调用方自己记）；
 * 3. `note` 与 `description` **是两个字段**，互不覆盖（这正是它存在的理由）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { blockOf, createNodeRecord, mutatePatch } from '../../src/domain/mutate.ts';
import type { GraphSnapshot, NodeRecord } from '../../src/shared/types.ts';

function graphOf(records: Array<Partial<NodeRecord> & { id: string; name: string }>): GraphSnapshot {
  const nodes: Record<string, NodeRecord> = {};
  for (const partial of records) {
    const base = createNodeRecord({
      id: partial.id,
      name: partial.name,
      parentId: partial.parentId ?? null,
      kind: partial.kind ?? 'task',
      ts: '2026-10-12T00:00:00.000Z',
      by: 'user',
    });
    nodes[partial.id] = { ...base, ...partial };
  }
  return {
    projectName: '测试项目',
    nodes,
    rootIds: records.filter((record) => (record.parentId ?? null) === null).map((record) => record.id),
    dataFormat: 1,
  };
}

const ctx = {
  clock: { now: () => '2026-10-12T03:00:00.000Z' },
  random: { uuid: () => 'sub-1' },
  policy: 'auto-fix-first' as const,
};

describe('note：未完成节点"还差什么"', () => {
  it('① 写进去，且 noteUpdatedAt 由内核自动打上', () => {
    const graph = graphOf([{ id: 'a', name: 'A' }]);
    const result = mutatePatch(
      graph,
      { nodeId: 'a', patch: { note: '缺 .eslintrc.js 的 rules，等于不校验' }, by: 'session' },
      ctx,
    );
    assert.equal(result.kind, 'ok');
    const node = result.kind === 'ok' ? result.graph.nodes['a'] : undefined;
    assert.equal(node?.note, '缺 .eslintrc.js 的 rules，等于不校验');
    assert.equal(
      node?.noteUpdatedAt,
      '2026-10-12T03:00:00.000Z',
      '时间戳必须自动打：让调用方记得传是不可靠的（description 那条已经踩过）',
    );
  });

  it('② note 与 description 互不覆盖（它存在的理由就是二者语义不同）', () => {
    const graph = graphOf([{ id: 'a', name: 'A', description: '搜索页分页与 records 口径' }]);
    const result = mutatePatch(
      graph,
      { nodeId: 'a', patch: { note: 'search.wxml:9 没绑 bindscrolltolower' }, by: 'session' },
      ctx,
    );
    const node = result.kind === 'ok' ? result.graph.nodes['a'] : undefined;
    assert.equal(node?.description, '搜索页分页与 records 口径', '写 note 不能动 description');
    assert.equal(node?.note, 'search.wxml:9 没绑 bindscrolltolower');
    assert.equal(
      node?.descriptionUpdatedAt,
      undefined,
      '只写 note 不该刷新描述时间戳 —— 否则"描述过时了吗"的判据会被进度类写入污染',
    );
  });

  it('③ note 属于描述块（blockOf = desc）：CAS 版本号校验要落在正确的域上', () => {
    assert.equal(blockOf({ note: 'x' }), 'desc');
    assert.equal(blockOf({ description: 'x' }), 'desc');
  });

  it('④ 只写 note（不带进度/状态）也要落库 —— 这正是"未完成节点写缺口"的用法', () => {
    const graph = graphOf([{ id: 'a', name: 'A' }]);
    const before = graph.nodes['a']!;
    const result = mutatePatch(graph, { nodeId: 'a', patch: { note: '还差超时与重试' }, by: 'session' }, ctx);
    const node = result.kind === 'ok' ? result.graph.nodes['a'] : undefined;
    assert.equal(node?.note, '还差超时与重试');
    assert.equal(node?.progress, before.progress, 'note 不参与完成度：进度必须原样不动');
    assert.equal(node?.selfState, before.selfState);
  });
});
