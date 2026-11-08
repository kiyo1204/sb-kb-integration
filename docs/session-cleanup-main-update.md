# PR #23: 最新mainへの追従と再検証

2026-11-08。作業場所 `C:\Users\kyoum\.codex\visualizations\2026\11\06\01a1aec2-e76a-7bf2-a3f8-eb3738f49022\analysis-layout-repo`、branch `codex/session-cleanup-delete`、開始HEAD `60e52ef7895391bfc7dba9f5d61a93b10bae11b0`、開始git statusはclean。適用されるAGENTS.mdは見つからなかった。他worktreeのファイル、既存DB・研究データは変更/接続していない。

GitHubでPR #23 open/base main/上記head、PR #21 open/base `codex/goal-map-json-transfer`/head `29a1c477f98a39e4a608bea0df010ad6d323bafe` を確認。main最新は `0d2c69c9fd6e98cf71c76bca4fcb776c3f051320`（PR #36の通常merge）。#23の以前のbase SHAは `7753592`、以前のCIを今回の統合検証として扱わない。

## #21との比較と整理

両PRの変更コード・呼び出し元・検証を比較した。#23は#21の利用目的を提供する後続実装だが、HTTP契約は同一ではない。#21を取り込むと削除API/画面/テストが二重になるため、#21のcommitや旧ルートは取り込まない。#21は参照だけで、base・状態・本文は変更しない。

| 観点 | #21 | #23 |
|---|---|---|
| UI | 未開始Sessionの削除/確認 | 同じ目的。対象ID・影響範囲・共有資材保持を確認 |
| API | DELETE `/api/research/stage1/sessions/:id` | POST `/api/research/data-management/cleanup`、`confirm: DELETE_UNSTARTED` をサーバー確認 |
| 開始/学習記録 | 状態・活動・回答・イベント・提出・旧ログ・配信を拒否 | 同等の境界に加え履歴境界、研究評価/メモ、学習者操作受付票も拒否 |
| 初期資源 | DRAFT/未提出マップを許可 | 初期snapshotのConcept/Link件数・ID・ラベル・座標・接続先・Merge先との一致が必要。空に戻った過去データも拒否 |
| 監査イベント | schema4/RESEARCHERの設定系だけ許容 | 設定系の限定された種類でRESEARCHER/SYSTEMを許容。旧形式の研究者作成イベントも学習者データと混同しない。他イベントは拒否 |
| ロック | advisory＋Session行ロック | 既存確認付き削除と同じadvisory/関連表EXCLUSIVE lock。開始/回答/受付票と直列化 |
| 削除本体/監査 | 確認付き削除と共通、削除receipt/失効を利用 | 同じ方針。削除Sessionを参照する新規イベントではなく独立receiptを残す |
| 再送 | 受付票作成との親行保持は未追加 | `reliableOperation` がLEARNER scopeのSessionをFOR KEY SHAREで確認し、孤立receiptを防ぐ |
| 外部参照 | FK失敗時rollback | based_on_map_idの外部参照を事前拒否。他FKも全体rollback |
| 模擬実行の補助 | 専用mock CLI action 2件追加 | 既存suite選択機構を使用。補助actionや同機能テストを複製しない |

#23へ#21の旧DELETE API互換性を新設していない。将来両方をmainへマージすると重複するため、整理対象としては#23を残すのが適切。今回は#21のクローズ/変更は行わない。

## main取り込みと競合

最新mainをfetchし、#23へ `git merge --no-commit --no-ff origin/main`。競合は以下の3ファイルだけ。

- backend/package.json: #23 `test:session-cleanup` とmain/PR #36 `test:research-note-safety` を両方保持。
- frontend/package.json: `test:session-cleanup-browser` とmainの `test:five-flow-feedback-browser` を両方保持。features browser等も保持。
- run-research-event-suite.ts: cleanup API/UIとmainのfive-flow-composite/feature-maps、研究者自由記述保護等の全登録を1回ずつ保持。

削除本体・HomePageの確認UI・delivery-reliabilityは自動統合で保持。mainとの比較でindex.ts/research-output-safety.ts/stage1-analysis.ts/MapPage.tsxに差がないことも確認し、PR #36の予算/安全エラー/監査対応を変更しない。

## 判定・競合・回帰の再確認

`cleanupEligible`、`lockDeletionScope`、`deleteSessionData`、確認付きpreview/delete、`reliableOperation`、HomePageからAPIまで追跡。判定から削除まで1トランザクションであり、学習記録のあるSessionは409と確認付き削除画面への案内になる。共有Goal Map/KitはSession専用mapスコープに含めない。削除receiptと失効表はFKを孤立させない既存方針を利用。確認付き削除のpreview/signature/DELETE確認を弱めない。

`verify-session-cleanup.ts`を強化し、同じテスト経路で以下を確認する。#21の検証ファイルはコピーしていない。

- 旧4活動の保存形式を合成fixtureに追加（旧6活動の生成後、未開始の4活動構成へ設定）。新5/旧6と合わせて未使用初期資源の削除を検証。
- 共有Goal MapだけでなくKit定義のID・Goal Map参照・名前が変わらないこと。
- 回答先行: 回答INSERTを未commitで保持し、cleanupが表lock待ちに入ったことをpg_stat_activityで観測。回答commit後に簡易削除が拒否され、回答が残ること。
- 削除先行: Session DELETE内のテスト専用advisory barrierで削除を一時停止し、その後に回答を要求。削除commit後に回答がFKで拒否され、孤児行がないこと。勝敗を固定sleepで決めない。
- 既存の開始先行lock待ち、実API同時開始/削除、Idempotency-Key付き活動開始/削除、認可、fault注入rollback、receiptと付随行の一貫性、UIの確認・キャンセル・案内を維持。

## 今回の環境と実行

Windows/Node v22.23.4（作業プロセスのPATHだけに指定）、Docker PostgreSQL 17、Edge headless。グローバルNode・LAN環境は変更していない。既存DATABASE_URLを渡さず、development / ONLY_SYNTHETICとmock-dbのmanifest/guardだけを使う。

対象用 `stage1_mock_pr23_target_1108` はcreate/migrate/seed後、`RESEARCH_SUITE_ONLY=test:session-cleanup,test:session-cleanup-browser`、`RESEARCH_BROWSER_CHECKS=1`、`BROWSER_CHANNEL=msedge`、prefix `pr23-main-target` で `npm run db:mock --prefix backend -- suite --name stage1_mock_pr23_target_1108`。2/2 PASS。

全体用は別の空の `stage1_mock_pr23_full_1108` をcreate/migrate/safety/seed/check。リセット防護と空ストリーム実APIフローはPASS。RESEARCH_SUITE_ONLYを解除し、同じbrowser設定、prefix `pr23-main-full` で `npm run db:mock --prefix backend -- suite --name stage1_mock_pr23_full_1108`。

Windowsの既存自動生成辞書とサンプルJSON/Markdownは、その生成器のLFへ作業コピーだけを合わせてから実行する。内容/期待値を変更せず、公開差分にも含めない。実行後はmerge indexの内容へ戻す。以前のPR #36での改行差停止を今回の失敗として数えない。

backend/frontendそれぞれ `npm run typecheck --prefix …`、`lint`、`build` の6件は全てPASS。今回の対象テストに失敗はなく、以前のPR文書にあるNode24異常終了とは区別する。今回の検証結果は `pr23-main-target-suite-results.json` と `pr23-main-full-*`、以前の `cleanup-*-final` は以前の実行の証拠。

実研究データ・実機LAN・本番・20台同時利用は確認していない。既存と同じ表単位lockのため、整理削除中に他Sessionの書込みも短時間待つ可能性がある。PR/Issueのマージやクローズ、デプロイは行わない。

## 最終結果

対象2/2、全体44/44（ブラウザー11件を含む）PASS。全体の子プロセス集計 393,743ms。backend/frontend静的検査6件もPASS。全体suite内でも追加した開始/回答競合と共有資材保持、PR #36の秘密値・予算・監査・通常出力回帰が成功。今回の失敗した試行はない。初期ストリームcheck・reset防護も成功。過去の停止/成功記録とは別である。

今回の専用模擬DB2件はmanifestの名前・64桁ID・目的ラベル・nonceを照合し、コンテナー/付属volumeと専用manifest/Exportキャッシュを削除済み。PNGも削除した。既存の辞書/サンプルと自動生成された既存結果ファイルはmerge indexの内容へ戻し、今回の記録だけを追加した。
