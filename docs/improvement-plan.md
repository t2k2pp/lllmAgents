# lllmAgents 改善計画書

> 作成日: 2026-03-09
> 元レポート: output/issues-report.md
> 対象バージョン: v0.3.x

---

## 優先度マトリクス

| Phase | 対象Issue | 重大度 | 実装難易度 | 優先順位の根拠 |
|-------|----------|--------|-----------|--------------|
| 1 | CFG-01 Discord | High | Low | ユーザー確認要望あり |
| 1 | UX-01 autoApprove | High | Low | 設定1行変更 |
| 1 | WEB-01/02 web_fetch | High | Medium | リサーチ系タスクの実用性 |
| 1 | BROWSER-03 headless | Medium | Low | サーバー環境での動作 |
| 2 | UX-02 Markdown | High | Medium | 視認性の大幅改善 |
| 2 | UX-03 help動的表示 | Medium | Low | スキル発見性 |
| 2 | SKL-02 システムプロンプト | Medium | Low | LLMのスキル自動利用 |
| 2 | BROWSER-02 screenshot | High | Medium | vision連携 |
| 3 | Discord双方向連携 | High | High | Discord Slash Command受信 |
| 4 | SEC-01 権限管理強化 | High | Medium | Claude Code互換ルール実装 |
| 5 | BROWSER-01 a11y tree | High | High | Playwright API置き換え |
| 5 | PERF-01 UXフィードバック | Medium | Medium | 長時間待機の改善 |
| 5 | CTX-01 トークナイザー | Medium | High | Ollama API利用 |

---

## Phase 1: 緊急対応 (今回実装)

### CFG-01: Discord Webhook URL バリデーション + テスト機能

**問題**: config.json の Discord URL が招待URL形式 (`discord.gg/...`) で、通知が届かない。
失敗が静かに無視される。

**設計**:

1. `src/utils/discord.ts`
   - `isValidWebhookUrl(url: string): boolean` 追加
   - 形式: `https://discord.com/api/webhooks/<id>/<token>`
   - `sendDiscordNotification()` の失敗時に `console.warn` でターミナル警告表示

2. `src/cli/repl.ts` の `/discord` コマンド拡張
   - `/discord test` サブコマンド追加 → テストメッセージ送信 → 成功/失敗をターミナル表示
   - `/discord url <URL>` 設定時にバリデーション実行、不正形式は警告 + 保存拒否

**ユーザーへの案内**:
- 正しいWebhook URLは Discord サーバー設定 → 連携サービス → ウェブフック で取得

---

### UX-01: web_search/web_fetch を autoApproveTools に追加

**問題**: 毎回確認プロンプトが出てリサーチ系タスクが使いにくい。

**設計**:
- `src/config/types.ts` の `getDefaultConfig()` の `autoApproveTools` に
  `"web_search"`, `"web_fetch"` を追加
- 既存ユーザーの `config.json` は変更しない（setup時のみデフォルト適用）
- 後方互換性: 既存configには影響しない (mergeではなくユーザーが明示設定)

---

### WEB-01/02: web_fetch HTML品質改善 + 相対URL解決

**問題**:
- `<header>`, `<nav>`, `<footer>` ごと削除でNHK等の内容が欠落 (WEB-01)
- 相対URLがabsoluteに変換されない (WEB-02)

**設計** (`src/tools/definitions/web-fetch.ts`):

1. **相対URL解決** (WEB-02)
   - `<a href="/path">` → `<a href="https://example.com/path">` に変換
   - `new URL(href, baseUrl).href` で解決
   - `<img src>` も同様に解決

2. **header/nav/footer の扱い変更** (WEB-01)
   - `<header>`, `<nav>`, `<footer>` の削除を廃止
   - 代わりに `<script>`, `<style>`, `<noscript>`, SVG, JSON-LD のみ除去
   - 重複リンク形式 `$2 ($1)` → `$2 [→$1]` に変更して見やすく

3. **コンテンツ品質スコア表示**
   - 取得バイト数とHTMLか静的テキストかを出力に含める

---

### BROWSER-03: headless: false → true (設定可能化)

**問題**: GUI環境以外で動作しない。

**設計**:
- `src/browser/playwright-manager.ts`: `headless: false` → `headless: true` に変更
- 設定ファイルの `browser.headless` フラグで上書き可能にする (Phase 2以降)
- 今回は単純に `true` に変更するのみ

---

## Phase 2: UX改善

### UX-02: Markdownレンダリング (marked-terminal)

**問題**: LLMがMarkdown形式で返答しても生テキストが表示される。

**設計** (`src/agent/agent-loop.ts`):
- ストリーミング中: 現状維持 (rawテキストをそのまま表示)
- ストリーミング完了後: `marked-terminal` でレンダリングした版を再表示
- 実装方針:
  1. ストリーミング中は現在通りチャンクを出力
  2. ストリーム完了時に `\r` で行先頭に戻り、収集済みの `textContent` を marked-terminal でレンダリングして上書き表示
  3. ただしストリーミング中の出力がすでに表示されているため「カーソル移動して上書き」は複雑
  4. **シンプルな代替案**: ストリーミング完了後に改行し、コードブロックのみハイライト

**注意**: ストリーミング中のリアルタイム表示とレンダリングはトレードオフ。
ストリーミングを犠牲にしてレンダリング優先 vs レンダリングなしでストリーミング維持。
→ **決定**: ストリーミング完了後に別途レンダリング表示を追加（ストリームraw + rendered の2段階表示は避け、raw表示のみでmarked-terminalは段階的に検討）

---

### UX-03: /help の動的スキル一覧

**問題**: `/help` のスキル一覧がハードコードで実態と乖離。

**設計**:
- `src/cli/renderer.ts`: `displayHelp(skills?: Array<{name: string; description: string}>)` に変更
- `src/cli/repl.ts`: `/help` ハンドラで `skillManager.getSkills()` を渡す

---

### SKL-02: システムプロンプトへのスキル一覧注入

**問題**: LLMがどのスキルが使えるか知らない。

**設計** (`src/agent/system-prompt.ts`):
- `buildSystemPrompt(contextMode?, skills?)` にスキルリスト追加
- システムプロンプトに以下を注入:
  ```
  ## 利用可能なスキル
  以下のスキルを呼び出せます。適切な場面で積極的に使用してください:
  - /commit: コミットメッセージ作成・コミット実行
  - /news-research: ニュース調査とレポート作成
  ```

---

### BROWSER-02: browser_screenshot + vision_analyze 連携修正

**問題**: スクリーンショット結果がBase64の先頭100文字のみ返却され、vision_analyzeに渡せない。

**設計** (`src/tools/definitions/browser.ts`):
- `save_path` が未指定の場合、OS一時ディレクトリに自動保存
- 出力に `saved_to: <パス>` を含め、vision_analyze で使用可能にする
- パス形式: `os.tmpdir()/lllmagent-screenshot-<timestamp>.png`

---

## Phase 3: 品質向上 (将来実装)

### BROWSER-01: Playwright accessibility API 使用
- `snapshot()` を `page.accessibility.snapshot()` に置き換え
- 参照IDを含む標準アクセシビリティツリーを返す
- `browser_click` にARIA role + name での指定を追加

### PERF-01: トークン生成速度表示
- Ollamaのストリーミングレスポンスに含まれる `eval_count` / `eval_duration` を利用
- `tokens/sec` をストリーミング完了時に表示

### CTX-01: Ollamaトークナイザー使用
- `POST /api/tokenize` エンドポイントを使い実際のトークン数を取得
- Ollamaプロバイダーのみ対応。他プロバイダーは現状維持

### WEB-03: 検索プロバイダーの拡張
- `TAVILY_API_KEY` 環境変数があれば Tavily API を優先使用
- フォールバックで DuckDuckGo HTML スクレイピング

---

## 変更ファイル一覧 (Phase 1)

| ファイル | 変更内容 |
|---------|---------|
| `src/utils/discord.ts` | URLバリデーション追加、失敗時警告表示 |
| `src/cli/repl.ts` | `/discord test` サブコマンド追加、URLバリデーション |
| `src/config/types.ts` | autoApproveTools に web_search/web_fetch 追加 |
| `src/tools/definitions/web-fetch.ts` | 相対URL解決、header/nav/footer削除廃止 |
| `src/browser/playwright-manager.ts` | headless: true に変更 |

## 変更ファイル一覧 (Phase 2)

| ファイル | 変更内容 |
|---------|---------|
| `src/agent/agent-loop.ts` | Markdownレンダリング対応 |
| `src/cli/renderer.ts` | displayHelp() 動的スキル一覧 |
| `src/cli/repl.ts` | displayHelp にスキルリスト渡す |
| `src/agent/system-prompt.ts` | スキル一覧をプロンプトに注入 |
| `src/tools/definitions/browser.ts` | screenshot 一時ファイル保存 |

## 変更ファイル一覧 (Phase 3: Discord双方向連携)

| ファイル | 変更内容 |
|---------|---------|
| `src/discord/interaction-server.ts` | HTTP サーバー、Ed25519 署名検証、deferred 応答+follow-up |
| `src/discord/slash-commands.ts` | `/ask` コマンド登録 (グローバル or ギルド) |
| `src/config/types.ts` | DiscordConfig に applicationId/publicKey/botToken/interactionPort/listenEnabled 追加 |
| `src/agent/agent-loop.ts` | `isProcessing` フラグ追加、source パラメータ対応 |
| `src/cli/repl.ts` | `/discord app-id|public-key|bot-token|port|register|listen` 追加 |
| `src/index.ts` | `--background` フラグでデーモンモード |

---

## Phase 4: 権限管理強化 (2026-03-10 実装)

### SEC-01: Claude Code 互換パターンベース権限ルール

**背景**: Claude Code の `allow/deny/ask` パターンルール（例: `Bash(npm *)`）に相当する柔軟な権限設定を実装。

**実装内容**:

1. **パターンルールエンジン** (`src/security/rule-engine.ts` 新規)
   - `evaluateRules(rules, toolName, params)` → `"allow" | "deny" | "ask" | null`
   - ルール形式: `bash(npm *)`, `file_write(./src/**)`, `web_fetch(domain:github.com)`
   - glob パターン(`*`, `**`, `?`)対応
   - Claude Code エイリアス対応（Bash/Read/Write/Edit/WebFetch 等）
   - 評価順: deny → allow → ask（最初にマッチしたルールが適用）

2. **権限ソース分離** (`src/security/permission-manager.ts` 大幅改修)
   - `RequestSource = "cli" | "discord"` 追加
   - CLI: `rules` → `autoApproveTools/requireApprovalTools` → 確認ダイアログ（5択）
   - Discord: `rules.deny` → `INHERENTLY_SAFE_TOOLS + discordAutoApproveTools`（headless）
   - **deny ルールは CLI・Discord 双方に適用**（セキュリティ強制）
   - ツール定義フィルタリング: Discord では許可ツールのみ LLM に提示
   - 確認ダイアログ 5択: 今回のみ / セッション中常に / 設定に保存して常に / 拒否 / 中止

3. **設定スキーマ拡張** (`src/config/types.ts`)
   - `SecurityRuleConfig { allow, deny, ask }` 追加
   - `SecurityConfig.rules` 追加
   - `SecurityConfig.discordAutoApproveTools` 追加
   - `loadConfig()` でツールリストを union マージ（新デフォルトが既存 config に自動反映）

4. **REPL コマンド拡張** (`src/cli/repl.ts`)
   - `/permission list/rules/rule-add/rule-remove/auto-add/auto-remove/require-add/require-remove/discord-add/discord-remove`

5. **タブ補完強化** (`src/cli/completer.ts`)
   - `/permission` 全サブコマンドを補完候補に追加
   - `/permission auto-add <tool>` 等でツール名の補完対応

6. **永続保存** (`src/index.ts`)
   - 「設定に保存して常に許可」選択時に `autoApproveTools` に追記して `config.json` 保存

## 変更ファイル一覧 (Phase 4)

| ファイル | 変更内容 |
|---------|---------|
| `src/security/rule-engine.ts` | 新規: パターンルールエンジン |
| `src/security/permission-manager.ts` | 大幅改修: Discord/CLI分離、5択ダイアログ、ルール評価 |
| `src/config/types.ts` | SecurityRuleConfig 追加、discordAutoApproveTools 追加 |
| `src/config/config-manager.ts` | ツールリストの union マージ |
| `src/agent/agent-loop.ts` | currentSource フィールド、Discord ツール定義フィルタリング |
| `src/tools/tool-executor.ts` | source パラメータ追加 |
| `src/discord/interaction-server.ts` | source: "discord" でエージェント呼び出し |
| `src/cli/repl.ts` | /permission 全サブコマンド追加 |
| `src/cli/completer.ts` | /permission 補完、ツール名補完 |
| `src/index.ts` | onPermanentApprove コールバック、saveConfig 連携 |
