# lllmAgents ユーザー体験課題レポート

> 調査日: 2026年3月9日
> 調査方法: コードリーディング・ツール直接テスト・アプリ起動テスト
> テスト環境: Windows 11, Ollama (http://192.168.1.33:11434), モデル: qwen3.5:27b (27B, 130K tokens)

---

## エグゼクティブサマリー

lllmAgentsは全体的に動作する基盤はあるが、**ユーザーが実際に使いこなすには以下の課題が顕著**である。特に「ニュース調査 → Markdown/HTML化」のようなWebリサーチタスクでは、パーミッション確認の煩雑さとWebコンテンツ取得精度の低さが大きな障壁となる。

重大度は `🔴 High` / `🟡 Medium` / `🟢 Low` で分類する。

---

## 1. I/O・操作性の課題

### 🔴 [UX-01] web_search・web_fetchがデフォルトで毎回確認プロンプトを表示

**問題**: `web_search`と`web_fetch`が `autoApproveTools` にも `requireApprovalTools` にも含まれていないため、PermissionManagerの fallback（`ask`）が適用される。ニュース調査タスクで10〜15回のWeb検索・取得を行うと、毎回インタラクティブな確認プロンプト（inquirer.prompt）が表示される。

**影響**: リサーチ系タスクの実用性が著しく低下する。

**再現箇所**: `src/config/types.ts:121-127` (defaultConfig.autoApproveTools に web_search/web_fetch が未記載)、`src/security/permission-manager.ts:40-41` (fallback が "ask")

**修正案**:
- デフォルトの`autoApproveTools`に`web_search`と`web_fetch`を追加する
- または`INHERENTLY_SAFE_TOOLS`集合にWebツールを含める
- 設定ファイルのdocumentationにこの挙動を明記する

---

### 🔴 [UX-02] Markdown レンダリングが端末に実装されていない

**問題**: `marked`と`marked-terminal`がdependenciesに含まれているが、`agent-loop.ts`のテキスト出力部分（`process.stdout.write(displayText)`）でマークダウンレンダリングが行われていない。LLMがMarkdown形式（見出し `#`, コードブロック等）で返答しても、端末には生のMarkdownテキストが流れる。

**影響**: コードブロック・見出し・箇条書きが視覚的に判読しにくく、長い回答が読みづらい。

**再現箇所**: `src/agent/agent-loop.ts:162` (`process.stdout.write(displayText)`)

**修正案**: `displayText`を `marked-terminal` でレンダリングしてから出力する。ただしストリーミング中にチャンク単位でMarkdownを中途半端にパースするとレンダリングが崩れるため、テキスト集約後にまとめてレンダリングする（Agent-loopの最終表示フェーズ）か、ストリーム完了後に再レンダリングする。

---

### 🟡 [UX-03] `/help` コマンドのスキル一覧がハードコードされており実態と乖離

**問題**: `src/cli/renderer.ts:41-45` の `displayHelp()` 内でスキルリスト（`/commit`, `/pr-review`, `/tdd`, `/build-fix`）がハードコードされている。ユーザーがカスタムスキルを追加しても反映されない。

**影響**: `/news`, `/markdown` 等の追加スキルが `/help` に表示されないため、ユーザーが利用可能なスキルを把握できない。

**再現箇所**: `src/cli/renderer.ts:41-45`

**修正案**: `displayHelp()` に `SkillRegistry` を受け取るパラメータを追加し、動的にスキル一覧を出力する。

---

## 2. Webツールの課題

### 🔴 [WEB-01] web_fetchのHTMLストリッピング品質が低い

**問題**: `src/tools/definitions/web-fetch.ts` の `stripHtml` 関数に以下の問題がある:

1. **`<header>`, `<footer>`, `<nav>` タグごとコンテンツを削除** するため、これらタグ内に重要なコンテンツがあるサイト（NHKニュースのトップページ等）では情報が欠落する
2. **SPAサイトの本文が取得できない**: NHKニュース等のSPAサイトは、記事本文がJavaScriptで動的に読み込まれるため、`fetch` で取得したHTMLには全文が含まれない（例: 「1バレル…」で途切れる）
3. **リンクが `テキスト (URL)` 形式で重複**: `$2 ($1)` 形式のリンク変換により、同じリンクが2回表示されることがある

**影響**: LLMに渡されるコンテンツの品質が低く、ニュース記事の本文取得に失敗するケースが多い。

**修正案**:
- `<header>`, `<nav>`, `<footer>` の除去は任意オプションにする
- Playwright（`browser_navigate` + `browser_snapshot`）を使ったJS実行後のコンテンツ取得を `web_fetch` の代替として案内する
- `prompt` パラメータを活用して、LLMに「ページの記事本文のみを抽出して」と指示する仕組みを追加する

---

### 🔴 [WEB-02] web_fetchが相対URLを解決しない

**問題**: NHKニュース等のサイトから取得したテキストに `/newsweb/na/na-k10015070401000` のような相対URLが含まれる。`web_fetch` はBaseURLを保持・解決しないため、後続の `browser_navigate` や再度の `web_fetch` でこのURLを使っても正しいページに到達できない。

**影響**: マルチステップのWebリサーチで「記事一覧からURLを取得 → 各記事を取得」というフローが機能しない。

**修正案**: HTMLからテキスト変換する際に、`<a href="/path">` の相対URLを取得元のベースURLを使って絶対URLに変換する。

---

### 🟡 [WEB-03] DuckDuckGoのHTML APIのみに依存する検索

**問題**: `web_search` は `https://html.duckduckgo.com/html/` のHTMLスクレイピングのみに対応。HTMLの構造変化でパースが壊れるリスクがあり、Tavilyや Serper等の検索APIとの比較で精度・安定性が劣る。また、DuckDuckGoは地域ターゲティングのニュース検索が弱い場合がある。

**影響**: ニュース記事のタイトル取得は機能するが、より高品質な検索APIが使えない。

**修正案**: 環境変数（`TAVILY_API_KEY`, `SERPER_API_KEY`等）が設定されている場合に外部検索APIを優先的に使用するフォールバック機構を追加する。

---

## 3. ブラウザ機能の課題

### 🔴 [BROWSER-01] アクセシビリティツリーが独自実装で精度が不足

**問題**: `src/browser/playwright-manager.ts:43-64` の `snapshot()` が、Playwrightの組み込みAPI（`page.accessibility.snapshot()`）ではなく、独自のDOM走査（`buildTree` 関数）でツリーを構築している。

具体的な問題:
- `el.getAttribute("role")` のみを見ており、Aria属性の多くが無視される
- `depth > 10` の制限で深いDOM構造では情報が欠落する
- リンク・ボタンの参照IDがなく、後続の `browser_click` で使用するセレクタ生成が困難

**影響**: `browser_snapshot` の結果からLLMが正しいCSSセレクタを推測できず、`browser_click` が失敗しやすい。

**修正案**: Playwright の `page.accessibility.snapshot()` API を使うか、Playwright MCPサーバーを活用する。

---

### 🔴 [BROWSER-02] browser_screenshotとvision_analyzeの連携が未完成

**問題**: `browser_screenshot` の実行結果として返されるのは `"Screenshot captured (N bytes, base64: <最初の100文字>...)."` というテキストのみ。実際のBase64データが含まれないため、LLMが `vision_analyze` にこのデータを渡せない。

```typescript
// src/tools/definitions/browser.ts:135
output: `Screenshot captured (${buf.length} bytes, base64: ${buf.toString("base64").slice(0, 100)}...).`,
```

**影響**: ブラウザのスクリーンショットをビジョン分析するユースケースが機能しない。

**修正案**: `save_path` が指定されない場合も、スクリーンショットを一時ファイルに保存し、そのパスを返して `vision_analyze` で利用できるようにする。または、Base64データ全体をツール結果に含め、LLMがvision_analyzeのimage_pathとして解釈できるようにする。

---

### 🟡 [BROWSER-03] headless: falseでGUIが開き、サーバー環境で動作しない

**問題**: `src/browser/playwright-manager.ts:25` で `{ headless: false }` が指定されており、ブラウザ操作のたびにGUIウィンドウが表示される。

**影響**: リモートサーバー・CI環境・ヘッドレス環境では `browser_navigate` 等のツールが完全に失敗する。

**修正案**: デフォルトを `headless: true` に変更し、設定ファイルで `browser.headless: false` を任意で指定できるようにする。

---

### 🟡 [BROWSER-04] browser_clickがCSSセレクタのみサポート

**問題**: `browser_click` は `selector` パラメータ（CSSセレクタ）のみに対応。現代的なSPAやSSR+hydrationサイトでは動的なDOM構造によりCSSセレクタが不安定。Claude CodeのようにアクセシビリティツリーのNodeIDや役割名でクリックする方式が望ましい。

**影響**: LLMが正しいCSSセレクタを生成できず、クリック操作が失敗しやすい。

---

## 4. ビジョン機能の課題

### 🟡 [VISION-01] visionLLM未設定時の動作が不明確・エラーハンドリング不足

**問題**: `config.visionLLM: null` の場合、`vision_analyze` ツールはメインLLM（qwen3.5:27b）をビジョンモデルとして使用する。しかし、以下の問題がある:

1. qwen3.5:27bがビジョン対応しているか設定画面でユーザーに明示されない
2. `chatWithVision()` が未対応のモデルで呼ばれた場合のエラーメッセージが不明確
3. `/status`コマンドでvisionLLMの設定状態が表示されない

**修正案**: セットアップウィザードでビジョン対応モデルの選択を明示し、`vision_analyze` ツールの説明に「visionLLMの設定が推奨」を記載する。

---

## 5. コンテキスト・メモリの課題

### 🟡 [CTX-01] コンテキスト使用量の計算にAnthropicトークナイザーを使用

**問題**: `src/agent/token-counter.ts`（および`/context`コマンドの計算）でAnthropicのtokenizer（`@anthropic-ai/tokenizer`）を使っているが、ローカルLLM（Ollamaのqwen3.5）のトークン数と一致しない。

**影響**: コンテキスト使用率の表示が不正確になり、圧縮タイミングがずれる。特に日本語テキストではトークン数の差が大きくなる可能性がある。

**修正案**: Ollamaプロバイダーの場合、`/api/generate` または `tokenize` エンドポイントを使って実際のトークン数を取得する（存在する場合）。または、各プロバイダーに合わせたトークナイザーを選択する仕組みを追加する。

---

### 🟡 [CTX-02] コンテキスト圧縮もローカルLLMで行われ処理が遅い

**問題**: `src/agent/context-manager.ts:49-66` でコンテキスト圧縮をLLM自身に要約させる。27Bモデルでは長い履歴の要約にも数十秒〜数分かかる場合があり、UXを損なう。

**影響**: 長セッション後にコンテキスト圧縮が発火すると、ユーザーが長時間待たされる。

**修正案**: 圧縮専用の軽量モデル（小さなOllamaモデル）を指定できるようにする。または、単純なメッセージ削除（最古メッセージの切り捨て）をデフォルトにし、要約はオプションにする。

---

## 6. 設定・セキュリティの課題

### 🔴 [CFG-01] DiscordのWebhook URLが招待URLになっており通知が機能しない

**問題**: `~/.localllm/config.json` に設定されているDiscordのWebhookURLが `https://discord.gg/9jmhMXtdK`（Discord招待URL）になっており、Webhook URLではない（正しい形式: `https://discord.com/api/webhooks/...`）。

**影響**: `discord.enabled: true` にもかかわらず、LLM応答後のDiscord通知が常に失敗する。エラーが静かに無視されるため（`src/utils/discord.ts`）、ユーザーが問題に気づかない。

**修正案**:
1. セットアップウィザードでWebhook URLの形式バリデーションを追加する
2. Discord通知送信失敗時にターミナルに警告を表示する

---

### 🟢 [CFG-02] web_fetch/web_searchがdocumentationに未掲載のaskフォールバックになる

**問題**: `autoApproveTools` にも `requireApprovalTools` にも含まれていないツールは `ask` にフォールバックするが、これが外部設計書（external_design.md）や設定ドキュメントに明記されていない。

**影響**: 新規ユーザーが設定なしで使うと、多くのツールが確認プロンプト対象になることを予期できない。

**修正案**: ドキュメントに「明示的に指定されていないツールはaskになる」ことを記載する。

---

## 7. スキル・エージェントの課題

### 🟡 [SKL-01] サブエージェントがストリーミングせず進捗がわからない

**問題**: `src/agent/sub-agent.ts:200` で `collectResponse()` を使っており、サブエージェントの処理中はLLMの応答がリアルタイムで表示されない。

**影響**: サブエージェントが複雑なタスクを処理している間、ユーザーにはスピナーのみが表示され、何が起きているかわからない（特にローカルLLMが遅い場合）。

**修正案**: メインエージェントと同様にストリーミング出力を実装する（`indentedStream` 等）か、少なくともツール呼び出しのたびにターミナルに中間状態を出力する。

---

### 🟡 [SKL-02] skillsystemがシステムプロンプトに一覧を注入していない

**問題**: `src/agent/system-prompt.ts` でスキルの名前・説明・トリガーがシステムプロンプトに含まれていない。スキルを起動するには `skill` ツールを呼ぶ必要があるが、LLMがどのスキルが利用可能かを知る手段がない（`/skills` コマンドはREPL層のため、LLMには見えない）。

**影響**: LLMが `skill` ツールを適切に呼び出せない。「コミットして」と言っても自動的に `/commit` スキルを使ってくれない。

**修正案**: `buildSystemPrompt()`でスキルの一覧（name + description + trigger）をシステムプロンプトに注入する。

---

## 8. パフォーマンスの課題

### 🟡 [PERF-01] ローカルLLMの遅さに対するUXフィードバックが不十分

**問題**: 27Bモデルでは1リクエストに30秒〜数分かかる場合がある。待機中のスピナーには経過時間が表示されるが（2秒以上の場合）、「あと何秒かかりそうか」「LLMが実際に動いているか」がわからない。

**影響**: ユーザーがアプリが応答しなくなったと誤解してCtrl+Cで中断する可能性がある。

**修正案**:
- ストリーミング中の応答チャンク数やトークン数をリアルタイムで表示する
- トークン生成速度（tokens/sec）を表示する
- LLM接続のヘルスチェック状態を起動時に表示する

---

## 作成されたファイル一覧

| ファイル | 説明 |
|---------|------|
| `.localllm/rules/japanese-response.md` | 日本語応答ルール |
| `.localllm/rules/research-quality.md` | リサーチ品質ルール |
| `.localllm/skills/news-research/SKILL.md` | ニュース調査スキル |
| `.localllm/skills/news-research/references/html-template.md` | HTML出力テンプレート参照 |
| `.localllm/skills/markdown-html/SKILL.md` | Markdown/HTML変換スキル |
| `output/news-2026-03-09.md` | 本日のニュースまとめ（Markdown） |
| `output/news-2026-03-09.html` | 本日のニュースまとめ（HTML） |

---

## 課題一覧サマリー

| ID | 重大度 | カテゴリ | タイトル |
|----|--------|----------|---------|
| UX-01 | 🔴 High | I/O | web_search・web_fetchがデフォルトで毎回確認プロンプト |
| UX-02 | 🔴 High | I/O | Markdownレンダリングなし |
| UX-03 | 🟡 Medium | I/O | helpのスキル一覧がハードコード |
| WEB-01 | 🔴 High | Web | web_fetchのHTMLストリッピング品質が低い |
| WEB-02 | 🔴 High | Web | 相対URLが解決されない |
| WEB-03 | 🟡 Medium | Web | DuckDuckGoのみへの依存 |
| BROWSER-01 | 🔴 High | Browser | アクセシビリティツリーが独自実装で精度不足 |
| BROWSER-02 | 🔴 High | Browser | browser_screenshotとvision_analyzeの連携が未完成 |
| BROWSER-03 | 🟡 Medium | Browser | headless:falseでGUIが開く |
| BROWSER-04 | 🟡 Medium | Browser | browser_clickがCSSセレクタのみ |
| VISION-01 | 🟡 Medium | Vision | visionLLM未設定時の動作が不明確 |
| CTX-01 | 🟡 Medium | Context | Anthropicトークナイザーによる不正確なトークン計算 |
| CTX-02 | 🟡 Medium | Context | コンテキスト圧縮もローカルLLMで実行されて遅い |
| CFG-01 | 🔴 High | Config | DiscordのWebhook URLが無効 |
| CFG-02 | 🟢 Low | Config | askフォールバックがドキュメントに未記載 |
| SKL-01 | 🟡 Medium | Skill | サブエージェントがストリーミングなし |
| SKL-02 | 🟡 Medium | Skill | スキル一覧がシステムプロンプトに未注入 |
| PERF-01 | 🟡 Medium | Performance | ローカルLLMの遅さへのUXフィードバック不足 |

**合計**: High 6件、Medium 9件、Low 1件 = 16件
