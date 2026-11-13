# リンク方向検証の失敗診断

2026-11-13、PR #43 head `8f6bc5d`、main `1a993666` を確認。PR用run 43356060784はKBの `.is-temporary` 可視待ち、push用run 43356009595は統合Mapの `invalidDrop` 内の矢印プレビューattached待ちで失敗した。原因は別々に未特定。SB診断は別ブラウザープロセスで、リンク検証への直接の変更はないが、負荷・タイミングの間接影響を否定したわけではない。

## 範囲

`link-wait-diagnostic.ts` をKBのパレットdragTo前と、統合のinvalidDropのpointerdown前に接続する。既存の15秒待機・操作・成功条件は変更せず、再試行しない。製品コード・公開ゲート・保存契約は変更しない。

失敗時だけ固定名 `kb-drop` / `integration-preview` と次の要約を出力する。

- 対象へのpointerdown、HTML dragstart、キャンバスへのdropの観測数。
- 対象結果要素が生成・可視になったことをMutationObserverで観測したか。統合の端点操作はHTML dragstartではないため、pointerdown到達とプレビュー生成を分けて読む。
- 失敗時の対象・結果要素数、各先頭4要素までの矩形・CSS可視性・画面との交差・中央のhit test、viewport寸法。

CSS可視と画面内交差は別の項目で、端末で実際に見えたことやアプリのハンドラー完了を保証しない。イベント数はAPI受理やDB保存を証明しない。セレクター・ID・テキスト・認証情報・ヘッダー・URL・本文・例外詳細は診断に出力しない。失敗時の読取りと後片付けはそれぞれ最大500msを待つ。診断の設定・読取り・出力・解除が失敗しても、操作の実行と元の検証例外を維持する。正常時は出力せず、監視を解除する。

## 検証

新規使い捨て `stage1_mock_link_diag`、Node 22.23.5、Windows、Chromium headless shell 156.0.8078.4、実製品API・既存認証・合成教材／Sessionを使用。Linux CI（Node 22.23.4、Chromium channel指定）とは異なる。通常公開は閉じたまま、専用プロセスだけ既存mock previewを使用。

`RESEARCH_SUITE_ONLY=test:link-wait-diagnostic,test:link-direction-api`、`RESEARCH_BROWSER_CHECKS=1` で対象のみを実行する。自己検証は合成DOMに意図した100msタイムアウトを作り、KB dragstart/dropあり・プレビューなしを区別し、出力失敗・ページ切断時にも元例外の同一性を確認する。これを製品障害の再現とは扱わない。個別TypeScript確認では初回にDOM.Iterable指定が不足し失敗し、指定して成功した。型依存や製品設定は変更しない。

過去のWindows/Chromiumの診断あり・なし成功は以前の結果で、今回の結果ではない。今回CIが成功しても、元のタイムアウトの解決・原因確定とは扱わない。ローカル全体suiteは繰り返さない。実研究データ、既存DB、実機LAN、本番運用は対象外。

初回の実API対象検証は、診断コールバックのtsx変換が参照するブラウザー内 `__name` が未定義で失敗した。既存の他のブラウザー検証と同じinit scriptを追加して再確認する。元のCIタイムアウトと区別する。

修正後の今回の対象検証は2/2成功。SB・KB・統合の接続、付け替え、保存、無効ドロップ、Esc、Undo/RedoとDB方向照合が成功。新規診断ファイルの個別型確認と差分チェック成功。生成した集計JSONはコミットせず保持する。専用DBはID・用途・nonceを照合して削除した。CI結果は別途確認する。
