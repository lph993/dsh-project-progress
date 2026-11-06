/**
 * **建树形状与覆盖**（0.3.74）：把"这棵树合不合适"变成可核对的数字。
 *
 * 这条规则来自真机：updater 那次建树报"新建 20、失败 39"，看起来完成了，
 * 实际根下 14 支、文件覆盖 82.4% —— 这两件事当时都是人另外写脚本才算出来的。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeTreeShape, summarizeTreeShape } from '../../src/domain/tree-shape.ts';
import type { GraphSnapshot, NodeRecord } from '../../src/shared/types.ts';

const node = (id: string, name: string, parentId: string | null, refs: string[] = []): NodeRecord => ({
  id,
  name,
  parentId,
  kind: parentId === null ? 'feature' : 'task',
  selfState: 'pending',
  progress: 0,
  refs: refs.map((target) => ({ type: target.includes('.') ? 'file' : 'dir', target })),
});

const graphOf = (nodes: NodeRecord[]): GraphSnapshot => ({
  projectName: 'demo',
  nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
  rootIds: nodes.filter((n) => n.parentId === null).map((n) => n.id),
  dataFormat: 1,
});

test('全部合格时明确说"合格"（不要只在失败时才有输出）', () => {
  const graph = graphOf([
    node('r', 'demo', null, []),
    node('a', '前端', 'r', ['web']),
    node('b', '后端', 'r', ['server']),
    node('a1', '登录页', 'a', ['web/login.tsx']),
  ]);
  const report = summarizeTreeShape(graph, [
    { path: 'web/login.tsx', kind: 'file' },
    { path: 'server/api.ts', kind: 'file' },
  ]);
  assert.equal(report.failures.length, 0);
  assert.equal(report.coverage, 1);
  assert.match(describeTreeShape(report), /合格/);
});

test('根下过宽 / 多根 / 覆盖不足都要点名（带数字，不许只说"不合适"）', () => {
  const wide = graphOf([
    node('r', 'demo', null),
    ...Array.from({ length: 7 }, (_, i) => node(`c${i}`, `功能${i}`, 'r')),
  ]);
  assert.match(describeTreeShape(summarizeTreeShape(wide, [])), /7 个直接子节点（上限 6）/);

  const twoRoots = graphOf([node('r1', 'a', null), node('r2', 'b', null)]);
  assert.match(describeTreeShape(summarizeTreeShape(twoRoots, [])), /根 2 个/);

  const sparse = graphOf([node('r', 'demo', null), node('a', '前端', 'r', ['web'])]);
  const report = summarizeTreeShape(sparse, [
    { path: 'web/a.ts', kind: 'file' },
    { path: 'server/b.ts', kind: 'file' },
    { path: 'server/c.ts', kind: 'file' },
    { path: 'server/d.ts', kind: 'file' },
  ]);
  assert.equal(report.covered, 1);
  assert.equal(report.files, 4);
  assert.match(describeTreeShape(report), /25\.0%/);
});

test('目录 refs 覆盖其下文件，文件 refs 只覆盖自己（与身份键同一口径）', () => {
  const graph = graphOf([
    node('r', 'demo', null),
    node('a', '前端', 'r', ['web']),
    node('b', '入口', 'r', ['server/main.ts']),
  ]);
  const report = summarizeTreeShape(graph, [
    { path: 'web/login.tsx', kind: 'file' },
    { path: 'web/deep/nested.ts', kind: 'file' },
    { path: 'server/main.ts', kind: 'file' },
    { path: 'server/other.ts', kind: 'file' }, // 不在任何 refs 里
  ]);
  assert.equal(report.covered, 3);
  assert.equal(report.coverage, 0.75);
});

test('墓碑不参与形状统计', () => {
  const removed: NodeRecord = { ...node('dead', '旧功能', 'r'), selfState: 'removed' };
  const graph = graphOf([node('r', 'demo', null), node('a', '前端', 'r'), removed]);
  const report = summarizeTreeShape(graph, []);
  assert.equal(report.roots, 1);
  assert.equal(report.widest?.children, 1);
});
