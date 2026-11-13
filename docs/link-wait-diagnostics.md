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


## KB drop未到達の追加診断（2026-11-13）

PR #43 `78f8027` のPR用・push用CIでは両方ともpointerdown=1、dragstart=1、canvas drop=0、一時リンク未生成。これだけでは製品・検証どちらの原因とも断定できない。

操作前にpassive captureリスナーを登録し、既存の件数にdrag・dragend・canvas dragoverを追加する。イベント座標・重なり先の固定分類・dropEffectを先頭12件と最後1件だけ記録し、失敗時だけ出力する。dropEffectはブラウザー報告の列挙値であり、サーバー受理を表さない。キャンバス矩形と、検証が指定するpadding box基準の予定ドロップ点（400,200）の開始前・失敗時の画面座標、画面内判定、hit test分類も出力する。ズームや途中のスクロールを含むブラウザー内部の最終ドロップ座標そのものを保証せず、イベント座標と併せて読む。実際のdropがなければその座標を作らない。

分類はcanvas／concept／connector／palette／drawer／dialogと、許可したHTML/SVGタグの汎用分類に限定し、テキスト・ID・クラス文字列・URL・ヘッダー・本文・認証情報を出力しない。監視でpreventDefault・stopPropagation・dataTransfer変更・イベント再送はしない。成功条件、待機時間、操作回数は変更しない。

環境はWindows・Node 22.23.5・Chromium headless shell 156.0.8078.4。準備済みLinuxブラウザー実行環境はなく、Linux CI（Node 22.23.4・Chromium channel指定）との差を残す。新規使い捨てDB `stage1_mock_kb_drag_detail` と製品API・既存認証・合成教材／Sessionのみを使用する。自己検証は20回の合成dragover・drag/dragend/dropと意図的な100ms待機失敗で、件数・記録上限・元例外保持を確認する。合成イベントは自己検証だけで、製品APIのブラウザー検証には注入しない。

今回の追加診断で対象2/2成功、SB・KB・統合の実API・DB方向照合成功、個別型確認・差分チェック成功。CI失敗はローカルでは再現せず原因未特定。模擬DBはID・用途・nonceを照合して削除し、集計JSONはローカル保持する。ローカル全体suiteは再実行しない。
