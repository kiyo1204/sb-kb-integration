# 新protocol SB・KBの操作案内改善

基点: main dccd759be1c0a2c2cb1b73c6ebd119c5fbc5e45e。2026-11-11に実施。既存worktreeの未追跡95件とバックアップを保持し、追跡対象が未変更であることを確認してcodex/sb-kb-state-guidanceを作成した。

## 確認と変更
Figma P05 (2:129)、P06 (2:194) のdesign contextと画像を読み取り。初期概念の注意と、確認・最終提出の近くに表示する短い案内を参考に、既存React部品・CSSで新protocolだけを補強した。図中の例示ノード・線は動的Mapの代替画像として使わない。

- SB: seedがある場合、選択前から移動・リンク接続可能、名称変更・削除不可と表示。選択中の既存説明も維持。surveys.ts seededConceptGuardとMapPageの実装に一致する案内であり、操作制約の変更なし。
- KB: ツールバー直下に未確認・確認中・保存状態不明・古い結果・不一致・一致・提出不可の理由と次の操作を表示。既存の重複する前回結果の行は新protocolの学習者KBに限り隠し、結果再表示ボタン・判定dialog・ボタンの有効条件は保持。新たな判定、正解や誤り位置の開示なし。
- backend、判定、提出、公開ゲート、旧protocol、統合Mapの機能は変更なし。

## 今回の検証
Windows / Node 24.15.0 / Edge / PostgreSQL17、合成データのみ。画面はPlaywrightで実APIに接続し、変更前後とも1366×1200。SB未選択/選択、KB未確認/不一致/古い結果/一致dialog/一致確認後を撮影し目視した。変更前のkb-stale画像は保存中を捕捉していたため、変更後は保存完了と古い結果の表示を待ってassertした。

- 変更前の対象test:experiment-learner: 1/1成功、115671ms。
- 変更後の対象test:experiment-learner: 1/1成功、113672ms。実APIの所有・提出、SB seed移動、KBパレットのマウス操作/Undo、再読込後再確認、P01〜P08、オフライン提出拒否、統合/終了の関連回帰を含む。今回追加した表示assertと画像記録も成功。
- npm run test:five-flow-feedback-browser --prefix frontend: 成功。こちらは実DBを使わない合成API fixtureで、旧KBの結果鮮度、統合のフィードバック不在、Merge解除等を確認。
- frontend typecheck / lint / build: 成功。既存500kB超のbundle警告あり。backend buildは検証起動準備として成功。backendソース変更なし。
- git diff --check: 成功。成功済み全体55/55は過去記録で、今回は全体suiteを再実行していない。

画像は.local/sbkb-before、.local/sbkb-afterに保持。結果はdocs/sbkb-before-suite-results.json、docs/sbkb-after-suite-results.json。最初のDocker照会は権限制限で失敗し、必要な権限で専用DBを作成した後の検証は成功。製品テスト失敗とは区別する。

今回作成した2つの模擬DBはmanifest/ID/用途/nonce/DB名を照合してコンテナー・volume・専用キャッシュ/manifestを削除した。既存DB、研究データに接続していない。通常公開ゲートは閉じたままで、模擬検証専用previewだけを利用。実機LAN、実参加者、複数の物理端末、本番運用は未確認。コミット・push・PR/Issue/Figma更新なし。

## 保存前レビューによる補強

2026-11-11、基点mainは引き続きdccd759be1c0a2c2cb1b73c6ebd119c5fbc5e45e、同一headのPRなしを確認した。
SBのseed保護案内はsurveys.ts seededConceptGuardと一致し、seedがない場合はsome(isSeed)により非表示。欠落ケースはブラウザー検証でMap GETのisSeedだけをfalseにした合成応答を利用し確認した。実DBのseed行や制約は変更しない。その後は実応答へ戻して移動・選択・提出を検証した。

KBの古い結果の案内を、既存の画面ボタン有効条件についての説明に明確化した。最終提出時には前回結果にかかわらずサーバーが最新Mapを再判定することを併記した。index.tsの提出transaction内readKitBuildFeedbackWithSignatureによる判定と、MapPageの既存canSubmit条件はいずれも変更しない。チェックボタン・dialog・旧protocol・統合の制御変更なし。状態は色だけに依存せず文章で伝え、確認ボタンと案内をaria-describedbyで関連付ける。

文言補強後、別の新規使い捨てstage1_mock_sbkb_reviewで対象test:experiment-learnerが1/1成功（116685ms）。新しい非seed fixtureと再判定説明のassertを含む実API/Edgeブラウザー検証。frontend typecheck/lint/buildも成功、既存bundle警告のみ。結果はsbkb-review-suite-results.json。以前のbefore/afterと今回の結果は別記録とし、全体suiteの再実行はしていない。

変更後画像.local/sbkb-reviewを確認。専用模擬DBはID・用途・nonce・DB名を照合して後片付け。今回の保存対象はMapPage/CSS/ブラウザー検証、本書とbefore/after/reviewのsuite結果3件の計7件。その他の画像・中間記録・バックアップ・単位A/B文書はローカル保持する。
