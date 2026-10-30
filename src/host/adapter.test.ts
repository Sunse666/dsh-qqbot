import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHostAdapter, _resetAdapterCache } from './adapter.ts';

/** 最小 ctx：可控的 get() */
function makeCtx(services: Record<string, unknown>) {
  return {
    get: (name: string) => {
      if (!(name in services)) throw new Error(`cannot get property "${name}" without inject`);
      return services[name];
    },
  } as never;
}

describe('host adapter', () => {
  beforeEach(() => {
    _resetAdapterCache();
    vi.unstubAllGlobals();
  });

  it('sessionEvents：新宿主 snapshotEvents() 优先', () => {
    const adapter = createHostAdapter(makeCtx({}));
    const events = [{ type: 'a', seq: 0 }];
    expect(adapter.sessionEvents({ snapshotEvents: () => events })).toBe(events);
  });

  it('sessionEvents：旧宿主 events getter 兜底', () => {
    const adapter = createHostAdapter(makeCtx({}));
    const events = [{ type: 'a', seq: 0 }];
    expect(adapter.sessionEvents({ events })).toEqual(events);
  });

  it('sessionEvents：两者皆无返回空数组（不抛）', () => {
    const adapter = createHostAdapter(makeCtx({}));
    expect(adapter.sessionEvents({})).toEqual([]);
  });

  it('serviceFor：旧宿主 presets 实例方法直接命中', async () => {
    const compaction = { compactNow: () => {} };
    const presets = { serviceFor: (agent: unknown, name: string) => (name === 'compaction' ? compaction : undefined) };
    const adapter = createHostAdapter(makeCtx({ agentPresets: presets }));
    expect(await adapter.serviceFor({ ctx: {} }, 'compaction')).toBe(compaction);
    expect(adapter.capabilities).toContain('serviceFor(presets实例方法)');
  });

  it('serviceFor：无实例方法时走动态模块函数', async () => {
    const compaction = { compactNow: () => {} };
    vi.doMock('@deepseek-ai/dsh-agent-presets', () => ({
      serviceForAgent: (_ctx: unknown, agent: unknown, name: string) =>
        name === 'compaction' ? compaction : undefined,
    }));
    const adapter = createHostAdapter(makeCtx({}));
    expect(await adapter.serviceFor({ ctx: {} }, 'compaction')).toBe(compaction);
  });

  it('globalService：未注册返回 undefined（不抛）', () => {
    const adapter = createHostAdapter(makeCtx({}));
    expect(adapter.globalService('compaction')).toBeUndefined();
  });

  it('globalService：已注册返回服务', () => {
    const compaction = { compactNow: () => {} };
    const adapter = createHostAdapter(makeCtx({ compaction }));
    expect(adapter.globalService('compaction')).toBe(compaction);
  });

  it('buildForkSeed：模块不可解析时返回 undefined（不抛）', async () => {
    const adapter = createHostAdapter(makeCtx({}));
    expect(await adapter.buildForkSeed([{ seq: 0 }], 0)).toBeUndefined();
  });

  it('sessionHeader：读到 header 返回之，load 失败返回 undefined（不抛）', async () => {
    const header = { meta: { agentPreset: 'coder' } };
    const ok = createHostAdapter(makeCtx({ sessionPersistence: { load: async () => header } }));
    expect(await ok.sessionHeader('s1')).toBe(header);

    const failing = createHostAdapter(makeCtx({
      sessionPersistence: { load: async () => { throw new Error('EIO'); } },
    }));
    expect(await failing.sessionHeader('s1')).toBeUndefined();
  });

  it('sessionExists：load 成功 → true', async () => {
    const adapter = createHostAdapter(makeCtx({ sessionPersistence: { load: async () => ({}) } }));
    expect(await adapter.sessionExists('s1')).toBe(true);
  });

  it('sessionExists：宿主 NotFound 错误 → false', async () => {
    const notFound = Object.assign(new Error('session "s1" not found'), { name: 'SessionPersistenceNotFoundError' });
    const adapter = createHostAdapter(makeCtx({
      sessionPersistence: { load: async () => { throw notFound; } },
    }));
    expect(await adapter.sessionExists('s1')).toBe(false);
  });

  it('sessionExists：非 NotFound 失败 → 抛出（求证失败 ≠ 不存在）', async () => {
    // 文案含 not found 但 name 不是宿主 NotFound：如 preset/工具缺失，不得判为会话不存在
    const adapter = createHostAdapter(makeCtx({
      sessionPersistence: { load: async () => { throw new Error('tool "x" not found'); } },
    }));
    await expect(adapter.sessionExists('s1')).rejects.toThrow(/tool "x" not found/);
  });

  it('sessionExists：旧宿主无 sessionPersistence → undefined', async () => {
    const adapter = createHostAdapter(makeCtx({}));
    expect(await adapter.sessionExists('s1')).toBeUndefined();
    expect(adapter.capabilities).toContain('sessionPersistence(缺失，会话存在性判定降级)');
  });
});
