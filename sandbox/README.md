# sandbox/

動作検証用ワークスペース。`deploy/` にビルド済みのスナップショットを起動して検証する。

## 使い方

```
# deploy を最新化
npm run sync:deploy

# sandbox で実行
./run.sh        # Linux/macOS/git bash
run.bat         # Windows cmd
```

## ディレクトリ

- `scripts/` — 検証用スクリプト（PPT/Excel生成、Vision試作等）。再利用前提でコミット対象。
- `artifacts/` — 生成物（PPTX, XLSX, JSON出力等）。gitignore。
- `output/` — レガシー出力退避先。gitignore。
- `screenshots/` — スクリーンショット退避先。gitignore。

## ルール

- ユーザー検証成果物は必ずここに生成する。リポジトリルートには置かない。
- `scripts/` 配下のスクリプトは「次回も使うかもしれないもの」だけ残す。
- `artifacts/` 等に貴重な結果がある場合は別途コミット可能な場所へ退避してから削除する。
