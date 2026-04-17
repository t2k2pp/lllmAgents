import chalk from "chalk";
let currentLevel = "info";
const LEVEL_ORDER = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};
export function setLogLevel(level) {
    currentLevel = level;
}
function shouldLog(level) {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}
export function debug(...args) {
    if (shouldLog("debug")) {
        console.error(chalk.gray("[DEBUG]"), ...args);
    }
}
export function info(...args) {
    if (shouldLog("info")) {
        console.error(chalk.blue("[INFO]"), ...args);
    }
}
export function warn(...args) {
    if (shouldLog("warn")) {
        console.error(chalk.yellow("[WARN]"), ...args);
    }
}
export function error(...args) {
    if (shouldLog("error")) {
        console.error(chalk.red("[ERROR]"), ...args);
    }
}
//# sourceMappingURL=logger.js.map