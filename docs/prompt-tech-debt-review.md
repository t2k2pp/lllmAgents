# プロンプト棚卸しレビュー (2026-04-29)

## 目的
- 局所解 / フォールバック / 仮対応の恒久化を可視化する (修正は別ターン)
- 各項目はユーザーが「残す / 直す / 削る」 を判断できる材料を提供
- 表記の凡例: 「事実」 = ファイルやドキュメントから直接読み取れる内容。 「推測」 = 文脈やコメントから推定される背景

## 調査対象ファイル
第1優先 (中核): `src/agent/system-prompt.ts`, `harness-intervention.ts`, `sub-agent.ts`, `tool-guides.ts`, `llm-profiles.ts`
第2優先 (評価/分類/圧縮): `src/agent/evaluator.ts`, `intent-classifier.ts`, `hierarchical-compressor.ts`
第3優先 (セカンドLLM): `src/second-llm/second-llm-manager.ts`
第4優先 (ツール description): `src/tools/definitions/*.ts` (重点: second-llm.ts, task.ts, bash.ts, file-edit.ts, file-read.ts, ask-user.ts, response-complete.ts, sandbox-info.ts, plan-mode.ts, todo-write.ts)
第5優先 (ビルトインスキル): `src/skills/builtin/*/SKILL.md` (全 17 件)
第6優先 (外部エージェント定義): `src/agents/builtin/*.md` (全 4 件)
背景資料: `docs/harness-engineering-phase5-progress.md` (1137行), `harness-engineering.md`, `prompt-optimization.md`, `llm-profile-descriptions.md`, `v030_second_llm_design.md`

## サマリ
- 調査対象ファイル数: 約 44 ファイル (中核 5 / 評価 3 / セカンド 1 / ツール 12 / スキル 17 / 外部 agent 4 / その他 2)
- 検出件数: 計 44 件 (重大 11 / 中 19 / 軽 13、 + ID-032 は ID-039 へ統合済みスタブ)
- 第 1 回調査 (2026-04-29): ID-001〜030 (中核 + ツール + スキル 5件)
- 第 2 回追加調査 (2026-04-30): ID-031〜045 (外部 agent 定義 + 残スキル 12件 + ツールテンプレ統一)
- 重大項目トップ3:
  1. **[ID-031]** 外部 agent 定義 4 ファイルが英語短文 + ハーネス原則ゼロで `buildSubAgentStrategyPrompt()` の哲学とほぼ完全に断絶
  2. **[ID-001]** system-prompt の「対話レジスター + Acceptance Checklist + 検証ルール表」 が二重三重に重複し肥大化
  3. **[ID-014]** `sub-agent.ts` の FALLBACK_CONFIGS と外部 agent 定義が二重存在し fallback が常時生きている恐れ
- 重大項目 (順位下) :
  4. [ID-002] harness-intervention のセカンドLLM 用プロンプトが中核と内容重複
  5. [ID-003] system-prompt の dialogueLockUntil 動作仕様の漏出
  6. [ID-005] 委任 3 条件が system-prompt + tool description + hard gate の 3 重化
  7. [ID-033] excel/powerpoint スキルが Python テンプレート 200 行強を SKILL.md 本文に内包 (References パターン違反)
  8. [ID-034] skill-creator が完全英語 + 当プロジェクトに存在しないスクリプト (init_skill.py / package_skill.py) への参照を含む
  9. [ID-035] excel/powerpoint/add-repl-command/skill-creator が `tools:` フロントマターを持つ一方、 game-development/dev-workflow 等は持たない (一貫性欠落)
  10. [ID-039] code-review / pr-review / code-reviewer (3 件) が同じ責務でばらばらに存在
  11. [ID-042] excel/powerpoint の「絶対ルール」 がレジスター無視で常に production 相当 (rough 依頼でもテンプレ全載せ)

---

## 検出項目

### [ID-001] system-prompt: 「対話レジスター」 → 「Acceptance Checklist」 → 「検証ルール表」 が三層で重複し巨大化 (重大度: 重大)
- **箇所**: `src/agent/system-prompt.ts:54-195`
- **テキスト断片**:
  ```
  # 対話レジスター [必須] — 「どこまでやれば終わりか」 の暗黙合意 (15行)
  # Acceptance Checklist [standard / production で必須] (5行)
  # 検証ルール [必須] — レジスターに応じて深さを変える (10行 + 表)
  # 応答完了の宣言 [必須] (5行)
  # スコープ厳守 [必須] (4行)
  # 失敗時のエスカレーション [必須] (8行)
  # ユーザー拒否や委任失敗に対する基本姿勢 [必須] (10行)
  # ユーザー指示の経路を勝手に変えない [必須] (6行)
  # 委任の判断 [必須] (15行)
  # 計画モード (enter_plan_mode) の発動閾値 [必須] (8行)
  ```
- **疑いの種別**: 重複 / 局所解の積み重ね / マグナムオプス化
- **背景**: progress.md の Phase 5 第3〜10ラウンドで段階的に追加された (推測)。 「[必須]」 マーカーが 9 セクションに付いている = 全部「最重要」 と謳っているため優先順位がモデルから見えない (事実)
- **現状の挙動**: 1 ターンあたり恒常的に約 100 行 / ~3000 トークンが先頭に居座る (事実)。 ローカルLLM (~32B) は冒頭の重要原則をすべて記憶できない可能性 (推測)
- **修正案** (具体プラン):
  1. **system-prompt.ts に残す (常時注入が必須な行動原則)** 4 セクション、 計 ~35 行:
     - 対話レジスター (4 段階の判定基準のみ。 表は維持) — L60-78
     - Acceptance Checklist の宣言義務 — L80-85
     - 応答完了の宣言 (response_complete を呼ぶ事実のみ。 「[自己点検 N/3]」 の細部は削る → ID-008 と統合) — L106-111
     - 失敗時のエスカレーション (壁ドンループ回避) — L124-130
  2. **`tool-guides.ts` の遅延注入へ移す** (該当 tool 初回使用時のみ注入) 5 セクション、 計 ~70 行:
     - 検証ルール表 (L88-104) → `bash.ts` 初回 or `file_write.ts` 初回で注入。 注入関数名: `buildVerificationGuide(extension: string): string`
     - スコープ厳守 (L113-117) → `bash.ts` の find/ls 系初回で注入
     - 委任の判断 + 委任時のレジスター継承 + 委任時の禁忌 (L151-176) → `second_llm_agent.ts` / `task.ts` の初回呼出で注入。 関数名: `buildDelegationGuide(): string`
     - ユーザー指示の経路を勝手に変えない (L143-149) → ID-004 で削除案。 残すなら `second_llm_agent` 失敗時のエラーメッセージ内に統合
     - 計画モードの発動閾値 (L178-188) → `plan_mode.ts` description が既に持つので削除 (ID-027 と統合)
  3. **削除** (ハーネス実装詳細):
     - 「ユーザー拒否や委任失敗に対する基本姿勢」 のうち L141 (「ハーネスは ① ... 対話必須ロックを発動」) のみ削除 → ID-003
     - 削減目標: 195 行 → 約 90 行 (53% 減)
  4. **段階的開示の関数 signature 例** (`src/agent/tool-guides.ts` に追加):
     ```typescript
     export function buildDelegationGuide(): string {
       return `[ガイド: 委任 (task / second_llm_agent / second_llm_consult) の判断]
     委任は 3 条件のいずれかが満たされる時のみ:
       1. コンテキスト保護 / 2. 並列性 / 3. 専門性
     委任時の必須 4 点 (レジスター / Acceptance Criteria / 仕様ファイルパス / 保存先パス) を delegate メッセージに含める。`;
     }
     export function buildVerificationGuide(ext: string): string { ... }
     ```
- **判断ポイント**:
  - (a) ローカル LLM (~32B) でも段階的開示が機能するか? → 機能するなら大幅縮小可
  - (b) 「すべての原則を毎回見せた方がモデルが守る」 という直感が正しいか? → 計測が必要
  - (c) 「Phase 5 第3ラウンドで導入した対話レジスターは現行の Sonnet 4.5 / Opus 等のクラウドモデルに本当に必要か?」 を Claude Code の system-prompt と照合して判断

### [ID-002] harness-intervention.ts: sub-agent prompt が system-prompt と独立に成長し原則重複 (重大度: 重大)
- **箇所**: `src/agent/harness-intervention.ts:59-117`
- **テキスト断片**:
  ```
  # 対話レジスターの継承 [必須]
  # 仕様ファイルがあるときの作法 [必須]
  # Acceptance Criteria のチェック
  # ツール使用の原則
  # 検証ルール [必須]
  # 失敗時のエスカレーション [必須]
  # 想定外の信号への基本姿勢 [必須]
  # 成果物の保存責任 [必須] — テキスト返却は未完了
  # 完成までの完結 [必須]
  ```
- **疑いの種別**: 重複 / 局所解の固定化
- **背景**: progress.md Phase 5 第2ラウンドで「セカンドLLM の system prompt が 1 行しかなく非対称」 を是正した結果、 メイン system-prompt を縮小コピーした (事実)。 第3ラウンドでレジスター継承、 第5ラウンドで「保存責任」 を追加 (事実)
- **現状の挙動**: メインと sub-agent でほぼ同じ原則を 2 箇所メンテナンス。 ファイル間で僅かに表現が違うため一致取れていない可能性あり (推測)
- **修正案** (共通部品切り出しの具体形):
  1. **新ファイル `src/agent/shared-principles.ts` を作成** し、 メイン/サブで共有する原則を関数として export:
     ```typescript
     // src/agent/shared-principles.ts
     export function buildRegisterRules(): string {
       return `# 対話レジスター [必須]
     | レジスター | 完了基準 |
     | rough | 最小実装 + 構文チェック OK |
     | standard | 計画 → 実装 → 検証 (構文+動作) → Criteria 全項目 |
     | production | standard + エッジケース + 多面的テスト |
     未指定時は standard。 「rough で済ませた → 動かなかった」 は最悪のパターン。`;
     }
     export function buildVerificationRules(): string { /* レジスター連動の検証表 */ }
     export function buildEscalationRules(): string { /* 同種失敗 2 回 → 別アプローチ */ }
     export function buildToolUsageRules(): string { /* file_read 必須 / 古情報禁止 等 */ }
     export function buildSpecFileRules(): string { /* 仕様ファイルがあるときの作法 */ }
     ```
  2. **`system-prompt.ts:54` 周辺** で、 上記関数を組み合わせて構築:
     ```typescript
     parts.push(`あなたはメインLLM。 ユーザーの依頼をツールで完遂する。
     ${buildRegisterRules()}
     ${buildVerificationRules()}
     ${buildEscalationRules()}
     ${buildToolUsageRules()}
     # 委任の判断 [メイン固有]
     ...`);  // メイン固有: 委任判断 / Acceptance Checklist 立案 / response_complete
     ```
  3. **`harness-intervention.ts:buildSubAgentStrategyPrompt()`** も同様に構築:
     ```typescript
     return `# あなたの立場
     メインLLMから委任されたサブエージェント。 タスクの完成までを 1 回の委任で完結。
     ${buildRegisterRules()}
     ${buildSpecFileRules()}
     ${buildVerificationRules()}
     ${buildEscalationRules()}
     ${buildToolUsageRules()}
     # サブ固有: 成果物の保存責任 [必須] — テキスト返却は未完了
     ...`;  // サブ固有: 保存責任 / 質問返し禁止 / Acceptance Criteria の継承
     ```
  4. **削減目標**: 重複行を 50 行 × 2 → 共通 60 行 + 差分 20 行 × 2 = 100 行。 = 約 50% 重複削減
- **判断ポイント**: 「メインとセカンド/サブで原則が乖離した方が良いケースはあるか?」 を確認。 ない場合は機械的に統合 (上記 1-3 の手順で問題なし)

### [ID-003] system-prompt: 「ユーザー拒否や委任失敗に対する基本姿勢」 が agent-loop の dialogueLockUntil の動作仕様を内包 (重大度: 重大)
- **箇所**: `src/agent/system-prompt.ts:132-141`
- **テキスト断片**:
  ```
  ハーネスは ① ユーザーが file_edit/file_write を拒否したとき ② 委任先が失敗したとき
  に「対話必須ロック」 を発動し、 file_write/file_edit を tool 層で拒否する。
  解除は ask_user 呼出のみ。 「拒否を聞かなかったことにして再試行」 は構造的に不可能。
  ```
- **疑いの種別**: 局所解の恒久化 / ハーネス実装詳細の漏出
- **背景**: progress.md Phase 5 第10ラウンドで「対話必須ロック」 を実装した直後に system-prompt に説明を追加した (事実)。 Round 8 で「監視官的介入は全廃」 と謳いながら、 Round 9-10 でハードガードを追加し、 その存在を system-prompt で説明する形になっている (事実)
- **現状の挙動**: モデルに「ロック中は file_write が tool 層で拒否される」 と教えている。 Claude Code のシステムプロンプトはハーネスの内部実装は隠す方針 (推測)。 ロック発動条件の仕様変更時に system-prompt も同期しないとズレる (= 死文化リスク)
- **修正案** (具体な行操作):
  1. **L141 の 1 段落を削除** (3 行):
     ```
     - ハーネスは ① ユーザーが file_edit/file_write を拒否したとき ② 委任先が失敗したとき に「対話必須ロック」 を発動し、 file_write/file_edit を tool 層で拒否する。 解除は ask_user 呼出のみ。 「拒否を聞かなかったことにして再試行」 は構造的に不可能。
     ```
  2. **代わりに `agent-loop.ts` の対話必須ロックエラー文言 (file_write が tool 層で拒否される時の error 文字列) を充実させる**。 例 (修正後の error 文字列、 既存ロックエラーパス内):
     ```typescript
     // agent-loop.ts (ロック発動時の tool エラー)
     return {
       success: false,
       output: "",
       error: `[対話必須ロック] file_write は現在ロックされています。 直前にユーザーが拒否 (or 委任先が失敗) しました。 ` +
              `次の手: ask_user で意図を確認してから再試行してください (リトライ / 別アプローチ / 中断 を提示)。 ` +
              `ロックは ask_user 呼出で自動解除されます。`
     };
     ```
  3. **残す内容** (L132-140 の 「ユーザー拒否や委任失敗に対する基本姿勢」 1-4 番) は維持。 ハーネス挙動の説明だけが外れる
- **判断ポイント**: 「モデルにロックの存在を教える」 vs 「ロックがエラーメッセージとして自然に伝わる」 のどちらがモデル挙動として安全か。 → 「説明 + エラー」 の二重提示でも害が無いとの判断なら現状維持可

### [ID-004] system-prompt: 「ユーザー指示の経路を勝手に変えない」 セクションが Phase 5-Q3 由来でほぼ事故対応 (重大度: 中)
- **箇所**: `src/agent/system-prompt.ts:143-149`
- **テキスト断片**:
  ```
  # ユーザー指示の経路を勝手に変えない [必須]
  ユーザーが特定のモデル/ツール/経路を **明示指示** している場合 (...)、
  その経路が失敗しても **メインが独断で経路変更 (= 自分でやる) してはいけない**。
  必ず ask_user で 3 択を提示する:
    (a) リトライする (一時的な失敗の可能性)
    (b) メイン側で実行 (ユーザーが許可する場合のみ)
    (c) モデル設定を見直す (例: /second status, /second setup azure-*)
  ```
- **疑いの種別**: 仮対応の恒久化 (Phase 5-Q3 の特定セッション事故対応)
- **背景**: progress.md L497-545 の通り、 第4ラウンド (2026-04-28) でセカンドLLM Azure 429 が頻発したセッション直後に追加された (事実)。 元の事故 (azure-claude プロバイダーが完全URL を二重結合) は Round 4 で `azure-anthropic` プロバイダー新設で構造修正済み (事実)
- **現状の挙動**: 既に system-prompt の「拒否や委任失敗に対する基本姿勢」 セクションと内容が重複 (事実)。 「3 択提示」 という具体的 UI 指示が混入している (= /second status コマンドの仕様に依存、 死文化リスク)
- **修正案** (具体な行操作):
  1. **L143-149 の 7 行を完全削除**。 system-prompt から「経路を勝手に変えない」 セクションごと撤去
  2. **削除した内容のうち実質的に価値ある「経路指示の継続」 原則は L132-140 の「基本姿勢」 セクションの 4 番として吸収**:
     ```
     4. ユーザーが特定の経路 (モデル/ツール) を明示指示している場合、 失敗してもメインで独断フォールバックせず、 ask_user で確認する
     ```
  3. **「3 択提示」 という具体 UI 指示は `second_llm_agent` 失敗時のエラーメッセージ (`buildSecondLLMFailureError`、 ID-022) に集約**。 system-prompt 側はメッセージ仕様に依存しない
- **判断ポイント**: ユーザー観点で「経路を勝手に変えない」 を 1 セクション独立で残す価値があるか。 → 価値が薄ければ完全削除、 「メイン LLM の自律フォールバック傾向への明示的歯止めが要る」 ならば 1 行に圧縮して L132 の番号付きリストに同居

### [ID-005] system-prompt: 「委任の3条件 + 禁忌 + 委任時のレジスター継承」 が tool description (second_llm_agent.description) と重複 (重大度: 重大)
- **箇所**: `src/agent/system-prompt.ts:151-176` (system-prompt 側) と `src/tools/definitions/second-llm.ts:138-167` (tool description 側)
- **テキスト断片** (system-prompt):
  ```
  # 委任 (task / second_llm_agent / second_llm_consult) の判断 [必須]
  **委任は 3 条件のいずれかが満たされる時のみ。それ以外はインライン処理。**
  1. コンテキスト保護: ...
  2. 並列性: ...
  3. 専門性: ...
  ```
  tool description でも全く同じ「委任の3条件」 が説明されている。 さらに reason enum でハードガードしている (Phase 5-B3)
- **疑いの種別**: 重複 / 仕組み三重化 (system-prompt + description + hard gate)
- **背景**: progress.md 第1ラウンドで system-prompt に明文化、 第7ラウンドで reason 引数ハードガード化 (事実)
- **現状の挙動**: 同じ原則が 3 箇所。 修正時に同期取れていない可能性
- **修正案** (3 重化を 1.5 重化に):
  1. **system-prompt.ts L151-176 (約 25 行) を最小 3 行に圧縮**:
     ```
     # 委任 (task / second_llm_agent / second_llm_consult) の判断 [必須]
     委任は 3 条件 (コンテキスト保護 / 並列性 / 専門性) のいずれかを満たすときのみ。 詳細は各 tool の description を参照。
     委任メッセージには必ず ① レジスター ② Acceptance Criteria ③ 仕様ファイルパス ④ 成果物保存先パス を含める (4 点欠けたら委任失敗の典型パターン)。
     ```
  2. **`second_llm_agent.ts` の description は維持** (3 条件 + reason enum hard gate を担う = 第一の真実)
  3. **削除する内容 (system-prompt 側)**:
     - 「委任の禁忌」 リスト 3 項目 (L157-160) → tool description にすでに「[使うべきでない]」 として書かれている (L143-150) ため重複。 削除
     - 「委任時のレジスター継承」 4 項目 (L162-167) → 上記要約 (③④) で十分。 詳細は description へ移植
     - 「委任の責任分担」 (L169-172) → tool description の「[よくある誤用]」 に既出 (L150)
     - 「委任時の禁忌 (出力形式の固縛)」 (L174-176) → ID-006 で別途削除案
  4. **削減目標**: 25 行 → 3 行 (88% 減)
- **判断ポイント**:
  - (a) ハードガード (reason enum) を信用するなら system-prompt 側は最小化可
  - (b) ローカル LLM が tool description を読まない傾向があるなら、 system-prompt に詳細を残す必要あり (= 計測判断)
  - (c) 「3 重化」 を「1.5 重化」 に絞る代わりに、 description を強化する (3 重化解消の主流路は description) という方針で OK か

### [ID-006] system-prompt: 「委任時の禁忌 (出力形式の固縛)」 (Output ONLY HTML 禁止) が極めて局所的事故対応 (重大度: 中)
- **箇所**: `src/agent/system-prompt.ts:174-176`
- **テキスト断片**:
  ```
  委任時の禁忌 (出力形式の固縛):
  - 「Output ONLY HTML」 のような **テキスト返却を前提とした** 形式縛りは禁止。
    これは委任先が file_write をスキップする原因になる
  - 必ず「成果物は <パス> に file_write して、 return には完了サマリ + パスを書く」 という指示にする
  ```
- **疑いの種別**: 仮対応の恒久化 (Phase 5-Q6/Q7 の特定セッション症状対応)
- **背景**: progress.md L596-597 の Round 5 で実装。 「セカンドが HTML をテキスト返却 → メインが受け取って自分で file_write → 経路二重化」 への対応 (事実)
- **現状の挙動**: かなり狭い特殊文言 (Output ONLY HTML) を例示している。 通常委任ではこの文言は出ない (推測)。 `harness-intervention.ts:107-111` の sub-agent prompt にも同主旨の「成果物の保存責任」 が書かれており重複 (事実)
- **修正案** (具体な行操作):
  1. **system-prompt.ts L174-176 の 3 行を完全削除**。 `harness-intervention.ts:107-111` (sub-agent prompt の「成果物の保存責任」) で同主旨が **委任先側に届く** ため不要
  2. **削除 before/after**:
     ```
     [before, system-prompt L174-176]
     委任時の禁忌 (出力形式の固縛):
     - 「Output ONLY HTML」 のような **テキスト返却を前提とした** 形式縛りは禁止。 これは委任先が file_write をスキップする原因になる
     - 必ず「成果物は <パス> に file_write して、 return には完了サマリ + パスを書く」 という指示にする

     [after]
     (削除のみ)
     ```
  3. **代わりに ID-005 で残す要約 3 行内に「成果物保存先パスを delegate メッセージに含める」 (④) で十分カバー** されているか確認
- **判断ポイント**: 委任先が「Output ONLY」 と指示されることは現実にどれくらいあるか? → progress.md L596-597 由来の特定セッション症状であれば、 そのセッションは過去のもの。 削除可

### [ID-007] system-prompt: 「ファイル内容確認は file_read（bash の cat/head 不可）」 が tool description と重複 (重大度: 軽)
- **箇所**: `src/agent/system-prompt.ts:121` と `src/tools/definitions/bash.ts:97` および `dev-workflow/SKILL.md:9`
- **テキスト断片**:
  ```
  (system-prompt) ファイル内容確認は file_read（bash の cat/head 不可）
  (bash.ts)       (1) ファイル中身確認 → file_read。
  (dev-workflow)  ファイル内容の確認には file_read を使う。bash (cat/type/head) は使わない
  ```
- **疑いの種別**: 重複 (3 箇所)
- **背景**: harness-engineering.md (Phase 1) の中核ルールだが、 各レイヤに伝播してそれぞれに残った (推測)
- **現状の挙動**: 同じことを 3 箇所で言うのは冗長
- **修正案** (3 箇所 → 1 箇所に集約):
  1. **`bash.ts:97` (tool description) のみ残す**。 description はモデルへ確実に届く第一の真実とする
  2. **削除する 2 箇所**:
     - `system-prompt.ts:121` の「ファイル内容確認は file_read（bash の cat/head 不可）」 1 行 → 削除
     - `dev-workflow/SKILL.md:9` の「ファイル内容の確認には file_read を使う。bash (cat/type/head) は使わない」 1 行 → 削除 (ID-028 で他の重複と一括処理)
  3. **削減**: 3 重 → 1 重 (description 1 行のみ)

### [ID-008] system-prompt: 「コードブロック retry」 系 / 自己点検メッセージのテキストが agent-loop と分散 (重大度: 中)
- **箇所**: `src/agent/system-prompt.ts:106-111` と `src/agent/agent-loop.ts:62-71, 718-828`
- **テキスト断片** (system-prompt):
  ```
  # 応答完了の宣言 [必須]
  作業が終わったら **必ず response_complete ツールを呼ぶ**。summary にユーザー向け要約を入れる。
  - 呼ばないとハーネスが「[自己点検 N/3]」を最大3回まで要求する（上限到達でターン強制終了）
  - 自己点検メッセージはユーザー発言ではない。ハーネス通知である。
  ```
  agent-loop.ts:62 で `formatSelfCheck()` 関数が個別の懸念ごとにメッセージを再構築している
- **疑いの種別**: ハーネス内部実装の漏出 / 重複
- **背景**: Phase 6 (docs/harness-engineering.md L378-441) の自己点検フェーズ実装で導入 (事実)。 過去 5 種類の偽ユーザーメッセージ問題を統合した経緯
- **現状の挙動**: モデルに `[自己点検 N/3]` の挙動を細かく説明している。 これは Phase 6 の改善で「偽ユーザーメッセージではないと明示」 する目的だが、 説明が長い
- **修正案** (具体な before/after):
  1. **system-prompt.ts L106-111 (6 行) を 3 行に圧縮**:
     ```
     [before]
     # 応答完了の宣言 [必須]
     作業が終わったら **必ず response_complete ツールを呼ぶ**。summary にユーザー向け要約を入れる。
     - 呼ばないとハーネスが「[自己点検 N/3]」を最大3回まで要求する（上限到達でターン強制終了）
     - 自己点検メッセージはユーザー発言ではない。ハーネス通知である。内容を確認し、不足なければ response_complete、不足があれば該当ツールを呼ぶ
     - 単純な挨拶や短い質問への応答でも、会話が完結したら response_complete を呼んでよい
     - standard / production レジスターで Acceptance Checklist の未消化項目があるなら response_complete は呼ばない (まだ完了ではない)

     [after]
     # 応答完了の宣言 [必須]
     作業が終わったら必ず response_complete ツールを呼ぶ。 summary にユーザー向け要約を入れる。
     standard / production レジスターでは Acceptance Checklist の全項目が ✓ になるまで呼ばない。
     ```
  2. **「[自己点検 N/3]」 の説明は `agent-loop.ts:formatSelfCheck()` 内のメッセージで自己説明的にする**:
     ```typescript
     // agent-loop.ts:62 周辺
     return `[自己点検 ${n}/3] ハーネスからの通知です (ユーザー発言ではない)。 ` +
            `直前のターンで response_complete が呼ばれませんでした。 ` +
            `タスクが完了していれば response_complete を呼んでください。 ` +
            `未完了の懸念があれば該当ツールを呼んでください: ${concerns.join(", ")}`;
     ```
- **判断ポイント**: モデルが `[自己点検]` マーカーを誤解するリスクが現状残っているか → メッセージ内部に「ハーネス通知」 と明記すれば system-prompt 側の説明は不要

### [ID-009] system-prompt: 検証ルール表が言語ごとのコマンドを ハードコード (重大度: 中)
- **箇所**: `src/agent/system-prompt.ts:88-96`
- **テキスト断片**:
  ```
  | 種別 | rough | standard | production |
  | .ts/.js | `node --check <file>` | + 関連テストを実行 | + lint + 型チェック |
  | .py | `python -m py_compile <file>` | + pytest 実行 | + lint + 型チェック |
  | HTML/CSS (Three.js含む) | file_read で主要要素確認 | ...
  | GUIアプリ (pygame/tkinter/Electron) | 構文チェックのみ |
  ```
- **疑いの種別**: マジックコマンド / 局所解
- **背景**: Phase 5 第3ラウンド (progress.md L432) でレジスター連動の表として導入 (事実)
- **現状の挙動**: 言語/フレームワークが pygame/tkinter/Electron/Three.js だけ列挙されている = ユーザーの過去タスク (3D ゲーム) に引きずられている (推測)
- **修正案** (table → 短文 + tool-guides 遅延注入):
  1. **system-prompt.ts L88-104 (検証ルール表 17 行) を 4 行に圧縮**:
     ```
     # 検証ルール [必須]
     コード/成果物を生成したら必ず検証する。 検証の深さはレジスターに応じて切替:
     - rough: 構文チェックのみ (例: node --check / py_compile)
     - standard: 構文 + 動作確認 (テスト実行 / file_read で主要要素確認)
     - production: standard + lint + 型チェック + 必要なら browser_screenshot
     ```
  2. **削除する table** (pygame/tkinter/Electron/Three.js の列挙) → セッション固有の名残
  3. **代わりに tool-guides.ts に `buildVerificationGuide(extension)` を追加** し、 `bash` 初回 or 検証コマンド初回呼出時に注入。 ID-001 と統合実装可
- **判断ポイント**: ローカル LLM (~32B) が抽象表現で具体コマンドを思いつけるか? → 計測必要だが、 経験的に `node --check`/`pytest` 程度の典型コマンドは生成可能。 マイナーフレームワーク (Three.js 等) のみ tool-guides 側で補強

### [ID-010] system-prompt: 環境情報セクションでシェル説明が isWindows 分岐 + 注釈付き (重大度: 軽)
- **箇所**: `src/agent/system-prompt.ts:206`
- **テキスト断片**:
  ```
  - シェル: ${isWindows ? "git bash (Unix構文を使用。cmd.exe/PowerShell構文は不可)" : process.env.SHELL ?? "/bin/sh"}
  ```
- **疑いの種別**: 仮対応コメント残留
- **背景**: harness-engineering.md A3 で「現在は cmd.exe/PowerShell と書いてあるが実際は git bash 」 として修正された (事実)。 修正履歴の名残
- **現状の挙動**: Windows ユーザーのみ詳細注釈。 macOS/Linux は素直に SHELL 環境変数。 動作は問題なし
- **修正案** (具体形):
  - **現状維持を推奨**。 動作している箇所を変更する必要は薄い
  - もし統一したいなら、 `src/utils/platform.ts` に `getShellLabel()` を新設して分岐を内部化:
    ```typescript
    // src/utils/platform.ts
    export function getShellLabel(): string {
      if (isWindows) return "git bash (Unix構文を使用。 cmd.exe/PowerShell構文は不可)";
      return process.env.SHELL ?? "/bin/sh";
    }
    ```
  - `system-prompt.ts:206` を `- シェル: ${getShellLabel()}` に短縮

### [ID-011] sub-agent.ts: FALLBACK_CONFIGS のシステムプロンプトが古い文体 (3-5 行の散文) (重大度: 中)
- **箇所**: `src/agent/sub-agent.ts:25-64`
- **テキスト断片**:
  ```typescript
  explore: {
    systemPrompt: `あなたはコードベース探索に特化したエージェントです。
  ファイル検索(glob)、コンテンツ検索(grep)、ファイル読み取り(file_read)のツールを使って
  コードベースを調査し、質問に答えてください。
  ファイルの編集や書き込みは行わないでください。
  調査結果を簡潔にまとめて報告してください。`,
    maxTurns: 20,
    allowedTools: ["file_read", "glob", "grep", "web_fetch", "web_search"],
  },
  plan: { (同様, 5 行) },
  "general-purpose": { (4 行) },
  bash: { (4 行) },
  ```
- **疑いの種別**: 死文化 / 重複
- **背景**: Phase 5 以前 (おそらく初期実装) のままで、 第2ラウンド以降に導入された `buildSubAgentStrategyPrompt()` (= 全 60 行の戦略プロンプト) との対比で取り残されている (推測)
- **現状の挙動**: task ツール経由で sub-agent を起動するときに使われる。 second_llm_agent (sub-agent prompt) と全く違う原則体系 (= レジスター/Acceptance Criteria/保存責任の概念がない)
- **修正案** (ID-014 と一緒に処理):
  1. **ID-014 の方針 (a) を取る場合** (外部 .md を正規):
     - FALLBACK_CONFIGS は完全削除。 古文体の問題は外部 .md 側で改善 (ID-031 で対応)
  2. **ID-014 の方針 (b) を取る場合** (FALLBACK_CONFIGS 残す):
     - 各 systemPrompt を以下に置換:
       ```typescript
       const FALLBACK_CONFIGS: Record<string, Omit<SubAgentConfig, "description">> = {
         explore: {
           type: "explore",
           systemPrompt: buildSubAgentStrategyPrompt({ readOnly: true }) +
                         "\n# 役割\nコードベース探索専任。 編集は禁止。 整理して return。",
           maxTurns: 20,
           allowedTools: ["file_read", "glob", "grep", "web_fetch", "web_search"],
         },
         // plan/general-purpose/bash も同様 (役割 1-2 行 + 共通プロンプト)
       };
       ```
     - `buildSubAgentStrategyPrompt({ readOnly })` のオプション化が必要。 readOnly=true の場合は L106-111 の「成果物の保存責任」 セクションをスキップ
- **判断ポイント**: 「task ツールはレガシー、 second_llm_agent が後継」 という解釈で良いか? その場合 task は廃止候補 (ID-024 と連動して判断)

### [ID-012] sub-agent.ts: hasLargeCodeBlock / extractFakeFileWriteCalls / 続き出力プロンプトが agent-loop と重複実装 (重大度: 中)
- **箇所**: `src/agent/sub-agent.ts:69-90, 220-300`
- **テキスト断片**:
  ```typescript
  this.history.addUserMessage("続きを出力してください。途中から再開してください。");
  ...
  this.history.addUserMessage(
    "コードをテキストで返しましたが、実際にファイルを作成してください。" +
    "file_writeツールを呼び出して、指定されたパスにファイルを保存してください。" +
    "コードをチャットに書くのではなく、必ずfile_writeツールを使用してください。"
  );
  ```
- **疑いの種別**: 重複 / Phase 6 統合漏れ
- **背景**: Phase 6 (harness-engineering.md L378-441) で「偽ユーザーメッセージは廃止し自己点検フォーマットへ統一」 と決まったが、 sub-agent.ts は agent-loop.ts の `formatSelfCheck()` を使わず古い「ユーザー発話偽装」 のままになっている (事実)
- **現状の挙動**: task ツール経由のサブエージェントは Phase 6 改革の対象外で、 偽ユーザー発言が injection されている
- **修正案** (具体な統合先):
  1. **`src/agent/self-check-messages.ts` (新規) を作って共通化**:
     ```typescript
     // src/agent/self-check-messages.ts
     export interface SelfCheckOptions { kind: "missing_response_complete" | "fake_file_write" | "incomplete_response"; details?: string; }
     export function formatSelfCheck(n: number, max: number, opts: SelfCheckOptions): string {
       const header = `[自己点検 ${n}/${max}] ハーネス通知 (ユーザー発言ではない)。`;
       switch (opts.kind) {
         case "missing_response_complete": return `${header} response_complete が未呼出です。 完了なら呼んでください。`;
         case "fake_file_write": return `${header} コードがテキストで返されました。 file_write でファイル化してください: ${opts.details}`;
         case "incomplete_response": return `${header} 応答が途中で切れています。 続きを出力してください。`;
       }
     }
     ```
  2. **`agent-loop.ts:62-71, 718-828`** と **`sub-agent.ts:69-90, 220-300`** の偽ユーザーメッセージ injection を `formatSelfCheck()` 呼出に置換
  3. **削除**: `sub-agent.ts:222` の「続きを出力してください。途中から再開してください。」 等の偽ユーザー文言、 約 30-50 行
- **判断ポイント**: 「ユーザー発話偽装の弊害」 (progress.md L321-340) は task ツールでも発生し得るか? → 同じハーネス哲学で動かすなら統一すべき

### [ID-013] tool-guides.ts: secondLLM ガイドの「コードレビュー・方針の壁打ち」 が tool description と重複 (重大度: 軽)
- **箇所**: `src/agent/tool-guides.ts:24-34`
- **テキスト断片**:
  ```
  [ガイド: セカンドLLMの使い方]
  以下の場面で自発的に使用すること:
  - コンテキスト節約: 大きなファイルの調査や要約など、メインの会話履歴を消費したくない作業を委任
  - コードレビュー: 自分が書いたコードの品質チェックを別の視点で確認
  - 方針の壁打ち: 実装アプローチに迷った時に相談
  使い分け:
  - second_llm_consult: 単発の質問
  - second_llm_agent: ツールを使った複合タスク委任
  ```
- **疑いの種別**: 重複
- **背景**: prompt-optimization.md の「段階的開示」 で system-prompt から切り出されたが、 tool description (second-llm.ts) にも同様の「使うべき場面」 が書かれている (事実)
- **修正案** (重複削減 before/after):
  ```
  [before, tool-guides.ts:24-34]
  [ガイド: セカンドLLMの使い方]
  以下の場面で自発的に使用すること:
  - コンテキスト節約: ...
  - コードレビュー: ...
  - 方針の壁打ち: ...
  使い分け:
  - second_llm_consult: 単発の質問
  - second_llm_agent: ツールを使った複合タスク委任

  [after]
  [ガイド: セカンドLLMは自発的に活用してよい]
  描画/会話履歴の節約・別視点・並列処理に有用。 各ツール description の [使うべき場面] を参照。
  注意: セカンドLLM は本会話の履歴を見ていない。 prompt に背景を全て同梱すること。
  ```
  - 削減目標: 11 行 → 3 行 (= description で語られない「履歴非共有」 のみ補足)

### [ID-014] sub-agent.ts: FALLBACK_CONFIGS と外部 AgentDefinitionLoader の二重存在 (重大度: 重大)
- **箇所**: `src/agent/sub-agent.ts:25-64, 102-120`
- **テキスト断片**:
  ```typescript
  function resolveAgentConfig(type: SubAgentType): Omit<SubAgentConfig, "description"> | null {
    const loader = getLoader();
    const externalDef = loader.get(type);
    if (externalDef) {
      logger.debug(`Using external agent definition for '${type}' from ${externalDef.source}`);
      return agentDefToConfig(externalDef);
    }
    const fallback = FALLBACK_CONFIGS[type];
    if (fallback) {
      logger.debug(`Using fallback config for agent type '${type}'`);
      return fallback;
    }
    return null;
  }
  ```
- **疑いの種別**: フォールバック恒久化
- **背景**: AgentDefinitionLoader が後から追加されたが、 古い FALLBACK_CONFIGS が残っている (推測)。 外部定義ファイルが配布されていないと常に fallback が発火
- **現状の挙動**: ユーザー環境に外部 agent 定義ファイルが無い場合、 古い文体のプロンプトが永続的に使われる
- **修正案** (どちらを正規にするか決め打ち):
  - **事実確認**: 外部 agent 定義は `src/agents/builtin/` に 4 ファイル (code-reviewer / explore / general-purpose / plan) 存在。 `agent-loader.ts:170-174` の searchPaths 第1優先で読み込まれる (ビルトイン配布済み)。 ただし `bash` だけは外部 .md なし → FALLBACK_CONFIGS のみで生きている。
  - **方針決定**: **外部 agent 定義 (`.md`) を正規** にし、 FALLBACK_CONFIGS は撤去 or 最小防衛線化:
    1. **`src/agents/builtin/bash.md` を新規作成** (現在 FALLBACK のみ。 これを外部に移植):
       ```markdown
       ---
       name: bash
       description: Command execution specialist (git/build/test)
       tools: [bash, file_read, glob, grep]
       ---
       (本文は ID-031 の改善後テンプレで書く)
       ```
    2. **`src/agent/sub-agent.ts:25-64` の FALLBACK_CONFIGS を完全削除** し、 代わりに「外部定義が無ければ resolveAgentConfig は null を返してエラー」 に変える:
       ```typescript
       function resolveAgentConfig(type: SubAgentType): Omit<SubAgentConfig, "description"> | null {
         const externalDef = getLoader().get(type);
         if (externalDef) return agentDefToConfig(externalDef);
         logger.warn(`Agent definition '${type}' not found in src/agents/builtin/. ` +
                     `Available: ${getLoader().listNames().join(", ")}`);
         return null;  // task ツール側で「不明な agent type」 として user-facing エラー
       }
       ```
    3. **代替案 (より保守的)**: FALLBACK_CONFIGS を残すが、 中身を `buildSubAgentStrategyPrompt()` を呼ぶように変更:
       ```typescript
       const FALLBACK_CONFIGS = {
         "general-purpose": {
           type: "general-purpose",
           systemPrompt: buildSubAgentStrategyPrompt() + "\n\n# 役割\n汎用サブエージェント。 全ツール利用可。",
           maxTurns: 30,
         },
         // explore/plan/bash も同様。 「役割」 1-2 行 + 共通プロンプト
       };
       ```
- **判断ポイント**:
  - (a) **「外部 .md を正規」 派**: 撤去でコード簡潔化。 ただし bash 用 .md を新規作成する必要 (1 ファイル増)
  - (b) **「FALLBACK_CONFIGS を強化」 派**: 既存パスを残しつつ内容のみ刷新。 リスク低いが二重定義は残る
  - (c) ユーザー判断: どちらを取るか? Claude Code 流儀は「ビルトイン .md 同梱 + ユーザー上書き可能」 なので (a) を推奨。 ただし運用上 .md ファイル欠損時の安全網が要るなら (b) で `general-purpose` のみ FALLBACK 残し、 他は外部のみ
  - (d) (関連) `task` ツール自体を廃止して `second_llm_agent` 一本化する選択肢もあり (ID-024 と連動)

### [ID-015] evaluator.ts: Evaluator system prompt が AGENTIC / FALLBACK で 95% 同一の重複 (重大度: 中)
- **箇所**: `src/agent/evaluator.ts:269-343`
- **テキスト断片**:
  ```typescript
  const EVALUATOR_SYSTEM_PROMPT_AGENTIC = `あなたは独立したコードレビュアーです。...
  ## 評価ルール
  - 発見した問題は具体的に指摘すること...
  ` // (40 行)
  const EVALUATOR_SYSTEM_PROMPT_FALLBACK = `あなたは独立したレビュアーです。...
  ## 評価ルール
  - 提示された全ファイルを総合的に評価すること
  - 発見した問題は具体的に指摘すること...
  ` // (35 行)
  ```
- **疑いの種別**: 重複
- **背景**: secondLLM 利用可能/不可で 2 系統の prompt がほぼ同文 (事実)
- **現状の挙動**: 「評価ルール」 「評価基準」 「最終回答形式」 がコピペされている。 文字化け箇所 (`���` 多数) もある = 過去の編集ミス痕跡 (事実)
- **修正案** (具体な共通化):
  ```typescript
  // src/agent/evaluator.ts に追加
  const EVALUATOR_COMMON = `あなたは独立したコードレビュアーです。
  ## 評価ルール
  - 提示された全ファイルを総合的に評価する
  - 発見した問題は具体的に指摘する (ファイル名・行番号を明記)
  - 「まあ大丈夫だろう」 という甘い判定は禁止
  ## 最終回答形式
  ### 総合評価: <pass | fail | needs_improvement>
  ### 主要な問題
  - [ファイル:行] 問題説明
  ### 改善提案
  - 具体的な提案`;

  const EVALUATOR_SYSTEM_PROMPT_AGENTIC = `${EVALUATOR_COMMON}
  ## 作業手順 (ツール利用可)
  1. file_read で対象ファイルを精読
  2. grep / glob で関連箇所を確認
  3. 問題点を整理して回答`;

  const EVALUATOR_SYSTEM_PROMPT_FALLBACK = `${EVALUATOR_COMMON}
  ## 作業前提 (ツール利用不可)
  - 提示されたコード本文のみを読み判断する`;
  ```
  文字化けは ID-016 で別途修復
- **判断ポイント**: 文字化けによりモデルが意図を汲めない部分があるか (重要度に直結) → 「禁止」 が「���止」 になっている箇所はモデルが意味を取れない可能性大、 優先修復

### [ID-016] evaluator.ts: 評価プロンプトに 文字化け (`���`) が多数残っている (重大度: 中)
- **箇所**: `src/agent/evaluator.ts:57, 134, 136, 162, 244, 261, 310-326, 338` 等
- **テキスト断片**:
  ```typescript
  // フィー���バック → フィードバック
  // レビュー���象 → レビュー対象
  // 「まあ大丈夫だろう」という甘い判定は���止 → 禁止
  ```
- **疑いの種別**: 死文化 (文字エンコーディング破損)
- **背景**: 過去の編集 (Shift-JIS / UTF-8 混在等) でコメント・プロンプト本文が破損 (推測)
- **現状の挙動**: コメントは害なしだが、 system prompt 本文の文字化けはモデルが意味を取れない可能性
- **修正案** (具体な手順):
  1. `evaluator.ts` 内で `���` を含む全文字列を grep:
     ```bash
     grep -n "���" src/agent/evaluator.ts
     ```
  2. 各箇所を文脈推定で正字に置換 (代表例):
     ```
     "フィー���バック" → "フィードバック"
     "レビュー���象" → "レビュー対象"
     "���止" → "禁止"
     "���観" → "観点"
     ```
  3. ファイルを UTF-8 で保存し直し、 `npx tsc --noEmit` で型エラーが出ないか確認
  4. 修復後の文字列を簡易ユニットテストで検証 (= prompt 文字列が JSON.stringify を経由しても破損しないことを確認)

### [ID-017] hierarchical-compressor.ts: temperature=0.3 / maxTokens=1000/1500 がハードコード (重大度: 軽)
- **箇所**: `src/agent/hierarchical-compressor.ts:156, 157, 204, 205`
- **テキスト断片**:
  ```typescript
  const stream = this.provider.chat({
    model: this.model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    maxTokens: 1000,  // Layer 1
    ...
  });
  ...
  maxTokens: 1500,  // Layer 2
  ```
- **疑いの種別**: マジックナンバー
- **背景**: Layer 1 は短い要約用、 Layer 2 は統合要約用で意図的に違う (推測)
- **現状の挙動**: ローカル/クラウドモデルで適切な値が異なるが固定。 大きいモデル (Sonnet 4.5 等) では 1500 tok の上限に当たって要約が切れる可能性
- **修正案** (具体な定数化):
  ```typescript
  // src/agent/hierarchical-compressor.ts (ファイル先頭)
  /** Layer 1 圧縮 (個別メッセージ要約) のサンプリング設定。
   *  temperature=0.3: 多少の表現揺れは許容、 但し決定論寄り。
   *  maxTokens=1000: 1 メッセージあたりの要約上限。 これ以上はノイズが増える傾向。 */
  const COMPRESSOR_LAYER1_TEMPERATURE = 0.3;
  const COMPRESSOR_LAYER1_MAX_TOKENS = 1000;

  /** Layer 2 圧縮 (Layer 1 結果の統合要約) のサンプリング設定。
   *  maxTokens=1500: 統合要約は Layer 1 より長くてよい。 ただし context 圧迫しない上限。 */
  const COMPRESSOR_LAYER2_TEMPERATURE = 0.3;
  const COMPRESSOR_LAYER2_MAX_TOKENS = 1500;
  ```
  L156-157 / L204-205 を上記定数に置換

### [ID-018] intent-classifier.ts: temperature=0 / maxTokens=50 がハードコード (重大度: 軽)
- **箇所**: `src/agent/intent-classifier.ts:152-153, 192-193`
- **テキスト断片**:
  ```typescript
  temperature: 0,
  maxTokens: 50,
  ```
- **疑いの種別**: マジックナンバー
- **背景**: 分類タスクは決定論的にしたいので 0、 出力が JSON 1 行だから 50 で十分 (推測)
- **現状の挙動**: 妥当だが理由がコメントにない
- **修正案** (具体な定数化):
  ```typescript
  // src/agent/intent-classifier.ts (ファイル先頭)
  /** 分類タスクは決定論的に: temperature=0 で再現性確保 */
  const CLASSIFIER_TEMPERATURE = 0;
  /** 出力は JSON 1 行のみ (例: {"intent":"task_completion"})。 50 tok で十分 */
  const CLASSIFIER_MAX_TOKENS = 50;
  ```
  L152-153 / L192-193 を置換

### [ID-019] second-llm-manager.ts: consult の system prompt がインライン文字列で第1優先と乖離 (重大度: 中)
- **箇所**: `src/second-llm/second-llm-manager.ts:140-145`
- **テキスト断片**:
  ```typescript
  const systemPrompt =
    `あなたはメインLLMから単発相談を受けたサブエージェント。 直接的で完結した回答を返す。\n` +
    `- 質問返しはしない (情報不足なら妥当な仮定を置いて回答+「仮定したこと」を併記)\n` +
    `- 与えられた背景・コンテキストの中で答える。 推測の混入は最小限\n` +
    `- ツール実行はできない。 純粋な推論で回答`;
  ```
- **疑いの種別**: 局所解 / 散在
- **背景**: progress.md 第2ラウンドのコメント (`// Phase 5 第2ラウンド: consult はツール無し単発質問`) (事実)
- **現状の挙動**: `harness-intervention.ts:buildSubAgentStrategyPrompt` とは別経路で書かれている。 二重管理
- **修正案** (関数 signature 変更):
  ```typescript
  // harness-intervention.ts (signature 変更)
  export interface SubAgentPromptOptions {
    withTools?: boolean;  // false なら consult 用 (純推論モード)
    readOnly?: boolean;   // true なら explore/plan 用 (file_write 不可)
  }
  export function buildSubAgentStrategyPrompt(opts: SubAgentPromptOptions = {}): string {
    const { withTools = true, readOnly = false } = opts;
    const sections = [
      `# あなたの立場\nメインLLMから ${withTools ? "委任された" : "単発相談を受けた"} サブエージェント。`,
      buildRegisterRules(),  // ID-002 で切り出した共通部品
      ...(withTools ? [buildSpecFileRules(), buildToolUsageRules(), buildVerificationRules(), buildEscalationRules()] : []),
      ...(withTools && !readOnly ? [/* 成果物の保存責任 */] : []),
      `# 完成までの完結\n中途半端な状態で return しない。 質問返しはしない。`,
    ];
    return sections.join("\n\n");
  }
  ```
  - `second-llm-manager.ts:140-145` の `consult` 用インライン文字列を削除し、 `buildSubAgentStrategyPrompt({ withTools: false })` 呼出に置換

### [ID-020] second-llm-manager.ts: temperature 既定値 0.2 / 0.1 がインライン (重大度: 軽)
- **箇所**: `src/second-llm/second-llm-manager.ts:157, 223, 356`
- **テキスト断片**:
  ```typescript
  ...this.resolveSampling(0.2),  // consult / runAsAgent
  ...this.resolveSampling(0.1),  // runAsEvaluator
  ```
- **疑いの種別**: マジックナンバー
- **背景**: Evaluator は決定論寄りに 0.1 (推測)
- **現状の挙動**: 妥当だが各メソッド内に散らばる
- **修正案** (具体な定数化):
  ```typescript
  // src/second-llm/second-llm-manager.ts (ファイル先頭)
  /** consult / runAsAgent 既定 temperature。 0.2 でバランス (= 多少の創造性 + ある程度の決定性) */
  const DEFAULT_TEMPERATURE_AGENT = 0.2;
  /** runAsEvaluator 既定 temperature。 0.1 で決定論寄り (評価結果の再現性確保) */
  const DEFAULT_TEMPERATURE_EVALUATOR = 0.1;
  ```
  L157, L223, L356 のリテラルを上記定数に置換

### [ID-021] second-llm-manager.ts: MAX_ITERATIONS=15 / 10 がハードコード (重大度: 軽)
- **箇所**: `src/second-llm/second-llm-manager.ts:212, 345`
- **テキスト断片**:
  ```typescript
  const MAX_ITERATIONS = 15;  // runAsAgent
  const maxIter = params.maxIterations ?? 10;  // runAsEvaluator
  ```
- **疑いの種別**: マジックナンバー
- **背景**: progress.md L142 でも「セカンド側にハーネスが皆無で、 ツール試行錯誤に陥り 15 イテレーション上限に到達しやすい」 とある (事実)
- **現状の挙動**: 用途で違う数字 (15/10) が混在
- **修正案** (具体な定数化):
  ```typescript
  // src/second-llm/second-llm-manager.ts (ファイル先頭)
  /** runAsAgent の最大ツール呼出回数。 progress.md L142 によれば 15 回に到達しやすいので
   *  これより増やすと「セカンドが試行錯誤に陥り無限委任」 のリスク。 必要なら config 化検討。 */
  const MAX_AGENT_ITERATIONS = 15;
  /** runAsEvaluator の最大ツール呼出回数。 評価は探索量が agent より少ないので 10 で十分 */
  const DEFAULT_EVALUATOR_ITERATIONS = 10;
  ```
  L212 を `const MAX_ITERATIONS = MAX_AGENT_ITERATIONS;` に、 L345 を `const maxIter = params.maxIterations ?? DEFAULT_EVALUATOR_ITERATIONS;` に変更

### [ID-022] tool: second-llm.ts buildSecondLLMFailureError の「メイン側にフォールバックは意図違反」 が経路保持原則に依存 (重大度: 中)
- **箇所**: `src/tools/definitions/second-llm.ts:70-83`
- **テキスト断片**:
  ```typescript
  return (
    `${marker} ${toolName} の呼び出しが失敗: ${String(e)}\n` +
    `[原因] ${guidance}\n` +
    `[対処] ユーザーが委任を明示している場合は、 ask_user で 3 択を提示すること:\n` +
    `  (a) リトライする (...)\n` +
    `  (b) メイン側で実行 (ユーザーが許可する場合のみ)\n` +
    `  (c) モデル設定を見直す (/second status / /second setup azure-*)\n` +
    `[禁忌] 独断でメイン側にフォールバック (= file_write/file_edit を直接呼ぶ) は意図違反。 委任意図がある状況ではハーネス側の hard gate で拒否される。`
  );
  ```
- **疑いの種別**: ハーネス内部実装の漏出 / 局所事故対応の恒久化
- **背景**: Round 9 Gate 3 でユーザー委任失敗時の自助情報として追加 (事実)
- **現状の挙動**: ユーザーが「メインで実行」 と指示している通常ケースでも常にこのメッセージが出る (= ユーザー指示なくても出る)。 「委任意図がある状況では」 と前置きしているが、 文末で「ハードガード」 を明言していて誤解を招く
- **修正案** (条件分岐 + 簡素化):
  1. **`buildSecondLLMFailureError` の signature を拡張**:
     ```typescript
     function buildSecondLLMFailureError(toolName: string, e: unknown, opts?: { userExplicitlyDelegated?: boolean }): string {
       const category = classifySecondLLMError(e);
       const guidance = categoryGuidance(category);
       const base = `[セカンドLLM失敗:${category}] ${toolName}: ${String(e)}\n[原因] ${guidance}`;
       if (opts?.userExplicitlyDelegated) {
         // ユーザー委任意図あり: ask_user 3 択提示を含める
         return base + `\n[対処] ask_user で 3 択提示: (a) リトライ (b) メイン側で実行 (c) /second setup`;
       }
       // ユーザー指示なくセカンド自発呼出: 簡素なメッセージのみ (= メインで自然にフォールバック可)
       return base + `\n[対処] エラー内容を確認し、 必要なら別アプローチへ。`;
     }
     ```
  2. **agent-loop.ts** が `userExplicitlyDelegated` フラグを判定するロジックを持つ前提 (= ユーザー発言の中に「セカンドで」「task で」「Kimi に」 等が含まれていた直後の失敗ならフラグ true)
  3. **「[禁忌] 独断でメイン側にフォールバック ... ハードガードで拒否される」 行は削除** (実装詳細の漏出。 hard gate のメッセージは agent-loop 側のロックエラーで自明)

### [ID-023] tool: second-llm.ts categoryGuidance に `/second status` 等のコマンド名がハードコード (重大度: 軽)
- **箇所**: `src/tools/definitions/second-llm.ts:38-55`
- **テキスト断片**:
  ```typescript
  case "AUTH":
    return "API Key が無効/期限切れ/権限不足。 /second status で現在の保存形式を確認、 /second setup azure-* で再設定。";
  ```
- **疑いの種別**: マジック文字列
- **背景**: REPL コマンドが変わると死文化する
- **修正案** (抽象化 + 定数同期 のどちらか):
  - **方針 A (抽象化、 推奨)**:
    ```typescript
    case "AUTH":
      return "API Key が無効/期限切れ/権限不足。 セカンドLLM 設定の再確認・再設定が必要。";
    ```
  - **方針 B (定数同期)**:
    ```typescript
    // src/cli/repl-commands.ts (REPL コマンド名を export)
    export const REPL_CMD_SECOND_STATUS = "/second status";
    export const REPL_CMD_SECOND_SETUP_AZURE = "/second setup azure-*";
    // src/tools/definitions/second-llm.ts
    import { REPL_CMD_SECOND_STATUS, REPL_CMD_SECOND_SETUP_AZURE } from "../../cli/repl-commands.js";
    case "AUTH":
      return `API Key が無効/期限切れ/権限不足。 ${REPL_CMD_SECOND_STATUS} で確認、 ${REPL_CMD_SECOND_SETUP_AZURE} で再設定。`;
    ```

### [ID-024] tool: task.ts description が古い 3-5 行散文で SKILL 形式と非対称 (重大度: 中)
- **箇所**: `src/tools/definitions/task.ts:20-28`
- **テキスト断片**:
  ```
  サブエージェントを起動して複雑なタスクを委任する。
  利用可能なタイプ:
  - explore: コードベース探索(読取専用ツールのみ)
  - plan: 実装計画の設計(読取専用ツールのみ)
  - general-purpose: 汎用タスク(全ツール利用可能)
  - bash: コマンド実行特化

  複数のサブエージェントを並列に起動可能。独立したタスクは並列実行で効率化する。
  ```
- **疑いの種別**: 死文化 / 形式の非対称
- **背景**: second_llm_agent (Phase 5 で 4 要素テンプレ化済み) と比べ古い文体のまま
- **現状の挙動**: task と second_llm_agent の使い分けが description だけからは曖昧
- **修正案** (具体な description 改稿):
  ```typescript
  // src/tools/definitions/task.ts
  description:
    "メインLLM (あなた自身) を別コンテキストで起動してサブタスクを委任する。\n" +
    "[使うべき場面] (1) メインLLM の特性 (例: 大コンテキスト・特定の専門性) が活きるタスク。 " +
    "(2) 探索系 (explore/plan agent type) で読取専用の調査を分離。 " +
    "(3) second_llm_agent と並列起動して総時間短縮 (parallelCapable=true 時)。\n" +
    "[使うべきでない] (1) セカンドLLMの特性が合うタスク → second_llm_agent を優先。 " +
    "(2) 自分で 30 秒以内にできる軽作業 → インライン処理。 " +
    "(3) 細切れの連続委任 → 修正をまとめて 1 回で渡す。\n" +
    "[よくある誤用] (a) explore/plan agent に編集タスクを渡す → 読取専用。 " +
    "(b) general-purpose に「ファイル一覧出して」 程度を委任 → glob で十分。 " +
    "(c) bash agent に複雑な多段タスクを丸投げ → general-purpose を選ぶ。\n" +
    "[second_llm_agent との使い分け] task = メインLLM (= あなた自身) / second_llm_agent = 別モデル。 モデル特性で選ぶ。"
  ```
- **判断ポイント**: そもそも task と second_llm_agent を分けて持つ意義が今あるか?
  - **判断材料**: ユーザーが「シングル LLM 構成 (= second 未設定)」 のみ運用するなら task 単独で十分、 second_llm_agent は廃止候補。 「マルチモデル運用」 を前提とするなら両方必要 (parallelCapable で並列実行できるのが利点)

### [ID-025] tool: response-complete.ts 「ファイル存在 = 完了 のような薄い完了報告は禁止」 が standard レジスター固有 (重大度: 軽)
- **箇所**: `src/tools/definitions/response-complete.ts:60-62`
- **テキスト断片**:
  ```typescript
  `\n[次の手] (1) 残項目を実装/検証して todo を completed にする  (2) 部分完成で報告するなら force=true で再呼び出し (理由を summary に明記)。\n` +
  `[原則] 「ファイル存在 = 完了」 のような薄い完了報告は禁止。 standard 以上のレジスターでは Acceptance Criteria を満たしてから完了。`
  ```
- **疑いの種別**: 仮対応の恒久化 / 局所解
- **背景**: Phase 5 第3ラウンドの 3D ゲーム生成セッション (progress.md L240) を直接的な動機にしている (事実)
- **現状の挙動**: 「ファイル存在 = 完了」 という具体表現は、 ある特定セッション以外では文脈不明
- **修正案** (具体な before/after):
  ```
  [before, response-complete.ts:60-62]
  [次の手] (1) 残項目を実装/検証して todo を completed にする  (2) 部分完成で報告するなら force=true で再呼び出し (理由を summary に明記)。
  [原則] 「ファイル存在 = 完了」 のような薄い完了報告は禁止。 standard 以上のレジスターでは Acceptance Criteria を満たしてから完了。

  [after]
  [次の手] (1) 残 todo を消化して completed にする (2) 部分完成で報告するなら force=true で再呼び出し (理由を summary に明記)。
  [原則] standard 以上のレジスターでは Acceptance Criteria を満たさずに完了報告しない。
  ```
  - 「ファイル存在 = 完了」 という具体表現は削除 (= セッション固有の名残)

### [ID-026] tool: sandbox-info.ts description が冗長な散文 (重大度: 軽)
- **箇所**: `src/tools/definitions/sandbox-info.ts:13`
- **テキスト断片**:
  ```typescript
  description: "現在自分がアクセス可能なサンドボックス（ディレクトリ）のリストとOSレベルのサンドボックス状態を取得します。存在しないパスや許可されていないパスにアクセスしてエラーになった場合、このツールで自身が操作可能なスコープを確認してください。",
  ```
- **疑いの種別**: 冗長
- **修正案** (具体な短縮):
  ```typescript
  // src/tools/definitions/sandbox-info.ts:13
  description: "アクセス可能ディレクトリと OS サンドボックス状態を返す。 パス権限エラー時の確認用。",
  ```
  - 117 文字 → 38 文字 (68% 減)

### [ID-027] tool: plan-mode.ts description に「以下の場合に使用」 のリストがあり system-prompt と重複 (重大度: 軽)
- **箇所**: `src/tools/definitions/plan-mode.ts:20-29`
- **テキスト断片**:
  ```
  プランモードに入る。プランモードでは、コードベースを調査して実装計画を設計する。
  ...
  以下の場合に使用:
  - 新機能の実装
  - 複数の有効なアプローチがある場合
  - アーキテクチャ決定が必要な場合
  - 複数ファイルにまたがる変更
  - 要件が不明確な場合
  ```
- **疑いの種別**: 重複 (system-prompt の「計画モードの発動閾値」 と二重管理)
- **修正案** (どちらに集約するか決め打ち):
  - **方針**: tool description を正規にし、 system-prompt 側 L178-188 の「計画モードの発動閾値」 セクション 11 行を完全削除
  - **削除する 11 行** (system-prompt.ts:178-188):
    ```
    # 計画モード (enter_plan_mode) の発動閾値 [必須]
    plan_mode は **以下のいずれかを満たす時のみ起動**。 単純タスクで起動しない (計画蒸発の温床):
    - 影響ファイル数 ≥ 3
    - 複数言語/レイヤ (フロント+バック等) にまたがる
    - 既存仕様との整合性確認が必要 (大規模リファクタ等)
    - ユーザーが明示的に計画を依頼

    軽い変更や単発質問では plan_mode を起動しないこと。

    **承認後は todo_write へ落とす [必須]**:
    exit_plan_mode で計画が承認されたら、 **次の 1 手は必ず todo_write** で計画内容を 3-5 項目の Acceptance Checklist に落とし込む。 ...
    ```
  - **plan-mode.ts の description は維持** (既に「以下の場合に使用」 リストを持つため)
  - **「承認後は todo_write へ落とす」 だけは exit_plan_mode の description (もしくはハーネスの状態遷移メッセージ) に移植**

### [ID-028] skill: dev-workflow / project / refactoring が system-prompt と内容重複 (重大度: 中)
- **箇所**: `src/skills/builtin/dev-workflow/SKILL.md`, `project/SKILL.md`, `refactoring/SKILL.md`
- **テキスト断片** (dev-workflow:9):
  ```
  ## ツール選択の原則
  - ファイル内容の確認には file_read を使う。bash (cat/type/head) は使わない
  - file_edit が失敗したら file_read で現在の内容を確認し...
  - 新規ファイル作成は file_write を使う。コードをテキスト応答に書かない
  - bash は git bash 構文で書く（cmd.exe/PowerShell 構文は不可）
  ```
  これらは system-prompt の「ツール使用」 「失敗時のエスカレーション」 と完全重複
- **疑いの種別**: 重複
- **背景**: harness-engineering.md A1-A2 で system-prompt に入った内容が、 スキルにもコピーされている (事実)
- **現状の挙動**: スキル発動時に同じ原則が再注入される (= 二重伝達)
- **修正案** (各スキルの削除対象を明示):
  - **`dev-workflow/SKILL.md`**:
    - 削除: L9-12 (ツール選択の原則、 system-prompt と完全重複) → 4 行削除
    - 削除: L21-24 (エラー回復、 system-prompt L124-130 と重複) → 4 行削除
    - 残す: L14-19 (マルチファイルプロジェクト作成手順 = スキル固有の知見)、 L26-31 (実装→検証サイクル = 言語別コマンド例)
    - 31 行 → 約 18 行 (42% 減)
  - **`project/SKILL.md`** / **`refactoring/SKILL.md`**:
    - 同様に「ツール選択原則」 等の共通部分を削除し、 各スキル特有の手順のみ残す (詳細は実ファイルを再読して個別判定)
  - **再注入されない前提を明記**: スキル本文先頭に `<!-- system-prompt の共通原則 (file_read 必須等) は前提とし、 ここでは <スキル特有> の知見のみ書く -->` とコメント追記

### [ID-029] skill: game-development の禁止事項が極めてセッション固有 (重大度: 中)
- **箇所**: `src/skills/builtin/game-development/SKILL.md:18-23`
- **テキスト断片**:
  ```
  - **配列インデックスに浮動小数点を使う**（必ず `Math.floor()` でラップする）
    - ❌ `world[x][rows * 0.6]` → `undefined` → `NaN` 連鎖でゲーム全体が描画されなくなる
    - ✅ `world[x][Math.floor(rows * 0.6)]`
  - **初期値にNaNが混入するコード**（全座標・サイズ計算に整数チェックを徹底）
  ```
- **疑いの種別**: 仮対応の恒久化 (= 過去の特定バグへの注意喚起)
- **背景**: 何かのセッションで NaN 連鎖が起きた経験から追加 (推測)
- **現状の挙動**: ゲーム実装スキルとして極めて狭い特殊例 (Math.floor) のみ強調されている
- **修正案** (具体な before/after):
  ```
  [before, game-development/SKILL.md:18-23]
  - **配列インデックスに浮動小数点を使う**（必ず `Math.floor()` でラップする）
    - ❌ `world[x][rows * 0.6]` → `undefined` → `NaN` 連鎖でゲーム全体が描画されなくなる
    - ✅ `world[x][Math.floor(rows * 0.6)]`
  - **初期値にNaNが混入するコード**（全座標・サイズ計算に整数チェックを徹底）

  [after]
  - 数値計算は整数性を保証する (配列インデックス・座標は必ず `Math.floor()` 等でラップ。 NaN/undefined の連鎖はゲーム全体の描画破綻を招く)
  ```
  - 5 行 → 1 行 (= 具体例は references/numeric-pitfalls.md に移すか、 削除)
  - もしくは references/ パターンを採用するなら `references/common-pitfalls.md` を新設して詳細を移し、 SKILL.md からは「詳細は references/common-pitfalls.md」 と参照

### [ID-030] skill: business-book-writing の「悪い例」 が箇条書き形式で書かれているメタ矛盾 (重大度: 軽)
- **箇所**: `src/skills/builtin/business-book-writing/SKILL.md:8-23`
- **テキスト断片**:
  ```
  ### ❌ 禁止事項
  - **箇条書き（・、-、*、番号リスト）は章本文での使用を禁止**。本文はすべて散文で書く。
  - 見出しだけで本文がないセクションを作らない
  - キーワードの羅列・体言止めの連続で終わらせない
  - 短文の連打 (...)
  - 「以下に示します」「次のとおりです」と言ってから箇条書きにする構成
  ```
- **疑いの種別**: 形式の自己矛盾 (= 軽)
- **修正案** (1 行追加で済む):
  ```markdown
  [冒頭 (`# Business Book Writing` 直後) に追加する 1 行]
  *(本 SKILL の説明は箇条書きを用いる。 これはスキル指示の構造化のため。 実際にユーザーへ提供する書籍本文では下記の禁止事項に従い散文で書くこと。)*
  ```
  - これでメタ矛盾の解消は十分

---

---

## 追加検出項目 (2026-04-29 第 2 回追記: 外部 agent 定義 + 残スキル 12 件)

### [ID-031] agents/builtin/*.md 4 ファイルが英語短文で `buildSubAgentStrategyPrompt()` の哲学とほぼ完全に断絶 (重大度: 重大)
- **箇所**: `src/agents/builtin/code-reviewer.md` (19行) / `explore.md` (11行) / `general-purpose.md` (10行) / `plan.md` (10行)
- **テキスト断片** (general-purpose.md の全文):
  ```markdown
  ---
  name: general-purpose
  description: General-purpose agent with full tool access
  tools: [file_read, file_write, file_edit, glob, grep, bash, web_fetch, web_search, todo_write, ask_user]
  ---
  You are a general-purpose development agent. Handle complex multi-step tasks autonomously.
  - Read before editing
  - Prefer editing over creating new files
  - Test changes when possible
  - Follow existing code patterns
  ```
  4 ファイル合計でも 50 行に満たない。 全て英文。 「対話レジスター」「Acceptance Criteria」「成果物の保存責任」「壁ドンループ回避」 等の概念ゼロ。 つまり `buildSubAgentStrategyPrompt()` (60行 / 9 セクション) が定義する Phase 5 第3-7ラウンド の哲学とほぼ完全に乖離している
- **疑いの種別**: 死文化 / 内容乖離 / 言語不統一
- **背景**: Claude Code 流の agent 定義フォーマット (frontmatter + 短い指示) を踏襲した初期実装と推測 (事実: 4 ファイル全て同様の構造で 10-20 行)。 Phase 5 で `buildSubAgentStrategyPrompt()` が成長した一方、 こちら 4 ファイルは取り残されている (= ID-014 の構造的問題が「ファイルとして実体化」 している)
- **現状の挙動**:
  - `agent-loader.ts:170-174` の `searchPaths` 第 1 優先で読み込まれるため、 task ツール経由のサブエージェント (task type=general-purpose 等) では **buildSubAgentStrategyPrompt() ではなく** これら短文 4 ファイルが使われる (事実)
  - サブエージェントは「Read before editing」 程度の指示しか受け取らず、 レジスター/Acceptance Criteria/保存責任 を一切認識しない状態でタスクを進める
  - メイン LLM の system-prompt と完全に断絶した文体・原則体系で動く
  - 4 ファイル間で「Read before editing」 系の同主旨原則が個別に書かれて表現が微妙に違う (一貫性欠落)
- **修正案** (大規模刷新):
  1. **共通プリアンブル + 役割固有差分** の構造に再構成。 `agent-loader.ts` 側で「frontmatter の `inherit: shared-strategy` を見て共通プロンプトを前置する」 機能を追加:
     ```typescript
     // src/agents/agent-loader.ts (loadFromDirectory 内)
     if (meta.inherit === "shared-strategy") {
       def.systemPrompt = buildSubAgentStrategyPrompt({ readOnly: meta.readOnly === "true" }) + "\n\n" + body;
     }
     ```
  2. **`general-purpose.md` の刷新例**:
     ```markdown
     ---
     name: general-purpose
     description: 汎用サブエージェント (全ツール利用可)。 メイン LLM から委任された複合タスクを最後まで完結させる。
     tools: [file_read, file_write, file_edit, glob, grep, bash, web_fetch, web_search, todo_write, ask_user]
     inherit: shared-strategy
     ---
     # 役割
     汎用開発エージェント。 マルチステップのタスクを自律的に完了させる。 既存パターンに従い、 編集前に必ず file_read。
     ```
     - 共通の「対話レジスター/保存責任/エスカレーション」 等は `buildSubAgentStrategyPrompt()` から自動で前置される
  3. **`explore.md` の刷新例** (read-only):
     ```markdown
     ---
     name: explore
     description: コードベース探索専任 (読取専用)。 glob/grep/file_read で調査して整理して返す。
     tools: [file_read, glob, grep, web_fetch, web_search]
     inherit: shared-strategy
     readOnly: "true"
     ---
     # 役割
     コードベース探索のみ。 ファイル編集は行わない。 調査結果を構造化して return する。
     ```
  4. **`code-reviewer.md`** は既に「Review Categories」 等のレビュー固有手順を持つので、 共通プロンプト前置 + 既存本文の翻訳でほぼ流用可能
  5. **`plan.md`** も同様に共通プロンプト前置 + 「実装計画設計の手順」 を残す
  6. **言語**: 4 ファイルすべて日本語化 (メインの system-prompt が日本語のため、 ハーネス哲学の伝達がスムーズ)
- **判断ポイント**:
  - (a) **「外部 agent 定義は Claude Code 流 (frontmatter + 短文)」 派**: 現状を維持し、 共通哲学はメイン側のみで完結
  - (b) **「外部 agent 定義もハーネス哲学を継承する」 派**: 上記 1-6 を全実施。 推奨
  - (c) ID-014 (FALLBACK_CONFIGS 撤去) と同期して進めるか、 別タイミングで進めるか

### [ID-032] agents/builtin/code-reviewer.md と skill/code-review と skill/pr-review が同責務でばらばら配置 (重大度: 中) (※ID-039 と統合済み: 後段参照)
- **箇所**: `src/agents/builtin/code-reviewer.md`, `src/skills/builtin/code-review/SKILL.md`, `src/skills/builtin/pr-review/SKILL.md`
- 詳細は **ID-039** にまとめる

### [ID-033] excel/powerpoint スキルが Python テンプレート 200 行強を SKILL.md 本文に内包 (Progressive Disclosure 違反) (重大度: 重大)
- **箇所**: `src/skills/builtin/excel/SKILL.md` (346行) / `src/skills/builtin/powerpoint/SKILL.md` (402行)
- **テキスト断片** (excel SKILL.md L48-253 の Python テンプレート抜粋):
  ```python
  import openpyxl
  from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
  ...
  PRIMARY_COLOR = '1A56DB'
  ...
  def style_header(ws, headers, row=1): ... (約 200 行のヘルパー + 実装)
  ```
  powerpoint も同様に L47-320 で `python-pptx` テンプレート 270 行強を本文埋め込み
- **疑いの種別**: References パターン違反 / 局所最適化 / 本文肥大
- **背景**: skill-creator/SKILL.md L86-94 が Progressive Disclosure を推奨 (References パターン: 「If files are large (>10k words), include grep search patterns in SKILL.md」、 「Avoid duplication: Information should live in either SKILL.md or references files, not both」 と明記) しているにも関わらず、 同プロジェクト内のビルトインスキル excel/powerpoint がこれに違反 (事実)
- **現状の挙動**:
  - スキル発動 (excel/powerpoint) のたびに SKILL.md 全文 (~350-400行 / ~10000-12000 トークン) が context に注入される
  - ユーザーが「ラフに表を作って」 (rough レジスター) と言っても 200 行の production テンプレートが注入される (= ID-042 と連動)
  - 編集依頼時の「スクリプト再利用ワークフロー」 説明 (excel L20-33) と Python テンプレ本体が同居しているため目的が二重 (再利用ガイド + 新規生成テンプレ)
- **修正案** (References パターンへ分割):
  1. **`src/skills/builtin/excel/scripts/excel_template.py`** を新設し、 L48-253 の Python コード全文を移動
  2. **`src/skills/builtin/excel/references/openpyxl-patterns.md`** を新設し、 L260-326 の追加要素 (条件付き書式 / 集計シート / 円グラフ / 折れ線グラフ) と L328-337 の数値書式リファレンスを移動
  3. **`src/skills/builtin/excel/SKILL.md` を以下の最小骨格に圧縮 (約 50 行)**:
     ```markdown
     ---
     name: excel
     description: Excelファイル(.xlsx)の作成スキル。 表・集計・データ分析・帳票・レポートを openpyxl で生成。
     tools: [bash, file_write, file_read]
     ---

     # Excel Spreadsheet Skill

     ## 絶対ルール
     - 出力先: `output/[name]/[name].xlsx`
     - スクリプト併存: `output/[name]/[name]_generate.py` を必ず残す (再編集時の正本)
     - ヘッダー行: 背景色 + 太字 + フィルター + 枠固定。 列幅は内容に合わせ調整

     ## 手順 (新規作成)
     1. 要件確認 → シート設計 → 合意
     2. `scripts/excel_template.py` をベースとして file_read で読み込み、 データ部のみユーザー要件に書き換える
     3. `output/[name]/[name]_generate.py` に file_write 保存 → bash 実行
     4. 完了報告にスクリプトパスと .xlsx パスの両方を含める

     ## 手順 (編集依頼)
     1. .xlsx と同ディレクトリの `*_generate.py` 存在確認
     2. タイムスタンプ比較で「スクリプトが正本か」 判定 (xlsx が新しいなら ask_user)
     3. スクリプトが正本ならスクリプトを編集 → 再実行

     ## 高度な要素
     - 条件付き書式 / 集計シート / 円グラフ / 折れ線グラフ → references/openpyxl-patterns.md
     - 数値書式コード一覧 → references/openpyxl-patterns.md

     ## 完了条件
     - .xlsx 生成成功
     - *_generate.py が同ディレクトリに残存
     - ヘッダー / 列幅 / 枠固定 / Meiryo フォント設定済み
     ```
  4. **powerpoint も同様に分割** (`scripts/pptx_template.py` + `references/pptx-patterns.md`)。 SKILL.md は 50-60 行に圧縮
  5. **References パターンの利点**: スキル発動時に SKILL.md (50 行) のみ注入、 Python 本体は file_read で必要時のみ読込 = ~7000-9000 トークン節約
- **判断ポイント**:
  - (a) **References パターン採用**: 推奨。 skill-creator が説いた原則に準拠
  - (b) **現状維持**: テンプレ常時注入が「ローカル LLM がコード生成失敗するリスクを下げる」 のなら維持価値あり (= 計測判断)

### [ID-034] skill-creator/SKILL.md が完全英語 + 当プロジェクトに存在しないスクリプト参照を含む (重大度: 重大)
- **箇所**: `src/skills/builtin/skill-creator/SKILL.md` (359行)
- **テキスト断片**:
  ```markdown
  Usage:
  ```bash
  scripts/init_skill.py <skill-name> --path <output-directory>
  ```
  ...
  ```bash
  scripts/package_skill.py <path/to/skill-folder>
  ```
  ```
  しかし `src/skills/builtin/skill-creator/scripts/` ディレクトリは存在しない (事実: ls 確認済み)。 さらに本文全体が英語で、 メイン system-prompt の日本語と非対称
- **疑いの種別**: 死文化 / 参照切れ / 言語不統一
- **背景**: Claude 公式の「skill-creator」 スキル ([anthropic-cookbook 由来と推測]) をそのまま流用したと思われる (事実: 「License: Complete terms in LICENSE.txt」 という外部由来を示すフィールドあり)。 当プロジェクトの実装には `init_skill.py` / `package_skill.py` を持たない
- **現状の挙動**:
  - ユーザーがスキル作成を依頼 → SKILL.md 発動 → モデルが「scripts/init_skill.py を実行せよ」 と指示するが実行不可 → エラー
  - References パターン解説は他スキル作成時の指針として有用、 ただし参照スクリプト不在で混乱を生む
  - 359 行の英文が日本語環境に注入されることで、 メイン LLM が一時的に英語応答に倒れる可能性 (推測)
- **修正案** (3 段階):
  1. **不在スクリプト参照を全削除** (L259-281 の Step 3 全体、 L323-348 の Step 5 全体):
     - L267-271 の `scripts/init_skill.py <skill-name>` 例 → 削除
     - 代わりに「`src/skills/builtin/<skill-name>/SKILL.md` を file_write で新規作成」 の手順に書き換え
     - L324-348 の `package_skill.py` 説明 → 削除 (.skill パッケージ化機能は当プロジェクトに無いため)
  2. **日本語化** (本文 359 行を翻訳):
     - 構造はそのまま保ち、 各セクション見出しと本文を日本語に書き換え
     - 「Concise is Key」 → 「簡潔さが鍵」、 「Set Appropriate Degrees of Freedom」 → 「適切な自由度の設定」 等
  3. **lllmAgents 固有の手順を追加**:
     - 「ビルトインスキルの場合は `src/skills/builtin/<name>/SKILL.md` を作成、 Stop フックが `~/.localllm/skills/` へ自動同期」 を明記 (CLAUDE.md L24-29 の運用と整合)
     - 「ユーザー側スキルは `~/.localllm/skills/<name>/SKILL.md` に file_write」
  4. **削減目標**: 359 行 → 約 200 行 (44% 減、 不在スクリプト参照と冗長な英語表現を削除)
- **判断ポイント**:
  - (a) **当プロジェクト固有に書き直す** (推奨): スクリプト不在 + 英語のままは死文化リスク大
  - (b) **scripts/init_skill.py 等を実装する**: 別軸の機能追加。 ID-034 とは別タスク

### [ID-035] スキル間で `tools:` フロントマターの有無が不揃い (重大度: 中)
- **箇所**: 全 17 ビルトインスキルの frontmatter
  - 持つ (5 件): `excel`, `powerpoint`, `code-stats`, `pr-review`, `add-repl-command`
  - 持たない (12 件): `business-book-writing`, `build-fix`, `code-review`, `commit`, `dev-workflow`, `game-development`, `project`, `refactoring`, `research`, `skill-creator`, `tdd`, (game-development 等)
- **テキスト断片** (excel):
  ```yaml
  tools: [bash, file_write, file_read]
  ```
  vs (game-development):
  ```yaml
  (tools: 行なし → 全ツール利用可)
  ```
- **疑いの種別**: 一貫性欠落 / 仕様不明確
- **背景**: スキル設計の初期と途中で「tools フィールドの位置付け」 が変わった可能性 (推測)。 skill-creator/SKILL.md は `name` と `description` のみ必須と説明 (L308-317、 「Do not include any other fields in YAML frontmatter」 と明記) しているが、 実装スキル側は無視して `tools:` を入れている
- **現状の挙動**:
  - tools 指定があるスキル: スキル発動中の利用ツールが制限される (= サンドボックス効果)
  - tools 指定がないスキル: 全ツール利用可
  - ユーザーがスキルを書く際にどちらが正しいか SKILL.md (skill-creator) からは判断不能
- **修正案**:
  1. **方針決定** (どちらを正規にするか):
     - **方針 A**: `tools:` フィールドを **必須** とする。 skill-creator/SKILL.md L308-317 を「`name` / `description` / `tools` の 3 つを記載」 と更新。 `tools:` のないスキル 12 件に追加:
       ```yaml
       # 例: code-review/SKILL.md
       tools: [file_read, glob, grep]
       # 例: build-fix/SKILL.md
       tools: [bash, file_read, file_edit, grep]
       ```
     - **方針 B**: `tools:` フィールドを **無効化** (= スキル発動中も全ツール利用可)。 5 件から `tools:` 行を削除し、 skill-loader.ts の処理も削除
  2. **どちらを取るか判断**: スキル単位のツール制限が「セキュリティ上の境界」 として機能しているなら方針 A。 単に「使うべきツール候補のヒント」 程度なら方針 B (description で「[使うべきツール] file_read / glob / grep」 と書く方が表現力高い)
- **判断ポイント**:
  - (a) ユーザーの方針: 「ツール権限はスキル単位で絞る」 vs 「ツール権限はセッション単位で global にする」
  - (b) skill-loader.ts での `tools:` の実装挙動を確認 (= 厳格 enforcement か、 ヒント程度か) — 修正前に要調査

### [ID-036] add-repl-command/SKILL.md が「`npx tsc --noEmit` で型エラー確認」 をスキル本文に記載 (重大度: 軽)
- **箇所**: `src/skills/builtin/add-repl-command/SKILL.md:65`
- **テキスト断片**:
  ```
  5. `npx tsc --noEmit` で型エラーがないか確認
  ```
- **疑いの種別**: 局所コマンドのハードコード / 検証コマンドの重複
- **背景**: REPL コマンド追加スキル固有の動作確認手順
- **現状の挙動**: REPL コマンド固有の検証として `npx tsc --noEmit` が指定されている。 これは妥当だが、 system-prompt の検証ルール (ID-009) と類似指示が重複
- **修正案**:
  ```markdown
  [before]
  5. `npx tsc --noEmit` で型エラーがないか確認

  [after]
  5. 型チェック (CLAUDE.md/プロジェクト指示に従う。 当プロジェクトは `npx tsc --noEmit`)
  ```
  - 「プロジェクト指示に従う」 と書くことで、 別プロジェクトに流用される際にも壊れない

### [ID-037] add-repl-command/SKILL.md が「3ファイル更新」 を機械的列挙 (Three-File Pattern を抽象化していない) (重大度: 軽)
- **箇所**: `src/skills/builtin/add-repl-command/SKILL.md:8-58`
- **テキスト断片**:
  ```
  ## 更新が必要な3ファイル
  ### 1. `src/cli/repl.ts` — コマンドハンドラー
  ### 2. `src/cli/completer.ts` — 補完候補
  ### 3. `src/cli/renderer.ts` — ヘルプ表示
  ```
- **疑いの種別**: ハードコード / 構造変更時の死文化リスク
- **背景**: REPL コマンドが 3 ファイルに分散している lllmAgents の現実装に密結合 (事実: コードベースを確認、 該当 3 ファイル存在)
- **現状の挙動**: REPL の構造を 1 ファイルに統合する等のリファクタリングを行うとスキルが死文化
- **修正案**: 現状維持で問題なし。 ただし冒頭に「(本スキルは 2026-04-29 時点の lllmAgents 実装を前提とする。 REPL 構造変更時はこのスキルも更新が必要)」 と注記を 1 行追加すると将来の保守者に親切

### [ID-038] code-stats/SKILL.md の Output Format がハードコード (重大度: 軽)
- **箇所**: `src/skills/builtin/code-stats/SKILL.md:19-38`
- **テキスト断片**:
  ```
  ## Output Format
  ```
  ## コードベース統計
  ### ファイル数
  | 言語 | ファイル数 | 総行数 |
  ...
  ```
- **疑いの種別**: 出力形式のハードコード
- **背景**: スキル発動時の出力フォーマット指定
- **現状の挙動**: 出力フォーマットが固定的。 ユーザーが「JSON で」 等を要求しても表形式で返ってくる
- **修正案**:
  ```markdown
  [before]
  ## Output Format
  ```
  ## コードベース統計
  | 言語 | ファイル数 | ... |
  ```

  [after]
  ## Output Format
  デフォルトは Markdown 表形式。 ユーザーが JSON / CSV を指定したら従う:
  ```
  ## コードベース統計
  | 言語 | ファイル数 | 総行数 |
  ...
  ```
  ```

### [ID-039] code-review (スキル) / pr-review (スキル) / code-reviewer (外部 agent) の 3 ファイルが同責務でばらばら配置 (重大度: 重大)
- **箇所**: `src/skills/builtin/code-review/SKILL.md` (31行) / `src/skills/builtin/pr-review/SKILL.md` (35行) / `src/agents/builtin/code-reviewer.md` (19行)
- **テキスト断片** (3 件すべて「コードレビューの観点」 を独自に列挙):
  ```
  [code-review/SKILL.md]
  ## 観点
  - **正確性**: ロジックエラー、境界条件、null/undefined の未処理
  - **セキュリティ**: インジェクション、認証漏れ、機密情報の露出
  - **パフォーマンス**: N+1クエリ、不要なループ、メモリリーク
  - **保守性**: 命名、責務の分離、重複コード
  - **テスト**: テストカバレッジ、エッジケース

  [pr-review/SKILL.md]
  3. 以下の観点でレビュー:
     - バグや論理エラー
     - セキュリティ脆弱性
     - パフォーマンス問題
     - コーディングスタイルの一貫性
     - テストの有無
     - エッジケースの処理

  [code-reviewer.md]
  ## Review Categories
  - **Critical**: Security vulnerabilities, data loss risks
  - **High**: Logic errors, performance issues
  - **Medium**: Code style, maintainability
  - **Low**: Minor improvements, suggestions

  ## Process
  1. Read the changed files
  2. Check for security issues (OWASP Top 10)
  ...
  ```
- **疑いの種別**: 重複 / 責務分散 / 言語不統一 (英 vs 日)
- **背景**: スキルとしての code-review (= 一般的なレビュー作業) と、 task ツールから呼ばれる code-reviewer エージェントと、 git diff ベースの pr-review が独立して進化した結果と推測
- **現状の挙動**:
  - ユーザーが「コードをレビューして」 と言うと **code-review (スキル)** がトリガー、 観点 5 つを使う
  - ユーザーが「PR をレビューして」 と言うと **pr-review (スキル)** がトリガー、 観点 6 つを使う (code-review と微妙に違う)
  - ユーザーが「task で code-reviewer 起動」 と言うと **code-reviewer (外部 agent)** が起動、 Review Categories 4 段階を使う (重要度分類が更に違う)
  - = 同じ「コードレビュー」 タスクが 3 つの異なる観点リストで実行される
- **修正案** (集約):
  1. **観点リストを `references/code-review-criteria.md` に一本化** (lllmAgents/src/skills/builtin/code-review/references/ に新設):
     ```markdown
     # コードレビュー観点 (共通)
     ## 重要度分類
     - **Critical**: セキュリティ脆弱性 / データ損失リスク
     - **High**: ロジックエラー / パフォーマンス問題
     - **Medium**: コードスタイル / 保守性
     - **Low**: マイナー改善 / 提案

     ## 観点
     - 正確性: ロジック / 境界条件 / null/undefined 処理
     - セキュリティ: インジェクション / 認証 / 機密情報露出 / OWASP Top 10
     - パフォーマンス: N+1 / 不要ループ / メモリリーク
     - 保守性: 命名 / 責務分離 / 重複コード
     - テスト: カバレッジ / エッジケース
     ```
  2. **`code-review/SKILL.md`** を「一般的なレビュー時の手順 + 観点は references を参照」 形式に変更 (~15 行)
  3. **`pr-review/SKILL.md`** は「git diff main...HEAD で変更を取得 + observe 観点は同 references」 形式に変更 (~15 行)
  4. **`code-reviewer.md` (外部 agent)** は「task ツール経由のサブエージェントとしてレビュー実行」 = ID-031 の方針で `inherit: shared-strategy` + 役割記述 + references 参照
  5. **言語統一**: code-reviewer.md を日本語化 (ID-031 と同期)
- **判断ポイント**:
  - (a) **3 ファイルを残しつつ観点を共有 references に集約** (推奨): スキル/agent としての発動経路は維持しつつ、 内容重複を排除
  - (b) **責務統合**: code-review (スキル) を廃止して pr-review (スキル) のみ残す等、 ファイル数を減らす方向

### [ID-040] commit/SKILL.md が「ユーザーへ提示して確認」 を含むがハーネスとしては ask_user を使うべき (重大度: 軽)
- **箇所**: `src/skills/builtin/commit/SKILL.md:14`
- **テキスト断片**:
  ```
  5. ユーザーにコミットメッセージを提示して確認を取る
  ```
- **疑いの種別**: ハーネス語彙からのズレ
- **背景**: スキル本文がツール呼出の言葉ではなく散文で「確認を取る」 と書いている
- **現状の挙動**: モデルがコミットメッセージを「テキストで提示」 してから次の bash を呼ぶ可能性。 確認のためには `ask_user` ツール呼出が正規
- **修正案**:
  ```markdown
  [before]
  5. ユーザーにコミットメッセージを提示して確認を取る

  [after]
  5. `ask_user` でコミットメッセージを提示して承認を取る (例: prompt="次のメッセージで commit してよろしいですか?\n\n```\n<message>\n```")
  ```

### [ID-041] research/SKILL.md の「ask_user で中間報告」 がハーネス哲学 (ask_user は確認用) と齟齬 (重大度: 軽)
- **箇所**: `src/skills/builtin/research/SKILL.md:28`
- **テキスト断片**:
  ```
  - 調査途中でもメモを取る（ask_user で中間報告、または file_write で調査メモ）
  ```
- **疑いの種別**: ツール用途のミスリード
- **背景**: ask_user は本来「ユーザーへの質問」 で、 「中間報告」 ではない (system-prompt の用途定義から外れる)
- **現状の挙動**: モデルが中間報告のために ask_user を呼ぶ → ユーザーが「確認求められている」 と誤解
- **修正案**:
  ```markdown
  [before]
  - 調査途中でもメモを取る（ask_user で中間報告、または file_write で調査メモ）

  [after]
  - 調査途中の発見はメモする (file_write で調査メモを残す。 ユーザー判断が必要な分岐がある場合のみ ask_user で確認)
  ```

### [ID-042] excel/powerpoint スキルの「絶対ルール」 がレジスター無視で常に production 相当 (重大度: 重大)
- **箇所**: `src/skills/builtin/excel/SKILL.md:11-19` / `src/skills/builtin/powerpoint/SKILL.md:11-18`
- **テキスト断片** (excel):
  ```
  ## 絶対ルール
  - openpyxlがなければ先に `pip install openpyxl` を実行
  - 出力先は `output/` 配下
  - **ヘッダー行は必ず背景色・太字・フィルター・枠固定を設定**する
  - **列幅は必ず内容に合わせて調整**する（デフォルト幅のまま放置禁止）
  - CSVではなく`.xlsx`で出力する
  - **生成スクリプト（.py）は必ず.pptxと同じディレクトリに残す**
  ```
- **疑いの種別**: レジスター原則違反 / 局所最適化
- **背景**: ID-001 で導入された「対話レジスター (rough/standard/production)」 哲学と矛盾。 スキルが「rough 依頼でも全部やる」 を強制している
- **現状の挙動**:
  - ユーザーが「ラフに表を出して」 と頼んでも、 スキルが「絶対ルール」 で背景色 + 太字 + フィルター + 枠固定 + 列幅自動調整 + Meiryo フォント + ストライプ + 印刷設定 + ... を全実行
  - rough レジスター = 「最小実装 + 構文チェック」 の哲学に反する
  - メイン system-prompt のレジスター宣言とスキルの「絶対ルール」 が衝突したとき、 モデルがどちらを優先するか不明
- **修正案** (レジスター連動):
  ```markdown
  [before]
  ## 絶対ルール
  - **ヘッダー行は必ず背景色・太字・フィルター・枠固定を設定**する
  - **列幅は必ず内容に合わせて調整**する
  ...

  [after]
  ## レジスター別の動作

  ### rough レジスター (最小実装)
  - openpyxl で .xlsx を生成、 ヘッダー + データ行のみ
  - 装飾 (背景色 / 枠固定 / 列幅調整) は省略可

  ### standard / production レジスター (デフォルト以上)
  - openpyxlがなければ先に `pip install openpyxl` を実行
  - 出力先は `output/` 配下
  - ヘッダー行: 背景色・太字・フィルター・枠固定
  - 列幅: 内容に合わせ自動調整
  - 偶数行ストライプ + Meiryo フォント
  - 生成スクリプト (.py) を .xlsx と同ディレクトリに残す

  ## 共通ルール (全レジスター)
  - CSVではなく.xlsxで出力
  - 出力先は `output/` 配下
  ```
  - powerpoint も同様にレジスター別構成へ
- **判断ポイント**:
  - (a) **「業務向けスキルは production 相当が当然」 派**: 現状維持。 ただし冒頭に「本スキルは production 寄り。 ラフな試し書きには使わず Python ヒアドキュメントで簡易生成」 と注記
  - (b) **「レジスター連動するべき」 派** (推奨): 上記 before/after に変更

### [ID-043] tdd/SKILL.md / build-fix/SKILL.md / research/SKILL.md が同種の「Rules」 セクションでハーネス共通原則を再注入 (重大度: 中)
- **箇所**:
  - `src/skills/builtin/tdd/SKILL.md:24-28`
  - `src/skills/builtin/build-fix/SKILL.md:21-26`
  - `src/skills/builtin/research/SKILL.md:25-29`
- **テキスト断片**:
  ```
  [tdd]
  ## Rules
  - テストを先に書く（Red-Green-Refactor サイクル）
  - 一度に1つの機能に集中する
  - テストが通るまで次の機能に進まない
  - リファクタリング後は必ずテストを再実行する

  [build-fix]
  ## Rules
  - エラーメッセージを正確に読む
  - 1つずつエラーを修正する
  - 修正後は必ず再ビルドで確認する
  - 不要なコードの追加を避ける

  [research]
  ## Rules
  - 推測と事実を明確に区別する
  - 「おそらく〜」で終わらせず、検証可能なものは検証する
  - 調査途中でもメモを取る
  ```
- **疑いの種別**: 重複 / 「再検証は必ず」 系のメイン原則 (system-prompt 検証ルール) と内容重複
- **背景**: 各スキル独立に Rules セクションが書かれており、 system-prompt の「失敗時のエスカレーション」 「検証ルール」 と重なる箇所がある
- **現状の挙動**: スキル発動時にこれらルールが追加で context に入る (= ID-028 の dev-workflow と同種問題、 規模は小さい)
- **修正案**:
  - **各スキルの Rules セクションをスキル固有の知見だけに絞る**:
    ```
    [tdd] Rules:
    - テストを先に書く (Red-Green-Refactor サイクル)。 これがスキル固有
    - (削除: 「テストが通るまで次の機能に進まない」 「リファクタリング後は必ず再実行」 → system-prompt 検証ルールで十分)

    [build-fix] Rules:
    - 1つずつエラーを修正する。 ビルドエラーは依存関係があるため一気に修正すると因果関係が見えにくい
    - (削除: 「修正後は必ず再ビルド」 → system-prompt 検証ルールで十分)
    ```

### [ID-044] code-stats / pr-review が `context: fork` フロントマターを持つ (重大度: 軽)
- **箇所**: `code-stats/SKILL.md:5` / `pr-review/SKILL.md:5`
- **テキスト断片**:
  ```yaml
  context: fork
  ```
- **疑いの種別**: 仕様の不透明 / skill-creator が説明していないフィールド
- **背景**: skill-creator/SKILL.md L308-317 は frontmatter フィールドを `name` / `description` のみと定義。 `context: fork` は当プロジェクト独自の追加フィールド (推測)
- **現状の挙動**: コンテキストを fork して別セッションで実行する仕様と推測 (skill-loader 側の実装次第)
- **修正案**:
  - skill-creator/SKILL.md (ID-034 改稿時) に `tools:` および `context:` のフィールドの説明を追加 (lllmAgents 固有として明記):
    ```markdown
    ## frontmatter フィールド (lllmAgents 拡張)
    - `name` (必須): スキル名
    - `description` (必須): 発動条件と概要
    - `tools` (任意): スキル発動中に利用可能なツールのリスト
    - `context` (任意): "fork" を指定すると独立コンテキストで実行
    ```

### [ID-045] tools description で `[使うべき場面]/[使うべきでない]/[よくある誤用]` の 3 要素テンプレが一部 tool でしか守られていない (重大度: 軽)
- **箇所**: `src/tools/definitions/*.ts` 全般
- **テキスト断片**:
  - 4 要素テンプレ準拠: `second-llm.ts` (consult/agent), `task.ts` (検出時、 ID-024 改稿後)
  - 散文: `bash.ts`, `file-edit.ts`, `file-read.ts`, `sandbox-info.ts`, `plan-mode.ts`, `response-complete.ts`, `ask-user.ts`, `web-fetch.ts`, `glob.ts`, `grep.ts`
- **疑いの種別**: 形式の不統一
- **背景**: progress.md Phase 5 第7ラウンドで second-llm 系のみ 4 要素テンプレ化 (事実)
- **現状の挙動**: tool description の品質がツール間でばらつく
- **修正案** (段階的にテンプレ化):
  - 全 tool description を以下構造に揃える:
    ```
    <1 行目: 動作の要約>
    [使うべき場面] ...
    [使うべきでない] ...
    [よくある誤用] ...
    ```
  - 優先度 H (使用頻度高): `bash.ts`, `file-read.ts`, `file-edit.ts`, `file-write.ts`
  - 優先度 M: `glob.ts`, `grep.ts`, `ask_user.ts`, `todo_write.ts`, `plan-mode.ts`, `response-complete.ts`
  - 優先度 L: `sandbox-info.ts`, `web-fetch.ts`, `web-search.ts`, `task.ts` (ID-024 で対応)

---

## 総括 (改訂版)

### Phase 5 の経緯と本レビューの相関
本レビューの多くの「重大」 案件は、 progress.md の Phase 5 第6〜10ラウンド (= 各ラウンドが特定セッション症状への対応) に対応する。 第8ラウンドで「監視官的介入の全廃」 が哲学として宣言された後、 第9-10ラウンドで「ハードガード + 対話必須ロック」 が再導入された結果、 system-prompt がそれらを全部説明する形になっている。 ハードガード自体が良い設計でも、 system-prompt がそれを冗長に説明している箇所は (Claude Code の「実装詳細を隠す」 流儀との対比で) 削減余地がある。

### 第 2 回追記で見えた構造的問題
1. **ハーネス哲学の伝達が「メイン system-prompt」 にしか届いていない**: ID-031 の通り外部 agent 定義 4 ファイルは Phase 5 哲学を全く知らない。 ID-002 の sub-agent prompt も「メインを縮小コピー」 段階で止まっている。 つまり「メインだけが進化、 委任先は古文体」 の構造。 ID-002/ID-014/ID-031 の修正は **共通プロンプト関数の切り出し** で同時解消される
2. **References パターンが skill-creator が説いておきながら自プロジェクト内で守られていない**: ID-033 (excel/powerpoint で 200 行テンプレ本文埋込)、 ID-039 (code-review 観点が 3 箇所に分散) など。 References パターン化を一括で実施する価値あり
3. **レジスター原則がスキル本文に届いていない**: ID-042 の通り excel/powerpoint の「絶対ルール」 が rough レジスターを無視。 ID-029 のセッション固有事故対応もレジスター連動していない。 = レジスターは system-prompt 内のローカル概念で止まっている

### 注記
- 文字化け箇所 (例: `evaluator.ts:57, 134, 136` 等) はファイルそのもののエンコーディング問題で、 prompt-tech-debt とは別系統。 修正フェーズで一緒に直すと効率的
- intent-classifier.ts の `INTENT_CLASSIFY_PROMPT` (L74-87) と `COMPLETION_CLASSIFY_PROMPT` (L89-99) は分類専用で、 中核プロンプトとは独立した Helper として妥当 (= 検出対象外)
- delegation-guard.ts (`src/second-llm/delegation-guard.ts`) は運用ガード (回数制限) で、 プロンプトテキストとしては中核ではないため未調査 (テキスト棚卸しの範囲外)
- 第 2 回追記でレビュー対象に追加された agents/builtin/*.md は agent-loader.ts の searchPaths 第 1 優先で読み込まれるため、 sub-agent.ts:FALLBACK_CONFIGS (ID-014) より上位の真実。 ID-014 と ID-031 は連動修正が必須
