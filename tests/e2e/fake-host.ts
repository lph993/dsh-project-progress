/**
 * **e2e 用的假宿主上下文**（0.3.34 从 `plugin-smoke.test.ts` 抽出来）。
 *
 * ## 为什么要抽
 *
 * 另一个 e2e 文件（同根多项目的绑定选择）需要**同一套**假上下文。
 * 我第一版直接 `import { createFakeContext } from './plugin-smoke.test.ts'` ——
 * 结果**把那个文件的 59 条测试在同进程里又跑了一遍**（测试总数 577 → 636），
 * 既是噪声也会掩盖真实条数。抽成独立模块后，两边都从这里 import，各跑各的。
 *
 * 依赖：`structureDomainSpec` / `progressDomainSpec` 来自 `src/storage/kv-port.ts`
 * （用宿主真实的 zod schema 校验数据形状，而不是随手造对象）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { structureDomainSpec, progressDomainSpec } from '../../src/storage/kv-port.ts';
import { normalizeRootPath } from '../../src/shared/path.ts';

/**
 * **假 agent 也要守宿主 v4 的来源准入口径**（0.3.2 加）。
 *
 * 为什么测试替身要主动做这件事：0.3.1 的 P0（注入消息用已退役的 `kind: "plugin"`，
 * 被宿主拒绝后**整个回合中断**）之所以一路走到真机，部分原因是测试替身只读
 * `message.source.plugin`、**从不校验 kind** —— 一个真机会拒绝的形状，在测试里畅通无阻。
 * 现在把宿主的判据（`dsh-session-format-v3-to-v4/lib/index.js:126`：非空且不是字面量 `plugin`）
 * 照抄进替身：形状不对就**当场失败**，而不是留到真机上表现为"工具故障、当轮工作丢失"。
 *
 * @param kind - 消息的 `source.kind`（可能是 undefined，那就是不合法）。
 * @param where - 出错的通道名（注入 / 回写），用于报错定位。
 */
export function assertAdmissibleKind(kind: unknown, where: string): string {
  assert.equal(
    typeof kind === 'string' && kind.length > 0 && kind !== 'plugin',
    true,
    `${where}：宿主 v4 只接受生产者自有的、非空的 source.kind，且拒绝已退役的 "plugin"` +
      `（收到 ${JSON.stringify(kind)}）—— 这个形状会让宿主拒绝整条事件并**中断整个回合**`,
  );
  return kind as string;
}

/** 按 DomainSpec 的 zod schema 校验的存储替身。 */
export function createFakeStorageDomain() {
  const domains = new Map<string, { spec: unknown; tables: Map<string, Map<string, unknown>>; global: unknown }>();
  const listeners: Array<(change: unknown) => void> = [];

  const table = (domainName: string, tableName: string) => {
    const domain = domains.get(domainName);
    if (!domain) throw new Error(`domain ${domainName} not open`);
    let store = domain.tables.get(tableName);
    if (!store) {
      store = new Map();
      domain.tables.set(tableName, store);
    }
    const spec = domain.spec as {
      tables: Record<string, { valueSchema?: { parse(value: unknown): unknown } }>;
    };
    const schema = spec.tables[tableName]?.valueSchema;
    if (!schema) throw new Error(`table ${tableName} not in spec`);

    const emit = (key: string, operation: 'put' | 'deleted', value?: unknown) => {
      for (const listener of listeners) listener({ domain: domainName, table: tableName, key, operation, value });
    };

    return {
      get: (key: string) => store.get(key),
      keys: () => store.keys(),
      entries: () => store.entries(),
      get size() {
        return store.size;
      },
      async put(key: string, value: unknown) {
        const parsed = schema.parse(value); // ← 关键：真用 DSH 的 schema 校验
        store.set(key, parsed);
        emit(key, 'put', parsed);
      },
      async delete(key: string) {
        const existed = store.delete(key);
        if (existed) emit(key, 'deleted');
        return existed;
      },
      async update(key: string, fn: (current: unknown) => unknown) {
        const current = store.get(key);
        if (current === undefined) throw new Error('missing-key');
        const next = schema.parse(fn(current));
        store.set(key, next);
        emit(key, 'put', next);
        return next;
      },
    };
  };

  return {
    async open(spec: { name: string; tables: Record<string, unknown>; global?: { schema: { parse(v: unknown): unknown }; initial: unknown } }) {
      const globalValue = spec.global ? spec.global.schema.parse(spec.global.initial) : undefined;
      domains.set(spec.name, { spec, tables: new Map(), global: globalValue });
      return {
        name: spec.name,
        table: (name: string) => table(spec.name, name),
        global: {
          get: () => domains.get(spec.name)?.global,
          set: async (value: unknown) => {
            const parsed = spec.global ? spec.global.schema.parse(value) : value;
            const domain = domains.get(spec.name);
            if (domain) domain.global = parsed;
          },
        },
        close: async () => {
          domains.delete(spec.name);
        },
      };
    },
    on(_event: string, listener: (change: unknown) => void) {
      listeners.push(listener);
      return () => {};
    },
  };
}

/** 最小假文件系统：只实现投影用到的两个方法。 */
export function createFakeFs(workspace: string) {
  const files = new Map<string, string>();
  return {
    files,
    async resolve(path: string) {
      return { targetKey: path, displayPath: join(workspace, path) };
    },
    async readText(target: { targetKey: string }) {
      const content = files.get(target.targetKey);
      if (content === undefined) throw new Error('FS_NOT_OBSERVED');
      return content;
    },
    async writeText(target: { targetKey: string }, content: string) {
      files.set(target.targetKey, content);
      return { operation: 'update', version: 'v1', before: null, after: content };
    },
  };
}

/** 本文件创建过的假上下文（供失败兜底卸载，见文件末尾的 `after`）。 */
export const createdContexts: Array<{ disposeAll(): void }> = [];

/**
 * **模块级假模型流**：把一段 JSON 当成模型的输出喂进去（不烧真 token）。
 *
 * 与用例内部的 `fakeStream` 同一形态；提出来是因为它现在被不止一处用
 * （0.3.23 的"面板发起的建树必须落在面板作用域"那条回归用例也要它）。
 */
export function fakeAiStream(json: string): {
  stream: () => AsyncGenerator<Record<string, unknown>>;
} {
  return {
    stream: () =>
      (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: json.slice(0, 40) };
        yield { type: 'text-delta', index: 0, text: json.slice(40) };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: json } };
        yield { type: 'finish', reason: 'stop' };
      })(),
  };
}

/** 最小假 cordis 上下文。 */
export function createFakeContext(options: { workspace: string; agents?: unknown }) {  const services = new Map<string, unknown>();
  const storage = createFakeStorageDomain();
  const fs = createFakeFs(options.workspace);
  const tools = new Map<string, unknown>();
  const settingsNamespaces: string[] = [];
  const effects: Array<() => void> = [];
  const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const logs: string[] = [];
  /** `ctx.inject` 的调用记录（用于断言"确实走了官方声明式路径"）。 */
  const injectCalls: Array<{ deps: string[]; ran: boolean }> = [];

  services.set('storageDomain', storage);
  services.set('fs', fs);
  // agent 注册表替身（可选）：只有需要"按会话精确解析工作区"的用例才装它
  if (options.agents !== undefined) services.set('agents', options.agents);
  /**
   * 工作区注册表替身。
   *
   * 真实 DSH 里它是 `ctx.workspaceRegistry`，`list()` 返回 `{ path, title, updatedAt }`。
   * 插件用它来解决"面板在没有工具调用时不知道工作区根"的问题（实测踩过：看板因此空着）。
   */
  services.set('workspaceRegistry', {
    list: () => [
      {
        path: options.workspace,
        title: 'test-workspace',
        sessionIds: ['session-in-workspace'],
        updatedAt: '2026-01-02T00:00:00Z',
      },
      {
        path: join(options.workspace, 'older'),
        title: 'older',
        sessionIds: [],
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ],
  });
  services.set('approval', {
    async request() {
      return 'allowed-once' as const;
    },
  });
  services.set('userQuestions', {
    async ask() {
      return { answers: [] };
    },
  });
  /** 捕获注册的 HTTP 路由，便于在测试里直接调用 handler。 */
  const registeredRoutes: Array<{
    kind: string;
    path: string;
    handler: (req: unknown, res: unknown) => void | Promise<void>;
  }> = [];

  services.set('webServer', {
    register(route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }) {
      registeredRoutes.push(route);
      return () => {};
    },
  });

  const ctx = {
    get: (key: string) => services.get(key),
    set: (key: string, value: unknown) => {
      services.set(key, value);
    },
    on: (event: string, listener: (...args: unknown[]) => unknown) => {
      const list = events.get(event) ?? [];
      list.push(listener);
      events.set(event, list);
      return () => {};
    },
    effect: (callback: () => (() => void) | void) => {
      const dispose = callback();
      if (typeof dispose === 'function') effects.push(dispose);
      return () => {};
    },
    // 与真实 cordis 对齐：`provide` 注册**新**服务并返回 disposer；
    // `set` 只允许覆盖已提供的服务（首次装入时就是用错 set 才炸的）。
    provide: (key: string, value?: unknown) => {
      if (services.has(key)) throw new Error(`cannot provide "${key}" twice`);
      services.set(key, value);
      return () => services.delete(key);
    },
    set: (key: string, value: unknown) => {
      if (!services.has(key)) {
        throw new Error(`cannot set property "${key}" without provide`);
      }
      services.set(key, value);
    },
    /**
     * 官方的**依赖声明式**加载：`ctx.inject(deps, cb)` —— 这在真宿主上是**唯一**能拿到
     * 未在插件 `inject` 里声明的服务的路（官方 `dsh-client-modules` 就是
     * `if (ctx.get("webServer") === void 0) ctx.inject(["webServer"], …)`）。
     *
     * 替身按官方语义实现：依赖齐了就**同步**回调；不齐就保持待定（不回调、不报错）。
     * 少了它，测试就只会走回退路径，真机上"服务是 PENDING"这件事永远测不到 ——
     * 而提示词层第一次真机实测就是这么静默失败的。
     */
    inject: (deps: string[], callback: (scoped: unknown) => void) => {
      const ran = deps.every((name) => services.has(name));
      injectCalls.push({ deps: [...deps], ran });
      if (ran) {
        // 真 cordis 的语义：注入后的作用域 ctx 上，这些服务是**可读属性**
        //（这正是"未声明的服务拿不到、声明了就能拿到"的全部区别）
        const scoped = Object.create(ctx) as Record<string, unknown>;
        for (const name of deps) scoped[name] = services.get(name);
        callback(scoped);
      }
      return () => {};
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of events.get(event) ?? []) listener(...args);
    },
    tools: {
      register: (definition: { name: string }) => {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    settings: {
      /**
       * 设置服务替身：**会真的合并补丁、真的通知订阅者**。
       *
       * 早先这里是个"什么都返回空"的桩，于是"设置页改一项 → 运行中的服务立刻用新值"
       * 这条链路完全没有覆盖。现在它按官方语义来：
       * `update(patch)` 合并进用户层 → 用注册时的 schema 校验 → 通知 watcher。
       */
      register: (
        namespace: string,
        schema?: (value: unknown) => unknown,
        options?: { applies?: string },
      ) => {
        settingsNamespaces.push(namespace);
        let section: Record<string, unknown> = {};
        const watchers: Array<(next: unknown, prev: unknown) => unknown> = [];
        const validate = (value: unknown): unknown => (schema ? schema(value) : value);
        const current = (): unknown => validate({ ...section });
        return {
          get: current,
          applies: options?.applies,
          watch: (callback: (next: unknown, prev: unknown) => unknown) => {
            watchers.push(callback);
            return () => {
              const index = watchers.indexOf(callback);
              if (index >= 0) watchers.splice(index, 1);
            };
          },
          update: async (patch: Record<string, unknown>) => {
            const prev = current();
            // 校验的是**合并后**的完整值：schemastery 的默认值会补齐缺失字段
            const next = validate({ ...section, ...patch });
            section = { ...section, ...patch };
            for (const watcher of watchers) await watcher(next, prev);
          },
          replace: async (next: Record<string, unknown>) => {
            const prev = current();
            section = { ...next };
            const resolved = current();
            for (const watcher of watchers) await watcher(resolved, prev);
          },
        };
      },
    },
    logger: {
      info: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
      error: (message: string) => logs.push(message),
    },
    services,
    fsService: fs,
    storage,
    toolRegistry: tools,
    settingsNamespaces,
    effects,
    events,
    logs,
    injectCalls,
    registeredRoutes,
    /**
     * 模拟 cordis 的**纤维卸载**：按注册逆序执行全部 effect disposer。
     *
     * 必须有这一步：插件注册了 chokidar 监听（外部改动感知），若测试结束时不卸载，
     * 监听会一直挂在事件循环上 —— Node 的测试进程会**一直等**（实测超时 120s）。
     */
    disposeAll() {
      for (const dispose of [...effects].reverse()) {
        try {
          dispose();
        } catch {
          // 卸载期异常忽略
        }
      }
      effects.length = 0;
    },
    /**
     * **把工具注册表暴露给测试**（键 = 工具名 → `defineTool` 的定义对象，含 `execute`）。
     *
     * 为什么叫 `toolDefs` 而不是 `tools`：`ctx.tools` 这个名字被上方的**注册入口**
     * （`{ register }`）占着 —— 插件要用它，不能让给测试（实测覆盖它会炸掉全部 e2e）。
     *
     * 为什么需要它：只断言"工具名注册了"是不够的 —— 工具自己的**参数处理与返回整形**是插件逻辑的一部分
     * （`pm_board` 的 `includeStale` 这类映射，光看服务层测不到；注册名对了但返回错了照样是 bug）。
     */
    toolDefs: tools,
  };
  createdContexts.push(ctx);
  return ctx;
}