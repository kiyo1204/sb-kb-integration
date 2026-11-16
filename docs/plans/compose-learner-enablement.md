# 通常Composeでの新学習者フロー有効化

## 目的・範囲
既定無効、従来の隔離模擬preview、通常Composeの明示有効を分離する。認証・所属・コード世代・画面世代・終了検査、保存・監査・出力契約は維持する。基点はmain 24fb29fe321f51423ec0fa80505cec4712655fb7。稼働環境は変更しない。

## 設計と対象
- `STAGE1_EXPERIMENT_LEARNER_ENABLED=1` のみ通常利用を有効化。省略/0は無効。previewと両方が1の場合・その他の値は固定理由で起動失敗。
- previewは従来のdevelopment/ONLY_SYNTHETIC/loopback DB名/DB marker検査を維持する。
- 共通能力判定を実施開始、me、教材、Stage/Map/提出、背景自動提出で共用。研究者の終了・分析・出力は無効化後も保持する。
- 有効モードは既存schemaを読み取り検査し、不足時は起動拒否。起動migration/変換は行わない。
- 対象: backend実行・アクセス・一覧、frontend関連表示、compose.yaml、.env.example、README、対象検証とsuite登録。

## 順序・リスク・検証
1. 公開判定を状態化し、不正設定/分離/schema欠損を安全側で拒否。
2. サーバーのモード情報を研究者と学習者へ返し表示を整合。
3. 独立使い捨て模擬DBで既定無効、明示有効、preview、認可・開始・終了・提出・出力を検証。通常Compose相当のサービス名接続を別途確認。
4. 型検査・Lint・build、対象成功後に全体suiteを一度。結果・環境差・未確認を追記。

誤公開リスクは明示指定/既定無効/競合拒否で抑制。既存データを変換せず、公開設定の変更はAPI再作成後から適用する。

## 復旧
`STAGE1_EXPERIMENT_LEARNER_ENABLED=0` に戻して対象APIのみ再作成。旧アプリへ戻す場合もDBを保持し、down -v/reset/破壊的migrationを行わない。終了済み実施を再開しない。

## 完了条件・進捗
実装・対象検証・Compose相当のサービス名接続・静的検査は完了。全体実行は44成功/1失敗で停止後、検証fixture修正を行い残り20項目を別実行で成功。単一の全体suite完走ではない。合成表示、実API/DB、実機確認を区別する。実研究利用前には通信保護、アクセス制限、バックアップと復元を別途確認する。

## 実装と対象確認（2026-11-16）
- 共通の3状態能力判定、起動schema読取確認、Compose/.env.example、研究者・学習者の状態別案内を実装。既存のトランザクション/所属/世代/終了後拒否は変更しない。
- Windows・Node 24.22.1。新規DB `stage1_mock_compose_flow_20261115` を正規手順で作成・migration・合成seed。旧リハーサルDBは未接続。
- 設定境界と実API preview/明示有効の3対象が成功。明示有効のJSON/CSV・ブラウザー検証を追加して対象確認中。
- 専用Dockerネットワーク上でAPI(Node 22イメージ)→`db`サービス名で実DBへ接続。preview/ONLY_SYNTHETIC環境変数なしで、401、0人開始拒否、登録、me/一覧のenabled、開始・同一キー再送、終了・未開始保持に成功。Composeファイル全体のupではなく、同等のAPI/DB接続条件の検証。4活動詳細は別のホストAPI実検証と区別する。
- 検証用SQLの列名誤記(status→state)を修正して接続確認成功。製品エラーとは扱わない。
- backend型検査/build/Lintとfrontend型検査/Lint/build成功。frontendの既存500kB chunk警告あり。
- 最初の対象実行が既定出力先の過去suite結果ファイルを変更したため、その記録差分は保持するが公開候補から除外。以後はcompose専用prefixで出力。過去結果を新しい成功証拠として扱わない。
- 未確認: 参加者PCの通常有効モード、実研究DB適用/通信保護/復元。本番運用確認済みとはしない。

### 対象ファイル詳細
- backend: `experiment-execution.ts`（3状態とschema確認）、`access-control.ts`（meと共通能力）、`experiment-foundation-guard.ts` / `experiment-map-read.ts`（共通能力参照）、`experiment-participant-access.ts`（一覧/claimのモード情報）。すべて `backend/src/` 配下。
- frontend: `App.tsx` / `ExperimentLearnerPage.tsx`（サーバーモード伝達とpreview表示）、`ExperimentLearnerGate.tsx`（無効時の設定案内）、`ExperimentParticipantsPage.tsx`（開始/コード案内）、`ExperimentRunsPage.tsx`（固定未公開文言の解消）。すべて `frontend/src/` 配下。
- 設定・文書: `.env.example`、`compose.yaml`、`README.md`、本計画。
- 検証: `backend/package.json`、`backend/src/scripts/run-research-event-suite.ts`、`verify-experiment-flow-config.ts`、`verify-experiment-enablement.ts`、`verify-experiment-learner.ts`、`verify-participant-access.ts`、`frontend/scripts/verify-researcher-ui-layout-browser.ts`。

### 記録の区別
- 最初の対象3件は設定/preview/明示有効のAPI検証。その後の対象4件は無効時API認可、実R08、合成研究者表示、明示有効の研究出力・学習・終了の実ブラウザーを含む。後者も成功。
- Dockerサービス名接続はNode 22.23.5、Windows側はNode 24.22.1 / Edge 157。通常Compose全体のupや実機LAN比較を成功したとは扱わない。
- `docs/issue13-suite-results.json` の生成差分、既定出力先の中間記録、ローカル成果物は公開候補外として保持。最終suiteには専用prefixと分離した一時画像領域を使用する。
- 合成研究者表示検証が既存の固定一時画像保存先を使用したため、その保存先の画像は今回実行で更新された可能性がある。過去画像の証拠と同一視しない。

### 全体回帰の失敗と切り分け
全体suiteの1回目は44件成功後、`test:data-management-browser` の「削除の最終確認」待ちで停止した。既存テストは一覧先頭を無条件選択していた。今回DBの先頭は新フローSessionで、独立した専用APIで同じ一覧先頭へのプレビューを照合すると、47msで409 `experiment_storage_only` を返した。初回ブラウザー内の要求を直接観測した記録ではないが、同じ対象と既存の拒否条件を確認した。製品の削除保護は維持する。

検証側だけを、識別済み合成DBに専用の旧protocol fixtureを作成し、そのSession行で確認・中止する方式へ修正した。fixtureにはbackendの既存pgを参照し、依存追加なし。修正後の対象は成功。成功済み44件を除き、失敗対象と未実行の20件を専用prefixで確認中。単一の全体suite成功とは扱わない。

残件選択ファイルの準備で作業フォルダーを誤り、選別なしで起動した追加実行は、今回DB名に一致する検証プロセス系統だけを識別して停止した。成功証拠に算入せず、別のローカル記録として保持。選択準備と起動を分離し、20件の存在検査後に残件実行を開始した。

対象ソース指紋は全体実行前20ファイルと、検証fixture修正後21ファイルを別に保持し、過去の指紋を書き換えていない。previewのmarker欠損・用途不一致・nonce不正はDB接続なしの補足検査でも固定理由で3/3拒否した。

## 最終結果
- 設定/preview/明示有効のAPI対象3件成功。その後の表示・実API/ブラウザー対象4件成功。
- 全体実行: 44成功・1失敗（削除確認の対象選択）。製品を変更せず専用legacy fixtureへ修正し、失敗対象＋未実行の20件が成功。重複しない64項目を確認。単一の最終ソース全体suite成功とは報告しない。誤起動して中止した追加実行は成功件数に算入しない。
- backend型検査/build/Lint、frontend型検査/Lint/build、修正したブラウザー検証のLintが成功。既存chunk警告は残る。差分チェック成功。
- 当初20ソースとfixture修正後21ソースのSHA-256を各実行前後で照合し不一致0。製品・設定ソースは全体実行開始後不変。計画文書の進捗更新は別扱い。
- 新規検証DBのコンテナ/volumeと、専用検証API/ネットワークを識別して片付けた。既存リハーサルのWeb/API/DBは切替・停止・書込みせず保持。新規worktreeの変更は未コミット。
- 保存候補は実装/設定/検証/必要文書の22ファイル。生成結果、画像、.local、既定出力先に残った過去結果ファイルの生成差分は対象外として保持する。ローカル候補台帳に相対パスとSHA-256を記録。
- 残る範囲: 通常Compose全サービスを同時起動した実機LAN確認は未実施。Docker API→dbサービス名での登録/開始/再送/終了と、Windows側の実API/DB・ブラウザー4活動/認可/出力を別々に確認した。実研究DB適用、通信保護、アクセス制限、バックアップ・復元、本番運用は別途必要。

## スナップショット復元後の最終レビュー（2026-11-16）
スナップショット `8d815dfaf3a335451b212367dad10c6b555740d7` の22候補を、親コミットのクリーンな専用worktreeへCRLFで復元し、元台帳のSHA-256と22/22一致。過去の44成功＋20成功、集計外試行の記録は独立したローカル証拠領域へ復元し、今回の単一実行と混同しない。

公開設定の競合は両方1のみ。省略/0/1の全9組合せ、schema不足、previewの分離とmarker検査を対象検証へ追加。READMEに0と1の併用が許可されることと、env編集/restartだけで反映されずAPI再作成が必要なことを明記。通常有効時にも参加者追加ボタンが「検証用コード」と表示されたため、通常有効時のみ「利用コード」へ整合させた。認可と保存処理は変更しない。

削除確認fixtureは、専用legacy Sessionの明示IDに限定し、DELETE入力による有効/無効、確認/中止、仮名再発行の中止、学習者アクセス拒否のassertionを維持している。

今回の新規DBによる単一全体suiteは64/64成功。登録項目・順序・件数が一致し、244ソース/設定の実行前後SHA-256に不一致なし。

### 今回の単一実行・最終結果
- Windows / Node 24.22.1 / Edge 157.0.4341.60。新規識別済み模擬DBで、選択フィルターなし・ブラウザー有効の全体suiteを1回実行。登録64、成功64、失敗0、未実行0、重複0、登録順も一致。終了コード0。
- 244の製品・検証・migration・設定ファイルの実行前後SHA-256が一致。レビュー後の製品/検証ソースを実行中に変更していない。
- 設定境界検証（9組合せ、不正値、schema不足、previewのホスト/marker/nonce拒否）成功。Composeの省略/0/1/不正/空の5条件でAPIへの値の伝達、API/DB loopback公開、dbサービス名を今回確認。Composeの不正値は空も含めてそのままAPIへ渡され、初期化が固定理由で拒否する。
- 通常有効化のAPI→dbサービス名接続は、スナップショットに保存された前回Node 22.23.5の実Docker検証と、今回の変更がないbackend能力判定・認可ソースを照合して再利用。今回の単一suiteはWindows上のAPIとPostgreSQLであり、通常Compose全サービスの実機LAN確認としては扱わない。
- backend型検査/build/Lint、frontend型検査/Lint/build成功。既存の500kB超chunk警告は継続。依存は一致するlockfileの既存インストールから専用worktreeへコピーし、追加・更新なし。最初の不完全な依存参照による対象コマンド起動失敗は準備工程の未実行として区別し、単一suiteへ算入しない。
- 今回のDBはmanifest・コンテナID・用途ラベル・nonceと専用volumeを照合して削除。runnerは終了コード0で終了し、専用APIの終了処理完了。既存環境の停止・切替、実研究DBへの接続/適用なし。
- 22候補は維持。元のスナップショット台帳と過去の44＋20件、集計外試行は独立したローカル証拠として保持。今回の結果とは混ぜない。現在候補の正確な相対パス・分類・SHA-256はローカル台帳へ記録。
- 残確認は、通常Compose全体での参加者PC/LAN操作、通信保護・アクセス制限、バックアップと復元、実研究DB適用/復旧。本番運用確認済みとはしない。
