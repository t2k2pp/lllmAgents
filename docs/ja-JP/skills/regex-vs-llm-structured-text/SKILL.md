---
name: regex-vs-llm-structured-text
description: Decision framework for choosing between regex and LLM when parsing structured text — start with regex, add LLM only for low-confidence edge cases.
origin: ECC
---

# 構造化テキスト解析における Regex vs LLM

構造化テキスト（クイズ、フォーム、請求書、文書）を解析するための実践的な意思決定フレームワークです。重要なインサイト：regex は95〜98%のケースを安価かつ決定論的に処理できます。高コストな LLM 呼び出しは残りのエッジケースにのみ使用してください。

## 有効化するタイミング

- 繰り返しパターンを持つ構造化テキストの解析（問題、フォーム、テーブル）
- テキスト抽出に regex と LLM のどちらを使うか判断する場合
- 両方のアプローチを組み合わせたハイブリッドパイプラインの構築
- テキスト処理におけるコスト/精度のトレードオフの最適化

## 判断フレームワーク

```
テキストフォーマットは一貫性があり繰り返しがあるか？
├── はい（>90% がパターンに従う） → Regex から始める
│   ├── Regex が 95%+ を処理 → 完了、LLM 不要
│   └── Regex が <95% を処理 → エッジケースにのみ LLM を追加
└── いいえ（自由形式、高い変動性） → LLM を直接使用
```

## アーキテクチャパターン

```
ソーステキスト
    │
    ▼
[Regex パーサー] ─── 構造を抽出（95-98% の精度）
    │
    ▼
[テキストクリーナー] ─── ノイズを除去（マーカー、ページ番号、アーティファクト）
    │
    ▼
[信頼度スコアラー] ─── 低信頼度の抽出にフラグを立てる
    │
    ├── 高信頼度（≥0.95） → 直接出力
    │
    └── 低信頼度（<0.95） → [LLM バリデーター] → 出力
```

## 実装

### 1. Regex パーサー（大部分を処理）

```python
import re
from dataclasses import dataclass

@dataclass(frozen=True)
class ParsedItem:
    id: str
    text: str
    choices: tuple[str, ...]
    answer: str
    confidence: float = 1.0

def parse_structured_text(content: str) -> list[ParsedItem]:
    """Parse structured text using regex patterns."""
    pattern = re.compile(
        r"(?P<id>\d+)\.\s*(?P<text>.+?)\n"
        r"(?P<choices>(?:[A-D]\..+?\n)+)"
        r"Answer:\s*(?P<answer>[A-D])",
        re.MULTILINE | re.DOTALL,
    )
    items = []
    for match in pattern.finditer(content):
        choices = tuple(
            c.strip() for c in re.findall(r"[A-D]\.\s*(.+)", match.group("choices"))
        )
        items.append(ParsedItem(
            id=match.group("id"),
            text=match.group("text").strip(),
            choices=choices,
            answer=match.group("answer"),
        ))
    return items
```

### 2. 信頼度スコアリング

LLM レビューが必要な項目にフラグを立てます：

```python
@dataclass(frozen=True)
class ConfidenceFlag:
    item_id: str
    score: float
    reasons: tuple[str, ...]

def score_confidence(item: ParsedItem) -> ConfidenceFlag:
    """Score extraction confidence and flag issues."""
    reasons = []
    score = 1.0

    if len(item.choices) < 3:
        reasons.append("few_choices")
        score -= 0.3

    if not item.answer:
        reasons.append("missing_answer")
        score -= 0.5

    if len(item.text) < 10:
        reasons.append("short_text")
        score -= 0.2

    return ConfidenceFlag(
        item_id=item.id,
        score=max(0.0, score),
        reasons=tuple(reasons),
    )

def identify_low_confidence(
    items: list[ParsedItem],
    threshold: float = 0.95,
) -> list[ConfidenceFlag]:
    """Return items below confidence threshold."""
    flags = [score_confidence(item) for item in items]
    return [f for f in flags if f.score < threshold]
```

### 3. LLM バリデーター（エッジケースのみ）

```python
def validate_with_llm(
    item: ParsedItem,
    original_text: str,
    client,
) -> ParsedItem:
    """Use LLM to fix low-confidence extractions."""
    response = client.messages.create(
        model="claude-haiku-4-5-20251001",  # バリデーション用の最安モデル
        max_tokens=500,
        messages=[{
            "role": "user",
            "content": (
                f"Extract the question, choices, and answer from this text.\n\n"
                f"Text: {original_text}\n\n"
                f"Current extraction: {item}\n\n"
                f"Return corrected JSON if needed, or 'CORRECT' if accurate."
            ),
        }],
    )
    # LLM レスポンスを解析して修正済みアイテムを返す...
    return corrected_item
```

### 4. ハイブリッドパイプライン

```python
def process_document(
    content: str,
    *,
    llm_client=None,
    confidence_threshold: float = 0.95,
) -> list[ParsedItem]:
    """Full pipeline: regex -> confidence check -> LLM for edge cases."""
    # ステップ 1: Regex 抽出（95-98% を処理）
    items = parse_structured_text(content)

    # ステップ 2: 信頼度スコアリング
    low_confidence = identify_low_confidence(items, confidence_threshold)

    if not low_confidence or llm_client is None:
        return items

    # ステップ 3: LLM バリデーション（フラグ付きアイテムのみ）
    low_conf_ids = {f.item_id for f in low_confidence}
    result = []
    for item in items:
        if item.id in low_conf_ids:
            result.append(validate_with_llm(item, content, llm_client))
        else:
            result.append(item)

    return result
```

## 実運用メトリクス

本番環境のクイズ解析パイプライン（410アイテム）からの実績：

| メトリクス | 値 |
|-----------|-----|
| Regex 成功率 | 98.0% |
| 低信頼度アイテム | 8 (2.0%) |
| 必要な LLM 呼び出し | 約5 |
| 全 LLM 比でのコスト削減 | 約95% |
| テストカバレッジ | 93% |

## ベストプラクティス

- **regex から始める** -- 不完全な regex でも改善のためのベースラインになる
- **信頼度スコアリングを使用**して、LLM の支援が必要なものをプログラム的に特定する
- **バリデーションには最安の LLM を使用**する（Haiku クラスのモデルで十分）
- 解析済みアイテムを**ミューテートしない** -- クリーニング/バリデーションステップでは新しいインスタンスを返す
- パーサーには **TDD が有効** -- 既知のパターンから先にテストを書き、次にエッジケース
- **メトリクスを記録**する（regex 成功率、LLM 呼び出し数）でパイプラインの健全性を追跡

## 避けるべきアンチパターン

- regex が 95%+ のケースを処理できるのに、すべてのテキストを LLM に送信する（高コストで低速）
- 自由形式で変動性の高いテキストに regex を使用する（LLM の方が適している）
- 信頼度スコアリングをスキップして regex が「ただ動く」ことを期待する
- クリーニング/バリデーションステップで解析済みオブジェクトをミューテートする
- エッジケースのテストをしない（不正な入力、欠損フィールド、エンコーディングの問題）

## 使用するタイミング

- クイズ/試験問題の解析
- フォームデータの抽出
- 請求書/レシートの処理
- 文書構造の解析（ヘッダー、セクション、テーブル）
- コストが重要な繰り返しパターンを持つ構造化テキスト全般
