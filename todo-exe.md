# EXE化スクリプト作成 ToDo

## 設計 (Design)
- 対象: Node.js (v20+) / ESM / TypeScript プロジェクト (`localllm-agents`)
- 要件: Node.jsを利用したCLIアプリの `.exe` ファイルを作成するスクリプト（`.bat`）を作成する。
- 方式: Node.js >= 20 で公式サポートされている **Single Executable Applications (SEA)** と、TypeScriptを1ファイルにバンドルする **esbuild** を組み合わせてEXEを作成する。
- 理由: `pkg`は非推奨となっておりESMのサポートに難があるため、最新のNode内蔵のSEA機能を利用するのが最も確実で安全。

### 作業ステップ
* [x] 1. `esbuild` と `postject` (SEAインジェクタ) のインストールを行う (devDependencies)
* [x] 2. `build-exe.bat` の作成: esbuild によるバンドルと Node SEA を使って exe 化するバッチファイルを作成する
* [ ] 3. リモートリポジトリへコミット (ToDo更新・作成)
* [ ] 4. `build-exe.bat` のテスト: 実際にバッチファイルを実行し、`.exe` ファイルが生成されることを確認する
* [ ] 5. 生成された `localllm.exe` の動作確認を行う
* [ ] 6. リモートリポジトリへコミット (バッチファイルの完成・最終作業)
