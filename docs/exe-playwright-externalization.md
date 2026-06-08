# exe での Playwright 外部化（ブラウザ機能の parity 回復）

/ 設計書。実装と常に整合を保つこと（CLAUDE.md ルール）。

## 1. 背景と問題

### 症状

Windows 配布版（SEA exe）でブラウザ系ツールが失敗する。実ログ（`samples/mq1nn3bb-2hzi.json`）:

| ツール | エラー |
|--------|--------|
| `game_smoke` | `TypeError: require.resolve is not a function` |
| `browser_navigate` | `TypeError: Cannot read properties of undefined (reading 'launch')` |

当初「サンドボックスの制限」と疑われたが、**サンドボックスは無罪**（実証済み）。
`permission-manager.ts:443` は `browser_*` を自動承認、プロセスサンドボックスは `bash` の spawn のみラップ。

### 根本原因

`playwright-core` は起動時に**自分のパッケージ位置／ブラウザの場所を `require.resolve` で解決**する:

- `playwright-core/lib/server/utils/nodePlatform.js:67` → `require.resolve("../../../package.json")`
- `playwright-core/lib/serverRegistry.js:80` → `require.resolve("..")` ほか多数

これを **esbuild で 1 ファイルに束ねる**と相対パスが束ね先基準にズレて壊れる
（esbuild 自身が `require-resolve-not-external` 警告を出す）。さらに **SEA の `require` には `.resolve` が無い**ため、
もう一段手前で `require.resolve is not a function` として表面化する。

### 実証（Mac・サンドボックス無し）

| 条件 | 結果 |
|------|------|
| 非バンドル `require('playwright').chromium.launch()` | ✅ launch OK |
| esbuild バンドル済み cjs（素の node） | ❌ `Cannot find module '../../../package.json'` |
| SEA exe（deploy/localllm）／Windows ログ | ❌ `require.resolve is not a function` |

→ **OS 非依存のパッケージング問題**。`build-exe.js` の `external` は作成当初（commit a6a5f6a）から
`chromium-bidi` のみで、**playwright 本体は一度も external 化されていない**＝exe はそもそも playwright を
起動できた試しがない。「以前は使えていた」は `npm run start`（tsx・非バンドル）での実行を指す。

### これは何の欠陥か

**exe ≡ source の parity 欠陥**。配布形態（exe）が開発形態（tsx）より機能が劣り、
配布を受けた人はブラウザ機能（`game_smoke` / `browser_*` / `/project` 系スキル）を**フルに使えない**。
`npx playwright install chromium`（README:61）の案内も**不十分**で、chromium を入れても
バンドルされた resolver 自体がロードできないため直らない。

## 2. 方針

**リーン＋初回セットアップ**（採用）。理由のトレードオフ:

| 案 | 内容 | 不採用理由 |
|----|------|-----------|
| 完全自己完結 | playwright + chromium を配布物に同梱 | 配布数百MB増。同梱版が**塩漬けで最新と乖離**していく |
| **リーン＋初回セットアップ（採用）** | exe は playwright を持たず、初回だけユーザー環境に導入 | chromium は `npx playwright install` で随時最新化可能。配布物が軽い |
| stopgap のみ | 生 TypeError を誘導メッセージに置換するだけ | 「フル機能が使えない」状態が残る＝不採用（誘導改善は採用案にも内包） |

## 3. 設計

### 3.1 ビルド（build-exe.js）

esbuild の `external` に `playwright` / `playwright-core` を追加（`chromium-bidi` に加えて）。
バンドルされた壊れたコピーを掴まないようにする。

```js
external: ['chromium-bidi', 'chromium-bidi/*', 'playwright', 'playwright-core'],
```

### 3.2 実行時ローダ（playwright-manager.ts `getPlaywright()`）

実行コンテキストで分岐:

- **dev / tsx（非 SEA）**: 従来どおり `await import("playwright")`。リポジトリの node_modules から解決でき、`require.resolve` も健全。
- **SEA exe**: `node:sea` の `isSea()` で判定し、`createRequire` を**実体ディスク上の node_modules** に向けて
  playwright をロードする。SEA の素の `require` を迂回し、ディスク上の非バンドル playwright を読むため
  playwright-core 内部の `require.resolve` も正常動作する。

解決順（候補: import → 各 root の `playwright` / `playwright-core`）:

1. `import("playwright")`（dev/tsx ＝ リポジトリ node_modules、 SEA では失敗してディスクへ）
2. `~/.localllm/node_modules`（管理ホーム＝skills と同居。作業フォルダ非依存）
3. 作業フォルダ `<cwd>/node_modules`

**選択方針 (2026-06 改訂)**: 「最初に読めたもの」ではなく **「対応する Chromium が実在するものを優先」**
する。playwright はライブラリ版と Chromium ビルドを 1:1 で固定するため、 ある版が読めても、 その版が
要求する Chromium が未導入なら別の (Chromium を持つ) 版を使う方が良い。
- 例: プロジェクト同梱の playwright 1.59.1 (→chromium-1217) が未導入でも、 `~/.localllm` の 1.60.0
  (→chromium-1223、 これはユーザーが MCP 等で既に導入済み) が揃っていれば、 **そちらを再利用**して
  追加ダウンロードなしでブラウザ機能が有効になる。
- `playwright-core` だけの環境 (MCP 等) も候補に含める (chromium API は同じ)。
- Chromium 実在の候補が一つも無ければ、 読めた最初の版を返す → `probe()` が「Chromium 未導入」を正しく報告。

どれも読めなければ**例外を投げず**、呼び出し側（`game_smoke` / `browser_*`）が
`ToolResult.error` として後述の誘導メッセージを返す。

```ts
// 擬似コード
async function getPlaywright() {
  if (!isSea()) return await import("playwright");      // dev
  for (const root of [homeLocalllm, cwd]) {
    const req = createRequire(path.join(root, "noop.js"));
    try { return req("playwright"); } catch { /* 次へ */ }
  }
  throw new PlaywrightNotInstalledError();               // 呼び出し側で誘導文に変換
}
```

### 3.3 セットアップ導線

`~/.localllm/` に playwright を導入する経路を用意:

- `localllm --setup`（既存フック, index.ts:64）の中で、ブラウザ機能を使うか確認し、
  Yes なら `~/.localllm` を cwd に `npm i playwright` → `npx playwright install chromium` を実行。
- もしくは独立コマンド（例 `localllm --install-browser`）。
- ネット/npm 不在でも落ちないよう best-effort。失敗時は手順を表示。

### 3.4 未導入時の誘導メッセージ（誠実化）

生 TypeError を返さず、`game_smoke` / `browser_*` から次の旨を `ToolResult.error` で返す:

> ブラウザ機能には Playwright のセットアップが必要です。`localllm --install-browser` を
> 実行してください（状態確認は `localllm --check-browser`）。
> ※ exe 版は playwright を同梱していません（リーン配布）。

注: 案内コマンドは `--install-browser`（`--setup` には導入を配線していない＝旧文面は誤り。P0-3 是正）。

### 3.5 ドキュメント整合

- `deploy/README.md:61` の「作業フォルダで `npx playwright install chromium`」を**正しい手順に修正**
  （chromium 単独では不十分だった点を是正）。
- `docs/workspace-separation.md:282`（Playwright 依存メモ）を本設計に合わせて更新。

## 4. 検証

診断用に `localllm --check-browser`（playwright をロード→headless 起動→終了し OK/誘導を表示）を追加。
ユーザーの自己診断にも使える。

### 実施済み（2026-06-06）

| # | 内容 | 結果 |
|---|------|------|
| 1 | unit: `resolvePlaywright` の import 優先 / roots 解決順 / 未導入 null / 誘導文 | ✅ 6 件 pass（`tests/browser/playwright-loader.test.ts`） |
| 2 | dev（tsx）`--check-browser` | ✅ OK（import 経路・回帰なし） |
| 3 | バンドル exe を repo 外に配置し未導入で `--check-browser` | ✅ 生 TypeError でなく**誘導メッセージ** |
| 4 | `--install-browser` で ~/.localllm へ導入 → `--check-browser` | ✅ `Loaded playwright from ~/.localllm` → 起動 OK |
| 5 | 全テスト | ✅ 640 pass / 3 skip |

導入時に chromium は最新版（headless-shell v1223）を取得 → リーン方式が「同梱塩漬け」を避ける利点を確認。

### 残課題（未実施・要・実 SEA 環境）

- 上記 3・4 は **シェルラッパ exe**（本機 = homebrew node で SEA fuse sentinel 不在のため
  実 SEA をビルドできず fallback）での検証。**実 SEA exe での end-to-end は未実施**。
- ただし成功パスは両者で同一（external 化で `import("playwright")` は実 SEA でも必ず失敗 →
  roots チェーン → `createRequire`(node:module は SEA でも利用可) で ~/.localllm をロード）。
  → 高確度で動作する見込みだが、**配布ビルド機（実 SEA が作れる環境 / Windows）で最終確認**すること。
- 本機の `deploy/localllm` は今回ラッパに退化（gitignore・再ビルド対象）。配布時は実 SEA 環境で
  `npm run build:deploy` し直す。

## B. Capability ゲート（実装済み 2026-06-06）

「未準備なのにツールを出すと、エージェントが試行→失敗を繰り返す」を根絶する。
**準備できているときだけ browser_*/game_smoke を登録**し、そうでなければツール自体を出さない。

### 判定（`src/browser/browser-capability.ts`）

- `probeBrowserCapability(config)` を起動時に一度実行（`src/index.ts`）。**ブラウザは起動しない**
  （JS 解決可否＋`chromium.executablePath()` のファイル存在のみ）。
- 強制制御（エージェント・人が決定論的に切替）:
  - env `LOCALLLM_NO_BROWSER`（強制 off）/ `LOCALLLM_FORCE_BROWSER`（強制 on, デバッグ用）
  - config `features.browser: auto|on|off`（既定 auto）。env が優先。
- 結果はモジュール内にキャッシュ。`getBrowserCapability()` で signature 変更なしに参照可。

### 反映先

1. **ツール登録の出し分け**（`src/index.ts`）: ready のときだけ `browser_*`/`game_smoke` を登録。
   未準備なら登録せず、起動時に1行通知（理由＋`--install-browser` 案内）。
2. **エージェントへの可視化**（`src/agent/system-prompt.ts`）: 無効時にシステムプロンプトへ
   「ブラウザ機能は無効。試みるな／『動く』と偽るな／ユーザーに `--install-browser` を案内せよ」を注入。
   → 試行ループ防止＋**緑の嘘防止**（検証不能なのに完成扱いしない）。

### 検証（実施済み）

| 内容 | 結果 |
|------|------|
| unit: 強制 off/on・env 優先・キャッシュ getter | ✅ 4 件（`tests/browser/browser-capability.test.ts`） |
| e2e(tsx): 強制 off → ready=false かつ system-prompt に無効 note＋`--install-browser` | ✅ |
| e2e(tsx): 強制 on → ready=true かつ note 無し | ✅ |
| 全テスト | ✅ 640 pass / 3 skip |

## A. 次フェーズ: npm 非依存の有効化【未実装 / 先送り】

> **ステータス: 未実装（2026-06-06 時点）。** ユーザー判断により先送り。
> 現行は §3.3 の npm/npx 依存版（`src/browser/install-playwright.ts`）が暫定で稼働。
> 本セクションは「将来そのまま着手再開できる」ための仕様メモ。**ここを読めば再導出不要**にすること。

### A.0 なぜやるか（動機・再確認用）

現 `--install-browser` は npm/npx に依存し、以下と矛盾する:
- 配布方針「SEA exe 単体・**Node 非依存**」（`docs/workspace-separation.md` 決定1）
- ユーザー判断「**配布物に他 OSS を内包しない**」「**ユーザーに npm を要求しない**（利用ハードル）」

→ exe 自身が依存物を取得し、npm/npx・`.cmd` spawn・配布内包のいずれも使わない形にする。

### A.1 ゴール / 受入基準（DoD）

- [ ] npm/npx を**一切** spawn しない（`install-playwright.ts` の `spawnSync(npm/npx)` を撤去）。
- [ ] 配布物（`deploy/`）に playwright を**内包しない**（取得先はユーザーの `~/.localllm`、chromium と同列）。
- [ ] `localllm --install-browser` 一発で、npm 不在の環境でも playwright(JS)+chromium が `~/.localllm` に入る。
- [ ] 取得後 `localllm --check-browser` が OK。閉域では `PLAYWRIGHT_DOWNLOAD_HOST` / レジストリミラーで代替可能。
- [ ] B（capability ゲート）は変更不要のまま機能する（解決順 `~/.localllm` のまま）。

### A.2 技術的事実（裏取り済み・2026-06-06）

- npm パッケージは単なる gzip tar。`https://registry.npmjs.org/<pkg>` の JSON metadata の
  `versions[v].dist.tarball` に tgz URL、`dist.integrity`（sha512）あり。
- `playwright` は `dependencies` に **`playwright-core`（厳密版）**のみ。よって取得対象は
  `playwright` + `playwright-core` の 2 tgz（依存解決は実質固定でよい）。
- chromium 取得はコード確認済み: `playwright-core/lib/server/registry`(`index.js:979 install()`) が
  **`https://cdn.playwright.dev`** から DL。npm 非経由。`PLAYWRIGHT_DOWNLOAD_HOST` 尊重。
- Node 標準で gzip 解凍可（`node:zlib`）。**tar 展開は標準に無い** → A.4 の判断事項。

### A.3 実装ステップ（着手時はこの順で）

1. `src/browser/registry-fetch.ts`（新規）を作る:
   - 入力: パッケージ名（`playwright` 固定版 or 範囲）。
   - metadata 取得 → tarball URL + integrity 解決 → tgz を HTTPS GET。
   - **integrity 検証**（sha512、`dist.integrity` と照合）。
   - gunzip → tar 展開して `~/.localllm/node_modules/<pkg>/` に配置。`playwright`+`playwright-core` 両方。
2. chromium 取得を npx から**プログラム呼び出し**へ置換:
   - 展開済み `~/.localllm/node_modules/playwright-core` を `createRequire` で読み、
     `registry.install([chromium])` 相当を in-process 実行（API シグネチャは着手時に
     `playwright-core/lib/server/registry/index.js` で確認。バージョン差異に注意）。
   - 代替案: `node <path>/playwright-core/cli.js install chromium` を**exe 自身を node として**
     再 exec（SEA は node なので `process.execPath` で自分を呼べる）。ただし SEA 引数受け渡しの罠に注意。
3. `installPlaywright()`（`install-playwright.ts`）の中身を 1+2 に差し替え、npm/npx 分岐を撤去。
4. 既存の誘導文・README・`--check-browser` はそのまま流用可。
5. テスト: registry-fetch を DI（fetch/展開を注入）して metadata→URL→integrity→展開の単体を固定。
   e2e は実ネット必要なので任意（CI ではモック）。

### A.4 未決事項（着手時に決める）

- **tar 展開**: ①薄い自前展開（npm tgz は ustar、~80行で可）か、②ビルド時バンドルする極小 tar lib
  （`tar-stream` 等。exe バンドルへの取り込みは「配布フォルダへの OSS 内包」とは別問題＝許容範囲か要確認）。
  → 「OSS 内包を避けたい」の射程が *配布フォルダ* なのか *exe バンドル* なのかをユーザーに確認してから決定。
- **バージョン固定**: `playwright` の版を exe ビルド版にピン留めするか、最新を引くか。
  ピン留めが安全（chromium rev と整合）。`package.json` の playwright 版を単一ソースにするのが筋。
- **オフライン/閉域**: レジストリ自体に出られない環境向けに、ローカル tgz パス指定の口を用意するか。
- **プロキシ**: `HTTPS_PROXY`/`NPM_CONFIG_REGISTRY` 相当をどこまで尊重するか。

### A.5 差し替え対象（現行の暫定実装）

- `src/browser/install-playwright.ts` … npm/npx 依存。**A 実装時に中身を置換**（ファイル冒頭コメントに暫定版の旨記載済み）。
- それ以外（ローダ `resolvePlaywright`、capability ゲート B、`--check-browser`）は **変更不要**。

### A.6 これが入るまでの安全網

B（capability ゲート）により、未準備環境では browser_*/game_smoke を**登録せず**、
エージェントは試行せず・偽らず・ユーザーに `--install-browser` を案内する。
よって A 未実装でも**破綻はしない**（機能が無効化されるだけ）。

## 5. 影響範囲（実装済みファイル＝この通り変更した）

| ファイル | 変更 | 区分 |
|----------|------|------|
| `build-exe.js` | external に `playwright`/`playwright-core` 追加 | 本実装 |
| `src/browser/playwright-manager.ts` | `resolvePlaywright()`（import 優先→roots）＋`PlaywrightNotInstalledError` | 本実装 |
| `src/browser/browser-capability.ts` | **新規**。capability プローブ＋強制制御（B） | 本実装 |
| `src/index.ts` | `--install-browser`/`--check-browser`、capability ゲートで browser_*/game_smoke を出し分け | 本実装 |
| `src/agent/system-prompt.ts` | 無効時に「試すな/偽るな/案内せよ」note 注入 | 本実装 |
| `src/config/types.ts` | `FeaturesConfig`（`features.browser`） | 本実装 |
| `src/browser/install-playwright.ts` | **新規**。npm 依存の**暫定**導入（A で置換予定。win32 は `shell:true`） | 暫定 |
| `scripts/deploy-assets/README.md` | 案内を `--install-browser` に是正（`deploy/README.md` はここから生成） | 本実装 |
| `docs/workspace-separation.md` | §282 を本設計に更新 | 本実装 |
| `tests/browser/playwright-loader.test.ts` / `browser-capability.test.ts` | **新規** 回帰テスト 10 件 | 本実装 |

注（未変更）: `game-smoke.ts`/`browser.ts` は既存の `catch → String(e)` で誘導文を表示するため改修不要。
`--setup`(setup-wizard) と `install.sh`/`install.bat` には導入を**配線していない**（導入は `--install-browser` 単独）。
