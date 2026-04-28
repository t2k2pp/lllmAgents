# macOS セットアップ手順書 (lllmAgents / localllm)

Windows で開発されたこのプロジェクトを macOS へ移送した際に必要となるセットアップ手順と、SEA (Single Executable Application) ビルドで実際に踏んだ罠をまとめる。Apple Silicon (arm64) 前提で記述するが、Intel (x86_64) でも `process.arch` 判定により同じ流れで動く。

## 1. 前提ツール

| ツール | 必要バージョン | 入手 / 確認方法 | 備考 |
|---|---|---|---|
| Node.js | **20+ (公式 .pkg 版)** | https://nodejs.org/ から `.pkg` インストーラを使う | **homebrew の `node` は使えない**(後述) |
| npm | Node に同梱 | `npm -v` | 10 系以降を想定 |
| Xcode Command Line Tools | 最新 | `xcode-select --install` | `codesign` / `lipo` / `otool` のため |
| bash | 3.2+ | macOS に標準で入っている | `build-exe.sh` 用 |

確認コマンド:

```bash
which -a node                  # /usr/local/bin/node が出ること
/usr/local/bin/node --version  # v20 以降
codesign --version             # codesign ツール 9...
lipo -info /usr/local/bin/node # x86_64 arm64 の universal が出る想定
```

## 2. なぜ homebrew 版 node が使えないか

`brew install node` で入る `/opt/homebrew/bin/node` は **約 68KB の薄いラッパ**で、実体は `libnode.141.dylib` ほか 18 個の dylib (`/opt/homebrew/opt/...`) にダイナミックリンクされている。SEA ビルドの実装上、次の問題が起きる:

1. `npx postject` が探す sentinel 文字列 `NODE_SEA_FUSE_...` がラッパ側に存在せず、
   `Could not find the sentinel ... in the binary` で失敗する。
2. 仮に注入できても、生成された `localllm` は `/opt/homebrew/opt/*` の dylib を必要とし、
   homebrew の入っていない環境にコピーすると即起動失敗する (= 配布不能)。

公式 `.pkg` インストーラが配置する `/usr/local/bin/node` は **約 237MB の universal binary**
(`x86_64` + `arm64` の両アーキを 1 ファイルに同梱) で、`/usr/lib/libSystem.B.dylib` 等
システム標準ライブラリしか参照しない。SEA に必要なシンボル一式も内包しているのでこちらを使う。

`build-exe.sh` は両方検知し、homebrew 版が前 (PATH 順) にあっても自動で
`/usr/local/bin/node` に切り替える。両方ない場合はエラーで止まる。

## 3. 初回セットアップ手順

### 3.1 リポジトリ取得後の最初の作業 (重要)

Windows からフォルダごと移送した場合、`node_modules/` には Windows 用ネイティブバイナリ
(`@esbuild/win32-x64`, `@rollup/rollup-win32-x64-msvc` 等) が混ざっている。これを掴んだまま
`npm run` するとビルド時に

```
You installed esbuild for another platform than the one you're currently using.
... "@esbuild/win32-x64" package is present but this platform needs the
"@esbuild/darwin-arm64" package instead.
```

で失敗する。**必ず削除して入れ直すこと**。

```bash
cd /path/to/lllmAgents
rm -rf node_modules package-lock.json
npm install
```

`package-lock.json` も Windows 環境で生成されたものなので一緒に消すと混乱が少ない。

### 3.2 開発モードでの動作確認

```bash
npm run start          # tsx 経由で src/index.ts を直接実行
# 初回は --setup ウィザードが起動する
```

ここで Setup Wizard が動くなら、TypeScript ソース側は OS 差を吸収できている。

### 3.3 SEA exe (= 単一バイナリ) のビルド

```bash
bash build-exe.sh
# あるいは
./build-exe.sh
```

成功すると以下が更新される:

```
dist/localllm           # 内部ビルド成果 (約 122MB)
deploy/localllm         # 配布用 (上記をコピー + skills/ 同梱)
deploy/skills/          # ビルトインスキル (同梱)
deploy/install.sh       # 配布先での簡易インストーラ
deploy/.deploy-meta.json # ビルド時メタ情報
```

実行確認:

```bash
./deploy/localllm
# Setup Wizard が起動すれば成功
```

## 4. 実際に踏んだ罠と build-exe.sh / build-exe.js での対処

`build-exe.bat` (Windows) は `npm run build:deploy` を呼ぶだけで完結するが、macOS では
追加のステップが必須となる。各ステップの根拠:

| # | 症状 | 原因 | 対処 (実装場所) |
|---|---|---|---|
| 1 | `esbuild` が `@esbuild/win32-x64` を要求して停止 | Windows 由来の `node_modules/` を持ち越した | `node_modules` 削除後 `npm install` (`build-exe.sh` 内で `node_modules` 不在なら自動実行) |
| 2 | postject が `Could not find the sentinel` で失敗 | homebrew 版 node はシン・ラッパで fuse 文字列が無い | `build-exe.sh` 内で `pick_sea_node()` がサイズ・dylib 依存をチェックし `/usr/local/bin/node` へ自動切替 |
| 3 | postject が `Multiple occurences of sentinel` で失敗 | 公式 node は universal binary で fuse が arm64+x86_64 両方に存在する | `build-exe.js` の darwin 分岐で `lipo -info` 検出 → `lipo -thin <arch>` で現アーキだけにスリム化 |
| 4 | postject が `Can't read and write to target executable` で失敗 | Apple 純正 codesign が残っており Mach-O のセグメント書換えがブロックされる | `build-exe.js` の darwin 分岐で `codesign --remove-signature` を事前実行 |
| 5 | 2 回目以降のビルドで `EACCES: permission denied, copyfile` | `process.execPath` (= node 本体) は `r-xr-xr-x`。`copyFileSync` が mode を継ぎ、次回上書き時に書き込み拒否 | `build-exe.js` で copy 前に `unlinkSync`、copy 後に `chmodSync(0o755)` |
| 6 | ビルドした binary が `killed: 9` で即終了 | postject で改造後の Mach-O は元署名と整合しない | `build-exe.sh` 末尾で `codesign --force --sign -` (ad-hoc 署名) を `dist/localllm` と `deploy/localllm` の両方に実施 |
| 7 | 出力ファイル名が `.exe` のままで Unix 的に不自然 / `install.sh` から見つけにくい | `build-exe.js` がハードコードで `localllm.exe` を出力し、`build-deploy.js` もそれをコピーしている | `build-exe.sh` 末尾で macOS / Linux なら `dist/localllm.exe` → `dist/localllm`, `deploy/localllm.exe` → `deploy/localllm` にリネーム + `chmod +x` |

これらは **Windows ではいずれも顕在化しない**。`build-exe.bat` を Mac で動かしても解決しないので、Mac では必ず `build-exe.sh` を使う。

## 5. クリーンビルドが必要なケース

以下のときは `node_modules` から作り直す:

- 別 OS から `node_modules` ごと移送したとき (前述)
- `package.json` の依存を変更したとき
- ビルドが意味不明な native error を吐くとき

```bash
rm -rf node_modules package-lock.json dist deploy
npm install
./build-exe.sh
```

`dist/` `deploy/` は再生成されるので消して構わない (gitignore 済)。

## 6. 配布用の deploy/ を別マシンに持っていく

公式 `.pkg` 版の universal node は `arm64` と `x86_64` の両方を含むが、`build-exe.sh` は
**ビルドホストのアーキだけ**にスリム化する (`lipo -thin`)。つまり:

- Apple Silicon (M1/M2/...) でビルド → `arm64` 専用 binary
- Intel Mac でビルド → `x86_64` 専用 binary

両方サポートしたい場合は両環境でビルドして配布物を分ける。

ad-hoc 署名された Mach-O は Gatekeeper に引っかかる (初回起動時にダイアログ)。Apple Developer ID
が必要な配布なら追加で:

```bash
codesign --force --options runtime --sign "Developer ID Application: <Your Name>" deploy/localllm
xcrun notarytool submit deploy/localllm.zip --apple-id <id> --keychain-profile <profile>
```

を行うが本プロジェクトでは未対応。

## 7. 既知の警告 (無視可)

`esbuild` が出す `should be marked as external for use with "require.resolve"` 系の警告は
playwright-core 内の動的 require によるもので、SEA 実行時には Playwright のブラウザ機能を
使わない (= スキル内から `npx playwright install chromium` を別途呼ぶ) 設計のため問題ない。

## 8. 関連ファイル

| ファイル | 役割 |
|---|---|
| `build-exe.sh` | macOS / Linux 用ビルドエントリポイント。前提チェック + 後処理を担当 |
| `build-exe.bat` | Windows 用 (`npm run build:deploy` を呼ぶだけ) |
| `build-exe.js` | esbuild → SEA blob → postject 注入の本体。OS 別分岐を含む |
| `scripts/build-deploy.js` | `dist/` から `deploy/` への配布物組み立て |
| `scripts/deploy-assets/` | 配布物に同梱する `install.sh` / `install.bat` / `README.md` |
