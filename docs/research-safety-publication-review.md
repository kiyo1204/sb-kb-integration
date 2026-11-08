# PR #36 負荷制限の最終レビュー・公開前検証

2026-11-08。作業場所 `C:\Users\kyoum\.codex\worktrees\research-note-safety\analysis-layout-repo`、branch `codex/research-note-secret-protection`、開始HEAD `d0c39166a0bf0987a749640a9aaa98da7eb9255b`。開始時の13 tracked変更と、前回作成した未追跡テスト・文書・集計を保持した。

GitHubのmainは `359ae31db9d37fc25263c5aaf85d0f4e950173fe`、PR #36のbaseはmain、headは開始HEADと同じ。公開済みheadのPR/push CIは成功。mainとの差の既存commitは研究者自由記述保護1件のみであり、他PRのcommitは含めていない。

## コードレビュー

- `research-output-safety.ts` のmiddlewareはALS scope作成と終了管理だけを行い、send/jsonを書き換えない。
- `index.ts` は認証・監査・ルートより前でscopeを作る。全共通照合呼び出し元を追い、分析rawと評価/メモ、survey/assessmentのnested snapshotも同じ予算になることを確認。
- `stage1-analysis.ts`、Goal Map転送、Session raw、survey、assessmentは型付きエラーを各catchで処理する。書込みは検査後、失敗時ROLLBACK。出力は検査後に全体送信する。
- 最終statusを設定してから既存 `server-audit.ts` のsend wrapperへ入る。422はREJECTED/VALIDATION、503はFAILURE/SERVER。転送・JSON取得の既存監査対象外ルートに監査を新設しない。
- exact digestキャッシュはリクエストstore内だけに保持し、新規SHA計算前に予算を減らす。新しい照合先集合と毎回比較し、安全判定を別loadへ使い回さない。終了したscopeを再利用しない。現在/失効/旧32〜128文字/埋め込みの候補範囲・フィールドは省略しない。
- frontendは固定理由コードを安全な対処文へ変換し、失敗CSVをファイルとして保存しない。入力本文・秘密値・例外本文をエラーや監査へ追加していない。
- プロダクトschema・migration・既存イベント意味・Issue・他PRの変更はない。前回の実装報告に加えて全コード差分と呼び出し経路を再読した。

## 追加した厳密な境界回帰

`research-safety-budget-checks.ts` に以下を追加。テスト用に本番予算を変更する仕掛けは追加していない。

1. ALS scope内で異なる短い日本語を19,999件照合。20,000件目の新規SHA計算も成功する。キャッシュ済みの完全検査値の再利用は追加SHAを必要としない。別loadから20,001件目を要求すると `ResearchSafetyError(safety_budget_exceeded)`。
2. 実APIのGoal Map JSONで、概念1,000/Link2,000。title1件と、各ラベル全体＋空白区切りの一意な短い語を組み合わせ、必要SHA計算数を19,999/20,000/20,001にする。前2件は200で全要素が返り、最後は422で固定error/messageだけ、添付ヘッダーなし、部分Mapなし。
3. 既存の評価・メモ・分析・各CSV・Session・Goal Map・survey・assessmentの超過/照合DB障害回帰も維持。監査対象では応答の記録済みヘッダーと新規監査1件のoutcome/reasonを照合し、保存行・受付票の不変を確認。

上限20,000回を引き上げていない。通常20 Session・54 Map・4,000旧操作履歴の100要求は成功し、JSONの全Concept数と操作CSV200行/Sessionも確認。異なる長い入力は依然として安全側で全体拒否する。詳細と過去の修正前後測定は `research-safety-normal-scale.md`、今回の生の集計は `safety-publish-target-*` / `safety-publish-final-*`。

## 実行環境・手順

Windows 10.0.26300、Node v22.23.4（作業プロセスPATHのみ）、AMD Ryzen 7 7730U、PostgreSQL 17-alpine。既存DATABASE_URLを解除し、`NODE_ENV=development`、`STAGE1_MOCK_DATA=ONLY_SYNTHETIC`。専用 `db:mock` のguardで新規DBのみへ接続した。

- `stage1_mock_publish_target_1108`: create → migrate → seed → `RESEARCH_SUITE_ONLY=test:research-note-safety`、prefix `safety-publish-target` でsuite。対象PASS。
- backend/frontendの `npm run typecheck --prefix …` / `lint` / `build` は6件全てPASS。
- `stage1_mock_publish_full_1108`: CIどおりcreate/migrate/safety/seed/checkを実行し成功。全体suite初回は既存辞書のCRLF/LF差で停止。作業コピーの改行だけ整えて再実行したところ、既存events.jsonサンプルでも同じ差で停止した。
- `stage1_mock_publish_final_1108`: 別の空DBをcreate/migrate/seed/check。JSONを整えた最初のsuiteは既存Markdown辞書の改行差で停止した。生成サンプルのJSON/MarkdownをまとめてLFへ合わせ、単独 `test:event-export-samples` が成功した後、全体suiteを最初から再実行。サンプル内容・検証の期待値・判定は変えず、作業コピーの改行差は公開差分へ含めない。
- 単独サンプル確認の準備で研究者トークン未設定により一度停止した。合成トークンをプロセスに設定して成功。DB接続はしていない。

全体suiteのコマンド:

```powershell
# Node22を作業プロセスPATHに指定済み、DATABASE_URLは未設定
$env:NODE_ENV='development'
$env:STAGE1_MOCK_DATA='ONLY_SYNTHETIC'
$env:RESEARCH_BROWSER_CHECKS='1'
$env:BROWSER_CHANNEL='msedge'
$env:RESEARCH_CHECK_REPORT_PREFIX='safety-publish-final'
# RESEARCH_SUITE_ONLYを解除（全件）
npm run db:mock --prefix backend -- suite --name stage1_mock_publish_final_1108
```

停止した3回は `safety-publish-full-initial/second/third-suite-results.json` として最終結果から区別して残す。前半テストはtransaction rollback/独自schemaの片付けがあり、最後の再試行前にDBへ操作受付票を残す後半検証は実行されていない。

## 制約

模擬検証は実研究データ・実機LAN・20端末同時利用・本番の保証ではない。未知の秘密や保持されない過去ハッシュは完全には検出できない。最大サイズの全正常出力の成功は保証せず、未検査値のある出力は拒否する。DB全面停止時に監査を保存できることの保証でもない。

今回の対象結果は1/1成功（73,099ms）。単体の厳密境界、実JSONの厳密境界、通常規模100/100の成功、各経路の監査・拒否/障害・rollback・秘密非露出まで含む。fullsuiteの最終結果を確認してから公開する。

最終全体suiteは42/42 PASS、検証子プロセスの集計経過 370,147ms。10種類のブラウザー検証を含む。対象1/1とbackend/frontendの6静的検査もPASS。公開前レビューに未解決の阻害事項はない。リポジトリ辞書/サンプルの内容・改行は公開差分に含めず、作業開始時の形式へ戻した。

片付け完了: 今回の専用DB3件はmanifestの名前・ID・nonce・目的ラベルを確認し、コンテナーと付属volume、専用manifest/Export一時ディレクトリを削除した。PNGも削除し、開始時からの作業成果と今回の集計だけを残した。
