# Codex / Claude 操作学習比較・商品品質改善 cycle 12

- 実施日: 2026-08-31
- 基準commit: `f19d3d6`
- 対象gap: `GAP-WL-01`
- 状態: 実装・unit/実browser評価済み（latest push SHAのCIはcommit後の完了条件）

## 1. 比較根拠

- OpenAIの[Record & Replay](https://learn.chatgpt.com/docs/extend/record-and-replay)は、macOSで一度実演したworkflowを、入力・step・verificationを持つ再利用skillへ変換し、Computer Use / browser / pluginと組み合わせられると説明する。
- OpenAIの[Build skills](https://learn.chatgpt.com/docs/build-skills)は、skillをinstruction・resource・scriptからなる再利用workflowと定義し、`SKILL.md`、progressive disclosure、明示/暗黙invocation、Record & Replayからの作成を説明する。
- Anthropicの[Claude Code features overview](https://code.claude.com/docs/en/features-overview)と[Extend Claude with skills](https://code.claude.com/docs/en/slash-commands)は、`SKILL.md`による再利用workflow、手動/自動invocation、`disable-model-invocation: true`、allowed toolsを説明する。
- Anthropicの[Tools reference](https://code.claude.com/docs/en/tools-reference)は、MCPによるcustom toolとskillによるprompt workflowの拡張を分けている。確認した公式Claude Code資料には、GUI実演を自動でskillへ変換するRecord & Replay相当の記載は見つからなかった。この「なし」は製品全体に存在しないという断言ではなく、調査範囲からの判断である。
- native OS操作そのものは[cycle 10](product-feature-comparison-cycle-10-2026-08-30.md)で比較・実装済み。本cycleは「操作できる」から「成功操作を安全に再利用できる」へのgapを扱う。

## 2. 機能比較マトリックス

凡例: `◎` 製品機能として提供、`○` 構成要素あり、`—` 調査した公式資料で同等機能を確認できず。

| 比較項目 | Codex / OpenAI | Claude / Anthropic | cycle 11以前 | cycle 12結果 |
|---|---|---|---|---|
| browser操作 | ◎ Computer Use/browser連携 | ○ MCP等のtool拡張 | ◎ `browser_*` | ◎ 維持 |
| native PC操作 | ◎ Computer Use | ◎ Computer Use/Cowork | ◎ 明示opt-in `computer_*` | ◎ 維持 |
| reusable skill | ◎ `SKILL.md` | ◎ `SKILL.md` | ◎ loader/registry | ◎ manual-only metadataを追加 |
| GUI実演 → skill | ◎ Record & Replay | — | — | ◎ 明示記録したtool軌跡をskill化 |
| 対応OS | Record & ReplayはmacOS | 同等機能未確認 | — | browserはPlaywright対応host、computerは既存Windows/macOS/Linux X11 capabilityに従う |
| 明示start/finish | ◎ Record開始/停止 | — | — | ◎ `/learn start/finish/cancel` |
| 入力/秘密値の扱い | 入力をskill構造化、秘密入力回避を案内 | skill authorが管理 | — | ◎ text、query、path、window ID、tool outputを非永続化 |
| 失敗step | 安定手順と成功基準を推奨 | skill authorが管理 | — | ◎ 1 failure/parallelで記録全体を拒否 |
| 自動起動の制御 | skill metadata policy | `disable-model-invocation` | field未対応 | ◎ loader/validator/tool/sub-agentでmanual-only強制 |
| replay時のtarget再解決 | verificationを作成 | skill記述次第 | — | ◎ DOM selector確認、window再列挙を生成skillへ固定 |
| 配布 | plugin/team共有 | project/user skill | project skillあり | ○ project-local保存。共有は通常のreview/commit経路 |

OpenAI Record & Replayが人のmacOS操作を直接記録するのに対し、本実装はエージェントが実行して成否を観測できるtool callだけを記録する。raw event recorderを同等と偽らず、cross-platform性、failure検出、秘密値非永続化を優先した意図的差分である。

## 3. gap選定と設計

`GAP-WL-01`をP1として選んだ。browser/native Computer Use、skill loader、permissionは揃っていたが、その間を結ぶobservation-to-skill bridgeがなく、同じ定型操作を毎回promptで説明する必要があったためである。

設計契約は次のとおり。

1. ユーザーの明示指示でのみ記録を開始する。
2. 成功した直列`browser_*` / `computer_*` tool callだけを対象にする。
3. tool outputを保持せず、入力値と一時識別子を保存前にplaceholder化する。
4. failed/parallel actionを黙って欠落させず、記録全体をやり直す。
5. project root containmentとatomic publishを満たし、既存skillを上書きしない。
6. 生成skillはユーザーのslash入力だけで起動し、skillからpermissionを昇格しない。

## 4. 発見した問題と回帰証拠

| ID | 優先度 | 原因 | 修正 | 回帰証拠 |
|---|---|---|---|---|
| WL-01 | P1 | browser/computer toolとskill systemの間に記録器がない | `WorkflowLearner`、4 tools、`/learn`を追加 | workflow learner/tool tests、実browser smoke |
| WL-02 | P1 | 生のtool引数を保存すると秘密値・URL query・一時window IDが漏洩/陳腐化する | field別sanitizationとtool output非保持 | secret/URL/computer/path非永続化test |
| WL-03 | P1 | failed/parallel/別surfaceのstepを省略すると、実演と異なる危険なworkflowになる | failure/parallel/remote/delegated actionでtaintし`finish`拒否 | failure/parallel/context regression |
| WL-04 | P1 | 学習skillがmodelから自動起動されるとGUI操作の意図確認を迂回する | `disable-model-invocation`をloader/validator/skill tool/sub-agentへ一貫適用 | manual-only tool/preload tests |
| WL-05 | P2 | 初回実装で`/learn start`等は補完されたが親`/learn`が補完候補にならない | 親completion entryを追加 | command registry test Red→Green |
| WL-06 | P2 | 実browser gate初回は対応Chromium実体がなく起動失敗 | Chromiumを導入し、gateはskip/fakeへ落とさず再実行 | 実DOM smoke pass |
| WL-07 | P1 | 初回pushのmacOS coverageで`/var`と`/private/var`を別pathと見なし、4件の保存testがescape判定で失敗 | 検証済みreal skill rootから保存先を構築し、containment強度を維持 | path alias regressionと次pushのmacOS CI |

## 5. 評価

- baseline: sandbox内`npm test`は既知のesbuild filesystem制限で起動不能。許可された通常実行では120 files（2 skipped）、1273 tests（11 skipped）成功。
- targeted: 5 files、33 tests成功（macOS path alias回帰を含む）。
- build: `npm run build`成功。
- browser smoke: 実ChromiumでDOMへ`SMOKE-SECRET-42`を入力しbuttonをclick、`saved:<redacted>`を画面状態から観測。4 steps、2 placeholders、manual-only=true、secret persisted=false。
- full unit: 122 files成功、2 files skipped。1287 tests成功、11 tests skipped。
- E2E: 非TTY pipe、権限確認、doctor、safe mode、side-effect-free help/Computer Use診断、diff/tasks/renameの7 scenarios成功。
- coverage: statements 42.65%、branches 75.61%、functions 65.42%、lines 42.65%。
- lint: TypeScript/Biome error 0。既存279 warnings、97 infosはnon-blocking設定。
- skill validator: built-in/project/Claude互換skill 25件成功。
- package: 536 files、9.3 MiB unpackedでallowlist/size検証成功。
- runtime audit: lockfile限定、High以上0 vulnerabilities。
- latest pushed SHAのCI結果はcommit後に本節へ追記せず、同じcommitを完了候補として監視する。

## 6. 残差

| ID | 優先度 | 内容 | 状態 |
|---|---|---|---|
| GAP-WL-02 | P2 | 人が行う任意のmouse/keyboard操作を直接recordするraw desktop recorder | open。入力監視・秘密値・screen capture・本人性の設計なしでは追加しない |
| GAP-WL-03 | P2 | learned skillのvisual editor / step差分review UI | open。現状は保存された`SKILL.md`を通常のGit reviewで確認 |
| GAP-WL-04 | P3 | team/pluginへのpublish UI | open。現在はproject-localのみ。配布は明示的なcommit/plugin化を利用 |

## 7. 完了gate

- [x] 公式資料による比較マトリックスとgap選定
- [x] sanitization / fail-fast / manual-only / filesystem境界のRed→Green
- [x] 実Chromiumで入力・click・結果観測・秘密値非永続化
- [x] 全unit / E2E / coverage / lint / skill / package / audit
- [ ] latest pushed SHAの全CI依存job
