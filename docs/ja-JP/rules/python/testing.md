---
paths:
  - "**/*.py"
  - "**/*.pyi"
---
# Python テスト

> このファイルは [common/testing.md](../common/testing.md) を Python 固有のコンテンツで拡張します。

## フレームワーク

テストフレームワークとして **pytest** を使用してください。

## カバレッジ

```bash
pytest --cov=src --cov-report=term-missing
```

## テストの整理

テストの分類に `pytest.mark` を使用してください:

```python
import pytest

@pytest.mark.unit
def test_calculate_total():
    ...

@pytest.mark.integration
def test_database_connection():
    ...
```

## 参照

スキル: `python-testing` で詳細な pytest パターンとフィクスチャを参照してください。
