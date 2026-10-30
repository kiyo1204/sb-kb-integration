# PR前全体検証（2026-10-30）

指定worktree `C:\Users\kyoum\.codex\worktrees\integrate-research-event-streams\sb-kb-integration`、branch `codex/integrate-research-event-streams`、HEAD `7ae20d03b8a97dbd212e3fcc70ca6516889e089f` を維持。

## 最終結果

- ブラウザー有効・選択フィルター未設定の標準suite：28/28成功。
- 前回の5検証（data-management / link-position-browser / delivery-browser / parent-followup / map-mixed-history）は28件の内数。33件とは数えない。拡張した削除受付・位置失敗/復旧アサーションも同じスクリプト内で実行した。
- backend/frontendのtypecheck・lint・build：6/6成功。
- 別途、隔離DBのtest:mock-reset-safetyとtest:mock-reset-new-streamも成功。
- カタログ40種/468契約ケース、旧/v2/v5混在再生・Undo/Redo、v6判定、通常/自動提出、評価、再送/再起動、削除済みキュー、研究者認可とExportの整合性を確認。今回の2修正も全体suite内で維持されている。

## コマンドと証拠

backendとfrontendの各々について `npm run typecheck --prefix <対象>`、`npm run lint --prefix <対象>`、`npm run build --prefix <対象>` を実行。

環境はNODE_ENV=development、STAGE1_MOCK_DATA=ONLY_SYNTHETIC、呼出し元DATABASE_URL未設定。RESEARCH_BROWSER_CHECKS=1、RESEARCH_SUITE_ONLY未設定、RESEARCH_CHECK_REPORT_PREFIX=pr-preflight。

```text
npm run db:mock --prefix backend -- create --name stage1_mock_pr_preflight --mock-data-only
npm run db:mock --prefix backend -- migrate --name stage1_mock_pr_preflight
npm run db:mock --prefix backend -- safety --name stage1_mock_pr_preflight
npm run db:mock --prefix backend -- seed --name stage1_mock_pr_preflight
npm run db:mock --prefix backend -- check --name stage1_mock_pr_preflight
npm run db:mock --prefix backend -- suite --name stage1_mock_pr_preflight
```

[全体28件](pr-preflight-suite-results.json)、[静的6件](pr-preflight-static-results.json)、[DB整合性](pr-preflight-invariants.json)、[代表規模](pr-preflight-scale-results.json)、[コマンド・範囲・保持記録](pr-preflight-results.json)。既存のIssue/監査/5件検証の結果ファイルは上書きしない。

## 初回失敗と再実行

最初の準備では実行者がseedをsafetyより先に実行した。safetyは専用DBを明示リセットするためKit fixtureが消え、checkのSession作成が404で失敗した。失敗assert後にWindows native exit 0xC0000409も発生した。これを成功扱いにしていない。リポジトリCI定義のsafety→seed→check→suiteの順で再準備し、起動検証と全体suiteが成功した。アプリ・検証コードの修正は不要だった。

## 保持と限界

検証前にGit上の変更・未追跡ファイルをSHA-256で記録し、結果文書追記前の内容がすべて一致することを確認した。今回の変更は新規検証記録と監査2文書への今回結果の追記だけ。既存の未コミット実装・マイグレーション・検証コードは変更していない。生成キャッシュは.gitignoreの既存除外を維持する。

既存DB・研究データへ接続せず、今回新規作成した模擬DBだけを使用。専用manifestのコンテナID/purpose/nonce照合後、そのコンテナとvolumeだけを削除済み。通常Composeや既存DBは操作していない。ステージ・切替・reset・コミット・PR・GitHub操作なし。

GitHub CI実行、実機LAN、20端末同時、複数APIプロセス、本番運用は引き続き未確認。ローカル全体検証の成功から補完しない。親Issueの12確認済み/4一部確認という観測範囲は拡大しない。
