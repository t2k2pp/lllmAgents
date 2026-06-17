# 画像生成機能 設計書

機能トグルで ON/OFF 可能な画像生成機能。クラウド (Azure OpenAI GPT Images) と
ローカル (Stable Diffusion WebUI / ComfyUI) のバックエンドを抽象化し、
`image_generate` ツール（LLM からの自然文依頼）と `/image gen`（REPL ダイレクト実行）の
両方から利用できる。コストは `/cost` の既存集計に統合する。

作成: 2026-06-10

## 1. 要件

| # | 要件 | 方針 |
|---|---|---|
| R1 | 機能の ON/OFF | `config.imageGen.enabled` + REPL `/image on\|off`。OFF 時はツール非登録（browser ゲートと同型） |
| R2 | バックエンド3種 | Azure GPT Images (gpt-image-2 等) / SD WebUI (A1111) / ComfyUI |
| R3 | エージェントが文章依頼で生成 | `image_generate` ツール。ゲーム素材・スライド・HP 用途で有効時に自律活用 |
| R4 | コマンドでダイレクト呼出 | `/image gen <prompt>` |
| R5 | /cost で価格確認 | `TokenUsageRecord` に `slot:"image"` で統合。画像単価テーブル |
| R6 | 対象外 | AWS / OpenAI 直など Azure 以外のクラウド（将来 providerType 追加で対応） |

ユーザー決定事項 (2026-06-10):
- v1 は **txt2img のみ**（img2img / 編集系は §9 将来拡張）
- バックエンド3種を **v1 で全部実装**（ComfyUI はテンプレートワークフロー方式）
- 複数プロファイル登録 + **アクティブ1つを切替**（model-registry の slot 方式と同型思想）
- コストは **TokenUsageRecord に統合**（トークン 0・estimatedCostUsd に画像料金を計上）

## 2. 設計思想

- **既存パターンの踏襲を最優先**。新しい仕組みを発明しない:
  - ON/OFF ゲート = browser 機能 (`FeaturesConfig` / 起動時登録スキップ) と同型。
    ただし browser と違い環境プローブ不要なので `features` ではなく `imageGen.enabled` を直接見る
  - プロファイル登録 + アクティブ切替 = model-registry (`entries` + `slots`) の縮小版
  - Azure 認証・endpoint 正規化 = `azure-gpt` プロバイダと同じ
    （`api-key` ヘッダ、`normalizeEndpoint` で `protocol://host` に正規化、apiKey は `env:`/`encrypted:`/平文）
  - コスト記録 = `globalTokenTracker.record()` に相乗り。集計・期間・export は既存のまま動く
- **LLM プロバイダ (`src/providers/`) とは別系統** (`src/image/`)。
  チャット用 `LLMProvider` インターフェース（stream/chat）とは形が違いすぎるため混ぜない
- **ローカルバックエンドはコスト 0**。/cost には枚数だけ記録される

## 3. 設定 (config.json)

```jsonc
{
  "imageGen": {
    "enabled": true,
    "active": "azure-main",          // アクティブな profile の name
    "profiles": [
      {
        "name": "azure-main",
        "providerType": "azure-image",
        "endpoint": "https://my-resource.openai.azure.com",
        "apiKey": "env:AZURE_IMAGE_KEY",     // env: / encrypted: / 平文 (CredentialVault 互換)
        "model": "gpt-image-2",              // deployment 名
        "defaultSize": "1024x1024",
        "defaultQuality": "medium"
      },
      {
        "name": "local-sd",
        "providerType": "sd-webui",
        "baseUrl": "http://localhost:7860",
        "defaultSize": "1024x1024",
        "steps": 28,
        "negativePrompt": "lowres, bad anatomy"
      },
      {
        "name": "local-comfy",
        "providerType": "comfyui",
        "baseUrl": "http://localhost:8188",
        "checkpoint": "sd_xl_base_1.0.safetensors",
        "workflowTemplate": null             // null = 組み込み txt2img テンプレート
      }
    ]
  }
}
```

型定義 (`src/config/types.ts`):

```ts
export type ImageProviderType = "azure-image" | "sd-webui" | "comfyui";

export interface ImageGenProfile {
  name: string;                  // 一意な表示名 (= /image use の引数)
  providerType: ImageProviderType;
  // azure-image
  endpoint?: string;             // リソース base URL (normalizeEndpoint 適用)
  apiKey?: string;               // env:VAR / encrypted:... / 平文
  model?: string;                // deployment 名 (例: gpt-image-2)
  // sd-webui / comfyui
  baseUrl?: string;              // 例: http://localhost:7860 / :8188
  // comfyui
  workflowTemplate?: string | null; // テンプレート JSON 絶対パス。未指定で組み込み
  checkpoint?: string;           // 組み込みテンプレートの CheckpointLoader に注入
  // 共通既定値 (ツールパラメータ未指定時に使用)
  defaultSize?: string;          // "WxH"。既定 "1024x1024"
  defaultQuality?: "low" | "medium" | "high"; // azure のみ。既定 "medium"
  negativePrompt?: string;       // sd-webui / comfyui
  steps?: number;                // sd-webui / comfyui。既定 25
}

export interface ImageGenConfig {
  enabled: boolean;
  active?: string;
  profiles: ImageGenProfile[];
}

// Config に追加
imageGen?: ImageGenConfig;
```

`defaultQuality` の既定を `medium` にするのは意図的（API 既定は `high` だが
1024×1024 で $0.21/枚と高額。エージェントが量産する用途では medium が妥当）。

## 4. プロバイダ層 (`src/image/`)

```
src/image/
├── image-provider.ts    // インターフェース + 共通型
├── azure-image.ts       // Azure OpenAI images/generations
├── sd-webui.ts          // A1111 /sdapi/v1/txt2img
├── comfyui.ts           // /prompt + /history ポーリング + /view
├── comfyui-default-workflow.ts  // 組み込み txt2img ワークフローテンプレート
├── image-service.ts     // アクティブ profile 管理・生成実行・保存・コスト記録
└── image-provider-factory.ts    // profile → ImageProvider
```

### 4.1 インターフェース

```ts
export interface ImageGenRequest {
  prompt: string;
  size?: string;            // "WxH"
  quality?: "low" | "medium" | "high";  // azure のみ意味を持つ
  n?: number;               // 生成枚数 (既定 1)
  negativePrompt?: string;  // sd 系のみ
  seed?: number;            // sd 系のみ
}

export interface ImageGenResult {
  images: Buffer[];         // PNG バイナリ
  model: string;            // コスト記録用 (例: "gpt-image-2" / "sd-webui" / "comfyui")
  costUsd: number;          // ローカルは 0
  warnings?: string[];
}

export interface ImageProvider {
  readonly providerType: ImageProviderType;
  generate(req: ImageGenRequest): Promise<ImageGenResult>;
}
```

### 4.2 azure-image

- `POST {endpoint}/openai/v1/images/generations?api-version=preview`
  - Header: `api-key: <KEY>`, `Content-Type: application/json`
  - Body: `{ model, prompt, size, quality, n, output_format: "png" }`
  - `model` = deployment 名（v1 系 API は body の model でルーティング。deploymentName 不要 — azure-gpt と同じ）
- 応答: `{ data: [{ b64_json }], usage? }` → Buffer 化
- `normalizeEndpoint()`: 他 Azure プロバイダと同一仕様（protocol+host のみに正規化）
- apiKey 解決: `CredentialVault.resolveApiKey`（env:/encrypted:/平文）。
  暗号化キーの復号合言葉は main LLM と共有の `sharedPassphrase` を使う
- 2026-06 時点の対応モデル: `gpt-image-1` 系 / `gpt-image-2`（DALL-E 3 は 2026-03 退役済み）
- gpt-image-2 のサイズ制約: 両辺 16px 倍数、長辺 ≤3840px、アスペクト比 ≤3:1。
  バリデーションはサーバーに任せ、エラーメッセージをそのまま LLM に返す（対症療法を埋め込まない）

### 4.3 sd-webui (AUTOMATIC1111)

- `POST {baseUrl}/sdapi/v1/txt2img`
  - Body: `{ prompt, negative_prompt, width, height, steps, batch_size: n, seed }`
- 応答: `{ images: ["<base64>", ...] }` → Buffer 化
- 認証なし前提（ローカル想定）。コスト 0

### 4.4 comfyui

- `POST {baseUrl}/prompt` に workflow JSON（API format）を投入 → `{ prompt_id }`
- `GET {baseUrl}/history/{prompt_id}` を 1 秒間隔でポーリング（タイムアウト 300 秒）
- 完了後 `outputs` 内の `images[]` を `GET {baseUrl}/view?filename=...&subfolder=...&type=...` で取得
- **テンプレートワークフロー方式**:
  - 組み込み既定テンプレート（`comfyui-default-workflow.ts`）: CheckpointLoaderSimple →
    CLIPTextEncode(+/−) → KSampler → VAEDecode → SaveImage の標準 txt2img
  - プレースホルダ `{{PROMPT}}` `{{NEGATIVE}}` `{{WIDTH}}` `{{HEIGHT}}` `{{SEED}}` `{{STEPS}}`
    `{{CHECKPOINT}}` `{{BATCH_SIZE}}` を文字列置換（JSON 文字列化後に置換せず、
    テンプレート文字列の段階で置換してから `JSON.parse` する。プロンプト中の引用符は JSON エスケープ）
  - `workflowTemplate` に絶対パスを指定するとユーザー独自ワークフローに差し替え可能。
    その場合もプレースホルダ規約は同じ（ユーザーが任意のノードに `{{PROMPT}}` を置く）
- コスト 0

### 4.5 image-service

- 役割: アクティブ profile の解決、provider 生成（factory）、生成実行、
  ファイル保存、コスト記録（§6）、REPL からの profile 切替反映
- 保存: 呼び出し側から渡された**絶対パス**に書き込む（アプリ内ルール: 相対パス禁止）。
  複数枚時は `name.png, name-2.png, ...` と連番
- profile 切替/ON/OFF は `saveConfig` で即永続化（autorunMode 等と同じ）

## 5. `image_generate` ツール

`src/tools/definitions/image-generate.ts`

```jsonc
{
  "name": "image_generate",
  "description": "Generate images from a text prompt using the configured image backend
                  (Azure GPT Images / Stable Diffusion). Write prompts in English for
                  best results. Saves PNG files to output_path.",
  "parameters": {
    "prompt":         { "type": "string",  "required": true },   // 英語推奨
    "output_path":    { "type": "string",  "required": true },   // 保存先 PNG の絶対パス
    "size":           { "type": "string" },                      // 例 "1024x1024"。省略時 profile 既定
    "quality":        { "enum": ["low", "medium", "high"] },     // Azure のみ。省略時 profile 既定
    "n":              { "type": "number" },                      // 1〜4 (暴走コスト防止で上限 4)
    "negative_prompt": { "type": "string" }                      // SD 系のみ
  }
}
```

- 登録: `src/index.ts` で `config.imageGen?.enabled && active profile が存在` のときのみ登録
  （browser ゲートと同型。無効時はツール自体が見えない＝エージェントが無駄試行しない）
- REPL `/image on|off` の動的切替は `toolRegistry.register / unregister` で即反映
  （MCP の即時 disable と同じ機構）
- 出力: 保存ファイルパス一覧 + バックエンド/モデル + 推定コスト。
  LLM がそのまま HTML/PPTX 等へ組み込めるようパスを明示
- 失敗時: API エラー本文をそのまま返す（silent 欠損禁止ルール）
- セキュリティ: `output_path` は `PermissionManager` の書込確認対象
  （file_write と同等の扱い。autoApproveTools に `image_generate` を追加すれば自動許可）

## 6. コスト統合

### 6.1 記録

- `UsageSlot` に `"image"` を追加（`"main" | "second" | "vision" | "image"`）
- `TokenUsageRecord` に `imageCount?: number` を追加（後方互換: 既存レコードは undefined）
- 生成成功ごとに:

```ts
globalTokenTracker.record({
  timestamp, provider: profile.providerType, model: result.model,
  slot: "image", inputTokens: 0, outputTokens: 0, cachedTokens: 0,
  estimatedCostUsd: result.costUsd, imageCount: n, sessionId,
});
```

- 既存の `/cost` 集計・期間フィルタ・export は変更なしでそのまま画像分を合算する

### 6.2 画像単価テーブル (`src/cost/image-pricing.ts`)

トークン単価 (pricing-table.ts) とは別軸（枚数×品質×サイズ）なので別ファイル。

```ts
// USD / 枚。 1024x1024 基準。 他サイズはピクセル数比でスケール。
export const BUILTIN_IMAGE_PRICING: Record<string, Record<Quality, number>> = {
  "gpt-image-2": { low: 0.006, medium: 0.053, high: 0.211 },  // 2026-05 Azure GA 時点
  "gpt-image-1": { low: 0.011, medium: 0.042, high: 0.167 },
  "gpt-image-1-mini": { low: 0.005, medium: 0.011, high: 0.036 },
};
```

- `~/.localllm/image-pricing.json` で上書き可（pricing.json と同じ流儀）
- サイズスケール: `cost = base[quality] × (W×H) / (1024×1024)`（近似。
  正確な請求はトークンベースだが、概算把握という /cost の目的には十分。
  単価未登録モデルは cost=0 + ⚠ 表示で顕在化させる — silent 欠損禁止）
- ローカル (sd-webui / comfyui): 常に $0。テーブル参照しない

### 6.3 表示 (`/cost`)

- `formatSummary`: 画像レコードがあれば `画像生成: N枚 $X.XX` の行を追加
- `formatProviders` の slot 別表: `"main / second / vision"` → `"main / second / vision / image"` に注記更新
- `usage-store.aggregate`: `slot === "image"` のレコードは unpricedModels 警告の対象外にする
  （トークン単価テーブルに無いのが正常のため。画像単価の未登録は記録時に warning を出す）

## 7. REPL `/image` コマンド

新コマンド4箇所チェックリスト対象: repl.ts 実装 / completer.ts / displayHelp / README.md

| サブコマンド | 動作 |
|---|---|
| `/image` | 状態表示（enabled / active / profiles 一覧 / ツール登録状態） |
| `/image on` / `off` | 機能トグル + ツール即時 register/unregister + saveConfig |
| `/image setup [azure\|sd-webui\|comfyui]` | 対話ウィザードで profile 追加（/model setup と同じ inquirer 流儀、Azure は endpoint 正規化 + apiKey 保護入力）。**引数なしで実行するとバックエンド候補メニューから選択**（2026-06-17 — 引数必須でプロバイダー名を知らないと辿り着けない問題を解消）。プロバイダー名の直接指定はメニューを飛ばすショートカット |
| `/image set` | アクティブ profile の既定 `defaultQuality` / `defaultSize` のみを対話選択で更新（**API Key は再入力しない**）。①品質を先に選び（Azure のみ。low/medium/high）→ ②解像度を選ぶ（正方形 1024x1024 / 横長 1536x1024 / 縦長 1024x1536 / カスタム WxH） |
| `/image use <name>` | アクティブ profile 切替 + saveConfig |
| `/image list` | profiles 一覧（active マーク付き） |
| `/image remove <name>` | profile 削除（active だった場合は active クリア） |
| `/image gen <prompt>` | ダイレクト生成。保存先は `<cwd>/generated-images/img-<timestamp>.png`（絶対パス化して保存）。サイズ等は profile 既定値 |
| `/image test` | アクティブバックエンドへ疎通確認（Azure: 設定検証のみ＝課金回避 / SD系: API ping） |

## 8. 起動フロー統合 (`src/index.ts`)

1. config ロード後、`config.imageGen?.enabled` かつ active profile があれば
   `ImageService` を生成し `image_generate` を登録
2. apiKey が `encrypted:` の場合は mainLLM と同じ `sharedPassphrase` で復号
   （追加の合言葉プロンプトは出さない）
3. 無効時は browser 同様に dim 表示 1 行（`ℹ 画像生成機能は無効: /image setup で設定`）。
   ただし `imageGen` が undefined（未設定）の場合は何も表示しない（初心者ノイズ回避）

## 9. 将来拡張（v1 対象外）

- **img2img / 画像編集**: Azure `images/edits`（入力画像 <50MB, PNG/JPG）、SD WebUI `/sdapi/v1/img2img`。
  ツールは `image_edit` を別ツールとして追加する（image_generate のパラメータ肥大を避ける）
- **他クラウド**: OpenAI 直 / AWS Bedrock 等は `ImageProviderType` 追加で対応（現時点で対象外）
- **ストリーミング部分画像**: gpt-image 系の `stream: true` + `partial_images`。CLI 表示価値が薄いため見送り
- **named slot 統合**: 将来 model-registry の named slot (`image`) に統合する可能性。
  v1 は LLM endpoint と型が違いすぎるため独立 config とする

## 10. テスト

- `tests/` 配下のユニットテスト: ComfyUI テンプレート置換（引用符エスケープ含む）、
  画像単価計算（サイズスケール・未登録モデル）、profile CRUD
- 結合: `npm run start` パイプモードで `/image` 系コマンドの状態遷移確認
- 実生成の確認はユーザー環境（Azure キー / ローカル SD）依存のため手動。
  成果物は `sandbox/` 配下に出力する
