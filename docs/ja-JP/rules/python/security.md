---
paths:
  - "**/*.py"
  - "**/*.pyi"
---
# Python セキュリティ

> このファイルは [common/security.md](../common/security.md) を Python 固有のコンテンツで拡張します。

## シークレット管理

```python
import os
from dotenv import load_dotenv

load_dotenv()

api_key = os.environ["OPENAI_API_KEY"]  # 未設定の場合 KeyError を発生
```

## セキュリティスキャン

- 静的セキュリティ解析に **bandit** を使用:
  ```bash
  bandit -r src/
  ```

## 参照

Django 固有のセキュリティガイドラインについては、スキル: `django-security` を参照してください（該当する場合）。
