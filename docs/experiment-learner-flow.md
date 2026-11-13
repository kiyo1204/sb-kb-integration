# SBKB_INTEGRATION_V1 学習者フロー（模擬検証専用）

## 対象リビジョンと公開範囲

- worktree: `<repository-root>`
- branch: `codex/experiment-foundation`
- HEAD / 開始時GitHub main: `ea5319416cecf11b2ace35308c21047ac4d69d25`
- PR #37: open・未マージ、head `f7430345885d6b9e4c00ea272acbb645d41d86d1`。その未マージ差分は取り込んでいない。
- 保存基盤、R03/R04、R06/R07、R08の未コミット差分を保持して追加。元worktreeの単位A/Bは変更しない。

**通常の実施開始・学習者利用は引き続き未公開。実研究データ・LAN・本番利用は有効にしていない。** 完了・撤回・分析/Exportを含む実運用契約が揃ったという意味ではない。

`STAGE1_EXPERIMENT_LEARNER_PREVIEW=1`の場合に限り、起動時に次の条件を全て満たす専用APIプロセスで今回のフローを検証できる。

- `NODE_ENV=development`、`STAGE1_MOCK_DATA=ONLY_SYNTHETIC`
- DB接続先はloopback、DB名が`stage1_mock_...`
- DBの`stage1_mock_guard.marker`が`ONLY_SYNTHETIC`で有効なnonceを持つ

不一致ならサーバー起動を拒否。通常起動ではこの設定は使わず、旧来の未公開ゲートとR08の無効な開始ボタンを保つ。これは保存された「準備完了」フラグではなく、専用模擬環境だけのプロセス能力制限。既存DBに接続してこの設定を試さない。今回の検証スクリプトはさらに`verifyMockTestUrl`を先に実行する。

## 保存契約・追加migration

追加: `backend/migrations/1791110000000_add_experiment_execution.js`。既存migrationを変更していない。

| 対象 | 追加・変更 |
| --- | --- |
| experiment_runs | `started_at`を追加。PREPARING→RUNNINGの1回だけ、サーバー時刻と登録Session 1件以上をDB triggerでも要求。教材版・予定人数等は不変 |
| experiment_start_receipts | UUID要求キー、実施ID、開始時刻。再送で開始・監査成功を重複させない |
| experiment_start_audit | 実施開始管理操作のHTTP status、outcome、固定reason_code、サーバー時刻。研究者専用操作で、Mapイベントへ混ぜない |
| 新protocol Session | 既存ID/所属/固定Kit/動画/時間/群なし/認証保存先を維持し、NOT_STARTED→IN_PROGRESS→COMPLETEDだけ許可 |
| 新protocol Stage | LESSON→PRIOR_MAP→KB_MAP→INTEGRATION_MAPの4件のまま。先行Stage完了、実施RUNNING、本人Session進行中を要求。Map Stageの完了は提出済みMapが必要 |
| 新protocol Map | 対応する進行中StageとRUNNING実施にだけ作成・更新可能。教材資材の凍結triggerは従来どおり |

旧Sessionの自動所属追加、ID置換、データ変換、イベント書換えを行わない。旧STAGE1_4/5/6、群・評価・アンケート、旧JSON/CSVや特徴量の契約は変更しない。downは新データを消さず、機能停止・前方修復を要求する。DB管理者によるtrigger無効化等まで保証しない。

## 画面・活動

Figma `eSgsQfqam4eOdVSuW8fltS` のP01 `27:130`、P05 `2:129`、P06 `2:194`、P05提出失敗 `4:224`のdesign contextと画像を読み取り。P02〜P04/P07/P08の独立フレームは今回確認したファイルに見つからず、依頼の要件と既存Session/Map UIを使う。Figmaの編集なし。

Code Connectの`primitives`は既存依存に存在しないため既存ネイティブbutton・dialog・デザイントークンを使用。ワイヤーに描かれた例示Concept/Linkは研究教材や静的画像として登録せず、実際のMapデータを既存SVG/DOMキャンバスで描画する。

| 画面 | 実装 |
| --- | --- |
| P01 | 既存コード入力を再利用。新protocolだけログイン直後の全ページ再読込みを避ける。本人のコードhashからSessionを導出 |
| P02 | 操作と「授業・動画→SB→KB→統合」の中立的な案内。正式な研究説明・同意取得の代替ではないと明示。回答Stageを追加しない |
| P03 | 既存動画・視聴確認チェックを再利用。全区間再生を要求しない。URL固定と内容不変性を区別 |
| P04 | 実施作成時に固定した教材版のSB/KB/統合説明。開始前に表示し、Map内でもdetailsを開閉できる。開閉でMapを再作成/再読込みしない |
| P05 | 既存seed配置・CLONED_FROM・seed保護を新protocolでも適用。seedは移動/Link可、名称変更/削除/Merge不可。他Concept/Linkは既存制約。追加の最低数・正誤条件なし |
| P06 | 既存Kitパレット・マップ・接続・Undo/Redoを再利用。概念/Linkの独立した横スクロール領域、上部操作/保存/一時提出/最終提出。部品使用状態は現在Mapから取得 |
| P07 | 提出済み本人SBと固定Kitの既存初期化経路を再利用。自由編集/Kit取込/Merge/直近1段階解除/Provenance/Undo/Redoを適用。KB判定APIは統合Mapに404。判定UIも表示しない |
| P08 | 統合提出後の「次へ」で4つ目のStageと本人Sessionを完了。SURVEYなし。終了案内・研究者指示待ちのみで、実施管理終了を装わない |

期限は固定教材版から複製されたSessionの時間を使う。新protocolでは期限前の手動提出を許可し、提出後の「次へ」も期限まで待たず使える。期限時は既存SYSTEM自動提出を拡張し、Stage/Sessionは「次へ」まで進行中とする。DBに提出が保存される前は「確認中」とし、期限経過だけで完了表示しない。旧群別6活動の期限・提出・完了条件をこの分岐で変えない。

KBは既存graph signatureを利用し、位置だけの変更を構造変更と混同しない。新protocolの最終提出ボタンはオンライン・保存済み・処理中/競合/入力エラーなし・編集欄が閉じられていること・現在構造に対する完全一致確認時だけ有効。再読込みではクライアントの古い確認を持ち越さず再確認する。サーバー提出時は最新保存Mapを再計算し、不一致なら拒否する。判定中はMap編集を停止し、通信障害時もMap内容を保持する。判定応答は一致/件数/signatureのみで、正解Map/端点/具体的誤り位置を返さない。

## 認可・固定教材・競合

`experiment-execution.ts`と既存`access-control.ts`を併用する。

- 認証hash→本人Session→参加所属→実施→固定教材版/Kit/時間を確認する。URL/本文の実施IDを権限根拠にしない。
- 学習者は自分のSession/現在Stage/現在Mapだけ。研究者API、別Session・別実施、Goal Mapを取得できない。進行飛ばしは既存current Stage検査でも拒否。
- `/api/experiment-material`は本人所属から固定版説明だけを返す。共有秘密検査/redactionを適用してから送信し、秘密検査不能時は安全なコードで失敗。
- 実施開始は`POST /api/research/experiment-runs/:runId/start`。研究者・専用模擬モード・空の要求・UUID Idempotency-Key・管理対象・PREPARING・登録1件以上を確認。run行とキーをロックし、RUNNING/時刻/受付票/成功監査を同一transactionで確定。
- 0件なら409 `participants_required`。公開ゲート閉鎖時409 `experiment_learner_flow_unavailable`。別キーで再開始は409、同じキーは元の開始結果のみ。途中障害は503でrollbackし、開始成功とは記録しない。
- 開始後の参加登録は同じ固定教材版を使う。予定人数は上限にしない。開始と登録は同じrunのロックで直列化する。
- 研究者による既存の新protocol資源直接変更/旧コード再発行経路は開放しない。Map作成本文のStage参照も保護する。

各学習者要求で現在hash・認証世代・利用画面秘密hash・画面世代・RUNNINGを検査し、書込みtransaction内で再検査する。既存`withTransaction`の**受付票再生より前**にguardを置き、失効前に認証だけ済ませた要求が確定しないようにする。拒否で開いたtransactionを残さずrollbackする。失効は401/409の固定コードとし、例外詳細を返さない。

コード再発行・画面切替・本人保存は同じaccess行で直列化する。コード再発行側では不要なSession共有ロックを先に取らず、access行→進行更新という順序との逆転を避ける。SYSTEM自動提出も実施/本人/Mapを同じ境界で確認し、Mapイベント・受付票・現在状態を原子的に保存する。送信状態レポートも新protocolだけ同じ世代検査をtransactionに含める。

新フロー内部はページ内遷移で、同じ開いた画面の秘密を保持する。**別ページ/再読込みは新しい画面候補で、R08の明示切替が必要**という先行R08の扱いを維持する。再読込みで自動奪取しない。未同期Mapを別画面へ自動移送しない。

## 観測イベント送信待ちとMap保存の区別

既存のMap保存/履歴/冪等受付票と、観測イベント送信待ちを別に扱う。Map本文は観測outboxへ保存しない。

新protocolの観測outbox項目には、イベント生成時点の**公開候補UUIDと画面世代**だけを追加保持する。コード/画面秘密を保存しない。再送は元の世代をヘッダーで伝え、サーバーが現在の所有世代と照合する。切替後に旧項目を新世代として自動再解釈しない。

古い/未記録の発生元なら409 `experiment_origin_stale`。ACKや成功を返さず送信待ちを保留し、自動移送・削除・回収を新設しない。古い項目が先頭に残ると後続の観測送信も進められないことがある。画面は操作記録の未確認を示す。既存の容量/年齢制限は引き続き適用される。これは未同期端末回収やMap本文復旧の保証ではなく、回収・保管方針は未決のまま。旧protocolのoutbox項目形状は新メタデータなしで従来どおり。

## 今回の検証

Windows / Node v22.23.4 / PostgreSQL 17 / Edge headless。TEST ONLYの合成教材・Sessionだけを使用。8秒・予定1等は検証fixtureであり、教材や研究条件の初期値・推奨値ではない。

専用新規DB: `stage1_mock_learner_target`、`stage1_mock_learner_full`、`stage1_mock_learner_final`、`stage1_mock_learner_acceptance`。既存DATABASE_URLを解除し、create/migrate/safety/seed/checkを実行。サーバー/検証はloopbackのみ。

対象スクリプト`verify-experiment-learner.ts`は独立した専用preview APIを起動する。0人開始拒否、開始監査途中故障のrollback、同キー再開始、開始後の追加登録、複数Sessionの分離、飛越し拒否、SB seed/Provenance、Map書込み故障と同キー再送、再発行と古い認証要求のロック競合、古い観測世代の拒否、KB不一致/一致/位置/再接続/Undo/最新提出判定、統合Merge/解除/Undo/Redo/混在再生、手動/自動提出、明示Next/完了/アンケートなしを確認する。

実APIブラウザーではP01からP08、自己申告の動画確認、固定説明開閉、seedだけのSB提出、オフライン提出無効、KB未確認ボタン無効、件数判定、実マウスでのパレット配置/Undoによる復元、同じアプリclientでの合成KB組立てと再取得、統合に一致ボタンなし、最終提出/Nextを確認する。KBの全組立てを全てマウスで行ったという意味ではない。追加確認では、全体表示後の実マウスseed移動と保存、未保存の概念追加欄を開いた間の提出禁止、独立スクロール設定と600px以内のキャンバス領域、KBの実再読込み・明示画面切替・再判定も確認した。

KBを実際に再読込みし、新しい画面候補が保留されること、研究者APIで明示切替した後に同じ保存Mapを再取得できること、最終提出は再確認まで無効であることを、連続した実APIブラウザー検証で確認した。同じコードの別画面拒否・研究者切替は先行R08検証も全体suiteで再実行する。実施終了・個別停止と自動提出の競合は機能自体が対象外で、検証済みとはしない。統合ではA+B→M、M+C→Nを作成し、Nの削除でMを残して内側のA/Bが非表示のままであることもAPIで確認した。

途中の失敗と修正:

1. PowerShellでのBash形式brace/glob検索と、Pythonの既定cp932読込みが失敗。UTF-8/実パスで再実行。対象既存差分は破棄していない。
2. 新スクリプトの報告名の型、空catchのLint、初期effectのLintを修正。既存静的検査の規則を無効化していない。
3. API fixtureが同じ参加者へ別画面秘密を作り直し409、統合作成201を200と期待し失敗。同一画面秘密の再利用と既存HTTP契約へ修正。
4. 新protocolログイン直後の全ページredirectで旧ページと新ページが別候補になる不具合を修正。旧protocolのredirectは維持。
5. ブラウザーが判定のloading dialogを閉じていた待機競合を、結果見出し待機へ修正。実マウスの移動・dragoverが届くようviewport/移動手順とパレット配置を確認。
6. page.evaluateへ渡す関数のtsx変換補助`__name`不足をテスト環境側だけ修正。
7. 新VIDEO fixtureがIdempotency-Keyだけを送り既存delivery契約で400。stream/sequenceを付け、検証を弱めず修正。
8. 画像レビュー後に新protocolの操作欄・パレット・キャンバスを整理し、既存Canvasを全体表示できるrefを追加。表示倍率の下でも既存座標変換でseed移動を保存できることを確認。旧protocolの配置は維持。
9. 最終レビューで新protocolにも残っていた未保存編集欄からの提出を禁止し、入力編集中の表示を追加。新しいオフライン/判定中の操作制限は新protocolだけに限定した。
10. 初期所属・画面検査のDB故障を409へまとめる点を修正。認証失効401・世代競合409・DB障害503を固定コードで区別し、rollback失敗も秘密値・例外詳細を返さず扱う。DB故障の分類境界は関数単体のfake接続で確認し、実APIの書込み故障/開始監査故障は専用模擬DBのtrigger注入で別に確認した。

1回目の全体suite（`learner-full-*`）は52件成功・各検証時間合計661.289秒、ソース49件の集約SHA-256は`7AA5DC1C46E6C8420134533CC4DF631E3895FA2B40F056E7111CE1849F80224D`で開始/終了が一致。画面整理後の2回目（`learner-final-*`）も52件成功・635.012秒、ソースhashは`566D17D2CE0C991D1500B541063B49B277D42E3A387CB42B630C094B3AF849BE`で実行中は変更なし。その後に未保存入力・エラー分類を修正し、`learner-acceptance-target-*`の対象検証を再実行して成功。これら先行2回は最新修正前の記録として区別する。

最終修正を含む`learner-acceptance-*`全体suiteは**52/52成功**。各検証の実行時間合計は598.995秒、新フローAPI/ブラウザー検証は47.603秒。最終対象のみの再実行`learner-acceptance-target-*`も1/1成功（48.613秒）。開始・終了時のbackend/frontendソース・設定49件の集約SHA-256はともに`C5E7D744D534666EB226477222850C126E22428CFA9EFA505F102D7CCD0DCE48`で一致し、全体suite中のソース/テスト変更なし。

| 今回の最終確認 | 実際の結果 |
| --- | --- |
| 4つの新規専用DBのcreate/migrate/safety/seed/check | 成功。既存DBへの接続なし |
| 最新コードの対象API・実ブラウザー | 成功。前記fake接続の障害分類境界と、実DB故障注入は区別 |
| 最新コードの全体suite | 52/52成功。旧4/5/6、JSON/CSV、監査、認可、履歴、先行保存基盤/R03〜R08も含む |
| backend typecheck / lint / build | 全て成功 |
| frontend typecheck / lint / build | 全て成功。Viteの500kB超chunk警告は残る（build成功） |
| git diff --check | 成功。LF/CRLF自動変換の警告のみ |
| 終了時GitHub再確認 | mainは`ea5319416cecf11b2ace35308c21047ac4d69d25`、PR #37はopen/未マージ・head `f7430345885d6b9e4c00ea272acbb645d41d86d1`のまま |
| 模擬環境後片付け | 専用4コンテナー/volume、対応4キャッシュ/manifestを削除済み。ID/名前/用途/nonce/DB名/bindなし/パス範囲を検査してから削除 |

後片付けの初回はPowerShellの`@($null).Count`が1になるため安全確認が停止し、削除は開始されなかった。bindが全てnullであることを読み直してnullを明示判定し、専用4件だけを削除した。アプリ検証失敗やデータ破損ではない。

今回の記録は`learner-*`に分離し、先行`access-*`等や過去CIを今回の成功として扱わない。suiteが生成した開始時cleanの5つの追跡ファイルと一時mobile画像は開始時に戻した。先行未コミットソースの保護コピー`.local/learner-before`は保持し、アプリ/suiteの対象には含めない。単位A/B文書は作業前と同じSHA-256を確認。コミット・push・GitHub更新なし。

```powershell
# Node v22.23.4 / development / ONLY_SYNTHETIC / 既存DATABASE_URLなし
npm run db:mock --prefix backend -- create --name stage1_mock_learner_target --mock-data-only
# 4専用DBそれぞれで migrate / safety / seed / check
# ONLY=test:experiment-learner / browser=1 / prefix=learner-target
npm run db:mock --prefix backend -- suite --name stage1_mock_learner_target
# 新規learner_full、ONLY解除、browser=1、prefix=learner-full
npm run db:mock --prefix backend -- suite --name stage1_mock_learner_full
# 画面整理後: prefix=learner-final、最新修正後: prefix=learner-acceptance
npm run db:mock --prefix backend -- suite --name stage1_mock_learner_final
npm run db:mock --prefix backend -- suite --name stage1_mock_learner_acceptance
npm run typecheck --prefix backend
npm run lint --prefix backend
npm run build --prefix backend
npm run typecheck --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
```

厳密サンプル比較のため開始時cleanの4サンプル作業コピーのみLFへ揃え、終了後に開始時へ戻す。全体suite中はコード/テストを変更しない。

## 変更ファイル・残る範囲

新規: migration179111、`experiment-execution.ts`、`verify-experiment-learner.ts`、`ExperimentLearnerPage.tsx`、`experiment-learner.css`、`verify-experiment-learner-browser.ts`、本書と今回の検証記録。

追加変更: `access-control.ts`、`index.ts`、`sessions.ts`、`surveys.ts`、`research-events.ts`、`delivery-reports.ts`、`experiment-foundation-guard.ts`、`experiment-participant-access.ts`、`App.tsx`、`SessionFlowPage.tsx`、`MapPage.tsx`、`auth-client.ts`、`observation-outbox.ts`、R07/R08の状態/模擬開始表示、両package.json/suite。前段run/participantテストは、今回公開ゲート付きstart APIが追加された点の期待値だけ調整する。

R05、実施終了、離脱・撤回・停止、撤回者Export除外、分析/Exportの新protocol対応、未同期端末回収は未実装。通常研究者Exportは新protocolに未対応であり、実研究利用を有効にしない。

具体教材/動画/Goal/seed数、Kit全要素必須、活動時間指標、Study/再参加、個別停止、撤回後保存/物理削除/backup、送信済みExport、未同期回収、実データ運用条件は決めていない。操作数やMap構造を理解・困難・学習成果・認知状態と断定しない。今回の模擬成功は実研究データ・実機LAN・20台同時利用・本番安全性の保証ではない。


## 研究者分析・Exportの新protocol対応（後続実装単位）

この節は先行の「未実装」記録を更新する現行差分である。先行suite/CIの成功を今回の実行結果とは扱わない。開始時は同じworktree、`codex/experiment-foundation`、HEAD `ea5319416cecf11b2ace35308c21047ac4d69d25`、未コミット260項目・staged 0。既存差分の保護コピーは`.local/analysis-before`。単位A/B文書は変更しない。

| 対象 | 着手時 | 本単位の対応 |
| --- | --- | --- |
| Session/実施/固定教材/Map所有 | 実装済み | 新protocolの所属と固定Kit/動画/時間/教材版を出力時にも確認 |
| 初期snapshot、v2/v5、Undo/Redo、Provenance | 保存・混在再生は実装済み | 既存replay/検証/状態比較を利用。過去状態と現在の保存行を区別 |
| 分析・Session JSON・操作CSV・画面 | 旧protocolに限定、新protocol不足 | 既存API/画面/CSVを拡張し、旧契約と分岐 |
| 統合開始/提出状態の表示・CSV | 不足 | 保存初期snapshotと受理イベントを照合。欠損・未提出・不整合を明示 |
| R05分離 | 専用表による分離は実装済み | 参加所属→通常Session/Stage/Mapの経路のみ取得し、R05の表を参照しない |
| 旧protocol回帰・実API/ブラウザー | 過去の成功記録のみ | 今回の対象/関連回帰結果を以下へ記録 |

### 契約・取得範囲

- 新protocolのSession JSONは`exportVersion:4`、`outputContract:sbkb-integration-research-v1`。旧4/6/5のversion1/2/3、完了Session限定条件、活動列、既存CSV列/UTC時刻/指標は維持する。
- 新protocolは準備中・進行中・完了を区別し、**保存済みDB状態**を出力する。未提出の現在Mapを完成状態に置換しない。画面は取得時点の読み取り専用snapshotで、ライブMapや編集画面へ誘導しない。
- 既存仮名は`research_session_ids.pseudonym`から取得。参加者ラベルやアクセスコードを新しい追跡IDとして出力しない。Session/Map/Stage/Eventの既存IDと相互参照は維持。
- `experiment`はrunId、実施状態/作成時刻、固定materialVersionId/catalogVersionId/教材版番号/教材名/制限時間、予定人数、登録時刻。実施単位JSONの`registeredSessions`は所属Session数。予定人数を上限にしない。
- `maps`は各活動の保存行と現在のProvenance、`initialSnapshot`は既存保存初期状態、`operationLogs`は旧ログ+保存されたv2/v5イベントとbefore/after/actor/outcome/ID/時刻。過去の削除済み資源・由来はイベントsnapshotから確認し、現在行へ復活させない。
- `integrationStates.start`は保存された初期snapshot。`submission`は成功したMAP_SUBMIT/MAP_AUTO_SUBMITが1件、Map提出時刻/対象ID/履歴境界が一致し、混在履歴の再生と現在DBグラフと受理イベントafterが一致した場合のみAVAILABLE。新たな構造指標を作らず、既存のreplay/validation/historySnapshotsEqualを再利用する。
- 欠測は`state:null`、`UNAVAILABLE`と理由コード。`INTEGRATION_MAP_MISSING`、`INITIAL_SNAPSHOT_MISSING_OR_INVALID`、`NOT_SUBMITTED`、`SUBMISSION_STATE_UNAVAILABLE`、`HISTORY_INCONSISTENT`等。0や現在編集中Mapで補完しない。所属/教材/活動列等の不整合は出力全体を409で拒否する。
- `seedConcepts`は既存の指定Kit部品/元Concept/配置Conceptの参照。群/アンケート/評価Stageを追加しない。旧STAGE1_5の特徴量を新protocolに流用しない。

### API・画面

| API | 内容 |
| --- | --- |
| GET `/api/research/stage1/sessions/:id/analysis` | 既存分析に固定実施/教材と統合状態を追加。新protocolのみ未完了も取得可 |
| GET `/api/research/stage1/sessions/:id/maps/:mapId/history?sequenceNumber=N` | 既存履歴再生。本人所属Mapを再確認し、欠損時は推測しない |
| GET `/api/research/sessions/:id/export` | version4 JSON。既存v1/v2/v3は変更しない |
| GET `/api/research/stage1/sessions/:id/operations.csv` | 既存列/順序/CSV保護のまま新protocolの保存操作を出力 |
| GET `/api/research/stage1/sessions/:id/map-states.csv` | 新契約の保存Map/統合開始/受理提出snapshotのCSV |
| GET `/api/research/experiment-runs/:runId/research[.json]` | 同一REPEATABLE READで実施所属の参加SessionをまとめたJSON |
| GET `/api/research/experiment-runs/:runId/research.csv` | 同じ所属SessionのMap状態CSV。操作履歴はJSON/既存操作CSV/共通イベント出力を使用 |

新しいMap状態CSVの列順は`outputContract,protocolKey,runId,materialVersionId,sessionId,pseudonym,sessionStatus,exportedAt,mapId,mapType,point,status,reason,recordedAt,submissionEventId,state,mapStatus,mapSubmittedAt`。`point`は`SAVED_AT_READ`（各Map）、`INTEGRATION_START`、`ACCEPTED_SUBMISSION`。`state`はsnapshot JSONで、座標/接続/ラベル/非表示Merge元/Provenanceを含む。欠測stateや時刻は空欄。Map未作成Sessionは`MAP_NOT_CREATED`の欠測行を出力し、実施登録0人ではCSVヘッダーのみ。CSVは既存csvCell（引用/式インジェクション防止）、UTF-8 BOM、CRLF、ISO8601 UTCを利用する。

R08の参加者行から既存分析画面へ移動し、実施JSON/Map状態CSVも取得できる。Home一覧は新protocolを旧4活動と誤表示せず、研究者読取り画面へ接続する。分析画面は各Mapの保存状態/現在の由来、統合開始/提出snapshot、既存の操作比較・履歴を表示。新protocolではアンケート、旧4活動評価入力、STAGE1_5特徴量を表示しない。

### 認可・監査・分離・互換性

- 既存Bearer/研究者認可を再利用し、参加者は全研究APIへアクセス不可。URLの親IDやSession IDだけで所属を認めない。R05 IDを渡しても通常Session/実施と解釈しない。
- 保存基盤guardの例外は研究者GETのanalysis/operations.csv/map-states.csv/指定Map historyだけ。コード発行/再発行、進行/編集/提出や通常参加者公開のガードは維持する。
- Session読取りのRESEARCH_ANALYSIS_VIEW/RESEARCH_EXPORT監査は既存server-auditへ新protocolを追加。実施単位読取りは既存experiment_run_auditのREADを利用。固定エラーとHTTP結果を整合させ、本文/例外詳細をログへ追加しない。
- JSONとCSVはDB読取り・既存秘密検査が全て完了してから送信。1リクエスト内で既存の秘密検査予算を共有し、超過422 safety_budget_exceeded/照合不能503 safety_lookup_unavailableで全体を抑止する。大きな実施出力が上限に達する場合はSession単位へ絞る。検出範囲や上限を変更しない。
- 新しいschema/migration/参加者識別子は追加しない。旧行の再関連付け/変換/削除なし。R05の自動提出は開いている専用画面の要求方式のままで、通常学習者のバックグラウンド提出と混同しない。

### 今回の検証・途中失敗

Windows/Node v22.23.4/PostgreSQL17/Edge headless/loopback/ONLY_SYNTHETICの専用模擬DBを使用。既存DBへの接続なし。

- 静的検査の初回: 追加画面のsnapshot型とCSVテストのparse戻り値型を修正。規則は弱めていない。
- `experiment-research-target`: 準備中分析が既存storage-only guardで409となり失敗。研究者GETの厳密な許可と監査のprotocol対応を追加した実装修正。
- `experiment-research-fixed`と`experiment-research-accept`: 実APIのJSON/CSV、受理状態、仮名/非混入検査は通過したが、ブラウザー検証の選択欄指定で失敗。option名も含むlabelへの完全一致を指定したfixture誤りを、専用selectと実Map IDの待機へ修正。
- `experiment-research-final`: 修正後の対象API/実ブラウザーを新規専用DBで検証。結果と関連回帰は完了後に追記する。

旧protocolの過去のsuite54件成功は先行R05時点の記録であり、本単位の結果ではない。本単位では関連検証だけを選択し、無関係な全体suiteの再実行はしない。実研究データ、実機LAN、20端末同時利用、本番運用、撤回/生成済み出力/保存・物理削除/未同期回収は未確認・未決定のまま。コミット/push/PR/Issue更新/既存DB適用/通常公開は行わない。


共通イベント抽出の最終確認で`event-export-query.ts`にも旧protocol限定条件が残っていたため、通常Sessionに属する新protocolの旧ログ/研究イベントを対象へ追加した。R05専用表はUNION対象に入れない。既存schema3・共通CSV列・UTC・actor/outcomeの意味は維持し、protocol_keyの説明だけを辞書へ追記した。サンプル辞書とそのmanifestのbytesも既存生成処理で整合させた。他のサンプルイベント値は変更していない。

`experiment-research-verified-*`は5項目全て成功（合計186,105ms）。新protocolの実共通JSON/CSVダウンロードについて、操作ID、Map ID、仮名、protocol、server_timestamp、outcome、before/afterがSession JSONと一致することを追加検査した。R05のID/Mapが共通抽出・通常分析へ混入せず、他Session Mapを当該Sessionの履歴として取得できないこと、研究者の分析監査保存ヘッダーも確認。モバイルの横はみ出しを新protocol専用CSSで修正し、390px表示でdocument.scrollWidthがviewport内に収まることをブラウザーで確認した。キャンバス内の拡大/移動は既存部品のまま。

途中の追加検証準備では、サンプル辞書のCRLF/LF比較、辞書変更に伴うmanifestのbyte数が順に不一致だった。既存生成処理で直した。DB変更が始まる前のfixture比較であり、研究データ不整合ではない。単体コマンドを模擬認証環境なしで直接起動した1回も初期設定検査で停止し、テストは開始されなかった。その後は既存db:mock suiteから模擬環境を渡して成功した。

最終レビューで、履歴APIの接続取得をエラー処理内へ移し、接続失敗も固定JSONにする補強を加えた。`experiment-research-failure-checks.ts`はDBを開かない代替Poolを用いたHTTP単体検証で、履歴の既存500と実施CSVの503、安全な固定コード、JSON Content-Type、添付ヘッダー/部分CSVなし、例外本文の応答/ログ非露出を確認する。実DBへの障害注入と混同しない。これに伴う最終の実API/旧4活動/分析UI再確認を`experiment-research-fault-final-*`に分けて記録する。

追加ファイルは`experiment-research.ts`、`experiment-research-states.ts`、`verify-experiment-research.ts`、`experiment-research-checks.ts`、`experiment-research-failure-checks.ts`、`verify-experiment-research-browser.ts`、`experiment-research.css`。変更は`research-export.ts`、`stage1-analysis.ts`、`experiment-foundation-guard.ts`、`server-audit.ts`、`event-export-query.ts`/辞書、`index.ts`登録、既存learner検証の合成fixture再利用、package/suite、`Stage1AnalysisPage.tsx`/R08/Homeの読取り導線、本書/サンプル辞書/manifest/検証記録。DB schema/migration変更はない。


### 最終結果と後片付け

| 今回の実行 | 結果・範囲 |
| --- | --- |
| `experiment-research-final-*` | 対象1項目成功（78,913ms）。初回の新protocol実API/画面とP01〜P08 |
| `experiment-research-regression-*` | 選択した関連13項目全て成功（262,853ms）。旧4/5/6・旧特徴量・旧JSON/CSV・認可/秘密保護・旧分析UI・R05・未公開ゲート |
| `experiment-research-verified-*` | 共通イベント抽出/辞書とモバイル補強後の5項目全て成功（186,105ms）。サンプル/共通出力/秘密保護/R05/新protocol実API・ブラウザー |
| `experiment-research-fault-final-*` | 接続取得の安全処理追加後の3項目全て成功（101,074ms）。代替Poolの障害HTTP単体、旧4活動実API、旧4/5/6分析UI、新protocol実API・ブラウザー・P01〜P08 |
| backend `typecheck` / `lint` / `build` | 最終修正を含め全て成功 |
| frontend `typecheck` / `lint` / `build` | 全て成功。既存500kB超chunk警告あり（build成功） |
| `git diff --check` | 成功。LF/CRLF自動変換警告のみ |

項目数には再確認による重複があり、全体suiteを21件の独立テストとして数えない。本単位では全体suiteを再実行していない。前段の成功と、共通抽出/画面/エラー処理の修正後に必要になった再確認を分けた。最終のbackend/frontendソース・設定75ファイルの集約SHA-256は、最終検証開始後と終了時の双方で`94283E1C97BFB79BDE49938D3FEAD862FCDD361E12B5529AECAA4D01A0613BD5`が一致し、実行中のソース変更なし。

実行コマンドは既存の`npm run db:mock --prefix backend -- create --name <今回専用名> --mock-data-only`と`migrate / seed / check`（最初の専用DBでは`safety`も実行）。対象/回帰は`npm run db:mock --prefix backend -- suite --name stage1_mock_research_regression`に、`RESEARCH_SUITE_ONLY`で次を段階別に指定した。

- 対象: `test:experiment-research`。既存learnerの合成fixtureを再利用し、授業/SB/KB/統合の実経路・手動/自動提出から保存状態を照合する。
- 関連13項目: `test:stage1:integration,test:session-flow-survey,test:five-flow-composite,test:five-flow-features,test:five-flow-feature-maps,test:research-note-safety,test:event-export,test:r05-execution,test:participant-access,test:session-cleanup,test:session-cleanup-browser,test:stage1-analysis-layout-browser,test:research-log-ui`。
- 共通出力補強後5項目: `test:experiment-research,test:event-export,test:event-export-samples,test:research-note-safety,test:r05-execution`。
- 最終3項目: `test:stage1:integration,test:stage1-analysis-layout-browser,test:experiment-research`。
- `RESEARCH_BROWSER_CHECKS=1`、`BROWSER_CHANNEL=msedge`、結果prefixは表のとおり。通常preview環境は親から解除し、既存のlearner fixtureだけが検証専用APIで有効にする。
- 静的検査は`npm run typecheck --prefix backend`/`frontend`、同`lint`/`build`。

最終画面画像はvisualizations配下`experiment-research-release/experiment-research-desktop.png`、`experiment-research-mobile.png`。記録は合成データであり、実研究データの確認結果ではない。

今回だけの4つの模擬DB `stage1_mock_research_target/fixed/accept/regression`は、container ID/用途/nonce/DB名/host bindなし/cache絶対パス/リンクなしを照合してから、container/volume/cache/manifestを削除済み。開始時cleanの比較用作業コピー（test matrix/events.json）とsuite生成のsurvey結果は開始時へ戻し、今回生成のmobile一時画像も削除。意図した辞書のprotocol説明とmanifest bytesの変更は保持した。先行差分、未追跡ファイル、開始時バックアップは破棄していない。

単位A/BのSHA-256は開始前の既知値と同じ`5AEDE09C4E100210E37E75B24AB70FFE392FCE9D69B44584FF65D9701B9BBE6F` / `1A204A8207C16508CE0B8B91D6CC16051DFE6CB6B49C16395B1CEE12C61FA60E`。終了時は同じworktree/branch/HEAD、未追跡の検証記録/保護コピーを含む316項目、staged 0。コミット・push・PR/Issue更新・既存DB接続/適用・通常公開を行っていない。


## 統合確認後の改行・実DB欠測検証

開始時: 同じworktree/branch/HEAD、317変更項目・staged 0。既存差分を保持し、今回触る4検証ファイルの開始時コピーを`.local/eol-missing-before`へ保持した。

対応表の生成はLF、Windows作業コピーはCRLFだった。`.gitattributes`はCSVを`-text`でバイト保持する指定のみ。生成物を毎回書換えず、`verify-event-catalog.ts`の読取り比較でCRLFだけをLFへ正規化する。`verify-event-export-samples.ts`のMarkdown/JSON比較も同様にし、CSVは従来どおり完全なバイト相当比較を維持。空白、行順、イベント名、値、裸のCR、末尾改行の有無は緩和しない。migration/本体機能/既存fixtureは変更していない。

欠測経路は既存の`verify-experiment-learner.ts`と研究者ブラウザー検証を拡張した。`verifyMockTestUrl`確認済みの新規使い捨てDBに限り、実フローで作った合成参加Sessionの提出済み統合Mapについて、存在を確認した`map_initial_snapshots`の該当1行だけを削除する。既存schemaではこの行のDELETEに禁止triggerはなく、trigger無効化や権限制約緩和は不要。通常の学習者APIで欠損を起こせるという意味ではない。

実分析APIおよびSession JSONが開始/提出stateをnull、理由をINITIAL_SNAPSHOT_MISSING_OR_INVALIDとして返し、実研究者画面の統合状態欄が理由付き欠測となり、初期/提出の比較Mapを描画しないことを確認。正常snapshotが存在する状態のJSON/CSV・履歴・R05分離・2参加Session分離は、削除前に既存検証をそのまま通す。正常な現在Mapや履歴・教材・R05記録は書換えない。欠測fixtureはDB廃棄で片付ける。

今回の対象結果`eol-missing-target-suite-results.json`は3/3成功（event-catalog、event-export-samples、experiment-research）。42イベント/478版・結果fixtureの検査、実API/研究者ブラウザー、既存P01〜P08も成功。backend typecheck/lint/buildは変更した検証コードを含め全て成功。frontendの変更は検証scriptだけで、src/package/型・Lint・build設定は前回成功時から変更していないため、その成功記録を利用。script自体は実ブラウザーで実行した。

全体は対象検証とは別の新規`stage1_mock_eol_missing_full`で、RESEARCH_SUITE_ONLYを解除し、RESEARCH_BROWSER_CHECKS=1、Node22.23.4/Windows/PostgreSQL17/Edge/ONLY_SYNTHETICで実行。開始後のソース指紋は88C50D88911B1DCE1EB53A07442C72DADAA6E376386086AA7FD99DC4A512E9C6。結果は終了後に追記する。過去の成功記録とは区別する。R05の自動提出は開いた専用画面の要求方式のまま。既存DB/実研究データ/通常公開には触れない。


最終結果: 初回全体`eol-missing-full`は旧分析UIの特徴量パネル待機でタイムアウト。期待値は変更せず、失敗時screenshot採取を同テストへ追加した。隔離実行権限での単独診断1回はEdgeパイプエラーで起動せず、通常のブラウザー実行権限の単独再実行は成功。初回タイムアウトの根本原因は未特定・再現せず。新しいDBの`eol-missing-final`全体suiteは55/55成功（合計726,208ms）。初回失敗を成功扱いしない。

最終全体検証の開始後/終了時ソース指紋は319A9B27166B15C7CF3858C528A7422CB9788CE1B98EC1ABE1E947F1A5C649B5で一致。変更は検証コード5件と本書/結果のみ。本体/migration/公開ゲートは変更していない。frontend/srcとpackageの21ファイルを前回成功時の保存指紋と照合し全て不変。backend型検査・Lint・buildは今回成功、frontend静的検査は既存成功記録を利用。

今回専用のtarget/full/final模擬DB3件はID/用途/nonce/DB名/bindなし/パス/リンクなしを検査してcontainer/volume/cache/manifestを削除。先行バックアップ/未追跡ファイルは保持。suiteが生成した開始時cleanのsurvey結果だけを戻し、今回の一時mobile画像だけを削除した。run固有の検証結果は保持。コミット/push/GitHub更新/既存DB接続・適用/通常公開なし。実機LAN/20端末/実研究/本番運用は未検証。


## Exportレビュー指摘3件の対応

開始時は同じworktree/branch/HEAD、351項目・staged 0。既存差分とA/B文書を保持し、今回触る既存3ファイルを`.local/export-review-before`へ保存。

`experiment-research.ts`は成功だけでなく404/409/例外経路でも、監査より先に読取りtransactionをrollbackし接続を解放する。rollback失敗接続は破棄する。UUIDは検証後に小文字へ正規化し、SQLと所属比較/監査へ同じIDを使う。

関連調査で既存experiment_run_auditのreason_code CHECKにresearch_data_inconsistent/research_unavailableがなく、監査失敗となることも確認。追加migration179115で許容コードのみを拡張する。旧migration/旧行/旧コード/監査outcome契約は変更せず、downはデータ保護のため前方修復を要求する。

接続数1・取得待機上限300msの実PostgreSQL PoolとHTTPで404を4並行要求した修正前検査では、404になるべき応答が503となった。無期限停止そのものを実行した結果ではなく、上限付きで接続枯渇を再現した証拠。最初の試行はテストラッパーがPoolのcallback接続方式を保持できず失敗しており、製品不具合の再現とは区別した。

`experiment-export-pool-checks.ts`は既存の合成learner fixtureから呼び出し、実DB・実研究者認証・接続数1で404/409/503を各4並行要求し、HTTPコード/安全な本文/監査outcome・reason_code、直後の200正常要求を確認。503は実SQLエラー、409は同DB内の別実施に実登録したSessionをテスト用読取りラッパーで所属検索結果へ返して再現する。永続所属や制約は変更しない。UUID小文字/大文字/混在は同じ実施JSONとなる。通常の学習者認可・R05非混入・JSON/CSV検証は既存経路をそのまま再実行する。

ブラウザー失敗画像は`failure-screenshot.ts`へ共通化。VISUALIZATION_DIR、未指定時はOS一時ディレクトリを使用し、保存の失敗を捕捉して元の例外をそのまま再throwする。`verify-failure-screenshot.ts`で成功時に撮影しないこと、撮影失敗でも元の例外オブジェクトが維持されることを確認し、旧分析UI検証の冒頭から実行する。初回UIタイムアウトの原因をこの変更で確定・修正したとは扱わない。

今回の対象`export-review-target-suite-results.json`は2/2成功（旧分析UI、実新protocol分析/Export）。backend型検査・Lint・buildも成功。frontend src/package/設定は不変であり過去成功記録を利用し、変更したfrontend検証scriptは実行して確認。別の新規模擬DBによる全体suiteをexport-review-fullへ記録。開始後ソース指紋はB89B4C0C6DAB65620720E08FC2096821C28C517591BFEFB479029F43848F62ED。既存DBへの接続/適用、通常公開、コミット/push/GitHub更新なし。


最終結果: `export-review-target`対象2/2成功。`export-review-full`全体55/55成功（741,780ms）。接続数1の並行404/409/503・各監査・後続正常要求、UUID3表記、別実施Sessionの混入拒否、撮影失敗時の元例外保持も全体内で成功。ソース指紋B89B4C0C6DAB65620720E08FC2096821C28C517591BFEFB479029F43848F62EDが開始/終了で一致。初回fixture失敗、修正前503再現、修正後成功は別の記録とした。過去のUIタイムアウト原因は未特定のまま。

変更: experiment-research.ts、追加migration179115、experiment-export-pool-checks.ts、既存experiment-research-checks.ts、failure-screenshot.ts、verify-failure-screenshot.ts、旧分析ブラウザー診断呼出し、本書/結果。schema制約を緩めたのは監査理由コードの追加だけで、認可やMap/履歴/教材/参加者所有制約は不変。今回作成した専用2コンテナー/volume/cache/manifestは用途/ID/nonce/DB名/bind/パスを確認して削除済み。開始時cleanのsurvey生成結果だけを復元し、今回生成mobile一時画像を削除。先行バックアップ/差分/A/B文書は保持。実DB/LAN/本番/20端末同時利用は未検証。コミット/push/PR/Issue/通常公開なし。


## PR38 実施開始APIの接続待ち修正

開始時HEADはe09e751e2a0800c6f4c71894b383812d3be80559、追跡済み差分なし、未追跡268件。既存バックアップと単位A/B文書は保持した。

開始ルートの接続取得をtry内へ移し、拒否・例外時はrollbackとreleaseを完了してから別接続で監査する。rollback失敗接続は破棄し、二重releaseを防ぐ。監査も失敗した場合は固定503とX-Experiment-Start-Audit-Saved:falseを返す。開始条件・受付票・所属・公開ゲートは変更しない。

新規experiment-start-pool-checks.tsを既存learner検証から実行する。製品の開始ルート、既存accessControl、実PostgreSQL17、max:1/接続待機上限1000msのPool、検証用HTTPサーバーを使う。404と参加者0件409は実DB状態。書込み障害は状態UPDATE後の受付票INSERTを実SQLエラーへ置き換え、監査障害は監査INSERTを実SQLエラーへ置き換える。通常サーバー全体をmax:1で動かす検証ではない。

各4並行の404/409/503、HTTPと監査outcome/reason_code、監査不能ヘッダー、秘密値・SQL本文非露出、PREPARINGと受付票0件へのrollback、各ケース後の正常開始、同一キー4並行200と成功監査/受付票1件、再開始409、未認証拒否を確認した。既存の所属・固定教材・学習者分離・開始競合検証は維持する。

失敗経過: 修正前は404要求が接続待ちで503となり再現した(start-pool-repro)。修正後の初回はテストの監査障害注入がcallback接続へ届かず失敗したため、Pool.query経路も注入するようfixtureを修正した(start-pool-target)。その後の対象learnerは成功(start-pool-fixed)。関連run-management/participant-accessも成功。

Node24.15.0/Windows/Edgeの最初の全体は53件成功後、2回目の学習者ブラウザーのパレットドラッグ待機で停止。単独の実API・ブラウザー再実行は期待値変更なしで成功したが原因は未特定。次の全体はNode24ネイティブ終了3221226505で停止した。Node22への切替時にDB再利用による固定fixture件数不一致も発生し、これは準備の誤りとして分離した。これらを最終成功扱いしない。

最終検証: 公式配布物のSHA-256照合済みNode22.23.4、Windows、PostgreSQL17.11、Edge、loopback、ONLY_SYNTHETIC、新規stage1_mock_start_node22で全体55/55成功(start-pool-clean22-suite-results.json)。backend typecheck/lint/buildもNode22で全て成功。frontendソース・設定は変更せず、関連ブラウザーは全体で実行した。過去の55/55記録とは別の今回の結果。

専用DBは既存db:mockのcreate/migrate/safety/seed/checkを使用し、suiteは対象をRESEARCH_SUITE_ONLY=test:experiment-learner（関連はtest:run-management,test:participant-access）、全体は同変数を解除してRESEARCH_BROWSER_CHECKS=1/BROWSER_CHANNEL=msedgeで実行した。各結果prefixは上記のとおり。生の中間記録はローカルだけに保持しコミットしない。

今回作成した専用DB4件はcontainer ID/名前/用途/nonce/DB名/loopback bind/volume/cacheパス/リンクなしを確認して後片付けした。今回の一時Node配布物も削除した。生成された開始時cleanのsurvey結果だけを復元し、先行未追跡ファイルは保持。既存DB適用、実機LAN、複数端末、本番運用、旧分析UIと今回パレット待機の根本原因は未確認。通常公開は無効のまま。

### Map状態CSVの追加列（2026-11-13）

既存16列の順序・意味を維持し、末尾に `mapStatus`、`mapSubmittedAt` を追加する。実施単位とSession単位のMap状態CSVに共通適用し、JSON・旧protocolのCSV契約は変更しない。列数固定の利用側は18列へ対応し、可能ならヘッダー名で取得する。外部のCSV利用処理は未確認であり、完全な後方互換性を保証するものではない。リポジトリ内の利用側はヘッダー名で解析しており、列順は対象API検証でも確認する。

両列は同一読取りトランザクションのJSON `maps[].status` / `maps[].submittedAt`（DB `maps.status` / `maps.submitted_at`）をそのまま使う。`mapStatus` はMap本体のDRAFT/SUBMITTED等、`mapSubmittedAt` は保存された提出時刻のISO8601 UTC（Z）。未提出のnull時刻は空欄で、時刻・提出状態をイベントから補完しない。Mapが存在しない行は両列空欄とし、既存のstatus/reason/stateの欠測表現を維持する。欠損snapshotや不整合履歴でも、保存済みMapの情報とsnapshotの取得可否を混同しない。

`SAVED_AT_READ` は取得時のMap本文、`INTEGRATION_START` は過去の開始snapshot、`ACCEPTED_SUBMISSION` は受理済み提出snapshotを表す。**追加2列は全行で取得時点のMap本体のメタデータ**であり、開始snapshot時点の提出状態ではない。したがって提出済みMapの開始snapshot行にもSUBMITTEDと現在保存されている提出時刻が入る。snapshotの時点は従来のpoint/recordedAtで判断する。status=AVAILABLEは引き続き状態記録の取得可能性であって提出済みを意味しない。提出snapshotが欠測の場合も、Map本体のSUBMITTEDだけを根拠に完成snapshotを作らない。

今回の検証（2026-11-13、Windows / Node 24.15.0 / PostgreSQL 17-alpine、専用使い捨て模擬DB・合成データ）:

- 初回: event-export-samples、旧stage1 integrationは成功。experiment-researchは追加した検証が別実施の参加者を主実施IDで検索して失敗（検証fixtureの所属指定誤り、製品のCSV不具合ではない）。`csv-submission-initial-suite-results.json`を保持。
- 修正後: 新規模擬DBでexperiment-research、event-exportが2/2成功。実製品APIの実施JSON/CSVとDBの保存行を照合。SB下書き、未提出統合、Map未作成、手動/自動提出済み、過去の開始snapshot行を確認。対象DBだけで開始snapshotを削除してAPIを呼び、追加列は保存Map情報のまま、snapshotはINITIAL_SNAPSHOT_MISSING_OR_INVALIDかつ空欄となることを確認し、finallyで復元。新たなmigrationやDB制約緩和はなし。
- 既存研究者認可、仮名化、R05 Map/履歴の非混入、JSON/CSV整合、旧CSVの式注入保護を含む。最終記録は`csv-submission-target-suite-results.json`。全体suiteは再実行していない。
- 最終backend typecheck/lint/buildとgit diff --check成功。模擬DB2件・専用volume・今回の一時データを削除。通常公開設定は変更していない。外部のCSV利用処理、実研究データ・実機LAN・本番運用は未確認。
