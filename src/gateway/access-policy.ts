/**
 * 访问控制解析（从 middleware-setup 抽出，便于脱离 SDK 单测）
 *
 * 只负责把配置翻译成 accessPolicy 的两段子配置，并暴露
 * 「allowlist + 空名单」这一 fail-open 陷阱。
 */
import type { Logger } from '../types.ts';

/** 单侧访问控制配置（accessPolicy 的 c2c / group 子项） */
export interface ResolvedAccessPolicy {
  mode: 'open' | 'allowlist' | 'disabled';
  allow: string[];
}

/**
 * 解析单侧访问控制配置。
 *
 * 空名单保持既有行为（退化为 `['*']`，即放行所有）——本函数只把
 * 「`allowlist` + 空名单」这个易踩的陷阱显式暴露出来：语义上它表示
 * 「谁都不许」，实现上却等于「谁都行」，且此前没有任何提示。
 * 改为 fail-closed 属于行为变更，需要产品决策，故此处只告警。
 */
export function resolveAccessPolicy(
  mode: ResolvedAccessPolicy['mode'],
  allow: readonly string[],
  scope: 'c2c' | 'group',
  logger: Logger,
): ResolvedAccessPolicy {
  if (mode === 'allowlist' && allow.length === 0) {
    const modeField = scope === 'c2c' ? 'c2cMode' : 'groupMode';
    const listField = scope === 'c2c' ? 'access.c2cAllow' : 'access.groupAllow';
    logger.warn(
      `im-qqbot: ${modeField}=allowlist，但 ${listField} 为空：`
      + `将退化为放行所有${scope === 'c2c' ? '私聊用户' : '群'}（fail-open）。`
      + `如需「谁都不可用」请改用 disabled；如需仅白名单可用请填写 openid。`,
    );
  }
  return { mode, allow: allow.length > 0 ? [...allow] : ['*'] };
}
