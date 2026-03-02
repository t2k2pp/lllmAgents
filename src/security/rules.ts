export type PermissionLevel = "auto" | "ask" | "deny";

export interface SecurityRule {
  pattern: RegExp;
  action: "block" | "warn";
  message: string;
}

export const DANGEROUS_COMMAND_PATTERNS: SecurityRule[] = [
  // Unix destructive
  { pattern: /rm\s+(-[rRf]+\s+|--recursive\s+)\/(?!\w)/, action: "block", message: "ルートディレクトリの再帰削除は禁止されています" },
  { pattern: /rm\s+-[rRf]*\s+~\//, action: "warn", message: "ホームディレクトリの削除は危険です" },
  { pattern: /mkfs/, action: "block", message: "ファイルシステムの作成は禁止されています" },
  { pattern: /dd\s+.*of=\/dev\//, action: "block", message: "デバイスへの直接書き込みは禁止されています" },
  { pattern: />\s*\/dev\/sd/, action: "block", message: "ディスクデバイスへの書き込みは禁止されています" },

  // Permissions
  { pattern: /chmod\s+777/, action: "warn", message: "777パーミッションはセキュリティリスクです" },
  { pattern: /chmod\s+-R\s+777/, action: "block", message: "再帰的な777パーミッション設定は禁止されています" },

  // Download & execute
  { pattern: /curl\s+.*\|\s*(bash|sh|zsh)/, action: "block", message: "ダウンロードしたスクリプトの直接実行は禁止されています" },
  { pattern: /wget\s+.*\|\s*(bash|sh|zsh)/, action: "block", message: "ダウンロードしたスクリプトの直接実行は禁止されています" },

  // System
  { pattern: /:()\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, action: "block", message: "フォーク爆弾は禁止されています" },
  { pattern: /\b(shutdown|reboot|poweroff|halt)\b/, action: "block", message: "システムのシャットダウン/再起動は禁止されています" },
  { pattern: /\binit\s+0\b/, action: "block", message: "システム停止は禁止されています" },

  // Windows destructive
  { pattern: /reg\s+delete/i, action: "block", message: "レジストリの削除は禁止されています" },
  { pattern: /del\s+\/[sfq]/i, action: "warn", message: "強制削除コマンドです" },
  { pattern: /format\s+[a-zA-Z]:/i, action: "block", message: "ドライブのフォーマットは禁止されています" },
  { pattern: /rd\s+\/s/i, action: "warn", message: "ディレクトリの再帰削除です" },

  // Git destructive
  { pattern: /git\s+push\s+.*--force\s+.*(main|master)/, action: "block", message: "main/masterへのforce pushは禁止されています" },
  { pattern: /git\s+reset\s+--hard/, action: "warn", message: "git reset --hardはコミットされていない変更を失います" },
  { pattern: /git\s+clean\s+-f/, action: "warn", message: "git cleanは追跡されていないファイルを削除します" },

  // Credential exposure
  { pattern: /echo\s+.*(?:password|secret|token|api.?key)/i, action: "warn", message: "認証情報がログに記録される可能性があります" },
  { pattern: /export\s+.*(?:PASSWORD|SECRET|TOKEN|API.?KEY)\s*=/i, action: "warn", message: "環境変数に認証情報を設定しています" },
];

export function checkCommand(command: string): SecurityRule | null {
  for (const rule of DANGEROUS_COMMAND_PATTERNS) {
    if (rule.pattern.test(command)) {
      return rule;
    }
  }
  return null;
}
