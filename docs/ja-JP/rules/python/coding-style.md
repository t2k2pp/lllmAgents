---
paths:
  - "**/*.py"
  - "**/*.pyi"
---
# Python コーディングスタイル

> このファイルは [common/coding-style.md](../common/coding-style.md) を Python 固有のコンテンツで拡張します。

## 標準

- **PEP 8** 規約に従う
- すべての関数シグネチャに **型アノテーション** を使用

## 不変性

不変データ構造を優先してください:

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class User:
    name: str
    email: str

from typing import NamedTuple

class Point(NamedTuple):
    x: float
    y: float
```

## フォーマット

- コードフォーマットに **black** を使用
- インポートの並べ替えに **isort** を使用
- リンティングに **ruff** を使用

## 参照

スキル: `python-patterns` で包括的な Python のイディオムとパターンを参照してください。
