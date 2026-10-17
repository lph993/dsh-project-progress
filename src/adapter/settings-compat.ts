/**
 * **设置服务的兼容层**（0.3.55）。
 *
 * ## 现场
 *
 * 真机上每次加载都报一条 warn：
 *
 * ```
 * 设置命名空间注册失败（将使用组合配置默认值）：ctx.settings.register is not a function
 * ```
 *
 * 原因是宿主的 `ctx.settings` 已经不是"每插件一个 scope"那套了：
 *
 * | | 老宿主 | 现在的 `@deepseek-ai/dsh-settings` |
 * |---|---|---|
 * | 顶层类型 | `Context.settings: SettingsScope` | `Context.settings: SettingsForms` |
 * | 注册 | `settings.register(ns, schema, {applies})` → scope | **没有 register** |
 * | 页面 | 自己注册 | **由宿主按插件导出的 `Config` 自动生成**（`configure({auto})` 只调策略） |
 * | 读写 | `scope.get()/update()/replace()/watch()` | `describe()` / `update(ns,patch,rev)` / `replace(ns,section,rev)` / `mutate()` |
 * | 变更通知 | `scope.watch(cb)` | **没有 watch**（`applies: 'live'`，由宿主把新配置重新注入） |
 *
 * ## 后果（这才是要修的）
 *
 * `settingsScope` 一直是 `undefined` ⇒ `GET /pm/settings` 报 `configurable: false`、
 * **`POST /pm/settings` 直接 409 `settings-unavailable`** ⇒ 设置页存不了任何东西。
 *
 * ## 做法
 *
 * 探测宿主形态，能适配就适配，适配不了才如实说（**并把 warning 降成 info** ——
 * 设置页由宿主自动生成这件事本身不是错误）。
 *
 * 这一层是**纯函数**（不 import cordis、不碰 fs），所以能真跑类型检查与单测。
 */

/** `http.ts` 里要的最小面：设置页只用这三个。 */
export interface CompatScope {
  get(): unknown;
  update(patch: object): Promise<void>;
  replace(section: object): Promise<void>;
}

export type SettingsBinding =
  /** 老宿主：`register` 拿到原生 scope（带 `watch`，能实时应用）。 */
  | { kind: 'native'; scope: CompatScope; liveApply: true; detail: string }
  /** 新宿主：用 `describe/update/replace` 拼一个等价 scope。 */
  | { kind: 'forms'; scope: CompatScope; liveApply: boolean; detail: string }
  /** 两种都不像 —— 如实说，别假装能用。 */
  | { kind: 'none'; detail: string };

/** 宿主 `ctx.settings` 的可能形状（松散，因为版本间会变）。 */
export interface SettingsLike {
  register?: (...args: unknown[]) => unknown;
  configure?: (presentation: { auto?: boolean }) => () => void;
  describe?: (options?: { redactSecrets?: boolean }) => unknown;
  update?: (ns: string, patch: object, revision?: number) => Promise<void>;
  replace?: (ns: string, section: object, revision?: number) => Promise<void>;
  writable?: boolean;
}

/** `describe()` 返回的条目（只取我们要用的字段）。 */
interface DescriptorLike {
  ns?: unknown;
  value?: unknown;
  revision?: unknown;
  applies?: unknown;
}

const asDescriptorList = (value: unknown): DescriptorLike[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is DescriptorLike => typeof item === 'object' && item !== null);
};

/**
 * 找出"我们自己那一条"描述符。
 *
 * `ns` 在宿主里是**配置条目 id**，不一定等于我们内部的命名空间标识
 * （真机上那两条就是这样对不上：我们叫 `project-manager`，条目 id 可能是包名 `dsh-project-progress`）。
 * 所以**接受一组候选名**：先精确匹配、再包含匹配；
 * 都对不上时**返回 undefined** —— 宁可说"找不到"，也不要去改别人的配置。
 */
const findDescriptor = (list: readonly DescriptorLike[], names: readonly string[]): DescriptorLike | undefined => {
  /** ① 精确匹配优先（任意一个候选名都算）。 */
  for (const name of names) {
    if (name === '') continue;
    const exact = list.find((item) => String(item.ns ?? '') === name);
    if (exact !== undefined) return exact;
  }
  /** ② 再退一步做包含匹配（条目 id 常带前缀/后缀）。 */
  for (const name of names) {
    if (name === '') continue;
    const loose = list.find((item) => String(item.ns ?? '').includes(name));
    if (loose !== undefined) return loose;
  }
  return undefined;
};

/**
 * 绑定设置服务。
 *
 * @param settings 宿主注入的 `ctx.settings`（形状未知，各版本不同）
 * @param namespaces 候选命名空间标识（**可以是数组**：我们内部叫 `project-manager`，
 *   而宿主 `describe()` 里的条目 id 可能是包名 `dsh-project-progress` —— 只给一个名字迟早对不上）
 * @param registerArgs 老宿主 `register()` 的其余参数（schema 等），仅 native 路径用
 */
export function bindSettings(
  settings: unknown,
  namespaces: string | readonly string[],
  registerArgs: readonly unknown[] = [],
): SettingsBinding {
  const names = typeof namespaces === 'string' ? [namespaces] : [...namespaces];
  /** 老宿主的 `register()` 只接受一个名字，用主名。 */
  const namespace = names[0] ?? '';
  if (settings === null || typeof settings !== 'object') {
    return { kind: 'none', detail: '宿主没有提供 settings 服务' };
  }
  const service = settings as SettingsLike;

  /** ① 老宿主：有 `register`，原样用（它给的 scope 自带 watch）。 */
  if (typeof service.register === 'function') {
    try {
      const scope = service.register(namespace, ...registerArgs) as Partial<CompatScope> | undefined;
      if (scope !== undefined && typeof scope.update === 'function' && typeof scope.get === 'function') {
        return {
          kind: 'native',
          scope: scope as CompatScope,
          liveApply: true,
          detail: `已注册设置命名空间 ${namespace}（原生 scope，带变更订阅）`,
        };
      }
      return { kind: 'none', detail: 'settings.register 返回的对象不是 scope（缺少 get/update）' };
    } catch (error) {
      return {
        kind: 'none',
        detail: `settings.register 抛错：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** ② 新宿主：`SettingsForms`（describe/update/replace）。 */
  if (
    typeof service.describe === 'function' &&
    typeof service.update === 'function' &&
    typeof service.replace === 'function'
  ) {
    /**
     * 页面由宿主按插件导出的 `Config` 自动生成；`configure({auto:true})` 只是把策略说明白。
     * 它**在重复注册时会抛**，所以单独 try 掉 —— 失败不该让整条设置通路失效。
     */
    let configureNote = '页面由宿主按 Config 自动生成';
    if (typeof service.configure === 'function') {
      try {
        service.configure({ auto: true });
      } catch (error) {
        configureNote += `（configure 未生效：${error instanceof Error ? error.message : String(error)}）`;
      }
    }
    /** 每条读写都现查一次 `describe()`：宿主是权威，缓存一份本地副本迟早不一致。 */
    const lookup = (): { ns: string; revision?: number } | undefined => {
      const found = findDescriptor(asDescriptorList(service.describe?.()), names);
      if (found === undefined) return undefined;
      const ns = String(found.ns ?? '');
      if (ns === '') return undefined;
      return {
        ns,
        ...(typeof found.revision === 'number' ? { revision: found.revision } : {}),
      };
    };
    const scope: CompatScope = {
      get: () => {
        const found = findDescriptor(asDescriptorList(service.describe?.()), names);
        return found?.value;
      },
      update: async (patch) => {
        const target = lookup();
        if (target === undefined) throw new Error(`settings.describe() 里找不到命名空间「${namespace}」`);
        await service.update?.(target.ns, patch, target.revision);
      },
      replace: async (section) => {
        const target = lookup();
        if (target === undefined) throw new Error(`settings.describe() 里找不到命名空间「${namespace}」`);
        await service.replace?.(target.ns, section, target.revision);
      },
    };
    const probe = lookup();
    return {
      kind: 'forms',
      scope,
      /** 没有 `watch` ⇒ 变更要等宿主把新配置注入下一次读取；不承诺实时。 */
      liveApply: false,
      detail:
        probe === undefined
          ? `设置页由宿主自动生成（${configureNote}）；但 describe() 里暂时找不到「${namespace}」—— 首次保存会再找一次`
          : `设置页由宿主自动生成（${configureNote}），已接上 describe/update（条目 id=${probe.ns}）`,
    };
  }

  return {
    kind: 'none',
    detail: `宿主 settings 既没有 register 也没有 describe/update/replace（实际字段：${Object.keys(
      service,
    ).join(',')}）`,
  };
}
