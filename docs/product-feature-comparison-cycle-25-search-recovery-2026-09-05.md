# Codex / Claude Code 機能比較・商品品質改善 cycle 25

- 実施日: 2026-09-05
- 基準commit: `58c99e4`
- 対象: 名前訂正後の最新情報検索、provider劣化の診断、探索の粘り強さ
- 完了条件: session `mtns71kw-aitc`の失敗を再現し、誤った不存在判定を防ぐ回帰・実環境評価・全品質gate・最新push SHAのCIを閉じる
- 状態: 実装・local評価済み、最新push SHAのCI待ち

## 1. session証拠

原文を転載せず保存構造とtool遷移を集計した。sessionは107 messages（user 8、assistant 39、tool 60）、
terminal transcript 2,149行だった。利用者が`Astral`を`Astra`へ訂正した後、モデルは`Astra`を含む
`web_search`を計16回実行したが、すべて`success: true / No results`として履歴へ戻った。既知候補URLの
`web_fetch`はHTTP 429で失敗し、別provider、browser、単独のcore entity検索へ移らず、Reddit収集をblockedにした。

設定providerはSearXNG（`http://192.168.1.201:8888`）。同endpointを実測すると、並列検索時にBraveは
rate limit、DuckDuckGoはCAPTCHA、Google CSE／Startpageはcrashとなり、HTTP 200かつresults空配列を返した。
旧`web_search`は`unresponsive_engines`を捨て、正常な0件として扱っていた。

対照として独立検索では、同日公開のReddit投稿、OpenAI発表、報道へ到達できた。修正後toolで
SearXNG劣化を明示失敗として検出し、`provider: "duckduckgo"`を明示した1回限りの再検索からReddit候補URLを取得した。

## 2. 機能比較マトリックス

凡例: `◎` user-facing contract、`○`一部あり、`—`無し。

| 比較項目 | Codex系検索 | Claude Code系検索 | `58c99e4`時点 | cycle 25結果 |
|---|---|---|---|---|
| 利用者の名称訂正を探索へ反映 | ◎ | ◎ | ○ queryには反映 | ◎ core entityから再探索する手順を永続化 |
| provider障害と真の0件を区別 | ◎ | ◎ | — engine障害を捨てて成功扱い | ◎ coverage失敗として明示 |
| 同一providerへの並列burst抑制 | service側 | service側 | — 4件同時発行 | ◎ SearXNGをinstance単位で直列化 |
| 同一providerの一過性劣化を再試行 | ◎ | ◎ | — | ◎ bounded 1回retry |
| 別検索経路を明示的に試す | ◎ | ◎ | — 設定変更・再起動が必要 | ◎ per-call provider override |
| silent fallbackを避ける | ◎ | ◎ | ◎ | ◎ 自動切替せず使用providerを結果へ表示 |
| 不存在結論前の独立coverage | ◎ | ◎ | — | ◎ 2経路またはdirect URL/browserを要求 |

## 3. 発見事項

| ID | 優先度 | 原因・影響 | 修正 | 状態 |
|---|---:|---|---|---|
| SEARCH-01 | P1 | SearXNGのengine障害下0件を成功扱いし、実在する最新情報を不存在と誤認 | `unresponsive_engines`をcoverage失敗へ変換 | 修正済み |
| SEARCH-02 | P1 | 複数`web_search`が同じSearXNGへ並列burstし、rate limit／CAPTCHAを悪化 | request開始を直列化・間隔制御 | 修正済み |
| SEARCH-03 | P1 | 別provider検証には保存設定変更と再起動が必要で、実行中探索が止まる | 保存を変えない明示per-call override | 修正済み |
| SEARCH-04 | P2 | 訂正後も類似queryを増やすだけで、core entity→別provider→direct URL/browserへ進まない | tool descriptionとresearch skillへ復旧ladderを固定 | 修正済み |

## 4. 改善設計

1. SearXNG呼出しはhandler instanceごとに直列化し、開始間隔750msを確保する。
2. engine障害下の0件だけは同providerで1回、1,250ms後に再試行する。別providerへは自動fallbackしない。
3. 再失敗は`transient`かつ「情報不存在の根拠ではない」と返し、失敗engineと次の明示providerを示す。
4. `web_search.provider`に`configured | duckduckgo | searxng`を追加し、その呼出しだけ経路を変える。
5. healthyな0件にもquery/provider限定の証拠であることを付記する。
6. `research` skillへ、訂正語のcore entity、非並列化、provider health、別provider、fetch/browserの順を永続化する。

## 5. 評価記録

- 修正前: 新規回帰3件失敗（劣化0件の誤成功、並列burst、provider override不能）。
- 修正後対象: `tests/tools/web-search-provider.test.ts` 4 tests成功、type build成功。
- 実SearXNG: 4並列callを6.6秒で直列処理し、劣化0件を4件とも`transient`失敗として可視化。
- 実DuckDuckGo override: `OpenAI Astra GPT-6 Reddit`で検索成功し、Reddit候補URLを含む結果を取得。
- 全unit: 136 files / 1,384 tests成功（2 files / 11 testsはplatform条件によりskip）。
- E2E: 8 tests成功。別processからの`--resume` transcript復元も成功。
- coverage: statements 45.17%、branches 76.33%、functions 69.44%、lines 45.17%。
- build / lint / built-in skill / version / npm package / dependency audit / durable restart: 成功。lintはerror 0、既知のwarning 279 / info 97。
- Windows SEA: `dist/localllm.exe --version`成功。停止済みのローカル配布先へ`build:deploy`し、`deploy/localllm.exe --version`成功。
- 最新push SHA CI: push後に追記する。

## 6. 終端条件

- SEARCH-01〜04の実装修正。
- 全unit / E2E / coverage / build / lint / package / Windows SEA成功。
- 最新push SHAの全依存CI job成功。
