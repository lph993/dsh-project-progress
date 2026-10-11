/**
 * 首次扫描：零 token 骨架（FR-38 / FR-39 阶段 A）。
 *
 * 设计要点（§6.4b）：
 * - 阶段 A **完全不调 AI**：只看文件树、`package.json`、README、目录结构、已有 md；
 * - 产物是"草稿树"，立即可见（FR-39a），不等待任何模型调用；
 * - 产物节点标 `autoCreated`（FR-39d），与用户手建节点在 UI 上可区分；
 * - 只做**抽样与推断**，不保证任务清单完整（§0.1 边界声明）。
 *
 * 本模块是**纯函数**：输入已遍历好的文件清单，输出建议节点树。
 * 真正的磁盘遍历在 `src/adapter/workspace.ts`。
 */

import type { NodeKind } from '../shared/types.ts';
import {
  DEFAULT_HEURISTIC_COEFFICIENTS,
  computeHeuristicScore,
  isStructurallyDegenerate,
  scoreLeaf,
  type HeuristicCoefficients,
  type HeuristicSignals,
  type HeuristicWeightDetail,
} from '../weight/heuristic.ts';

/** 一个被扫描到的文件/目录条目。 */
export interface ScannedEntry {
  /** 工作区相对路径（`/` 分隔，目录不带尾斜杠）。 */
  path: string;
  kind: 'file' | 'dir';
  sizeBytes?: number;
  /**
   * 文本文件行数（阶段 A 统计；供零 token 启发式权重轨使用，§9.3a）。
   *
   * 读盘受限（文件过大、读取失败、读盘预算耗尽）时为**估算值**，并由
   * `lineCountEstimated` 如实标注 —— 不允许把估算当成实测。
   */
  lineCount?: number;
  /** `lineCount` 是否为估算值。 */
  lineCountEstimated?: boolean;
}

/** 扫描参数（对应设置项 FR-81）。 */
export interface ScanOptions {
  /** 目录深度上限（超过则不再下钻）。默认 3。 */
  maxDepth: number;
  /** 单个目录下最多取多少个子项（防止根目录巨大时节点爆炸）。默认 12。 */
  maxChildrenPerDir: number;
  /** 最多产出多少个节点（硬上限，超出即截断并如实标注）。默认 200。 */
  maxNodes: number;
  /** 包含 glob（空数组表示全部）。 */
  include: string[];
  /** 排除 glob。 */
  exclude: string[];
  /** 根目录名（用于建议项目名）。 */
  rootDirName?: string;
  /** `package.json` 的 name（由调用方读盘后传入，用于建议项目名）。 */
  packageName?: string;
  /**
   * 是否给叶节点附**启发式权重**（§9.3a）。
   *
   * **默认关闭**（实测反馈后改的）：节点的语义是「功能点 / 任务点」，进度说的是
   * "这个任务做完了多少"，而**代码行数回答不了"还剩多少要写"** —— 未写的代码没有行数。
   * 所以默认口径就是**按件数**（每个任务点等权）；权重只在用户显式开启
   * 或在 AI 测量轨拿到相对工作量时才使用（`src/ai/` 尚未实现）。
   */
  attachWeights?: boolean;
  /** 启发式权重系数（仅在 `attachWeights` 为真时生效）。 */
  coefficients?: HeuristicCoefficients;
}

export const DEFAULT_SCAN_OPTIONS: ScanOptions = {
  maxDepth: 3,
  maxChildrenPerDir: 12,
  maxNodes: 200,
  include: [],
  exclude: [],
};

/**
 * **非代码产物**（第三方环境 / 各类缓存 / 构建输出）的排除项 —— 每个生态都要排。
 *
 * ## 为什么单独列一份、而且必须共享
 *
 * 批次 70 的教训（真机）：原排除表**只排 JS 生态**（`node_modules`/`dist`/`.next`…），
 * Python 与 Rust 生态一个都没排。后果在 2026-10-11 的 AIG 工作区上完整复现 ——
 * 那个工作区 `.venv` 有 **67233** 个文件、`server` 17151、`nrfunc-rs` 20215，
 * 建树骨架被非代码文件整片淹掉，模型只能抓着几个"文本丰富"的目录编树，
 * 结果建出来 5 个分支全在描述编辑器脚手架，真正的代码一个节点都没有。
 *
 * 所以：**扫描用的表与建树用的表必须引用同一份定义**。各写一份迟早会漂
 * （本仓库对重复常量的口径见 `aiMaxOutputTokens` 的注释）。
 *
 * ## 写法
 *
 * 按批次 70 实测钉住的 glob 语义：以"双星号目录 + 名字"写成的 glob **同时覆盖根层与
 * 任意嵌套层**，且**不跨目录名**（`a/任意目录/node_modules` 能匹配，而 `a/xnode_modules`
 * 不能）—— 所以这里一律用这一种形式，不必再补一条裸名。
 */
export const NON_CODE_ARTIFACT_EXCLUDE: readonly string[] = [
  // ── Python：虚拟环境、字节码与各种工具缓存 ──────────────────
  '**/.venv',
  '**/venv',
  '**/__pycache__',
  '**/.mypy_cache',
  '**/.pytest_cache',
  '**/.ruff_cache',
  '**/.tox',
  '**/.eggs',
  // ── Rust / JVM 的构建输出 ────────────────────────────────
  '**/target',
  '**/.gradle',
  // ── 运行期输出（不是功能）────────────────────────────────
  '**/logs',
];

/**
 * 上面这张表**故意没有**的两类，以及为什么（2026-10-11 实测后删掉的）。
 *
 * 本仓库的 glob **不支持单个星号通配**（只认双星号），实测：
 * - 以"双星号 + 斜杠"开头、再跟"单星号 + 点 + egg-info"的写法，对
 *   `a/b.egg-info/PKG-INFO` 不匹配；
 * - 以"双星号 + 斜杠"开头、再跟点 venv 加单星号的写法，对
 *   `aitest/.venv_dsocr/bin/python` 与 `server/.venv/lib/x.py` 都不匹配；
 *   而同一条 `server/.venv/lib/x.py` 用表里现有的点 venv 那条**能**匹配 ——
 *   说明是单星号没生效，不是路径写错了。
 *
 * 所以"名字可变的目录"（`<包名>.egg-info`、`.venv_dsocr` 这类）**表达不出来**。
 * 这类模式**宁可不写**：写一条永不命中的排除项，会让后人以为它已经排掉了 ——
 * 那比缺一条更坏（批次 70 的教训就是"按假设写 glob"）。
 * 真机上遇到具体名字时，用设置页的 `scanExclude`（会叠加在这张表之上）单独补即可。
 */

/**
 * 入口文件 / 关键文件的识别表（阶段 A 的"只读入口文件"，§9.5 T4）。
 *
 * 注意它同时含**目录**条目（`src` / `docs` / `packages` …）：`isKeyFileName` 只对
 * **文件名**做匹配，所以这些目录条目实际上只会命中同名文件。这是原有行为，保留原样
 * （改名会牵动 AI 建树那份签名清单，不在本次清理范围内）。
 */
const ENTRY_FILE_PATTERNS: Array<{
  pattern: RegExp;
  label: string;
  origin: 'directory' | 'entry-file' | 'doc' | 'module-dir';
}> = [
  { pattern: /^package\.json$/, label: '依赖与脚本清单', origin: 'entry-file' },
  { pattern: /^pnpm-workspace\.yaml$/, label: '工作区定义', origin: 'entry-file' },
  { pattern: /^tsconfig.*\.json$/, label: 'TS 编译配置', origin: 'entry-file' },
  { pattern: /^README\.md$/i, label: '项目说明', origin: 'doc' },
  { pattern: /^CHANGELOG\.md$/i, label: '变更记录', origin: 'doc' },
  { pattern: /^docs?$/i, label: '文档目录', origin: 'doc' },
  { pattern: /^src$/i, label: '源码目录', origin: 'module-dir' },
  { pattern: /^packages$/i, label: '多包目录', origin: 'module-dir' },
  { pattern: /^apps$/i, label: '应用目录', origin: 'module-dir' },
  { pattern: /^test(s)?$/i, label: '测试目录', origin: 'module-dir' },
  { pattern: /^scripts$/i, label: '脚本目录', origin: 'module-dir' },
];

/** 该文件名是否属于"关键文件"（供 AI 建树只读入口文件时复用同一张表）。 */
export function isKeyFileName(fileName: string): boolean {
  return ENTRY_FILE_PATTERNS.some((item) => item.pattern.test(fileName));
}

/**
 * 没有实测行数时，用字节数估算行数的**保守**比值（§9.3a 的诚实边界）。
 *
 * 40 字节/行是"代码文件平均行长"的粗估：写成估算值而不是假装实测，
 * 是为了让用户能在 `weightDetail.signals.lineCountEstimated` 里看见这一点。
 */
export const BYTES_PER_LINE_ESTIMATE = 40;


/** 目录名 → 人类可读节点名（避免把 `src` 直接当节点名）。 */
const DIR_LABELS: Record<string, string> = {
  src: '源码',
  source: '源码',
  lib: '库代码',
  packages: '子包',
  apps: '应用',
  docs: '文档',
  doc: '文档',
  test: '测试',
  tests: '测试',
  spec: '测试',
  specs: '测试',
  scripts: '脚本',
  tools: '工具',
  config: '配置',
  configs: '配置',
  assets: '资源',
  public: '静态资源',
  static: '静态资源',
  styles: '样式',
  types: '类型定义',
  utils: '工具函数',
  components: '组件',
  server: '服务端',
  client: '客户端',
  api: '接口层',
  db: '数据层',
  domain: '领域层',
  core: '内核',
  infra: '基础设施',
  ui: '界面',
  hooks: 'Hooks',
  store: '状态管理',
  router: '路由',
  pages: '页面',
  views: '视图',
  locales: '国际化',
  i18n: '国际化',
};

/** glob 的最小匹配（只支持 `*`、`**` 与路径前缀，够用且可测）。 */
export function matchesGlob(path: string, glob: string): boolean {
  if (glob === '') return false;
  const normalized = glob.replace(/\\/g, '/').replace(/\/+$/, '');

  // `**` 单独出现：匹配任意层级下的该名字
  if (normalized === '**') return true;
  if (normalized.startsWith('**/')) {
    const tail = normalized.slice(3);
    return path === tail || path.endsWith(`/${tail}`) || path.includes(`/${tail}/`) || matchesGlob(path, tail);
  }
  // `dir/**`：该目录及其下全部
  if (normalized.endsWith('/**')) {
    const prefix = normalized.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  // `**.ts` 这类后缀写法
  if (normalized.startsWith('**')) {
    const suffix = normalized.slice(2);
    return path.endsWith(suffix);
  }
  if (normalized.includes('*')) {
    const pattern = normalized
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*');
    return new RegExp(`^${pattern}$`).test(path);
  }
  return path === normalized || path.startsWith(`${normalized}/`);
}
