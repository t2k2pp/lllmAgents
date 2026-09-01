# Codex / Claude リリース・バージョン比較と商品品質改善 cycle 14

- 実施日: 2026-09-01
- 基準commit: `1fd2b12`
- 対象gap: `GAP-REL-01`
- 観点: 公開版と実行binaryの同一性、更新可否の診断、release失敗の可視性
- 状態: 実装・ローカル評価済み。latest pushed SHAのCI監視前

## 1. 比較根拠

- OpenAIの[Codex developer commands](https://developers.openai.com/codex/cli/reference/)は`codex update`をstable commandとして定義し、対応releaseでは更新を確認・適用する。`/status`とstatus lineではserver/Codex versionも確認できる。
- OpenAIの[Codex CLI overview](https://developers.openai.com/codex/cli/features/)は、subagents、web search、MCP、permissions、cloud、completion等をuser-facing contractとして列挙する。
- Anthropicの[Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)は`claude update`、version/install指定、background agent、plugin、MCP等を公開する。
- Anthropicの[Claude Code setup](https://code.claude.com/docs/en/getting-started)はnative版のbackground update、stable/latest channel、`claude doctor`による直近update結果、署名manifestとplatform署名を記載する。
- lllmAgentsの公開GitHub APIを2026-09-01に確認すると、latest releaseは`v0.4.1`（2026-08-13公開）、assetは0件。tagはcommit `7500dfe`を指し、そのcommitの`package.json`と`src/version.ts`はともに`0.4.0`、CHANGELOGに`0.4.1`項目は無かった。現行main `1fd2b12`も変更前は同じ`0.4.0`だった。

## 2. 機能比較マトリックス

凡例: `◎` user-facing contract、`○`構成要素あり、`△`不完全、`—`公式資料/実装で同等を確認できず。

| 比較項目 | Codex | Claude Code | cycle 13以前のlllmAgents | cycle 14結果 |
|---|---|---|---|---|
| 実行版の表示 | ◎ status/version | ◎ version/doctor | ○ `--version`、ただし公開releaseと不一致 | ◎ 3桁公開版+build commit |
| 公開版のsource of truth | release管理 | release/channel管理 | △ packageとsource定数の二重手動管理 | ◎ `package.json`単一ソース、SEAへ注入 |
| 明示的な更新確認 | ◎ `codex update` | ◎ `claude update` | — background通知のみ | ◎ `--check-update [--json]` |
| 更新失敗の診断 | ○ release非対応を明示 | ◎ `doctor`で直近結果 | — API/parse/asset不足を全てnull化 | ◎ status/reason/recovery/exit code |
| 更新先assetの存在確認 | release実装依存 | ◎ signed manifest/binary | — release URLだけ通知 | ◎ asset 0件をblocked扱い |
| release channel | 公式release | ◎ stable/latest | — | — |
| binary署名・checksum | 配布surface依存 | ◎ manifest署名+platform署名 | △ 無署名方針、checksumなし | △ 自動置換しない安全境界を維持 |
| version/tag CI整合 | 製品release工程 | 製品release工程 | — 手順書のみ | ◎ manifest/lock/CHANGELOG/tag validator |

広い機能面では過去cycleでsub-agent skill preload、schedule、background lifecycle/steering、plugin、safe mode、worktree isolation、Native Computer Use、workflow learning、streaming previewを順次追加済みである。今回の再比較では、両比較製品が持つ「ユーザーが明示的に更新状態を確かめる経路」と、実配布を同定するversion contractの欠落が、実際の公開不整合として再現したため優先した。

## 3. version方針とgap設計

`GAP-REL-01`をP1として選んだ。versionの役割を次のように固定する。

| 要素 | 役割 | 例 | 変更条件 |
|---|---|---|---|
| MAJOR | 非互換変更 | `1.0.0` | 設定・CLI・保存形式等の互換性を壊す |
| MINOR | 後方互換の機能追加 | `0.5.0` | 新しいuser-facing capability |
| PATCH | 後方互換の修正 | `0.4.2` | bug/security/docs/release修正 |
| BUILD | 同じ公開版内の実体 | `1fd2b12` / `1fd2b12-dirty` | commitごと。公開版の4番目にはしない |

表示は`vMAJOR.MINOR.PATCH (build <commit>[-dirty])`とする。tracked変更を含む開発buildは基準commitだけを名乗らず`-dirty`で区別する。`0.4.1.42`の独自4桁版はSemVer toolとの互換性を落とすため採用しない。機械表現が必要な場所ではSemVer build metadataの考え方に合わせて公開版とbuildを別fieldで保持する。

`package.json`を唯一の公開版sourceとし、通常実行はmanifestから読む。SEAはbuild時に同じ値を埋め込み、manifestを持たないbinaryでも同一表示にする。`package-lock.json`、CHANGELOG、release tagはvalidatorで一致を要求する。

更新は二つのmodeへ分ける。

1. TTY background advisory: 通信不能で起動を止めないが、公開releaseのtag/asset不整合は隠さない。
2. `--check-update`: 明示診断としてcurrent/available/blocked/unavailableを返し、判定不能・壊れたreleaseはexit 1。`--json`でautomation可能。

未署名asset、install方式判定、checksum、atomic rollbackが無い現状ではbinary自動置換を行わない。これはsilent fallbackではなく、危険な能力を提供済みと偽らない境界である。

## 4. 発見事項と終端状態

| ID | 優先度 | 症状・原因 | 対応・回帰証拠 | 状態 |
|---|---|---|---|---|
| VER-01 | P1 | 公開`v0.4.1` tag/releaseに対しtag先・main・binary表示が`0.4.0` | manifest/lockを`0.4.1`へ整合し、3桁版+build表示test | 修正済み。公開tag履歴は非改変 |
| VER-02 | P1 | packageとsource定数の二重手動管理 | manifest単一ソース、SEA define、unit/build/exe検証 | 修正済み |
| VER-03 | P1 | tag/manifest/lock/CHANGELOG不一致をCIが検出しない | `validate:version`とCI step、tag mismatch regression | 修正済み |
| VER-04 | P1 | tracked変更を含む開発buildも基準commitだけを表示し、clean成果物と区別できない | build identityへ`-dirty`を付与し、script/unit/E2E/SEAで回帰確認 | 修正済み |
| VER-05 | P1 | Windows package smokeの旧`commit unknown`検査が新しい`build`表示を検証せず退行を見逃す | package版から正規表現を組み立て、clean commit形式とdeploy metadata一致を検査 | 修正済み。latest SHA CIで実行 |
| REL-01 | P1 | `v0.4.1` release asset 0件なのに旧版へ更新URLだけを通知する | release assetを検査し、0件は理由・対処付きblocked | 修正済み（GitHub実releaseで再現） |
| REL-02 | P1 | background checkがHTTP/parse failureを全てnullにし、明示診断手段が無い | `inspectUpdate`、`--check-update [--json]`、status別test | 修正済み |
| REL-03 | P2 | 公開`v0.4.1`のtag先そのものは`0.4.0`でassetなし | public historyをrewriteしない。次releaseを新tagで作り、validatorを必須化 | blocked（tag作成・release公開は今回の権限境界外） |
| REL-04 | P2 | `codex update`/`claude update`相当の安全なbinary自動更新 | 署名/checksum/install判定/rollbackが無いため自動置換しない | 範囲外。自動更新の品質gateを文書化 |
| REL-05 | P2 | stable/latest channelが無い | 個人配布かつ単一release列のため現時点では品質gateを妨げない | 範囲外 |

現在mainには`v0.4.1`以後の後方互換機能追加が多数あるため、次に実際の公開releaseを作る際はPATCHの`0.4.2`ではなくMINORの`0.5.0`が妥当である。ただし本taskではtag/releaseを新設せず、履歴も書き換えない。

## 5. 評価

- baseline unit: 124 files passed / 2 skipped、1296 tests passed / 11 skipped。sandbox内Vitestは既知のesbuild parent-directory制限で起動不能、通常実行で製品不具合ではないことを確認。
- targeted: version/update/version-policy/git-revisionの4 files、18 tests passed。
- version validator: public `0.4.1`、build=Git commitまたは`commit-dirty`、表示分離、`--tag v0.4.1` passed。
- build: TypeScript build passed。tracked変更を含む現作業treeの`node dist/index.js --version`は`v0.4.1 (build 1fd2b12-dirty)`を表示。
- live update diagnosis: GitHub release `v0.4.1`を`blocked`、asset 0件、release URL、復旧手順としてJSON出力しexit 1。
- lint: error 0。既存warning/infoはnon-blocking設定。
- full unit: 最終差分で126 files passed / 2 skipped、1306 tests passed / 11 skipped。
- E2E: 7 scenarios passed。隔離HOMEで`--help`と`--version`を実行し、状態非生成、`v0.4.1 (build <commit>)`、`unknown`非表示を確認。
- coverage: statements/lines 42.94%、branches 75.46%、functions 66.01%。全threshold passed。
- skill/package/audit: 25 skills passed。npm packageは538 files、9.3 MiB。lockfile基準runtime auditは0 vulnerabilities。
- SEA: `dist/localllm.exe`を生成し、隔離HOMEでversion、実GitHubへのJSON更新診断、状態非生成を確認。`v0.4.1 (build 1fd2b12-dirty)`、`blocked`/exit 1、asset 0件を実証。
- deploy directory全体は既存`deploy/localllm.exe`をPID 11524が使用中だったため、build scriptが上書きをfail-fastした。processは停止せず、clean checkoutのWindows deploy/exe smokeを最新push SHAのCIで閉じる。

## 6. 完了gate

- [x] Codex / Claude公式資料と実GitHub/repository evidenceの比較
- [x] 機能比較マトリックスと優先gap選定
- [x] 3桁公開SemVer+build identity方針
- [x] version単一ソース化とrelease metadata validator
- [x] 明示更新診断とrelease asset fail-fast
- [x] targeted test / build / live GitHub診断
- [x] full unit / E2E / coverage / package / audit / SEA smoke
- [ ] task差分だけをcommit/push
- [ ] latest pushed SHAの全依存CI job
