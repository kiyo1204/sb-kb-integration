# 5活動フロー・アンケート・初期概念の検証

記録日: 2026-11-06。模擬データだけを使用。既存DB・研究データ・元worktreeには接続／変更していない。

## 起点と隔離

作業開始時main=3284a408f21e6ba28ca71135efe2da0dd969c731（PR #17を含む）。専用worktree/ブランチcodex/session-flow-survey-seeds。C:/sb-kb-integrationの旧ブランチ・ステージ済み22ファイル、統合worktreeの7文書変更とローカル記録は保持。mainが作業中にbc6c07bへ進んだため、PR #18の研究者Undo/Redo制限も取り込み、後述の最終確認を追加する。

## 初回確認・再試行（最終成功と区別）

- 初期の型／Lint確認で画面のnullable参照、React effect内setState、旧fixtureの型エラーを検出し修正した。
- 最初の全体suiteはイベント対応表の未再生成で停止。v7の2種を対応表へ加え、生成・照合後に再実行した。
- 旧main起点の全体suiteは30既存+新API+新UI=32/32成功。所要時間215177msのfresh模擬DB実行はsurvey-pr-suite-results.jsonに記録した（最終統合後の集計は下記参照）。
- 同じ使い捨てDBで再度全体suiteを実行した一回は、既存削除テストが空DB前提で数える模擬受付記録の残存（4件対2件）により停止。プロダクトの削除条件を弱めず、完全新規DBで通し直した。
- 作成画面の追加ブラウザーテストは可変ラベルに依存したselectorでタイムアウト。fieldset/comboboxへ限定して修正後に成功した。
- 出力へprotocol_keyを追加した後、同一Sessionがサンプル内で異なるプロトコルにならない検証も追加し、サンプルを再生成・照合した。CSVのCRLFは既存契約どおり保持し、差分確認にはcore.whitespace=cr-at-eolを使用する。

## 確認した機能

- 新規STAGE1_5の5活動・群null、重複／不明／他Kitの初期概念拒否、旧4・6活動の実API進行・評価・出力の互換性。
- Kit全概念からの初期配置、リンクなし、isSeed、Provenance/初期snapshot、移動・リンク・Undo/Redo・混在再生、名前変更／削除のAPI拒否とUI無効化。
- TEXT/CHOICE/RATING、必須と任意、順序変更・設問追加削除、開始後固定、設問ID・ロール・Sessionの境界。
- 同値保存で編集イベントなし、同じキーでの再送、故障注入時の回答／提出／進行の原子的ロールバック。未確認保存時の入力保持とIndexedDBに回答本文が入らないこと。
- 手動統合提出からSURVEY、期限時自動提出1件、提出後の閲覧拒否、明示「次へ」でSURVEY。
- v7 JSON／共通CSV／詳細CSVのID・件数・時刻・outcome・protocol一致。旧評価CSVにアンケートを混ぜない。回答CSVは研究者のみ。
- 新4テーブルの削除プレビュー・確認付き削除、故障注入時のロールバック、削除済みコードでの再送拒否、他Session保持。

## コマンドと最終結果

最終統合後の結果を追記するまで、この欄の32件をPR #18込みの検証結果と読み替えない。

```powershell
$env:NODE_ENV='development'
$env:STAGE1_MOCK_DATA='ONLY_SYNTHETIC'
$env:RESEARCH_BROWSER_CHECKS='1'
# 既存DATABASE_URLは使わず、create生成manifestのコンテナーだけへ接続
npm run db:mock --prefix backend -- create --name stage1_mock_survey_pr --mock-data-only
npm run db:mock --prefix backend -- migrate --name stage1_mock_survey_pr
npm run db:mock --prefix backend -- seed --name stage1_mock_survey_pr
npm run db:mock --prefix backend -- suite --name stage1_mock_survey_pr
npm run db:mock --prefix backend -- safety --name stage1_mock_survey_pr
npm run db:mock --prefix backend -- seed --name stage1_mock_survey_pr
npm run db:mock --prefix backend -- check --name stage1_mock_survey_pr
# backend/frontendそれぞれでtypecheck, lint, build
```

上記の最初のfresh実行は全39マイグレーション・32/32・静的6/6・リセット防護と新形式起動2/2が成功。v7契約は42イベント種の対応表と433契約ケースに含む。追加の実API検証はsession-flow-survey-results.json、集計はsurvey-pr-invariants.json、規模確認はsurvey-pr-scale-results.jsonに記録。規模確認は20模擬Session/4000件であり20台のブラウザー同時利用ではない。

## 後片付け・限界

初回準備、再試行、fresh実行の3コンテナーはID・名前・purpose/nonceを照合して削除済み（session-flow-survey-cleanup.json）。元のACK待ち1件には触れていない。既存環境へのマイグレーション適用、実機LAN、複数実端末、本番運用、バックアップ復元訓練は未確認。活動時間の研究上の扱いは決めない。所属不明の旧下書きの隔離保持を維持する。GitHub CIはPR作成後に実走行を別途確認する。
