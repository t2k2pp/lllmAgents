# localllm

ローカル LLM (Ollama / LM Studio / llama.cpp / vLLM) 向けの CLI エージェント。

## 同梱物

```
localllm.exe      本体 (Windows 単一実行ファイル、約 90MB)
skills/           ビルトインスキル
agents/           ビルトインサブエージェント定義
install.bat       Windows インストーラ
install.sh        macOS/Linux/git-bash インストーラ
README.md         このファイル
```

## インストール

### Windows

1. このフォルダを任意の場所に配置
2. `install.bat` をダブルクリック
   - `localllm.exe` が `%LOCALAPPDATA%\localllm\` にコピーされる
   - `skills/` が `%USERPROFILE%\.localllm\skills\` にコピーされる
   - `agents/` が実行ファイル隣接の `%LOCALAPPDATA%\localllm\agents\` にコピーされる
3. 表示される手順に従って PATH に `%LOCALAPPDATA%\localllm` を追加
4. 新しいターミナルで `localllm --setup` を実行して初期設定

### macOS / Linux / git-bash

```bash
chmod +x install.sh
./install.sh
```

PATH への追加は `~/.bashrc` / `~/.zshrc` に以下を追記:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## 初回起動

```
localllm --setup
```

対話形式で LLM エンドポイント (例: `http://localhost:11434` for Ollama) や
モデル名を設定。設定は `~/.localllm/config.json` に保存されます。

## スキルについて

- **ビルトインスキル**: インストーラが `~/.localllm/skills/` に配置
- **自作スキル**: `~/.localllm/skills/<name>/SKILL.md` に置けば自動認識
- **プロジェクト別スキル**: 作業フォルダの `.localllm/skills/` または `.claude/skills/` に配置

## サブエージェントについて

- **ビルトイン定義**: インストーラが実行ファイル隣接の `agents/` に配置
- **ユーザー上書き**: `~/.localllm/agents/<name>.md`
- **プロジェクト上書き**: 作業フォルダの `.localllm/agents/<name>.md`

## 既知の注意点

### Windows SmartScreen 警告

exe は署名されていないため、初回起動時に「Windows によって PC が保護されました」と
表示されることがあります。「詳細情報」→「実行」で起動できます。
ダウンロードした zip 経由の場合は、zip を右クリック → プロパティ → 「許可する」に
チェックしてから展開すると警告を減らせます。

### macOS Gatekeeper 警告

macOS 版バイナリは ad-hoc 署名のみのため、別マシンでは初回起動時に
「開発元を検証できないため開けません」と表示されることがあります。
Finder でアプリを右クリック →「開く」を選ぶか、以下で隔離属性を外してください:

```bash
xattr -d com.apple.quarantine ./localllm
```

### Playwright (ブラウザ自動化) を使う場合

`localllm` (exe) は Playwright を**同梱していません**（リーン配布）。
ブラウザ系ツール (`browser_*` / `game_smoke` や `/project` などのスキル) を使う前に、
**一度だけ**以下を実行してください:

```
localllm --install-browser
```

これで `~/.localllm` に Playwright と Chromium が導入され、以降どの作業フォルダでも使えます。
導入できているかは `localllm --check-browser` で確認できます。
（手動でやる場合: `cd ~/.localllm && npm install playwright && npx playwright install chromium`）

> 注: 単に `npx playwright install chromium` を実行するだけでは不十分です。
> exe は Playwright 本体を持たないため、上記で **Playwright 本体ごと** `~/.localllm` に導入する必要があります。

### アンインストール

- `%LOCALAPPDATA%\localllm\` を削除 (Windows) または `~/.local/bin/localllm` を削除 (Unix)
- 設定・スキルを完全に消すなら `~/.localllm/` も削除

## バージョン情報

`.deploy-meta.json` にビルド時のバージョン・Node 版数が記録されています。

## サポート

リポジトリ: https://github.com/t2k2pp/lllmAgents

不具合報告には `localllm --version` の出力 (バージョン+コミット) と、
可能なら REPL の `/doctor` 診断結果を添えてください。
