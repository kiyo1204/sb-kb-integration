# 実施終了の実装・検証記録

冒頭から「再開順」までは中断時点の記録です。再開後の最終結果は末尾を参照してください。

## 作業場所と保護
専用worktree: `experiment-end/analysis-layout-repo`、branch `codex/experiment-end`、基点main `760e536f3bb5edb10416168b17596c3d61dbc5aa`。全て未コミット。元のexperiment-foundation worktreeは切替せず、未追跡317件とバックアップ・単位A/B文書を保持。最初の同一worktree切替は自動承認レビューで拒否され、専用worktreeを作る安全な方法へ変更した。

## 確定仕様
研究者終了で活動停止。未提出は未提出保持、終了後のMap変更・提出・観測イベントを拒否。参加者は終了案内のみ、Map閲覧不可。研究者の保存記録閲覧・分析・出力は維持。本人Sessionの完了・離脱・撤回へ変換しない。通常公開ゲートは閉じたまま。コミット/push/PR/Issue更新・既存DB接続は禁止。

## 実装途中
- 追加migration179116: ENDED/ended_at、終了受付票・監査、実施行の共有ロックを使うMap/Concept/Link/学習者イベントの終了後書込みガード。旧migration未変更。
- experiment-end.ts: 研究者限定POST /api/research/experiment-runs/:runId/end、confirmed:trueとUUIDキー、RUNNINGのみ、run排他ロック、状態/時刻/受付票/監査を同一tx。拒否・失敗は接続解放後に監査。既存開始条件は維持。
- access-control/execution: 終了後は本人認証を保ったme・experiment-statusの最小応答だけ許可。他の学習者要求は409 experiment_ended。tx内世代/状態再検査を維持。
- 背景自動提出の候補検索からENDEDを除外。既存のtx内guardも維持。
- ExperimentEndBoundary: 2秒poll/focus/onlineと409検知でMapをunmountし終了案内。R08に確認付き終了ボタン、一覧終了表示、終了時刻を研究者取得/出力へ追加。
- observation-outbox: me.runState=ENDEDとexperiment_ended拒否は送信待ちを保持。ACK/削除にしない。
- 既存Appの新protocol分岐をBoundaryで包む。R05/旧protocolは変更しない。

## 今回の実行と失敗
新規使い捨てstage1_mock_end_targetだけ使用。179116のmigrate/safety/seed/check成功。Node22.23.4の公式zipをSHA-256照合して.local/end-runtimeへ展開。依存は各npm ciで準備済み。ローカル既定Node24ではなく、再開時はPATHへこのNode22を先頭追加する。

1. end-target: Export SELECTへended_atを加えたことで既存SQL障害fixtureのstartswith条件が一致せず失敗。experiment-export-pool-checks.tsの条件だけを追従（期待503は維持）。
2. end-fixed: 実ブラウザーのR08確認→活動中SB Map非表示→再読込終了案内は成功。新fixtureの観測イベントに配送ヘッダーがなく400。ヘッダーを追加。
3. end-api-fixed: fixtureが先行検証で失効したp.issuedCodeを使い401。新規登録した本人コードを使うよう修正。
4. end-integration: 対象API成功。提出済み参加者＋活動中の未提出統合Map、終了失敗rollback、4同一キー並行、Map更新が先に確定するロック競合、終了後直接API拒否、研究者JSON/CSV、NOT_SUBMITTED、終了後に期限を過ぎてもDRAFT維持。
5. end-accept: 対象experiment-researchの実API/研究者ブラウザー/学習者ブラウザー/終了ブラウザー/終了APIは成功。終了待ちの後ろに並ぶ提出が409となる検証も通過。backend lintに未使用初期代入が出たため、終了失敗前後のsnapshot一致assertを追加して意味のある検査に直した。
6. 最後に通信断→終了→復帰で未送信観測を残すブラウザーassertを追加。編集用Pythonが一度文字コード指定不足で停止したが、UTF-8を明示して追記済み。最終コマンドはtypecheck/lint/build途中でユーザー停止。session61285へCtrl-Cを送りexit1で停止。end-queueのsuiteは開始確認しておらず成功扱いしない。

frontend typecheck/lint/buildは今回成功済み（既存500kB chunk警告）。backendも以前の段階ではtypecheck/lint/build成功。ただし最終ソースに対するbackend buildと最終追加ブラウザーassertは未完了として再確認する。全体suiteはまだ一度も実行していない。

## 停止時の環境
今回作成したstage1_mock_end_targetだけID/名前/用途/nonceを照合してdocker stopした。データ・manifestは再開用に保持。既存DBに接続していない。Node22ランタイムも保持。バックアップや元worktreeを調査・削除しない。再開時は対象container/manifestを再照合して起動するか、この今回用DBだけ安全に片付けて新規対象DBを作る。全体suiteには別の新規DBを使うこと（固定fixtureの再利用不整合を避ける）。

## 再開順
1. Git状態と本メモ、変更コード・追加migrationを確認。最終の通信復帰/キュー保持ブラウザーassertを対象test:experiment-learner（RESEARCH_BROWSER_CHECKS=1/BROWSER_CHANNEL=msedge）で検証し、失敗なら修正。
2. backend最終型/Lint/build。frontendのsrc/configを新たに変更した場合だけ必要な静的検査をやり直す。
3. 終了・提出・背景自動提出の境界を再レビュー。背景自動提出は終了後抑止を実行済みだが、同時境界の追加競合確認が必要。直接状態APIの本人分離、DBguardの更新/削除、監査結果・受付票・終了日時表示も最終確認。
4. 新規使い捨てDBで全体suite。既存認可・開始・R05・旧4/5/6・分析/JSON/CSVを含める。通常公開は有効にしない。
5. 作業記録をまとめ、今回だけのDB/一時ランタイム/一時生成物を照合して片付ける。未コミットのまま報告して止める。

実機LAN・複数端末・実研究データ・本番運用は未確認。これまでのブラウザータイムアウト原因を今回修正したとは扱わない。


## 再開後の最終結果（2026-11-11 JST）

実装と模擬検証を完了し、未コミットで保持。研究者POST /api/research/experiment-runs/:runId/endはconfirmed:true/UUID Idempotency-Keyを要求する。RUNNING→ENDED/ended_at、受付票、成功監査は同一transaction。準備中は409、確認不足は400。失敗時はrollback/release後に固定の失敗監査を試み、監査不能はX-Experiment-End-Audit-Saved:falseで通知。入力・例外本文・認証値をログ/応答に含めない。

終了側はrun行の排他ロック、既存の学習書込み/観測受信/背景提出は同じrunの共有ロックで順序を確定する。終了後の要求は自己申告時刻で受け入れず拒否。Map/Concept/Link/学習者研究イベントにはDB側の終了ガードも追加。R05は専用表のままで影響させない。本人Session・Stageの進行状態は終了で変更しない。未提出Mapに提出時刻/完成状態を作らない。

参加者に許す終了後の応答は本人認証に基づくme/experiment-statusの最小状態のみ。新旧コード・世代・所属の既存検査を維持し、Map・進行・観測要求は409 experiment_ended。2秒poll/focus/online/明示409検知でMapをunmountする。通信断中の遠隔即時反映は保証しない。研究者のR08/一覧はENDED/終了時刻と「終了により停止（終了時の保存状態）」を表示。本人完了とは区別する。R08の終了確認は未提出保持・変更拒否・参加者閲覧不可・研究者閲覧保持を案内する。Figma R08の既存終了操作を同じ概要アクション領域で扱う。独自の撤回/離脱/再開/終了取消は実装しない。

outboxはme.runState=ENDEDで送信を止め、送信中にexperiment_endedが返っても対象を保持する。ACKや送信済みを捏造せず、終了を理由とする自動削除はしない。既存の容量/年齢制約は変更しない。認証コード切替は別のBoundaryインスタンスとして分離する。

### 再開後の準備・途中失敗
- 再開時Docker Engineが停止しており、最初のinspect/対象suite準備は失敗。既存DB接続は始まらず、Docker Desktopを非表示で起動して今回用のmanifest/ID/用途/nonceを照合して再開した。
- end-resume-raceのキューfixtureはNOT_APPLICABLEを用いており、既存outboxのOBSERVED/clientTimestamp契約に合わずinvalid_observation。検査を弱めずfixtureを修正。
- 新たに背景自動提出がrun共有ロックで待機する状態を実際の定期走査で作り、その後ろへ終了APIを並べて、提出が先にcommitされ保持されることを確認した。
- 初回全体end-fullは48件中47件成功後、旧run-management検証が終了API未実装の404を期待して停止。現在の仕様に合わせ、確認なし400/準備中409/状態不変を検査するよう更新した。未公開learner-tokenの404検査は維持。

### 実行・最終成功
環境はWindows/Node22.23.4/PostgreSQL17.11/Edge/loopback/ONLY_SYNTHETIC。新規使い捨てDB3件だけ使用し、実研究DBには接続しない。対象DBは中断時の今回用DBを照合して再開したもの。全体DBはそれぞれ別の新規DB。

- end-resumed-accept: 実研究者分析/JSON/CSV/履歴/学習者/終了ブラウザーを含む対象1件成功。
- end-final-target: 最終R08停止表示とキュー保持を含む対象1件成功。
- end-regression: run-management/participant-access/experiment-researchの3/3成功（117033ms）。
- end-final: 新規stage1_mock_end_finalで全体55/55成功（718830ms）。旧4/5/6、認可、監査、再送、提出・自動提出、R05分離/提出/削除、分析/出力、実ブラウザーを含む。
- backend/frontendのtypecheck/lint/buildは最終変更を含め全て成功。既存Vite chunk 500kB超警告は残る。成功済み検査は変更・失敗理由なく繰り返していない。
- 最終全体の前後でbackend/frontendソース・設定の集約SHA-256は459941952308c0fac1b46d8fce2180a9455b72af8ac12fd5b636f91fd2c3b7c7で一致。

### 実検証と条件注入の区別
製品API・既存認証・実PostgreSQLを使用。ロック競合はテスト接続が対象Map行またはrun行を保持し、pg_stat_activityで実製品要求が待機したことを確認して解放する方式。Map更新が先→終了→遅れた提出409、実背景提出が先→終了→提出保持、終了後期限到来→未提出維持を確認した。終了受付票INSERTの故障だけは今回の模擬DBへ一時triggerを追加し、UPDATE後のrollbackを確認して除去。保存値を捏造して競合成功としない。

完了・活動中・未提出の混在、4同一キー終了の成功/受付票/成功監査1件、失敗rollback、参加者の終了操作拒否、終了後直接Map GET/変更/提出/観測拒否、研究者分析/JSON/CSV取得、NOT_SUBMITTED、欠測の既存経路維持、DB直接更新拒否を照合した。ブラウザーは実R08確認から活動中SBを終了し、通信断→終了→復帰でMap非表示・終了案内、未送信キュー項目保持、再読込後終了案内を検査した。研究者表示は本人Sessionの完了へ置き換えない。

### 手順・保存物・後片付け
コマンドはnpm run typecheck/lint/build --prefix backend/frontend。DBは既存npm run db:mock --prefix backend -- create/migrate/safety/seed/check/suiteを使い、createのみ--mock-data-only、NODE_ENV=development/STAGE1_MOCK_DATA=ONLY_SYNTHETIC、既存DATABASE_URLなし。対象はRESEARCH_SUITE_ONLYで選択、全体では解除しRESEARCH_BROWSER_CHECKS=1/BROWSER_CHANNEL=msedge。結果prefixは上記。個々の記録はdocs/end-*-suite-results.json等にローカル保持し、先行結果を今回の実行と混同しない。

今回のstage1_mock_end_target/end_full/end_finalはcontainer ID/名前/用途/nonce/DB名/loopback bind/volumeとcache絶対パス/リンクなしを照合してcontainer/volume/cache/manifestを削除済み。一時Node22配布物と今回生成の未追跡mobile画像だけを削除した。suiteが生成した開始時cleanのsurvey集計だけを元に戻し、先行ファイルやバックアップは削除していない。元experiment-foundation worktreeは未編集。

追加migration179116は今回新規模擬DBだけへ適用。旧migration・旧行変換・ID置換なし。downはデータを消さず前方修復を要求する。DB管理者によるtrigger無効化を防ぐ保証ではない。通常公開ゲートは閉鎖したまま。実機LAN・複数端末・実研究データ・本番、既存DB適用/復旧、従前のUI待機タイムアウトの原因は未確認。今回コミット・push・PR/Issue更新・デプロイを行わず、この機能単位で停止する。


## 静的レビュー2件の修正と実検証（2026-11-11 JST）

前回の55/55・関連3/3とは別の、今回の変更と実行結果。通常公開・既存DB適用・コミット・push・PR/Issue更新は行わない。

### 修正ファイルと境界
- `backend/src/experiment-map-read.ts`（新規）と`backend/src/index.ts`: 新protocol参加者の`GET /api/maps/:mapId`で、本人・コード世代・画面世代・実施状態を再検査し、同じ接続/transactionでMap・Link・Kit部品を読む。実施の共有ロックと本人アクセス行のロックをHTTP `finish`まで保持する。DB読取り後に先にロックを解放してMap本文を送らない。
- 研究者と旧protocolは従来の読取り経路を使う。Undo/Redo状態GETの応答は操作可否・ID等の概要で、Map本文を返す経路ではないことも確認。
- 応答切断/エラーでは送出先を破棄してから解放。応答待機30秒、SQL/ロック待機は各statement 10秒を技術的上限として設定する。活動時間の変更ではない。成功時も読取りのみのtransactionをROLLBACKして解放し、rollback不能な接続はpoolへ戻さず破棄する。送出の定義はNodeのtransportへ渡す`finish`であり、相手端末への到達・既送信データ/端末キャッシュの消去は保証しない。
- `frontend/src/auth-client.ts`と`frontend/src/ExperimentEndBoundary.tsx`: 認証切替のメモリー上の世代を要求開始時に捕捉し、応答時の現在主体と照合する。通知には世代のみを渡し、コード平文を通知・ログ・追加永続保存へ含めない。Boundaryも現在世代に限定して通知と状態確認を適用する。同じコードの再設定だけでは世代を進めない。
- `backend/src/scripts/experiment-map-read-checks.ts`（新規）、`backend/src/scripts/experiment-map-read-response-gate.js`（新規）、`backend/src/scripts/verify-experiment-learner.ts`、`frontend/scripts/verify-experiment-end-browser.ts`: 以下の待機制御を追加。製品APIにテスト用の公開エンドポイント/認可迂回は追加していない。
- 追加migrationなし。未コミットの179116と先行変更は保持。

### 実API/DBと待機制御の区別
環境: Windows / Node22.23.4 / PostgreSQL17.11 / Edge / loopback / ONLY_SYNTHETIC。今回新規作成した`stage1_mock_end_read_target`と`stage1_mock_end_read_full`のみ使用。実PostgreSQL、製品のMap GET/終了/認証APIを使用する。

| 条件 | 待機制御と実際の確認 |
|---|---|
| Map取得が先 | 検証専用preloadが実製品応答の`ServerResponse.end`直前だけを保留。Map本文組立て後も実施がRUNNINGで、終了APIの実SQLが行ロック待機していることをpg_stat_activityで確認。送出を許可した後にHTTP finish・終了確定・Map200を照合。 |
| 送出失敗 | 同じ送出保留中に実クライアント要求をabort。finishなしで要求が失敗し、接続/transactionが解放され、後続の終了と研究者分析が完了する。 |
| 終了が先 | 検証接続で実施行を保持し、終了SQLを先に、Map要求のアクセス検査を後に並べる。待機を確認して解放し、終了が確定してMap要求は409 experiment_ended、本文にConceptがない。 |
| 終了確定後のGET | 実Map GETを再要求し409 experiment_ended。研究者分析は保存MapとNOT_SUBMITTEDを維持。 |
| Aの遅延応答 | Playwright route.fetchが製品APIから実際に受け取ったAの409応答を保留。画面内でコードBへ切り替えた後にその応答だけを返し、Bの開始画面が維持される。Bの通常要求は保留しない。 |
| B自身の終了応答 | 研究者の実終了APIでBを終了後、Bの実APIが返す409で終了案内になる。状態pollをこの検証中だけ通信abortし、pollによる遷移と取り違えない。 |

30秒の応答期限満了そのものやDBネットワーク断による10秒statement timeoutは今回実測していない。送出保留・実クライアント切断とその後の解放は実検証した。通常のネットワーク遅延・切断による端末反映遅れと、サーバーの受理順序を区別する。

### 途中失敗と最終結果
- 初回backend Lintは検証専用JSのprocess/timerグローバルで失敗。node:process/node:timersの明示importで修正。
- `end-read-target-suite-results.json`: 新規fixtureの観測送信元/順序ヘッダー不足により409。既存検査は変更せずfixtureへ正規ヘッダーを追加。
- `end-read-fixture-fixed-suite-results.json`: Map取得/終了/abortの確認は成功したが、ブラウザー待機制御がBの正常200も捕捉し409を期待して失敗。Aの最初の1要求だけを保留するよう検証を修正。
- `end-read-target-final-suite-results.json`: 対象1/1成功。授業から統合までの実フロー、終了制限、A/B切替を含む。
- `end-read-full-suite-results.json`: 今回の別新規DBで全体55/55成功。旧4/5/6、Map更新/提出/観測/背景自動提出と終了、認可・監査・冪等性・履歴・研究者分析/JSON/CSV・R05非混入/提出/削除・ブラウザーを含む。過去の全体55/55を今回の結果として流用していない。
- backend/frontendのtypecheck・Lint・buildは成功。応答error時も破棄を先行する最終補強後にbackendの3検査を再実行し成功。既存Viteの500kB chunk警告は残る。

コマンドはNode22をPATH先頭にして、`npm run typecheck|lint|build --prefix backend|frontend`を各々実行。模擬DBは既存の`npm run db:mock --prefix backend -- create|migrate|safety|seed|check|suite --name <今回のDB名>`を使用し、createは`--mock-data-only`付き。通常のDATABASE_URLは未設定。対象はRESEARCH_SUITE_ONLY=test:experiment-learner、全体は解除。RESEARCH_BROWSER_CHECKS=1/BROWSER_CHANNEL=msedge。

最終ソース指紋（backend/frontendの追跡・未追跡ts/tsx/js/json/css、node_modules/dist除外、ソートしたパスと各SHA-256をLF連結したSHA-256）は`1320bf9731efcaa112066f08437ae8fb68cf3dae09f9fe2dd387046ce830b655`。検証対象の最終補強後と全体suite後に一致。

### 後片付け・未確認
2つの今回用DBはmanifest/ID/用途/nonce/DB名/loopback/volume/cacheパスを照合してcontainer・volume・cache・manifestを削除済み。今回専用Node22、一時migrationログ、今回生成した未追跡mobile画像も削除済み。開始時cleanだったsuite生成のsurvey集計のみ元に戻した。失敗/成功の結果JSONは区別してローカル保持し、先行未追跡ファイル・バックアップ・単位A/B文書は保持。

通常公開ゲートは閉じたまま。R05の方式・通常の開始/終了・所属契約を変更せず、R05の自動提出は従来どおり画面要求型。実研究データ・既存DB適用/復旧・実機LAN・実端末での複数端末・本番運用は未確認。従前のUIタイムアウト原因も未特定のまま。


## Map読取り期限修正の停止チェックポイント（2026-11-11 JST）

ユーザーの「再開できるようにして一旦止めて」により停止。全体suiteは完了していない。旧55/55と今回の対象成功を、今回の全体成功と混同しない。

### 保存した実装
- `backend/src/experiment-map-read.ts`: ヘルパー入場からの期限（標準30秒）にpool取得待ちを含める。各SQLのstatement_timeoutをmin(10秒,残り時間)にし、期限/切断でAbortControllerに通知して後続SQLを拒否。処理中SQLは別の専用Clientからpg_cancel_backendを要求し、対象接続は取消処理が終わるまでcheckout状態で維持する。中断接続はstream破棄＋release(true)で再利用しない。通常例外はrollback、rollback待ちも最大1秒/残時間で破棄へ移る。解放済みflagと取消Promiseのcatchで二重解放/未処理拒否を防ぐ。既に切断された応答は取得前にも拒否。
- 認証/所属検査のうちヘルパーより前のmiddlewareは期限外。pg公開APIで削除できないpool待ちcallbackは後着接続を未使用のまま返し、SQLを開始しない。制御接続は接続/照合とも1秒を設定し強制closeするが、DBネットワーク断・DB停止・接続枠/取消権限不足・event loop停止で厳密な全処理終了時刻は保証しない。取消失敗時はDB側残時間制限とデータ接続破棄がfallback。HTTP finishは端末の受信/消去を意味しない。
- `backend/src/scripts/experiment-map-deadline-checks.ts`（新規）: 1.5秒leaseの実ヘルパー＋既存認証/実DBのテスト用HTTP route。合計SQL遅延、SQL中クライアント切断、SQL例外、pool取得待ち、idle in transactionなし、後続接続利用可を検証。
- `experiment-map-read-checks.ts` / `experiment-map-read-response-gate.js`: 既存競合検証へ短縮試験を接続。検証専用preloadのSQL遅延と、EXPERIMENT_READ_REAL_DEADLINE_CHECK=1の場合だけの実製品GETの30秒試験を追加。この環境変数は検証scriptだけが読み、製品に公開設定/APIを増やしていない。
- frontend、既存migration、公開ゲートは本作業で未変更。先行未コミット変更・未追跡ファイル・バックアップ・単位A/B文書は保持。

### 今回の実行結果
Node22.23.4（公式zip SHA-256照合）、Windows、PostgreSQL17.11、Edge、ONLY_SYNTHETIC/loopback。
- 新規stage1_mock_read_budget_targetのmigration/safety/seed/check成功。
- docs/read-budget-target-suite-results.json: 対象1/1成功、144232ms。短縮試験はsum 1650ms（SQL3本開始/2本完了、4本目は開始せず）、disconnect 111ms（実SQLを検知してabort、完了0）、SQL failure 87ms（500/rollback）、pool wait 1543ms（SQL開始0）。全例で終了操作・後続要求・poolのSELECT1とidle in transactionなしを確認。
- 実際の30秒試験は一度だけ実施。実製品GET/auth/endと実DB、各Map SELECT前に9秒pg_sleepを注入。30121ms、SQL4本目の遅延は未完了（開始4/完了3）、Map本文なし/接続close、終了が成功。前回Node24レビューの約36秒と環境を混同しない。30秒試験の再実行は不要。
- 対象で読取り先行/終了先行、応答保留/切断、終了後GET拒否、研究者分析、更新/提出/観測/背景提出制限、P01〜P08、A→B通知分離も成功。
- 最終backend typecheck/lint/build成功。対象成功後に「既に切断された応答を入場時に拒否する」2行を補強し、backend3検査を再実行して成功。frontendは未編集なので前回成功記録を利用し、今回のブラウザー回帰を実行。
- 最終ソース指紋（従前と同じ集約方式）は1c0d0dc5b829b061bea1099fff0a882a5c9f2ed408bb995eb1867b980c0a09c6。

### 中断した全体suite
新規stage1_mock_read_budget_fullでmigration/safety/seed/check成功後、RESEARCH_CHECK_REPORT_PREFIX=read-budget-full、browser=1/msedge、30秒試験flagなしで実行。停止時のdocs/read-budget-full-suite-results.jsonは50行、49成功、test:r05-executionがexitCode=4294967295（プロセス停止）で中断。suite実行セルはexit -1。R05の製品不具合として扱わず、全体未完了とする。

停止指示後、当該suiteを起動した一意のPowerShellと子プロセス16件だけを停止。対象以外のプロセスは停止しない。今回の2DBをmanifest/ID/用途/nonce/DB名で照合してdocker stopし、volume/cache/manifestは再開用に保持。既存DB・研究データには接続しない。

### 再開に必要な場所と残作業
- 作業場所は現在のexperiment-end worktree、branch codex/experiment-end、HEAD 760e536f3bb5edb10416168b17596c3d61dbc5aa。コミット/ステージ/push/PR/Issue更新なし。
- Node22ランタイムは `.local/end-deadline-runtime/node-v22.23.4-win-x64` に保持。PATH先頭へ追加して使用。
- 停止中の今回用DB: stage1_mock_read_budget_target / stage1_mock_read_budget_full。`.local/mock-reset/<name>.json`のIDとdocker inspectの用途/nonce/DB名/loopbackを再照合してから扱う。内容や認証値を出力しない。今回用の一時migrationログ2件も保持。
- 全体DBは途中のfixtureが残っているため、無条件に同じDBへsuiteを再実行しない。対象を照合して今回用DBを片付け、別の新規使い捨てDBで全体suiteを完走する。実30秒試験flagは設定しない。成功済み対象/静的検査は新たな変更がなければ再実行しない。
- 最終結果をこの文書へ追記し、今回用DB2件＋新規全体用DB、Node22一時ランタイム、今回だけの生成物を照合して片付ける。開始時cleanだったdocs/session-flow-survey-results.jsonはsuite生成で変更中。frontend/analysis-layout-mobile.png等の今回生成画像があれば対象を照合して片付ける。先行ファイルやバックアップは削除しない。
- 実機LAN、実端末の複数端末、DBネットワーク障害、既存DB適用/復旧、本番運用、従前のUIタイムアウト原因は未確認。通常公開は閉じたまま。


### 再開後の実行中記録（2026-11-11 JST）

ソース指紋1c0d0dc5b829b061bea1099fff0a882a5c9f2ed408bb995eb1867b980c0a09c6とGit状態を確認して再開。停止済みの今回用stage1_mock_read_budget_target/read_budget_fullはID/用途/nonce/DB名/volume/loopback/cacheパスを照合して削除済み。新規stage1_mock_read_budget_resumeを作成しmigration/safety/seed/check成功、read-budget-resume prefixで全体suiteを実行中（まだ成功扱いにしない）。実30秒試験flagは解除し、対象/静的検査は再実行していない。Node22の配布zipハッシュを再照合し、コンパイル済みhelperにも最終ガードがあることを読み取り確認。次は全体完了の確認、最終記録、今回用resume DBと一時ランタイム/生成物だけの後片付け。


### 再開全体での検査範囲の修正

read-budget-resumeは54行（53成功、test:experiment-researchの短縮試験で1失敗）。失敗はexperiment-map-deadline-checks.tsの全DBのidle in transaction件数が1だったこと。最初の保持元PID/SQLは未記録のため不明で、製品の接続漏れと断定しない。読取り専用test poolにランダムなapplication_nameを付け、当該接続のidle件数を検査するよう変更。pool待機caseでは別の正当なBEGIN/SELECT1を明示保持し、全DB集計だと同じ誤検出が生じること、その間も対象idle=0であることを実検証。別Txはfinallyでrollback/releaseする。製品helperへの追加変更はなし。backend typecheck/lint/build再成功後、read-budget-scoped prefixで失敗対象experiment-researchを検証中。実30秒試験は繰り返さない。対象成功後は別の新規DBで全体suiteが必要。


### 検査範囲修正後の再確認と最終全体の開始

read-budget-scoped（実API・既存認証・ブラウザー・分析Exportを含む失敗対象test:experiment-research）は1/1成功、139281ms。無関係な正当Txを意図保持しても対象接続idle=0・後続利用可・終了成功を確認。全DBの瞬間値を対象接続漏れと混同しない検査とした。製品helperは未変更。backend typecheck/lint/build成功済み。最終ソース集約指紋は31808011d0ba326c8d3b90f66a61e2db54ce089fa57d17ac1002d18e84feb8cc。

別の新規stage1_mock_read_budget_final / read-budget-final prefixで全体suiteを開始（完了までは成功扱いにしない）。実30秒flagは解除、成功済み静的検査は再実行なし。今回保持中のDBはread_budget_resume（失敗調査用）とread_budget_final（最終用）の2件。古いtarget/fullは削除済み。一時Node22と今回のmigrationログ4件は最後に照合して片付ける。全体suite実行セル27813。


## Map読取り期限修正：最終完了（2026-11-11 JST）

- 最終全体 `read-budget-final-suite-results.json` は55/55成功、総検証時間889166ms。Node22.23.4 / Windows / PostgreSQL17.11 / Edge / 新規使い捨てDBのみ。旧4/5/6、認可・監査・再送、Map読取り/更新/手動提出/背景自動提出/観測、履歴、研究者分析/JSON/CSV、R05、P01〜P08、A→B通知分離の関連回帰を含む。過去の55/55や停止された49件成功を今回の完走と混同しない。
- 短縮期限・切断・例外・pool待機は実ヘルパー/実PostgreSQL/既存認証を使うテストHTTPルートで確認。製品GET本体の30秒・SQL遅延試験は停止前の対象検証で一度だけ実施済み（30121ms、4本目未完了）。今回の全体はこの実30秒flagを設定せず、通常の製品APIの競合・拒否・画面遷移を通した。短縮試験の遅延/SQL例外/クライアントabortと、未確認のDB実ネットワーク障害を区別する。
- 再開した最初の全体は検査範囲の問題で54件中1件失敗。最初のidle保持元PIDは未記録のため不明。対象接続のapplication_nameを識別し、無関係な正常Txを明示保持しても対象の未解放を見逃さず区別できる検証へ修正。対象 `read-budget-scoped-suite-results.json` 1/1成功後、別の新規DBで今回の全体を完走した。失敗記録はそのまま保持。
- backend typecheck/lint/buildは検査範囲修正後に成功。再開/最終全体中に製品コードを追加変更していない。frontendは今回未編集なので従前の成功記録を利用し静的検査を再実行せず、今回の実ブラウザー回帰を確認した。
- 今回の期限修正ソース: `backend/src/experiment-map-read.ts`、新規 `backend/src/scripts/experiment-map-deadline-checks.ts`、`backend/src/scripts/experiment-map-read-checks.ts`、`backend/src/scripts/experiment-map-read-response-gate.js`。他の先行差分は保持。追加migrationなし。
- 最終ソース指紋31808011d0ba326c8d3b90f66a61e2db54ce089fa57d17ac1002d18e84feb8ccは全体前後で一致。

### 保証範囲・制限
期限はMap読取りヘルパーへ入った時点から30秒で、同ヘルパーのpool取得待ち、SQL、送出待ちを含む。その前の認証・所属確認middlewareは含まない。pool待ちの論理取消後、pg公開APIで削除できないcallbackは待ち行列に残り得るが、後着clientを未使用で戻しSQLは開始しない。SQLには各min(10秒,残時間)のDB制限。途中取消は別の制御接続を必要とし、接続枠・取消権限・到達性が必要。取消が失敗した場合は残時間statement timeoutと接続強制破棄へfallbackする。

中断接続は再利用しない。正常なSQL例外はrollback完了後のみ再利用し、cleanupも期限/最大1秒で破棄へ移る。実時間制限はevent loopの動作とDBの割込み/通信に依存し、実ネットワーク断やDB停止まで含めてHTTP要求全体/DBロックの絶対的な30秒完了を保証しない。HTTP finishはNode transportへの送出であり、端末受信/既送信・端末保存データの消去ではない。

### 後片付け・終了状態
停止中だったtarget/fullの2DBと、調査用resume/最終用finalの2DBを、それぞれmanifest/ID/用途/nonce/DB名/loopback/volume/cache絶対パスで照合し削除済み。今回専用Node22は公式zip内容一覧と照合して削除、migration一時ログ4件と今回生成mobile画像も削除済み。開始時cleanでsuiteが生成したsurvey集計のみ元に戻した。先行未追跡ファイル・バックアップ・単位A/B文書、失敗/中断/成功の検証記録は保持。

コミット・ステージ・push・PR/Issue更新・既存DB接続/適用・デプロイ・通常公開なし。実機LAN・実端末同時利用・実研究データ・本番運用・既存DB適用/復旧、従前のUIタイムアウト原因は未確認。通常公開ゲートは閉じたまま。この機能単位で停止する。


## 保存・下書きPR準備の確認（2026-11-11 JST）

本書内の未コミット・push禁止・作業停止等は各実装/検証時点の状態を記録したもの。後続の明示依頼により、ここからはローカル保存・push・main向け下書きPR作成だけが承認された。マージ、Issue変更、既存DB適用、デプロイ、通常公開は引き続き行わない。

GitHub mainは基点760e536f3bb5edb10416168b17596c3d61dbc5aaと一致、同一headの既存PRなしを確認。ソース指紋31808011d0ba326c8d3b90f66a61e2db54ce089fa57d17ac1002d18e84feb8ccが保存済み最終55/55と一致したため、ローカルの成功済み検証は再実行していない。

保存候補は45件（製品実装13、追加migration1、設定1、検証コード8、本文書1、選別した検証記録21）。記録はread-budget-final-*.jsonの17件と、read-budget-target/full/resume/scoped-suite-results.jsonの4件。最終成功、実30秒を含む対象成功、ユーザー停止による中断、検査範囲の失敗と再確認を区別するために選んだ。JSON原記録の内容は変更しない。本文書中のその他の過去結果ファイルはローカル保持で、今回の公開対象外。

候補の相対import、検証suite/ブラウザー登録、個人環境の絶対パス・メールアドレス・既知トークン形式・秘密鍵形式・認証付きURL・固定Bearer値を検査し、公開阻害となる一致なし。検証用HTTP loopback URLや正規表現は個人PCパスではなく、JSONのauthorization/credentials等のキーは権限検証結果であることを確認。合成ID、OS/Node/CPU等の測定環境を研究参加者データと混同しない。未知形式の秘密や任意の個人情報を完全検出できたとは保証しない。

.local全体、バックアップ、単位A/B文書、元worktree、その他の中間記録は今回のコミット対象外として保持する。
