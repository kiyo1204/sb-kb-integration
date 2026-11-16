# 旧機能・模擬Session・一時生成物の整理方針

## 目的と今回の境界

新フローの通常利用で迷う導線を減らし、過去データの閲覧・出力と検証の再現性を守る。古さ、名前、完了状態だけで削除しない。

2026-11-16に使用版とGitHubの最新mainを照合し、いずれも `6b6085ba638f8a21515be62bec5fcea285791514` と確認した。計画作成時点ではコードと運用記録の読取り、本文書の作成のみを行い、DB接続、件数・対象IDの確定、削除、テスト、稼働変更は行っていない。

関連計画は [通常Compose有効化](compose-learner-enablement.md) と [UI統一](rehearsal-ui-unification.md)。前者は有効化、後者は表示改善の記録であり、削除方針は本書に集約する。過去の検証結果は書き換えない。

## 環境の位置付け

- 既存ローカル運用記録 `operations.txt` と同じ記録領域の `handoff.json` を参照した。所在・認証ファイルの場所・起動コマンドはその記録を使い、公開文書へ複製しない。
- Composeプロジェクトは `research-system`、DBボリュームは `research-system_postgres_data`。DBの用途は既存記録に「ユーザーが模擬データ専用と確認」とあるため、再質問しない。これは用途の申告であり、DB内容を独立検査した証拠ではない。通常Composeには模擬preview専用DBと同一の用途保証が自動的に付くわけではない。
- 通常利用は明示有効・preview無効。専用checkoutとローカルoverrideで、既存の同じボリュームを使用する構成。元checkoutの `.env.example` 差分、旧イメージ、復旧用設定を保持する。
- 最新の記録時点ではWeb 5180、API、DBはloopback限定、LAN公開はPrivateネットワーク未確認のため保留。記録時点のhealthy・HTTP結果を、今回の現在稼働確認としては扱わない。
- この環境は開発・合成データの模擬運用用。実研究利用前の通信保護、アクセス制限、保存先、バックアップ・復元、運用責任者の確認は別途必要。

## 分類表

A＝新フロー通常利用に必要、B＝過去研究データの閲覧・出力に必要、C＝通常画面から隠せるが内部に残す、D＝条件付き削除候補、E＝用途不明で保留。同じファイル内に複数の役割があるため、ファイル単位の一括削除には使わない。

| 対象 | 分類 | 理由・依存先・扱い |
| --- | --- | --- |
| 教材管理 `/research/materials`、実施一覧・作成 `/research/experiment-runs`、参加者管理 | A | `MaterialsPage.tsx`、`ExperimentRunsPage.tsx`、`ExperimentParticipantsPage.tsx`。教材版・実施・Sessionの正規の準備経路。旧Session一覧との統合で所属や状態の意味を変えない。 |
| 新学習者4活動と終了案内 | A | `ExperimentLearnerPage.tsx`、`ExperimentLearnerGate.tsx`、`ExperimentEndBoundary.tsx`、backendの `experiment-*`。所属・コード/画面世代、準備中/終了後拒否、提出・期限を維持する。 |
| 研究者トップの旧Session新規作成リンク `/research/stage1/new` | C | `HomePage.tsx` → `Stage1NewSessionPage.tsx` → `/api/research/stage1/sessions`。新実施作成と混同しやすい。まず通常導線から移す/隠す案。直URL・API・既存認可はこの段階で変更しない。 |
| 旧4/5/6活動の学習入口 `/sessions/:id` と開始・進行処理 | C / B | `App.tsx`、`SessionFlowPage.tsx`、backend `sessions.ts` と `index.ts`。protocolは `STAGE1_4/5/6`。旧学習者コードの遷移、履歴閲覧、研究者のSession表示が依存する。書込み経路の廃止は別判断。個々の旧protocol用APIからも作成可能かを、廃止実装前にさらに確認する。 |
| 旧Session一覧・検索・各行の「開く」 | B / C | `HomePage.tsx` の `ResearchSessions`。新実施一覧は実施単位、こちらはSession単位であり同一ではない。新規準備の主導線から「過去Sessionの閲覧」へ整理する案。既存行の分析・削除・状態情報への到達を残す。 |
| ゴールMap管理 `/research/goal-maps` | C / A | `Stage1GoalMapsPage.tsx`、`/api/maps/:goalMapId/kits`、Kit関連処理。従来の編集入口は副次領域へ整理可能。新教材もKit定義へ依存するため、Kit取得・固定化や基礎データまで削除しない。 |
| 分析・履歴・研究イベント・JSON/CSV Export | A / B | `Stage1AnalysisPage.tsx`、`EventExportPage.tsx`、backend `stage1-analysis.ts`、`research-export.ts`、`event-export-*`、`experiment-research.ts`、混在履歴API。旧protocol別Stage配列・旧ログと新イベント・snapshot境界・由来の互換性を保持。18列CSVの `status` とMap提出情報・snapshot時点を維持する。 |
| 共有Map描画・保存・接続・Merge・Undo/Redo | A / B | `MapPage.tsx` の `ConceptCanvas`、backend Map操作・履歴/出力処理。新旧フロー、R05、練習、読取り専用表示が共有。旧画面整理を理由に削除・仕様変更しない。 |
| 旧アンケート・事前/事後評価・自習・説明回答の表示/出力 | B / C | `SessionFlowPage.tsx`、`Survey.tsx`、backend `surveys.ts`、回答・出力処理。新4活動へ導入する案ではない。過去の研究条件と回答の関連を保持する。 |
| R05教材テスト | A | `R05Page.tsx`、`r05-routes.ts`、`r05-execution.ts`、`r05-storage.ts`。通常参加Sessionとは別テーブル。準備確認として残す。テスト履歴の削除は専用の確認付き経路だけを候補とする。 |
| 任意の操作練習 | A | P02内表示と `TutorialPage.tsx`。Reactの局所状態を用い共有 `ConceptCanvas` を使用。本人Map/Stageとは別。練習往復、停止条件、既存 `/tutorial` 契約を保持する。 |
| 隔離模擬preview、mock-db、fixture、検証登録 | C | `experiment-execution.ts`、`backend/src/scripts/mock-db.ts`、検証scriptsとsuite。通常画面への案内を整理できるが、previewの分離チェック、CI・回帰の能力は残す。通常利用への有効化とは分ける。 |
| 重複した中間結果・再生成可能な未使用build/画像 | D（条件付き） | 利用プロセス/イメージ/rollback/文書/ソース指紋との参照なし、正本と最終証拠を保全、対象一覧承認後だけ。今回は対象ファイルを確定していない。 |
| 出所不明のSession、単独Map、古い成果物・バックアップ・worktree | E | 作成記録、用途、所有者、参照先が未確認。名前や更新日で推定せず保持。製品コードの削除対象は今回確定していない。 |

表のfrontendファイルは `frontend/src/`、backendファイルは `backend/src/` 配下。画面振分けの根拠は [App.tsx](../../frontend/src/App.tsx)、通常導線の根拠は [HomePage.tsx](../../frontend/src/HomePage.tsx)。

## 模擬データの識別と保持

1. まず環境/ボリュームの用途記録、作成手順、fixtureの作成ID対応、実施/Sessionの明示ID一覧、担当者の承認を組み合わせる。専用mock手順ではmanifestのcontainer ID・用途ラベル・nonceとDB markerを照合する。今回DBには接続せず、その照合を新たに実施したとは扱わない。
2. 通常ComposeのSessionに共通の「模擬/研究」判定があるとは、今回見たSession・新実施のschema/作成処理から確認できない。`protocol_key` はフロー、study/仮名IDは関連付けを示し、模擬性の証明ではない。`ENABLED=1`、`PREVIEW=0`、`ONLY_SYNTHETIC`、DB名、名前中の `test` も単独の削除根拠にしない。
3. R05は `r05_test_runs/maps/history` 等の専用領域で識別できる。通常Sessionへ混ぜない。画面内練習の状態も通常Sessionデータとして数えない。
4. 終了済み実施は結果として保持し再開しない。未提出Mapを本人完了・離脱・撤回に変換しない。次回は新規実施を作る。終了・完了を保存期限終了と同一視しない。
5. 未開始Sessionも、初期Map、回答、受付票、研究イベント、他Mapの由来参照があり得るため自動削除しない。「空」に見える場合も正規の適格検査を必要とする。
6. 今回は件数、実施/Session/Map ID、保存期限、実際の参照関係、削除対象を未確認。保持期間、例外、保管担当、バックアップ世代、外部ダウンロード/端末内データの扱いを決めるまで削除しない。

## 既存の削除機能と限界

根拠は [data-management.ts](../../backend/src/data-management.ts) と [DataManagementPage.tsx](../../frontend/src/DataManagementPage.tsx)。

- 旧Sessionの未開始整理 `/api/research/data-management/cleanup` は研究者限定、`DELETE_UNSTARTED` 確認、NOT_STARTED・開始/完了時刻なしを要求する。Stage未着手、回答・操作・配送記録なし、許された研究者/システムイベントのみ、学習者operation receiptなし、初期snapshot一致、外部のMap由来参照なし等も確認する。表示上の未開始だけで適格とはいえない。
- 旧データの確認付き削除はSession IDまたは仮名IDでpreviewし、件数・対象・内容指紋、5分の期限と `DELETE` 入力を用いる。仮名IDの指定では複数Sessionに広がる可能性があり、対象を先にレビューする。トランザクション内で再照合・ロックを行う。利用者の中止を維持する。
- 削除影響はSessionだけではない。Stage、Map・概念・リンク、初期snapshot、旧操作ログ/履歴境界、新研究イベント/カウンタ、回答/設問、種概念、由来、配送受付票/配送報告、関連operation receipt、研究IDの所属・出力キャッシュ等に及ぶ。削除受付票・失効/端末消去追跡は残す設計。ダウンロード済み出力、バックアップ、未接続端末の消去までは保証しない。
- **新protocol `SBKB_INTEGRATION_V1` は既存の汎用削除処理で `experiment_storage_only` 拒否される。** 空・未開始・ENDEDでも旧整理機能を流用しない。実施所属のRESTRICT参照、教材版の固定、コード/画面世代、開始/終了/アクセスの受付票と監査まで含めた別設計・承認が必要。今回その解除や新削除機能は提案実装しない。
- R05は [専用ルート](../../backend/src/r05-routes.ts) のdeletion-previewと確認digest、研究者権限、冪等キーを使う。テストMap/履歴等の削除と、完成教材の受付記録 `r05_submission_acceptances`・監査の保持を区別する。削除で再テスト制約や完成条件を取り消す設計にしない。詳細は [r05-storage.ts](../../backend/src/r05-storage.ts)、[schema](../../backend/migrations/1791120000000_add_r05_test_storage.js) を参照。
- 研究用データ管理の保存期限表示は、自動削除ジョブを意味しない。期限設定だけで勝手な消去を追加しない。

## ファイル・環境資産の扱い

| 種類 | 方針 |
| --- | --- |
| `.local` のmanifest・運用引継ぎ・復元記録・候補台帳 | 原則保持。通常の生成物と分ける。認証値・接続秘密値を含むファイルは公開しない。現用/rollbackの参照を確認し、役割が終わった記録だけを別途承認対象にする。 |
| build成果物・Dockerイメージ | 配信中・比較中・復旧用は保持。指定ソース/lockfile/設定との対応を記録。未使用かつ再生成可能な重複のみD候補。イメージpruneや一括削除はしない。 |
| 最終検証結果・指紋・失敗原因の要約 | 必要な証拠として保持。過去の分割実行と単一64/64、合成表示と実API/DBと実機を区別。現在の証拠へ書き換えない。 |
| 中間/重複JSON・画像 | 正本、失敗経緯、現用参照を確定してからD候補。存在しない画像は参照不可と記録し、現在の画像を過去の証拠に代用しない。 |
| ダウンロードJSON/CSV | 利用者が指定した出力だけを扱う。研究データに準じ保存先・期限・アクセス制限を管理。DB削除とは別の対象。Downloads全体探索をしない。 |
| 復旧用設定・バックアップ・別worktree | 復旧先、所有者、未コミット/未追跡差分、対応ソース、復元可能性を確認するまで保持。worktree名や古さで削除しない。DBバックアップの作成/復元自体も別途承認が必要。 |

## 実装順序・対象・承認・復旧

### 1. 導線だけを整理する（最初の作業単位）

- 完了（2026-11-16、専用worktree）: `HomePage.tsx` の旧Session作成リンクを主導線から外し、閉じた「旧フローの作成」領域へ移した。教材管理・実施管理の主要カードは維持した。
- 完了: ゴールマップ／Kitを「教材準備の補助」として別領域に置き、教材準備との依存を案内した。研究データ管理、研究イベント履歴・Exportのリンクは維持した。
- 完了: 新旧protocolが混在する既存Session一覧は分類・呼称・動作を変更せず残した。旧作成先、一覧、分析などのroute・API・認可には変更を加えていない。
- 新しい一括作成/削除、旧API停止、認証/遷移制約の変更は混ぜない。旧画面の直URL、研究者閲覧、旧学習者認証後の遷移は維持する。新実施一覧へ旧Sessionを推測で所属させない。
- 対象は `frontend/src/HomePage.tsx`、`frontend/src/rehearsal-ui.css`、`frontend/scripts/verify-rehearsal-ui-browser.ts` と本計画。稼働checkoutは変更せず、基準mainから分離したworktreeで実装した。
- 復旧は表示変更の対象ファイルだけを戻す。DB変更を伴わない。今回の変更は未コミットで、配信切替・commit/pushは行っていない。

### 2. 削除ルール・保存方針を確定する

- 研究責任者が用途の証拠、対象単位、保存期間、利用停止中/結果保存の扱い、監査/受付票の保存、端末・出力・バックアップへの波及、承認者を決める。期限や研究条件を開発側で補完しない。
- 新protocolについて、既存削除拒否を維持したまま個別設計を作る必要がある。重要なschema/認可/ログ/保存仕様の変更は、根拠・影響・検証・復旧案を示して事前承認する。
- 別承認を得た読取り調査で対象IDと依存関係・件数を確定する。DB内容から用途を推測しない。現時点の計画だけではその調査・削除を承認済みとしない。

### 3. 承認された対象だけを削除する

- 明示ID、用途根拠、previewの範囲、保存対象、バックアップ/復元検証、アプリ停止の要否、担当者と実行日時を具体化して最終承認を得る。既存の正規機能で対応できるものだけを使う。
- 先に新規使い捨て模擬DBで、参照切れ/対象外データの変化なし・受付票/監査保持・出力無効化・同時操作との原子性を検証する。強制SQL、CASCADE追加、guard無効化、volume初期化を近道にしない。
- 削除後は対象以外の保存・参照・出力と監査結果を確認する。復旧は検証済みバックアップを分離環境に戻してから扱いを判断し、稼働DBへの安易な上書きやschema巻戻しをしない。認証失効・外部出力まで含め、削除は単純にUndoできないことを承認時に説明する。

## 将来必要な検証（今回は未実行）

- 導線整理: 研究者トップの通常/過去データ到達、旧4/5/6の直URL、研究者/学習者の権限、P02練習往復と停止制限。1366×768/1440×900で空/読込/エラー、主要操作、フォーカスを確認。
- 旧データ保全: 各protocolのStage・Map/履歴・回答・由来・旧ログと新イベントを含む分析とJSON/CSV。初期/提出snapshot欠損を推測補完せず、18列CSVの意味を維持。R05非混入も確認。
- 削除: `test:session-cleanup`、`test:data-management` と各browser検証、対象増減・変更・期限切れ・中止・認可・同時書込み・再送/受付票、対象外参照。新protocol拒否を引き続き確認。
- R05: `test:r05-storage`、`test:r05-execution`、`test:r05-browser`。完成受付・監査保持と再テスト制約、共有Mapの操作回帰。
- 通常利用: `test:experiment-enablement`、参加者アクセス・実施管理・学習者browser検証。共有処理を変更する場合は保存/再読込・接続・提出・期限・旧protocolを確認。変更に応じた型検査/Lint/buildと、確定差分の全体suiteを必要時に行う。既存成功結果を今回の新実装の成功に転用しない。

## 完了条件と進捗

- 完了: 記録による環境用途の確認、コード上の入口/共有依存/削除制限の棚卸し、A〜E分類と段階的計画。
- 完了: 研究者トップの主要導線・副次領域の配置整理。教材管理と実施管理の主要カード、既存Session一覧、分析・履歴・Export、ゴールマップ／Kit管理への到達性を保持した。
- 合成ブラウザー確認済み: Edgeの合成応答検証で、研究者トップ、旧作成領域のキーボード開閉とフォーカス、一覧あり／空／読込中／取得失敗、未認証画面・学習者画面の既存確認項目を1366×768と1440×900で確認。横はみ出しなし。実API・DBでの確認ではない。
- 静的検査: frontend typecheck、lint、変更した検証スクリプトのlint、buildに成功。buildに既存の大容量chunk警告あり。関連する全体suiteは実行していない。
- 代表画像（合成データ、CSS有効状態）: 変更前 `source-before/researcher-home-populated-1366x768-after.png`、`source-before/researcher-home-populated-1440x900-after.png`。変更後 `source-after-final/researcher-home-populated-1366x768-after.png`、`source-after-final/researcher-home-populated-1440x900-after.png`。保存先は一時領域 `sbkb-researcher-home-legacy-nav-20261116`。元のCSS無効／有効比較画像の意味とは区別する。
- 未確認: 実API・DBでの表示・データ確認、稼働環境への反映、実研究利用、LAN・通信保護。DB内の件数/対象ID/用途の独立検査、削除/復元の実行結果も未確認。
- 次の作業: 削除ルール・保存方針の確定へ進む場合は、研究責任者による対象・保存期間・監査等の決定と別途の読取り調査承認が必要。コード/Session/ファイル/volume/worktreeの削除はまだ行わない。
