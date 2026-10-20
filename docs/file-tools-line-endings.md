# ファイルツールの改行コード (file_read / file_edit / file_write)

Status: implemented (2026-10-20)

## 1. 背景

2026-10-18 の myppt セッション (Windows, `core.autocrlf=true`) で次の連鎖が起きた。

1. モデルが `git checkout -- src/main/main.js` を実行し、 作業ツリーの main.js が CRLF になった
2. 以後、 main.js への複数行の `file_edit` が「old_string not found」 で連続失敗した
   (file_read の表示に `\r` は見えず、 モデルは `\r\n` を含む old_string を作れない)
3. モデルは `\r\n` を自前で扱う node の置換スクリプトに切り替え、 そのスクリプトの
   エスケープ誤りで main.js / print.js に構文エラーを 3 件作った

改行コードはモデルが意識して指定するものではなく、 **ファイルの属性**である。
ツール側が責任を持って扱う (Claude Code の Edit / Write と同じ考え方)。

## 2. 仕様

共通処理は `src/tools/line-endings.ts`。

| ツール | 振る舞い |
|---|---|
| `file_read` | 表示は LF に揃える (行末の `\r` を出さない)。 CRLF / 混在のファイルでは末尾に `[file_read] 改行コード: CRLF。 file_edit / file_write には LF のまま指定すればよい…` と注記する |
| `file_edit` | ファイル本文・`old_string`・`new_string` をすべて LF に揃えて照合・置換し、 ファイルが使っていた改行コードで書き戻す。 失敗時の添付内容・スニペットも LF |
| `file_write` | 既存ファイルの上書きでは、 元のファイルの改行コードが CRLF なら CRLF で書く。 新規作成は渡された内容のまま書く |

### 2.1 改行コードの判定

`CRLF` の数と単独 `LF` の数を数え、 **多い方**をそのファイルの改行コードとする (同数なら LF)。

### 2.2 混在ファイル

CRLF と LF が混在するファイルを `file_edit` すると、 ファイル全体を多い方に統一して書き戻す。
編集箇所以外の行の改行も変わるため、 結果に `改行コードが混在していたため CRLF に統一して書き込みました`
と明示する (黙って変えない)。

### 2.3 意図的に改行コードを変えたいとき

`file_write` は既存ファイルの改行コードを保つため、 LF への変換などは bash
(`dos2unix` / `sed`) で行う。 モデルが改行コードを変えたい場面は稀で、
変えてしまう事故 (全行差分) の方が多いため、 こちらを既定とする。

## 3. テスト

`tests/tools/file-line-endings.test.ts`
