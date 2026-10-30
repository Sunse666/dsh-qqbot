/**
 * 宿主 API 适配层 — 收口所有版本漂移点，一次探测按需复用。
 *
 * 宿主新旧版本 API 形态不同（本插件踩过的漂移：events → snapshotEvents、
 * presets.serviceFor 实例方法 → serviceForAgent 模块函数、./fork 子路径导出）。
 * 调用方只依赖本模块的稳定签名，不再直接假设宿主形态。
 */
import type { Context } from '@deepseek-ai/cordis';

/** 日志最小接口 */
export interface AdapterLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface HostAdapter {
  /** 会话事件读取：新宿主 snapshotEvents()，旧宿主 events getter */
  sessionEvents(session: { snapshotEvents?: () => readonly unknown[]; events?: readonly unknown[] }): readonly unknown[];
  /** preset 作用域服务解析：旧宿主实例方法 / 新宿主模块函数 */
  serviceFor(agent: { ctx: unknown }, name: string): Promise<unknown | undefined>;
  /** 全局服务读取（未注册返回 undefined，不抛） */
  globalService(name: string): unknown | undefined;
  /** 官方 fork seed 构造；旧宿主无导出时返回 undefined */
  buildForkSeed(events: readonly unknown[], boundary: number): Promise<readonly unknown[] | undefined>;
  /** 会话 header 读取（取 meta.agentPreset 等）；服务缺失或读取失败返回 undefined */
  sessionHeader(sessionId: string): Promise<SessionHeaderLike | undefined>;
  /**
   * 会话是否存在于持久化层。
   *
   * 三种结果语义不同，调用方必须区分——把「判不出」当成「不存在」正是重建已存在
   * 会话、撞出重复 id 的根因：
   * - `true` / `false`：确定答案；
   * - `undefined`：旧宿主无该服务，没有求证手段；
   * - 抛出：求证过程本身失败（后端故障），不能据此断言会话不存在。
   */
  sessionExists(sessionId: string): Promise<boolean | undefined>;
  /** 探测结果摘要（启动契约检查用） */
  readonly capabilities: string[];
}

/** 会话持久化 header 的最小结构（只读插件关心的字段） */
export interface SessionHeaderLike {
  meta?: { agentPreset?: string };
}

/** 持久化服务的最小只读契约 */
interface SessionPersistenceLike {
  load(id: string): Promise<SessionHeaderLike>;
}

/**
 * 宿主「会话不存在」错误的稳定 name。
 *
 * 不 import `SessionPersistenceNotFoundError`：该类属 session-persistence 包
 * （插件未直接依赖），且跨 realm 的 instanceof 不可靠。只认 name，不做文案
 * 猜测——resume/load 的报错可能来自别的环节（preset 挂载、同 id 未释放），
 * 把它们误判成「会话不存在」会导致重建一个实际存在的会话。
 */
const NOT_FOUND_NAME = 'SessionPersistenceNotFoundError';

/** 模块级函数的动态 import 结果缓存（spec 变量路径绕开本地依赖类型检查） */
const moduleCache = new Map<string, Record<string, unknown> | undefined>();

async function importModule(spec: string, logger?: AdapterLogger): Promise<Record<string, unknown> | undefined> {
  if (moduleCache.has(spec)) return moduleCache.get(spec);
  let mod: Record<string, unknown> | undefined;
  try {
    mod = (await import(spec)) as Record<string, unknown>;
  } catch {
    mod = undefined;
    logger?.warn(`host adapter: module not resolvable: ${spec}`);
  }
  moduleCache.set(spec, mod);
  return mod;
}

export function createHostAdapter(ctx: Context, logger?: AdapterLogger): HostAdapter {
  const capabilities: string[] = [];

  // events 读取路径只有运行时才能确定，sessionEvents 内自适应
  capabilities.push('sessionEvents(s自适应)');

  // persistence 可能在插件启动后才注册，sessionExists/sessionHeader 内每次取
  capabilities.push(safeGet(ctx, 'sessionPersistence') ? 'sessionPersistence(已注册)' : 'sessionPersistence(缺失，会话存在性判定降级)');

  let resolveFn: ((agent: { ctx: unknown }, name: string) => unknown | undefined) | undefined;
  const presets = safeGet(ctx, 'agentPresets') as
    | { serviceFor?: (agent: unknown, name: string) => unknown }
    | undefined;
  if (presets && typeof presets.serviceFor === 'function') {
    resolveFn = (agent, name) => presets.serviceFor!(agent, name);
    capabilities.push('serviceFor(presets实例方法)');
  } else {
    capabilities.push('serviceFor(serviceForAgent动态)');
  }

  return {
    capabilities,

    sessionEvents(session) {
      if (typeof session.snapshotEvents === 'function') return session.snapshotEvents();
      const legacy = session.events;
      return Array.isArray(legacy) ? legacy : [];
    },

    async serviceFor(agent, name) {
      if (resolveFn) {
        try {
          const found = resolveFn(agent, name);
          if (found) return found;
        } catch { /* 宿主实现差异，走模块函数 */ }
      }
      const mod = await importModule('@deepseek-ai/dsh-agent-presets', logger);
      const fn = mod?.serviceForAgent as
        | ((ctx: unknown, agent: { ctx: unknown }, name: string) => unknown)
        | undefined;
      if (typeof fn !== 'function') return undefined;
      try {
        return fn(ctx, agent, name);
      } catch {
        return undefined;
      }
    },

    globalService(name) {
      return safeGet(ctx, name);
    },

    async sessionHeader(sessionId) {
      const persistence = safeGet(ctx, 'sessionPersistence') as SessionPersistenceLike | undefined;
      if (!persistence) return undefined;
      try {
        return await persistence.load(sessionId);
      } catch {
        return undefined;
      }
    },

    async sessionExists(sessionId) {
      const persistence = safeGet(ctx, 'sessionPersistence') as SessionPersistenceLike | undefined;
      if (!persistence) return undefined;
      try {
        await persistence.load(sessionId);
        return true;
      } catch (err) {
        if ((err as { name?: unknown } | null)?.name === NOT_FOUND_NAME) return false;
        throw err; // 求证失败 ≠ 会话不存在
      }
    },

    async buildForkSeed(events, boundary) {
      const mod = await importModule('@deepseek-ai/dsh-session/fork', logger);
      const fn = mod?.buildForkSeed as
        | ((events: readonly unknown[], boundary: number) => readonly unknown[])
        | undefined;
      if (typeof fn !== 'function') return undefined;
      try {
        return fn(events, boundary);
      } catch {
        return undefined;
      }
    },
  };
}

/** ctx.get 的非抛出版本 */
function safeGet(ctx: Context, name: string): unknown {
  try {
    return ctx.get(name) as unknown;
  } catch {
    return undefined;
  }
}

/** 测试辅助：清空模块缓存 */
export function _resetAdapterCache(): void {
  moduleCache.clear();
}
