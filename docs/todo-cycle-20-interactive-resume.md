# ToDo: cycle 20 処理中composer・モード切替・stdout resume

- 課題ID: `GAP-INTERACTIVE-RESUME-01`
- 目的: 処理中にも見える入力欄から既存steeringを利用でき、`Shift+Tab`でmodeを切替え、session resume時に過去の標準出力も復元する。d720c4fの過大判定とSEA検出も補正して最新SHA CIまで閉じる。

## タスク一覧

- [x] 1. Codex / Claude Code公式資料と現行UXの比較
- [x] 2. d720c4fのsource・test・配布経路レビュー
- [x] 3. 処理中固定composerとstdin所有権の実装
- [x] 4. `Shift+Tab` mode循環と保存失敗rollback
- [x] 5. session別terminal transcript保存・明示resume復元・旧形式再構成
- [x] 6. background Room切替ではCLI画面を載せ替えない境界
- [x] 7. d720c4f補正（SEA capability実測、小型Qwen優先）
- [x] 8. 対象unit（162 tests）と別process E2E（8 tests）
- [x] 9. 全unit/coverage、lint、version/skill/package、audit、配布検証
- [ ] 10. task所有差分だけをstageしcommit/push
- [ ] 11. 最新push SHAのUbuntu/macOS/Windows、実PTY、Windows deploy/exe smoke監視
- [ ] 12. 評価記録とユーザー報告
