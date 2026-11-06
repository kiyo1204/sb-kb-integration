# 新5活動の統合Map：Merge結果の削除による1段階解除

## 仕様と範囲

作業指示58304で研究者が選択した意味を実装する。新5活動（STAGE1_5）のINTEGRATION Mapに限定し、Merge結果Conceptの削除で、そのConceptを生成したMergeを1段階解除する。旧4/6活動、SB seed、KBの挙動は維持する。DB変更・マイグレーション・過去イベントの更新はない。

開始場所は `C:\Users\kyoum\.codex\worktrees\five-flow-regression\analysis-layout-repo`、開始branchはcodex/integration-merge-delete-review、HEADはc2dad8e20c1a3df8361caf6e1f7614dce3f79e72、statusはclean。GitHubのmainとIssue #24を再確認し、同じ最新mainからcodex/integration-merge-releaseを作成した。PR #25はマージ済み。リポジトリと祖先にAGENTS.mdは見つからなかった。PR #23のworktree・差分は変更しない。

## 状態遷移

- A+B→Mの後にMを削除：Mを現在DBから削除し、直接の元A/BをMerge直前のラベル・座標・Provenanceで復元する。元の関連Linkも同じID、接続先、ラベル、保存済みラベル座標、Provenanceで復元する。
- A+B→M、M+C→Nの後にNを削除：M/Cのみ復元し、A/B→Mを維持する。Mを改めて削除するとA/Bが復元される。
- Merge前にあったLinkへの後続編集・削除・再接続は、そのMerge直前状態へ戻す。現在削除対象に接続している後発Linkは通常Concept削除と同じく削除する。それ以外のConcept/Linkの後続編集、MapのKit設定などは巻き戻さない。
- 現在DBから消えたM/NのProvenanceは過去のMergeイベントと削除直前snapshotに残る。現在Mapと歴史上の資源は同一視しない。tombstoneや孤立参照は作らない。

`merge-release.ts`は、検証済み混在履歴中の生成Mergeが一意であること、直接元が2個で現在も対象に統合されていること、MERGED_FROM、復元後状態を確認して局所差分を作る。Merge前の復元候補を作るためにprefixを再生するが、その全MapをDBへ戻さない。

Concept削除APIは既存Mapロック・トランザクション内で、既存applyHistoryStateDeltaにより変更対象だけを書き込む。新しいv5 DELETE_CONCEPTに削除直前/解除直後の全Map snapshotを保存する。既存Undo/Redoはこの新操作の差分を使用し、削除直前状態と解除後状態を相互に完全復元する。

生成Mergeや状態・参照が不明なら409 `merge_release_unavailable`。DBの外部Provenance参照制約などによる拒否は既存の409 `concept_lineage_protected`。いずれもトランザクションをロールバックする。既存の履歴不整合時の記録防護も維持し、保存できない拒否記録を保存済みとは返さない（logSaved=false）。

成功受付票はid/mapId/mergeReleasedを保持する。削除済みIDの同一キー再送でも、同一要求の受付票と認証済みSessionの現在Map権限を再確認して既存結果を返す。別Sessionや期限・進行状態が変わって権限を失った要求を、この経路で再認可しない。

UIは新5活動の統合だけで削除を有効にし、直接元とリンクの復元、内側Merge維持、後発Link削除を確認前に説明する。解除後はサーバーから再読込みする。

## 検証経路

- `test:merge-release`：DBを使わない合成状態で局所変更、生成Merge欠落/重複、before欠損、非表示Merge元の拒否。
- PR #25由来の`test:five-flow-composite`を拡張：新5活動を実APIで完了し、単段/多段解除、直接元の削除拒否、元Linkの内容・座標、後発Link削除、無関係な後続編集、Undo/Redo、成功イベントINSERT故障のロールバック、受付票の未保存、同一キー再試行/重複、未認証/別Session拒否、未記録のlineage拒否、旧4/6活動のMerge結果削除拒否を確認する。以前のイベントIDと前後snapshotが不変であることも照合する。
- 同じ複合検証の全イベントprefix再生、DB/初期・完成状態/Provenance、研究者JSON、イベントJSON、共通CSV、map_operations.csvのID・順序・件数・結果・時刻・before/after照合を再利用する。
- `test:five-flow-feedback-browser`を拡張：mock API+EdgeでKB freshnessと統合の判定非表示を維持し、N→M/C→A/Bの確認文・削除有効化・再読込み表示を確認。旧4/6活動は削除無効。DB照合とは別の画面検証である。

fixtureのラベル・設問はすべてTEST-ONLY。教材・推奨内容・アプリ初期値へ登録しない。

## 今回の実行

新規専用DB stage1_mock_58304のみ使用。呼出し元DATABASE_URLを除外し、NODE_ENV=development、STAGE1_MOCK_DATA=ONLY_SYNTHETICでdb:mock create --mock-data-only、migrate、seedを実行した。

- `npm run test:merge-release --prefix backend`：成功。
- `RESEARCH_SUITE_ONLY=test:merge-release,test:five-flow-composite`、`RESEARCH_CHECK_REPORT_PREFIX=merge-release-target`で専用DBの`db:mock suite`：成功。
- `npm run test:five-flow-feedback-browser --prefix frontend`（Edge）：成功。
- backend/frontendの`npm run typecheck`、`npm run lint`、`npm run build`：成功。

関連20検証はすべて成功。RESEARCH_BROWSER_CHECKS=1、BROWSER_CHANNEL=msedge、RESEARCH_CHECK_REPORT_PREFIX=merge-release-relatedを指定し、RESEARCH_SUITE_ONLYには次を指定した：test:undo-redo:unit、test:merge-release、test:map-mixed-history、test:event-export、test:stage1:integration、test:session-flow-survey、test:five-flow-composite、test:map-api-v2、test:map-failure-retry、test:map-auto-submit-v2、test:server-audit、test:delivery-reliability、test:research-log-ui、test:stage1-analysis-layout-browser、test:link-position-browser、test:session-flow-survey-browser、test:five-flow-feedback-browser、test:undo-role-browser、test:delivery-browser、test:event-export-browser。

今回集計はmerge-release-related-suite-results.json。最終対象結果はmerge-release-target-composite-results.json（Mapイベント63件、統合イベント47件）。最後に失敗記録logSaved=trueとDB/JSON/CSVのactor_type一致も追加して対象検証を再実行し、成功した。最終assertion追加後もbackend型検査・Lint・ビルド成功。GitHub Actionsの最終結果は提出PRに記載する。

専用コンテナーb0143635cdc6c9e02f1d8ce249db484d505b8966a601928acdd9aadb2fe9f740は、manifestの名前・ID、Docker名・purpose・nonceを照合してvolumeとともに除去した。専用manifest/cacheも削除済み。関連検証で生成された既存文書の変更とスクリーンショットは提出差分から除去した。

準備中の結果を最終成功と混同しない：初回suite子プロセスがWindows終了コード3221226505で停止し、同条件の再実行では起動した。sandbox内のEdge起動も失敗したため承認された通常ホスト環境で実行した。fixtureの概念座標が重なってクリックできない点と、別Session作成fixtureの必須配列・設問の不足を修正した。初回型検査ではGoal専用表示経路に不要な統合条件を追加していたため削除した。製品側では、削除済みConceptの既存再送認可が結果不明を返す問題を対象検証で検出し、新しいMerge解除だけMap所有権による再認可を追加した。

## 限界

実ブラウザーの検証はmock API、API/DB/出力の検証は別の合成経路である。実研究DB、実機LAN、20端末同時利用、本番運用、あらゆる通信障害の組合せを保証しない。履歴不足・外部参照など安全に解除できない場合は拒否する。SBリンクラベル座標の初期継承の必要性、新5活動の特徴量定義、教材・アンケート等の未決定事項は決めない。過去のPR #25検証文書は当時の実行記録として保持し、Merge削除制限についての現在の実装状態は本書に記載する。
