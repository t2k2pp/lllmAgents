/**
 * アプリのバージョン定数。
 *
 * package.json と二重管理になるが、SEA (単一 exe) 配布では実行時に package.json を
 * 読めないため定数で持つ。リリース時は package.json と同時に更新すること
 * (docs/production-readiness.md PR-12)。
 */
export const APP_VERSION = "0.3.0";
