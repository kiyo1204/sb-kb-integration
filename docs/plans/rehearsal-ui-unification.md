# リハーサル用UI統一

## 目的・基準
main `19a1898efa86d81318086f9d5fca07f7db7f2320` を基点に、淡いグリーンとニュートラル、PC・マウス、日本語・ライトモードで配置と操作の発見しやすさを揃える。稼働中のLAN環境は切り替えない。R08の未コミット差分を継承する。PR #42の取消済み操作、別worktreeの強調表示は取り込まない。

## 対象と順序
| 順序 | 画面 | 構成の基準 | 進捗 |
|---|---|---|---|
| 1 | 共通の文字・余白・操作・フォーム・表・エラー | 既存design-system、R08の緑のヘッダーと白いパネル | 共通CSS適用済み、研究者画面の確認待ち |
| 2 | ログイン・開始待ち・授業・本人完了・実施終了 | 既存単一活動カードと実際の認証・保存状態 | 合成表示確認済み、実API操作待ち |
| 3 | SB・KB・統合Map | P05/P06、既存の操作・保存・判定案内。統合独立フレームは未確認 | レイアウト実装・合成表示確認済み、保存操作回帰待ち |
| 4 | 研究者トップ・教材・実施一覧/作成・参加者 | R04/R08と既存画面。R06/R07独立フレームは前回未確認 | R04・R06/R07の見た目とフォーム確認済み、実API確認待ち |
| 5 | R05・分析/Export・チュートリアル・旧protocol | 共通スタイルと既存の詳細情報・導線 | R05/分析・チュートリアル/研究者トップは合成画面確認済み。実API/DB・旧protocol全体回帰は未確認 |

## 対象ファイル・実装手順
`frontend/src/main.tsx` と共通UI用CSS、必要な場合だけ各ページの表示マークアップを変更する。既存design-systemのトークンとページクラスを使用し、外観上書きを一か所に集める。R08の既存変更と対象検証は維持する。
1. Figma画像と既存CSS/画面を比較し、1366/1440pxの変更前画像を保存する。
2. 通常ページの幅・見出し・フォーム/操作・表・状態表示を統一する。
3. 学習者の単一活動・保存状態・研究者導線を確認し、必要な表示差分だけを直す。
4. 同条件の変更後画像、キーボードフォーカス、横はみ出しと回帰を確認する。

## 影響・リスクと対策
共通CSSは旧protocolにも適用されるため、Mapキャンバス/ノード/リンク/座標/ドラッグのセレクターは通常ページの装飾対象から除く。状態判定・認可・API書込み・ログ・提出/期限・研究条件・出力契約は変更しない。native confirmはブラウザー標準を維持する。未取得時間や離脱/撤回を補完しない。

## 検証・完了条件
既存Playwrightを使う。合成応答の表示確認と実API/新規の使い捨て模擬DB操作を区別し、保存・再読込・接続・提出の関連回帰を確認する。重要な共通変更は全体suiteも一度実行する。frontend型検査/Lint/build、diff checkを行う。画像は合成データのみで認証値を含めない。
全対象の画面確認、関連操作回帰、未確認範囲と結果の記録までを完了条件とする。実機LAN/多数端末/実研究データでの安全性は別途確認が必要。

## 進捗・結果
- 作業先AGENTS.md確認済み。上位AGENTS.mdは探索で見つからなかった。GitHub mainを読み取り確認し基点と一致。既存未追跡記録と別worktreeを保持。
- Figma R08/P06のdesign contextと画像を取得。R08の未取得時間や未実装機能は模倣せず、既存契約を優先。
- 検証結果と未完了事項は実行後に本節へ追記する。

### 2026-11-14 学習者の授業・SB・KB・統合Map
- Figma P05（2:129）とP06（2:194）を参照。P03授業と統合画面に専用フレームは確認できなかったため、授業は既存の単一活動カード、統合は共通Map画面ルールに合わせた。
- Mapツールバーの操作・保存状態を揃え、保存状態を淡いグリーンのラベルで表示。KBパレットを2行の独立横スクロールにし、概念・リンクの見出しを日本語化。SB/KB/統合の可視キャンバス高をそれぞれ576px/399px/399pxに整理した。これは表示領域だけの調整で、Map本体の寸法・座標・ドラッグ・接続・提出条件は変更していない。初期概念保護、KB判定、制限時間、Merge/解除、Undo/Redoの処理も変更していない。
- Playwright Edge（Windows、Node 24.15.0）で合成API応答のみを使い、画面高768px、幅1366px・1440pxの授業、SB、KB、統合を確認。8組すべてで画面幅の横はみ出しなし、ツールバーの文字切れ・ボタン重なりなし、保存状態表示あり。KBの合成9項目は両パレット行で独立横スクロールし、パレット高169px・キャンバス399pxで重ならないことを確認。SBキャンバスは576px。画面全体は縦スクロールする。
- 変更前後のviewport/full-pageスクリーンショットはOS一時領域`sbkb-learner-layout-20261114`に保存（1366/1440px、合成データのみ、認証値なし）。代表比較はP06の`kb-1366-before.png`と`kb-1366-after.png`、SB/統合の変更後画像。
- 現在のブラウザー検証は合成fixtureでの表示・レイアウト確認であり、実API/DBを使った保存・再読込・接続・提出回帰ではない。通常sandboxでのEdge起動はプロセス起動直後に失敗したが、Playwright実行の承認後に同じ対象検証が完了した。対象テストはEdge起動失敗時にもViteを閉じるよう終了処理を保護した。
- 旧protocol/R05との共有影響は、変更CSSが`.is-experiment`に限定され、Map操作・API・保存コードに変更がないことを確認。旧protocol/R05の実API操作回帰は未実施。
- `test:learner-layout-browser`は現在の9部品fixtureで1366/1440pxの8画面状態をPASS。`npm run typecheck`、`npm run lint`、`npm run build`、`git diff --check`も成功。buildには既存の500KB超chunk警告あり。新規検証スクリプト単体のPrettier checkは成功。package.jsonと計画書を含めたファイル全体のPrettier checkは警告となったため、既存内容を一括整形せず保持した。

### 2026-11-14 共通装飾の初回実装
- `rehearsal-ui.css`をmainから読み込み。通常ページの幅/余白、ログインの緑ヘッダー、見出し、フォーム/ボタン高、研究者の表、状態/エラー、分析詳細の横スクロール、フォーカスを揃えた。新ライブラリなし。Map描画のセレクターは追加していない。
- ログイン・公開停止・開始待ち・実施終了：Edge/Windows/Node 24.15.0、合成API応答、1366/1440×900で表示、横はみ出し、ログイン入力のフォーカスを確認。R08も合成応答で未開始/活動中/本人完了/終了時未完了の表示と横はみ出しを確認。
- 画像はOSの一時ディレクトリ`sbkb-rehearsal-ui-20261114`に保持。`login-1366-before.png`/`login-1366-after.png`、`r08-1440-before.png`/`r08-1440-after.png`等。beforeは同一画面で新しい共通CSSのsheetだけを無効にした比較であり、R08の先行改善は両方に含む。認証入力欄は空、参加者データは合成のみ。
- `test:rehearsal-ui-browser`をnpm/ブラウザーsuiteに登録。初回はrootから直接起動しViteのindexが見つからず404。正規のfrontend npm script経由に直し成功。製品エラーではない。
- frontend typecheck/Lint/build成功。既存の500KB超chunk警告あり。git diff --check成功。
- 全体suite準備は`stage1_mock_ui_unification_1114`のcreateで`docker_unavailable_or_request_rejected`により停止。Engine確認もexit 1、manifestなし。migrate/seed/suiteは未実行。既存DBへ代替接続せず、Docker再起動や稼働リハーサル環境変更は行っていない。

### 2026-11-14 初回調査時の未完了メモ（後続の回帰結果で更新）
この時点ではDocker Engineの応答が得られず、実API/DB回帰を保留していた。後続の専用模擬DB検証と最終棚卸しは、末尾の「全体回帰後」節に記録する。この初回記録は当時の状態として保持する。

### 2026-11-14 研究者の教材・実施画面
- Figma R04 (`3:88`, 1366×768) と合成データの教材編集画面を照合。見出し、概要、左ナビ、編集欄、完成チェックの三列構成は既存実装で揃っていた。持続表示のアクセス切替バーが内容を下へ押し、1366×768で完成登録ボタンが画面外になる点を調整した。切替操作は残したままR04/R03/R06/R07の緑ヘッダー内へ配置し、R04の8項目チェックリストを圧縮して完成操作を初期表示内に収めた。
- R06/R07は独立したFigmaフレームを確認できなかったため、共通UIのフォーム・表を継続利用。実施一覧の「準備中／実施中／終了」を文字ラベルに加えて控えめな背景色でも区別。予定人数と登録Session数の別列・説明、作成画面の固定教材版と制限時間、入力エラー・空・読込中・取得失敗の表示を維持した。教材版、完成条件、予定人数、認可、保存・開始処理の意味は変更していない。
- 変更: `frontend/src/researcher-ui.css`、`frontend/src/main.tsx`（専用stylesheetの読込）、`frontend/src/ExperimentRunsPage.tsx`（状態badgeの表示クラスのみ）、`frontend/package.json`・`frontend/scripts/verify-researcher-ui-layout-browser.ts`（合成ブラウザー検証登録）、本計画。
- 代表画像は `%TEMP%\sbkb-researcher-ui-20261114-final` に同一の合成fixture・1366×768/1440×900で保存。例: `before-material-draft-1366x768.png` / `after-material-draft-1366x768.png`、`before-runs-list-1366x768.png` / `after-runs-list-1366x768.png`、`before-run-create-1366x768.png` / `after-run-create-1366x768.png`。同一ブラウザー内で研究者ページ専用CSSの有効/無効だけを切り替えた前後比較。
- 今回の実画面確認: WindowsのMicrosoft Edge、Node 24.15.0、Viteのローカル画面とPlaywrightの合成API応答のみ。1366×768/1440×900、水平はみ出しなし、R04完成登録ボタンとR06作成ボタンの初期表示内配置、実施状態badge、教材チェックから入力欄へのフォーカス移動を確認。教材・実施一覧の読み込み中/空/取得失敗、予定人数の小数入力拒否と0の受理可能表示も確認した。
- 検証: `npm run test:researcher-ui-layout-browser` 成功（合成fixtureのみ、DB/製品API接続なし）、`npm run typecheck`、`npm run lint`、`npx eslint scripts/verify-researcher-ui-layout-browser.ts`、`npm run build` 成功。buildは既存の500kB超chunk注意を表示。新規検証スクリプト・CSSとpackage.jsonのPrettier checkも成功。API/DB検証と全体suiteは未実行。
- 未確認: `test:material-catalog-browser` と `test:run-management-browser` は新規使い捨てmock DBを使う実API/DB検証のため未実行。教材保存・完成登録、実施作成、認可/固定版の保存は別途この検証が必要。学習者Mapのドラッグ・接続・保存・提出、旧protocol・R05の実回帰も引き続き未確認。全体suiteは大きな実装まとまり後に一度実施する。

### 2026-11-14 R05教材テスト・研究者分析/Export
- Figmaは読み取りのみ。R04 (`3:88`) にはR05へ進む導線があるものの、独立したR05画面フレームは確認できなかった。研究者分析・Exportの独立フレームも確認できなかったため、R05・分析画面は既存の淡いグリーン/ニュートラルな共通UIに合わせた。
- R05は教材版・実行状態を見出しと状態ラベルでまとめ、開始・状態更新・削除を分けて配置。Map/履歴選択、選択Map本体の現在の提出状態、保存済み履歴を視覚的に区分した。提出状態は既存応答の`submitted_at`から表示し、履歴snapshotの表示中には状態の参照時点が異なることを示す。読込失敗・空履歴・処理中を表示。開始・提出・削除の条件や内部Map処理は変更していない。
- 分析/Exportは既存のJSON/CSV出力操作を見出し付き領域へ整理し、関連画面への移動を別段にした。取得失敗時は再取得操作を提示し、失敗中の「読み込み中」表示を重ねない。既存の分析値、状態・理由、Map比較、履歴再生、出所情報、出力契約・権限は変更していない。未提出・欠測の文言と既存の比較Map追加/削除/変更印を保持。
- 実装ファイル: `frontend/src/R05Page.tsx`、`frontend/src/Stage1AnalysisPage.tsx`、ページ限定CSS `frontend/src/r05-analysis-ui.css`、読込元 `frontend/src/main.tsx`、合成ブラウザー検証のnpm登録 `frontend/package.json` と `frontend/scripts/verify-r05-analysis-ui-browser.ts`。CSSはR05/分析のページ範囲に限定し、Mapのノード・リンク・座標・ドラッグ対象や比較マーカー色のルールを追加していない。Mapキャンバス操作や保存データ処理のコードは変更していない。
- `npm run test:r05-analysis-ui-browser` はWindows Edge・Node 24.15.0・ローカルVite・合成API fixtureのみで成功。1366×768と1440×900の両方でR05未実施/下書き/提出済み/読込中/失敗、分析の混在状態/活動なし・snapshot欠測/読込中/失敗を確認した。R05現在のMap提出状態・履歴snapshotの区別、分析の未提出理由、欠測理由、エラー再取得、出力ボタン、キーボードフォーカス、横はみ出しと操作ボタンの画面幅内表示を確認。初回の厳密な提出表示確認では検証fixtureが共有Mapオブジェクトを書き換えていたため、fixtureを独立コピーに変更し、さらに提出後相当のKB段階に合わせた後の再実行で成功した。これは検証fixtureの誤りで製品状態の不具合ではない。
- `npm run test:stage1-analysis-layout-browser` 成功（合成API fixture）。既存の旧4/5/6活動表示、欠測時に差分を捏造しない表示、比較Mapの追加・削除・変更色/印、アンケート表示の回帰を確認。両ブラウザ検証ともDB・実API・稼働中リハーサルには接続していない。
- `npm run typecheck`、`npm run lint`、`npx eslint scripts/verify-r05-analysis-ui-browser.ts`、関連ファイルのPrettier確認、`npm run build` は成功。buildは既存の500KB超chunk警告を表示。全体suiteは未実行。
- 代表画像（合成fixture、変更前は対象ページCSSを無効にした同一ブラウザー比較）: R05 1366px 前 `OS一時領域/sbkb-r05-analysis-ui-20261114/r05-unsubmitted-1366x768-before.png` / 後 `OS一時領域/sbkb-r05-analysis-ui-20261114/r05-unsubmitted-1366x768-after.png`、1440px 前 `OS一時領域/sbkb-r05-analysis-ui-20261114/r05-unsubmitted-1440x900-before.png` / 後 `OS一時領域/sbkb-r05-analysis-ui-20261114/r05-unsubmitted-1440x900-after.png`。分析/Export 1366px 前 `OS一時領域/sbkb-r05-analysis-ui-20261114/analysis-mixed-1366x768-before.png` / 後 `OS一時領域/sbkb-r05-analysis-ui-20261114/analysis-mixed-1366x768-after.png`、1440px 前 `OS一時領域/sbkb-r05-analysis-ui-20261114/analysis-mixed-1440x900-before.png` / 後 `OS一時領域/sbkb-r05-analysis-ui-20261114/analysis-mixed-1440x900-after.png`。状態別画像は同じディレクトリ内の`r05-empty/loading/error/submitted-*`と`analysis-empty-missing/loading/error-*`。
- 未確認: R05・分析/Exportの実API/DB認可・保存・削除・実ダウンロード内容、両画面の実研究データ、全体suite。今回の表示確認は画面レイアウトと合成応答の処理だけで、ブラウザーから実APIが返す値や出力内容の検証ではない。全体UIの残りはチュートリアル・旧protocol画面と、まとまった時点の全体回帰。

### 2026-11-14 チュートリアル・研究者トップ
- チュートリアルの案内を、通常Sessionとは別の練習であること、Mapがサーバー/Session記録へ保存されないこと、画面離脱・モード切替・やり直しで初期化されることに合わせた。説明は概念追加・移動、作成中リンク接続、部品パレットの現在の操作に限定し、保存済みLinkの再接続を促す文言やPR #42で取り消された操作説明は追加していない。練習アクセス、部品、ローカルreset、Map操作コールバックと記録の扱いは変更していない。選択中の練習モードは`aria-pressed`で識別できる。
- 研究者トップは「研究者メニュー」と明示し、「教材準備」「実施・参加者管理」「結果確認」の3導線に整理。従来形式Session作成、データ管理、研究イベント、イベント出力、ゴールマップ、参加Session一覧と各行の既存操作を残した。新protocolの「開く」と旧形式Session画面への遷移先を説明し、参加者コードと研究者コードの共有注意も維持した。API・認可・保存・一覧状態の意味、削除確認は変更していない。
- 変更対象: `frontend/src/TutorialPage.tsx`、`frontend/src/HomePage.tsx`、既存共通CSS `frontend/src/rehearsal-ui.css`、既存合成検証 `frontend/scripts/verify-rehearsal-ui-browser.ts`、本計画。MapPage/Map CSS、Mapの座標・ドラッグ・接続処理、API、DB、研究イベントは変更していない。依存追加なし。
- 代表画像は同一の合成fixtureで前後を撮影。チュートリアル: `OS一時領域/sbkb-tutorial-researcher-home-20261114/tutorial-prior-1366x768-before.png` / `OS一時領域/sbkb-tutorial-researcher-home-20261114/tutorial-prior-1366x768-after.png`、Kit-Build: `OS一時領域/sbkb-tutorial-researcher-home-20261114/tutorial-kit-build-1440x900-before.png` / `OS一時領域/sbkb-tutorial-researcher-home-20261114/tutorial-kit-build-1440x900-after.png`。研究者トップ: `OS一時領域/sbkb-tutorial-researcher-home-20261114/researcher-home-populated-1366x768-before.png` / `OS一時領域/sbkb-tutorial-researcher-home-20261114/researcher-home-populated-1366x768-after.png`、1440×900も同じ名前末尾で保存。before/afterは同じブラウザー・DOM・合成応答で、共通UI stylesheetを無効/有効にした比較。
- `npm run test:rehearsal-ui-browser` 最終成功。Windows Edge、Node 24.15.0、localhost Vite、合成API応答のみ。1366×768/1440×900でログイン・公開停止・開始待ち・実施終了の既存参加者状態、チュートリアルの練習モード・初期化・終了リンク、局所状態の作成後reset、モード切替、API要求がないこと、研究者トップのrole表示・主要/既存リンク・新旧protocol行の遷移先・キーボードフォーカス、Session一覧のpopulated/loading/empty/error、横はみ出しなしを確認。実API/DB保存は使っていない。
- 検証経緯: 最初の通常sandbox実行はEdgeがページ起動前に終了。承認付き実行では、案内の見出しと本文を別要素に分けた変更後UIに対して検証期待値が本文だけを見ていたため失敗し、見出しを含む表示確認に修正。その後、従来Session行からの既存データ管理リンクも数えるよう合成fixtureの期待件数を合わせ、最終実行が成功した。いずれも検証条件の調整で、製品挙動の失敗ではない。
- 追加した既存参加者状態の回帰を含む最終再確認では、通常の隔離実行でEdgeがページを開く前に終了し（PlaywrightのTransactNamedPipeエラー）、画面検証には到達しなかった。承認付きの同じ対象実行ではログイン・公開停止・開始待ち・終了状態と今回の画面検証が成功した。
- `npm run typecheck`、`npm run lint`、`npm run build`、`npx eslint scripts/verify-rehearsal-ui-browser.ts` はこの変更後に成功。buildは既存の500kB超chunk警告あり。Prettierは新規に整えたTutorialPage/検証スクリプトで確認。HomePageと共通CSS全体は変更前から圧縮された既存書式を含むため全体整形せず、表示変更と無関係な差分拡大を避けた。

## 画面棚卸し（UI単位の初回確認時点）
以下の表は画面単位の確認を始めた時点の記録であり、後続の実API/DB全体回帰前の状態を示す。最終状態は末尾の「全体回帰後」を参照する。「実装」は現行コード上の画面/導線を指し、実APIで使えることの保証ではない。合成ブラウザー確認はAPI route interceptionを使い、実DB/API確認とは別に扱う。

| 画面・機能群 | 実装状態 | 合成応答での画面確認 | 実API/DB・実操作画面 | 残作業 |
|---|---|---|---|---|
| ログイン・公開停止・開始待ち・実施終了 | 実装済み | 合成状態の画面を確認済み | このUI統一の表示確認では未確認 | 認可・開始/終了の既存API回帰と表示整合を全体回帰時に確認 |
| チュートリアル | 実装済み。通常Sessionと別のローカル練習 | 本ターンで練習切替/reset/終了導線と概念追加後resetを確認済み | APIを呼ばないことはブラウザー監視で確認。実API/DB保存なし | リンク接続・Kit部品ドラッグ自体は本ターンで実操作していない。説明は現行Canvas実装を静的照合 |
| 授業 P03 | 実装済み | 前段で合成画面確認済み | 動画参照先の実内容・実API視聴確認は未確認 | リハーサル用動画/通信条件の確認 |
| SB P05・KB P06・統合Map P07 | 実装済み | 前段でレイアウト・状態を合成確認済み | 本UI単位ではMap実保存・再読込・ドラッグ/接続・提出を未確認 | 新規模擬DBで保存/判定/提出回帰。統合制限時間・Merge/Undo/Redoを含む |
| P08本人完了・終了案内 | 実装済み | 合成状態表示を確認済み | 終了時の実API画面は本UI単位で未確認 | 実施終了との境界を実APIで関連回帰 |
| 研究者トップ | 実装済み | 本ターンで一覧あり/読込中/空/取得失敗と導線を確認済み | 実API/DB画面確認なし | 専用模擬環境でrole・データ取得の画面確認 |
| R03/R04教材、R06/R07実施一覧・作成 | 実装済み | 前段で合成画面・フォーム状態を確認済み | 保存/完成登録/実施作成の実API/DB画面確認は未確認 | 既存の実API模擬DB検証を行う |
| R08参加者管理 | 実装済み | 前段で進行状態表示を合成確認済み | API側の既存検証記録と実ブラウザー接続は区別。本UI単位で実画面/DBは未確認 | 実施/Session所属と画面表示を模擬DBで照合 |
| R05教材テスト | 実装済み | 前段で状態・履歴表示を合成確認済み | 実API/DBの開始/提出/削除・保存表示は未確認 | R05分離・認可・原子性の実API回帰 |
| 研究者分析・Export | 実装済み | 前段で欠測・未提出・比較状態を合成確認済み | 本UI単位でJSON/CSV実ダウンロード・DB一致を未確認 | 出力・仮名化・R05非混入の模擬DB回帰 |
| 旧4/5/6活動 | 既存実装を維持 | 旧分析表示など一部の合成回帰あり | 全活動の実API/DB回帰は未確認 | Map共用CSS、提出、ログ、Exportを関連回帰 |

### 初回確認時点の未完了項目（後続回帰結果は末尾節）
- 本ターンではFigmaに独立したTutorial/Researcher Homeフレームがあるか再調査していない。両画面は既存共通スタイルを基準にし、Figmaとの一致は主張しない。
- 実API/DBの画面操作、学習者Mapのドラッグ・接続・保存・提出、旧protocol/R05の全回帰、研究者出力のDB整合、全体suiteは未完了。新規の使い捨て模擬DBが使用可能になった段階で、画面単位の実API検証をまとめて行う。
- 10〜20台同時利用、実機LAN、既存研究DB適用/復旧、実研究データ、本番運用は未確認。UI表示確認だけをもって実験利用可能とは扱わない。

## 全体回帰後（2026-11-14）
この節は上の初回棚卸しを更新する。実装状態、合成応答での画面確認、使い捨てPostgreSQLを通したAPI/ブラウザー確認、未確認事項を分けて記録する。今回追加した変更は画面機能ではなく、Map表示倍率と保存座標の換算修正、およびその回帰検証である。

| 画面・機能群 | 実装 | 合成応答での画面確認 | 実API/DB・ブラウザー確認 | 未確認 |
|---|---|---|---|---|
| 共通UI・各画面の配置 | 実装済み | 既述のCSS有効/無効比較で確認済み | API/DBは画面装飾の検証対象外 | 比較画像は同一コード・データでCSSだけを切り替えたもので、旧コード全体との比較ではない。全画面全状態の視覚的な網羅はしていない |
| 学習者 P03・SB・KB・統合Map・終了案内 | 実装済み | 1366/1440px表示と状態案内を既述の合成ブラウザー検証で確認 | 新protocolの学習API・Map保存/再読込・SB/KB/統合の提出経路を、Windows/Node 24.15.0/Chromium系ブラウザーと使い捨てPostgreSQL 17.11で回帰。Fit後クリックで意図しない位置PATCHが出ないこと、スクロール後のドラッグ位置のDB保存・再読込、KB横スクロール部品の取込みとUndo、提出ガードを確認 | 外部動画URL先の内容/可用性、実機LAN、実研究DB、本番運用 |
| 研究者の教材・実施管理 | 実装済み | 1366×768/1440×900の合成画面、空/読込/エラーとフォームを確認 | 教材カタログ・完成登録、実施作成等の既存API/DBブラウザー検証が全体suiteで成功 | 実研究DBへの適用・復旧 |
| R08参加者管理・進行表示 | 実装済み | 未開始/活動中/本人完了/終了時未完了の表示は合成API応答で確認 | 参加者アクセスと進行APIの関連認可/状態回帰を使い捨てDBで確認 | R08の進行サマリー画面を実DB応答に接続した視覚検証は未実施 |
| R05教材テスト | 実装済み | R05/履歴の表示状態を合成応答で確認 | 開始・Map/履歴・提出・閲覧・削除と保存分離の関連API/DB/ブラウザー回帰が全体suiteで成功 | 実研究データでの運用 |
| 研究者分析・Export | 実装済み | 欠測・未提出・比較表示を合成応答で確認 | 研究出力・認可・CSV/JSONの関連API/DB回帰が全体suiteで成功。新protocolの研究者ブラウザー出力確認を含む | 既存の外部CSV利用処理、実研究データでの運用 |
| チュートリアル・研究者トップ | 実装済み | Edge/Windowsの合成応答で1366×768/1440×900、導線・空/読込/エラーを確認 | チュートリアルはローカル練習でAPI書込みがないことを監視。研究者トップの実API画面接続は未実施 | 実データ応答を使う画面確認 |
| 旧4/5/6活動 | 既存実装を維持 | 分析・共通UIの一部合成回帰あり | 全体suite内の関連API/ブラウザー回帰が成功。旧Map位置保存・再読込等を含む | 全旧protocolの全画面・全操作の網羅確認 |

### 今回の座標回帰と修正
- Fit後にキャンバスのCSS表示倍率が1未満になると、ポインターの画面座標とMapモデル座標の差を補正せず、クリックだけでもseedの移動として計算される経路を確認した。`frontend/src/MapPage.tsx` のポインター座標変換でX/Yそれぞれの表示倍率を反映し、キャンバス寸法が無効な場合は保存位置を変えないようにした。保存形式、ログ、Map操作制約は変更していない。
- `frontend/scripts/verify-experiment-learner-browser.ts` に実API/DB回帰を追加。キャンバスFit後のクリックで位置PATCHが送られないこと、実際のページ/キャンバススクロール後にドラッグした位置がAPI/DBと再読込後で一致することを確認する。テストは同じ実験クライアントclaimを保つため、ハードリロードではなくSPAでMapを開き直す。
- P05選択状態の画面画像を検証中に撮影し、模擬環境の一時データとともに削除した。前後比較画像ではなく、Fit後にseed編集drawerが開く状態の確認用だった。既存の各画面の前後比較画像（上の画面単位記録を参照）は今回削除していない。

### 今回の検証結果
- 対象suite `docs/ui-regression-target7c-20261114-suite-results.json`: 2/2成功（`test:experiment-learner`、`test:link-direction-api`）。製品APIと使い捨てPostgreSQL 17.11を使用し、Chrome/Windows/Node 24.15.0の実ブラウザー確認を含む。
- 全体suite `docs/ui-regression-full2-20261114-suite-results.json`: 58/58成功。R05、教材/実施管理、参加者認可、新protocol、研究者分析/Export、旧4/5/6の関連回帰を含む。`test:event-scale`は単一実行環境の合成Session規模確認であり、複数物理端末の同時利用試験ではない。
- 最終ソースでfrontend `npm run typecheck`と`npm run build`が成功し、変更した`MapPage.tsx`とブラウザー検証スクリプトへの`npx eslint`も終了コード0。全体の`npm run lint`は実行したが、実行結果の終了コードを回収できなかったため、成功確認済みとは数えない。buildは既存の大きなchunkに関する警告を出した。`git diff --check`成功（Windowsの改行コード警告のみ）。
- 初回にはR08画面の旧期待ラベル不一致、Node子プロセスのWindows終了コード`3221226505`、検証でのハードリロード後のクライアントclaim不一致、Fit後クリックのDrawer待ち失敗があった。ラベルとテスト遷移を現行契約に合わせ、最後のDrawer失敗は位置計算の製品不具合として修正した。子プロセスの初回終了原因は未特定。修正後は対象2/2、全体58/58で成功し、これら初回失敗を成功記録に置き換えていない。

### 完了後も未確認の範囲
- R08進行表示、研究者トップ、チュートリアルは合成応答の画面確認であり、実API/DB接続時の見た目確認とは区別する。画面/APIとしての機能存在を全画面の実動作保証とみなさない。
- 実機LAN、物理的に別の複数端末、10〜20台同時利用、ネットワーク切断を含む本番相当の負荷、既存研究DBへのmigration適用/復旧、実研究データ、本番運用は確認していない。稼働中LANリハーサル環境は接続・切替していない。
- 動画参照先の実内容、すべてのブラウザー/画面状態、すべての旧4/5/6活動を網羅した手動操作は未確認。UI統一の合成画面確認を、研究利用可能性の保証として扱わない。

## 2026-11-14 保存前レビュー指摘の修正と検証
- 全体suiteのbrowser検証登録を確認し、`test:learner-layout-browser`、`test:researcher-ui-layout-browser`、`test:r05-analysis-ui-browser`をそれぞれ1回だけ登録した。先行追加の`test:r08-progress-display-browser`と`test:rehearsal-ui-browser`も、frontend npm script登録とbackend suite参照が各1件で一致する。frontendのbrowser検証コマンドのsuite経由・個別実行は同じnpm scriptと継承環境変数を使う。suite runnerは子プロセスのspawn errorとnull exit codeを失敗として記録し、PASS扱い・待機放置を避ける。
- `materials.css`の`.materials-page button`装飾がR05 Map内のリンク接続端点にも適用されていたため、ページボタンの基底・hover・disabled規則をMapキャンバス外に限定した。R05端点は18×18px、padding 0px、38pxのmin-heightなしとなり、Map内の配置・操作領域は既存のキャンバス用ルールを維持する。
- `verify-r05-browser.ts`にR05の端点回帰を追加。端点クリックではMap操作要求がなくMap状態も変化しないこと、端点ドラッグで`RECONNECT_LINK`が受理され、読取API上の始点・終点が保存状態と一致することを製品APIと使い捨てPostgreSQLで確認した。Map本文は結果記録へ転載していない。
- 今回の対象表示検証では、学習者レイアウト、研究者UI、R05分析UIの各browser検証が1366px/1440pxの合成fixtureで成功。R05の実API/DB endpoint regressionも成功した。最初のR05 endpoint検証では38pxの端点高を検出しCSSを修正。その後、R05画面に存在しないリンク選択UI/成功ラベルを前提とした検証期待値が失敗したため、その無効な画面前提を除き、API保存状態を確認する形にして最終成功した。
- frontend `npm run typecheck`、`npm run lint`、`npm run build`は終了コード0。backend `npm run typecheck`、`npm run lint`、`npm run build`、R05検証スクリプトのESLintも成功。buildには従来の500KB超chunk警告がある。過去のfrontend Lintで終了コードを回収できなかった記録は当時の履歴として残し、今回の成功で書き換えていない。
- 新規使い捨てDB `stage1_mock_ui_save_review_full_20261114_01`で全体suiteを実行。初回は32件中31件成功し、`test:delivery-reliability`がWindows終了コード`3221226505`で失敗。対象単独実行も終了コード1で`ECONNRESET`となった。残り28件は別続行で27件成功し、`test:experiment-research`内の`test:experiment-learner-browser`が`3221226505`で終了した。全61項目のうち60項目まで実行され、成功58、失敗2、未実行1（`test:r05-storage`）。同項目のみ正規suite wrapperで起動を試したが、runner自体が`3221226505`で終了し、個別テストの結果記録まで到達しなかった。原因はいずれも未特定で、全体suiteは成功扱いにしない。3件の今回追加browser検証は続行runで全て成功。今回の証跡は`docs/ui-save-fix-full-20261114-suite-results.json`、`docs/ui-save-fix-continuation-20261114-suite-results.json`、`docs/ui-save-fix-delivery-target-20261114-suite-results.json`、`docs/ui-save-fix-target7-20261114-suite-results.json`、`docs/ui-save-fix-target7-20261114-r05-execution.json`。`test:r05-storage`は結果ファイル未生成で、失敗をPASS/FAILいずれにも読み替えない。
- 実行前後のbackend/frontendソース対象は27ファイルでパス集合・個別SHA-256が一致。集約SHA-256は`338d6076098359e4c995af088be8d00c0247b2209acc4f587e98c041225f5c15`。記録は`docs/ui-save-fix-20261114-source-fingerprint.json`。
- 公開文書10件の個人worktree絶対パス表記のみ、`[repo-local worktree]`へ置換した。検証結果、日付、失敗経緯は変更していない。docs内Markdownに個人Windowsパスが残らないことを確認した。文書の14画像参照は「OS一時領域」という汎用表記だが、今回参照先を確認すると全14件とも現在は見つからず、画像は今回閲覧できていない。過去の撮影・確認記録と、現時点での画像閲覧可能性は区別する。
- 検証記録は`.local`を含めすべて保持する。今回作成した2つの使い捨てDBは、正確なmanifest名・container identityを確認後に後片付けする。稼働中LANリハーサル環境や他の模擬DBには触れない。
- 未解決: `test:delivery-reliability`と`test:experiment-research`内のWindows子プロセス異常終了、R05 storage検証の未実行。これらの原因・製品影響は確定していない。実機LAN、複数物理端末、既存DB適用/復旧、本番運用も未確認。

## 2026-11-14 プロセス異常終了の個別切り分け
製品・検証assertion・fixture・待機条件を変更せず、専用プロセスに限定した観測preloadでNode起動元/版、子プロセス終了、通信失敗コードを記録した。引数・環境変数一覧・ヘッダー・本文・認証値・メモリーダンプは記録していない。観測はタイミングに影響し得るため、その制約を残す。

| 対象 | Node 24.15.0へ統一 | 既存Node 24.22.1へ統一 |
|---|---|---|
| `test:delivery-reliability` | 1回成功。ECONNRESETは再現せず | 比較目的の1回成功 |
| `test:experiment-research` | 1回失敗。ブラウザー起動前の`verify-experiment-research.ts`プロセスが3221226505で終了し、その後suite runnerがAssertionError | 比較目的の1回成功。API/DB・研究者/学習者/終了browserまで完了 |
| `test:r05-storage` | 1回成功し結果記録あり | 比較目的の1回成功 |

- PATHと既存runtime/cache/worktree候補を確認したがNode 22は見つからず、新規インストールは行っていない。24.15.0はシステムのNode、24.22.1は既存アプリ同梱Nodeを明示的に起動。PowerShellから同じNodeでnpm-cli.jsを実行し、npm scriptのtsxと`process.execPath`で起動するrunner/API/子プロセスも各試行の同じ版だったことを観測した。npm 11.12.1、tsx 4.23.15、Playwright 1.64.1、Windows x64 10.0.26300、Edge 157.0.4341.46。依存とlockファイルは変更していない。
- 24.15.0失敗では、検証本体の異常終了が親のassertionより先だった。直前の非health fetch失敗・JS未処理例外は観測されていない。過去のECONNRESET時のAPI生存状態は、旧記録では確認できない。Windows Application Errorの通常照会は権限拒否、追加権限での狭い時刻範囲照会は該当イベントなし。内部原因、Node版との因果関係、OS/製品不具合のいずれも確定していない。
- 24.22.1で3項目成功後、別の新規使い捨てDBで全体suiteを1回実行し、**61/61成功**。runner/API/各Node子プロセスの観測版も24.22.1のみ。27ソースの事前・事後SHA-256は一致し、集約指紋は`338d6076098359e4c995af088be8d00c0247b2209acc4f587e98c041225f5c15`。過去の58/58や直前の失敗したsuiteと今回の成功は別の記録である。今回の再実行成功を元の原因解決とは扱わない。
- 要約は`docs/ui-process-diagnosis-20261114.json`。今回生成された17個の生の検証JSONは元のbytesのまま、この作業専用`.local/ui-crash-diag-20261114/reports/`へ保持した。実行元の絶対パス・安全なプロセス観測記録・事前事後指紋も同じローカル領域に保持し、既存の中間記録は変更していない。
- 今回作成した`stage1_mock_ui_crash_diag_1114_01`と`stage1_mock_ui_crash_full_1114_01`は、正規DB guardとmanifest/container/label/loopback/cacheパス照合後に削除。残存する対象APIプロセスはなかった。稼働中リハーサル環境は切り替えていない。
- 残件は、Node 22環境での確認と、必要に応じた異常終了元の追加調査。Linux/Chromium、実機LAN、複数物理端末、既存DB・本番運用は今回の検証範囲外。

## 2026-11-14 保存前の画面確認と候補整理
- 作業先はこの計画の基点と一致する `codex/r08-progress-display-20261114` / `19a1898efa86d81318086f9d5fca07f7db7f2320`。UI実装と既存検証を変更せず、直近の27対象ファイルSHA-256は保存済み指紋と全件一致。前回の全体61/61はNode 24.22.1・Windows Edge・使い捨てDBの別検証結果として保持し、今回の結果へ混ぜず、全体suiteは再実行していない。
- 表示だけを再確認するため、既存合成ブラウザー検証を使用した。Windows Edge 157、Node 24.22.1、Viteローカル画面、合成API応答のみで、実API・DB・リハーサル環境への接続はない。`test:rehearsal-ui-browser`、KB状態に絞った `test:learner-layout-browser`、`test:r08-progress-display-browser`、`test:researcher-ui-layout-browser`、`test:r05-analysis-ui-browser` が成功。通常権限でのEdge起動は `TransactNamedPipe` で画面を開く前に失敗したが、承認済みの通常実行経路では成功した。起動拒否の内部原因や製品不具合とは断定しない。
- 1366×768/1440×900を確認。ログイン・研究者トップは両サイズ、R08は両幅・高さ900、研究者管理およびR05/分析は両サイズで空・読込中・エラー等を含めて確認した。学習者画面の既存検証は1440幅も高さ768だったため、その不足のみ一時コピーでKBを1440×900にして再確認し、PASS後に一時スクリプトを除去した。授業・SB・統合Mapの保存・提出回帰は、今回再実行せず、指紋一致の全体61/61記録を参照する。
- 画面では横はみ出し、主要ボタンの文字切れ、案内と操作部品の重なりを確認しなかった。KBは部品パレットを横スクロールできる。キャンバスの高さは399pxで、1366×768の初期表示では下部がページ折返しより先へ続き、1440×900でも末尾が約49px折返し後にある。画面全体を縦スクロールして確認できるが、初期表示から全キャンバスを見渡す配置ではない点を残記録する。機能・CSS変更は行っていない。
- 今回の新しい代表画像7枚を `.local/ui-final-review-20261114/screenshots/` に保存した。これは現在の最終表示を撮影した合成画面であり、過去のbefore/after画像や旧ソースとの比較ではない。過去記録にある14画像参照は引き続き現在参照不可で、今回の画像で置き換えない。
- 画面別の状態は次のとおり。**実装済み**: 対象ルートの現行コード。**合成応答で画面確認済み**: 上記5検証と代表画面。**実API/DB確認済み**: 以前の全体61/61に含まれる既存回帰の範囲、および直前に記録済みの実API/DB回帰のみ。今回の撮影自体はAPI/DB接続なし。**未確認**: 実研究データの表示、全ブラウザー・全状態の手動網羅、10〜20台同時利用、既存研究DBの適用/復旧、本番運用。Node 24.15.0の異常終了原因も未特定で、Node 24.22.1の成功を原因解決とは扱わない。
- 保存候補は現在の実差分を基準に選別した。候補30件の正確な相対パス・分類・理由・SHA-256、除外群の理由、ローカル画像のSHA-256は `.local/ui-final-review-20261114/save-candidates.json` に記録した。R08表示で使う保存済みStage情報とAPI契約文書、UI、関連検証、登録、計画、61/61および指紋/診断要約を候補とする。研究安全・監査文書のパス表記だけの変更、別機能文書、suiteが更新した生成JSON、重複する途中結果、モバイル画像、`.local`内データは今回の公開候補から除外し、削除しない。
- 既存記録の区別: 58/58は前段の結果であり今回の成功証拠ではない。全体61/61は前回の結果として維持する。今回の画面確認は合成APIだけで、実API/DB操作を新たに確認していない。

### 追加: R01・P01のFigmaフレーム照合
- FigmaのPage 1メタデータとフレーム画像を読み取り、役割を画面名・内容から確認した。P01は [`P01 / 被験者トップ`](https://www.figma.com/design/eSgsQfqam4eOdVSuW8fltS?node-id=27-130)、R01は [`R01 / 研究者トップ`](https://www.figma.com/design/eSgsQfqam4eOdVSuW8fltS?node-id=27-157)。どちらも1366×768。したがってP01を「ログイン画面」とだけ推定した対応付けはしていない。
- P01のフレームは「実験に参加する」見出し、参加コードの説明・ラベル・入力欄・「実験を開始」ボタン、コードが不明な場合の案内に加え、「コードなしで練習する」領域とSB/KB練習ボタンを含む。現在の対象は `frontend/src/HomePage.tsx` の未認証 `signed-out` 表示（代表画面 `.local/ui-final-review-20261114/screenshots/01-login-1366x768.png`）。見出し「アクセスコードで開始」、説明、アクセスコード欄、「続行」、操作練習へのリンクがあるため、P01の参加コード入力部分には視覚上の対応があるが、独立した参加者専用画面ではない。現行 `App.tsx` は同じコードを `/api/me` へ送り、応答のroleで研究者・学習者を分岐する。
- **P01の表示差**: Figmaは「参加コード」「実験を開始」と対象を明示し、入力例のplaceholderを持つ。現行は共通の「アクセスコード」「続行」で、入力placeholderはなく、説明が研究者コード共有注意などを含む。Figmaの下段はSB練習/KB練習の個別ボタン、現行は「操作の練習」リンクでチュートリアルへ進む。**認証・操作手順の差**: Figmaは参加者コード入力とコード不要のSB/KB練習をP01内で分ける一方、現行入口は研究者・学習者共通認証で、練習は別ページへのリンクである。見た目だけでは揃えられない差として記録し、認証方式や練習導線は変更していない。
- **R01の対応**: フレーム [`R01 / 研究者トップ`](https://www.figma.com/design/eSgsQfqam4eOdVSuW8fltS?node-id=27-157) は研究者向けの教材管理・セッション管理ポータル。現在は `HomePage.tsx` の認証済み研究者分岐（`.local/ui-final-review-20261114/screenshots/02-researcher-home-1366x768.png`）が対応する。暗緑ヘッダー、ニュートラル背景、研究者向け説明、教材・実施管理への主要導線は一致する。現行は「研究者メニュー」と呼び、システム状態、結果確認カード、その他の研究者機能、参加Session一覧も同じページに含む。Figmaの2カード中心の配置に対する追加情報量・縦長化は表示差として確認した。R01にはログインフォームではなく、認証後の管理トップを割り当てた。
- **処理中・エラー状態**: 確認できたR01/P01フレームにはエラー/処理中の別variantがない。現行のコード入口は失敗時に `role="alert"` で一般化した再入力案内を表示するが、送信中表示やボタン無効化は実装上確認できない。今回の保存画像は初期表示であり、コード送信によるエラー/処理中をブラウザーで実行確認していない。研究者トップのAPI/DB接続状態とSession一覧の空・読込中・取得失敗variantは既存の合成ブラウザー検証に含まれる。
- **画面サイズと証拠範囲**: Figmaの該当フレームは1366×768であり、同寸法の現在画像と直接比較した。1440×900のFigmaフレームは見つからない。既存 `test:rehearsal-ui-browser` の保存済み実行は合成API応答で両幅（1366×768、1440×900）を確認しており、今回の1366画像でも現行配置を照合したが、1440用画像は現在のローカル証拠に残っていないため、そのサイズでのFigma画像との直接比較は未確認とする。現在の7画像は最終UIの合成画面であり、旧ソースとの比較や過去のbefore/afterの代替ではない。
- **分類と判断**: P01のコード種別・認証後の役割分岐・SB/KB練習の画面遷移は認証/操作手順の仕様に関わる。R01のシステム状態や結果一覧の配置・情報量、見出し/余白は表示調整に属するが、今回依頼は照合と記録までのため変更しない。Figmaで意図が確定していない部分は実装仕様へ読み替えず、保存前の判断事項として残す。

### 追記: R01・P01の表示調整
- 先行するフレーム照合結果に沿って、P01相当の共通コード入口は「参加者・研究者」「アクセスコードを入力」とし、説明・ラベル・安全なplaceholderを整理した。Figmaの参加者専用入口には変更していない。練習の入口は独立したカードにしたが、リンク先は既存の `/tutorial` のまま。SB/KB別ボタン、認証後の遷移、練習モードは変えていない。
- コード確認中は送信ボタンを無効化して処理中表示を出す。失敗は既存の一般化したエラー表示を維持する。`/api/me` のGETとBearer認証、既存の役割判定・遷移処理には手を加えていない。入力例に認証コードは置いていない。
- R01相当の研究者トップでは、教材管理・実施管理の2カードをページ上部の主要導線にし、結果確認と接続状態を下段へ整理した。旧Session作成、研究データ管理、イベント、Goal Map、Session一覧などのリンクと機能は残した。Figmaの2カード中心の優先順位と見出し・余白へ近づけた一方、Figmaにない既存状態情報・Session一覧は副次領域に残している。
- **表示上解消した差**: 共通入口の入力と練習の視覚的分離、主要ボタンの配置、R01の2つの主要導線、結果・状態情報の優先順位を調整した。緑・ニュートラル基調、ラベル、ボタン、余白を既存UIから再利用した。
- **仕様判断として残す差**: Figmaの参加者専用コード文言、専用の「実験を開始」操作、SB/KB別練習ボタンは、共通認証と既存チュートリアル導線を変えるため実装していない。R01の結果一覧・システム状態の表示自体も残し、削除していない。
- **実画面の比較記録**: FigmaのP01 `27:130` とR01 `27:157` は1366×768。変更前の合成画面は `.local/ui-final-review-20261114/screenshots/01-login-1366x768.png` と `02-researcher-home-1366x768.png`、および `.local/ui-r01-p01-adjustment-20261114/before/` の1440×900画像で確認した。後者のファイル名末尾 `after` は共通stylesheet有効状態を意味し、今回のコード変更後という意味ではない。変更後は `.local/ui-r01-p01-adjustment-20261114/after/` にP01/R01の1366×768・1440×900ビューポートで撮った合成画像を保存した。検証スクリプトは全ページ撮影のため、R01画像の実ピクセル高はビューポート高を超える。1440×900はレスポンシブ確認であり、その寸法のFigmaフレームはない。すべて認証入力が空または合成APIデータのローカル画像で、Figma画像や過去証拠の置換ではない。
- **今回の検証**: `test:rehearsal-ui-browser` を合成API・Windows Edgeで両サイズ実行し、未認証初期表示、アクセス要求（GET `/api/me` とBearerヘッダーの存在のみ確認）、研究者認証後の主要・副次リンク、フォーカス、エラー、送信中、一覧の読込中・空・取得失敗、横はみ出しを確認。初期実行ではsandbox内Edge起動が `TransactNamedPipe` で止まり、承認付き実行ではlocatorの曖昧さや旧画面期待値が検出された。テスト側を現行の意味に合わせた後の最終実行はPASS。これら初回失敗は製品機能の失敗と扱っていない。
- frontend `typecheck`・`lint`・`build` は成功。buildには既存の552.70 kB JavaScript chunkに対する500 kB警告が出た。API/DB接続や保存は今回確認していない。全体suiteは限定UI変更のため実行していない。以前の61/61と27ファイル指紋 `338d6076098359e4c995af088be8d00c0247b2209acc4f587e98c041225f5c15` は変更前の記録として維持し、今回のソースの成功根拠に流用していない。
- 保存候補台帳 `.local/ui-final-review-20261114/save-candidates.json` はR01/P01の実差分に合わせて更新し、候補31件・保存候補のSHA-256・ローカル画像13件を記録した。ローカル比較画像は `localScreenshots` だけに記録し、公開候補には含めない。稼働中リハーサル環境、DB、別worktreeは未操作。
