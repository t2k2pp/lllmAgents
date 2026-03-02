# LocalLLM Agent

ローカルLLMを使ったCLI型AIエージェント。Claude Codeにインスパイアされた、PC操作が可能な対話型アシスタント。

## 特徴

- **ローカルLLM対応**: Ollama, LM Studio, llama.cpp, vLLM をサポート
- **ツール呼び出し**: ファイル操作、コマンド実行、ブラウザ操作をLLMが自律的に実行
- **セキュリティ**: Claude Code準拠の3段階権限モデル（自動許可/要確認/禁止）
- **画像認識**: Vision非対応LLM向けにサブLLM委譲をサポート
- **コンテキスト管理**: 80%消費時に自動圧縮（LLM自身による要約）
- **ブラウザ操作**: Playwright統合によるWeb自動化
- **クロスプラットフォーム**: Windows, macOS, Linux対応

## セットアップ

```bash
# インストール
npm install

# 初回設定（セットアップウィザード）
npm run setup

# 起動
npm start
```

### セットアップウィザードの流れ

1. LLMサーバーの種類を選択（Ollama / LM Studio / llama.cpp / vLLM）
2. サーバーのIPアドレスとポートを入力
3. 接続テスト → 利用可能モデル一覧を自動取得
4. モデルをリストから選択（手入力不要）
5. コンテキストウインドウサイズを設定（デフォルト: モデル上限）
6. 画像認識用サブLLMの設定（任意）

## 使い方

```
$ npm start

  LocalLLM Agent v0.1.0
  Model: llama3.1:70b @ 192.168.1.100:11434 (Ollama)
  Context: 128K tokens

> このディレクトリのファイルを見せて

> package.json を読んで

> README.md を編集して、タイトルを変更して
  [file_edit] README.md を編集します。よろしいですか？ [y/N]
```

### コマンド

| コマンド | 説明 |
|----------|------|
| `/help` | ヘルプ表示 |
| `/quit` | 終了 |
| `/clear` | 会話履歴クリア |
| `/context` | コンテキスト使用状況 |
| `/setup` | 設定ウィザード再実行 |

## アーキテクチャ

```
src/
├── index.ts            # エントリーポイント
├── cli/                # REPL・UI
├── config/             # 設定管理・セットアップウィザード
├── providers/          # LLMプロバイダー抽象化
│   ├── openai-compat   # OpenAI互換API共通実装
│   ├── ollama          # Ollama固有API
│   ├── lmstudio        # LM Studio
│   ├── llamacpp        # llama.cpp
│   └── vllm            # vLLM
├── agent/              # エージェントループ・コンテキスト管理
├── tools/              # ツール定義・実行
│   └── definitions/    # file_read, file_write, bash, browser, etc.
├── security/           # 権限管理・サンドボックス
├── browser/            # Playwright統合
└── utils/              # ユーティリティ
```

## セキュリティモデル

| 権限レベル | ツール | 説明 |
|-----------|--------|------|
| 自動許可 | file_read, glob, grep | 読み取り専用操作 |
| 要確認 | file_write, file_edit, bash | 変更を伴う操作 |
| 禁止 | サンドボックス外のファイル操作 | 安全性のため |

危険なコマンド（`rm -rf /`, `format`, フォーク爆弾等）は自動検出してブロックします。

## 設定

設定ファイル: `~/.localllm/config.json`

```json
{
  "mainLLM": {
    "providerType": "ollama",
    "baseUrl": "http://192.168.1.100:11434",
    "model": "llama3.1:70b",
    "contextWindow": 128000
  },
  "visionLLM": null,
  "security": {
    "allowedDirectories": [],
    "autoApproveTools": ["file_read", "glob", "grep"]
  },
  "context": {
    "compressionThreshold": 0.8
  }
}
```

## 必要環境

- Node.js 18+
- ローカルLLMサーバー（Ollama / LM Studio / llama.cpp / vLLM）
- Playwright（ブラウザ操作を使う場合）

## ライセンス

MIT
