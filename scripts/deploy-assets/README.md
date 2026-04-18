# localllm

ローカル LLM (Ollama / LM Studio / llama.cpp / vLLM) 向けの CLI エージェント。

## 同梱物

```
localllm.exe      本体 (Windows 単一実行ファイル、約 90MB)
skills/           ビルトインスキル
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

## 既知の注意点

### Windows SmartScreen 警告

exe は署名されていないため、初回起動時に「Windows によって PC が保護されました」と
表示されることがあります。「詳細情報」→「実行」で起動できます。

### Playwright (ブラウザ自動化) を使う場合

`localllm` は Playwright をバンドルしていません。ブラウザ自動化を使うスキル
(`/project` など) を実行する前に、作業フォルダで以下を実行してください:

```
npx playwright install chromium
```

### アンインストール

- `%LOCALAPPDATA%\localllm\` を削除 (Windows) または `~/.local/bin/localllm` を削除 (Unix)
- 設定・スキルを完全に消すなら `~/.localllm/` も削除

## バージョン情報

`.deploy-meta.json` にビルド時のバージョン・Node 版数が記録されています。

## サポート

リポジトリ: https://github.com/(TBD)
