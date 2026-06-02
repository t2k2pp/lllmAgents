# リグレッション復旧設計：自動チェックポイント & ランタイムスモーク

> **ステータス**: 実装済み（2026-06-02）。A=シャドウ Git オプトイン / D=スモーク Tool＋スキル強化。tsc 通過・ロジック実証済み（手動 TTY での REPL/対話品質確認は別途）
> **起票日**: 2026-06-02
> **関連**: ユーザールール「負債貯金はしない」「参考資料と成果物を区別」、`docs/workspace-separation.md`（sandbox 成果物の扱い）、`docs/harness-engineering.md`、`src/agent/hooks.ts`、`src/tools/tool-executor.ts`、`src/skills/builtin/game-development/SKILL.md`、`src/browser/playwright-manager.ts`
> **メモリ**: [[feedback_review_focus_ux]]（固まる/中断不能/進捗不可視を最優先）、[[feedback_diagnose_before_speculate]]

## 改訂履歴

- **2026-06-02**: 初版。バーチャロン風ゲーム作成時の「復旧不能スパイラル」事象を起点に設計化。
- **2026-06-02 (改訂2)**: D はスキル強化で実装と確定。A はシャドウ Git を一旦「過剰」として見送り、声がけ案に縮小。
- **2026-06-02 (改訂3・確定)**: **A は シャドウ Git を「オプトイン機能」として採用**に再転換。見送り理由だった SSD 寿命懸念は過剰見積りと判明（コミットはテキストで数 KB/ターン、アプリ自身の session ログ 44MB/回の方が桁違いに大）。スキル/MCP 同様に簡単に ON/OFF できる前提で、ユーザーの「やりたい」意向を採用。**声がけ（本物 Git）は従の補助**に降格。**D はスキル強化で実装**で不変。
- **2026-06-02 (改訂4・実装)**: A・D とも実装完了。実装ファイルは §8 参照。tsc 通過。実証: (1) シャドウ Git の commit→list→restore→scope外skip を一時ディレクトリで確認、(2) `game_smoke` が good HTML=pass / bad HTML(=`THREE.MathUtils.lerpAngle` 例外)=fail を正しく判定（本事象の発端バグを実際に検知）。
- **2026-06-02 (改訂5・活用導線)**: 「裏で撮るだけで活用されない」ギャップを是正。ユーザー判断: 回帰時は**モデルが提案・人間が `/checkpoint restore` で実行**（restore ツールは作らない）／build系タスクで**モデルが `/checkpoint on` を提案**（既定 OFF のまま）。§9 参照。
- **2026-06-02 (改訂6・掃除)**: 溜め込み対策を実装。`/checkpoint clear [--all]` と、セッション開始時の保持ポリシー自動掃除（`retention.maxSessions`=既定20 / `maxAgeDays`=既定60、現在セッションは常に保持）＋50コミットごとの `git gc --auto`。実証: 100日超を年齢削除＋件数超過の最古を削除し現在セッションは保持。tsc 通過。
- **2026-06-02 (改訂7・最終更新基準)**: 保持判定の「古さ」を**開始日ではなく最終更新日**に修正（ユーザー指摘）。当初はディレクトリ mtime を使用（git の index.lock→rename で結果的に追従していたが暗黙依存で脆い）。`logs/HEAD` の mtime（最終コミット時刻）を明示シグナルにし、フォールバック付き。実証: dir=100日前でも最終コミットが2日前なら保持、最終コミットが100日前なら削除。
- **2026-06-03 (本版・サブエージェントレビュー反映)**: 独立レビューで判明した重大欠陥を修正（詳細 §10）。H1 resume時にチェックポイントが継承されない（致命）、H2 restore が不完全（追加ファイルが残る）、M3 スコープが cwd 全体で機密混入リスク、H3/M5 スモークのフリーズ/blank 判定の誤検知。併せて設計書本文の未実装記述（Stop フック / known-good タグ）を実態へ整合。

---

## 1. 背景：何が起きたか（事実）

`~/.localllm/sessions/mpv3cuiq-e86g.json`（main = `gpt-5.4`、Blender 併用で `sandbox/output/games/virtual-on-like/` に 3D Web ゲームを作成）で発生。

ToDo 49 件と実メッセージから、挙動は典型的な **リグレッション・スパイラル**：

```
実装 → 不具合診断 → 修正 → 別の破綻 → 「差し戻す変更箇所を特定」
→ 「変更前へ戻す」 → 「壊れ方を特定」 → 「遊べていた安定挙動へ手動復旧」
→ 開始後動かない → 再診断 → また動かない → 再診断 → 回転エラー…
```

決定的なユーザー発言（復旧セッション冒頭, msg #5）：

> **「戻せてませんよ。壊れたまま。ローカルリポジトリでも作ってくれてたら戻せたのにな。」**

その後 `[file_edit] replaced 1 occurrence` が数十連発（＝前進パッチを当て続ける）、「まだ動きません」が反復、最後は `THREE.MathUtils.lerpAngle is not a function`（three.js に存在しない捏造 API）でランタイム例外ループ。作業フォルダに `.git` は無し。

## 2. 問題分析

### 2.1 これは「生成AIあるある」か、アプリ固有か

- **挙動そのもの**（回帰スパイラル／存在しない API の捏造／実行確認せず「直りました」宣言／動いていた版を失う）は **生成 AI 共通**。
- ただし **ハーネス設計が「ちょっと面倒」を「ほぼ復旧不能」に格上げ**していた。原因は 2 つ：
  1. **編集前スナップショットが無い** → 「戻す」がモデルの記憶からの再構築（手動復旧）に依存し不確実。沼の入口。
  2. **検証が build/構文止まり** → 実行・描画確認を人間に丸投げ。1 往復が遅く、モデルは盲目のまま次のパッチを当てる。

### 2.2 根本原因の一言

> 沼の原因は「AI が間違えること」ではなく、**間違えたときに戻れる地点をハーネスが残していなかったこと**。

## 3. 設計原則（置き場所の判断軸）

本件に限らず再利用する判断基準：

> **「モデルが失敗しても動くべき」ものほど深く（core / Hook）、「モデルを導く」ものほど浅く（Skill）。MCP は “別ホストとも共有したい能力” のときだけ。**

| 機能 | 置き場所 | 理由 |
|---|---|---|
| A 自動チェックポイント（シャドウ Git）（**確定**） | **Hook（PostToolUse/Stop）＋ シャドウ Git**、`config` フラグ＋`/checkpoint` で ON/OFF | モデル非依存の安全網。原則「失敗しても動くべきは深く」に合致。Claude Code の `file-history-snapshot` と同コンセプト |
| A' 版管理の声がけ（**従・補助**） | ルール/スキル追記（任意） | ユーザー所有の見える Git を促す habit。安全網は A が担うため必須ではない |
| D スモーク能力 | **ビルトイン Tool**（将来クロスホスト共有なら MCP） | 既存 Playwright を露出。モデルが呼ぶ「能力」 |
| D スモーク運用 | **既存 `game-development` スキルに追記** | いつ走らせ結果をどう解釈するかの判断＝モデル向け |

**設計原則との整合**：A は原則どおり「モデルが失敗しても動くべき＝深く（Hook＋裏 Git）」に置く。一度は声がけ案へ縮小したが、それは私の SSD 寿命懸念（過剰見積り）が前提を歪めていたため。前提が訂正され、かつ ON/OFF が容易（Hook の発火を gate するだけ）と判明したので、原則に沿った本来案へ戻した。**実証で確認した事実が判断を覆した**例（[[feedback_diagnose_before_speculate]]）。

**Claude Code の先例**：本プロジェクトの Claude Code ログ 20 セッションに `file-history-snapshot`（`trackedFileBackups` + `timestamp` を messageId 単位で保持）が存在し、`/rewind` で復元できる。A はこれと同コンセプト（ハーネスが裏で・ユーザー Git とは別系統で・ターン単位の復元点を残す）を git で実装するもの。

---

## 4. 機能 A：自動チェックポイント（シャドウ Git・オプトイン）

### 4.1 目的

作業成果物を、モデルの協力なしにハーネスが版管理し、壊れても last-good に戻れる安全網を常時張る。**復旧にモデルを介在させない**（人間が `/checkpoint restore` で戻せれば、モデルが沼っても被害が確定しない）。Claude Code の `file-history-snapshot`／`/rewind` と同コンセプト。

### 4.2 採用に至る判断（SSD 懸念の訂正）

一度は「過剰」として見送ったが、見送り理由は**私の SSD 寿命懸念であり、それが過剰見積りだった**ため、訂正のうえ採用に戻す。

- **書き込み実態**：git は変更ファイルのみを zlib 圧縮してオブジェクト化。テキスト/コードなら 1 ターンあたり数 KB〜十数 KB。1000 ターンでも合計 ~100MB 級。
- **耐性との比**：消費者 SSD は 1TB あたり 300〜600 TBW クラス。コミットの寄与は実質ゼロの桁。
- **比較対象**：本アプリ自身の 1 セッションログ（`logs/sessions/..._main.jsonl`）が 44MB あった実測。チェックポイントのコミットはこの隣では誤差。npm install / Playwright の Chromium DL（~150MB）の方が桁違いに書く。
- **残る唯一の本物の懸念**＝バイナリ資産（Blender 書き出し等）の毎ターン丸ごと保存による書き込み増幅。これは 4.5 のスコープ/除外で潰す。

### 4.3 配置と構成（シャドウリポジトリ）

- 既存の `PostToolUse`（`file_write`/`file_edit` 後）または `Stop`（1 ターン 1 コミット）フックで起動。core 本体には埋め込まない（拡張点で表現可能・core を薄く保つ）。
- **モデル負担：ほぼゼロ**（git をツールとして叩かせない。トークン増分・判断・プロンプト追記すべて不要）。
- **シャドウリポジトリ**：`.git` 本体を作業フォルダの外に置く。
  - 場所：`~/.localllm/checkpoints/<session-id>/`
  - 運用：`git --git-dir=~/.localllm/checkpoints/<session-id> --work-tree=<作業フォルダ> ...`
  - ユーザーが Git を使っていてもいなくても**常にシャドウで統一**（既存 Git への相乗りはしない）。

**なぜ衝突しないか**：
1. `--git-dir` が別 → index・ロック・HEAD・ブランチ・履歴がすべて独立。ユーザーの `.git` に一切触れず、`git status` にも現れない（不可視）。
2. 作業フォルダに `.git` を作らない → 入れ子リポジトリ問題が起きない。
3. ロック競合なし → index ロックは我々の git-dir 側。ユーザーの `git commit` と同時でも取り合わない。

### 4.4 ON/OFF（スキル/MCP 並みに容易）

実体は「Hook を発火させるか否か」だけなので、トグルは素直：

- **設定フラグ** `checkpoints.enabled`（`config.json`）でグローバル ON/OFF。
- **REPL コマンド**：`/checkpoint on|off`（ランタイム切替）、`/checkpoint list`、`/checkpoint restore <n>`、`/checkpoint diff <n>`、`/checkpoint clear [--all]`（履歴削除）。入力補完対象に含める。
- 既定値（要確定）：ユーザーは賛成派のため **既定 ON**＋スコープ限定が候補。

### 4.5 スコープ・除外・保持（書き込みとサイズの制御）

- **スコープ（実装済み）**：work-tree は `config.checkpoints.workTreeDir` で指定可。未指定なら `<cwd>/sandbox/output` があればそこ、無ければ cwd（deploy exe を成果物フォルダで動かす実運用では cwd=成果物）。これにより開発時に `src/` や機密を巻き込まない。
- **機密・巨大除外（実装済み）**：`.env*`/`*.pem`/`*.key`/`id_*`/`*.p12`/`*.pfx` を info/exclude で除外。`maxFileSizeMb`（既定 25）超のファイルはステージから外し以後 exclude に追記（Blender 書き出し等の肥大対策）。
- **除外**：`node_modules/`・機密・巨大ファイルは内部除外リスト（info/exclude）＋サイズガードで弾く。
- **.gitignore の扱い（確定・H-B）**：作業ツリー内のユーザー `.gitignore` は**意図的に尊重する**（`git add -A`、`-f` は使わない）。当初設計は「`-f` で確実に拾う」としていたが、`add -f` は info/exclude も貫通して**機密・`node_modules` まで取り込んでしまう**ため不採用。トレードオフとして、ユーザーが `.gitignore` した成果物（例: `*.html` を無視）はチェックポイント対象外になる。既定スコープ（`sandbox/output`）には通常 `.gitignore` が無いため実害は限定的。完全スナップショットが必要なら `.gitignore` を置かない運用とする。
- **粒度（実装済み）**：file_write/file_edit 成功ごとに `git add -A` で**作業ツリー全体をステージしてコミット**（＝各コミットが完全な復元可能スナップショット。整合性 > メッセージ粒度）。同一ターンの複数変更は最初のコミットにまとまるため、メッセージは staged ファイル名一覧から生成して実態を反映。
- **保持（実装済み）**：
  - **セッション横断の自動掃除**：セッション開始時に `pruneOldSessions()` が `~/.localllm/checkpoints/` を走査し、`maxAgeDays`（既定 60 日）より古い／`maxSessions`（既定 20）を超える古いセッションを削除。現在のセッションは常に残す。`config.checkpoints.retention.{maxSessions,maxAgeDays}` で調整可（0=無制限）。1 年前・100 セッション前のスナップショットを溜め込まない。
  - **「古さ」の基準＝最終更新日**：セッション開始日（ディレクトリ作成日）ではなく、**最後にチェックポイントした日**で判定する。コミットのたびに追記される `logs/HEAD` の mtime を最終活動時刻とし、無ければ HEAD/index/dir の最大 mtime にフォールバック。「ずっと前に作ったが昨日まで触っていたセッション」を誤って消さない。
  - **手動削除**：`/checkpoint clear`（今セッション）／`/checkpoint clear --all`（全セッション）。作業フォルダのファイルは無傷。
  - **セッション内圧縮**：50 コミットごとに `git gc --auto`（閾値未満は no-op）。

### 4.6 コミットの引き金（D との連携）

**※ known-good タグは未実装（将来案）。** 現状は全コミットが等価な復元点で、回帰時は `/checkpoint list` から動く版を選んで restore する運用。スモーク（D）合格時に自動タグを打つ連携は将来の拡張余地として残す（§10）。

### 4.7 復旧 UX

- **モデル/ユーザー**：`/checkpoint list` → `/checkpoint restore <n>` で任意ターンへ復元。
- **アプリ外から**：`git --git-dir=~/.localllm/checkpoints/<session-id> --work-tree=… log/checkout` でも操作可能。

### 4.8 補助（A'）：版管理の声がけ（任意）

安全網は A が担うため必須ではないが、ユーザー所有の**見える Git** を促す habit として、`game-development`/`dev-workflow` スキルに「動く版ができたら本物の repo にコミットを提案」の一文を添えてよい。A（裏の網）と A'（表の履歴）は排他ではなく補完。

### 4.9 オープン論点

- 既定 ON/OFF とスコープの既定値（成果物フォルダ限定で既定 ON が有力）。
- known-good タグの命名・保持件数。
- 回帰ループ検出（同一領域の診断→修正が N 回連続で停止し「直前の動く版へ戻すか」を問う）を A の上に将来載せるか。ToDo にループ署名が明確に出るため技術的には可能。本設計では非対象（将来拡張）。

---

## 5. 機能 D：ランタイムスモーク

### 5.1 線引き（過信しない）

- **できないこと**：操作感・ゲームバランス・ロックオン挙動の良し悪し・「面白いか」。アクションゲームの本質は機械検証不能。
- **できること（今回の沼はここ）**：未捕捉例外（`lerpAngle is not a function`）、console error、真っ黒/空 canvas、開始後フリーズ等の**破滅的・機械的失敗**。
- **再定義**：D は「品質検証」ではなく **「破滅的失敗の早期検知」**。ゲーム性には踏み込まない。

### 5.2 能力（Tool）

`src/browser/playwright-manager.ts` を露出した **ビルトイン Tool**。手順（実装済み）：

1. headless でロード → `networkidle` 待ち（best-effort）→ settle。console error / pageerror をロード前から回収
2. **入力前ベースライン**：スクショ 2 枚で「自走アニメの有無（idleAnimated）」を測る
3. canvas に focus → 合成入力（Enter/Space/中央クリック → 矢印/WASD）
4. **入力後**：スクショ 2 枚で「入力反応（respondedToInput＝遷移 or 継続動作）」を測る
5. **致命判定**：未捕捉例外/console error があれば FAIL。加えて **「自走アニメも無く入力反応も無い＝画面が死んでいる」場合のみフリーズ FAIL**

ゲームの中身を理解せず「即死していないか／画面が生きているか」だけを判定する。
- **誤検知対策**：自走アニメがある場合は入力反応をピクセルで断定できないため FAIL にせず、その旨を報告（手応えは人間が試遊）。
- **blank canvas 判定は情報のみ**（単独 FAIL にしない）：左上サンプル/単色フレームで誤検知しやすく、WebGL（three.js 等の主対象）は判定不能。WebGL の死活はフリーズ判定と console error で代替する。

- **MCP 化の条件**：Claude Code や他エージェントからも同じスモークを使い回したい場合のみ。当面アプリ専用なら Tool で十分（MCP は IPC オーバーヘッド分の損）。

### 5.3 運用（既存スキル更新）

新規スキルは作らず **`src/skills/builtin/game-development/SKILL.md` に追記**。同スキルは既に「NaN 混入」「float 添字 → undefined → 描画停止」という失敗教訓を蓄積しており（＝今回の「動いて見えるのに壊れている」系）、検証が「ファイル冒頭コメント」止まりで機械チェックが無い。ここにスモークゲートを足すのが整合的。

- 追記内容（Step 3〜完了条件）：「保存後、スモーク Tool を実行。console error 0 件 ＆ Start 前後で canvas が変化、を満たすまで `done` と宣言しない。ただしゲーム性は判定対象外」。
- 依存：スモーク Tool（5.2）が存在すること。**Tool だけで Skill 未更新＝持っているが使わない／Skill だけで Tool 未実装＝指示はあるが手が無い**。両輪で初めて機能する。

### 5.4 オープン論点

- 対象判定：「ブラウザ成果物（index.html を持つ output）」に限定。CLI/ターン制（将棋・トランプ）には適用しない切り分けをスキル側でどう書くか。
- Start の合成入力をどう汎用化するか（Enter / Space / クリック等の試行順）。flaky 化を避ける待ち時間設計。

---

## 6. 実装可否の判断材料

| 観点 | A シャドウ Git（確定） | D スモーク（確定） |
|---|---|---|
| 効果 | 高（毎ターンの復元点で「復旧不能」を構造的に解消。モデル非依存） | 中（破滅的失敗の早期検知。往復削減） |
| モデル負担 | ほぼゼロ（Hook が裏で実行） | 低（呼び出し判断のみ） |
| 実装規模 | 小〜中（Hook＋シャドウ Git 運用＋`/checkpoint` コマンド） | 中（Playwright オーケストレーション＋スキル追記。flaky 対策あり） |
| 主なリスク | バイナリ資産の書き込み増幅 → スコープ/除外/gc で制御。SSD 寿命懸念は誤りと判明 | flaky・ゲーム種別の切り分け過不足 |
| ON/OFF | `config` フラグ＋`/checkpoint` で容易 | スキルが対象を判定（ブラウザ成果物のみ） |

**実装方針（確定）**：A・D とも実装する。
- **D**：スモーク Tool（Playwright 露出）＋`game-development` スキル追記。
- **A**：Hook＋シャドウ Git＋`/checkpoint` コマンド。成果物フォルダ限定・トグル可能。
- 順序：独立に着手可能。A のコミット引き金に D の合格を使うため、**D → A の順**だと known-good タグ連携を一度に組める。

## 7. 非ゴール（やらないこと）

- ゲーム性・面白さ・バランスの自動評価（D の対象外）。
- ユーザーの既存 Git リポジトリへの無断コミット・相乗り（A は別系統のシャドウ repo で統一）。
- アプリ自身の `src/` など成果物フォルダ外の自動スナップショット（スコープ外）。
- 回帰ループ検出の実装（将来拡張。本設計では非対象）。
- core 本体への直接埋め込み（Hook/Tool/Skill で表現可能なため）。

## 8. 実装ファイル（2026-06-02）

**D（スモーク）**
- `src/browser/playwright-manager.ts`：`runSmoke()`／`SmokeResult`。console error・pageerror 回収、Start前後スクショ差分（buffer 比較）、2D canvas 空判定（WebGL は null）。
- `src/tools/definitions/game-smoke.ts`：`game_smoke` ツール。path/url を受け file:// 変換し runSmoke 呼出、PASS/FAIL を整形。
- `src/index.ts`：`createGameSmokeTool` を登録。
- `src/skills/builtin/game-development/SKILL.md`：Step5 スモークゲート＋完了条件＋版管理の声がけを追記。

**A（チェックポイント）**
- `src/checkpoint/checkpoint-manager.ts`：シャドウ Git 運用（`--git-dir=~/.localllm/checkpoints/<session-id>` / `--work-tree=cwd`）。init/commitForFile/commit/list/restore/diffStat、scope 判定、info/exclude、直列化キュー、clearCurrent/clearAll/pruneOldSessions、gc。
- `src/config/types.ts`：`CheckpointConfig`（`checkpoints.enabled`=既定 false、`retention.{maxSessions,maxAgeDays}`）。
- `src/tools/tool-executor.ts`：file_write/file_edit 成功後に `commitForFile` を呼ぶ（有効時のみ）。
- `src/agent/agent-loop.ts`：`CheckpointManager` を生成し ToolExecutor へ注入、resume 確定後に `runCheckpointMaintenance()`（prune）、restore 時 `rebind`、`getCheckpointManager()` を公開。
- `src/index.ts`：resume 解決後に `agent.runCheckpointMaintenance()`。
- `src/cli/repl.ts`：`/checkpoint status|on|off|list|restore <n>|diff <n>|clear [--all]`。
- `src/cli/completer.ts`：`/checkpoint` 系の入力補完。

**残作業**：手動 TTY で `/checkpoint` 系コマンドの対話表示と、実ゲーム作成フローでの `game_smoke` 呼出を確認（非TTYパイプでは対話品質を検証不可）。既定 OFF のため、有効化は `/checkpoint on`。

## 9. 活用導線（モデルへの教え方）

「裏で自動スナップショットするだけ」では沼脱出に使えない。モデルが**存在・使い所・復旧手段**を知る必要がある。ユーザー判断（2026-06-02）：

- **復旧の主体 = モデルが提案・人間が実行**。restore ツールはモデルに渡さない（誤った版を選んで良い作業を失うリスク回避。「復旧に人間を残す」設計原則とも整合）。
- **有効化 = build系タスクでモデルが `/checkpoint on` を提案**（既定 OFF を維持）。

教える場所（3 touchpoint）：
1. **着手時の提案** → `game-development` スキル「版管理」節：チェックポイントが無効なら作成開始時に `/checkpoint on` を提案。
2. **回帰時の復元提案** → (a) `shared-principles.ts` の `buildEscalationRules`（壁ドンループ）に「回帰したら前進修正を重ねず `/checkpoint restore` を提案」を tier 別に追加。(b) `game_smoke` の FAIL 出力に同趣旨のヒントを同梱。
3. **原則としての常識** → 同上 escalation rules が全 tier で常時提示される。

実装ファイル（追加分）：`src/agent/shared-principles.ts`、`src/tools/definitions/game-smoke.ts`（FAIL ヒント）、`src/skills/builtin/game-development/SKILL.md`（版管理節）。

## 10. サブエージェントレビュー反映（2026-06-03）

独立レビュー（設計者・開発者目線）で判明した欠陥を修正。

| # | 指摘 | 対応 |
|---|---|---|
| **H1** | resume 時にチェックポイントが継承されない（checkpoint用id=毎起動の timestamp、resume用id=session.meta.id で別名前空間。restoreSession も rebind せず）。**中断→再開という中心ユースケースで戻せない** | checkpoint を **session.meta.id で採番**（構築時 `rebind`）。`restoreSession` で resume 先 id へ `rebind`。prune は identity 確定後（`runCheckpointMaintenance`）に移し、復元対象の誤削除も防止 |
| **H2** | `git checkout <hash> -- .` は対象コミット以降に**追加されたファイルを消さない**→「戻したのに壊れたまま」 | restore を「復元前に自動スナップショット → 追加ファイル（`diff --diff-filter=A <hash> HEAD`）を作業ツリーから削除 → checkout」で**完全一致**に。HEAD は進めず forward 履歴温存 |
| **M3** | スコープが cwd 全体で `.env`/鍵まで平文シャドウGitに混入しうる（設計書「成果物フォルダ限定」と乖離） | work-tree を `workTreeDir` 設定で限定（既定 `sandbox/output` or cwd）。機密パターン＋`maxFileSizeMb`（既定25）超を除外 |
| **H3/M5** | フリーズ判定がスクショ完全一致依存で誤検知両方。単色背景を blank 誤判定。WebGL で blank 不能 | 入力前ベースラインで自走アニメを測り、**自走も反応も無い時だけ**フリーズ FAIL。canvas focus・`networkidle` 待ち追加。blank は最終状態計測の**情報のみ**（単独 FAIL にしない） |
| M1/M4 | 同ターン複数変更でメッセージが先頭1ファイルだけ／ensureInit 非対称 | `add -A` は維持（スナップショット整合）し、メッセージを staged ファイル群から生成。`commit()` の冗長 init を整理 |
| L1/L2/L4 | `list(Math.max(n,30))` 直感に反する／数値検証緩い／コミット失敗が不可視 | `list(n)`、`/^\d+$/` 検証、`/checkpoint status` に直近コミット失敗を表示 |

**未実装（将来案）**：Stop フックでの 1 ターン 1 コミット集約、スモーク合格時の known-good 自動タグ、回帰ループ自動検出。

**実証（このコミットで確認）**：
- H2: restore #2 で後から追加した `enemy.js` が消え `main.html` が旧版に戻る。
- M3: `.env` と 2MB ファイル（cap 1MB）が除外、通常テキストは追跡。
- H1: `rebind` 後のコミットが新名前空間へ、旧名前空間は空。
- スモーク: 開始キーで動くゲーム=pass（誤検知解消）／完全静止=fail／例外=fail。
- tsc 通過。

**残作業**：手動 TTY で `/checkpoint` 系の対話表示、resume を跨いだ list/restore、実ゲーム作成フローでの `game_smoke` 呼出を確認。

## 11. サブエージェント 2 巡目レビュー反映（2026-06-03）

「最初の問題に気を取られ他を見落とす／改善後だから見える不具合」を狙い、先入観を与えない新規エージェントで再レビュー。1 巡目修正で新たに顕在化した欠陥を是正。

| # | 指摘 | 対応 | 実証 |
|---|---|---|---|
| **H-A** | restore の追加ファイル算出が `--diff-filter=A` のみで、**rename 先（R 分類）を取りこぼし**、復元後に余分なファイルが残る（H2 修正が不十分） | `git diff --no-renames --diff-filter=AC` に変更（rename 先を A として検出） | rename 後 restore で `renamed.txt` が消え `old.txt` 復活 |
| **H-B** | `git add -A` がユーザー `.gitignore` を尊重し成果物が歯抜けに（設計書は `-f` と記載＝乖離） | `-f` は info/exclude も貫通し機密混入するため不採用。`.gitignore` 尊重を**確定仕様**として設計書を訂正（§4.5） | — |
| **M-A** | restore が直列化キューを迂回し index.lock 競合の恐れ | restore 本体をキューに載せて直列化 | tsc 通過・動作確認 |
| **M-B** | restore で追加ファイル削除後に空ディレクトリが残る | 削除後、work-tree 内に限り空の親dirを掃除 | nested `sub/new.js` 削除＋空 `sub/` 除去 |
| **M-D** | スモークの console error が favicon/CORS/`net::ERR` 等のネットワークノイズで誤 FAIL | ネットワーク系ノイズを除外（未捕捉例外は厳格維持） | favicon404＋無効画像のページが pass・consoleErrors 0 |
| **L-A** | work-tree 外作業時に「ON なのに履歴空」に気づきにくい | `/checkpoint status` に対象フォルダパスを表示 | — |

**1 巡目修正の妥当性（2 巡目で確認された点）**：`git checkout <hash> -- .` の pathspec `.` は **work-tree 基準**で解決され CWD≠work-tree でも正しい／`session.meta.id` 採番で `--resume`/`--continue` 双方が再接続／`/model` 切替は AgentLoop を再生成せず名前空間維持／prune は resume 確定後に実行。**退行なし。**

**M-C（情報）**：2D canvas でも CDN 画像描画で `getImageData` が SecurityError → blank 判定が null（判定不能）に落ちることがある。blank は情報のみのため実害なし。

## 12. 評価者レビュー反映（2026-06-03）

QA/受け入れ評価者の視点（当初問題を本当に解決し実運用で価値が出るか）でのレビュー反映。判定は「条件付き Ship 可」だった。

| # | 指摘 | 対応 |
|---|---|---|
| **H1** | 既定 OFF＋声がけ頼みでは「ただ作ってと言っただけのユーザー」を取りこぼす（声がけは best-effort・初手の破壊が提案前に起きる） | **既定を条件付き ON に変更**：未設定時は work-tree が成果物フォルダ（`sandbox/output` 等）に解決できた場合のみ ON、cwd 全体になる場合は OFF。明示 `enabled` 設定が優先。`config.checkpoints.enabled` の意味を更新 |
| **git 無し** | 既定 ON だと git 未インストール時に「ON のつもりで実は記録ゼロ」（見かけ倒し） | 起動時に有効かつ git 未検出なら**可視警告**。`/checkpoint status` にも git 未検出を赤字表示。`isGitReady()` を追加 |
| **H2** | `/checkpoint`（と `/cost`）が `/help` 未掲載で人間が復旧コマンドを発見できない | `displayHelp` に追記 |
| **M1** | スモークの「自走アニメ→PASS」抜け穴（点滅タイトル等で Start が壊れていても PASS）が過信を生む | `game_smoke` PASS 出力と `game-development` スキルに「**PASS=完成ではない／開始遷移・操作は人間が必ず試遊**」を明記 |
| **M2** | 自動テストが皆無（repo に vitest スイートがあるのに） | `tests/checkpoint/checkpoint-manager.test.ts` を追加（13 ケース：restore exact-match／追加・rename・空dir掃除／scope外no-op／無効時／機密・巨大除外／rebind／clear／メッセージ／resolveWorkTree）。HOME/USERPROFILE を一時dirへ隔離しクロスプラットフォーム動作 |
| L1/L2/M3 | .gitignore 除外の不可視／scope 環境差／resume 時 enabled | `/checkpoint status` に対象フォルダ表示済み。残りは軽微で据え置き |

**未実装（将来案・据え置き）**：DOM/console から「ゲーム状態が playing に遷移したか」を検出してスモークの false PASS を減らす案。known-good タグ。回帰ループ自動検出。
