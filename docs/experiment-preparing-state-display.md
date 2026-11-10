# 準備中の参加者向け状態表示（R05とは別タスク）

## 対象と保護

- 作業場所: `<repository-root>`
- branch: `codex/experiment-foundation`; HEAD: `ea5319416cecf11b2ace35308c21047ac4d69d25`
- 先行保存基盤/R03/R04/R06/R07/R08/学習者フローの未コミット・未追跡ファイルを保持。変更前の対象5ファイルと既存変更のhash一覧を`.local/waiting-ui-before`に保護。
- 今回のR05教材テスト実行への変更なし。API、DB schema、migration、開始条件、認証/認可、コード/編集世代、保存/提出/監査/受付票処理、旧protocol/Exportの意味に変更なし。
- 適用されるAGENTS.mdは確認した親階層・リポジトリ内で見つからなかった。既存の`db:mock`/suite手順を使用。

## 現行契約と表示の対応

| 状態・操作 | 変更前の実装 | 今回の表示・判定 | 根拠 |
| --- | --- | --- | --- |
| コード本人確認 | PREPARINGでも本人のSessionを認証する | 維持。コード確認成功と学習開始を混同しない | `access-control.ts`の新protocol `/me`、`authenticateExperimentToken` |
| 画面登録 | PREPARINGでもclaim可。OWNED=200、別画面PENDING=409 | 維持。登録成功時だけ「コード確認・端末登録済み」 | `claimExperimentClient`、`ExperimentLearnerGate.tsx` |
| 公開停止 | `/me`の`flowAvailable=false`で既存Gate。学習APIは409 `experiment_learner_flow_unavailable` | 公開停止は実施の開始待ちとは別の制限と明示。所有画面/競合も別表示 | `App.tsx`、既存Gate |
| 準備中の開始待ち | 専用模擬previewではclaim後の教材要求が409 `experiment_not_running`。旧UIは画面更新/開始前を混在表示 | claim成功後のこのHTTP/codeだけ「実施の開始を待っています」。本人確認・登録済み、研究者開始まで学習不可、更新手順を表示 | `validateExperimentRequest`、`ExperimentLearnerPage.tsx` |
| 端末競合/古い世代 | claimは409 `experiment_client_in_use`、利用要求は409 `experiment_client_stale` | 「この画面では利用できません」。開始を待つだけでは解消しないこと、研究者切替を案内 | 同上、`lockCurrentExperimentClient` |
| 障害・不明な応答 | 旧UIはclaim失敗を競合、教材失敗を開始前とまとめていた | 「接続状態を確認できません」。未知409/503/不正応答で登録成功・開始待ちを推測しない。応答の任意message/例外本文を描画しない | `experiment-access-status.ts`と両画面 |
| 学習操作 | 実施RUNNING前はAPIが409拒否。DBもSession/Stage/Map変更を制限 | 制限を変更しない。待機中はMap/活動操作をマウントしない | `experiment-execution.ts`、`179111...`の既存trigger |
| 開始後 | 専用模擬previewのみP01〜P08が動く | 同じ画面で状態更新すると既存学習UIへ。Stage/Mapを作り直さない | 既存SessionFlowPage/MapPage、今回ブラウザー回帰 |

公開停止と端末競合は同時に成立し得るため、通常Gateでは公開停止の全体説明に加えて画面登録結果を分けて示す。通常Gateには実施状態の応答がないので、PREPARINGや研究者開始済みとは推測しない。開始待ちの明示検証は、既存のloopback専用・ONLY_SYNTHETIC・DB markerを検査するpreviewプロセスで行う。公開ゲートを開いていない。

更新は同じ画面秘密を使い、要求中ボタンを無効化する。開始待ちの確認成功と画面ACK/学習保存成功は別であり、待機表示で学習操作成功とは示さない。再読込・別画面の編集権移動、古い世代の拒否、未同期Mapの非移送の意味は変えない。

## 今回の変更ファイル

- `frontend/src/ExperimentLearnerPage.tsx`: 既存HTTP/codeに基づく開始待ち/競合/障害表示、成功応答の型確認、更新中の二重操作抑止。
- `frontend/src/ExperimentLearnerGate.tsx`: 公開停止と端末登録/競合の区別、失敗時の古い登録成功表示を消す。
- `frontend/src/experiment-access-status.ts`: 既知のHTTP/codeだけを固定文言へ対応づける。未知の理由を追加しない。
- `frontend/scripts/verify-experiment-learner-browser.ts`: 実コード入力→準備中登録→開始待ち→競合→研究者開始→既存P01〜P08。障害/未知応答のtransport fixtureは実API検証と区別。
- `frontend/scripts/verify-participant-access-browser.ts`: 公開停止と登録/競合を別に検証、既存明示切替/失効コード検証を維持。
- `backend/src/scripts/verify-experiment-learner.ts`: 準備中の本人確認・claim成功を学習拒否から分離。実Stageと未作成Map IDへの直接要求を拒否し、Session/Stage/Map/受付票の部分変更なしを照合。ブラウザーには別のPREPARING実施を渡す。
- 本書と`waiting-before-*`/`waiting-after-*`の検証結果。

## 検証環境・方法

Windows / Node v22.23.4 / PostgreSQL 17 / Edge headless。新規の`stage1_mock_waiting_before`と`stage1_mock_waiting_after`のみ使用。既存DATABASE_URLを解除し、専用container ID/DB名/用途ラベル/nonce/loopback/mountの既存guardを通してcreate/migrate/safety/seed/check。TEST ONLYの合成教材・参加者のみで、研究条件や教材の初期値を追加していない。

変更前は`participant-access`/`participant-access-browser`/`experiment-learner`の3件を実行して成功。旧UIでの本人確認/登録・拒否・開始後の回帰であり、新表示が確認済みという意味ではない。

変更後は以下の関連15件を選択し、独立した新規DBで実行した。全体suite全件の今回再実行とは区別する。

```powershell
# NODE_ENV=development / STAGE1_MOCK_DATA=ONLY_SYNTHETIC / DATABASE_URL未設定
npm run db:mock --prefix backend -- create --name stage1_mock_waiting_after --mock-data-only
# migrate / safety / seed / checkをそれぞれ同じ専用nameで実行
# RESEARCH_BROWSER_CHECKS=1、BROWSER_CHANNEL=msedge、RESEARCH_CHECK_REPORT_PREFIX=waiting-after
# RESEARCH_SUITE_ONLY=下記15件をカンマ区切り
npm run db:mock --prefix backend -- suite --name stage1_mock_waiting_after
# backend/frontend各々でtypecheck、lint、build
```

`test:event-export`、`test:stage1:integration`、`test:session-flow-survey`、`test:five-flow-composite`、`test:map-failure-retry`、`test:assessment-events`、`test:server-audit`、`test:audit-routing`、`test:delivery-reliability`、`test:session-flow-survey-browser`、`test:five-flow-feedback-browser`、`test:undo-role-browser`、`test:participant-access`、`test:participant-access-browser`、`test:experiment-learner`。

実APIでは準備中の本人確認とclaimを成功として別に確認し、flow取得、Session開始、実Stage開始、Map作成、未作成Mapの取得/編集/提出をすべて409 `experiment_not_running`として確認する。Mapが準備中にDBへ作成できないため、その時点の編集/提出拒否は未作成の有効形式IDに対するpreflight拒否の検証であり、存在する学習Mapを事前作成した検証ではない。

ブラウザーの503/未知409/claimに不適切な開始待ちコードを返すtransport fixtureは、UIの誤推定と例外表示を検査するためのもので、実DB停止を再現したという意味ではない。API/DB障害の制御自体は今回変更していない。待機状態を固定sleepで待たず、対象応答・見出し・更新ボタン復帰を待つ。

## 今回の最終結果（2026-11-10 JST）

| 確認 | 結果 |
| --- | --- |
| 変更前の専用DB準備と対象3件 | create/migrate/safety/seed/check成功、3/3成功。各検証の時間合計76.038秒 |
| 変更後の独立専用DB準備と関連15件 | create/migrate/safety/seed/check成功、15/15成功。各検証の時間合計242.427秒 |
| backend typecheck / lint / build | 全て成功。今回backendランタイムは変更なし |
| frontend typecheck / lint / build | 全て成功。最終UI変更後にも再実行。Viteの500kB超chunk警告は残る（build成功） |
| 表示画像 | waiting.png / client-conflict.png / unpublished.pngを目視確認。アクセスコード平文なし |
| 保護確認 | 開始時hashを記録した既存変更のうち対象5ファイルと今回生成レポート以外は一致。単位A/Bのhashも一致 |
| 後片付け | 今回の2専用コンテナー/volumeと対応cache/manifestをID/用途/nonce/DB名/bindなし/パス範囲で確認して削除。開始時cleanだったsuite生成のsurvey結果JSONは復元 |

今回のテスト実行に失敗はなく、変更前成功と変更後成功を別prefixに保存した。探索時の存在しない補助ファイル/PowerShellで展開されないglobの読込み失敗はテスト失敗ではなく、実パスで読み直した。模擬transport障害は期待する異常系が成功したもので、実DB障害を観測した記録ではない。

過去の`learner-acceptance-*`やGitHub CIを今回の実行結果と混同しない。今回は関連15件であり、先行52件全体suiteを今回再実行したとはしない。両mock DBを停止したため模擬サービスは利用中ではない。通常公開ゲートも閉じたまま。

画像は`<local-verification-artifacts>/waiting-state/`、結果は`docs/waiting-before-suite-results.json`と`docs/waiting-after-suite-results.json`。未コミットの保護コピー`.local/waiting-ui-before`は保持し、アプリ実行経路には含めない。

## 対象外・残る制約

R05教材テスト実行、実施終了、離脱/撤回、新protocol分析/Export、未同期端末回収は実装しない。教材/動画/Goal/seed数、全Kit使用、時間指標、撤回後の保存/削除/backup等の研究判断も追加しない。実機LAN、物理的な複数端末、20端末同時利用、実研究データ、本番運用の確認ではない。別ブラウザーcontextは端末競合の模擬であり、実機検証と区別する。

コミット、push、PR/Issue変更、既存DB適用、参加者向け公開なし。
