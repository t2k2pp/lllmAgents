# メインのモデルが画像を自分で見る (in-context vision) 設計書

> **ステータス**: implemented (2026-11-09。 自動テストは通過。 実機 (Gufo + Blender) の通しの確認は未)
> **作成日**: 2026-11-09
> **関連**: [prompt-prefix-stability.md](prompt-prefix-stability.md) (前方一致を壊さない)、 [context-reduction-redesign.md](context-reduction-redesign.md) (整理イベント)、
> [ephemeral-context-design.md](ephemeral-context-design.md) (揮発メッセージ)、 [llm-logging.md](llm-logging.md)、 [blender-mcp-integration.md](blender-mcp-integration.md)、 [config-reference.md](config-reference.md)

---

## 1. 背景 (2026-11-08〜09 の狼の作業)

メインのモデル (Gufo の「Qwen3.8 Flash Next」。 `visionLLM` は未設定) が Blender MCP で狼を作ったとき、自分の描画した絵を一度も見なかった。

- `vision_analyze` (`src/tools/definitions/vision.ts`) は画像 1 枚とモデルが書いた問いだけを、会話の文脈を持たない脇の呼び出しに送り、文字だけを返す
- `renderMcpResult` (`src/mcp/mcp-content.ts`) は MCP の画像を一時ファイルにし、「vision_analyze を使え」という文に変えていた
- `ToolResult.output` は文字だけなので、ツール結果が画像を会話に運ぶ手段が無かった

結果、狼の目はあごの高さに付いたままだった。 モデルの問いは「何の動物か」だけで、文脈の無い視覚モデルは「狼」と答え、誤りに誰も気付かなかった。
目を置くコードは猫の作業 (光線で頭の表面を探し、猫用に決め打ちしたずらしの値で置く) から写したもので、エラー無しに違う所へ置いた。

Gufo のサーバーで直接確かめたこと (2026-11-09):
- `/v1/models` が「Qwen3.8 Flash Next」に `architecture.input_modalities: ["text","image"]` を返す (`GufoProvider.listModels` は既にこれを `supportsVision` にしている)
- 1200×900 の PNG を、ツールループの会話の中に `role:"tool"` の `image_url` パートとしても、ツール結果の後の `role:"user"` メッセージとしても送れる。 増えた prompt は 約 1,300 トークン
- 会話の文脈つきで見せると、モデルはすぐ「目が頭の下から 8 割 (あご) の所にある。 狼として低すぎる」と正しく答えた

そこで、Claude Code の Read が画像を返すのと同じく、**メインのモデル自身が画像を見る**ようにする。

## 2. メインのモデルが画像を見られるかを決める (名前の付いた 3 つのモード)

`ImageInputState` (`src/tools/tool-registry.ts`) = `{ mode: "on" | "off" | "unknown", source: "config" | "provider", detail }`。

- 決め方 (`resolveImageInput`。 `src/agent/image-content.ts`):
  - config の `mainLLM.vision` が `"on"` / `"off"` ならそれ (provider に問わない)
  - `"auto"` (既定) なら `provider.supportsVision(mainModel)` に問う。 Gufo は `/v1/models` の `input_modalities`。 `openai-compat` の基底は常に false (判定しない) なので、その provider で見せたいときは `"on"` を明示する
  - provider が失敗したら **`unknown` (失敗の中身つき)**。 推測で on/off にしない
- いつ決めるか: 起動時に `index.ts` が `agent.refreshImageInput()` を待ち、結果を 1 行出す (`画像 (メインのモデル): 見る (ON) — <モデル>: gufo が画像の入力に対応と報告`。 unknown は黄色)。
  `/model` などで接続先・モデルを替えたとき (`setModel` / `setProvider`) も判定し直し、次の `run()` の頭で判定の終わりを待つ。 判定中は unknown として扱う (前のモデルの判定を使わない)
- 見える所: 起動時の 1 行・`/status` の 1 行・動作ログ `[image-input]`
- **黙った代替をしない** (AGENTS.md「Product failure policy」): off / unknown のとき、画像を返すはずのツールは画像を載せず、そのことを結果の文で名指しする
  - off: 「メインのモデルは画像を見られない設定です (理由)。 画像は会話に載せていません。 vision_analyze を使ってください」
  - unknown: 「判定できませんでした (失敗の中身)。 config.json の mainLLM.vision を "on" か "off" にすると判定を省けます」
  - 状態の無い経路 (サブエージェント・セカンド LLM の道具の実行): 「この実行経路 (サブエージェント等) では画像を会話に載せません」

## 3. ツール結果の画像 (`ToolResult.images`)

```ts
interface ImageAttachment { mimeType: "image/png" | "image/jpeg" | "image/webp"; data: string /* base64 */; label: string }
interface ToolResult { …; images?: ImageAttachment[] }
interface ToolExecutionContext { …; imageInput?: ImageInputState; taskRequest?: string }
```

- 検査は `src/tools/image-attachment.ts`: 形式・空でないこと・1 枚 20 MiB まで (MCP と同じ上限)・base64 の往復一致。 外れたら理由つきで投げる (黙って捨てない)
- `label` はファイルのパス (MCP の画像は保存した一時ファイルのパス)。 会話の見出しと、退役した後の置き換え文 (「file_read で読み直す」) に使う
- `ToolExecutor` が `imageInput` と `taskRequest` を context に入れる。 入れるのはメインの `AgentLoop` だけ

## 4. 会話への載せ方 (`AgentLoop.withToolBatch`)

1 回の応答のツール結果は `withToolBatch` の中で入れ、ハーネスの促しはその応答の結果を全部入れた後に足す決まりがある (結果の途中に挟むと `findToolPairingError` で対が切れる)。 画像も同じ所で扱う:

1. 結果を履歴に入れた直後に `collectToolImages()` が画像を範囲 (scope) に集める (直列・並列の両方の経路)
2. 範囲の終わり (`finally`) で、その応答の結果を全部入れた後に **1 件の画像の運び役** を足す (`addToolImageNote()`)。 その後にほかの促しを足す
3. 運び役 = 揮発の (ephemeral) `role:"user"`。 本文は `ContentPart[]`:
   - 先頭の文字パート: `[ハーネス] 画像の添付: 直前のツール結果が返した画像です。 利用者の発言ではありません。 …` と、画像ごとの `ツール名 — label` の一覧
   - 画像ごとに見出し `[画像 N] <label>` の文字パートと `image_url` (data URL) のパート
   - 1 回に載せるのは `MAX_LIVE_IMAGES` (8) 枚まで。 超えた分は名前を挙げて「載せていません」と書く
4. `role:"user"` の画像パートは全部の provider が既に扱う (openai-compat はそのまま、 azure-anthropic は `normalizeContentToAnthropic`、 azure-gpt は `normalizeUserContent`)。 `role:"tool"` の中に画像を入れる形は provider ごとに対応が違うので使わない
5. 運び役を利用者の依頼として扱わない:
   - 揮発の印 → 依頼の始まりの判定 (`currentRequestMessage`)・引き継ぎ文書の「依頼の原文」 (`isUserWords`)・整理の抜粋 (`reduction-excerpt`)・要約で残す発言 (`reduction-summary`) から外れる
   - 先頭が `[ハーネス` → 進み具合の要約 (`progress-judge`) から外れる
   - `isToolImageNote()` → 委任の意図の判定 (`hasRecentDelegationIntent`)・`/resume` の画面の記録の作り直し (`session-transcript.ts`) から外す
   - 終わった依頼の運び役は、揮発メッセージとして次の整理イベントの前処理で除かれる
6. 判定が途中で替わってツールが画像を返したのに off / unknown なら、載せずに促しで知らせる (守り)

サブエージェント (`sub-agent.ts`) は自分の道具の実行に `imageInput` を渡さない。 道具は §2 の「この実行経路では載せない」文を返す (壊さない。 サブエージェントのモデルは別のことがあり、判定をモデルごとに持つ作りは今回はしない)。

## 5. 推定トークン数

`estimateMessageTokens` (`token-counter.ts`) は画像パートを **1 枚 `IMAGE_TOKEN_ESTIMATE` = 1,500 トークン** で数える (§1 の実測 約 1,300 に余裕を足した値)。
base64 の長さでは数えない (数十万文字 = 数万トークンと誤り、整理の判定が「溢れた」 と誤る)。 文字だけの配列は今までどおりの JSON の長さで数える (`contentForTokenCount`)。

## 6. 古い画像の退役 (文脈の量と前方一致)

送ったメッセージを毎ターン書き換えない ([prompt-prefix-stability.md](prompt-prefix-stability.md))。 画像を外すのは次の 2 つの時だけで、どちらも書き換えの理由を申告する:

1. **整理イベントの前処理** (`applyReductionStages`。 `reduction-stages.ts`): 新しい `KEEP_RECENT_IMAGES` (3) 枚を残し、古い画像パートを置き換え文
   `[画像は文脈から外しました (整理): <label>。 もう一度見る必要があれば file_read でそのファイルを読み直してください]` にする。
   整理イベントは `reduction:<ID>` を申告する。 枚数は `ReductionEventRecord.retiredImages` と整理の通知 (「古い画像 N 枚を文脈から外す」) に出る。
   段階 0〜2 は user の中身に触れない決まりだが、この前処理だけは画像の運び役の画像パートを置き換える (メッセージは残すので並びと対は変わらない)
2. **上限**: 運び役を足した後で生きている画像が `MAX_LIVE_IMAGES` (8) 枚を超えたら、古い画像を `KEEP_RECENT_IMAGES` 枚まで退役させ、
   `history.replaceMessages(next, "image-retire")` で差し替える (`prefix_break` は理由つき = unexpected ではない)。 8 枚を超えた時だけまとめて 3 枚まで減らすので、書き換えは 5 枚に 1 回程度

`tests/agent/prompt-prefix-invariant.test.ts` は緩めていない。

## 7. 文字にする所・ログ・セッション

- 本文を文字にする所は `contentToText()` (`image-content.ts`) を使い、画像を `[画像: <mime> <bytes>B]` にする: 引き継ぎのダイジェスト (`handoff.ts`)・整理 (`reduction-stages.ts`)・意図分類の文脈 (`MessageHistory.getRecentContext` / `getFullText`)・思考の inline 化 (`toSentMessage`)・進み具合の要約 (`progress-judge.ts`)。 `messageText()` (`task-handoff.ts`) と `textOf()` (`reduction-summary.ts`) は元から文字パートだけを読む
- LLM の I/O ログ (`~/.localllm/logs/sessions/*.jsonl`): `sanitizeLogValue` が文字列の中の `data:image/…;base64,…` を `[image <mime> <bytes>B]` に置き換える。 request の差分 (`messages`)・side_call・道具の定義のどれにも base64 は書かれない
- セッション (`~/.localllm/sessions/<id>.json`): `saveSession` が画像パートを置き換え文 (`セッションの保存`) にした写しを書く (メモリ上の履歴は書き換えない)。
  base64 をいつまでも残さないため。 再開すると画像は見えない (置き換え文が file_read で読み直す手を示す)。 再開した並びは保存前と画像の所から違うので、サーバーに残っている前の会話の KV キャッシュはそこから先が使えない (再開時だけの読み直し)
- セッションの再開 (`restoreSession`) は、配列の本文 (画像付きの発言・運び役) を配列のまま戻す (以前は JSON の文字列にしていた)

## 8. 画像を返すツール

| ツール | 見られる (on) | 見られない (off / unknown / 経路に状態なし) |
|:--|:--|:--|
| `file_read` (.png/.jpg/.jpeg/.webp) | 短い文 (パス・バイト数・PNG/JPEG/WebP の先頭から読んだ幅×高さ) + 画像の添付 | 短い文 + §2 の文 (画像を文字として読まない) |
| MCP の image ブロック (`renderMcpResult`) | 検査 → 一時ファイルに保存 → 添付 (label = 保存したパス) | 今までどおり保存したパスと vision_analyze の案内 + §2 の文 |
| `browser_screenshot` / `computer_screenshot` | 添付はしない。 文で「同じパスを file_read で開けば自分で見られる」と案内 | 同じ |

スクリーンショットを直接添付しなかった理由: `computer_screenshot` の画面は信頼できない内容 (指示として扱わない) と明記している道具で、勝手に会話へ載せると見せる量と経路が増える。 モデルが file_read で開くかを決めればよい。

`renderMcpResult` は `{ text, images }` を返すようにし、呼び出し元 (`mcp-manager.ts` の MCP ツールの `execute`) が `ToolResult.images` に入れる。

## 9. vision_analyze

残す。 説明文を「文脈を持たない別の視覚モデルの第二の意見。 メインのモデルが画像を見られるなら、まず file_read で開いて自分で確かめる。 問いは種類当てでなく位置・比率」に変えた。
問いの前に **いまのタスクの依頼の原文** を付ける (`buildVisionPrompt`)。 原文は `ToolExecutionContext.taskRequest` で、 AgentLoop が引き継ぎ文書 (`TaskHandoffTracker.activeDoc().requests`) から、無ければ今の依頼の発言から作る (2,000 文字まで)。 サブエージェントの経路では付かない。

## 10. Blender のスキル (`src/skills/builtin/blender-modeling/`)

- 描画したら PNG を **file_read で開いて自分で見る**。 vision_analyze は見られない設定のときだけ
- 生き物は `render_closeup(..., view="side")` で **頭の横の寄り** を必ず撮る (前からの絵では目の高さの誤りが見えない)
- 目・鼻先・耳の付け根は `landmark_fraction()` (その y の頭の断面の高さの何割か) と `check_range()` で **スクリプトの中で数値を確かめ、範囲の外なら止める**。 置く道具を信じない
- 問いは位置と比率 (目の高さ・目と鼻の間・耳の位置)。 種類当てだけでは できた としない
- 別の動物の置き方のコード (猫の光線と決め打ちのずらし) を写さない
- `references/proportions.md` に犬・狼・猫・馬の頭の目印の範囲を足した
- bkit の新しい関数は Blender (Steam 版) の画面無しで動作を確かめた (球で 0.77 = OK、 あごの高さ 0.12 = 止まる)

## 11. 実装 ToDo (この設計の範囲)

- [x] `ToolResult.images` / `ImageAttachment` / `ImageInputState`・context の `imageInput` / `taskRequest`
- [x] 判定 (`resolveImageInput`)・config `mainLLM.vision`・起動時と `/status` の表示・切替で判定し直す
- [x] `withToolBatch` の後に運び役を 1 件・上限での退役 (`image-retire`)
- [x] 文字にする所の置き換え文・推定トークン数・ログの墨消し・セッションの保存
- [x] 整理の前処理での退役 (新しい 3 枚を残す)
- [x] file_read・MCP の画像・スクリーンショットの案内
- [x] vision_analyze の説明と依頼の原文の前置き
- [x] Blender のスキル (自分で見る・横の寄り・数値の確かめ・写さない)
- [x] テスト (`tests/agent/image-content.test.ts`・`tests/agent/in-context-vision-loop.test.ts`・`tests/agent/session-image-save.test.ts`・`tests/tools/file-read-image.test.ts`・`tests/mcp/mcp-content.test.ts`)
- [ ] 実機: Gufo の Qwen3.8 Flash Next で狼の続きを動かし、 file_read で絵を見て目の高さを直せるかを確かめる (未)
- [ ] サブエージェントでも見せる (モデルごとの判定を持たせる。 今は名指しで載せない)

## 12. 未確認・今後

- `IMAGE_TOKEN_ESTIMATE` は Gufo の 1 回の実測から決めた。 provider ごとに画像のトークン数は違う (Anthropic は大きさ次第)。 実数 (`usage.promptTokens`) が返る呼び出しの後は P の土台がそれに置き換わるので、推定の誤差は次の呼び出しまで
- 20 MiB の画像はトークンの面では大きすぎることがある (サーバーが縮める)。 必要なら縮める作りを足す
