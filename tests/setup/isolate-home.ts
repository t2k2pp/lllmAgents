/**
 * テスト実行中のホームディレクトリを一時フォルダへ向ける (vitest setupFiles)。
 *
 * LLM ログ (`~/.localllm/logs/sessions`) や設定 (`~/.localllm/config.json`) は os.homedir() から
 * 決まるため、 そのままだと AgentLoop を使うテストを流すたびに利用者の実ログへ偽セッションが
 * 書き込まれ、 実設定も読み込まれていた (2026-10-14 発覚: vitest 1 回ごとに *_main.jsonl が数件増加)。
 * 本番の既定動作は変えず、 テストの入口でだけ隔離する。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// テストファイルごとに新しい空フォルダにすると、 Git Bash が起動のたびにホームの初期化を行って最初の出力が
// 遅れ、 時間に敏感な bash テスト (idleTimeout 250ms) が落ちる。 一時フォルダ内の固定パスを使い回す。
const fakeHome = path.join(os.tmpdir(), "localllm-test-home");
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
