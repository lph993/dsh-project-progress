/**
 * `domain/refs-exists.ts` 的测试 —— 0.3.2 新增的"refs 指向的路径存在吗"。
 *
 * 这条判据的**边界**比它的正例重要得多：
 * - 它**不许拦写入**（路径可以"先声明后创建"，改名/切分支也会让正确引用暂时消失）；
 * - 它**不许编**（根拿不到时由调用方跳过，这里只回答"给定 refs + 存在性判据"的结论）；
 * - 它只该报 `dir` / `code` 两类，别把 `note`/`md`/`artifact` 也拉进来（那不在本次范围）。
 *
 * 真机依据（使用报告 §5.6 第 9 条）：误写的 `.pm` 被工具**静默接受**，
 * 库里还留着 `miniapp/components`、`miniapp/services` 两条指向不存在目录的引用。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeMissingRefTargets, missingRefTargets } from '../../src/domain/refs-exists.ts';
import { refsFromPaths } from '../../src/domain/identity.ts';
import type { Ref } from '../../src/shared/types.ts';

/** 用"存在的路径集合"造一个 pathExists（测试里不碰真实文件系统）。 */
const exists = (...present: string[]) => {
  const set = new Set(present);
  return (target: string): boolean => set.has(target);
};

describe('missingRefTargets：只报"真的不存在"的引用', () => {
  it('① 存在的路径一条都不报（不许误报，否则每次写入都刷告警）', () => {
    const refs = refsFromPaths(['src/domain', 'src/service.ts']);
    assert.deepEqual(missingRefTargets(refs, exists('src/domain', 'src/service.ts')), []);
  });

  it('② 真机那两条不存在的目录引用必须被报出来', () => {
    const refs = refsFromPaths(['miniapp/components', 'miniapp/services', 'miniapp/app.js']);
    const missing = missingRefTargets(refs, exists('miniapp/app.js'));
    assert.deepEqual(
      missing.map((entry) => entry.target),
      ['miniapp/components', 'miniapp/services'],
      '两条不存在的目录引用都要报，且**按路径排序**（顺序稳定才好比对）',
    );
  });

  it('③ 只查 dir / code：note / md / artifact 不在本次范围', () => {
    const refs: Ref[] = [
      { type: 'dir', target: 'no-such-dir' },
      { type: 'code', target: 'no-such-file.ts' },
      { type: 'note', target: 'no-such-note' },
      { type: 'md', target: 'no-such-doc.md' },
      { type: 'artifact', target: 'no-such-artifact.zip' },
    ];
    const missing = missingRefTargets(refs, exists());
    assert.deepEqual(missing.map((entry) => entry.target), ['no-such-dir', 'no-such-file.ts']);
    assert.deepEqual(missing.map((entry) => entry.type), ['dir', 'code']);
  });

  it('④ 同一条路径出现两次只报一次；空路径不算"缺失"', () => {
    const refs: Ref[] = [
      { type: 'dir', target: 'gone' },
      { type: 'dir', target: 'gone' },
      { type: 'code', target: '   ' },
      { type: 'dir', target: '' },
    ];
    const missing = missingRefTargets(refs, exists());
    assert.deepEqual(
      missing.map((entry) => entry.target),
      ['gone'],
      '重复路径去重；空/纯空白路径跳过（否则会把""报成"路径不存在"）',
    );
  });

  it('⑤ 不拒绝任何东西：它只产出清单，写入与否由调用方决定', () => {
    const refs = refsFromPaths(['definitely-not-here']);
    const missing = missingRefTargets(refs, exists());
    assert.equal(missing.length, 1);
    // 返回值形状里**没有** status / error / ok 这类字段 —— 它不做判定，只做记录
    assert.deepEqual(Object.keys(missing[0]!).sort(), ['target', 'type']);
  });
});

describe('describeMissingRefTargets：文案只有一处', () => {
  it('没有缺失 ⇒ 空串（调用方据此决定要不要挂 warnings）', () => {
    assert.equal(describeMissingRefTargets([]), '');
  });

  it('列出路径；超过上限折叠成"等 N 条"', () => {
    const missing = ['b/gone', 'a/gone', 'c/gone'].map((target) => ({ target, type: 'dir' as const }));
    assert.equal(describeMissingRefTargets(missing, 2), 'b/gone、a/gone 等 3 条');
    assert.equal(describeMissingRefTargets(missing, 5), 'b/gone、a/gone、c/gone');
  });
});
