import chalk from "chalk";

export type LogLevel = "debug" | "info" | "warn" | "error";

let currentLevel: LogLevel = "info";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

export function debug(...args: unknown[]): void {
  if (shouldLog("debug")) {
    console.error(chalk.gray("[DEBUG]"), ...args);
  }
}

export function info(...args: unknown[]): void {
  if (shouldLog("info")) {
    console.error(chalk.blue("[INFO]"), ...args);
  }
}

export function warn(...args: unknown[]): void {
  if (shouldLog("warn")) {
    console.error(chalk.yellow("[WARN]"), ...args);
  }
}

export function error(...args: unknown[]): void {
  if (shouldLog("error")) {
    console.error(chalk.red("[ERROR]"), ...args);
  }
}
