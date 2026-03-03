---
name: visa-doc-translate
description: Translate visa application documents (images) to English and create a bilingual PDF with original and translation
---

ビザ申請書類の翻訳を支援します。

## 手順

ユーザーが画像ファイルパスを提供した場合、確認を求めずに以下のステップを自動的に実行します：

1. **画像変換**：ファイルが HEIC の場合、`sips -s format png <input> --out <output>` を使用して PNG に変換

2. **画像回転**：
   - EXIF の向きデータを確認
   - EXIF データに基づいて画像を自動回転
   - EXIF の向きが 6 の場合、反時計回りに 90 度回転
   - 必要に応じて追加の回転を適用（文書が逆さまに見える場合は 180 度を試す）

3. **OCR テキスト抽出**：
   - 複数の OCR メソッドを自動的に試行：
     - macOS Vision フレームワーク（macOS で推奨）
     - EasyOCR（クロスプラットフォーム、tesseract 不要）
     - Tesseract OCR（利用可能な場合）
   - 文書からすべてのテキスト情報を抽出
   - 文書タイプを識別（預金証明書、在職証明書、退職証明書など）

4. **翻訳**：
   - すべてのテキスト内容をプロフェッショナルな英語に翻訳
   - 元の文書の構造とフォーマットを維持
   - ビザ申請に適した専門用語を使用
   - 固有名詞は元の言語で保持し、英語を括弧内に記載
   - 中国語の名前にはピンイン形式を使用（例：WU Zhengye）
   - すべての数値、日付、金額を正確に保持

5. **PDF 生成**：
   - PIL と reportlab ライブラリを使用した Python スクリプトを作成
   - 1ページ目：回転済みの原本画像を A4 ページに合わせて中央配置・拡縮して表示
   - 2ページ目：適切なフォーマットで英語翻訳を表示：
     - タイトルは中央揃えで太字
     - 内容は左揃えで適切な間隔
     - 公式文書にふさわしいプロフェッショナルなレイアウト
   - 下部に注記を追加："This is a certified English translation of the original document"
   - スクリプトを実行して PDF を生成

6. **出力**：同じディレクトリに `<original_filename>_Translated.pdf` という名前で PDF ファイルを作成

## 対応文書

- 銀行預金証明書（存款证明）
- 収入証明書（收入证明）
- 在職証明書（在职证明）
- 退職証明書（退休证明）
- 不動産証明書（房产证明）
- 営業許可証（营业执照）
- 身分証明書およびパスポート
- その他の公式文書

## 技術的な実装

### OCR メソッド（優先順に試行）

1. **macOS Vision フレームワーク**（macOS のみ）：
   ```python
   import Vision
   from Foundation import NSURL
   ```

2. **EasyOCR**（クロスプラットフォーム）：
   ```bash
   pip install easyocr
   ```

3. **Tesseract OCR**（利用可能な場合）：
   ```bash
   brew install tesseract tesseract-lang
   pip install pytesseract
   ```

### 必要な Python ライブラリ

```bash
pip install pillow reportlab
```

macOS Vision フレームワーク用：
```bash
pip install pyobjc-framework-Vision pyobjc-framework-Quartz
```

## 重要なガイドライン

- 各ステップでユーザーの確認を求めない
- 最適な回転角度を自動的に判定する
- 一つの OCR メソッドが失敗した場合、複数のメソッドを試行する
- すべての数値、日付、金額を正確に翻訳する
- きれいでプロフェッショナルなフォーマットを使用する
- プロセス全体を完了し、最終的な PDF の場所を報告する

## 使用例

```bash
/visa-doc-translate RetirementCertificate.PNG
/visa-doc-translate BankStatement.HEIC
/visa-doc-translate EmploymentLetter.jpg
```

## 出力例

このスキルは以下を実行します：
1. 利用可能な OCR メソッドを使用してテキストを抽出
2. プロフェッショナルな英語に翻訳
3. 以下の内容で `<filename>_Translated.pdf` を生成：
   - 1ページ目：原本の文書画像
   - 2ページ目：プロフェッショナルな英語翻訳

オーストラリア、アメリカ、カナダ、イギリスなど、翻訳文書が必要な国へのビザ申請に最適です。
