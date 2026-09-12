# Unity とローカルLLMの連携

LocalLLM Agents の既存モデル設定・permission・skill・MCP経路で、Unity公式スキルと
Unity CLIを使用する。Claude/Codexの契約やAPI接続は不要。公式スキル本文と参照ファイルは
変更せず、単一manifestを持つ本アプリ向けバンドルへコピーする。

## 導入

前提はGit、Unity 6以降のプロジェクト。Editor操作時にはUnity CLIと
`com.unity.pipeline`が必要。CLI/Editor/パッケージのインストール、ログイン、ライセンス同意は
このsetupでは行わない。実行テストを保留する場合は手順1までで止める。

1. `localllm unity setup --project "/absolute/path/MyGame"`
   - 固定した公式Git SHAを取得し、対象projectの `.localllm/unity/bundles/` に生成する。
   - 既定SHAは `c7055702b44e58402ee481ff408aee407bcf9483`。
   - UnityやLLMは起動しない。既存configや公式sourceを変更しない。
   - CLIがPATHにない場合は `--command "/absolute/path/to/unity"` を指定する。
2. 実行検証を開始してよい時点で、対象UnityプロジェクトをEditorで開き、
   `localllm unity doctor --project "/absolute/path/MyGame"` を実行する。
   doctorはCLIバージョンと対象Editorのready状態を確認する。モデル推論・シーン変更はしない。
   MCP handshakeは次のアプリ起動時に確認する。
3. setupのJSON出力の `launchArgs` を使用する。
   `localllm --plugin-dir "<出力されたbundleの絶対パス>"`
   開発checkoutでは `npm start -- --plugin-dir "<bundleの絶対パス>"`。
   毎回有効化する場合は既存configの `pluginDirs` にこの絶対パスを明示追加する。
4. `/unity:local-development` を起動し、実施する作業を指定する。
   公式スキルは `/unity:unity-cli` 等で個別利用できる。

Unity MCPは `unity mcp --project-path <absolute path>` として起動し、
ツール名は `mcp__unity__editor__<tool>` になる。別プロジェクトにはsetupを別途実行する。
worktree agentは既存のMCP利用制限に従い、元Editorへの暗黙の操作は許可しない。

## バージョンと復元

`setup --revision <40桁の公式Git SHA>` で更新する。取得元URLは固定し、取得したHEADを照合する。
source.jsonに取得元・SHA・バージョン・対象project・CLIを記録する。
同一内容の再実行では既存bundleを使用し、改変されたbundleはエラーにする。
更新は新しいbundleとして生成し、以前の絶対パスで起動すれば復元できる。
不要になったbundleは、利用を終了しpluginDirsから外した後にそのディレクトリを削除する。
元のUnity Companion Licenseは各bundleのLICENSE.mdに保持する。

## ローカルLLMと画像

公式スキル31件と本アプリ向け手順1件を読み込み、本文は必要時に既存skillツールで取得する。
公式のallowed-tools配列と複数行descriptionに対応し、Bash等を本アプリのツール名へ変換する。
汎用YAMLの完全互換を表明するものではない。読み込めないskillがあればsetupは失敗する。

MCPのtext、埋め込みtext、structuredContentはテキストとして返す。
PNG/JPEG/WebPは一時ファイルへ保存し、そのパスを返す。Base64をテキストモデルへ注入しない。
画面確認には既存のvision_analyzeと画像対応visionモデルを明示設定する。
保存成功だけでは視覚検証済みにならない。画像は不要になったら返された一時ディレクトリを削除する。
画像1件の上限は20 MiB。未対応contentはエラーとして報告する。

MCPのtools/listページングとlist_changed通知に対応する。更新失敗時は古いツールを外して
`/mcp reload` を案内する。Editorがreadyでない場合はコンパイルエラーとPipelineを確認する。

## 検証境界

自動テストは隔離したproject構造・公式形式fixture・偽MCPプロセスを使用する。
実際のローカルLLM・Unity Editorに対する操作は含めない。
実機受け入れでは以下を別途確認する。

- doctorが対象Editorを認識し、MCPツールが登録される。
- ローカルLLMがunity:unity-cliの参照を読み、正しい対象へオブジェクトを作成・保存する。
- コンパイル結果、EditModeテストの終了コードとレポートを確認する。
- Editor再起動後の再接続とツール更新を確認する。
- 画像対応モデルを設定した場合、返された画像パスをvision_analyzeで確認する。
- 同一課題の連携前後で成功率・時間・トークン量を比較する。実測前に効率改善を断定しない。

一次資料:

- https://github.com/Unity-Technologies/unity-agent-plugin
- https://github.com/Unity-Technologies/unity-agent-plugin/blob/c7055702b44e58402ee481ff408aee407bcf9483/skills/unity-cli/references/integration-advanced.md
- https://unity.com/ja/blog/unity-plugin-for-claude-code
