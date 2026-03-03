---
name: content-hash-cache-pattern
description: Cache expensive file processing results using SHA-256 content hashes — path-independent, auto-invalidating, with service layer separation.
origin: ECC
---

# コンテンツハッシュファイルキャッシュパターン

SHA-256コンテンツハッシュをキャッシュキーとして使用し、高コストなファイル処理結果（PDF解析、テキスト抽出、画像分析）をキャッシュする。パスベースのキャッシュとは異なり、このアプローチはファイルの移動/名前変更に対応し、内容が変更されると自動的に無効化される。

## 発動条件

- ファイル処理パイプライン（PDF、画像、テキスト抽出）を構築する時
- 処理コストが高く、同じファイルが繰り返し処理される時
- `--cache/--no-cache` CLIオプションが必要な時
- 既存の純粋関数を変更せずにキャッシュを追加したい時

## コアパターン

### 1. コンテンツハッシュベースのキャッシュキー

ファイルの内容（パスではなく）をキャッシュキーとして使用する:

```python
import hashlib
from pathlib import Path

_HASH_CHUNK_SIZE = 65536  # 64KB chunks for large files

def compute_file_hash(path: Path) -> str:
    """SHA-256 of file contents (chunked for large files)."""
    if not path.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    sha256 = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(_HASH_CHUNK_SIZE)
            if not chunk:
                break
            sha256.update(chunk)
    return sha256.hexdigest()
```

**なぜコンテンツハッシュか?** ファイルの名前変更/移動 = キャッシュヒット。内容の変更 = 自動無効化。インデックスファイル不要。

### 2. Frozenデータクラスによるキャッシュエントリ

```python
from dataclasses import dataclass

@dataclass(frozen=True, slots=True)
class CacheEntry:
    file_hash: str
    source_path: str
    document: ExtractedDocument  # キャッシュされた結果
```

### 3. ファイルベースのキャッシュストレージ

各キャッシュエントリは `{hash}.json` として保存される。ハッシュによるO(1)ルックアップが可能で、インデックスファイルは不要。

```python
import json
from typing import Any

def write_cache(cache_dir: Path, entry: CacheEntry) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"{entry.file_hash}.json"
    data = serialize_entry(entry)
    cache_file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

def read_cache(cache_dir: Path, file_hash: str) -> CacheEntry | None:
    cache_file = cache_dir / f"{file_hash}.json"
    if not cache_file.is_file():
        return None
    try:
        raw = cache_file.read_text(encoding="utf-8")
        data = json.loads(raw)
        return deserialize_entry(data)
    except (json.JSONDecodeError, ValueError, KeyError):
        return None  # 破損はキャッシュミスとして扱う
```

### 4. サービスレイヤーラッパー（SRP）

処理関数を純粋に保つ。キャッシュは独立したサービスレイヤーとして追加する。

```python
def extract_with_cache(
    file_path: Path,
    *,
    cache_enabled: bool = True,
    cache_dir: Path = Path(".cache"),
) -> ExtractedDocument:
    """Service layer: cache check -> extraction -> cache write."""
    if not cache_enabled:
        return extract_text(file_path)  # 純粋関数、キャッシュの知識なし

    file_hash = compute_file_hash(file_path)

    # キャッシュ確認
    cached = read_cache(cache_dir, file_hash)
    if cached is not None:
        logger.info("Cache hit: %s (hash=%s)", file_path.name, file_hash[:12])
        return cached.document

    # キャッシュミス -> 抽出 -> 保存
    logger.info("Cache miss: %s (hash=%s)", file_path.name, file_hash[:12])
    doc = extract_text(file_path)
    entry = CacheEntry(file_hash=file_hash, source_path=str(file_path), document=doc)
    write_cache(cache_dir, entry)
    return doc
```

## 主要な設計判断

| 判断 | 根拠 |
|------|------|
| SHA-256コンテンツハッシュ | パス非依存、内容変更時に自動無効化 |
| `{hash}.json` ファイル命名 | O(1)ルックアップ、インデックスファイル不要 |
| サービスレイヤーラッパー | SRP: 抽出は純粋に保ち、キャッシュは別の関心事 |
| 手動JSONシリアライゼーション | Frozenデータクラスのシリアライゼーションを完全制御 |
| 破損時は`None`を返す | グレースフルデグラデーション、次回実行時に再処理 |
| `cache_dir.mkdir(parents=True)` | 最初の書き込み時に遅延ディレクトリ作成 |

## ベストプラクティス

- **パスではなくコンテンツをハッシュする** -- パスは変わるが、コンテンツのアイデンティティは変わらない
- **大きなファイルはチャンク単位でハッシュする** -- ファイル全体をメモリに読み込むことを避ける
- **処理関数を純粋に保つ** -- キャッシュについて一切知るべきではない
- **キャッシュのヒット/ミスをログに記録する** -- デバッグ用に短縮されたハッシュを使用
- **破損をグレースフルに処理する** -- 無効なキャッシュエントリはミスとして扱い、決してクラッシュさせない

## アンチパターン

```python
# 悪い例: パスベースのキャッシュ（ファイルの移動/名前変更で壊れる）
cache = {"/path/to/file.pdf": result}

# 悪い例: 処理関数内にキャッシュロジックを追加（SRP違反）
def extract_text(path, *, cache_enabled=False, cache_dir=None):
    if cache_enabled:  # この関数が2つの責務を持つことになる
        ...

# 悪い例: ネストされたfrozenデータクラスでdataclasses.asdict()を使用
# （複雑なネスト型で問題が発生する可能性がある）
data = dataclasses.asdict(entry)  # 代わりに手動シリアライゼーションを使用
```

## 使用すべき場面

- ファイル処理パイプライン（PDF解析、OCR、テキスト抽出、画像分析）
- `--cache/--no-cache` オプションが有用なCLIツール
- 同じファイルが複数回の実行で出現するバッチ処理
- 既存の純粋関数を変更せずにキャッシュを追加する場合

## 使用すべきでない場面

- 常に最新データが必要な場合（リアルタイムフィード）
- キャッシュエントリが極めて大きくなる場合（代わりにストリーミングを検討）
- 結果がファイル内容以外のパラメータに依存する場合（例: 異なる抽出設定）
