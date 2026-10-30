var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
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
const moduleCache = new Map();
async function importModule(spec, logger) {
    if (moduleCache.has(spec))
        return moduleCache.get(spec);
    let mod;
    try {
        mod = (await import(__rewriteRelativeImportExtension(spec)));
    }
    catch {
        mod = undefined;
        logger?.warn(`host adapter: module not resolvable: ${spec}`);
    }
    moduleCache.set(spec, mod);
    return mod;
}
export function createHostAdapter(ctx, logger) {
    const capabilities = [];
    // events 读取路径只有运行时才能确定，sessionEvents 内自适应
    capabilities.push('sessionEvents(s自适应)');
    // persistence 可能在插件启动后才注册，sessionExists/sessionHeader 内每次取
    capabilities.push(safeGet(ctx, 'sessionPersistence') ? 'sessionPersistence(已注册)' : 'sessionPersistence(缺失，会话存在性判定降级)');
    let resolveFn;
    const presets = safeGet(ctx, 'agentPresets');
    if (presets && typeof presets.serviceFor === 'function') {
        resolveFn = (agent, name) => presets.serviceFor(agent, name);
        capabilities.push('serviceFor(presets实例方法)');
    }
    else {
        capabilities.push('serviceFor(serviceForAgent动态)');
    }
    return {
        capabilities,
        sessionEvents(session) {
            if (typeof session.snapshotEvents === 'function')
                return session.snapshotEvents();
            const legacy = session.events;
            return Array.isArray(legacy) ? legacy : [];
        },
        async serviceFor(agent, name) {
            if (resolveFn) {
                try {
                    const found = resolveFn(agent, name);
                    if (found)
                        return found;
                }
                catch { /* 宿主实现差异，走模块函数 */ }
            }
            const mod = await importModule('@deepseek-ai/dsh-agent-presets', logger);
            const fn = mod?.serviceForAgent;
            if (typeof fn !== 'function')
                return undefined;
            try {
                return fn(ctx, agent, name);
            }
            catch {
                return undefined;
            }
        },
        globalService(name) {
            return safeGet(ctx, name);
        },
        async sessionHeader(sessionId) {
            const persistence = safeGet(ctx, 'sessionPersistence');
            if (!persistence)
                return undefined;
            try {
                return await persistence.load(sessionId);
            }
            catch {
                return undefined;
            }
        },
        async sessionExists(sessionId) {
            const persistence = safeGet(ctx, 'sessionPersistence');
            if (!persistence)
                return undefined;
            try {
                await persistence.load(sessionId);
                return true;
            }
            catch (err) {
                if (err?.name === NOT_FOUND_NAME)
                    return false;
                throw err; // 求证失败 ≠ 会话不存在
            }
        },
        async buildForkSeed(events, boundary) {
            const mod = await importModule('@deepseek-ai/dsh-session/fork', logger);
            const fn = mod?.buildForkSeed;
            if (typeof fn !== 'function')
                return undefined;
            try {
                return fn(events, boundary);
            }
            catch {
                return undefined;
            }
        },
    };
}
/** ctx.get 的非抛出版本 */
function safeGet(ctx, name) {
    try {
        return ctx.get(name);
    }
    catch {
        return undefined;
    }
}
/** 测试辅助：清空模块缓存 */
export function _resetAdapterCache() {
    moduleCache.clear();
}
//# sourceMappingURL=adapter.js.map