/**
 * **根节点归位的判据**（0.3.35）。
 *
 * 三次真机重建、三次不同的错法（详见 `src/domain/root-normalize.ts` 的文件头），
 * 提示词路线已证伪 ⇒ 判据必须**可核对、不看仓库名、不看技术栈**。
 * 这里把边界逐条钉住，包括"宁愿不动"的那几种歧义情形。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { coreNameOf, decideRootNormalize } from '../../src/domain/root-normalize.ts';

const child = (id: string, name: string) => ({ id, name });

describe('根节点归位：判据只看"同一个东西被建成了两个节点"', () => {
  it('真机第 3 次现场：根是端、项目名是子节点 ⇒ 提升', () => {
    const d = decideRootNormalize(
      'PEIS 体检管理系统',
      'Web 服务端与门户',
      [
        child('a', '门户与登录鉴权'),
        child('b', '数据列表与报表输出'),
        child('c', 'PEIS 体检管理系统'),
        child('d', '控制器与请求处理管道'),
      ],
    );
    assert.equal(d.promoteId, 'c', '项目名那一个必须被提升：' + d.reason);
  });

  it('真机第 2 次现场：项目名与根的自称不同写法（共享核心串）也要命中', () => {
    // 存储里的项目名是「PEIS 体检管理系统」，树里的节点叫「PEIS 体检信息系统」
    const d = decideRootNormalize('PEIS 体检管理系统', 'Web 服务端与业务模块', [
      child('x', '前端页面与布局框架'),
      child('y', 'PEIS 体检信息系统'),
    ]);
    assert.equal(
      d.promoteId,
      'y',
      '共享核心串「PEIS体检」就该命中（用相等关系会漏掉真机这种写法差异）：' + d.reason,
    );
  });

  it('根自己已经是项目本体 ⇒ 不动（命名不同不算错）', () => {
    const d = decideRootNormalize('PEIS 体检管理系统', 'PEIS 体检信息系统', [
      child('a', 'Web 服务端与门户'),
      child('b', '移动端'),
    ]);
    assert.equal(d.promoteId, null, '根已是项目本体就不该动：' + d.reason);
  });

  it('没有同源子节点 ⇒ 不动', () => {
    const d = decideRootNormalize('PEIS 体检管理系统', 'Web 服务端与门户', [
      child('a', '登录与鉴权'),
      child('b', '报表输出'),
    ]);
    assert.equal(d.promoteId, null, d.reason);
  });

  it('命中多个 ⇒ 歧义，宁可不动', () => {
    const d = decideRootNormalize('PEIS 体检管理系统', 'Web 服务端与门户', [
      child('a', 'PEIS 体检管理系统'),
      child('b', 'PEIS 体检管理系统移动端'),
    ]);
    assert.equal(d.promoteId, null, '有歧义就必须不动（不能猜）：' + d.reason);
    assert.match(d.reason, /歧义/);
  });

  it('项目名核心串过短 ⇒ 不做判断（否则包含关系会到处命中）', () => {
    const d = decideRootNormalize('系统', 'Web 端', [child('a', '报表系统'), child('b', '人事系统')]);
    assert.equal(d.promoteId, null, d.reason);
    assert.match(d.reason, /过短/);
  });

  it('coreNameOf：去掉括号注释、空白与分隔符', () => {
    assert.equal(coreNameOf('PEIS 体检管理系统'), 'PEIS体检管理系统');
    assert.equal(coreNameOf('PEIS 卡务模块（Card 区）'), 'PEIS卡务模块');
    assert.equal(coreNameOf('  A - B / C  '), 'ABC');
  });
});
