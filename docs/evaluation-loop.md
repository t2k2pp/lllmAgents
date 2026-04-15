# 評価ループ設計書

> **ステータス**: 設計中
> **作成日**: 2026-04-15
> **前提**: harness-engineering.md（Phase 1-4完了）の次のフェーズ
> **参考**: [Anthropic: Harness Design for Long-Running Apps](https://www.anthropic.com/engineering/harness-design-long-running-apps)

---

## 1. 背景と課題

### 1.1 現在の問題

現在のアプリは、LLMが「完了しました」とテキスト応答すればタスク終了となる。
ハーネスは完了宣言の**検出**はしている（`intent-classifier.ts` の `classifyCompletion`）が、
**宣言の妥当性を検証していない**。

```
現状: 実装 → LLM「完了しました」 → ユーザーに次を聞く
問題: 振り返り可能なレベルでもLLMが早期完了宣言してしまう
```

### 1.2 Anthropic記事の知見

Anthropicの「Harness Design for Long-Running Apps」から得た設計原則:

1. **自己評価は構造で解決する** — 生成者と評価者を分離する。同一コンテキストでは自己批判が機能しない
2. **完了判定は「宣言」ではなく「検証」** — ツール結果という客観的事実に基づいて判断する
3. **タスク種別で検証手段が異なる** — コーディングにはテスト実行、文章にはレビューエージェント

### 1.3 Claude Codeの終了メカニズム

Claude Codeの終了条件は「モデルがツールを呼ばなくなったら終了」という単純な仕組み。
粘り強さの源泉は、テスト失敗・ビルドエラーなどのツール結果が客観的証拠としてコンテキストに残り、
モデルが自然と修正に向かう構造。ただし**文章系タスクではこの仕組みは機能しない**
（検証可能なツール結果がないため）。

---

## 2. 設計方針

### 2.1 タスク種別と検証戦略

| タスク種別 | 検証手段 | 終了条件 |
|-----------|---------|---------|
| コーディング | bash実行（テスト/ビルド/lint） | 検証コマンドが成功した事実 |
| 文章・設計書 | Evaluatorエージェントによるレビュー | Evaluatorが「重大な問題なし」判定 |
| リサーチ | 情報源の網羅性チェック | 主要ソースをN件以上確認した事実 |
| ファイル操作 | bash / file_read で結果確認 | 操作結果の確認事実 |

### 2.2 核心: 2つの検証メカニズム

#### メカニズムA: ツール追跡による検証強制（コーディング系）

ハーネスが「file_write/file_edit の後に bash が呼ばれたか」を追跡する。
検証なしに完了宣言が来たら、ユーザーに返さず再プロンプトを注入する。

```
file_write → (LLMがbashを呼ばずにテキスト応答) 
  → ハーネス: 「検証が完了していません。作成/変更したファイルの動作確認をbashで実行してください」
  → LLMがbash実行 → 結果に基づいて継続 or 完了
```

**利点**: LLM判定不要。ツール呼び出し履歴という客観的データのみで判断。

#### メカニズムB: Evaluatorレビュー（文章・非コード系）

実装後、別コンテキストのLLMが成果物をレビューする。
レビュー結果をメインLLMのコンテキストに注入し、問題があれば修正を促す。

```
file_write（文章） → ハーネスがEvaluatorを起動
  → Evaluator: 「3.2節→3.3節の論理飛躍、第2章の伏線X未回収」
  → メインLLM: フィードバックに基づいて修正 → 再評価 or 完了
```

---

## 3. Evaluatorアーキテクチャ

### 3.1 LLM選択の抽象化

Evaluatorが使うLLMは設定に応じて自動選択:

```
Evaluator LLM = secondLLM ?? mainLLM（別コンテキスト）
```

| 構成 | メインLLM | Evaluator LLM | 想定シナリオ |
|------|----------|---------------|-------------|
| 最小構成 | 27B MoE | 同じ27B（別コンテキスト） | GPU 1台 |
| 推奨構成 | 27B MoE（高速） | Dense 9B-14B（正確） | GPU余裕あり |
| 最強構成 | 27B MoE | Claude Sonnet等 | クラウド併用 |

**ポイント**: コード上の分岐は不要。Evaluatorのインターフェースは1つで、
裏のLLMが何かは設定（`secondLLM` の有無）で決まる。

### 3.2 既存資産との関係

- `second_llm_consult`: 現在はメインLLMが**自発的に**呼ぶツール
- Evaluator: **ハーネスが自動的に**起動する仕組み（メインLLMの意思に依存しない）

この違いが重要。メインLLMが「完了しました」と言った後にハーネスがEvaluatorを起動するので、
メインLLMの「早期完了」傾向を外部から制御できる。

### 3.3 Evaluator呼び出しインターフェース

```typescript
interface EvaluatorResult {
  passed: boolean;          // 合格/不合格
  issues: EvaluatorIssue[]; // 発見された問題のリスト
  summary: string;          // 総評（メインLLMに注入する）
}

interface EvaluatorIssue {
  severity: "critical" | "warning" | "suggestion";
  description: string;      // 問題の説明
  location?: string;        // ファイルパス・行番号等
  suggestion?: string;      // 修正提案
}
```

### 3.4 Evaluatorプロンプト設計

```
あなたは独立したコードレビュアー / 文章レビュアーです。
以下の成果物を客観的に評価してください。

## 評価基準
- [タスク種別に応じた基準を動的に生成]

## 評価ルール
- 発見した問題は具体的に指摘すること（ファイルパス、行番号、該当箇所の引用）
- 一度出した指摘を取り下げないこと
- 「まあ大丈夫だろう」という甘い判定は禁止。問題があるなら問題として報告する
- 軽微な問題（typo等）は severity: suggestion とし、合否判定には影響させない

## 成果物
[ファイル内容]

## ユーザーの元の依頼
[元のリクエスト]
```

---

## 4. 実装設計

### 4.1 メカニズムA: ツール追跡（コーディング検証強制）

#### 変更対象: `agent-loop.ts`

新しい状態変数:
```typescript
/** file_write/file_edit 実行後、bash検証が行われたかを追跡 */
let pendingVerification: string[] = [];  // 検証待ちファイルパスのリスト
```

追跡ロジック:
```
1. file_write / file_edit 実行時 → pendingVerification にファイルパス追加
2. bash 実行時 → pendingVerification をクリア（検証が行われたとみなす）
3. テキスト応答が来た時:
   a. pendingVerification が空 → 通常処理（完了として扱う）
   b. pendingVerification が非空 → 検証未実施として再プロンプト注入
```

再プロンプトテンプレート:
```
以下のファイルを作成/変更しましたが、動作確認が完了していません:
{pendingVerification のファイルリスト}

bashで適切な検証コマンドを実行してください:
- .ts/.js: node --check または npm test
- .py: python -c "import ast; ast.parse(open('file').read())"
- .html: ブラウザで表示確認（browser_screenshot）
- 汎用: 該当するビルド/テスト/lintコマンド

検証が成功したら結果を報告してください。問題があれば修正してください。
```

#### 例外ケース（再プロンプトしない）

- `file_write` で `.md` / `.txt` などのドキュメント系ファイルのみ変更した場合 → メカニズムBの対象
- ユーザーが会話的入力をした場合（intentClassifier で判定済み）
- plan mode 中の場合

### 4.2 メカニズムB: Evaluatorレビュー（文章・非コード系）

#### 新規ファイル: `src/agent/evaluator.ts`

```typescript
export class Evaluator {
  private provider: LLMProvider;
  private model: string;

  constructor(
    secondLLMManager: SecondLLMManager | null,
    mainProvider: LLMProvider,
    mainModel: string,
  ) {
    // secondLLM が利用可能ならそちらを使う、なければ mainLLM
    if (secondLLMManager?.isAvailable()) {
      this.provider = secondLLMManager.getProvider();
      this.model = secondLLMManager.getModel();
    } else {
      this.provider = mainProvider;
      this.model = mainModel;
    }
  }

  /**
   * 成果物を評価し、フィードバックを返す
   */
  async evaluate(params: {
    taskType: "code" | "document" | "research";
    files: { path: string; content: string }[];
    originalRequest: string;
    additionalContext?: string;
  }): Promise<EvaluatorResult> {
    const prompt = this.buildEvaluationPrompt(params);
    // ... LLM呼び出し、結果パース
  }
}
```

#### 発動条件

メカニズムBは以下の条件で発動:

1. `pendingVerification` にドキュメント系ファイル（`.md`, `.txt`, `.rst` 等）がある
2. LLMが完了宣言をした（`classifyCompletion` で "completed" 判定）
3. ユーザーの元の依頼が一定以上の複雑さ（単純な挨拶・質問ではない）

```
LLM「完了しました」→ classifyCompletion: "completed"
  → pendingVerification にドキュメントファイルあり?
    → Yes: Evaluator起動 → 結果に基づいて再プロンプト or ユーザーに返す
    → No: 通常完了処理
```

#### Evaluator結果のメインLLMへの注入

```
[自動レビュー結果]
独立したレビュアーが成果物を確認しました:

{evaluator.summary}

指摘事項:
{issues をフォーマットして列挙}

上記の指摘に対応してください。修正が完了したら報告してください。
```

### 4.3 タスク種別の自動判定

`pendingVerification` のファイル拡張子から自動判定:

```typescript
function classifyFileType(filePath: string): "code" | "document" {
  const codeExtensions = new Set([
    ".ts", ".js", ".tsx", ".jsx", ".py", ".rs", ".go", ".java",
    ".c", ".cpp", ".h", ".hpp", ".css", ".scss", ".html", ".vue",
    ".svelte", ".json", ".yaml", ".yml", ".toml", ".sql", ".sh",
  ]);
  const ext = path.extname(filePath).toLowerCase();
  return codeExtensions.has(ext) ? "code" : "document";
}
```

コードファイルとドキュメントファイルが混在する場合:
- コードファイル → メカニズムA（bash検証を要求）
- ドキュメントファイル → メカニズムB（Evaluatorレビュー）
- 両方ある場合は両方実行

### 4.4 システムプロンプト強化

現在の抽象的な記述:
```
# 実装→検証サイクル [必須]
実装(file_write/edit) → 検証(bash) → エラー修正 → 再検証。省略禁止。
```

具体化した記述:
```
# 実装→検証→完了サイクル [必須]

## コード変更時
1. file_write/file_edit でコードを書く
2. 必ず bash で検証してから完了報告:
   - .ts/.js → node --check <file>
   - テストがある → npm test / pytest 等を実行
   - Webアプリ → 起動して browser_screenshot で確認
   - 汎用 → build/lint コマンド実行
3. 検証が失敗 → 修正して再検証。通るまで繰り返す
4. 検証成功の事実を報告に含める

## 文章・ドキュメント変更時
1. file_write で文章を書く
2. 完了前に自己チェック:
   - 元の依頼の要件を満たしているか
   - 前後の文脈との整合性
   - 論理の飛躍がないか
3. 不安な点があれば修正してから完了報告

## 禁止事項
- 検証なしの「完了しました」
- テスト未実行での完了報告
- エラーを無視して次のファイルへ移動
```

---

## 5. 終了条件の設計

### 5.1 設計思想

回数制限やLLM判定ではなく、**客観的事実に基づく終了**を原則とする。

| 終了トリガー | 判定方法 | LLM判定への依存 |
|-------------|---------|----------------|
| コード検証成功 | bashの exit code = 0 | なし |
| Evaluator合格 | EvaluatorResult.passed = true | Evaluator LLMのみ（メインLLMではない） |
| ユーザー介入 | ユーザーが「OK」等の承認応答 | なし |
| 安全弁: 最大リトライ | メカニズムA: 3回、B: 2回 | なし |

### 5.2 安全弁

無限ループ防止のため、検証リトライに上限を設ける:

- **メカニズムA（bash検証）**: 3回検証しても失敗する場合 → ユーザーに状況報告して判断を委ねる
- **メカニズムB（Evaluatorレビュー）**: 2回レビューしても不合格の場合 → Evaluatorの指摘とともにユーザーに報告

安全弁発動時のメッセージ:
```
検証を{N}回実施しましたが、以下の問題が解決していません:
{未解決の問題リスト}

続行しますか？それとも方針を変更しますか？
```

この時、ask_user で選択肢を提示:
```
options: [
  { label: "続行 (推奨)", description: "現在の方針で修正を続ける" },
  { label: "方針変更", description: "別のアプローチで最初からやり直す" },
  { label: "現状で完了", description: "未解決の問題を承知の上で完了とする" },
]
```

---

## 6. 実装フェーズ

### Phase 1: メカニズムA（ツール追跡）+ システムプロンプト強化
- `agent-loop.ts` に `pendingVerification` 追跡を追加
- bash未実行時の再プロンプト注入
- システムプロンプトの検証ガイド具体化
- **効果**: コーディングタスクの検証漏れを防止

### Phase 2: Evaluatorの基盤
- `src/agent/evaluator.ts` 新規作成
- secondLLM ?? mainLLM の自動選択
- ドキュメント系ファイルの完了時にEvaluator自動起動
- **効果**: 文章系タスクの品質向上

### Phase 3: 評価基準のチューニング
- タスク種別ごとの評価プロンプト最適化
- Evaluatorの厳しさ調整（few-shot例の追加）
- 安全弁の閾値調整
- **効果**: 評価精度の向上

---

## 7. 設計上の判断と根拠

### 7.1 なぜ3エージェント完全分離ではないか

Anthropic記事のPlan-Generate-Evaluateパターンは、6時間/$200の長時間タスク向け。
本アプリの主要ユースケース（10-30分のコーディングタスク）では:

- Plannerの分離 → 既存の `enter_plan_mode` / `todo_write` で代替可能
- Generator → メインLLMそのもの
- Evaluator → **これだけ分離する**のが費用対効果最大

記事も「導入推奨順序: Evaluator単体追加 → Generator → Planner段階的分離」と述べている。

### 7.2 なぜメカニズムAとBを分けるか

コード検証（メカニズムA）は:
- exit code という完璧な判定基準がある
- LLM呼び出し不要（高速・低コスト）
- 27Bモデルでも結果を見れば対応できる

文章レビュー（メカニズムB）は:
- 客観的な合否基準がない
- LLMによる判断が必須
- 生成者と評価者の分離が効果的

両方をEvaluatorに統一すると、コード検証にも不要なLLM呼び出しが発生する。

### 7.3 メインLLM/セカンドLLMの使い分け

現時点の方針:
- **生成（メインタスク）**: 常にメインLLM
- **評価（Evaluator）**: secondLLM ?? mainLLM（別コンテキスト）
- **探索・計画（サブエージェント）**: 現行通りメインLLMのサブエージェント

将来的にはサブエージェントもsecondLLMを選択可能にできるが、
まずはEvaluatorの分離を優先する。
