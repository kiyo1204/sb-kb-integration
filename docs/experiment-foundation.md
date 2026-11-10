# 新実験の保存基盤（実施機能は未公開）

## 基点と範囲

2026-11-09 JST。GitHub main `ea5319416cecf11b2ace35308c21047ac4d69d25` を確認。PR #37はopen・未マージで取り込まない。専用worktree `<repository-root>`、branch `codex/experiment-foundation`、開始HEADはmain、開始statusはclean。元worktreeの単位A/B文書を移動・編集しない。

実装するのは不変教材版、実施、コード未発行の参加者Session/Stage/所属、内部取得・所有確認、公開操作拒否だけ。公開API/画面、コード発行・再発行、開始・終了、停止・撤回、編集権、分析・Export対応は追加していない。新protocolは `SBKB_INTEGRATION_V1`、活動はLESSON/PRIOR_MAP/KB_MAP/INTEGRATION_MAP。旧STAGE1_4/5/6を変更せず、新フローに群・SURVEY・回答を作らない。

## 新規保存関係

追加migration 1791070000000。既存migrationは変更せず、sessionsの許可protocolに新キーを追加し、新キーだけに保存専用CHECKと整合性検査を追加する。旧行の変換・ID置換・実施への自動所属付けはしない。

- experiment_material_versions: 不変版ID、要求キー/hash、教材名、動画参照、SB/KB/統合説明、固定Kit、統合秒数、サーバー作成時刻。
- experiment_material_seeds: 版とそのKitの概念部品の選択。重複・別Kit・公開後追加/変更/削除を拒否。
- experiment_runs: 固定版、予定人数、PREPARING、サーバー作成時刻。予定人数は非負整数の記録値で、参加者登録の上限ではない。
- experiment_run_sessions: 新規Sessionと実施の一対一所属、登録時刻、要求キー/hash。Sessionの実行IDは置換しない。
- experiment_asset_locks: Goal単位の直列化用メタデータ。教材内容の第二の正規ソースではない。

参加者Sessionは既存の人物割当triggerを通る。実施レコードはSession表へ入れず、新たなStudy所属や既存人物との推測結合を行わない。

内部サービスは研究者主体だけが作成・取得可能。publishMaterialVersion/createExperimentRun/registerExperimentSession/getMaterialVersion/getExperimentRun/getExperimentSessionを提供する。createExperimentRunには初期参加者を指定でき、実施・Session・Stage・所属・seedを一つのトランザクションで作成できる。参加者の追加作成も原子的。公開入口はPoolでトランザクションを所有し、PoolClientの再利用は内部の合成操作だけに限定する。

request_keyは各保存種別で一意。要求の正規化hashを比較し、同一要求は同じID、同キー異内容は拒否する。秘密コード・要求本文を受付票へ保存する仕組みはない。本文は教材の必要フィールドとしてだけ保存し、既存秘密値/credential-like検査を通す。取得時も既存redactionを使用する。未知秘密の完全検出は保証しない。

## 不変性と並行処理

正規データは既存Goal/Kit/Concept/Linkを使用し、教材版へ別のMap JSONを二重保存しない。Kit全体がGoalの有効概念・Linkをカバーする既存の割当条件を検査する。研究上の全Kit要素使用条件を新設したものではない。

完成版、seed、実施、参加所属は現在の保存基盤では更新・削除不可。固定対象GoalのMap行・Concept/Link行（名称・端点・座標等）、Kitと部品にDB triggerを設け、追加/更新/削除を拒否。旧Mapから固定Mapへの行移動とその逆も検査する。TRUNCATEは新基盤データがある場合に保護する。

Goal単位の専用行を実際に更新して版固定と資材更新を直列化する。advisory lockだけで古いRepeatable Readから固定を見落とさないようにし、古いsnapshotからの書込みはserialization failureとなる。保護は通常DMLとtrigger/FKが有効な権限構成の範囲。DB所有者/管理者のDDL、trigger無効化、ストレージ・バックアップの直接変更を防ぐ保証ではない。

既存APIでは安全な409 experiment_asset_frozenを返す。JSON取込みは従来どおり別IDの新しいGoal/Kitを作り、固定元を上書きしない。固定GoalからのKit再登録も拒否する。変更した資材で新版を作る操作は将来の教材管理UI/APIで扱う。動画URL参照の固定は動画内容や公開状態の不変性を保証しない。

## 所属・利用開始防止

新SessionはNOT_STARTED、コードhashなし、群なしに限定。StageはPENDINGで正確な4活動、固定版とKit/動画/制限時間/seedが一致することをcommit時にも検査する。所属不明の新Sessionはcommitできない。新protocolの進行・Map作成・コードhash設定・所属変更をDBでも拒否する。

resolveExperimentOwnershipは認証主体と実FKからSession/Stage/Mapの実施所属を解決し、他Sessionの学習者には返さない。送信された親IDを認可根拠にしない。

experimentStorageGuardは既存の公開資源経路と新Sessionの管理変更を409 experiment_storage_onlyで拒否し、照合障害は503 experiment_guard_unavailableとする。Map本文や秘密値を返さない。確認付き削除の共通処理にも拒否を追加し、所属FKによる汎用500で済ませない。新データを含む削除/人物関連付け等は後段の正式契約まで拒否する。旧データだけの経路は既存契約を維持する。

実施開始の1人以上条件、開始後追加、研究者端末切替、同一Session維持のコード再発行は後段の確定要件であり、今回実行可能にはしない。PREPARINGしか保存できず、実施・Sessionの状態変更も拒否する。将来のmigration/APIで明示的に拡張する必要がある。

## 検証方法と途中失敗

既存DATABASE_URLを解除し、NODE_ENV=development、STAGE1_MOCK_DATA=ONLY_SYNTHETIC、db:mock guardによる専用環境だけを使用。Node v22.23.4、Windows、PostgreSQL17、ブラウザー回帰はEdge。合成fixtureの文言はTEST ONLY。600秒等のfixture値は研究設定・推奨値ではない。

初回createはDocker Engine停止によりdocker_unavailable_or_request_rejectedで失敗し、DBは作成されなかった。Docker Desktopを起動後、新規stage1_mock_foundationでcreate/migrate/safety/seedが成功。最初の検証コードのtypecheck/buildは、verificationReportPathに未対応の結果名を渡したため失敗し、既存ヘルパー契約に沿う安全な結果パスに修正した。これらを最終成功と混同しない。

対象検証はtest:experiment-foundation。FOREIGN/重複seed、不完全Kit、不変SQL/実API、別IDでのJSON取込み、予定数超過登録、所属、公開開始/再発行/削除拒否、認可、途中Stage失敗時の人物/Session/実施rollback、並行再送、版固定と更新競合、古いRepeatable Read、秘密値拒否/redactionを確認する。公開フローが動いたとは扱わない。旧Session行のfingerprintも比較する。

対象用: RESEARCH_SUITE_ONLY=test:experiment-foundation、RESEARCH_CHECK_REPORT_PREFIX=foundation-targetで `npm run db:mock --prefix backend -- suite --name stage1_mock_foundation`。結果はfoundation-target-*。

全体用: 別の空のstage1_mock_foundation_fullをcreate/migrate/safety/seed/checkし、RESEARCH_SUITE_ONLYを解除、RESEARCH_BROWSER_CHECKS=1、BROWSER_CHANNEL=msedge、prefix=foundation-fullでsuite。固定を伴う新検証は既存検証の後に登録する。Windows上の旧サンプルJSON/Markdownは作業コピーの改行だけLFへ合わせ、終了後に元へ戻す。結果はfoundation-full-*。

backendのtypecheck/lint/build、既存画面回帰のためfrontendのtypecheck/lint/buildも実行する。今回の最終結果と後片付けは下に追記する。過去のmain CIを今回実行した結果として扱わない。

## 退避・未実装・未決事項

追加migrationはデータを消すdownを提供しない。異常時は新規書込みを止め、新データを保持して対応版で復旧する。旧バイナリへの単純な差戻し、新旧未対応書込みAPIの混在は安全とみなさない。今回既存DBへ適用していない。

公開API/画面、教材下書き管理、人による版系列管理、開始・終了、停止・離脱・撤回、編集権、コード発行・再発行、分析/Exportの新protocol対応は未実装。Studyの実施所属、人物の再参加、撤回後保管・物理削除、active時間、未同期回収は未決定。観測キューはMap本文のオフライン保存/回収ではない。

実研究データ・実機LAN・20端末同時利用・本番安全性は未確認。共有研究者コード、HTTP LAN、DB権限、端末保存、バックアップ等は別の運用審査を要する。構造や操作数から理解・困難・学習成果・認知状態を推定しない。コミット/push/PR/Issue更新は行わない。

## 今回の最終結果（2026-11-09 JST）

| 今回実行した検証 | 結果 |
| --- | --- |
| 新規DB 2件のcreate / migrate / safety / seed（全体用はcheckも実行） | 成功。既存DBのURLは使用しない |
| 対象suite（RESEARCH_SUITE_ONLY=test:experiment-foundation） | 成功、7検証グループ。境界ケース追加後にも再実行 |
| 全体suite（RESEARCH_BROWSER_CHECKS=1、BROWSER_CHANNEL=msedge） | 45件成功、失敗0、各検証の所要時間合計503.79秒 |
| backend: npm run typecheck / lint / build --prefix backend | すべて成功。追加した最終境界テストも型検査・Lint・build対象 |
| frontend: npm run typecheck / lint / build --prefix frontend | すべて成功。フロントコードは変更なし |
| git diff --check | 成功 |

全体suiteには旧4/5/6進行・アンケート・JSON/CSV、Goal Map転送、秘密値保護、認可、サーバー監査、冪等性、削除整合性、混在履歴再生、Merge解除、5活動複合検証、特徴量、送信回復、実API/Edgeブラウザー回帰を含む。保存済み結果は今回作成した `foundation-full-*` と `foundation-target-*`。他コミットのCI結果を流用していない。新基盤の検証は最後に実行し、資材固定が既存fixtureを変更しないようにした。

追加境界として、所属なしSessionと版設定の不一致はcommit時に拒否され行数不変、照合関数を模擬DB内で一時的に利用不能にした実API要求は503 `experiment_guard_unavailable`（例外詳細なし）、復旧後の処理成功を確認した。途中Stage書込みの注入失敗では実施・Session・人物割当を含めてrollbackし、同一要求の並行再送後は一組だけ作られた。

今回追加した保存専用拒否は409 `experiment_storage_only`、固定資材の変更は409 `experiment_asset_frozen`、確認不能は503 `experiment_guard_unavailable`。公開機能を有効化しないため、実施状態はPREPARINGから変更できず、新Sessionには認証コードhash・Mapがない。後段機能の追加時には、DB制約とAPI認可・イベント契約を一緒に拡張して再検証する必要がある。

終了時、専用manifestのcontainer ID・名前・purpose label・nonceが一致する2コンテナーだけを `docker rm --force --volumes` で削除した。対応するmanifest・検証用Exportキャッシュ、ブラウザーの一時PNGを削除し、改行調整した旧fixtureとsuiteが生成した旧結果ファイルは開始時の内容へ戻した。集計された今回の検証記録だけをdocsに残す。既存DB・他コンテナー・他worktreeは操作していない。

## 変更ファイルと最終作業状態

- 新規: `backend/migrations/1791070000000_add_experiment_foundation.js`、`backend/src/experiment-foundation.ts`、`backend/src/experiment-foundation-guard.ts`、`backend/src/scripts/verify-experiment-foundation.ts`、本書。
- 既存への限定変更: `backend/src/index.ts`（保護middleware・安全な資材拒否）、`backend/src/data-management.ts`（新所属データの削除拒否）、`backend/package.json`、`backend/src/scripts/run-research-event-suite.ts`（検証登録）。
- 今回の記録: `docs/foundation-target-{foundation,suite-results}.json` と `docs/foundation-full-{foundation,suite-results,invariants,performance,scale-results,normal-output,composite-results}.json`。

branch `codex/experiment-foundation`、HEAD `ea5319416cecf11b2ace35308c21047ac4d69d25`。全変更は未コミット。元の単位A/B文書のSHA-256は開始時と終了時で一致した。コミット、push、PR作成、Issue更新、既存DBへのmigration、実験フロー有効化は行っていない。
