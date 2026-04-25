/**
 * Settings hierarchy — user / project / local / flag / policy resolver.
 *
 * Mirrors `clawagents_py/src/clawagents/settings/__init__.py`.
 */

export {
    SettingsLayer,
    resolveSettings,
    getSetting,
    findRepoRoot,
    POLICY_SETTINGS_PATH_ENV,
    DEFAULT_POLICY_SETTINGS_PATH,
} from "./resolver.js";
export type {
    SettingsObject,
    SettingsValue,
    ResolveSettingsOptions,
    GetSettingOptions,
} from "./resolver.js";
