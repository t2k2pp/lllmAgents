# Token最適化ガイド

Token消費を削減し、セッション品質を維持しながら、日次制限内でより多くの作業を行うための実践的な設定と習慣をまとめたガイドです。

> 参照: モデル選択戦略については `rules/common/performance.md`、自動コンパクション提案については `skills/strategic-compact/` を参照してください。

---

## 推奨設定

以下はほとんどのユーザーに推奨されるデフォルト設定です。パワーユーザーはワークロードに応じて値をさらに調整できます。たとえば、単純なタスクでは `MAX_THINKING_TOKENS` を低く設定し、複雑なアーキテクチャ作業では高く設定するなどの調整が可能です。

`~/.claude/settings.json` に以下を追加してください:

```json
{
  "model": "sonnet",
  "env": {
    "MAX_THINKING_TOKENS": "10000",
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "50",
    "CLAUDE_CODE_SUBAGENT_MODEL": "haiku"
  }
}
```

### 各設定の説明

| 設定 | デフォルト値 | 推奨値 | 効果 |
|------|-------------|--------|------|
| `model` | opus | **sonnet** | Sonnetはコーディングタスクの約80%を十分にこなせます。複雑な推論が必要な場合は `/model opus` でOpusに切り替えてください。コスト約60%削減。 |
| `MAX_THINKING_TOKENS` | 31,999 | **10,000** | Extended thinkingはリクエストごとに最大31,999の出力tokenを内部推論用に確保します。この値を減らすことで、隠れたコストを約70%削減できます。簡単なタスクでは `0` に設定して無効化できます。 |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | 95 | **50** | Context windowの使用率がこの割合に達すると自動コンパクションが実行されます。デフォルトの95%では遅すぎます。品質はそれより前に低下し始めます。50%でコンパクションを行うことで、セッションをより健全に保てます。 |
| `CLAUDE_CODE_SUBAGENT_MODEL` | _(メインモデルを継承)_ | **haiku** | サブエージェント(Taskツール)はこのモデルで実行されます。Haikuは約80%安価で、探索、ファイル読み取り、テスト実行には十分です。 |

### Extended thinkingの切り替え

- **Alt+T**(Windows/Linux)または **Option+T**(macOS) -- オン/オフの切り替え
- **Ctrl+O** -- thinking出力の表示(詳細モード)

---

## モデル選択

タスクに適したモデルを使用してください:

| モデル | 最適な用途 | コスト |
|--------|-----------|--------|
| **Haiku** | サブエージェントによる探索、ファイル読み取り、単純な検索 | 最低 |
| **Sonnet** | 日常的なコーディング、レビュー、テスト作成、実装 | 中程度 |
| **Opus** | 複雑なアーキテクチャ設計、多段階の推論、難解なバグのデバッグ | 最高 |

セッション中にモデルを切り替える:

```
/model sonnet     # default for most work
/model opus       # complex reasoning
/model haiku      # quick lookups
```

---

## コンテキスト管理

### コマンド

| コマンド | 使用タイミング |
|----------|---------------|
| `/clear` | 無関係なタスク間で使用。古いコンテキストは後続のすべてのメッセージでtokenを浪費します。 |
| `/compact` | 論理的なタスクの区切りで使用(計画後、デバッグ後、フォーカスの切り替え前)。 |
| `/cost` | 現在のセッションのtoken消費量を確認します。 |

### 戦略的コンパクション

`strategic-compact` スキル(`skills/strategic-compact/` 内)は、タスクの途中で実行される可能性のある自動コンパクションに頼るのではなく、論理的なタイミングで `/compact` を提案します。フックの設定手順についてはスキルのREADMEを参照してください。

**コンパクションすべきタイミング:**
- 探索の後、実装の前
- マイルストーン完了後
- デバッグの後、新しい作業に移る前
- 大きなコンテキスト切り替えの前

**コンパクションすべきでないタイミング:**
- 関連する変更の実装中
- アクティブな問題のデバッグ中
- 複数ファイルにまたがるリファクタリング中

### サブエージェントでコンテキストを保護する

メインセッションで多くのファイルを読み込む代わりに、探索にはサブエージェント(Taskツール)を使用してください。サブエージェントが20個のファイルを読み込んでも、メインのコンテキストには要約のみが返されるため、コンテキストをクリーンに保てます。

---

## MCPサーバー管理

有効な各MCPサーバーはcontext windowにツール定義を追加します。READMEでは次のように注意しています: **プロジェクトごとに有効にするサーバーは10未満に抑えてください**。

ヒント:
- `/mcp` を実行して、アクティブなサーバーとそのコンテキストコストを確認
- 利用可能な場合はCLIツールを優先(`gh`はGitHub MCPの代わりに、`aws`はAWS MCPの代わりに使用)
- プロジェクト設定の `disabledMcpServers` を使用して、プロジェクトごとにサーバーを無効化
- `memory` MCPサーバーはデフォルトで設定されていますが、どのスキル、エージェント、フックでも使用されていません。無効化を検討してください

---

## Agent Teamsのコストに関する注意

[Agent Teams](https://code.claude.com/docs/en/agent-teams)(実験的機能)は複数の独立したcontext windowを生成します。各チームメイトは個別にtokenを消費します。

- 並列処理が明確な価値をもたらすタスクにのみ使用してください(マルチモジュール作業、並列レビューなど)
- 単純な逐次タスクには、サブエージェント(Taskツール)の方がtoken効率が高い
- 有効化: 設定に `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` を追加

---

## 今後の予定: configure-ecc連携

`configure-ecc` インストールウィザードで、セットアップ時にこれらの環境変数をコストのトレードオフの説明とともに設定できるようにする構想があります。これにより、新規ユーザーが制限に達してからこれらの設定を発見するのではなく、初日から最適化を開始できるようになります。

---

## クイックリファレンス

```bash
# Daily workflow
/model sonnet              # Start here
/model opus                # Only for complex reasoning
/clear                     # Between unrelated tasks
/compact                   # At logical breakpoints
/cost                      # Check spending

# Environment variables (add to ~/.claude/settings.json "env" block)
MAX_THINKING_TOKENS=10000
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50
CLAUDE_CODE_SUBAGENT_MODEL=haiku
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```
