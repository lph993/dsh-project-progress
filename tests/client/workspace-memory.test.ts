/**
 * 看板作用域记忆（0.3.7）。
 *
 * 用户原话："项目进度里切换工作区不能记忆，每次点进去都要重新选。"
 * 0.3.6 的手动选择只存在组件 `useState` 里，面板一卸载就没了。
 *
 * 这个文件钉两件事：
 * 1. **按会话存**（`dsh.pm.scope.<sessionId>`）—— 同一个会话里反复进出要记住；
 * 2. **没有会话 id 就不存** —— 匿名时存下来的东西属于谁不明确，下一次有会话时会误用。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  readRememberedScope,
  scopeStorageKey,
  writeRememberedScope,
  type KeyValueStoreLike,
} from '../../src/client/workspace-memory.ts';

/** 内存版存储（单测里替掉 localStorage）。 */
function fakeStore(seed: Record<string, string> = {}): KeyValueStoreLike & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    dump: () => Object.fromEntries(map),
  };
}

describe('scopeStorageKey：按会话分键', () => {
  it('有会话 id 才给键（匿名不记忆）', () => {
    assert.equal(scopeStorageKey('session-a'), 'dsh.pm.scope.session-a');
    assert.equal(scopeStorageKey(undefined), undefined);
    assert.equal(scopeStorageKey(''), undefined);
  });

  it('不同会话互不覆盖（这是"跨会话自动失效"的机制）', () => {
    const store = fakeStore();
    writeRememberedScope(store, 'session-a', 'e:/WxObj/COP');
    writeRememberedScope(store, 'session-b', 'e:/CSP/ReportWorker');
    assert.equal(readRememberedScope(store, 'session-a'), 'e:/WxObj/COP');
    assert.equal(readRememberedScope(store, 'session-b'), 'e:/CSP/ReportWorker');
    // 第三个会话没有记忆 ⇒ 面板回到"会话所属"那一档，不会被旧记忆按住
    assert.equal(readRememberedScope(store, 'session-c'), undefined);
  });
});

describe('读写：不抛、不编', () => {
  it('存了就能读回来（这就是"点进去不用重选"）', () => {
    const store = fakeStore();
    writeRememberedScope(store, 's1', 'e:/a');
    assert.equal(readRememberedScope(store, 's1'), 'e:/a');
  });

  it('存储不可用（隐私模式 / SSR）⇒ 读 undefined、写静默放弃', () => {
    assert.equal(readRememberedScope(undefined, 's1'), undefined);
    assert.doesNotThrow(() => writeRememberedScope(undefined, 's1', 'e:/a'));
  });

  it('存储抛异常也不外溢（丢的是视图偏好，不是数据）', () => {
    const hostile: KeyValueStoreLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    assert.equal(readRememberedScope(hostile, 's1'), undefined);
    assert.doesNotThrow(() => writeRememberedScope(hostile, 's1', 'e:/a'));
  });

  it('空路径不写（写空等于把记忆清成一个无效值）', () => {
    const store = fakeStore();
    writeRememberedScope(store, 's1', '');
    assert.equal(readRememberedScope(store, 's1'), undefined);
  });

  it('没有会话 id 时既不读也不写', () => {
    const store = fakeStore({ 'dsh.pm.scope.': 'e:/stale' });
    assert.equal(readRememberedScope(store, undefined), undefined);
    writeRememberedScope(store, undefined, 'e:/a');
    assert.deepEqual(store.dump(), { 'dsh.pm.scope.': 'e:/stale' });
  });
});
