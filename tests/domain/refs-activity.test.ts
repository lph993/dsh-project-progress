/**
 * **"正在改的文件 → 节点"映射**（0.3.68，纯函数）。
 *
 * 这些用例钉的都是真机会踩的形态：Windows 反斜杠、大小写、目录前缀、绝对路径、
 * 以及"文件引用不能按前缀误伤同名前缀的兄弟"（`src/a.ts` 不该覆盖 `src/a.tsx`）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hotNodeIdsOf,
  normalizeWorkspacePath,
  refCoversPath,
} from '../../src/domain/refs-activity.ts';

test('路径归一：正反斜杠、./ 前缀、尾部斜杠、大小写', () => {
  assert.equal(normalizeWorkspacePath('src\\ai\\prompt.ts'), 'src/ai/prompt.ts');
  assert.equal(normalizeWorkspacePath('./src/ai/'), 'src/ai');
  assert.equal(normalizeWorkspacePath('  SRC/AI/  '), 'src/ai');
  assert.equal(normalizeWorkspacePath('src//ai///prompt.ts'), 'src/ai/prompt.ts');
});

test('目录引用覆盖其下所有文件（含嵌套、反斜杠、大小写）', () => {
  const ref = { type: 'dir', target: 'src/ai' };
  assert.equal(refCoversPath(ref, 'src/ai/prompt.ts'), true);
  assert.equal(refCoversPath(ref, 'src/ai/shard/index.ts'), true);
  assert.equal(refCoversPath(ref, 'SRC\\AI\\prompt.ts'), true, 'Windows 路径风格也要认');
  assert.equal(refCoversPath(ref, 'src/aix/prompt.ts'), false, '同名前缀的兄弟目录不算');
  assert.equal(refCoversPath(ref, 'src/ai2.ts'), false);
});

test('文件引用只精确匹配，不许按前缀误伤兄弟文件', () => {
  const ref = { type: 'code', target: 'src/a.ts' };
  assert.equal(refCoversPath(ref, 'src/a.ts'), true);
  assert.equal(refCoversPath(ref, 'src/a.tsx'), false);
  assert.equal(refCoversPath(ref, 'src/a.ts/child'), false);
});

test('绝对路径（refs 或改动路径）一律不参与匹配', () => {
  assert.equal(refCoversPath({ type: 'code', target: 'E:\\work\\a.ts' }, 'E:/work/a.ts'), false);
  assert.equal(refCoversPath({ type: 'code', target: 'src/a.ts' }, 'E:/work/src/a.ts'), false);
});

test('节点映射：多节点、去重、顺序稳定；没有 refs 的节点永不命中', () => {
  const nodes = [
    { id: 'n1', refs: [{ type: 'dir' as const, target: 'src/ai' }] },
    { id: 'n2', refs: [{ type: 'code' as const, target: 'src/client/board-panel.tsx' }] },
    { id: 'n3' },
    { id: 'n4', refs: [{ type: 'dir' as const, target: 'updater-rust' }] },
  ];
  assert.deepEqual(
    hotNodeIdsOf(nodes, ['src/ai/prompt.ts', 'src/ai/shard.ts', 'updater-rust/src/bin/updater/pkgbuild.rs']),
    ['n1', 'n4'],
  );
  assert.deepEqual(hotNodeIdsOf(nodes, ['src/client/board-panel.tsx']), ['n2']);
  assert.deepEqual(hotNodeIdsOf(nodes, []), [], '没有改动 ⇒ 一个都不热');
  assert.deepEqual(hotNodeIdsOf(nodes, ['docs/readme.md']), [], '没被任何 ref 覆盖 ⇒ 不热（不猜）');
});
