import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getDefaultConfig } from "./types.js";
const CONFIG_DIR = path.join(os.homedir(), ".localllm");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export function getConfigDir() {
    return CONFIG_DIR;
}
export function getConfigPath() {
    return CONFIG_FILE;
}
export function configExists() {
    return fs.existsSync(CONFIG_FILE);
}
export function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        return getDefaultConfig();
    }
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    const defaults = getDefaultConfig();
    // ツール配列はデフォルト ∪ ユーザー設定 で合成する。
    // こうすることでコード側に追加されたデフォルトツールが既存 config.json でも有効になる。
    const mergeToolList = (defaultList, savedList) => {
        if (!savedList)
            return defaultList;
        return [...new Set([...defaultList, ...savedList])];
    };
    const savedSecurity = parsed.security ?? {};
    return {
        ...defaults,
        ...parsed,
        security: {
            ...defaults.security,
            ...savedSecurity,
            autoApproveTools: mergeToolList(defaults.security.autoApproveTools, savedSecurity.autoApproveTools),
            requireApprovalTools: mergeToolList(defaults.security.requireApprovalTools, savedSecurity.requireApprovalTools),
            discordAutoApproveTools: mergeToolList(defaults.security.discordAutoApproveTools, savedSecurity.discordAutoApproveTools),
            slackAutoApproveTools: mergeToolList(defaults.security.slackAutoApproveTools, savedSecurity.slackAutoApproveTools),
        },
        context: { ...defaults.context, ...parsed.context },
        discord: { ...(defaults.discord ?? { enabled: false, webhookUrl: "" }), ...parsed.discord },
        slack: { ...(defaults.slack ?? { enabled: false, webhookUrl: "" }), ...parsed.slack },
    };
}
export function saveConfig(config) {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}
//# sourceMappingURL=config-manager.js.map