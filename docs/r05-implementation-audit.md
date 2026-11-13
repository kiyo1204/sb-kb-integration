# R05 実装・検証記録（未コミット）

以下の冒頭表と「残作業」は初回調査・内部保存サービス段階の記録。最新の実装・実行結果は末尾「実行API・画面の接続」を参照。

作業場所は`experiment-foundation/analysis-layout-repo`、branchは`codex/experiment-foundation`、HEADは`ea5319416cecf11b2ace35308c21047ac4d69d25`。既存差分を保持する。

| 対象 | 判定 | 根拠・不足 |
| --- | --- | --- |
| 完成教材版/固定Kit | 実装済み、今回未実行 | `material-catalog.ts`、migration 179107/179108の固定参照・不変trigger |
| R05開始/閲覧/削除と研究者認可 | 未実装 | `material-catalog-routes.ts`にはR05経路がなく、完成チェックは`NOT_AVAILABLE` |
| R05のMap/履歴保存領域 | 部分実装 | 未コミットmigration 179112は専用表を作るが、実行状態・期限・同一要求・同時実行の保護や実操作APIはない |
| 受理提出と実施済み記録 | 未実装 | `r05_submission_acceptances`の行追加とMap提出を結び付けるAPI/DB制約は存在しない。179112単独では完成版参照も受理済み提出も保証しない |
| 出力・研究データ分離 | 要検証 | 通常`research_events`にSessionなしのイベントを追加すると`event-export-query.ts`の共通出力対象となり得る。現在新protocolを通常Session出力が扱わないことだけでは分離の保証にならない |
| 中断後再開・完了後再テスト | 実験側の決定済み対象外 | 既存参加者フローの再開/権限移動をR05へ自動流用しない |
| 未完了削除後の新規開始 | 決定済み、未実装 | 対象テストの削除がcommitした後のみ再作成可能にする |
| 自動削除期限 | 実験側で未決定 | 期限を導入しない |

## 保存領域と適用状況

179112は今回既存ファイルとして扱い、書き換えない。直前の記録では同migrationは新規使い捨て模擬DBへ適用・検査後にDBごと削除した。実DB接続は禁止されており、その他のDBでの適用有無は今回確認できない。実装時の補強は追加migrationで行い、旧migration・旧行の変更を前提にしない。

R05用のMapと履歴を専用表に隔離し、通常Session/実施/研究イベントへ書き込まない案を採る。研究者認可・版固定検査・各状態遷移・操作受付票・削除と再開禁止のロックはサーバー側で確認する必要がある。提出受理と完成記録は同一transaction内で行い、完成記録をテストデータ削除後も保持する。削除と未完了版の再作成は、版単位のロックを共有し、削除成功のcommit後だけ新規作成を認める。完成済みの再テストは禁止し、失敗・中断を完成扱いしない。これらは設計方針であり実装済みではない。

既存`index.ts`のMap操作は`withTransaction`、Session所有、研究イベントと結び付いている。通常APIへ研究者用の認可迂回を加えず、安全な純粋関数だけを共通化するか、R05専用の処理を実装する必要がある。授業・SB・KB・統合、時間と手動/自動提出、seed、Undo/Redoや履歴、Mapの制約を実参加者用と整合させる検証も必要。

## 残作業

- 179112を補強する追加migration、研究者専用R05 API、明示削除確認と監査、専用Map/履歴操作、提出受付と一貫した受付票。
- R04から完成版限定のR05画面へ接続し、テスト中/完了後のMap・履歴を表示。既存Figmaファイルには独立R05 frameはなく、R04導線・テスト未実施dialogのみ前回読取で確認。
- 新規使い捨て模擬DBで研究者以外拒否、全通常Exportから分離、版/資材不変、手動/自動提出と記録の原子性、削除・故障・再送・同時操作、未完了削除後再作成、完成後再テスト拒否を確認。
- 実API/ブラウザーでR05全活動と既存P01〜P08、旧4/5/6の関連回帰、backend/frontend型検査・Lint・build。今回これらは実行していない。

実機LAN、複数端末、実研究データ、本番運用は未確認。通常公開ゲートは維持する。コミット・push・PR/Issue更新・既存DB接続/適用は行わない。


## 内部保存サービスの追加（今回の実行記録）

179112は変更せず、`1791130000000_guard_r05_test_storage.js`を追加。完成版参照の検査、同じ版に存在する実行の競合防止、完了記録がある版の再作成拒否、提出時刻/種別の対応、専用受付票・監査を追加した。完成記録はテスト削除後も保持する。未完了を正常削除した後は版の新規開始が可能。未完了削除と版ロックを共有するのは内部サービスの範囲で、今後追加する全Map書込みも同じロック規約を守る必要がある。

`r05-storage.ts`に研究者限定の内部作成/取得/確認付き削除を追加。開始/削除を版単位に直列化し、同キー受付票/監査/保存を同一transactionで確定。確認hashが変われば削除を拒否し、削除失敗時は全体をrollback。同キーの削除再送は保存結果を返し、再削除しない。通常Session/Map/研究イベントへ書き込まない。取得では既存の秘密検査を通す。

`verify-r05-storage.ts`を追加し既存suiteへ登録。Windows・Node v22.23.4・PostgreSQL17、新規`stage1_mock_r05_service`のみでcreate/migrate/safety/seed/checkと対象suiteが成功。研究者ロール/完成版必須、同キー並行作成、重複開始拒否、確認変更拒否、削除監査の書込み障害注入/rollback/同キー再送、cascade履歴削除、未完了削除後の新規作成、提出対応のない完成記録拒否、完成記録を残す削除、再テスト拒否、通常Session/Map/研究イベントの件数と完成版body不変を確認した。SQL fixtureの提出は内部構造検査であり、R05の画面や本物のKB判定・統合提出APIが完成した証拠ではない。時刻をJavaScript Dateで往復させず、DB内INSERT SELECTでmicrosecondを維持するfixtureにした。対象の今回実行は成功し、テストの初回失敗はなかった。

R05の活動進行・seed/KB/統合/Merge・Undo/Redoの実行API、手動/自動提出サービス、R04導線/R05画面は未実装。内部サービスとDB構造検査を、R05完成やAPI/ブラウザー受入成功とは扱わない。新機能は通常APIへ登録しておらず、通常公開ゲートも変更なし。既存の全分析/JSON/CSV内容比較、旧4/5/6全回帰、R05実API/ブラウザー、frontendの今回静的検査は未実行。backend型検査・Lint・buildは全て成功。今回作成した専用模擬DB・volume・cache/manifestは用途/ID/nonce/パスを確認して後片付け済み。


## 実行API・画面の接続

### 対象と現在の差分

- worktree: `<repository-root>`
- branch `codex/experiment-foundation`、HEAD `ea5319416cecf11b2ace35308c21047ac4d69d25`。開始時181変更項目・staged 0件。先行差分を保持し、変更対象の開始時コピーを`.local/r05-execution-before`へ保存。
- 179112/179113を書き換えず、`1791140000000_add_r05_execution.js`を追加。既存DBの適用状況は接続禁止のため未確認。今回の実行は新規使い捨て模擬DBだけ。
- Figmaの独立R05 frameは前回読取で存在せず、R04導線と未実施dialogのみ確認。本単位では既存教材画面・ConceptCanvas・デザイントークンを再利用し、Figmaを書き換えていない。

| 要件 | 現行実装/根拠 | 今回の対象検証 |
| --- | --- | --- |
| 研究者専用開始/取得/操作/削除 | `r05-routes.ts`、既存access-controlを通した後にrole再確認 | 未認証401、学習者403、実R04→R05 |
| 完成教材版・固定Kit/seed/時間 | `r05Material`が公開済み版から取得、既存不変性triggerを維持 | 未完了版の内部保存拒否（先行対象と全体のstorage検証）、固定Conceptへの更新拒否、版/通常データ不変 |
| 授業→SB→KB→統合、アンケートなし | `r05_execution.phase`とサーバー操作検査。通常Sessionを作らない | 実APIとブラウザーの全活動 |
| SB seed/自由編集 | 固定seedをCLONED_FROMとして専用Mapへ配置。seedの名称/削除は拒否、移動可 | seed変更拒否、実マウス移動/保存、通常概念追加/提出 |
| KB一致と最新保存状態での提出判定 | 共通`kit-build-feedback.ts`で確認と最終提出再判定。positionはsignature対象外 | 不一致、構造変更/古い結果拒否、移動、Undo、再確認/提出 |
| 統合自由編集/Merge/1段解除 | 専用操作と既存`releaseMerge`/履歴/UndoRedo関数を使用 | 二段Mergeの外側解除で内側保持、Undo/Redo、現在状態とreplay照合 |
| 手動/期限時自動提出 | 保存済み固定時間とDB clockで判定し、提出/履歴/完了記録/受付票を同一tx | 実MANUAL/AUTOMATIC、提出trigger故障でrollback、同キー並行再送 |
| 中断後再開なし | 開始画面内のexecution IDをRAMだけに保持。新画面は閲覧/削除のみ。明示中断は閉鎖phase | 別execution IDと中断後操作拒否、完了記録なし |
| 未完了削除後の新規開始 | 版ロックを保存/操作/削除で共有。正常削除commit後に新規作成可能 | 削除監査故障でrollback/作成拒否、同キー再送成功後に新規開始 |
| 完了記録保持・再テスト禁止 | `r05_submission_acceptances`は専用Map/履歴のcascade対象外。不変trigger/版uniqueを維持 | 完了Map削除後も記録あり、同版開始409、ブラウザーで確認 |
| 通常分析/JSON/CSVとの分離 | 専用表のみ更新。通常Session/Map/研究イベントへ書き込まない | 通常行数/共通抽出JSONの前後照合、R05 IDの通常分析/CSV/Session JSON取得404、共通イベントJSON/CSVはR05行なし |
| 自動削除期限・実データ運用 | 実験側で未決定/対象外 | 自動期限を追加しない。実機LAN/20端末/実研究データは未検証 |

### API・トランザクション

全APIは`/api/research/materials/:version/r05`配下。通常の研究者Bearer認証を使い、新しい参加者認証や通常APIの迂回を導入しない。

| Method/末尾 | 操作と拒否境界 |
| --- | --- |
| GET `/` | 完成版、専用実行/Map/履歴/処理結果、提出受理記録。readonly tx内で一貫して取得し、既存秘密検査後に送信 |
| POST `/` | UUID executionIdとIdempotency-Key。既存CREATE内部サービスの同一tx内で実行状態も初期化。未完了実行や完了記録がある版は409 |
| POST `/:id/operations` | サーバーで版/実行/実行ID/phase/revisionを確認し、版ロック→操作→Map/履歴/状態/受付票/専用成功監査をcommit。同キーは保存結果を再送 |
| GET `/:id/deletion-preview` | 所属を再確認し、Map/履歴件数と確認hashを返す |
| DELETE `/:id` | `confirmed:true`と確認hashを必須化。対象の専用データだけをcascade削除し、失敗はrollback。完了記録と固定資材は削除しない |

開始・操作・削除の応答喪失は、同じ画面のRAM内に保った要求キーで結果を再確認する。再送確認が終わるまで別編集を止め、古い要求を別の操作として自動適用しない。画面を閉じた後の再開は提供しない。ページ離脱時の中断通知はkeepaliveで送り、通知が届かなくても新画面へexecution IDを自動引継ぎしない。

自動提出は生存中の同じテスト画面が期限要求を送り、サーバーがDB時刻で検査して受理する。画面を閉じた/明示中断したテストを背景workerで勝手に完了扱いしない。オフライン・通信失敗・期限経過だけでは完了を表示せず、受理記録を取得できて初めて実施済みと表示する。通信が回復した同じ画面の要求再送と、中断後の新画面再開は区別する。通常参加者側の自動提出workerや公開ゲートは変更していない。

### KB判定・Map操作・データ分離

`index.ts`内の既存KB読取り関数/SQL/signatureを`kit-build-feedback.ts`へそのまま切り出し、通常APIとR05から共通利用する。R05では接続内のTEMP表に専用Map状態と固定Goalの読取りコピーを置く。`SET LOCAL search_path`と`ON COMMIT DROP`によりcommit/rollback後はpool接続へ残さない。固定資材の読取りは`public.`を明示する。公開のmaps/concepts/links/provenanceにR05状態を保存しない。

ConceptCanvas、v5 snapshot検証/件数/文字長/座標/サイズ制限、label検査、秘密照合、UndoRedo availability、Merge解除/replayを再利用。R05の独立した履歴は各変更のbefore/afterを保存し、通常のイベントschemaや過去ログを変更しない。失敗・拒否は専用監査に固定コードと最終HTTP結果を残し、Map差分や成功記録を作らない。通常の研究者分析、`research-export.ts`、`event-export-query.ts`等は専用R05表を参照しない。新protocolが既存Session出力の対象外であることだけに依存しない。

完成教材版そのものを更新せず、R04取得に追加の`testStatus`を返して実施済み/テストデータあり/未実施を表示。R04完成登録前のテスト不要という既存仕様も維持する。完成版の実行・結果確認・削除はR05へ接続する。

### 変更ファイル

新規: migration179114、`r05-execution.ts`、`r05-routes.ts`、`kit-build-feedback.ts`、`verify-r05-execution.ts`、`R05Page.tsx`、`r05.css`、`verify-r05-browser.ts`。
変更: `r05-storage.ts`（CREATEの同一tx初期化hook/要求hash）、`index.ts`（共通KB関数import/R05登録）、`material-catalog.ts`（追加testStatus）、`MaterialsPage.tsx`、`App.tsx`、両package.json/suite登録、既存material検証の実行可否レポート、本書、今回の検証結果。

### 今回の検証と初回失敗

環境: Windows / Node v22.23.4 / PostgreSQL17 / Edge headless / loopback / development / ONLY_SYNTHETIC。教材・コード・時間180秒/1秒などはTEST ONLY fixtureで、研究教材や実験時間の初期値ではない。

専用新規DBは`stage1_mock_r05_target`（初回）、`stage1_mock_r05_fixed`（修正後）、`stage1_mock_r05_acceptance`（ACK/故障検証）、`stage1_mock_r05_visual`（視認性/実マウス確認）、`stage1_mock_r05_full`（最終回帰）。既存DATABASE_URLを解除し、既存db:mockのID/用途/nonce/loopback検査を通して準備。

1. 初回静的検査でSQL文字列の引用、never関数の型絞込み、Express params型、未使用import、render内ref更新を検出。規則を弱めず修正。
2. 初回実API検証はKB提出→統合初期化で503。TEMP conceptsを後続資材読取りが参照していた実装不具合で、固定資材のSELECTをpublicスキーマへ明示して修正。
3. 同DBでの再試行は自動承認レビューに残留fixture汚染の理由で拒否され、実行していない。新しい専用DBへ切替。以後の対象API/実ブラウザーは成功。
4. 追加した開始/操作/削除の応答喪失では、実APIで書込み完了した応答だけをブラウザーtransportで失わせ、同キー再確認と二重作成/操作なしを確認。DB障害検証とは区別。
5. 提出受理trigger・削除監査triggerの故障は実際の専用DBに注入してrollbackと同キー再送を確認。二段Mergeと既存replayの照合も実APIで確認。
6. 画像確認後にヘッダーリンクの視認性、概念の追加位置、操作名を調整し、実マウスでseed移動保存を検証。別途静的検査/ビルド成功。Viteの500kB超chunk警告は残る。

`r05-target-suite-results.json`は初回失敗。`r05-target-fixed-*`、`r05-acceptance-*`、`r05-visual-*`はそれぞれの修正段階の対象成功。これらを最終全体suiteや過去CIと混同しない。全体suite実行中のソースは固定し、backend/frontend 62ファイルの開始時集約SHA-256は`E3073FDA54C44B1B2704B02C684976389DD5FE137E9FD6977D4AA784FDD114E6`。

### 最終結果・後片付け

最終全体suiteは54項目すべてexitCode 0（合計692,836ms）。`r05-full-suite-results.json`が各項目の結果、`r05-full-r05-execution.json`が実API/ブラウザーの結果、`r05-full-r05-storage.json`が内部保存のみの結果である。後者だけを実活動の成功根拠にはしない。今回の実行結果であり、保存済みGitHub CIとは別の証拠である。

実行した主なコマンド（Node v22.23.4をPATH先頭へ指定）:

- 対象: `npm run db:mock --prefix backend -- suite --name stage1_mock_r05_fixed`、同acceptance/visual。`RESEARCH_SUITE_ONLY=test:r05-execution`、`RESEARCH_BROWSER_CHECKS=1`。初回targetの失敗は前記のとおり。
- 全体: `npm run db:mock --prefix backend -- suite --name stage1_mock_r05_full`。`RESEARCH_SUITE_ONLY`は解除、`RESEARCH_BROWSER_CHECKS=1`。通常参加者previewの環境設定は解除した状態で開始し、既存の学習者検証だけが専用模擬previewを使う。
- `npm run typecheck --prefix backend`、`npm run lint --prefix backend`、`npm run build --prefix backend`: 成功。最終の検証コード追加後にも再実行して全て成功。
- `npm run typecheck --prefix frontend`、`npm run lint --prefix frontend`、`npm run build --prefix frontend`: 成功。既存Vite chunkサイズ警告は残る。
- `git diff --check`: 成功。先行作業ファイルのLF/CRLF警告は内容エラーではない。

全体suite終了時のbackend/frontend 62ファイル集約SHA-256は開始時と同じ`E3073FDA54C44B1B2704B02C684976389DD5FE137E9FD6977D4AA784FDD114E6`。実行中にソースを変更していない。旧4/5/6、P01〜P08、準備中の本人確認/端末登録と学習操作拒否、認可、監査、秘密保護、通常JSON/CSV、Merge解除/特徴量の登録済み回帰も全体suiteに含まれる。R05では共通イベントJSON/CSVの実ダウンロードも検査し、R05 Map/ラベルが混入せず、R05実行IDによる通常分析/Session出力が取得できないことを確認した。

最終ブラウザー画像はvisualizationsの`r05-full/r05-completed.png`と`r05-deleted-completed.png`。実R04導線、授業から統合提出、実マウスのseed移動、KB不一致/一致、開始/操作/削除応答喪失後の同キー再確認、削除後の完了記録を確認した。実機LANや複数端末での検証を意味しない。

今回作成した5つの専用模擬DBについて、container ID・用途・nonce・DB名・host bindなし・cache絶対パスを照合し、対象container/volume/cache/manifestを後片付けした。既存DBへ接続していない。厳密サンプル比較用に開始時cleanの4つの作業コピーだけをLFへ揃え、suiteが生成した開始時cleanのsurvey結果を含む5ファイルを終了後に開始時内容へ戻した。今回生成された未追跡mobile画像も削除し、先行の変更/未追跡ファイル/バックアップは保持した。単位A/B文書のSHA-256不変も確認した。

未実装/未決定のまま維持するもの: 中断後再開、完了版の再テスト、自動削除期限、通常の研究者テスト以外の実施終了/撤回/新protocol分析・Export。本単位では通常参加者の公開ゲートを開かず、実研究データ・実機LAN・20端末同時利用・本番運用は未確認。コミット・push・PR/Issue更新・既存DB適用は行わない。

終了時は同じworktree/branch/HEADのまま、`git status --porcelain=v1 --untracked-files=all`で260項目、staged 0件。未追跡の検証結果と開始時バックアップもこの件数に含む。単位A/B文書は別worktreeの既存ファイルを読み取り、変更していない。
