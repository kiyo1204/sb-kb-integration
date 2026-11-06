# Issue #24 第1段階: 新5活動の複合回帰

作業指示60483。今回の実行は2026-11-06、合成fixtureだけを利用。

## 起点・保護

GitHub mainは775359271e18c5855f1e4eb99013b7b947879041、Issue #24を再読した。PR #23はopen/unmerged、head 60e52ef7895391bfc7dba9f5d61a93b10bae11b0。旧worktreeとPR #23は変更していない。

元の作業場所 C:/Users/kyoum/.codex/visualizations/2026/11/06/01a1aec2-e76a-7bf2-a3f8-eb3738f49022/analysis-layout-repo は codex/session-cleanup-delete / 60e52ef、開始時clean。mainをfetchし、別worktree C:/Users/kyoum/.codex/worktrees/five-flow-regression/analysis-layout-repo を作成した。専用branchはcodex/five-flow-composite-regression、開始HEADは7753592、開始statusはclean。確認可能な祖先とリポジトリ内にAGENTS.mdなし。

## 変更と根拠

既存verify-session-flow-survey.tsは統合の作成直後提出を含み、verify-stage1.tsの複合編集は旧4活動が中心だった。重複する機能テストを新規実装せず、これらを関連suiteとして再利用し、新5活動における状態・出所・再送・出力の境界照合だけを追加した。プロダクトAPI/UI・DBスキーマ・マイグレーションは変更していない。

- backend/src/scripts/verify-five-flow-composite.ts: 既存APIによる新5活動の完了、DB直接読取り、履歴再生、出力の照合。
- frontend/scripts/verify-five-flow-feedback-browser.ts: mock APIでの学習者画面。KB結果表示と別状態を観測後のstale表示、統合で編集UIがあり一致確認UI/要求がないこと。
- backend/package.json、frontend/package.json、run-research-event-suite.ts: 対象検証を実行・CI全体suiteへ登録。

TEST-ONLYと明記した独立Goal/Kit/概念/関係/設問を各実行で作り、アプリの初期値・推奨内容やseed-devへは登録しない。fixtureの個数や30分の実行猶予は研究条件ではない。

## 今回確認した経路

1. 新SessionがSTAGE1_5、群null、授業→SB→KB→統合→アンケートで作成・完了する。
2. 教師指定seedだけがSBへ初期配置され、CLONED_FROMとSessionのseed対応がDB・JSONに一致する。名称変更・削除は409、移動・リンク作成、一般概念の追加・編集は成功する。
3. KBを一致状態に構成し一致確認・表示を記録。その後に接続を変え、過去の一致結果があっても提出409・DBのDRAFT保持を確認。signatureも変わり、正しい接続へ戻して最新再確認・提出後にDBがSUBMITTEDとなる。
4. 提出済みSBから統合が複製され、based_on参照、概念/リンクのCLONED_FROM、方向・ラベル、KB使用Kitの対応が保存される。統合の一致確認GETと表示POSTへの直接要求は404。
5. 統合の概念追加・名称編集・移動、リンク追加・名称編集・再接続・削除、Kit概念/リンク取込み、概念削除時のリンクcascade、Undo/Redo、Merge、手動提出を実行。代表的な編集ごとにDBとmixed-historyを照合する。
6. 統合の成功EDIT_CONCEPTイベントINSERTに一時的な失敗triggerを入れ、操作を409/map_history_unavailableとして拒否、Mapの変更なし、FAILURE記録を確認。trigger除去後、同じIdempotency-Keyで再試行し、重複再送してもSUCCESSは1件。履歴・出力に失敗と成功が区別して残る。
7. 削除UndoでConcept/LinkのID、座標、Provenance ID・source・relation・時刻が戻ることを照合。完成後は全統合イベントprefixを再生し、SUCCESSのbefore/after、FAILURE/REJECTEDの状態不変、最終DBとの一致を確認する。
8. Session生データJSON、研究者分析、イベントJSON、共通CSV、map_operations.csvでSession/Map/Event/Target、順序、件数、outcome/reason、時刻、前後JSONを照合。Provenanceを含む前後状態はDB値と完全比較する。初期・完成グラフも保存値と照合する。
9. 旧4/6活動の合成sentinelについて新5活動の前後でJSONのversion・群・活動順・assessment等が変わらないことを確認する。sentinelは欠損Map警告を持つ最小完了fixtureで、旧プロトコルの実進行をこの比較だけで保証しない。旧4活動の実進行は関連test:stage1:integration、旧6活動の自動提出等はtest:map-auto-submit-v2など既存検証も今回実行した。

## 差分判定

|要件|判定|今回の証拠・保留|
|---|---|---|
|新5活動、SB seedと通常概念、KB最新判定|実装済み|新しい実API複合テストとmock UIテストで確認|
|統合の通常編集、Kit取込み、初期・完成状態、出所・履歴・出力|実装済み|今回のDB/replay/JSON/CSV照合に成功。すべての操作順列の保証ではない|
|統合にKB一致判定を適用しない|実装済み|実APIの直接要求拒否とmock UIの非表示・非要求を確認|
|Merge結果を無条件に削除する自由度|未実装|今回もconcept_merge_result_protectedで409、状態不変を確認。lineage保護との未解決差分として残し、削除意味は変更しない|
|新5活動の特徴量・特徴量CSV|未実装|分析features={}を保持。成功/試行、active/履歴資源の定義を決めず、新指標を実装しない|
|SB→統合のリンクラベル座標継承|要検証|作成APIのリンク取得/INSERTはラベル座標をコピーしない。Issue #24は継承の必要性を確定していないため、SBとの座標同一性を新要件・assertionにしない。生成された初期状態自体とその再生/出力は比較する|
|教材・アンケート内容・Seed数・全Kit要素使用・時間・授業形式等|実験側で未決定|テスト専用fixture以外へ反映しない|
|実研究DB・実機LAN・20端末同時利用・本番運用|要検証|今回の隔離模擬検証の対象外|

## 実行と結果

既存検証記録の再掲ではなく、今回のworktreeで実行した結果。

- npm ci --prefix backend / frontend: locked dependencyを導入。
- 新規stage1_mock_60483にdb:mock create --mock-data-only、migrate、seedを実行。DATABASE_URLは呼出し元から渡さず、NODE_ENV=development / STAGE1_MOCK_DATA=ONLY_SYNTHETICを指定。
- RESEARCH_SUITE_ONLY=test:five-flow-composite、RESEARCH_CHECK_REPORT_PREFIX=five-flow-target-finalでdb:mock suite: 成功。最終対象結果はfive-flow-target-final-composite-results.json。
- RESEARCH_SUITE_ONLY=test:stage1:integration,test:session-flow-survey,test:five-flow-composite,test:map-api-v2,test:map-failure-retry,test:map-auto-submit-v2,test:delivery-reliability,test:five-flow-feedback-browser、RESEARCH_BROWSER_CHECKS=1、BROWSER_CHANNEL=msedgeでdb:mock suite: 8/8成功。five-flow-related-suite-results.jsonに集計。
- npm run test:five-flow-feedback-browser --prefix frontend: 成功。
- backend/frontendそれぞれnpm run typecheck、lint、build: 6/6成功。最終対象assertion追加後もbackendの3件を再実行。

準備中の型エラー（空配列の型推論）を修正した。またKit APIはGoal接続元IDを隠すため、試験用の対応はAPIフィールドを仮定せずguard済みfixture DBから取得するよう整理した。最初の対象試行は故障注入時にHTTP 500を期待して停止したが、現行の409 map_history_unavailableが正しい契約だった。fixture期待値を修正後に対象・関連とも成功した。これらをプロダクト不具合の修正とは数えない。

全体suiteは新PRのGitHub Actionsでも実行する。ローカルでは今回の8関連検証と静的検査を実行しており、過去の全体suite成功を今回の実行とは数えない。

## 後片付け・限界

一時故障trigger/functionはfinallyで除去し、一時ExportはAPIで解放する。検証用DB stage1_mock_60483は専用manifestのname/container ID/purpose/nonceを照合してからコンテナー62b00b0a38bdc956693e82d4bdff4a95701bfc9624a06941ae27185d7a05fa5eとvolumeを除去し、manifest/cacheも後片付け済み。既存DB・研究データへは接続しない。

画面検証はmock API+Edgeであり、実APIのDB/Export検証と分けている。実ブラウザーを実APIへ接続した全5活動の操作、実機LAN、20端末同時利用、本番運用を保証しない。今回の実行済み範囲を超える通信障害の組合せや、未観測の操作の完全性も保証しない。Merge制限・研究側未決定事項・旧プロトコル/イベント/特徴量の意味は維持している。
