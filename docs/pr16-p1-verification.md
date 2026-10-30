# PR #16: マージ前レビューP1修正・回帰確認（2026-10-31 JST）

起点HEADは `7b68baf599144b098d40b84c328916c2bb113847`、既存統合worktree/ブランチを維持。開始時は `docs/issue8-resume.md` だけが未追跡で、その内容を変更せずPR対象外とした。AGENTS.mdは対象worktreeと確認した上位パスにはなかった。既存DB・研究データには接続していない。検証終了後、今回作成した2コンテナーだけをID・名前・用途・nonceで照合して削除した。専用manifestとログはローカルの無視対象として保持し、PRへ含めない。

## 修正

1. Mapのエラー応答記録を `map-failure-response.ts` で保護。接続取得を含むcallback全体の例外を捕捉し、元のHTTPコード・安全なエラーを維持してoperationOutcome/logSaved:falseを返す。切断済み応答や応答書込み失敗も未処理Promise拒否にしない。
2. 追加179104で一意制約を成功枠と非成功のoutcome別枠に分離。既存のFAILURE/REJECTED行を消さず、同じキーのSUCCESSを追加できる。Undo/RedoはSUCCESSだけを適用済みと判定し、取消の再取得はCANCELLEDだけを見る。Map/イベント/receiptの原子性、ロック、認可と本文ハッシュ検証は維持。

更新済みAPIは179104適用後に起動する。旧APIとの混在稼働やdownは行わない。既存データ入り環境への適用訓練を済ませたという意味ではない。

## 今回の実行

PowerShellでNODE_ENV=development、STAGE1_MOCK_DATA=ONLY_SYNTHETICを設定し、継承したDATABASE_URLは子プロセスの環境から除外。専用manifest・nonce・Docker ID・DB markerを検証する `db:mock` 経由だけでDBを利用した。

```powershell
npm run db:mock --prefix backend -- create --name stage1_mock_pr16_p1 --mock-data-only
npm run db:mock --prefix backend -- migrate --name stage1_mock_pr16_p1
npm run db:mock --prefix backend -- safety --name stage1_mock_pr16_p1
npm run db:mock --prefix backend -- seed --name stage1_mock_pr16_p1
# RESEARCH_SUITE_ONLY=test:map-failure-retry / prefix=pr16-p1-targeted
npm run db:mock --prefix backend -- suite --name stage1_mock_pr16_p1

npm run db:mock --prefix backend -- create --name stage1_mock_pr16_final --mock-data-only
npm run db:mock --prefix backend -- migrate --name stage1_mock_pr16_final
npm run db:mock --prefix backend -- safety --name stage1_mock_pr16_final
npm run db:mock --prefix backend -- seed --name stage1_mock_pr16_final
npm run db:mock --prefix backend -- check --name stage1_mock_pr16_final
# RESEARCH_SUITE_ONLY未設定 / RESEARCH_BROWSER_CHECKS=1 / BROWSER_CHANNEL=msedge
# RESEARCH_CHECK_REPORT_PREFIX=pr16-p1-full
npm run db:mock --prefix backend -- suite --name stage1_mock_pr16_final

npm run typecheck --prefix backend
npm run lint --prefix backend
npm run build --prefix backend
npm run typecheck --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
```

最終標準suiteは **29/29成功**（過去の28件＋test:map-failure-retry）。追加検証の8シナリオは同じsuite内で成功。型検査・Lint・ビルドは **6/6成功**。新規DBへの179104までの順次適用、リセット防護と空の新形式起動も成功。

追加テストは実APIを呼び、ログ接続拒否だけをテスト専用preloadで注入する別APIプロセスを `--unhandled-rejections=strict` で起動する。400/500・logSaved:false、プロセス生存とhealth、例外非露出を確認。通常APIではDBトリガーで更新・イベント保存を失敗させ、Undo/Redo/Link移動の同一キー回復、各4並行要求と再送、成功1件、元失敗行保持、混在再生とExportを照合する。179104の実SQLをトランザクション内の一時テーブルへ適用し、既存失敗行の保持と両一意制約も確認する。本番に障害注入用API/設定は追加していない。

[集計](pr16-p1-results.json)、[全29件](pr16-p1-full-suite-results.json)、[静的6件](pr16-p1-static-results.json)、[統合不変条件](pr16-p1-full-invariants.json)、[模擬規模計測](pr16-p1-full-scale-results.json)。統合不変条件の提出重複・unsafeAudit・設問所属不一致はすべて0。

Windows / Node24.15.0 / Edge / PostgreSQL17.11の模擬環境。20模擬Session・4000イベントの読み出し計測はSQL fixtureであり、20台同時収集や本番性能の保証ではない。

## 初回失敗と再実行の区別

- 新規preloadのthis型指定不足を型検査で検出して修正。
- 初回対象検証は、拒否状態を作るfixtureがPENDINGと非NULL開始時刻を併存させたため23514で停止。既存の研究条件は変更せずfixtureを修正。[初回結果](pr16-p1-targeted-initial-suite-results.json)を保持し、[再実行](pr16-p1-targeted-suite-results.json)は7シナリオ成功。後から追加したマイグレーション保持確認を含む最終8シナリオは全体suiteで成功した。
- 対象検証済みDBで空ストリーム専用checkを実行したため、既存21イベントの検出で拒否された。そこで新規final DBを作成し、safety→seed→check→suiteの順で成功した。通常起動のリセットや既存DBへの操作は行っていない。

## 観測限界

この記録はpush前のローカル検証結果。新HEADのGitHub CIはPR上の後続結果と区別する。接続障害はテスト専用の確定的な取得拒否であり、物理LAN/DB切断の全障害を再現したものではない。実機LAN、20端末同時、本番運用、既存研究DBへの適用と復元訓練は未確認。所属不明旧下書きの隔離保持など受け入れ済みの制約を維持し、親Issueの12確認済み/4一部確認を全面完了へ変更しない。
