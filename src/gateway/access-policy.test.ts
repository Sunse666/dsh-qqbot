import { describe, it, expect, vi } from 'vitest';
import { resolveAccessPolicy } from './access-policy.ts';
import type { Logger } from '../types.ts';

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('resolveAccessPolicy', () => {
  it('open 模式：空名单照旧放行所有，且不告警', () => {
    const logger = createLogger();
    expect(resolveAccessPolicy('open', [], 'c2c', logger)).toEqual({ mode: 'open', allow: ['*'] });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('allowlist + 空名单：行为不变（仍放行所有），但记录 fail-open 告警', () => {
    const logger = createLogger();
    const resolved = resolveAccessPolicy('allowlist', [], 'group', logger);
    expect(resolved).toEqual({ mode: 'allowlist', allow: ['*'] });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const message = String(vi.mocked(logger.warn).mock.calls[0]![0]);
    expect(message).toContain('groupMode=allowlist');
    expect(message).toContain('access.groupAllow 为空');
    expect(message).toContain('fail-open');
  });

  it('allowlist + 非空名单：只放行名单，不告警，且返回副本', () => {
    const logger = createLogger();
    const allow = ['openid-a', 'openid-b'];
    const resolved = resolveAccessPolicy('allowlist', allow, 'c2c', logger);
    expect(resolved).toEqual({ mode: 'allowlist', allow: ['openid-a', 'openid-b'] });
    expect(resolved.allow).not.toBe(allow);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('disabled：不告警（名单与放行无关）', () => {
    const logger = createLogger();
    expect(resolveAccessPolicy('disabled', [], 'c2c', logger).mode).toBe('disabled');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
