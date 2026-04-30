# メインLLM / セカンドLLM / サブエージェント 比較・現状整理

> **作成日**: 2026-04-30
> **目的**: 「メインLLM」「セカンドLLM」「サブエージェント」 という 3 つの実行主体について、**何が違うのか / 何が同じなのか** を 1 か所に集約し、現在のコード実装と過去の設計書の間に生じているズレを可視化する。
> **位置付け**: 修正の足掛かりとなる現状把握資料。 設計の最終形ではない。
> **関連設計書**:
> - 元設計: `docs/v030_second_llm_design.md` (Orchestrator-Worker パターン、 階層型委任ルール)
> - 対称化: `docs/main_second_swap_design.md` (型統一・swap 機能、 主従の対称性)
> - 補助情報: `docs/llm-profile-descriptions.md` (description によるルーティング誘導)
> - ハーネス: `docs/harness-engineering.md`, `docs/harness-engineering-phase5.md` (委任ガード、 Evaluator 統合)

---

## 1. 一言でまとめると

| 主体 | 何者か | LLM | 起動契機 |
|------|--------|-----|----------|
| **メインLLM** | ユーザーと対話する オーケストレータ。 `AgentLoop` 本体 | `config.mainLLM` で指定された Provider/Model | アプリ起動時に 1 つだけ |
| **サブエージェント (task)** | メインLLMの **「分身」**。 同じ Provider/Model を別コンテキストで再起動 | メインLLMと同一 (`SubAgentManager` がメインの provider/model を保持) | メインLLMが `task` ツールを呼んだとき |
| **セカンドLLM consult** | **別の** LLM への単発相談 (ツール無し) | `config.secondLLM.endpoint` で指定された別 Provider/Model | メインLLMが `second_llm_consult` を呼んだとき |
| **セカンドLLM agent** | **別の** LLM をサブエージェント化したもの (ツール有り) | 同上 | メインLLMが `second_llm_agent` を呼んだとき |
| **Evaluator** | 成果物を独立レビューする「第三者」 役 | セカンドLLM があればそちら、 無ければメイン | メインLLMが file_write/edit を完了して response_complete を呼ぶ直前に自動起動 |

ポイント:
- **「サブエージェント」 ≠ 「セカンドLLM」**。 サブエージェント = メインの分身 (同一モデル) / セカンドLLM = 別モデル
- サブエージェントは **メインの能力を別コンテキストでもう一度走らせる** (コンテキスト分離が主目的)
- セカンドLLMは **異なる特性を持った別モデルに渡す** (専門性 / コスト効率 / 並列性が主目的)
- Evaluator は v0.3.0 設計書には無い、 後付けの概念。 セカンドLLMがあれば自動的にレビュー役を兼ねる

---

## 2. 全体俯瞰図

```mermaid
graph TD
    classDef user fill:#fce4ec,stroke:#c2185b,stroke-width:2px;
    classDef main fill:#e1f5fe,stroke:#0288d1,stroke-width:3px;
    classDef sub fill:#fff3e0,stroke:#f57c00;
    classDef second fill:#f3e5f5,stroke:#8e24aa;
    classDef eval fill:#e8f5e9,stroke:#43a047;
    classDef tool fill:#f1f8e9,stroke:#689f38;
    classDef guard fill:#ffebee,stroke:#d32f2f;

    User([ユーザー]):::user --> Main

    subgraph "プロセス内 (Node.js / 単一 ToolRegistry を共有)"
        Main["🎯 メインLLM<br/>AgentLoop (本体)<br/>config.mainLLM"]:::main

        Main -- "task ツール" --> SAM["SubAgentManager"]:::sub
        SAM -- "launchForeground/Background/Parallel" --> Sub["👤 サブエージェント<br/>SubAgent インスタンス<br/>= メインと <b>同じ</b> Provider/Model"]:::sub

        Main -- "second_llm_consult ツール" --> SLM1["SecondLLMManager.consult()<br/>1 回呼び切り (ツール無し)"]:::second
        Main -- "second_llm_agent ツール" --> SLM2["SecondLLMManager.runAsAgent()<br/>ツール実行ループ"]:::second
        Main -- "(自動) response_complete 直前" --> EV["Evaluator<br/>file_read/grep/glob で自律レビュー"]:::eval

        SLM1 -.利用.-> SecondProvider["🌐 セカンドLLM Provider<br/>config.secondLLM.endpoint"]:::second
        SLM2 -.利用.-> SecondProvider
        EV -.セカンド利用可なら.-> SLM3["SecondLLMManager.runAsEvaluator()<br/>読取専用ツール (file_read/grep/glob)"]:::eval
        SLM3 -.利用.-> SecondProvider
        EV -.セカンド利用不可なら.-> Main

        Sub --> Tools["共有 ToolRegistry<br/>(task のみ除外)"]:::tool
        SLM2 --> Tools2["共有 ToolRegistry<br/>(EXCLUDED_TOOLS を除外)"]:::tool
    end

    subgraph "セーフティ"
        DG["DelegationGuard<br/>連続/累計委任回数の上限"]:::guard
        Lock["dialogueLockUntil<br/>拒否/委任失敗時の対話必須ロック"]:::guard
    end
    SLM1 -.checkDelegation.-> DG
    SLM2 -.checkDelegation.-> DG
    Main -.発動.-> Lock
```

凡例:
- **🎯 メインLLM** = ユーザーと直接対話する。 1 プロセスに 1 つ
- **👤 サブエージェント** = メインの分身 (同 Provider/Model)。 task ツールで起動
- **🌐 セカンドLLM** = 別 Provider/Model。 consult / agent / evaluator の 3 用途
- 共有部分: `ToolRegistry` / `PermissionManager` / `Sandbox` / `HarnessState` (各エージェントごとにインスタンスを分けるが、 contract は共通)

---

## 3. 比較表 — どこが同じでどこが違うか

### 3.1 LLM・コンテキスト面

| 観点 | メインLLM | サブエージェント (task) | セカンドLLM consult | セカンドLLM agent | Evaluator |
|------|-----------|--------------------------|----------------------|-------------------|-----------|
| **Provider/Model** | `config.mainLLM` | メインと **同一** (継承) | `config.secondLLM.endpoint` | 同左 | セカンドが利用可 ⇒ セカンド / 不可 ⇒ メイン |
| **会話履歴** | 永続 (`MessageHistory`) | **新規** (1 タスク完了で破棄) | **新規** (1 リクエストで破棄) | **新規** (1 タスク完了で破棄) | **新規** (1 評価で破棄) |
| **System Prompt** | `buildSystemPrompt()` (フル) | 各サブエージェント定義 (`explore`/`plan`/`general-purpose`/`bash`) または `.md` 定義 | 「単発相談用」 圧縮版 | `buildSubAgentStrategyPrompt()` (戦略原則を継承) | `EVALUATOR_SYSTEM_PROMPT_AGENTIC` (評価専用) |
| **コンテキスト圧縮** | あり (`ContextManager`) | なし (短命のため) | なし | なし (15 ターン上限のため) | なし |

### 3.2 ツールアクセス面

| 観点 | メインLLM | サブエージェント (task) | セカンドLLM consult | セカンドLLM agent | Evaluator |
|------|-----------|--------------------------|----------------------|-------------------|-----------|
| **使えるツール** | 全ツール | `allowedTools` 指定があればホワイトリスト / 無ければ **`task` のみ除外** | **無し** | 共有 ToolRegistry から `EXCLUDED_TOOLS` を除いた全て | `file_read` / `grep` / `glob` の 3 つ |
| **EXCLUDED_TOOLS** | (なし) | `task` のみ | n/a | `task`, `task_output`, `second_llm_consult`, `second_llm_agent`, `enter_plan_mode`, `exit_plan_mode` | n/a (ホワイトリスト方式) |
| **ハーネス介入** | あり (`harnessState`) | なし | なし | あり (`HarnessState` 独立インスタンス) | あり (`HarnessState` 独立インスタンス) |
| **dialogueLock の影響** | 受ける (file_write/edit を tool 層で拒否) | 受けない | 受けない | 受けない | 受けない |

### 3.3 制御・上限面

| 観点 | メインLLM | サブエージェント | セカンドLLM consult | セカンドLLM agent | Evaluator |
|------|-----------|------------------|---------------------|-------------------|-----------|
| **ターン上限** | `MAX_TOOL_ITERATIONS` | `maxTurns` (定義) または `MAX_SUB_ITERATIONS = 30` | 1 (構造的に) | `MAX_ITERATIONS = 15` | `params.maxIterations ?? 10` |
| **委任ガード対象** | n/a | n/a | あり (`checkDelegation`) | あり | **無し** (独立レビューと位置付け) |
| **DelegationGuard 上限** | n/a | n/a | maxConsecutive=5 / maxTotal=20 | 同左 | n/a |
| **サンプリング (温度)** | `samplingParams` で `/model temperature` 等から指定 | メイン継承 | endpoint 設定 ?? **0.2** (fallback) | endpoint 設定 ?? **0.2** | endpoint 設定 ?? **0.1** |

### 3.4 ライフサイクル

| 観点 | メインLLM | サブエージェント | セカンドLLM consult | セカンドLLM agent | Evaluator |
|------|-----------|------------------|---------------------|-------------------|-----------|
| **生成タイミング** | アプリ起動時 (`src/index.ts`) | `task` ツール実行時に都度 `new SubAgent(...)` | `second_llm_consult` 実行時にメッセージ列を都度組成 | 同上 | response_complete 直前に毎回 `evaluator.evaluate(...)` |
| **再利用** | 1 プロセスを通じて | 1 タスクで使い捨て | 1 リクエストで使い捨て | 1 タスクで使い捨て | 1 評価で使い捨て |
| **swap で置換** | `/swap` で endpoint 入替 | 親が swap されればその後生成される子は新 endpoint | `/swap` で endpoint 入替 | 同左 | セカンド endpoint 入替時に `setMainProvider` で再判定 |

---

## 4. コード構造のマッピング

```mermaid
classDiagram
    class AgentLoop {
        +run(userMessage)
        -secondLLMManager: SecondLLMManager?
        -evaluator: Evaluator
        -harnessState: HarnessState
        -dialogueLockUntil: number
    }
    class SubAgentManager {
        -provider: LLMProvider
        -model: string
        +setProvider(provider, model)
        +launchForeground(type, desc, prompt)
        +launchBackground(type, desc, prompt)
        +launchParallel(tasks)
        +launchSkillFork(name, prompt, allowed, ...)
    }
    class SubAgent {
        -provider: LLMProvider  // メインと同じ
        -model: string          // メインと同じ
        -filteredRegistry: ToolRegistry
        -config: SubAgentConfig
        +run(prompt)
    }
    class SecondLLMManager {
        -provider: LLMProvider  // セカンド用
        -endpoint: SecondLLMEndpoint
        -delegationGuard: DelegationGuard
        +consult(prompt)
        +runAsAgent(prompt)
        +runAsEvaluator(params)
    }
    class Evaluator {
        -secondLLMManager: SecondLLMManager?
        -mainProvider: LLMProvider
        -mainModel: string
        -source: "secondLLM" | "mainLLM"
        +evaluate(params)
    }
    class taskTool {
        +execute() => SubAgentManager.launchForeground/Background
    }
    class secondLLMConsultTool {
        +execute() => SecondLLMManager.consult
    }
    class secondLLMAgentTool {
        +execute() => SecondLLMManager.runAsAgent
        +reason: "context_protection"|"parallelism"|"specialty"
    }

    AgentLoop --> SubAgentManager : task 経由
    AgentLoop --> SecondLLMManager : second_llm_* 経由
    AgentLoop --> Evaluator : 自動レビュー
    SubAgentManager --> SubAgent : 新規生成
    Evaluator --> SecondLLMManager : runAsEvaluator
    taskTool ..> SubAgentManager
    secondLLMConsultTool ..> SecondLLMManager
    secondLLMAgentTool ..> SecondLLMManager
```

主要ファイル:
- `src/agent/agent-loop.ts` — メインLLM の本体
- `src/agent/sub-agent.ts` — `SubAgent` / `SubAgentManager`
- `src/second-llm/second-llm-manager.ts` — セカンドLLM の 3 モード
- `src/second-llm/delegation-guard.ts` — 委任ガード
- `src/agent/evaluator.ts` — Evaluator
- `src/tools/definitions/task.ts` — `task` / `task_output` ツール
- `src/tools/definitions/second-llm.ts` — `second_llm_consult` / `second_llm_agent` ツール

---

## 5. 委任の意思決定フロー (現在の実装)

```mermaid
flowchart TD
    Start([メインLLMがタスクを受領]) --> Q1{委任の3条件のいずれかを満たす?<br/>① コンテキスト保護<br/>② 並列性<br/>③ 専門性}
    Q1 -- いずれも該当しない --> Inline[インラインで処理]
    Q1 -- 該当する --> Q2{ツール実行が必要?}
    Q2 -- 不要 (単発相談) --> Q3{別モデルの特性が活きる?}
    Q2 -- 必要 --> Q4{別モデルの特性が活きる?<br/>または 並列で走らせたい?}
    Q3 -- Yes --> SC[second_llm_consult]
    Q3 -- No --> Inline
    Q4 -- Yes --> SA[second_llm_agent]
    Q4 -- No --> TK[task<br/>= メインの分身]
    SC --> DG1{DelegationGuard OK?}
    SA --> DG2{DelegationGuard OK?}
    DG1 -- NG --> Block[拒否]
    DG2 -- NG --> Block
    DG1 -- OK --> Run1[セカンドLLM 単発呼出]
    DG2 -- OK --> Run2[セカンドLLM ツールループ]
    TK --> Run3[サブエージェント起動]
    Run1 --> Done([結果をメインに戻す])
    Run2 --> Done
    Run3 --> Done
```

メイン側のシステムプロンプトに埋め込まれている判定ガイド (`src/agent/system-prompt.ts:151-176`):

> 委任は 3 条件のいずれかが満たされる時のみ。 それ以外はインライン処理。
> 1. コンテキスト保護: 大量ファイル読込で本セッションのコンテキストを浪費したくない
> 2. 並列性: 独立した複数タスクを同時に走らせたい
> 3. 専門性: 別モデルの特性 (高速/別視点等) が活きるタスク
>
> 委任時のレジスター継承 [必須]: delegate メッセージには ① レジスター ② 完成基準 ③ 仕様ファイルパス ④ 成果物保存先 を必ず含める。

`second_llm_agent` には `reason` 引数 (`context_protection` / `parallelism` / `specialty`) のハードガードがあり、 該当しない委任は tool 層で拒否される (`src/tools/definitions/second-llm.ts:177-190`)。

---

## 6. 設計意図と現状のズレ — 修正検討材料

ここからが本ドキュメントの本題。 **「v0.3.0 設計書」「main⇔second swap 設計書」 と現在のコードの間に生じている差分** を列挙する。 すべてが「直すべき問題」 とは限らない (進化として正当な変更もある) が、 **意図せずズレている可能性のあるもの** を分けて示す。

### 6.1 サブエージェントの EXCLUDED_TOOLS が緩い (要検討)

| 比較項目 | v0.3.0 設計書 §2.3 | 現在の `src/agent/sub-agent.ts:184-211` |
|---------|---------------------|------------------------------------------|
| **C1 ルール** | 「Level 2 のメンバーは Level 2 以上のメンバーを起動できない」 (分身も task ツールを除外済み) | `allowedTools` 未指定のサブエージェント (= general-purpose) は **`task` のみ除外**。 `second_llm_consult` / `second_llm_agent` は呼べる |

**観察される結果**: `general-purpose` サブエージェント (= メインの分身) が `second_llm_agent` を呼べてしまう。 これは元設計の C1 違反。

**判断材料**:
- 一方で main_second_swap_design.md の対称性思想からすれば「サブエージェントもメインと同等の権限で良い」 という見方もできる
- しかし「再帰的増殖」 のリスクは残っている。 サブエージェント A → second_llm_agent → サブエージェント A の親メインに戻る、 のような循環が原理的にあり得る (DelegationGuard で止まる想定だが、 構造的なバリアではない)

**修正候補**:
- `sub-agent.ts:202-209` の filtering を `second-llm-manager.ts:20-27` の `EXCLUDED_TOOLS` と統一する
- または「サブエージェントは second_llm_* を呼べる、 ただし再帰検出は DelegationGuard に一任」 を **明示的に文書化** する

### 6.2 メインLLMが「ローカルLLM のみ」 の前提が崩れている (進化済み・要文書更新)

| 比較項目 | v0.3.0 設計書 §1.2 | main_second_swap_design.md §3.1 | 現在の実装 |
|---------|---------------------|----------------------------------|--------------|
| **メインLLMの想定** | 「ローカルLLM のみ。 変更なし」 | 「主従の対称性: 型を分けない」 | `config.mainLLM = LLMEndpoint`、 cloud (vertex-ai/azure-*) も指定可 |

**観察される結果**: 設計書 v0.3.0 が「メイン=ローカル限定」 を前提にした文章のまま残っており、 後発の swap 設計書と整合していない。 README やセットアップウィザードの想定もズレている可能性。

**修正候補**:
- `docs/v030_second_llm_design.md` に「**注**: §1.2 の方針は v0.3.0 リリース時の方針であり、 main⇔second swap 機能 (`docs/main_second_swap_design.md`) で対称化された」 という追記
- もしくは v030 設計書を「歴史的経緯」 として `archive/` に移し、 現在の方針を 1 本にまとめた上位設計を新規作成する

### 6.3 Evaluator が設計書に存在しない (後付け)

v0.3.0 設計書には `Evaluator` の記述が無い。 現在の実装では:

- `AgentLoop` がコンストラクタで `new Evaluator(secondLLMManager, provider, model)` を生成
- file_write/edit が完了 → response_complete 直前で `evaluator.evaluate()` が自動実行
- セカンドLLM があれば `runAsEvaluator()` (読取専用ツール 3 つ) で**エージェンティック評価**
- 無ければメインLLMで 1 回呼び切り評価

これは `docs/harness-engineering.md` 系の Phase 5 で導入された (Anthropic "Harness Design for Long-Running Apps" の Evaluator パターン)。 v030 設計書 §1.3 のセカンドLLMの「動作モード」 にも `consult` / `agent` の 2 つしか書かれていないが、 実装は 3 つ目として `evaluator` がある。

**修正候補**:
- v030 設計書 §1.3, §4.1 (`SecondLLMMode` 型) に `evaluator` を追加
- もしくは Evaluator は「セカンドLLMの利用形態」 ではなく「ハーネス側のレビュー機構」 として独立記述する。 `docs/harness-engineering.md` 群への参照を太字で v030 から張る

### 6.4 DelegationGuard の数値が設計書と異なる (微差)

| 比較項目 | v0.3.0 設計書 §2.3, §4.2 | 現在の `src/second-llm/second-llm-manager.ts:74-78` |
|---------|---------------------|------------------------------------------|
| 連続呼出上限 | maxConsecutiveCalls = 3 | maxConsecutiveDelegations = **5** |
| セッション全体上限 | maxSessionCalls = 50 | maxTotalDelegations = **20** |
| エージェントモードのターン上限 | maxAgentTurns = 30 | `MAX_ITERATIONS = 15` (ハードコード) |

数値が設計書より「セッション全体は厳しく / 連続は緩く / エージェントターンは半分」 にチューニングされている。 ハーネス Phase 5 の試行錯誤で調整された結果と推測。

**修正候補**: 設計書側の数値を実装値に合わせる、 または実装側のコメントで「v030 §2.3 から変更: 理由 X」 を記述。

### 6.5 v030 にあった「@second」 プレフィックス / `/second ask` が実装されていない

v030 §7.3 では:
1. `@second` プレフィックスで明示委任
2. `/second ask` コマンドで直接相談
3. メインLLMが自動判断

の 3 経路があると記述。 現在の実装には経路 1, 2 が無く、 経路 3 (LLM が自発的に `second_llm_*` を呼ぶ) のみ。 REPL の `/second` は `setup`, `status`, `enable`, `disable`, `temperature` 系の管理コマンド中心。

**観察される結果**: ユーザーが「セカンドに直接聞かせたい」 ときの導線が不明確。 メインLLMの判断にフルに任されており、 description 設定 (llm-profile-descriptions.md) が誘導の主役になっている。

**判断材料**:
- 現状の方針 (description でルーティング誘導) は main_second_swap_design.md の対称性と整合
- 一方で「ユーザーが特定経路を明示指定する」 体験は failed の場合のみ (system-prompt.ts:144-148 の 3 択提示) 顕在化する

**修正候補**:
- `@second` プレフィックスを復活させる (v030 §7.3 を実装する)
- もしくは v030 §7.3 を「不採用」 として明示的に取り消す (設計書側で削除 or strikethrough)

### 6.6 サブエージェント = 「メインの分身」 と書きつつ、 SubAgent は任意の Provider を受け取れる構造

`SubAgent` のコンストラクタ (`src/agent/sub-agent.ts:155-163`) は `provider: LLMProvider` と `model: string` を任意に受け取れる構造。 現状は `SubAgentManager` が「メインの provider/model を保持」 する運用で実質的に分身となっているが、 **将来 task が `use_model: "main" | "second"` を取れる拡張余地が暗黙的に残っている**。

これは llm-profile-descriptions.md の §「将来拡張余地」 にも書かれているとおり想定済み。 ただし現状は task = メイン固定 / second_llm_agent = セカンド固定で十分という判断。

**判断材料**: 現状で問題ないが、 「task はメイン固定」 のルールを `system-prompt.ts:262` の文言だけでなく **コードで型付けして閉じる** (= `SubAgentManager` のコンストラクタを 1 本に絞る) 方が安全。

### 6.7 セカンドLLMの 3 用途 (consult / agent / evaluator) と「相談 / 委任 / 評価」 の責務境界

現在のセカンドLLMは 3 つの顔を持つ:
1. **consult** (`SecondLLMManager.consult`): 単発相談、 ツール無し
2. **agent** (`SecondLLMManager.runAsAgent`): タスク委任、 ツール有り、 DelegationGuard 対象
3. **evaluator** (`SecondLLMManager.runAsEvaluator`): 自動レビュー、 読取専用ツール 3 つ、 DelegationGuard **対象外**

evaluator が DelegationGuard の対象外なのは、 「ユーザーターンごとに 1〜N 回必ず走るレビュー機構なので、 委任ガードと別の論理で動かす」 という設計判断。 ただし**「レビュー」 と「委任」 の責務がセカンドLLM 1 個に乗っている** ことで:

- セカンド endpoint の障害 → consult/agent だけでなく Evaluator も道連れ
- セカンド endpoint の温度設定 → consult=0.2 / agent=0.2 / evaluator=0.1 と用途別、 これらの fallback 値はハードコード
- セカンドLLMの description は 1 つしか持てない → 「相談に向く特性」 と「評価に向く特性」 を 1 文字列で表現する必要がある

**判断材料**:
- 現状は実用上問題なし。 ただし「Evaluator は別 endpoint (例: 安いモデル) で走らせたい」 というニーズが出たら破綻する
- 将来的な拡張余地として「evaluatorLLM endpoint を別建てする」 オプションを設計書に記述しておくと良い

### 6.8 サブエージェントのハーネス介入が無い

セカンドLLM (consult を除く agent/evaluator) は `HarnessState` を独立に持ち、 壁ドンループ検出・Read→Edit 契約・連続委任ガードが効く (`src/second-llm/second-llm-manager.ts:210, 343`)。

一方 **サブエージェント (`SubAgent`) には HarnessState の組み込みが無い** (`src/agent/sub-agent.ts:148-326`)。 ツールの直接呼び出しのみで、 `enrichToolResult` を通っていない。

**観察される結果**: 「分身が壁ドンループに陥っても、 ハーネスで助けが入らない」。 メインに比べて分身は **ハーネス支援が薄い**。

**判断材料**:
- v030 §2.1 では「コンテキスト分離」 を分身の主目的に挙げており、 ハーネスの再現は議論されていない
- ただし harness-engineering Phase 5 でハーネス介入が「能力の発揮に必須」 と位置付けられているので、 分身にも同等の介入を入れた方が一貫性が高い

**修正候補**:
- `SubAgent.run()` 内で `HarnessState` インスタンスを生成し、 ツール結果を `enrichToolResult` でラップする
- これは sub-agent のロジックを `runAsAgent` (second-llm-manager) と統合するチャンス

### 6.9 サンプリング fallback の温度ハードコード

| 用途 | endpoint 未指定時の温度 |
|------|---------------------------|
| consult | 0.2 |
| runAsAgent | 0.2 |
| runAsEvaluator | 0.1 |

main_second_swap_design.md §2.2 で「ユーザーが `/second temperature` を設定すれば fallback を上書きできる」 と整理されているが、 **fallback の値そのものはコード固定**。 設定ファイル (`config.json`) や設計書ではユーザーから見えない。

**修正候補**: fallback を `config-reference.md` の §secondLLM に記載するか、 fallback 自体を設定可能にする (例: `config.secondLLM.endpoint.temperature_fallback`)。

---

## 7. まとめ — 「直す前に決めるべき問い」

このドキュメントを足掛かりに、 修正方針を決める際の問いを整理する。

### Q1. メインLLMとサブエージェントは「同じ立場」 を維持するか?
- 維持するなら: SubAgent も `EXCLUDED_TOOLS` (second_llm_*, plan_mode 系) を持たせて Level 階層を再構築するべきではない
- そうでないなら: §6.1 の通り EXCLUDED_TOOLS を強化する

### Q2. v0.3.0 設計書をどうするか?
- 「歴史的経緯」 として archive する: main_second_swap_design.md + harness-engineering 系を上位設計と位置付ける
- 維持する: §1.2 (メイン=ローカル限定) と §1.3 (動作モード=consult/agent のみ) を更新

### Q3. Evaluator はセカンドLLMの 1 用途? それとも独立した役者?
- セカンドLLMの 1 用途: v030 §1.3, §4.1 を更新して `SecondLLMMode = "consult" | "agent" | "evaluator"` に
- 独立した役者: `Evaluator` を「メイン/セカンドのどちらか / または別 endpoint」 を選べる構造に拡張

### Q4. 「@second」 プレフィックスや `/second ask` を復活させるか?
- 復活させる: v030 §7.3 を実装し、 ユーザー明示経路を提供
- 取り消す: v030 §7.3 を削除 or 注記し、 description ベースのルーティング誘導に一本化

### Q5. サブエージェントにもハーネス介入を入れるか?
- 入れる: §6.8 の通り `HarnessState` を `SubAgent` に組み込み、 メインと一貫性を持たせる
- 入れない: 「分身は短命なのでハーネスは不要」 と整理して文書化

---

## 8. 関連ファイル一覧 (現状把握用)

| 役割 | ファイル |
|------|----------|
| メインLLM | `src/agent/agent-loop.ts` |
| メイン用 system prompt | `src/agent/system-prompt.ts` |
| サブエージェント | `src/agent/sub-agent.ts` |
| サブエージェント定義 | `src/agents/agent-loader.ts` + `~/.localllm/agents/*.md` |
| セカンドLLM | `src/second-llm/second-llm-manager.ts` |
| セカンドLLM ガード | `src/second-llm/delegation-guard.ts` |
| Evaluator | `src/agent/evaluator.ts` |
| ハーネス共通介入 | `src/agent/harness-intervention.ts` |
| LLM プロファイル | `src/agent/llm-profiles.ts` |
| task ツール | `src/tools/definitions/task.ts` |
| second_llm_* ツール | `src/tools/definitions/second-llm.ts` |
| 起動・初期化 | `src/index.ts` (Line 215〜260, 330〜332, 457) |
| swap コマンド | `src/cli/repl.ts` (`/swap`, `/second *`, `/model *`) |
| 型定義 | `src/config/types.ts` (`LLMEndpoint`, `SecondLLMEndpoint`, `SecondLLMConfig`) |

**設計書一覧 (時系列)**:
1. `docs/v030_second_llm_design.md` (2026-03-15) — Orchestrator-Worker パターン、 階層型委任、 Credential Vault
2. `docs/llm-profile-descriptions.md` (時期不明) — description によるルーティング誘導
3. `docs/harness-engineering.md` / `harness-engineering-phase5.md` (Phase 5: 2026 春) — Evaluator・ハーネス介入の導入
4. `docs/main_second_swap_design.md` (2026-04-29) — 型統一・主従対称化
