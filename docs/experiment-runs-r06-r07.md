# R06 実施作成 / R07 実施一覧

## 基点と今回の範囲

2026-11-09 JST。GitHub main `ea5319416cecf11b2ace35308c21047ac4d69d25`、PR #37はopen・未マージ（head `f7430345885d6b9e4c00ea272acbb645d41d86d1`）。同PRの差分は取り込まない。

worktree `<repository-root>`、branch `codex/experiment-foundation`、HEADは上記main。前段の保存基盤179107・R03/R04の179108とコード/文書/検証記録が未コミットの状態で開始し、保持して続行した。ブランチ切替、reset、stash、他worktreeへの編集は行わない。

Figma `eSgsQfqam4eOdVSuW8fltS` のページ `0:1` を読み取り、R06/R07フレームがないことを確認した。ユーザーから「既存デザインと必須項目で進める」と回答を受け、R04 `3:88` のデザインコンテキストと既存React/CSSを再利用した。FigmaのR06/R07固有配置との一致は確認できていない。Figmaは編集しない。`primitives`ライブラリはこのリポジトリになく、既存のフォーム/ボタン/カード/テーブルを使用。静的画像アセットは追加していない。

## 実装した動作

- `/research/experiment-runs/new`（R06）: 実施名、完成教材版、予定人数を明示入力し、準備中の実施を保存する。教材や人数の初期値はない。
- `/research/experiment-runs`（R07）: 実施名、使用教材版、予定人数、登録Session数、状態、作成時刻（JST）を表示する。固定版の統合秒数も確認できる。更新/再読み込み可能。
- 研究者HomePageに実施一覧への導線を追加。既存の旧Session作成・一覧・Goal Map・R03/R04導線は保持する。
- 完成版確認は既存R04へリンクする。R08の詳細操作や開始/終了/コード操作のリンク・ボタンは置かない。
- 作成直後の登録Session数は0。作成処理はSession/Stage/Map/人物/学習イベントを作成しない。
- 保存結果が不明な通信障害では入力を保持し、「同じ内容で再試行または一覧確認」を案内する。同一ページ内の同内容再送では同じIdempotency-Keyを使う。
- 一覧更新失敗時は前回の行を保持し、その旨を表示する。登録数を0として捏造しない。

研究者画面は既存 `ResearcherOnly` で保護する。APIはaccessControlに加え研究者主体を明示確認し、学習者には作成/一覧/教材選択肢/単体取得を許可しない。

## 保存契約と追加migration

追加migration `1791090000000_add_run_management.js`。既存migrationは変更せず、既存行の変換・再関連付け・ID置換をしない。

| 追加テーブル | 契約 |
| --- | --- |
| experiment_run_catalog | run_id（既存experiment_runsへのPK/FK）、catalog_version_id（R03/R04版へのFK）、実施名、要求hash。完成カタログ版と実施の固定教材版が一致し、PREPARINGであることをDB検査。通常DMLで更新/削除不可 |
| experiment_run_audit | CREATE/READ/LIST/MATERIALS、対象実施ID、研究者主体、最終HTTP status、outcome/reason、固定理由コード、サーバー時刻。入力本文・認証値・例外詳細は保存しない。不変 |

実施本体は既存 `experiment_runs` を再利用し、二つ目の実施本体を作らない。実施名とカタログ版との結合だけを追加する。受付票は既存の一意な `experiment_runs.request_key`/request_hashと追加メタデータの要求hashで扱う。要求本文を別受付票へ複製しない。

カタログの公開APIで作成するのは、R03/R04でPUBLISHEDになった完成版を参照する新規実施だけ。前段内部サービスで既に作られた単独実施を自動的にカタログへ所属させない。R07/APIは今回の明示的な管理関連を持つ実施を表示する。内部の既存実施は既存サービスで保持されるが、移行や自動取り込みはしない。

実施の `material_version_id` が不変教材版を固定し、その参照先の `integration_seconds` を読み取る。制限時間の競合する複製列は作らず、「最新教材版」や可変設定から読み直さない。実施と固定参照が不変なので、同じ系列に次版を作っても実施の教材/秒数は変わらない。既存のGoal/Kit/部品は作成時にコピー/更新しない。

## 予定人数と登録数

予定人数は既存保存基盤の `planned_participants integer CHECK(>=0)` と内部サービスの上限2,147,483,647に合わせた非負32bit整数。これは既存の保存形式の限界であり、20人等の任意の研究上限を追加したものではない。0も明示入力して保存できる。空欄・小数・負数・文字列・保存形式外は拒否する。

登録数は `experiment_run_sessions` のSession所属行を数える。予定人数や仮名Participantの人数として扱わない。予定人数との比較で登録を拒否する処理/DB制約は追加しない。検証では既存の内部登録サービスだけを使い、予定1・所属Session2を確認する。これは試験用の合成登録であり、公開登録APIの追加ではない。

研究者開始は1人以上登録後、開始後の追加、同時編集拒否/研究者端末切替、同一Sessionを保つコード再発行は確定済み後段要件のまま。今回、その操作を公開しない。

## APIとトランザクション

| API | 内容 |
| --- | --- |
| GET /api/research/experiment-runs/material-versions | PUBLISHEDカタログ版だけ。版ID/系列/版番号/固定教材版ID/教材名/統合秒数 |
| POST /api/research/experiment-runs | name、catalogVersionId、plannedParticipantsだけを受け付け、準備中を作成。UUID Idempotency-Key必須 |
| GET /api/research/experiment-runs | 管理対象の実施一覧 |
| GET /api/research/experiment-runs/:id | 一つの実施の同じ要約情報。R08の参加者管理APIではない |

POSTは未知項目を拒否し、参加者配列・コード・制限時間・状態をクライアントから注入できない。下書きID、存在しないID、生の固定版ID（カタログ版ではないID）は選択として拒否する。

`createExperimentRunInTransaction` を追加し、既存作成処理を呼び出す。呼出し元が実施本体・実施名/完成版関連・成功監査のBEGIN/COMMITを所有する。元の独立作成サービスの挙動は変更しない。作成中の資材/監査書込み障害は全体rollbackし、Runだけを残さない。

要求キーは小文字UUIDへ正規化し、既存サービスと同じ要求キーlockを取得する。同一要求は同じID、同キー異内容は409。既存単独実施のキーと衝突した場合は取り込まず409。合成専用入口は既存実施の再利用を拒否するため、競合経路から旧実施を黙って所属させない。

完成カタログ版を検査/参照し、DB triggerでも実施の固定版との一致を検査する。新しい実施関連は変更不可。既存固定教材/seed/Goal/KitのDB保護はそのまま使う。

秘密値検査・出力redactionは既存 `loadResearchTextSafety` を再利用し、独自の検査範囲縮小はしない。POSTの名前検査と全返却情報の安全確認をCOMMIT前に済ませる。GETも検査が終わるまで本文を返さない。

## 応答と監査

既存Session/Mapの研究イベントの意味は変更しない。新しい実施管理の監査は専用表へ記録し、参加者の操作ログや旧Exportへ混ぜない。response.sendの差替えは追加しない。最終status/codeを決めてから監査・送信する。`X-Run-Audit-Saved` は監査保存の成否を表す。

| 応答 | 監査 |
| --- | --- |
| 201作成 / 200取得 | SUCCESS、reasonなし |
| 400 run_invalid_request | REJECTED / VALIDATION |
| 422 run_material_unavailable / run_sensitive_text / safety_budget_exceeded | REJECTED / VALIDATION |
| 409 run_request_conflict | REJECTED / CONFLICT |
| 503 run_storage_unavailable / safety_lookup_unavailable | FAILURE / SERVER |

拒否/失敗は固定メッセージで、本文・秘密値・例外詳細を監査・応答・ログへ入れない。成功監査を保存できない作成はrollbackする。照合/監査先そのものが停止して記録できない場合は、その事実をheader=falseで示す。

サーバーで201がcommitされた後に応答だけが失われる場合、画面は「保存失敗」と断定せず「保存状態を確認できない」と表示する。同じキーで再送して保存済み実施へ戻れる。通信到達とDB commitの違いを、監査の操作成功と混同しない。

## 互換性・保証範囲・後段

旧4/5/6のSession/Stage/Map/回答/イベント/履歴/JSON/CSVは変更しない。作成時刻はサーバーのtimestamptz、APIは従来どおりUTCのISO表現、画面はJST。既存CSVのUTC列を変更しない。

新protocol `SBKB_INTEGRATION_V1` の保存専用ガードを維持し、学習者には有効化しない。開始/終了、参加者登録/追加/コード発行再発行、停止/離脱/撤回、端末切替/編集権、R08、R05、分析/Export/未同期回収の新API・操作は作らない。

具体的な教材・動画・Goal/seed個数・統合時間値、全Kit要素使用、活動時間、撤回後保管/物理削除/バックアップ、Study所属・同一人物再参加、未同期回収・実運用条件は今回確定しない。教材版のURL固定はリンク先内容の同一性を保証しない。

不変性は通常アプリDMLとtrigger/FKが有効な範囲。DB管理者のDDL・trigger無効化等まで保証しない。新規表の破壊的downは拒否し、新規書込み停止・データ保持・対応版での復旧を前提にする。実環境への追加migration適用やデプロイは別承認。旧未対応版APIとの混在稼働を安全と扱わない。

## 今回の検証

Windows / Node v22.23.4 / PostgreSQL 17 / Edge headless。全fixtureはTEST ONLYと明記。601/777秒・予定1/2等はテスト値で、アプリ既定値や研究推奨値ではない。既存DATABASE_URLを解除し、新規の専用 `stage1_mock_runs_target` と `stage1_mock_runs_full` だけを使用する。

今回の途中失敗:

1. 対象APIは成功したが、ブラウザーの「未実装のコード操作なし」という判定が既存の認証ツールバーの「アクセスコードを切り替える」を拾い、1件と数えた。R06/R07領域に限定して再実行し、既存認証UIは削除/変更しなかった。
2. 大文字UUIDでの並行再送ケースを足した後のbackend型検査で、テストヘルパーのdefault引数がcrypto.randomUUIDの狭いtemplate型となり、stringを渡せなかった。引数をstring型と明記し、型検査/Lint/buildと対象検証を再実行した。実際のキー検査はAPI側に残す。

最終対象: API/SQL 5グループと実APIブラウザー1件。作成/再表示、版/時間/状態/0 Session、未完成/不存在拒否、人数の技術境界、同一/異内容/大文字小文字の再送・並行要求、既存単独実施を取り込まないこと、メタデータ/監査途中障害のrollback、全APIの照合障害と監査、次版の影響なし、内部登録が予定数を超えられること、新protocol開始拒否を確認する。

ブラウザーは実API接続で作成・commit済み201応答の破棄・同キー再送・R07再読込みを確認する。未完成選択肢がないこと、人数未設定/形式、JST表示、実施要約、未実装ボタンなし、デスクトップ/390px幅を確認する。一覧更新失敗・完成版なし・学習者表示ガードの一部は模擬応答。学習者のAPI拒否は実コード認証のAPI検証で別に確認する。

実行手順（今回の専用DBだけ）:

```powershell
# NODE_ENV=development、STAGE1_MOCK_DATA=ONLY_SYNTHETIC、既存DATABASE_URLなし
npm run db:mock --prefix backend -- create --name stage1_mock_runs_target --mock-data-only
npm run db:mock --prefix backend -- migrate --name stage1_mock_runs_target
npm run db:mock --prefix backend -- safety --name stage1_mock_runs_target
npm run db:mock --prefix backend -- seed --name stage1_mock_runs_target
npm run db:mock --prefix backend -- check --name stage1_mock_runs_target
# ONLY=test:run-management,test:run-management-browser / browser=1 / prefix=runs-target
npm run db:mock --prefix backend -- suite --name stage1_mock_runs_target
# runs_fullも新規create/migrate/safety/seed/check、ONLY解除、browser=1、prefix=runs-full
npm run db:mock --prefix backend -- suite --name stage1_mock_runs_full
npm run typecheck --prefix backend
npm run lint --prefix backend
npm run build --prefix backend
npm run typecheck --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
```

既存suiteのサンプル厳密比較のため、開始時cleanの4サンプル作業コピーだけ改行をLFへ揃え、終了後に戻す。今回の結果は `runs-target-*` / `runs-full-*` に分離し、以前のfoundation/materials/CI結果を今回の成功として流用しない。全体suite中はコード・テストを変更しない。

最終件数・後片付けは完了後に追記する。模擬環境の成功は実研究データ・実機LAN・20端末同時利用・本番運用の保証ではない。構造や操作数から理解・困難・学習成果を断定しない。

## 最終結果（今回実行）

| 検証 | 結果 |
| --- | --- |
| 新規模擬DB2件 create/migrate/safety/seed/check | すべて成功 |
| 対象API/SQL | 5グループ成功 |
| 対象実API/Edge R06/R07 | 成功。修正後再実行も成功 |
| 全体suite | **49件成功・失敗0**。各検証時間合計450.21秒 |
| backend typecheck/Lint/build | テスト引数型修正後にすべて成功 |
| frontend typecheck/Lint/build | すべて成功 |
| git diff --check | 成功 |

全体suiteは旧4/5/6、回答、JSON/CSV、認可、監査、秘密値保護、保存/再送/同時要求、Map履歴/Merge解除、特徴量、Session削除、保存専用基盤、R03/R04、今回R06/R07を含む。今回の全体実行は1回で成功し、対象検証と型検査の途中失敗を上記とは別に記録した。

全体suite開始時と終了時の未コミットコード/設定25件の集約SHA-256は `000c975aae1ca0333eaad276e600319cbe60348adc49dc7fb3f4850c9f4c9cec` で一致した。実行中にコード/テストを変更していない。

今回作成した2コンテナーはmanifestのcontainer ID/名前/purpose label/nonce/host bindなしを確認し、コンテナーとそのvolume、専用manifest・Exportキャッシュを削除した。検証用に改行調整した旧サンプルとsuite生成の旧JSON結果を開始時へ戻し、旧ブラウザーテストの一時PNGも削除した。今回の集計と確認画像は保存する。画像は `<local-verification-artifacts>/runs-r06-r07/`。元worktreeの単位A/B文書は以前のハッシュと一致した。

## 変更ファイルと最終作業状態

- 新規 `backend/migrations/1791090000000_add_run_management.js`、`backend/src/experiment-run-management.ts`、`backend/src/experiment-run-routes.ts`。
- `backend/src/experiment-foundation.ts`: 呼出し元トランザクション用の実施作成入口を追加。既存単独作成/参加者内部サービスは維持。
- 新規 `frontend/src/ExperimentRunsPage.tsx`、`frontend/src/experiment-runs.css`。既存`App.tsx`に研究者限定ルート、`HomePage.tsx`に一覧導線を追加。
- 新規 `backend/src/scripts/verify-run-management.ts`、`frontend/scripts/verify-run-management-browser.ts`。両package.jsonとsuiteに登録。
- `backend/src/index.ts`のルート登録、本書、`runs-target-*`/`runs-full-*`の今回の記録。前段foundation/materialsの記録は上書きしない。

最終作業場所は開始時と同じ。branch `codex/experiment-foundation`、HEAD `ea5319416cecf11b2ace35308c21047ac4d69d25`。保存基盤・R03/R04と今回差分をすべて未コミットで保持。終了前確認のGitHub mainも同SHA、PR #37はopen・未マージ。コミット、push、PR/Issue更新、既存DBへの適用、新protocolの学習者向け有効化は行っていない。
