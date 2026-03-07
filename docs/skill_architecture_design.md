# Skill Architecture Design (Hybrid)

## 1. 目的
本設計書は、`lllmAgents`におけるカスタムスキルのアーキテクチャ定義、および自律的なスキル作成を支援するメタスキル `skill-creator` の実装仕様を定める。
主眼は、LLMの試行錯誤を減らし確実な実行を担保する「Low Freedom」な設計原則の導入と、環境（Python / Node.js）の得意不得意を活かしたハイブリッド設計（適材適所）の実現にある。

## 2. スキルアーキテクチャ (Hybrid Approach)

### 2.1 ディレクトリ構造とProgressive Disclosure
Anthropicのベストプラクティス構造をそのまま採用し、コンテキスト肥大化を防ぐ Progressive Disclosure パターンを導入する。

```text
.localllm/skills/<skill-name>/
  ├── SKILL.md       (必須: YAMLフロントマター、トリガー条件、基礎的な実行手順のみを記す)
  ├── scripts/       (推奨: 決定論的処理を行うスクリプト。要件に応じ Python / JS などを使い分ける)
  ├── references/    (任意: スキーマ、API仕様、フロー詳細などの分割Markdown)
  └── assets/        (任意: ひな形ファイルや画像など静的ファイル)
```

### 2.2 LLMによるスキルの実行とエンジン選択の原則
- **Low Freedom**: LLMはツールを直接叩いての試行錯誤を避け、`scripts/` にカプセル化された処理を引数付きで呼び出す。
- **ハイブリッドエンジンの選択基準**:
  - **Python (`.py`)**: Anthropicの公式リポジトリ等で提供されるツール群、データパース、検証バリデーション、テキスト処理など標準ライブラリで堅牢に書けるCLI処理に最適。
  - **Node.js (`.js`, `.ts`)**: `playwright`等のブラウザ操作、`lllmAgents` との親和性が高い非同期処理、npmエコシステム（Web系）との統合が必要な場合に最適。
  - スキル作成時、LLMは要件に応じて適切なスクリプト言語を選択して出力する。

## 3. skill-creator 設計 (Anthropic公式スクリプトの活用)

本家の `skill-creator` が提供する優れたPythonスクリプトによるバリデーションや初期化の恩恵を受けるため、メタツール群は公式のPython実装を標準として維持する。同時に、`SKILL.md` のガイドライン内で、Node.jsも選択肢として使えることをLLMに明示する。

### 3.1 同梱スクリプト群 (`builtin/skill-creator/scripts/ *.py`)
公式のリポジトリ構造をそのまま利用する。
1. **`init_skill.py`**: スキルの雛形生成
2. **`package_skill.py`**: スキルディレクトリのパッケージ化
3. **`quick_validate.py`**: `SKILL.md` のフロントマターや構造の静的検証

### 3.2 ガイドとリファレンス (`builtin/skill-creator/SKILL.md` 等)
- **`SKILL.md`**: メタプロンプト。LLMがスキルを作成する際、`init_skill.py` や `quick_validate.py` などの公式Pythonツールを呼び出す手順を明記する。また、「スクリプトの実装にはPythonとNode.jsのどちらを用いても良い（ブラウザならNode/Playwright, 一般ツールならPython等）」旨を追記する。

## 4. 既存スキルの移行 (Chunkbase Screenshot)
「Webスクレイピング / ブラウザ操作」はNode.js + Playwrightが環境的に適している（本アプリで依存解決済み）ため、このスキルはNode.jsで実装する。
- **格納先**: `.localllm/skills/chunkbase-screenshot/`
- **スクリプト**: `scripts/capture.js` 
- **目的**: "適材適所"のハイブリッド構成の実証。ツール作成などのシステム操作はPython(`skill-creator`)で行い、ブラウザ等特定のドメインタスクはNode.jsで行うことをデモンストレーションする。
