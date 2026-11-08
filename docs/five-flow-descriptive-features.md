# 新5活動の記述的特徴量：stage1-5-descriptive-v1

作業指示94520。Issue #24の研究側で決定済みの集計方針のみを実装する。

## 作業基点と差分

開始worktreeは `C:\Users\kyoum\.codex\worktrees\five-flow-regression\analysis-layout-repo`、branchはcodex/integration-merge-release、HEADは08cbfea1c12d5a2caeb21cc8aa9ecee1a2cfe937、statusはclean。GitHubの最新main e86744354a540d2e28599616d30032aa6ea31818とIssue #24を再確認し、最新mainからcodex/five-flow-descriptive-featuresを作成した。リポジトリ/祖先の指示ファイルは既存確認とrg検索で見つからなかった。PR #23のworktreeや差分は変更しない。

|項目|開始時の判定|今回の変更|
|---|---|---|
|開始snapshot、手動/自動提出のv5全状態、Merge解除・Undo/Redo・再送|既存実装済み|保存/進行処理は変更しない|
|旧4活動のstage1-descriptive-v2とfeatures.csv|既存実装済み|算出式・列・値・適用範囲を維持。全列とAPI値の回帰assertionを追加|
|新5活動の開始/完成/差分、主体/結果別件数|未実装|読取り算出サービス、専用API/CSV、分析画面を追加|
|実研究DB・本番/LAN/同時利用|要検証|模擬検証では保証しない|
|細かい由来分類、接続性、密度、中心性、意味評価、未決定の研究条件|今回の対象外|新指標・初期値を追加しない|

## 定義

- 適用：STAGE1_5だけ。featureVersionは `stage1-5-descriptive-v1`。旧4/6活動に適用しない。
- 開始：INTEGRATION Mapに対してサーバーが保存したsnapshot_version=1の初期snapshot。構造・ID・参照等を既存v5状態validatorで検証する。
- 完成：SUBMITTEDのMapに対し、一意なSUCCESSのMAP_SUBMITまたはMAP_AUTO_SUBMITのafter状態。生成元Map/Session、対象ID、Map型、初期記録/提出/イベント時刻の順、旧境界と保存snapshot、全混在履歴の再生結果、現在の提出済みDB状態と一致することを確認する。成功提出後にさらに成功した状態操作があれば拒否する。現在の編集中状態や旧ログを完成状態に読み替えない。
- activeConcepts：各snapshotのConcept IDのうちmergedIntoConceptId=nullの個数。
- hiddenMergeSources：mergedIntoConceptIdがnullでないConcept IDの個数。A+B→M、M+C→Nはactive=1、非表示元=4。Nの1段階解除後はactive=2、非表示元=2。
- links：snapshotのLink ID個数。同じ端点でも別IDは別に数える。自己ループ/多重リンクを除外する指標ではない。
- delta：完成－開始。両側AVAILABLEの場合だけ計算する。

三つの集計点をそれぞれstatus/reason付きで返す。未提出はcompletion.reason=NOT_SUBMITTED。開始snapshot欠損/不正はINITIAL_SNAPSHOT_MISSING_OR_INVALID。受理済み状態の特定不能はSUBMISSION_STATE_UNAVAILABLE、履歴/現在状態等の不一致はHISTORY_INCONSISTENT。deltaはSTART_OR_COMPLETION_UNAVAILABLE。存在しない統合MapはINTEGRATION_MAP_MISSING。数値は算出不可ならnullであり、0に補完しない。startが検証できれば、completionが算出不可でもstartの値は表示できる。

開始・完成のMap全体は既存の生データ/イベントJSON出力を使用する。本APIはその記録を根拠とした件数と根拠ID・時刻を返し、Map保存やProvenanceの分類を新設しない。

## 保存済み操作結果

操作結果の集計範囲は `SAVED_AT_READ`：同じ読取りトランザクションで見える、当該統合Map/Sessionの保存済みMap操作イベント全体。完成snapshot時点で打ち切る集計ではない。提出後に保存された拒否も含み得るため、sampledAtと明確に区別する。

対象操作種別：ADD/EDIT/MOVE/DELETE_CONCEPT、MERGE_CONCEPT、IMPORT_KIT_CONCEPT、ADD/EDIT/MOVE/DELETE/RECONNECT_LINK、IMPORT_KIT_LINK、UNDO、REDO、MAP_SAVE、MAP_KIT_ASSIGN、MAP_SUBMIT、MAP_AUTO_SUBMIT。授業、アンケート、研究者閲覧、配信など他のイベントは含めない。

research_eventsは保存されたactor_type/outcomeごとに件数を返す。SUCCESS、FAILURE、REJECTED、CANCELLED、UNKNOWNを合算しない。イベントのschema versionを限定せず、当該Map操作に該当する保存行を数える（例：system auditの自動提出失敗）。構造再生は既存のv2/v5境界を使用し、不成功イベントを状態変化として適用しない。

旧map_operation_logsはhistorySource=LEGACY、actorType=UNRECORDED、outcome=UNRECORDEDとして独立させる。結果不明と結果未記録をSUCCESSに補完しない。Undo/Redoも保存された結果区分の行として独立に含める。初期配置は操作イベントを新設しないため操作件数に加算しない。

同じキーの失敗と成功は別の保存結果なので別々に数える。同じ成功要求の再送は既存受付票で重複保存されないので増えない。キーだけで異なる結果行をさらにまとめない。これは全試行数やブラウザー未送信操作数ではない。

構造の算出可否と、観測できる保存行数は別に扱う。DB読取り自体が失敗した場合は安全なエラーを返し、空の集計を返さない。

## API・CSV契約

研究者認証・認可が必要。新しい識別子やDB項目は保存しない。

- GET `/api/research/stage1/sessions/:sessionId/descriptive-features`：新5活動専用。未完了Sessionも読取り可能。新5活動以外は409 wrong_protocol、不存在は404。
- GET `/api/research/stage1/sessions/:sessionId/descriptive-features.csv`：同じ算出サービスによる別CSV。
- 完了済み新5活動の既存analysis応答には別フィールドdescriptiveFeaturesを追加する。既存featuresは{}を保持。旧4活動のfeaturesと既存features.csvは変更しない。
- 読取りはREPEATABLE READ READ ONLYの一つのsnapshotで照合・集計する。sampledAtはそのトランザクション時刻。各API/CSVの取得は別トランザクションなのでsampledAtは異なり得る。閲覧・出力監査には既存方針を適用する。

CSVはUTF-8 BOM、CRLF、RFC 4180の既存csvCellを使用。固定列順：

```
featureVersion,protocolKey,sessionId,mapId,sampledAt,aggregationPoint,status,reason,activeConcepts,hiddenMergeSources,links,capturedAt,submittedAt,submissionEventId,submissionEventType,submissionEventServerTimestamp,historySource,actorType,outcome,savedEventCount
```

start/completion/deltaの3行を必ず返し、その後にSAVED_AT_READの主体・結果・記録種別ごとの観測行を返す。イベントが0件ならその観測行はない。APIのoperationResults.totalはそれらのcountの合計である。構造行のsavedEventCount、操作結果行の構造値は適用外で空欄。算出不可の構造値も空欄だが、status/reasonで区別できる。正当な0は0として出力する。startのcapturedAt、完成のsubmittedAt・提出イベントID/種別/観測時刻を付け、集計時点を失わない。数値の負のdeltaは数値としてCSVへ出力する。

画面は開始/完成/差分を先に表で示し、その後に記録種別・主体・結果ごとの件数を示す。算出不可は理由付きで表示する。旧4活動の既存特徴量欄を置き換えない。

## 今回の検証

既存検証記録の再掲ではなく、今回の専用worktreeで実行する。新規DB stage1_mock_94520のみを作成し、呼出し元DATABASE_URLを除外、NODE_ENV=development、STAGE1_MOCK_DATA=ONLY_SYNTHETICでdb:mock create --mock-data-only、migrate、seedを実行した。

- `npm run test:five-flow-features --prefix backend`：成功。多段Merge状態/1段階解除状態、異なるIDの同端点リンク、手動/自動の共通定義、欠測、結果/主体/旧ログ区分、CSVを合成状態で確認。
- RESEARCH_SUITE_ONLY=test:five-flow-features,test:session-flow-survey,test:five-flow-compositeで専用DBのdb:mock suite：成功。実APIの受理済み手動/自動状態、PR #26由来の多段Merge解除・再送、DB snapshotと件数/差分/結果区分の一致、認可、初期snapshot欠損・現在状態不一致を確認。UNKNOWNはテスト専用に既存の検証済みイベント挿入関数で保存し、CANCELLEDは実取消APIで作る。
- test:stage1:integration：旧4活動の全CSV列順と全値が既存features APIと一致、新5活動専用API/CSVが旧4活動を拒否することを追加確認して成功。
- `npm run test:stage1-analysis-layout-browser --prefix frontend`：mock API+Edgeで版/値/欠測/未提出/履歴不整合/CSVダウンロードと旧4/6活動の新欄非表示を確認して成功。
- 専用DBのsuite内でtest:five-flow-features-browser：実API+Edgeで画面の開始/完成/delta、版/protocol、主体/結果、実ダウンロードCSVを照合して成功。先に同じ隔離suiteの新5活動合成fixtureが必要で、全体suiteではそれらの後に登録する。
- backend/frontendのtypecheck/lint/build：6/6成功。新しいDB検証スクリプト追加後もbackendの3検査を再実行し成功。
- test:five-flow-feature-mapsを専用DBで追加実行して成功。テスト専用の提出済みSB/KBと活動進行をSQL fixtureで準備し、統合作成・二段Merge・解除・提出は実APIを使用。未解除の提出でactive=1/非表示=4/Link=2、外側1段階解除後の提出でactive=2/非表示=2/Link=2、開始はいずれも3/0/2。保存snapshotと現在DB、APIの件数・差分が一致する。全活動をこのfixtureだけで実行したとは数えず、前述の複合検証と区別する。

関連suite最終実行は22/22成功。RESEARCH_BROWSER_CHECKS=1、BROWSER_CHANNEL=msedge、RESEARCH_CHECK_REPORT_PREFIX=five-flow-features-related、RESEARCH_SUITE_ONLYは次の値でdb:mock suite --name stage1_mock_94520を実行した：

```
test:undo-redo:unit,test:merge-release,test:five-flow-features,test:map-mixed-history,test:event-export,test:stage1:integration,test:session-flow-survey,test:five-flow-composite,test:map-api-v2,test:map-failure-retry,test:map-auto-submit-v2,test:server-audit,test:delivery-reliability,test:research-log-ui,test:stage1-analysis-layout-browser,test:link-position-browser,test:session-flow-survey-browser,test:five-flow-feedback-browser,test:five-flow-features-browser,test:undo-role-browser,test:delivery-browser,test:event-export-browser
```

集計はfive-flow-features-related-suite-results.json。実DBの多段Merge提出対象検証はRESEARCH_SUITE_ONLY=test:five-flow-feature-maps、RESEARCH_CHECK_REPORT_PREFIX=five-flow-features-nestedで実行し、five-flow-features-nested-suite-results.jsonに記録した。CI全体suiteにも対象検証を登録した。

five-flow-features-related-composite-results.jsonのfeatureCounts配列は[active概念,非表示Merge元,Link]順で、今回の全5活動合成fixtureは開始[3,0,1]、完成[12,0,4]、差分[9,0,3]。これは研究条件や推奨規模ではない。

専用コンテナー259af91bc646b039c306e761ef2bd3b9de68b55f58f284d733a9e084fd0e1443はmanifest名/IDとDocker名/purpose/nonceを照合してvolumeとともに除去済み。専用manifest/cacheと不要な生成画像・出力も後片付けし、検証が生成した既存文書変更を提出差分から除去した。既存DB・研究データへは接続しない。

準備中：変更追加時のpatch適用は画面側の文脈不一致で一度拒否され、部分変更がないことを確認して分割適用した。frontend Lintのeffect内同期setState指摘は、Session IDをkeyにして再マウントする方法に修正した。最初の関連suiteは15番目の分析画面ブラウザー検証で停止した。旧4活動fixtureがデータ取得前の見出しを読んだ待機競合であり、具体的な「フロー：4活動（旧形式）」の表示を待つよう修正した。未取得状態を旧4活動と誤表示しない画面変更は維持した。初回の集計はfive-flow-features-related-attempt-suite-results.jsonとして最終22/22成功と分けて保持する。

全fixtureはテスト専用。教材・アンケート・seed個数・実験時間等の初期値や推奨内容として追加しない。新指標はactive/非表示とリンク件数に限定する。操作数・構造から困難・理解・学習成果・因果効果を断定しない。実研究DB、実機LAN、20端末同時利用、本番運用は今回の模擬検証では保証しない。
