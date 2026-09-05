import chalk from "chalk";
import { format } from "node:util";
import { writeRuntimeError } from "../cli/runtime-diagnostic.js";

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

function emit(label: string, ...args: unknown[]): void {
  const message = format(...args);
  writeRuntimeError(message ? `${label} ${message}` : label);
}

export function debug(...args: unknown[]): void {
  if (shouldLog("debug")) {
    emit(chalk.gray("[DEBUG]"), ...args);
  }
}

export function info(...args: unknown[]): void {
  if (shouldLog("info")) {
    emit(chalk.blue("[INFO]"), ...args);
  }
}

export function warn(...args: unknown[]): void {
  if (shouldLog("warn")) {
    emit(chalk.yellow("[WARN]"), ...args);
  }
}

export function error(...args: unknown[]): void {
  if (shouldLog("error")) {
    emit(chalk.red("[ERROR]"), ...args);
  }
}
