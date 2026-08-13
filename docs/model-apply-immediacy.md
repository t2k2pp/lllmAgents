# モデル設定の即時反映と設定ズレの可視化 (不具合 3)

> **ステータス**: 2026-08-14 設計 / 実装
> **関連**: `docs/model-registry.md` / `docs/model-orchestration.md` / `docs/azure-gpt-provider.md`

---

## 1. 症状

> Azure などのモデルを設定したときに、 再起動しないと変更が適用されない。
> またそのまま古いモデルのまま使い続けられるので、 間違いに気づきづらい。

**2 つの独立した問題**が重なっている。

| # | 問題 | 性質 |
|---|------|------|
| A | 設定しても反映されない | 機能の欠落 |
| B | 反映されていないことに気づけない | **可視性の欠落。 こちらの方が危険** |

B が本質的に悪い。 反映されないだけなら「あれ、 効いてないな」 で済むが、
**古いモデルで動き続けていることに気づかないまま作業が進む**と、
「なぜか品質が上がらない」 「課金先が想定と違う」 といった形で後から効いてくる。

---

## 2. 原因 A: 暗号化保存を選ぶと意図的に反映をスキップしている

`src/cli/repl.ts` の Azure / Claude / Gemini セットアップ 3 箇所に同じ構造がある。

```ts
const passphrase = await password({ message: "暗号化用パスフレーズ:" });
// ... 確認入力・長さ検証 ...
storedApiKey = CredentialVault.encrypt(apiKey.trim(), passphrase);
needsRestart = true;   // ← 暗号化済みは初回起動時に合言葉を聞くため再起動が必要

// ... 後略 ...
if (needsRestart) {
  console.log("⚠ 暗号化保存のため、 反映にはアプリの再起動と合言葉入力が必要です。");
} else {
  await this.applyMainLLMEndpoint();   // ← ここに来ない
}
```

**合言葉はすぐ上のスコープに存在している**。 それを捨てて「再起動してください」
と言っている。 復号に必要なものが手元にあるのに、 わざわざ再起動を要求している状態。

「初回起動時に合言葉を聞くため」 という理由づけは、 起動時フローの都合を
設定変更フローに持ち込んだもので、 根拠として成立していない。

### 2.1 修正

入力された合言葉を **セッションの合言葉としてそのまま採用**する。

```ts
storedApiKey = CredentialVault.encrypt(apiKey.trim(), passphrase);
this.passphrase = passphrase;   // 以降 ensurePassphraseFor() が再入力を求めない
```

`ensurePassphraseFor()` は「既存の `this.passphrase` で復号できれば再利用」 と
いう実装なので、 これだけで既存の反映経路 (`applyMainLLMEndpoint()`) が通る。
`needsRestart` は 3 箇所とも撤去する。

### 2.2 それでも反映できない場合の扱い

provider 生成や接続テストが失敗することはあり得る。 そのときも
**「再起動してください」 で終わらせない**。

```
  ⚠ 設定は保存しましたが、 実行中への反映に失敗しました。
     理由: 接続テストに失敗 (401 Unauthorized)
     いま動いているのは以前の設定 (azure-anthropic:claude-sonnet-4-5) のままです。
     /model apply で再試行できます。
```

**「いま動いているのは何か」 を必ず併記する**。 これが §3 につながる。

---

## 3. 原因 B: 「設定値」 と「実際に動いているもの」 を誰も比べていない

`config.mainLLM` は **設定ファイルの値**であり、
`AgentLoop` が握っている provider は **起動時 (または最後に成功した反映時) の値**である。
この 2 つがズレても、 現状はどこにも現れない。

`/model` の表示は `config.mainLLM` を読んでいるだけなので、
**反映に失敗していても「新しい設定」 が表示される**。 これが
「間違いに気づきづらい」 の直接の原因である。 画面は嘘をついている。

### 3.1 実行中バインディングを記録する

provider を生成した時点の endpoint signature を保持する。

```ts
// src/agent/agent-loop.ts
private liveBinding: LiveModelBinding | null;

interface LiveModelBinding {
  signature: string;
  model: string;
  providerType: string;
  /** 表示用ラベル。 generateEntryName(endpoint) をここで固めておく */
  label: string;
}

setProvider(provider: LLMProvider, model: string, endpoint?: LLMEndpoint): void {
  // ... 既存処理 ...
  if (endpoint) this.liveBinding = makeLiveBinding(endpoint, model);
}

getLiveBinding(): LiveModelBinding | null
```

`label` を記録時に固めておくのは、 §2.2 / §3.3 の表示が
`azure-anthropic:claude-sonnet-4-5 @ my-resource.azure.com` のような
ホスト付きラベルを前提にしているため。 signature だけ持っていても
「いま動いているのは何か」 を人間に見せられない。

signature は `model-registry.ts` の `endpointSignature()` を再利用する
(接続情報のみで、 サンプリング値や description は含まない = 反映が要るものだけ拾う)。

### 3.2 ズレの検出

```ts
function detectModelDrift(config, agent): Drift | null {
  const want = endpointSignature(config.mainLLM);
  const live = agent.getLiveBinding()?.signature;
  if (!live || want === live) return null;
  return { want, live, wantLabel, liveLabel };
}
```

### 3.3 どこで見せるか

**1 箇所だけでは足りない**。 気づかせるのが目的なので、 目に入る場所すべてに出す。

| 場所 | 出し方 |
|------|--------|
| ユーザー入力を受け付ける直前 | ズレがある間、 **毎ターン** 1 行の警告を出す |
| `/model` (ステータス表示) | 「設定値」 と「実行中」 を **2 行に分けて**表示し、 違えば赤で強調 |
| `/status` | 同上 |
| `/doctor` | 診断項目として追加。 NG なら対処コマンドを提示 |

毎ターン出すのはうるさいが、 **うるさくないと気づかない**のがこの不具合である。
ズレを解消すれば消えるので、 恒常的なノイズにはならない。
ただしマルチライン入力中 (```` ``` ```` ブロック) は抑制する。
各行で再表示されると入力そのものが読めなくなるため。

#### 対象は main slot のみ (今回の範囲)

second / vision も `applySecondLLMEndpoint()` / `applyVisionLLMEndpoint()` で
同じ構造の反映を持つので原理的にはズレ得る。 ただし
**不具合として報告されたのは main であり、 かつ「毎ターン警告」 を 3 スロット分
出すとノイズが実害になる**ため、 今回は main に絞る。
second / vision に広げる場合は「毎ターン警告」 ではなく
`/model` / `/doctor` での表示に留めるのが妥当。

表示例 (`/model`):

```
  メインLLM (設定):   azure-anthropic:claude-opus-4-6 @ my-resource.azure.com
  メインLLM (実行中): azure-anthropic:claude-sonnet-4-5 @ my-resource.azure.com   ← 一致していません
                      /model apply で設定値を反映できます
```

### 3.4 `/model apply`

ズレを直す 1 コマンドを用意する。 `applyMainLLMEndpoint()` を明示的に呼ぶだけ。
警告文から辿れる操作が無いと、 ユーザーは結局アプリを再起動する。

---

## 4. F1 (model-resolver) との整合

`docs/model-orchestration.md` §3.3 の provider キャッシュは
「entry の signature が変わったら作り直す」 設計なので、 **原理的にはズレない**。
ただし以下は明示的に無効化する。

- `applyMainLLMEndpoint()` / `applySecondLLMEndpoint()` / `applyVisionLLMEndpoint()`
  の末尾で `invalidateModelCache()` を呼ぶ
- 合言葉が更新されたら `setResolverPassphrase()` を呼び直す
  (`setResolverPassphrase` は内部でキャッシュを捨てる)

暗号化 apiKey の entry は、 合言葉が無い間 resolver が解決を拒否する仕様
(§3.4 of model-orchestration.md) なので、 §2.1 で `this.passphrase` を
確保したタイミングで resolver にも渡さないと、 named slot が使えないままになる。

---

## 5. 変更ファイル一覧

| ファイル | 変更 |
|----------|------|
| `src/cli/repl.ts` | `needsRestart` 撤去 (3 箇所)、 合言葉の採用、 `/model apply`、 `/model` 表示の 2 行化、 毎ターンのズレ警告 |
| `src/agent/agent-loop.ts` | `liveBinding` の記録と `getLiveBinding()` / `setLiveBinding()`、 `setProvider()` に endpoint 引数を追加 |
| `src/agent/model-drift.ts` | **新規**。 ズレ検出とメッセージ整形 (repl から切り出して単体テスト可能にする) |
| `src/index.ts` | 起動直後に `agent.setLiveBinding(config.mainLLM)`。 これが無いと起動時設定との比較材料が無く、 検出が丸ごと効かない |
| `src/cli/commands/doctor.ts` | 診断項目「モデル設定の反映状態」 を追加 |
| `src/cli/completer.ts` / `src/cli/renderer.ts` | `/model apply` を補完候補と `/help` に追加 |
| `tests/agent/model-drift.test.ts` | **新規** |

---

## 6. リスク

| リスク | 対策 |
|--------|------|
| 合言葉をメモリに保持することへの懸念 | 起動時フローも既に `sharedPassphrase` を保持しており、 新しいリスクではない。 ディスクには書かない |
| 毎ターンの警告がうるさい | ズレている間だけ。 解消すれば消える。 `/model apply` への導線を必ず添える |
| `liveBinding` が未設定の経路が残ると誤検出する | `liveBinding` が null のときは **ズレなしとみなす** (安全側)。 検出漏れの方が誤警告よりましである |
| 3 箇所の `needsRestart` 撤去で暗号化キーの復号に失敗する経路が出る | 反映は try/catch で包み、 失敗しても設定保存は済んでいる状態を保つ。 失敗時は §2.2 の文言を出す |
