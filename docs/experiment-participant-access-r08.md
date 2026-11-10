# R08 参加者登録・コード管理・利用画面切替

## 対象と作業状態

今回の実装は、保存基盤・R03/R04・R06/R07の未コミット差分へ追加したもの。先行作業をリセット・stash・checkoutしていない。

- 作業場所: `<repository-root>`
- branch: `codex/experiment-foundation`
- HEADおよび今回確認したGitHub main: `ea5319416cecf11b2ace35308c21047ac4d69d25`
- PR #37: open・未マージ、head `f7430345885d6b9e4c00ea272acbb645d41d86d1`。mainの機能・検証には数えていない。
- Figma `eSgsQfqam4eOdVSuW8fltS` のR08 `3:167`を読み取り。概要・5枚の集計・参加者表の構成を既存UI部品で実装。Figmaの変更なし。

単位A/B文書がある元worktreeは変更しない。コミット、push、PR/Issue更新、既存DBへの適用は今回の範囲外。

## 利用開始ゲートと意図的な未実装

P01〜P08の新学習者フローが未実装のため、実施開始を有効にすると参加者が先へ進めない。依頼の安全条件に従い、**開始APIを公開せず、開始ボタンを無効に維持**する。準備完了を装う保存フラグは追加しない。

現在のfoundationのDB制約は新protocolのSessionをNOT_STARTED、4 StageをPENDINGに保ち、新Map作成も禁止している。この制約を外してテストを通すことはしない。参加者0件・1件以上の両方で開始できないことを確認する。将来の開始機能では、研究者明示操作、登録Session 1件以上、開始後の追加登録、同じ固定教材版という条件を実装・検証する必要がある。**今回、開始成功や開始後登録を確認したとは扱わない。**

R08は、未公開・模擬検証用・実参加者へのコード配布と本番実施不可を明示する。学習者コードで認証できても未公開ゲート以外は使えない。進行・Map取得/編集/提出・再送受付票による操作再実行・研究者APIを許可しない。R08にライブMap、終了・離脱・撤回・分析・Exportの仮ボタンを追加しない。

## 画面

- R07から実在するR08へのリンク。実施名、固定教材版、準備中、固定制限時間を表示。
- 予定人数、登録Session数、未開始/進行中/完了の集計。予定人数を上限としない。人物数とは呼ばない。
- 仮名の参加者ラベルを入力してSessionとコードを原子的に作成。ラベルを同一人物の一意キーにしない。
- 参加者の活動完了数、保存済み状態、コード世代、利用画面を表示。作業時間は未計測、学習操作のない最終操作は記録なしとし、推測しない。
- コードは発行直後のモーダルだけに表示し、閉じるとメモリから除く。一覧/再読込み/受付票再送では表示しない。
- 再発行は確認を挟み、同じSessionの旧コードと利用画面権を無効化する。
- 別画面は公開UUIDの候補として表示。研究者が明示的に選択・確認して切り替える。
- 390px幅では表の列幅を保ち、表内を横スクロールする。ページ全体の横はみ出しを防止。

## 追加保存契約

追加migration: `backend/migrations/1791100000000_add_experiment_participant_access.js`。過去migration・既存行を変更しない。

| テーブル | 内容・関係 |
| --- | --- |
| experiment_participant_access | 所属済み新SessionをPK/FK、現在コードのSHA-256 hash、認証世代、画面世代、現在の画面候補ID |
| experiment_client_candidates | サーバー発行UUID、同じSession・認証世代、クライアント秘密のhash、サーバー登録時刻 |
| experiment_retired_credentials | 失効hash、同じSession、旧認証世代、失効時刻。旧データ削除用revocationsと混同しない |
| experiment_access_operations | UUID要求キー、操作種、実施/Session、要求digest、安全な結果メタデータのみ。コード平文・client秘密を入れない |
| experiment_access_audit | 操作、実施/Session識別子、主体、最終HTTP status、outcome/reason/固定reason_code、サーバー時刻。本文・コード・例外詳細なし |

既存Session/Stage/Map/EventのIDや所有を維持する。認証hashは追加表に保存し、旧Sessionの認証方式・旧コードを変更しない。新protocolの既存所属表と固定教材版・Kit・時間を照合する。

PK・一意hash・FK・triggerで、別Session/別認証世代の画面指定、不正な世代変更、失効hash未記録での認証更新、履歴更新/削除、データ存在時のTRUNCATEを拒否する。コード再発行は認証世代/画面世代を各1増やし、利用画面を解除。画面切替は認証を変えず画面世代だけ1増やす。

監査識別子は失敗した対象・不存在対象も記録できるため、削除依存を作るFKにしない。これは参加者Mapイベントの新種ではなく、管理操作専用の追記型監査であり、過去研究イベントやExport契約を変えない。

DB管理者の直接改変、trigger無効化、認証hashの読み出し権限まで保証するものではない。downは新データを消さず明示拒否し、停止して前方修復する方針。通常の旧Session削除は従来どおり、新所属Sessionは前段の明示拒否ガードを保つ。

## API・トランザクション・応答

`backend/src/experiment-participant-routes.ts`、`experiment-participant-access.ts`。

| API | 主体・検査 | 成功/再送 |
| --- | --- | --- |
| GET /api/research/experiment-runs/:runId/participants | 研究者、既存管理実施、新protocol所属。共有秘密検査を適用 | 200。hash/client秘密/Map本文なし |
| POST 同上 | 研究者、準備中実施、仮名ラベルの型/長さ/秘密検査、UUID Idempotency-Key | 201。Session/Stage/seed所属/hash/受付票/成功監査を同一transaction |
| POST .../:sessionId/code | 研究者、同じ実施所属、未発行、expectedCredentialGeneration=0 | 200。保存済みコード未発行Sessionの初回発行 |
| POST .../:sessionId/code/reissue | 研究者、同じ実施所属、現在のexpectedCredentialGeneration | 200。失効hash/新hash/世代/受付票/監査を原子的に確定 |
| POST .../:sessionId/client-switch | 研究者、同じ実施/Session/認証世代の候補UUID、expectedDeviceGeneration | 200。画面世代・所有候補・受付票・監査を原子的に確定 |
| POST /api/experiment-client/claim | 認証hashから導いた本人Session。本文は空objectのみ。X-Experiment-Clientの秘密をhash照合 | 所有画面200、別候補409。いずれも学習不可 |

コード平文は32 random bytesをbase64url化した43文字で、COMMIT後の最初の成功応答だけに含む。DB・ログ・監査・受付票・要求digestに平文を保存しない。クライアント秘密も同じくhashのみ保存。

同じ操作キーをadvisory transaction lockで直列化し、違う内容の使い回しは409。同一要求再送では元受付結果メタデータを返すが、`issuedCode:null / codeDelivery:NOT_REPLAYED`とし、Session作成やコード更新を繰り返さない。成功監査は元の原子的受付と対応し、再送のたびに新しい管理操作が成立したとは数えない。

発行応答を失うとコードは復元できない。同じキーで受付済みか確認した後、研究者が**別の明示操作**として再発行する。平文再取得用DB、暗号化保管、ログからの回収機能は設けない。UIは応答不明の間だけキーを保持し、確定後の新しいフォーム送信は別要求とする。

| 失敗 | HTTP / outcome / reason | 固定コード例 |
| --- | --- | --- |
| 入力不正/秘密入りラベル | 400または422 / REJECTED / VALIDATION | access_invalid_request / access_sensitive_text |
| 親・所属・対象不一致 | 404 / REJECTED / VALIDATION | not_found |
| 世代/要求キー/所有競合 | 409 / REJECTED / CONFLICT | access_conflict / experiment_client_in_use / experiment_client_stale |
| 共通安全検査予算超過 | 422 / REJECTED / VALIDATION | safety_budget_exceeded |
| 照合障害/保存障害 | 503 / FAILURE / SERVER | safety_lookup_unavailable / access_storage_unavailable |

catchで固定コード・対処文に変換し、最終statusで管理監査を書く。外側で監査後のstatusを書き換えない。正常監査もtransactionに含め、監査途中の失敗なら変更/受付票をrollback。エラー監査はrollback後に別途試みる。DB自体の停止等で監査保存不能なら、保存済みと装わず`X-Participant-Audit-Saved:false`。例外詳細をログへ流さない。共有秘密検査を取得応答の送信前に完了する。

認証middlewareでの未認証401・旧学習者404・新学習者の研究API403/未公開409は、ルート到達前の既存認可/公開ゲートであり、管理操作成功として記録しない。全失敗に管理監査が必ず保存されると保証しない。

## 画面権・失効・競合

`access-control.ts`は旧4/5/6の認証・削除通知を維持し、該当しないtokenだけ新コードhash/失効hashを検査する。新認証の`/me`は内部proof/hashを返さず、本人Sessionと未公開状態のみを返す。claim以外の学習者経路は受付票replay前に閉じる。

認証middlewareで検証済みでも、更新時に古くなり得る。`lockExperimentProof`はhash/認証世代をaccess行のFOR UPDATE内で再照合し、再発行と同じロックを使う。`lockCurrentExperimentClient`はさらにclient hash/画面世代を検査する。利用画面切替後の古い世代の再送を通さない。今は全Map更新・提出が公開ゲートで拒否され、将来有効にする各保存/提出/自動提出ハンドラーはこれらと実施状態検査を自分のtransactionへ組み込む必要がある。今回のhelper検証だけで将来の全更新経路の安全性を確認済みとはしない。

同じ開いたページのonline復帰・再試行はメモリ内の同じ秘密を使う。別ページ・別端末・再読込みは新候補とし、自動奪取せず研究者の切替を必要とする。クライアント秘密をlocalStorageへ増設しない。認証コードの端末保管は既存認証UIのsessionStorage方式の範囲であり、実運用の安全保証ではない。古い画面の未同期Mapは取得・自動移送・自動適用しない。

秘密検査の共通lookupに現在/失効済み新コードhashとclient秘密hashを追加し、既存の現在・旧形式・失効コード検出やリクエスト予算を縮小しない。未知の任意の秘密を完全に検出する保証はない。

## 今回の模擬検証と限界

Windows / Node v22.23.4 / PostgreSQL 17 / Edge headless。全fixtureはTEST ONLYの合成データ。601秒・予定1等はテスト用で、アプリ既定値・推奨条件ではない。既存DATABASE_URLを解除し、新規専用`stage1_mock_access_target`と`stage1_mock_access_full`だけを使用。

途中の失敗・発見:

1. backend Lintのprefer-const（テスト変数）を修正。
2. frontend Lintのset-state-in-effectで初期loadが停止。fetchとイベント操作を分け、effectからの同期state更新を除去した。
3. 最初のPrettierコマンドは作業相対パスが違い対象0件で失敗。frontend内で正しいパスにして整形。
4. 対象テストは通ったが、画像確認で390px表が縦折れすることを発見。共通CSSより優先されるmin-widthを指定し、列幅と領域内scrollの回帰条件を追加して再実行。

対象API/SQLは4グループ: 原子的作成、固定4 Stage/Kit/時間、予定人数超過、認可/未公開ゲート、同キー/異内容/並行再送、初回発行、コード失効、同じSession/Stage/履歴の維持、2画面と研究者切替、古い世代拒否、書込み/成功監査障害rollback、再発行と認証済み旧proofのロック競合、平文非保存と共通秘密検査を確認。

ブラウザーは実APIで、R07→R08、commit済み登録応答の破棄→同キー再送、明示再発行の一度だけの表示、2独立contextの所有/候補→研究者切替、旧画面拒否、予定数超過、desktop/390px、ライブMapなしを確認。コード表示を閉じてから撮影する。

新protocolの非空Mapを持つ再発行は、Map作成の禁止を維持するため**未検証**。現在の空Map/Event状態とSession/4 Stage/旧Sessionを変更しないことは検証する。非空Map/将来の開始後保存・自動提出・停止競合は後段の受入条件。0人開始拒否、1人以上開始成功、開始後追加のうち、後2者は今回は未実装であり成功扱いにしない。

実行コマンド（今回の専用DBのみ、過去CIからの転載ではない）:

```powershell
# NODE_ENV=development / STAGE1_MOCK_DATA=ONLY_SYNTHETIC / 既存DATABASE_URLなし
npm run db:mock --prefix backend -- create --name stage1_mock_access_target --mock-data-only
# 各DBで migrate / safety / seed / check を実行
# ONLY=test:participant-access,test:participant-access-browser
# RESEARCH_BROWSER_CHECKS=1 / BROWSER_CHANNEL=msedge / prefix=access-target
npm run db:mock --prefix backend -- suite --name stage1_mock_access_target
# 同様に新規access_fullを作成、ONLY解除、prefix=access-full
npm run db:mock --prefix backend -- suite --name stage1_mock_access_full
npm run typecheck --prefix backend
npm run lint --prefix backend
npm run build --prefix backend
npm run typecheck --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
```

厳密サンプル比較のため開始時cleanの4文書/サンプル作業コピーのみLFへ揃え、終了後に戻す。全体suite中はコード/テストを変更しない。今回の結果を`access-target-*`/`access-full-*`へ分離し、foundation/materials/runsの過去記録やCIを今回の実行結果として扱わない。

最終件数・後片付けは終了時に追記する。模擬環境の成功は、実研究データ・実機LAN・20端末同時利用・本番運用の保証ではない。操作ログ・Map構造・特徴量から理解・困難・学習成果・認知状態を断定しない。

## 変更ファイルと後段

新規: migration179110、`experiment-participant-access.ts`、`experiment-participant-routes.ts`、`verify-participant-access.ts`、`ExperimentParticipantsPage.tsx`、`ExperimentLearnerGate.tsx`、`experiment-participants.css`、`verify-participant-access-browser.ts`、本書と今回の検証結果。

追加変更: foundationの呼出し元transaction内Session登録入口、access-controlの新認証/ゲート、共通秘密hash lookup、indexのroute登録、両package.jsonとsuite登録、AppのR08/未公開ゲート、R06/R07の導線・説明、前段runテストの「participantsは未公開」期待値のみを今回の承認に合わせる。前段の保存・教材・実施作成コードや既存data-managementの先行差分は保持。

未実装: 実施開始/終了、開始後参加者登録、離脱・撤回・停止、撤回者Export除外、R05、新学習者フロー、分析/Export、未同期端末回収。将来の有効化前には新protocolの全保存/提出/再送と世代・実施状態のtransaction境界を再確認する。

研究側未決: 具体教材・動画・seed数・全Kit使用、個別停止/再開、Study/再参加、撤回後保管/削除/backup、生成中/済みExport、活動時間、未同期端末回収、実データ運用条件。値・初期設定を追加していない。

## 最終結果（今回実行）

| 検証 | 最終結果 |
| --- | --- |
| 新規模擬DB2件のcreate/migrate/safety/seed/check | すべて成功。追加migration179110を含む |
| 対象API/SQL | 4グループ成功。修正後再実行も成功 |
| 対象R08/未公開ゲートの実API+Edge | 成功。モバイル表の条件を追加した再実行も成功 |
| 全体suite | **51件成功、失敗0**。各検証時間合計558.145秒。全体実行は1回で成功 |
| backend typecheck/Lint/build | 前述のテスト変数修正後、すべて成功 |
| frontend typecheck/Lint/build | effect修正後、すべて成功。Viteの500kB超chunk警告は残る（build成功） |
| git diff --check | 成功 |

全体には旧4/5/6、回答/JSON/CSV/特徴量、Map履歴/Undo/Redo/Merge解除、保存障害/再送/並行要求、自動提出、秘密値/認可/監査、Session削除、foundation、R03/R04、R06/R07、R08の検証を含む。開始成功・開始後登録・非空新protocol Mapでの再発行は前述のとおり未検証であり、51件に成功として紛れ込ませていない。

全体実行開始/終了の未コミットコード・設定35件の集約SHA-256は、いずれも`786B1CDE3711352858ECB824829CE3B789036BF1D27D7DF806F5983C05AA5F4B`。実行中にコード/テストを変更していない。

今回の2コンテナーはmanifestのID・name・purpose label・nonce・専用DB名・host bindなしを確認し、そのコンテナー/volumeと専用manifest/cacheだけを削除した。開始時cleanの旧サンプル4件、suite生成の旧JSON記録、一時mobile PNGを開始時へ戻した。今回の`access-target-*`/`access-full-*`と確認画像は保持する。画像は`<local-verification-artifacts>/access-r08/`。

元worktreeの単位A/B文書のSHA-256は開始時の記録と一致:

- A: `5AEDE09C4E100210E37E75B24AB70FFE392FCE9D69B44584FF65D9701B9BBE6F`
- B: `1A204A8207C16508CE0B8B91D6CC16051DFE6CB6B49C16395B1CEE12C61FA60E`

最終作業場所・branch・HEADは冒頭と同じ。先行3単位と今回差分をすべて未コミットで保持する。既存DB/研究データには接続せず、コミット・push・PR/Issue変更・新フロー公開・本番実施は行っていない。
