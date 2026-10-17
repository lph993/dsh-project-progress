/**
 * **设置服务兼容层**（0.3.55，真机报错驱动）。
 *
 * ## 现场
 *
 * 真机每次加载都报：`设置命名空间注册失败：ctx.settings.register is not a function`
 *
 * 宿主现在给的是 `SettingsForms`（`describe/update/replace/configure`），**没有 `register`**。
 * 后果不只是那条 warn：`settingsScope` 恒为 undefined ⇒ `POST /pm/settings` 一律
 * **409 `settings-unavailable`**（设置页存不了东西）。
 *
 * 这组用例把两种宿主形态都钉住，并确保第三种（都不像）**如实说、不假装能用**。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bindSettings } from '../../src/adapter/settings-compat.ts';

const NS = 'project-manager';

test('老宿主（有 register）：走原生 scope，liveApply = true', () => {
  const calls: unknown[][] = [];
  const nativeScope = {
    get: () => ({ refreshIntervalMs: 1000 }),
    update: async () => {},
    replace: async () => {},
    watch: () => () => {},
  };
  const binding = bindSettings(
    {
      register: (...args: unknown[]) => {
        calls.push(args);
        return nativeScope;
      },
    },
    NS,
    [{ type: 'schema' }, { applies: 'live' }],
  );
  assert.equal(binding.kind, 'native');
  assert.equal(calls.length, 1, '应当调用 register');
  assert.equal(calls[0]?.[0], NS, '第一个参数是命名空间');
  assert.equal(binding.kind === 'native' && binding.liveApply, true, '老宿主能实时应用');
});

test('新宿主（SettingsForms）：拼出等价 scope，update 打到 describe 找到的条目上', async () => {
  const updated: Array<{ ns: string; patch: object; revision?: number }> = [];
  const settings = {
    describe: () => [
      { ns: 'other-plugin', value: { a: 1 }, revision: 7 },
      { ns: 'project-manager', value: { refreshIntervalMs: 500 }, revision: 42 },
    ],
    update: async (ns: string, patch: object, revision?: number) => {
      updated.push({ ns, patch, revision });
    },
    replace: async () => {},
    configure: () => () => {},
  };
  const binding = bindSettings(settings, NS, [{ type: 'schema' }]);
  assert.equal(binding.kind, 'forms', '这是宿主现在的形态，必须认出来');
  assert.equal(binding.kind === 'forms' && binding.liveApply, false, '新宿主没有 watch，不许谎称实时');
  assert.deepEqual(binding.scope.get(), { refreshIntervalMs: 500 }, 'get 要读到我们自己那条的 value');

  await binding.scope.update({ refreshIntervalMs: 800 });
  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.ns, 'project-manager', '**必须打到我们自己的条目**，不能打别人的配置');
  assert.equal(updated[0]?.revision, 42, '要把 revision 带上（宿主靠它做乐观锁）');
});

test('新宿主：describe 里找不到我们 ⇒ update 明确抛错（不静默写错配置）', async () => {
  const updated: unknown[] = [];
  const binding = bindSettings(
    {
      describe: () => [{ ns: 'somebody-else', value: {}, revision: 1 }],
      update: async (...args: unknown[]) => {
        updated.push(args);
      },
      replace: async () => {},
    },
    NS,
  );
  assert.equal(binding.kind, 'forms');
  await assert.rejects(
    () => binding.scope.update({ x: 1 }),
    /找不到命名空间/,
    '**宁可报错，也不要去改别人的配置**',
  );
  assert.equal(updated.length, 0, '一次写都不许发出去');
});

test('两种都不像 ⇒ kind = none，并把实际字段列出来（别让人猜）', () => {
  const binding = bindSettings({ weird: true }, NS);
  assert.equal(binding.kind, 'none');
  assert.match(binding.detail, /register/);
  assert.match(binding.detail, /weird/, '要说出宿主实际有什么字段');
});

test('register 返回的不是 scope（缺 get/update）⇒ 如实报 none，而不是拿个半成品去用', () => {
  const binding = bindSettings({ register: () => ({}) }, NS);
  assert.equal(binding.kind, 'none');
  assert.match(binding.detail, /不是 scope/);
});

test('register 抛错 ⇒ none（不把异常冒到插件加载路径上）', () => {
  const binding = bindSettings(
    {
      register: () => {
        throw new Error('already registered');
      },
    },
    NS,
  );
  assert.equal(binding.kind, 'none');
  assert.match(binding.detail, /already registered/);
});

test('候选名：条目 id 是包名时也能认出来（真机风险）', () => {
  /**
   * 我们内部的命名空间是 `project-manager`，但宿主 `describe()` 里的条目 id
   * 很可能是**包名** `dsh-project-progress`。只给一个名字就会"找不到自己"，
   * 于是设置页虽然能显示、**保存时却报 settings-unavailable**。
   */
  const updated: string[] = [];
  const binding = bindSettings(
    {
      describe: () => [{ ns: 'dsh-project-progress', value: { a: 1 }, revision: 3 }],
      update: async (ns: string) => {
        updated.push(ns);
      },
      replace: async () => {},
    },
    ['project-manager', 'dsh-project-progress'],
  );
  assert.equal(binding.kind, 'forms');
  assert.deepEqual(binding.scope.get(), { a: 1 }, '要按包名找到自己那一条');
  return binding.scope.update({ a: 2 }).then(() => {
    assert.deepEqual(updated, ['dsh-project-progress'], '写到条目自己的 id 上');
  });
});
