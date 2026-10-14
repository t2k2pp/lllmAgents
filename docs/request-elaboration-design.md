# 依頼の膨らませ方（要件展開）の改善設計

作成: 2026-10-14 / 状態: 設計確定・実装中（進捗は `docs/todo-request-elaboration.md`）

## 1. 背景 — goemon 試作で見えた差

依頼文: 「ファミコンであった、がんばれゴエモン道中記のようなゲームを作成して」

| | 本アプリ (Qwen3.8 Flash Next, T2) | 上位エージェントアプリ |
|---|---|---|
| 冒頭宣言 | 「standard の完成度で作ります（上から見るアクション：コイン投げで敵を倒し、壁や箱を割って小判を集める）」 | 作品名・ジャンル + キセル/小判攻撃、招き猫3段階パワーアップ、壺探索、よろず屋/めし屋、通行手形3枚で関所突破、チップチューンBGM |
| 原作の看板要素 | 小判投げ・箱割りのみ | 通行手形・店・パワーアップ・探索・BGM まで列挙 |
| 結果 | ユーザーが後から「通行手形をアイテムに」「ダメージ制」「店で回復/能力アップ購入」を追加依頼 (T65) | 最初から含む |

ログ: `~/.localllm/logs/sessions/2026-10-14T00-14-58_main.jsonl`（317 行、89 応答）

## 2. 診断 — モデルは「知っていたのに削った」

1 ターン目の thinking（約 4 万字）を読むと、モデルは原作の要素を思い出している:
`shop?`、`pipes/hatches`、8 方向移動、敵の種類など。しかし直後に次の判断をしている。

- "Pipe warp? Omit for simplicity" / "Mobile touch? Omit" / "Also 'shooter'? Omit"
- "Actually, let's keep scope manageable: 1 well-crafted map"
- "Simplify: 4-directional movement"
- ToDo は「設計(即 completed)/実装/検証/報告」の工程 4 項目だけ。機能が 1 つも載っていない

つまり不足は「知識」より「どこまで作るべきかの判断軸」と「削ったことを黙っている」点にある。
削った事実はユーザーへの宣言に出てこない（= 黙った欠損。`feedback_no_silent_loss` に反する）。

## 3. ハーネス側の原因

| # | 原因 | 該当箇所 |
|---|---|---|
| H1 | 完了レベル（standard 等）は**検証の深さ**だけを決めており、**機能の厚み**を決める軸がどこにもない。「standard = 最小限で動けばよい」と読める余地 | `shared-principles.ts` `buildRegisterRules` |
| H2 | 「まず粗く作る（Build as you go）」が、**順序**の話ではなく**範囲を削る**根拠として読まれた（"keep scope manageable"） | `buildCreativeRhythmRules` |
| H3 | 戦略 ToDo の例が工程（"the HTML is written via file_write", "it runs in the browser"）だけ。機能を完了条件にする発想が出ない | `buildAcceptanceRules` |
| H4 | 冒頭宣言は完了レベル 1 行のみ。「何を作る/何を外す」を言わせないので、削った事実が見えない | `system-prompt.ts` 宣言行 |
| H5 | 「〜のような」「〜風」「オマージュ」など**既存作品を参照する依頼**の扱いがない。参照先の看板要素を洗い出す手順がない | どこにも無い |
| H6 | game-development スキルは要件整理が「コア/追加」の 2 行だけ。かつ今回はユーザー設定 `disabledSkills` で無効 | `src/skills/builtin/game-development/SKILL.md` |

副次的な問題（今回のスコープ外、§7 に記録）: 25KB を 1 回の file_write で書く→ピクセル/タイル座標の取り違えバグで約 60 ターンを消費、など。

## 4. 方針

- **ゲーム専用の規則にしない。** 「〜のような」はゲーム以外（アプリ、文書、UI）でも起きる。汎用原則として入れ、
  ゲーム固有の分解観点は game-development スキルへ外出しする（`feedback_no_workarounds`）。
- **常駐プロンプトを太らせない**（`docs/system-prompt-redesign.md` の原則）。常駐は「何を・なぜ」の短い原則だけ。
  「どうやって洗い出すか」の詳細は `todo_append` 初回の遅延ガイドへ。
- **削るのは自由、黙って削るのは禁止。** 実装量の上限はモデルの判断に任せるが、外した看板要素は宣言で名指しさせる。
- モデル向け文言は英語が正本（`docs/prompt-language-policy.md`）。ユーザー可視の宣言は日本語で出る。

## 5. 変更内容

### 5.1 新規常駐原則 `buildScopeRules(tier)`（shared-principles.ts）

T2 文案（要旨）:

```
# Reading the request [REQUIRED for standard / production]
Build what the user expects, not the minimum the words allow.
- Before implementing, list the features the user expects: what they said + what such a thing normally has.
- If the request points at an existing work or product ("like X", "X-style", homage), list the signature
  elements that make X recognizable (rules, systems, items, progression, look & sound) and include them by default.
- The completion level sets how deeply you verify, not how thin the product may be.
- Leaving a feature out is allowed; leaving it out silently is not. Name what you drop and why.
```

- T1: 1〜2 行に圧縮。T3: 「(4) What it includes / leaves out」を開始テンプレートに追加。
- メイン/サブ共有（`harness-intervention.ts` のサブ用戦略プロンプトにも入れる）。

### 5.2 冒頭宣言の拡張（system-prompt.ts T2 / T1）

`"This task is <level>"` の 1 行に加え、standard 以上は**主な機能**と**外すもの**を 1〜2 行で書かせる。
例: `This task is **standard**. Includes: A, B, C. Leaves out: D (reason).`

### 5.3 戦略 ToDo の例を機能ベースへ（buildAcceptanceRules）

完了条件に「ユーザーに見える機能」を入れる。例を
`"the HTML is written via file_write", "it runs in the browser"` から
`"the shop sells items for collected coins", "the gate opens only with the pass", "it runs in the browser without errors"`
の形に。工程だけの ToDo を避けるよう 1 文追加。

### 5.4 「粗く作る」は順序であって範囲削減ではない（buildCreativeRhythmRules）

`Rough-first is about order, not scope: the rough whole should already have a slot for every planned feature.` を追加。

### 5.5 遅延ガイド `scope`（tool-guides.ts）

`todo_append` 初回に注入。参照作品の分解観点（汎用）:
1. 中心の遊び/使い方（core loop / main flow）
2. その作品だと分かる看板要素（固有のルール・アイテム・仕組み）
3. 進行と目標（ステージ、鍵、クリア条件）
4. 成長・経済（お金、店、強化）
5. 見た目と音（画面構成、BGM/SE）
→ 各要素を「入れる / 簡略化して入れる / 外す(理由)」に振り分け、入れるものを ToDo の完了条件へ。

### 5.6 game-development スキル（SKILL.md）

Step 1「要件整理」を上記 5 観点の「参照作品の分解」に置き換え、完了条件に「看板要素の採否を宣言した」を追加。
※ ユーザー環境では `disabledSkills` に入っているため、効果を得るには有効化が必要（ユーザー判断）。

## 6. 評価方法

本番と同じ LLM（Qwen3.8 Flash Next @ 192.168.1.201:9087）に、変更前/変更後のシステムプロンプト + 同じツール定義 +
同じ依頼文で 1 ターン目だけを送り比較する（`sandbox/scripts/eval-request-elaboration.mjs`）。

指標:
- E1 宣言に機能が並ぶか（機能語の数）
- E2 宣言/ToDo に外す要素の明示があるか
- E3 ToDo のうち機能項目の割合（工程項目でない）
- E4 原作の看板要素（通行手形/関所、店、パワーアップ、探索/隠し、BGM）への言及数

## 7. スコープ外（記録のみ）

- 1 ターンで 25KB 一括 file_write → 座標系取り違えバグ 2 件の発見に約 60 ターン。分割して書く/書いた直後に最小実行する誘導は別課題
- 新しい依頼が来ても前の依頼の完了済み ToDo が残り続ける（T66 の ToDo 表示）
- python heredoc によるファイル書換えが「破壊的コマンド検出」(P3-B) に掛かり、直後にモデルが空応答
- T65「ToDo化して」の指示に対しコード読みを先行し、ユーザーに「プロジェクトとして進めないとだめ」と言われた
