# Codex / Claude Code 機能比較・商品品質改善 cycle 21

- 実施日: 2026-09-05
- 基準commit: `262548d`
- 対象: 応答可視性、TUIでの選択・コピー、OpenAI Responses / Chat Completionsのparameter互換性
- 完了条件: 再現したP1を修正し、回帰テスト・全品質gate・最新push SHAのCIを閉じる
- 状態: 実装・ローカル全品質gate完了（最新push SHAのCI待ち）

## 1. 比較根拠

- Codexの現行設定schemaはAlternate Screenを`auto/always/never`で選べ、keymapに
  `copy`とcopy-friendly transcript用の`toggle_raw_output`を持つ:
  [OpenAI Codex config schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)
- Claude Code fullscreenはmouseでの選択・自動copy、端末modifierによるnative選択、
  mouse captureを止める`CLAUDE_CODE_DISABLE_MOUSE=1`、transcriptのnative scrollback書出しを持つ:
  [Claude Code fullscreen](https://code.claude.com/docs/en/fullscreen),
  [interactive mode](https://code.claude.com/docs/en/interactive-mode)
- OpenAIのモデルガイドは新しいreasoning modelで`temperature` / `top_p`等を送らないよう
  明記し、GPT-5.2/5.1でもreasoning effortが`none`以外ならエラーになる:
  [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)

## 2. 機能比較マトリックス

凡例: `◎` user-facing contract、`○`一部あり、`—`無し。

| 比較項目 | Codex | Claude Code | 262548d時点 | cycle 21結果 |
|---|---|---|---|---|
| 応答待機中の可視状態 | ◎ streaming/status | ◎ streaming/fullscreen status | ○ 1行preview | ◎ preview維持 + API失敗を確定表示 |
| 実行時エラーが再描画後も残る | ◎ transcript内 | ◎ transcript内 | — `stderr`直書きがTUI再描画で消える | ◎ Alternate Screenのみ確定scrollbackへ記録 |
| full-screen内のcopy-friendly mode | ◎ raw output切替 / last response copy | ◎ in-app選択 / mouse capture off | — 再起動して`--no-alt-screen`のみ | ◎ `/tui mouse off`で実行中切替 |
| mouse captureなしの履歴移動 | ◎ keyboard pager | ◎ PgUp/PgDn | — TUIごと無効化が必要 | ◎ Alternate ScreenとPgUp/PgDnを維持 |
| OpenAI model別parameter適応 | ◎ product側で管理 | 対象外 | — 設定値を無条件送信 | ◎ provider/model能力で送信fieldを決定 |
| 非対応parameterの扱い | ◎ 有効なrequest shape | 対象外 | — HTTP 400、理由は画面から消える | ◎ 送信せず1回だけ理由と解除方法を表示 |

## 3. 再現証拠と発見事項

原文prompt/応答/API keyは転載せず、運用ログの集計値とエラー署名だけを使用した。

- `~/.localllm/logs/ops` 200ファイル・約192 MBを対象に署名集計。
- `azure-gpt` / `gpt-5.6-luna`の
  `Unsupported parameter: 'temperature' is not supported with this model`は
  2026-08-22〜2026-09-05に26件、2026-09-05 JSTだけで5件。
- 最新保存sessionはuser message 2件・assistant message 0件。terminal transcript 25行にも
  `Unsupported parameter` / `HTTP 400`が無く、API失敗と画面上の無応答が一致した。
- 修正前の回帰テストは、API body 2件、mouse mode 4件、runtime diagnostic module欠落で失敗した。

| ID | 優先度 | 症状・原因 | 改善 | 回帰証拠 | 状態 |
|---|---:|---|---|---|---|
| API-01 | P1 | `azure-gpt.ts`がGPT-5.6へ`temperature`を無条件送信しHTTP 400。内部classifier等の固定値でも発生 | OpenAI reasoning modelの`temperature/top_p`を能力表で除外。Azure OpenAI非対応拡張も除外 | captured request body unit | 修正済み |
| UX-ERROR-01 | P1 | LLM失敗を`console.error`でAlternate Screen外へ直書きし、次の再描画で消すため無応答に見える | `writeRuntimeError`でTUI時は確定scrollback、classic時はstderrを維持 | alternate/classic unit | 修正済み |
| COPY-01 | P1 | wheel修正でmouse trackingを常時有効化した結果、端末本来のdrag選択を奪った。解除にはTUI再起動が必要 | `/tui mouse off/on/status`、`--no-mouse`、`LLLMAGENT_DISABLE_MOUSE=1`を追加 | ScreenManager state/escape/PgUp unit | 修正済み |
| TEST-01 | P2 | 既存PTYはraw byte markerだけを検査し、エラーが確定履歴に残る契約とmouse-offを検査していない | request body、runtime diagnostic、mouse modeの境界回帰とPTYでのoff/on往復を追加 | 対象102 tests + CI実PTY | 修正済み |

## 4. 改善設計

1. 速度向上の1行previewは維持する。ただしAPI失敗をpreview消去後の一過性表示にせず、
   ユーザーがcopyできる確定出力として残す。
2. sampling parameterは「設定にあるから送る」ではなくprovider/model能力でrequest shapeを作る。
   省略は黙って行わず、該当model・parameter・設定解除方法をprocess内で一度だけ表示する。
3. wheel scrollとnative selectionは端末mouse protocol上のトレードオフなので、既定のwheel動作は
   変えず、実行中に明示切替できる対等なsupported modeとして公開する。
4. `mouse off`でもAlternate Screen、固定composer、PgUp/PgDn、確定transcriptは維持する。

## 5. 実装境界

- `src/providers/openai-sampling-compat.ts`: provider/model別の送信fieldと可視warning。
- `src/providers/azure-gpt.ts`, `openai-compat.ts`: capability-aware request body。
- `src/cli/runtime-diagnostic.ts`, `agent-loop.ts`: 実行時LLMエラーの表示面を選択。
- `src/cli/screen-manager.ts`, `repl.ts`: mouse captureの起動時・実行時切替。
- README、help、TUI/config設計を同じcontractへ更新。

## 6. 評価記録

- 修正前: 追加回帰は6件失敗、87件成功。
- 修正後対象: 5 files / 102 tests成功。
- 全unit: 135 files / 1,365 tests成功、環境依存11 tests skip。
- E2E: 1 file / 8 tests成功。`--help`で`--no-mouse`も確認。
- coverage: statements 44.66%、branches 76.26%、functions 68.95%、lines 44.66%。
- lint（`tsc --noEmit && biome check .`）: 成功（既存warning/infoのみ）。
- build / durable restart smoke / skill・version・npm package validation: 成功。
- production dependency audit: high gate成功、脆弱性0件。
- Windows SEA: `build:exe`成功、`dist/localllm.exe --version`成功。
- real PTY: Linux/macOS CIで`mouse off → on → wheel → preview → durable pause/resume`を検査する。ローカルWindowsは
  `script` / `expect`対象外のため、最新push SHAの両OS jobで閉じる。
- 初回候補`065ab03` / CI run `33937189061`: Ubuntu成功。macOS実PTYはoff/on動作自体は成功したが、
  expect側の完了markerを`sentMouseOff/sentMouseOn`へ反映せず失敗判定した。driver間の観測契約を補正し再検証する。

## 7. 終端状態

- API-01 / UX-ERROR-01 / COPY-01 / TEST-01: 修正済み。
- 未解決P0/P1: ローカル検証では0件。最新push SHAのCI完了まで最終判定保留。
