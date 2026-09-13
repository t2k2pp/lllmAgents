# 症状から原因へ

失敗ごとに「どの層か／観測値／次に変える一点／再確認結果」を短く残す。同じ呼び出しを連打しない。

| 症状 | 最初に見るもの | 次の行動 |
|---|---|---|
| BashのCLIが未接続、MCPは登録されている | MCPで対象sceneを直接取得できるか | MCPが成功すればその経路を使用。Bash sandboxとEditorの接続障害を混同しない |
| MCPも接続失敗 | 対象project、Editor/Pipelineの状態、最後に成功した時点 | 接続先を確認し、必要ならPipeline再起動を一度行う。操作手段がなければ復旧操作だけユーザーへ依頼。package再インストールやsandbox解除を初手にしない |
| C# evalがコンパイル失敗 | diagnosticsの最初の原因、evalの入力形式 | 最小の本文に戻して修正。通信障害として全作業を中断しない |
| 引数不正 | 現在のschemaと送った値 | Vector3がobjectなら`{"x":0,"y":1,"z":2}`。文字列へ引用符そのものを埋め込まず、設定後に読み返す |
| asset検索が0件 | 検索フィルタ、実ファイル、FBX内subasset | 0件を不存在と断定しない。既知pathのLoadAssetAtPath、LoadAllAssetsAtPath等で確認 |
| 型が見つからない | import/compile中か、Editor/runtime assemblyの違い | コンパイル完了後に確認。Editorメソッドなら登録メニューの実行も選択肢。成功結果を得るまで推測で連続実行しない |
| コンパイル成功なのにConsoleに過去エラー | 現在のcompiling/compilationFailedと新しいentries | 期間と現在値を分けて記録。Consoleを消して修正の証拠にしない |
| 429 / rate_limit_exceeded | provider名、発生した操作 | 後続送信を停止。モデル/画像解析へ切り替えて回避しない。ユーザーの明示的な再開を待つ |

## evalはメソッド本文

Unity PipelineのevalはコードをExecuteメソッド内へ挿入する方式がある。使用中の仕様を確認し、この方式では`using`・クラス・Runメソッドを貼り付けない。

まず次だけで成功を確認する:

```csharp
return UnityEngine.SceneManagement.SceneManager.GetActiveScene().path;
```

必要な集計は型を完全修飾し、短い文字列/明示的にシリアライズ可能なデータを返す。JsonUtilityで匿名型のpropertyが保存されると仮定しない。クエリを分割し、成功したコードをプロジェクトの開発記録へ残して再利用する。

```csharp
var scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
var roots = scene.GetRootGameObjects();
var text = new System.Text.StringBuilder();
text.AppendLine(scene.path + " roots=" + roots.Length + " dirty=" + scene.isDirty);
foreach (var root in roots) {
    var rs = root.GetComponentsInChildren<UnityEngine.Renderer>(true);
    text.AppendLine(root.name + " renderers=" + rs.Length);
}
return text.ToString();
```

エラー全文や巨大な生成コードを何度も読ませず、原因となるdiagnosticと該当行を残す。認証token・鍵・Pipeline descriptorの秘密値は診断出力へ含めない。
