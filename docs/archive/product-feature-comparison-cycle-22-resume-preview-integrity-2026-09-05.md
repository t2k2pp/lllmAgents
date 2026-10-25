# Codex / Claude Code 機能比較・商品品質改善 cycle 22

- 実施日: 2026-09-05
- 基準commit: `7cc5cc0`
- 対象: session resume時の対話表示完全性、buffered 1行previewと最終本文の整合性
- 完了条件: 欠落を再現したP1を修正し、別process E2E・全品質gate・最新push SHAのCIを閉じる
- 状態: 完了（実装・ローカル全品質gate・実装SHA CI成功）

## 1. 比較境界

cycle 13の1行previewとcycle 20のterminal transcript resumeを組み合わせた後の回帰を扱う。
CodexとClaude Codeはいずれもsession resume後に過去のconversationを読めることを利用者契約としており、
生成中表示は確定した回答を欠損させない。本アプリもmessage履歴は内部復元していたが、画面は保存stdoutを
無条件に正としていたため、「モデルへ渡る履歴」と「ユーザーが読める履歴」が一致しない場合があった。

## 2. 機能比較マトリックス

凡例: `◎` user-facing contract、`○`一部あり、`—`無し。

| 比較項目 | Codex | Claude Code | 7cc5cc0時点 | cycle 22結果 |
|---|---|---|---|---|
| resume後のconversation継続 | ◎ | ◎ | ◎ message履歴をLLMへ復元 | ◎ 維持 |
| resume後に過去の対話を画面で読める | ◎ | ◎ | ○ 保存stdoutがあるとmessage照合なし | ◎ 欠けたuser/assistant本文を補完 |
| 過去のtool・診断stdoutも維持 | ◎ transcript | ◎ transcript | ◎ 最大10,000行 | ◎ 保存snapshotを維持 |
| 生成中の早期可視化 | ◎ streaming/status | ◎ streaming/status | ◎ 1行preview | ◎ 維持 |
| 自動継続前の本文を確定表示 | ◎ | ◎ | — previewを表示済みと誤認 | ◎ 前半をflush後に継続 |
| 旧不完全sessionの自己修復 | surface依存 | surface依存 | — | ◎ 欠落件数を明示して補完 |

## 3. 再現証拠と発見事項

prompt・応答原文は転載せず、最新の`terminalTranscript`付き実sessionを構造だけ集計した。
対象は対話本文11件、保存stdout 1,377行、`truncated=false`だったが、先頭・中央・末尾anchorで
完全表示を確認できない本文が3件あった。修正前の決定的テストでも、`finish_reason=length`後の出力は
「継続します」と後半本文だけで、前半本文が確定出力に存在しなかった。

| ID | 優先度 | 症状・原因 | 改善 | 回帰証拠 | 状態 |
|---|---:|---|---|---|---|
| PREVIEW-02 | P1 | 自動継続分岐が1行previewを実本文の表示とみなし、前半をflushせず`displayed=true`にした | length・構造的不完全の双方で前半本文を`final=false` flushし、実表示を`displayed`条件にする | AgentLoop buffered display unit | 修正済み |
| RESUME-04 | P1 | version 1 stdoutが存在するとcanonical message履歴を照合せず、過去対話の一部欠落をそのまま復元した | ANSI・Markdown差を正規化し、欠けたuser/assistant本文だけを明示セクションへ補完 | transcript unit、別process E2E | 修正済み |
| TEST-02 | P2 | preview formatterとstdout markerのテストはあったが、継続前半と「有効schema内の本文欠落」を検出しなかった | length・構造不完全、短文・長文・Markdown、別process欠落sessionを固定 | 対象unit 21件、E2E 8件 | 修正済み |

## 4. 改善設計

1. 1行previewは体感TTFT改善のため維持する。ただしlive statusであり、確定stdout・session transcript・
   `displayed`判定の証拠には使わない。
2. 自動継続では、受信済みの前半本文をMarkdown確定表示してから継続案内と次のAPIへ進む。
3. resumeでは保存stdoutを破棄して全会話を二重表示せず、message本文が存在するかを装飾差を除いて照合する。
   長文は先頭だけのpreviewを完全表示と誤認しないよう、先頭・中央・末尾の64文字anchorをすべて要求する。
4. 欠落分だけを補完し、件数を表示する。旧schema・不正schemaの既存再構成と10,000行上限は維持する。

## 5. 実装境界

- `AgentLoop`: length・構造的不完全の自動継続前に本文を確定flushし、履歴の表示済み条件を実出力へ限定。
- `session-transcript`: 保存stdoutとmessage本文のcoverage照合、欠落対話補完、補完件数の明示。
- unit: preview継続2経路、resumeの短文欠落・長文先頭のみ・Markdown描画済み非重複。
- E2E: 1 process目のsessionから本文行だけを欠落させ、2 process目の`--resume`でstdout markerと対話本文を復元。

## 6. 評価記録

- 修正前: 新規回帰はresume 2件とpreview 1件が失敗。preview出力は後半のみを確認。
- 修正後対象: 4 files / 21 tests成功。
- E2E: 1 file / 8 tests成功。別processで標準出力と欠落したuser/assistant本文2件を復元。
- build/typecheck: 成功。
- 全unit / coverage: 136 files成功・2 files skip、1,370 tests成功・11 tests skip。
  statements / lines 44.85%、branches 76.23%、functions 69.07%。
- lint: error 0（既存warning 279、info 97）。build/typecheck、durable restart smoke、skill・version検証成功。
- package: dry-run 554 files・9.4 MiB。production dependencyはhigh以上を含め0 vulnerabilities。
- Windows SEA: `build:exe`と生成した`dist/localllm.exe --version`が成功。
- 実装commit: `833afde`。
- 実装SHA CI: [run 33950630195](https://github.com/t2k2pp/lllmAgents/actions/runs/33950630195)で
  Commit message policy、Ubuntu、macOS、Windows、Windows deploy / exe smokeの全5 job成功。
  Linux/macOSの実PTY回帰も各OS job内で通過した。

## 7. 終端状態

- PREVIEW-02 / RESUME-04 / TEST-02: 修正済み。
- 未解決P0/P1: 0件。
- 完了証拠: 実装commit `833afde`、GitHub Actions run `33950630195`（全5 job成功）。
