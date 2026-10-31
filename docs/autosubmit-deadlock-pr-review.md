# 自動提出デッドロック修正：PR前レビュー（2026-10-31）

## 判定

対象差分にPR作成を妨げる指摘なし。これは実機LANの再試験や本番利用の承認ではない。

起点はmain b73e18c5c3cea16d5c8173d4851b0f50efa6b2a1、専用ブランチcodex/fix-autosubmit-deadlock。元の統合worktreeの変更は含めない。

## レビューした契約

|対象|確認内容|
|---|---|
|index.tsの共通Mapロックと拒否/失敗記録|非キー更新の排他をNO KEY UPDATEで保持。Map更新・Undo/Redo・提出同士は依然競合し、イベントのFK KEY SHAREだけを不要に遮らない。|
|sessions.tsのlockSessionStageProgress|Session/Stageの更新排他・現在活動/期限/提出済み条件を維持。開始時刻の延長や活動の自動完了を追加していない。|
|system-submission.ts|期限候補をSessionロック後に再確認。監査の既存重複防止キー・SYSTEM主体を変更していない。|
|初回履歴境界・179105|既存関数定義のMap行ロックだけを変更。想定外の定義は拒否。履歴行、境界、不変性・旧追記禁止、外部キー、一意制約、スキーマv1〜v6を維持。|
|submitExpiredIntegrationMaps / withTransaction / appendMapOperationLog|Map行ロック後にDRAFT・現在活動・群・期限を再確認し、Map更新・境界・イベントを同一トランザクションで確定。保存失敗はロールバック。新たな成功偽装・広範囲リトライなし。|
|冪等性・混在履歴|成功/失敗別の既存一意制約、Map行による直列化、operation/client receipts、連番割当と再送ACKを維持。旧ログを変更・移行せず、新旧再生照合を維持。|
|研究者のGoal Map等|共通ロックは同じ更新排他を保持。データ値・保存形式・認可条件は変更しない。|

## 検証対象との対応

前回の結果は作業時刻と報告では整合するが、保存時のソース指紋がないため、それだけをPR対象の実行証拠にはしなかった。今回PRへ含めるソースで、次を新規の使い捨て模擬DBだけで再実行した。

- backend/frontendのtypecheck・lint・build：6/6成功。
- 全体suite：30/30成功（既存29＋期限競合の新検証1）。期限競合3条件とイベント保存失敗/回復の計4条件を含む。
- 新規DBに全38マイグレーションを適用。DBログのdeadlock detectedは0件。
- 検証前後の143ソース/依存定義/CIファイルのSHA-256が全一致。変更7ソースのGit blob IDも保存し、ステージする内容と照合する。後続の文書更新は実行ソースを変えない。
- 再送・並行同一キー、期限前後の群別取得、活動完了、自動提出1件、Map/境界ロールバック、混在再生、Undo/Redo、評価・Export、削除、実ブラウザー5検証を含む。
- 今回の専用DB stage1_mock_deadlock_pr_reviewだけをID/名前/purpose/nonce/loopback公開/DB名で照合後に除去。不在を確認。

実行コマンド：npm run typecheck/lint/build --prefix backend とfrontendの計6件、db:mock create/migrate/seed/suite（--name stage1_mock_deadlock_pr_review）。NODE_ENV=development、STAGE1_MOCK_DATA=ONLY_SYNTHETIC、既存DATABASE_URLなし、RESEARCH_BROWSER_CHECKS=1、BROWSER_CHANNEL=msedge。新worktreeのサンプル照合用LF/CRLF準備は終了後に元のバイト列へ戻した。静的/DB処理の今回の失敗は0件。

証拠：

- [ソース指紋・コマンド・終了コード・後片付け](autosubmit-deadlock-pr-source-verification.json)
- [今回の30検証](deadlock-pr-review-suite-results.json)
- [今回の期限4条件](deadlock-pr-review-cases.json)
- [今回の整合性検証](deadlock-pr-review-invariants.json)
- [合成データ参考計測](deadlock-pr-review-scale-results.json)（20端末同時利用ではない）

## 元作業の保持と対象外

元worktreeの7文書＋未追跡を含む16ファイルのSHA-256が一致し、元ブランチcodex/integrate-research-event-streams・HEAD 1c505f9を保持。削除ACK待ち1件の記録もそのまま。元文書・LANリハーサル成果物・docs/issue8-resume.md・.local・.vite/deps・認証情報は本PRへ含めない。

当日のLAN記録にはAPIパス/相関IDがないため、今回再現したPOST /api/sessions/:sessionId/eventsと当日の要求が同一かは未確認。実機LAN再試験、既存研究DBへの179105適用、バックアップ復元訓練、本番運用は未確認であり、他の全競合の不存在も保証しない。今回のDB検証は模擬データだけである。

この文書はPR作成前のローカルレビュー記録。GitHub CIの結果は、PRの実際のHEADとrunで別途確認する。Issue状態・チェックリストの変更やマージは行わない。
