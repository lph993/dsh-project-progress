/**
 * 「为未归属的改动新建节点」的默认值逻辑（0.3.69）。
 *
 * 这些是**默认值**，猜错也不会造成数据损失（输入框可改）；但默认值离谱时用户要多改三秒，
 * 而"公共目录"这种算法最容易写成"字符串前缀"（`src/ab` 与 `src/ac` 会算出 `src/a`）。
 * 所以按**整段**比较，并用测试钉住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  commonDirOf,
  dirOf,
  normalizeForLabel,
  refTypeOf,
  suggestNodeName,
} from '../../src/client/uncovered.ts';

test('路径归一 + 取父目录', () => {
  assert.equal(normalizeForLabel('./src\\a.ts'), 'src/a.ts');
  assert.equal(normalizeForLabel('src/ai/'), 'src/ai');
  assert.equal(dirOf('src/ai/prompt.ts'), 'src/ai');
  assert.equal(dirOf('a.ts'), '');
  assert.equal(dirOf('/abs/a.ts'), '/abs', '绝对路径不在 refs 契约里；这里只保证不崩、可预测');
});

test('公共目录按整段比较，不做字符串前缀', () => {
  assert.equal(commonDirOf(['src/ab/x.ts', 'src/ac/y.ts']), 'src', '不能算出 src/a');
  assert.equal(
    commonDirOf([
      'updater-rust/src/bin/updater/pkgbuild.rs',
      'updater-rust/src/bin/updater.rs',
    ]),
    'updater-rust/src/bin',
  );
  assert.equal(commonDirOf(['a.ts', 'b.ts']), '', '都在根下 ⇒ 没有公共目录');
  assert.equal(commonDirOf([]), '');
});

test('默认节点名：公共目录 + 中文前缀；根下退回纯前缀', () => {
  assert.equal(
    suggestNodeName(['updater-rust/src/bin/updater/pkgbuild.rs']),
    '未归类改动（updater-rust/src/bin/updater）',
  );
  assert.equal(suggestNodeName(['a.ts']), '未归类改动');
  assert.equal(suggestNodeName([]), '未归类改动');
});

test('引用类型按扩展名推：文档 / 二进制 / 其它代码', () => {
  assert.equal(refTypeOf('docs/变更记录.md'), 'md');
  assert.equal(refTypeOf('README.MD'), 'md');
  assert.equal(refTypeOf('assets/logo.png'), 'artifact');
  assert.equal(refTypeOf('target/app.exe'), 'artifact');
  assert.equal(refTypeOf('src/main.rs'), 'code');
  assert.equal(refTypeOf('Makefile'), 'code');
});
