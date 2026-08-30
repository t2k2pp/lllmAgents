# モデル・オーケストレーション設計書 (Model Registry Phase 6)

> **ステータス**: 2026-08-13 設計 / 実装
> **位置付け**: `docs/model-registry.md` の Phase 6 「任意 named slot の REPL 操作 +
> サブエージェントカタログとのバインド」 を具体化した実装設計書。
> **前提**: Phase 1〜5 (registry + slot の 2 層モデル、 `/models` ピッカー、 vision slot) は実装済み。

---

## 1. 背景と目的

### 1.1 現状

LLM の使い分けは **メイン / セカンド の 2 択に固定**されている。

| 実行主体 | 使うモデル | 決め方 |
|----------|-----------|--------|
| メインループ (`AgentLoop`) | main slot | 固定 |
| サブエージェント (`task` ツール) | **main slot** | 固定 (`SubAgentManager` が main の provider を持つ) |
| セカンド委任 (`second_llm_agent` / `second_llm_consult`) | second slot | 固定 |
| Evaluator (`/try` の評価役) | second slot | 固定 |
| Vision | vision slot → 無ければ main | 固定 |

つまり **「どのモデルを使うか」 はコード側が決めており、 モデル自身が選ぶ余地がない**。
registry には 5 個でも 10 個でもモデルを登録できるが、 実際に走らせられるのは
main / second / vision の 3 枠だけ、 という状態になっている。

### 1.2 目指す姿

Claude Code が Fable / Opus / Sonnet / Haiku を **タスクごとに選び分ける**のと同じ構造を作る。

- 複数モデルを **あらかじめ登録** しておく (= registry。 既に可能)
- それぞれに **役割 (slot) の名前** を付ける (`fast` / `deep` / `review` / `cheap` …)
- **サブエージェント定義側**が「自分はこの slot で走る」 と宣言できる
- **モデル自身**が委任時に「このタスクは deep で」 と指名できる
- 指名がなければmainを既定モデルとして使う

### 1.3 スコープ外 (今回やらない)

- 自動モデル選択 (タスク難易度から自動で slot を決める)。 まずは **明示指名**を通す。
  自動化は `capability-tier.ts` の判定結果と組み合わせて後続フェーズで検討する
- 並列マルチモデル実行のスケジューラ。 既存の `maxParallelTools` に従う
- slot ごとの課金上限・レート制御

---

## 2. データモデル

Phase 1 で導入済みの型をそのまま使う。 **型の変更は無い**。

```ts
interface LLMSlotAssignments {
  main: string;                        // registry entry id
  second?: string;
  named?: Record<string, string>;      // ← ここを一級市民として使い始める
}
```

`slots.named` は Phase 1 で optional として用意済みだが、 現状 `vision` しか入らない。
Phase 6 では **任意の名前**を受け付ける。

### 2.1 slot 名の規約

| 種別 | 名前 | 扱い |
|------|------|------|
| 特権 slot | `main` | 必須。 メインループが使う。 空にできない |
| 特権 slot | `second` | 任意。 `second_llm_*` ツール群と Evaluator が使う |
| 予約 named slot | `vision` | 画像認識。 `VisionService` が使う (Phase 5 実装済み) |
| 自由 named slot | 任意の英小文字 + 数字 + `-` (2〜20 文字) | user が自由に定義。 サブエージェント / `task` ツールから指名可能 |

予約語 (`main` / `second` / `vision`) を `/models slot` の自由 slot として使おうとした場合は、
**それぞれの正規経路 (`/models` の Set as main 等) に誘導**する。 これは
main/second/vision が単なる参照ではなく **`config.json` への同期書込みと provider 再生成**
を伴うため (§5 参照)。

### 2.2 slot の説明文

slot 自体には説明文を持たせない。 「その slot が何のためのものか」 は
**割り当てられた registry entry の `endpoint.description`** で表現する。
理由:

- 説明の二重管理 (slot の説明 / entry の説明) を避ける
- slot は「役割名」 という短いラベルで十分意味が伝わる
- entry を差し替えたら説明も一緒に付いてくるのが自然

---

## 3. ModelResolver — 参照から実行可能な provider へ

新規 `src/config/model-resolver.ts`。 **「モデル参照 (ref) を受け取り、 生きた provider を返す」**
単一の解決層。 これが Phase 6 の中核。

### 3.1 モデル参照 (ModelRef) の文法

文字列 1 本で表現する。 サブエージェント frontmatter・`task` ツール引数・CLI 引数で共通。

| 記法 | 意味 | 例 |
|------|------|-----|
| `main` | main slot | `main` |
| `second` | second slot | `second` |
| `<slot-name>` | named slot | `deep` / `fast` |
| `id:<entry-id>` | registry entry を id 直指定 (slot を経由しない) | `id:4f75-…` |
| `name:<部分一致>` | entry 名の部分一致 (大小無視、 一意なら採用) | `name:qwen3` |

解決順序は **slot → id → name**。 slot 名と entry 名が衝突した場合は slot が勝つ
(役割名の方が意図として強いため)。

### 3.2 API

```ts
export interface ResolvedModel {
  /** 実行に使う provider (キャッシュ済み) */
  provider: LLMProvider;
  /** provider に渡すモデル名 */
  model: string;
  /** 接続情報一式 (contextWindow / サンプリング値の参照元) */
  endpoint: LLMEndpoint;
  /** 由来の registry entry id */
  entryId: string;
  /** 解決に使われた slot 名 (id:/name: 直指定なら undefined) */
  slot?: string;
  /** 表示用ラベル (entry.name) */
  label: string;
}

/** ref を解決する。解決できなければ undefined */
export function resolveModelRef(ref: string): ResolvedModel | undefined;

/** ref 未指定時だけ main を既定として解決する。明示refの失敗は undefined */
export function resolveModelRefOrMain(ref: string | undefined): ResolvedModel | undefined;

/**
 * 指名対象になり得る slot の一覧 (プロンプト注入・`task` の description 生成用)。
 * provider は生成しない (表示専用。 毎ターン全 slot の provider を作らないため)。
 * **予約 slot (main / second / vision) は含めない** — 理由は §9 参照。
 */
export function listResolvableSlots(): Array<{ slot: string; label: string; description?: string }>;

/** 復号用の合言葉を登録する (起動時に index.ts が 1 回だけ呼ぶ) */
export function setResolverPassphrase(passphrase: string | undefined): void;

/** entry が編集された / slot が付け替えられた時に provider キャッシュを捨てる */
export function invalidateModelCache(entryId?: string): void;
```

### 3.3 provider キャッシュ

`Map<entryId, { signature: string; provider: LLMProvider; model: string }>`。

- キーは entry id、 値に **その時点の `endpointSignature(endpoint)` を保持**する
- 取得時に現在の signature と突き合わせ、 **違っていたら作り直す**
  → これが不具合 B3 (設定変更が再起動まで反映されない) の構造的な予防になる
- `invalidateModelCache(entryId)` で明示破棄も可能

キャッシュする理由: `task` ツールが呼ばれるたびに provider を新規生成すると、
HTTP エージェントの接続プールが毎回捨てられ、 クラウド系で目に見えて遅くなるため。

### 3.4 合言葉 (passphrase) の扱い

暗号化された `apiKey` を持つ entry を解決するには合言葉が要る。
起動時に `index.ts` が取得済みの `sharedPassphrase` を `setResolverPassphrase()` で
resolver に預け、 resolver が `createProvider(endpoint, passphrase)` に渡す。

合言葉が無い状態で暗号化 entry を解決しようとした場合は **undefined を返し、
理由をログに残す** (対話プロンプトは出さない。 ツール実行中に合言葉を聞くと
描画が壊れるため — 不具合 B1/B2 と同根)。 user には
`/models` から明示的に切り替えてもらう。

---

## 4. サブエージェントへのモデル束縛

### 4.1 frontmatter フィールド

`src/agents/builtin/*.md` の frontmatter に **optional** で追加する。

```yaml
---
name: code-reviewer
description: コード品質・セキュリティレビュー専任のサブエージェント
tools: [file_read, glob, grep, bash]
model: review        # ← 追加。 ModelRef 文法 (§3.1)
---
```

- `AgentDefinition` に `modelRef?: string` を追加 (frontmatter キーは `model`)
- **未指定なら従来通り** `SubAgentManager` が持つ main provider を使う
- 指定された slot が未割当なら、設定方法を示して **起動を停止**する (mainへ置換しない)

ビルトイン 5 定義には **今回は何も書かない**。 デフォルト挙動を変えないため。
user が `~/.localllm/agents/` 等に置く自前定義で使える口を開ける、 が主目的。

### 4.2 SubAgent / SubAgentManager の変更

`SubAgent` は現状 `provider` と `model` をコンストラクタ引数で受け取っている。
ここに **解決済みの `ResolvedModel` を渡せる経路**を足す。

```ts
// SubAgentManager
private resolveFor(type: SubAgentType, explicitRef?: string): { provider: LLMProvider; model: string } {
  // 優先順位: 呼出時の明示指定 > 定義の modelRef > main (自分の provider)
  const ref = explicitRef ?? getLoader().get(type)?.modelRef;
  const resolved = ref ? resolveModelRef(ref) : undefined;
  if (ref && !resolved) logger.warn(`model ref '${ref}' を解決できません。 main で起動します`);
  return resolved ? { provider: resolved.provider, model: resolved.model } : { provider: this.provider, model: this.model };
}
```

`launchForeground` / `launchBackground` / `launchParallel` / `launchSkillFork` の
全てに optional な `modelRef` を通す。

### 4.3 サブエージェント実行の可視化

サブエージェントが **main 以外のモデルで走る場合のみ**、 起動ログに使用モデルを出す。

```
  [Task] code-reviewer: 認証まわりのレビュー  (model: review → azure-anthropic:claude-sonnet-4-6)
```

main で走る場合は従来通り表示しない (情報量を増やさない)。

---

## 5. `task` ツールの `model` 引数

モデル自身が委任先モデルを選べるようにする。

```jsonc
{
  "subagent_type": "explore",
  "description": "認証フローの調査",
  "prompt": "...",
  "model": "fast"        // ← 追加 (optional)
}
```

### 5.1 ツール定義の動的生成

`model` パラメータの description は **registry の現在の slot 一覧から生成**する。
静的な文字列だと、 user が slot を足しても LLM が知らないままになるため。

```
model: "このタスクを実行するモデル。 省略時はメインLLM。
       利用可能: main (現行モデル) / fast (ollama:qwen3-9b — 軽量・高速。 単純な検索や要約向け) /
       deep (azure-anthropic:claude-opus-4-6 — 難しい設計判断・原因究明向け)"
```

`enum` は使わない。 slot は動的に増減するため、 enum に固定するとツール定義の
キャッシュとズレたときに全 task 呼び出しが弾かれる。 文字列として受け、
解決失敗時はtaskを失敗させ、`/models slot <ref> <モデル>` の設定方法を返す。

### 5.2 未定義 slot を指定されたとき

```text
Error: 指定された model 'deep' を解決できないためサブエージェントを起動しません。
/models slot deep <モデル> で割り当ててください。
```

別モデルの結果を要求したモデルの成果に見せない。未指定時のmain利用は既定動作であり、明示指定失敗時の代替ではない。

---

## 6. システムプロンプトへの注入

モデルが slot の存在を知らなければ指名しようがない。
**registry に 2 件以上の entry があり、 かつ named slot が 1 つ以上ある場合のみ**、
system prompt に短いブロックを足す。

```
## 利用可能なモデル
委任時に model 引数で指名できる。 省略時は現在のモデルで実行される。
- fast: ollama:qwen3-9b — 軽量・高速。 単純な検索や要約向け
- deep: azure-anthropic:claude-opus-4-6 — 難しい設計判断・原因究明向け
```

条件付き注入にする理由: 単一モデル運用の user にとっては完全なノイズであり、
毎ターン数十トークンを恒久的に消費する価値がないため
(`docs/system-prompt-redesign.md` の「再肥大を防ぐ原則」 に従う)。

説明文は `endpoint.description` をそのまま使う。 未設定なら
`<provider>:<model>` だけを出す。

上の例は日本語で書いているが、 **実装ではブロックの枠組み (見出し・案内文) は英語**にする。
`system-prompt.ts` の周辺セクションが英語ベースに統一されているため
(`docs/prompt-language-policy.md`: モデル向けは英語が正本)。 slot の説明文は
`endpoint.description` をそのまま流すので、 user が日本語で書けば日本語で出る。

---

## 7. CLI: `/models slot`

`/models` ピッカーは Phase 2 で実装済み。 そこに slot 操作を足す。

| コマンド | 動作 |
|----------|------|
| `/models slot` | 全 slot の割当状況を一覧表示 |
| `/models slot <name>` | 対話ピッカーで entry を選び `<name>` に割り当て |
| `/models slot <name> <query>` | query (番号 / id 前方一致 / 名前部分一致) で非対話割当 |
| `/models slot clear <name>` | slot を解除 |

予約 slot (`main` / `second` / `vision`) は **一覧には出るが `/models slot` からは変更できない**。
変更は正規経路 (`/models` の Set as main / `/model second setup` / `/model vision setup`) から行う。

表示例:

```
  ── Slots ──
  main     anthropic:claude-sonnet-4-6 @ api.anthropic.com
  second   ollama:qwen3-32b @ 192.168.1.33:11434
  vision   (未割当: main が画像を担当)
  fast     ollama:qwen3-9b @ 192.168.1.33:11434
  deep     azure-anthropic:claude-opus-4-6

  /models slot <name> <モデル> で割当 / /models slot clear <name> で解除
```

`main` / `second` / `vision` を `<name>` に指定した場合は
「その slot は `/models` の Set as main / `/model second setup` / `/model vision setup`
から設定してください」 と誘導して終わる (§2.1)。

### 7.1 slot 名のバリデーション

`/^[a-z][a-z0-9-]{1,19}$/`。 弾く理由を添えてエラーにする。
大文字・日本語を許すと `task` ツール引数での取り違えが増えるため。

---

## 8. 変更ファイル一覧

| ファイル | 変更内容 |
|----------|----------|
| `src/config/model-resolver.ts` | **新規**。 §3 の解決層 + provider キャッシュ |
| `src/config/model-registry.ts` | `listNamedSlots()` / `resolveEntryQuery()` を追加 |
| `src/agents/agent-loader.ts` | `AgentDefinition.modelRef` (frontmatter `model:`) を読む |
| `src/agent/sub-agent.ts` | `SubAgentManager` に modelRef 解決を追加。 launch* 系に optional 引数 |
| `src/tools/definitions/task.ts` | `model` パラメータ追加 + 動的 description + フォールバック注記 |
| `src/agent/system-prompt.ts` | 条件付きで「利用可能なモデル」 ブロックを注入 |
| `src/cli/repl.ts` | `/models slot` サブコマンドを dispatch |
| `src/index.ts` | `setResolverPassphrase()` の呼び出し |
| `src/cli/completer.ts` | `/models slot` の補完候補 |
| `tests/` | model-resolver の単体テスト (ref 解決 / キャッシュ無効化 / フォールバック) |

---

## 9. 後方互換性

| 観点 | 影響 |
|------|------|
| 既存 config / registry ファイル | **変更なし**。 `slots.named` は既存の optional フィールド |
| ビルトインサブエージェント定義 | `model:` を書かないので挙動不変 |
| `task` ツール | `model` は optional。 未指定時は完全に従来通り |
| system prompt | named slot が 0 個なら注入されない = 既定では変化なし |
| `/second` / `/swap` / `/model vision` | 変更なし |

つまり **user が自由 named slot を 1 つも作らなければ、 挙動は一切変わらない**。

「自由」 と断っているのは、 予約 named slot である `vision` が `slots.named` に同居しているため。
`listResolvableSlots()` が `vision` を含めてしまうと、 vision を設定済みの user だけ
system prompt にブロックが生え `task` に `model` パラメータが生えてしまう。
そのため resolver は予約 slot を列挙対象から除外する (§3.2)。

`task` ツールの `model` パラメータも、 自由 named slot が 0 個なら
**プロパティ自体を出さない**。 単一モデル運用でのノイズを避けるため。

---

## 10. リスク

| リスク | 対策 |
|--------|------|
| 別モデルのサブエージェントが暗号化キーを解決できず落ちる | resolve 失敗は main フォールバック + 明示注記。 起動は止めない |
| provider キャッシュが古い接続を掴み続ける | signature 比較で自動再生成 (§3.3)。 B3 対策と同一機構 |
| LLM が存在しない slot 名を捏造して指名する | 解決失敗 → main 実行 + `modelNote` で LLM に事実を返す (学習させる) |
| slot が増えて system prompt が膨らむ | named slot のみ列挙。 5 件を超えたら lastUsedAt 上位 5 件に絞る |
| 別モデルのサブエージェント実行がコスト集計に載らない | **既知の欠落**。 `globalTokenTracker.record()` を呼ぶのは `agent-loop.ts` / `second-llm-manager.ts` / `image-service.ts` の 3 箇所のみで、 `sub-agent.ts` は元々トークンを記録していない。 Phase 6 で悪化はしないが、 別モデル委任が増えると無視できなくなる。 sub-agent の usage 記録追加は後続フェーズの課題とする |

---

## 11. 将来の拡張余地

- **自動選択**: `task-complexity.ts` の判定と slot の `tags` を突き合わせ、
  model 未指定時に自動で `fast` / `deep` を選ぶ。 明示指名が安定してから
- **slot ごとのサンプリング上書き**: 現状は entry の値をそのまま使う
- **フォールバックチェーン**: `deep` が 429 のとき `main` に自動退避
- **`second_llm_agent` の slot 一般化**: `second` 固定をやめ、 任意 slot を指定可能に
  (今回は `task` 側だけ通す。 second 系は互換維持を優先)
