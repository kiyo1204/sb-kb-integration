# PR #36: リクエスト共有の秘密値照合予算

## 作業基点と今回の結果

2026-11-08。作業場所は `C:\Users\kyoum\.codex\worktrees\research-note-safety\analysis-layout-repo`、branch は `codex/research-note-secret-protection`、HEAD は `d0c39166a0bf0987a749640a9aaa98da7eb9255b`。
開始時の未コミット変更は `backend/src/index.ts` と `backend/src/research-output-safety.ts` だけであり、それを引き継いだ。適用される AGENTS.md は見つからなかった。他の worktree、既存DB、研究データには接続・変更していない。

GitHubで PR #36 は open / base main / 同じ head、main は `359ae31db9d37fc25263c5aaf85d0f4e950173fe`。公開済みheadの [PR CI](https://github.com/kiyo1204/sb-kb-integration/actions/runs/42453554507) と [push CI](https://github.com/kiyo1204/sb-kb-integration/actions/runs/42453524050) は成功。今回の未コミット変更をそのCIが検証したわけではない。commit/push/PR・Issue操作は行わない。

今回の対象検証、関連14検証、backend/frontendのtypecheck・lint・buildは成功。最終追加テストを含む対象結果は `safety-budget-final-target-suite-results.json`、関連結果は `safety-budget-related-suite-results.json`。以前の `research-note-*.json` は過去の証拠であり、今回の結果と区別する。

## HTTP応答と監査の順序

以前の暫定 `response.send` 差し替えを削除した。`researchSafetyBudget` はリクエスト開始時に AsyncLocalStorage のスコープを作るだけであり、HTTP応答を変更しない。

1. 共通検査が `ResearchSafetyError` を送出する。元のDB例外・入力本文・候補秘密値は保持しない。
2. 保存ルートは ROLLBACK 後、出力ルートは送信前に `respondResearchSafetyError` を呼ぶ。
3. 固定のHTTP status・JSON本文を確定してから、既存 `server-audit.ts` の send 処理へ入る。
4. 既存監査が確定したstatusから outcome/reasonを決め、監査を記録した後に送信する。監査後にstatusを上書きする処理はない。

| 原因 | HTTP / JSON error | 既存監査 outcome / reason_code | 利用者への対処 |
|---|---|---|---|
| 共有予算超過 | 422 / `safety_budget_exceeded` | `REJECTED` / `VALIDATION` | 入力短縮・出力範囲縮小。範囲を変えられない場合は管理者へ |
| 秘密値ハッシュ照合先のquery失敗 | 503 / `safety_lookup_unavailable` | `FAILURE` / `SERVER` | 時間を置いて再試行、継続時は管理者へ |

HTTPの個別理由コードを、既存監査の分類（VALIDATION/SERVER）へ対応させる。監査schema・既存イベントを変えない。監査対象の各拒否要求について、応答の `X-Research-Event-Saved: true` と、新規監査1件だけのoutcome/reasonをDBで照合した。照合DB障害は、専用模擬DBのrevocations表だけを一時的に隠す方法で発生させ、finallyで復元した。監査DBまで全面停止する障害の保証ではない。

失敗応答はJSONの `error` と `message` のみ。CSV用Content-Dispositionを除去し、Content-TypeをJSONへ設定し直す。共通検査の対象経路にはHTTPの逐次ストリーミングはなく、全検査を完了してからjson/sendするため、途中までのCSV・Map・JSONを送信しない。保存拒否では評価・メモ・Map・Kit・受付票の部分更新がないことを検証した。拒否/失敗の監査記録は意図して残す。

## 予算単位・上限・検出契約

1リクエストの共通検査全体で **SHA-256候補照合20,000回**。各 `tokenHash` の直前に残数を減らし、20,001回目は計算せず拒否する。文字列全体、空白区切り、埋め込み43文字および32〜128文字の候補窓をすべて同じ予算に算入する。検出ロジック・窓の長さ・順序は変えていない。

分析APIの生データ照合と、後続の評価・メモ照合、6活動のassessmentSnapshot、5活動のsurveySnapshotも同じALS storeを使う。load関数ごとに予算を作り直さない。並行要求は別storeで、モジュール共通の可変カウンターはない。HTTP終了/切断時にscopeを閉じ、遅れて実行された照合は失敗させる。応答済み要求の予算をバックグラウンドで再利用しない。

共通検査の呼び出しはすべてawaitされる。既存の自動提出timerとEventExportServiceの掃除timerは起動時に作られ、リクエストscopeの外にある。新たなバックグラウンド処理をリクエスト内で起動する設計は追加していない。スコープ外の単体呼び出しはloadごとに独立した20,000回予算を持つ。同期/非同期境界、8並行要求、終了済みscopeの拒否、scope外呼び出しを検証した。

根拠：長さn>=128の秘密に一致しない英数字run1本では、窓だけで `97*n - 7663` 回程度の候補が必要（全体・単語・run照合が別途3回）。190文字は10,770回で単独では通るが、異なる190文字2本は共有上限を超える。10,000文字では従来約96万回となる。20,000回なら今回のWindows実測で同期照合部分が概ね50〜110msに留まり、日本語1,000文字×10行は約1ms以下で通る。CPU回数の上限であり、HTTP全体の処理時間SLAやDB待機時間上限ではない。

既存の上限は理由5,000文字、メモ10,000文字、通常JSON 100kb、Goal Map JSON 4,000,000 bytes・概念1,000・Link2,000・label512文字・title120文字。アンケート/旧評価は最大1,000問・prompt10,000文字など。これらはサイズ/形式上限であって秘密照合コストの上限ではなかった。保存済み出力には複数行・複数snapshotが含まれるため、各文字列上限だけでは不足する。

大きな正常Map・UUIDの多い履歴でも20,000回を超えれば出力全体が拒否される。この制約は意図した安全側の動作であり、最大サイズの全出力を許可する保証ではない。Session分析のように範囲を狭めるUIがない場合は管理者へ案内する。出力を得るために既存研究データを削除・改変させる処理はない。

現在の研究者値、現存する学習者ハッシュ、保存済み失効ハッシュ、旧32〜128文字コード、区切りのない埋め込みコード、credential-likeパターンを維持した。全32〜128文字長の埋め込み照合を単体検証し、現在/失効/32/128文字・埋め込みの保存拒否と旧保存データの読出しを実APIで確認した。予算不足は秘密なしではなく422になる。秘密値の新しい平文保存・復元は追加しない。未知、分割・変換された秘密、保持されていない過去ハッシュは依然として完全には検出できない。

## 経路一覧と今回の結果

以下の共通検査経路はすべて予算超過422、照合先失敗503を確認。良性文・秘密値・認可は対象/関連suiteで確認。新たな監査イベント種類は作らない。

| 経路（/apiを省略） | 送信/保存境界 | 既存の研究者監査 |
|---|---|---|
| POST research/stage1/sessions/:id/evaluations, reflections | 検査→INSERT→監査→COMMIT。失敗時ROLLBACK | RESEARCH_ASSESSMENT_CHANGE、結果照合PASS |
| GET …/analysis | rawと注釈を同一予算で検査→JSON | RESEARCH_ANALYSIS_VIEW、結果照合PASS |
| GET …/evaluations.csv, reflections.csv | rawと注釈を検査→CSV全体 | RESEARCH_EXPORT、結果照合PASS |
| GET …/operations.csv, features.csv | raw検査→各CSV | RESEARCH_EXPORT、結果照合PASS |
| GET research/sessions/:id/export | nested snapshotとraw検査→JSON添付 | RESEARCH_EXPORT、結果照合PASS |
| GET …/survey、GET …/assessment | snapshot検査→JSON | このGETは従来の監査対象外 |
| GET …/survey-answers.csv、…/assessment-answers.csv | snapshot/全行検査→CSV | RESEARCH_EXPORT、結果照合PASS |
| GET session-stages/:id/survey | 共通surveySnapshot→JSON | 従来の監査対象外。current活動の422/503も確認 |
| POST research/goal-maps/import | 全label照合→新Map/Kit書込み。失敗時ROLLBACK | この転送ルートは従来の監査middleware登録前 |
| GET research/goal-maps/:id/export | 保存済みlabel全検査→JSON添付 | 同上、監査を新設していない |

共通検査を使わない別契約も確認した。イベントZIP/JSON/CSVは `event-export-query.ts::normaliseEvent` と `event-export-service.ts` の既存検査/出力制限を使い、研究者評価理由・メモを含めない。今回の20,000回制限の対象へ勝手に変更していない。`test:event-export` と5活動複合検証でその認可・秘密値保護・CSV・ZIPを回帰確認した。新5活動の数値特徴量専用出力もこの共通文字列照合を呼ばず、契約を変えていない。

画面はStage1AnalysisPageの読込/保存/CSV/JSON、共通download、旧評価CSV、アンケート取得/CSVで固定理由に応じた対処文を表示する。Goal Map転送は既存のmessage表示を再利用。Edgeのブラウザーテストで422/503の分析表示・メモ保存・CSVエラー、入力保持、ダウンロードが発生しないことを確認した。

## 性能（今回の測定）

Windows、AMD Ryzen 7 7730U、Node v22.23.4、Docker Desktop PostgreSQLの新規専用DB。`performance.now()`の経過ms。関数は合成ハッシュ1件のlookup、APIはlocalhostの実サーバー/認証/監査/DBを含む。入力はすべてテスト専用。修正後は5反復、比較用の従来候補列挙・SHA計算ループは3反復、並行要求は各1バッチ。厳密な負荷ベンチマークではなく、固定sleepで結果を待っていない。

最終対象実行の記録は `safety-budget-final-target-performance.json`。従来方式の再現ループは合成入力に対する計算部分のみで、修正前実APIを今回動かしたという意味ではない。前回報告のWindows Node24単体値とも区別する。

| 関数入力 | 従来ループ中央値 ms | 修正後中央値 ms | 修正後の扱い |
|---|---:|---:|---|
| 英数字1,000文字 | 261.91 | 67.89 | 予算超過で拒否 |
| 英数字10,000文字 | 3,714.42 | 64.05 | 予算超過で拒否 |
| 異なる英数字1,000文字×10行 | 3,073.71 | 55.85 | 全体拒否、行の一部を成功扱いしない |
| 日本語1,000文字×10行 | 0.40 | 0.44 | 検査完了 |

| 修正後の実API | 中央値/バッチ総時間 ms | 結果 |
|---|---:|---|
| メモ10,000英数字 | 149.04（138.25〜279.10） | 422、監査REJECTED |
| 評価理由5,000英数字 | 156.91（104.43〜177.94） | 422、監査REJECTED |
| メモ日本語1,000文字 | 29.61（29.23〜34.27） | 201 |
| 別要求で保存した190文字×10行のCSV | 155.31（150.45〜174.09） | 合算超過422 |
| 190文字の8並行保存 | 全体655.55 | 8件とも201、予算独立 |
| 10,000文字の4並行保存 | 全体503.00 | 4件とも422 |

関連suite中の別測定も `safety-budget-related-performance.json` に保存。実機負荷の変動があるため、測定値を厳密な応答時間保証にしない。要求数自体を制限するレート制限・worker化は今回行っていない。

## 再現コマンドと検証記録

グローバルNode/LAN環境は変更せず、この作業のプロセスPATHにのみNode22を指定した。実行前にDATABASE_URLを解除し、mock-dbの生成/照合ガードだけで専用接続先を選んだ。

```powershell
$env:NODE_ENV='development'
$env:STAGE1_MOCK_DATA='ONLY_SYNTHETIC'
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
npm run db:mock --prefix backend -- create --name stage1_mock_budget_target_1108 --mock-data-only
npm run db:mock --prefix backend -- migrate --name stage1_mock_budget_target_1108
npm run db:mock --prefix backend -- seed --name stage1_mock_budget_target_1108
$env:RESEARCH_SUITE_ONLY='test:research-note-safety'
$env:RESEARCH_CHECK_REPORT_PREFIX='safety-budget-final-target'
npm run db:mock --prefix backend -- suite --name stage1_mock_budget_target_1108
```

関連suiteは別の空の `stage1_mock_budget_related_1108` を同じcreate/migrate/seedで作成して1回実行。`RESEARCH_BROWSER_CHECKS=1`、`BROWSER_CHANNEL=msedge`、`RESEARCH_CHECK_REPORT_PREFIX=safety-budget-related`、選択は以下。14/14 exit 0。

```text
test:research-note-safety,test:stage1:integration,test:data-management,test:event-export,test:goal-map-transfer,test:server-audit,test:audit-routing,test:assessment-events,test:session-flow-survey,test:five-flow-composite,test:five-flow-feature-maps,test:five-flow-features,test:stage1-analysis-layout-browser,test:five-flow-features-browser
```

実行: `npm run db:mock --prefix backend -- suite --name stage1_mock_budget_related_1108`。
Edge単独の `npm run test:stage1-analysis-layout-browser --prefix frontend` もPASS。共有照合を使う学習者survey読出しと32〜128文字全長の追加検証後、対象を再実行してPASS。テストスクリプトの追加のみのため、既に通った無関係な関連検証は再実行していない。

`npm run typecheck --prefix backend`、`npm run lint --prefix backend`、`npm run build --prefix backend`、frontendの同じ3コマンドはすべてexit 0。最終テスト追加後もbackend3コマンドを再確認。DBスキーマ・既存イベント意味・lockfile変更なし。

今回、対象/関連テストの失敗はなかった。最初の `safety-budget-target-attempt` という名前の実行も成功であり、失敗結果ではない。性能比較と追加境界検証を加えて最終実行を行った。通常権限からDockerへ接続できなかった準備段階は、許可された実行権限で新規模擬DBを作成して解消。GitHub照会の引数修正と、gh未導入による照会不能はGitHub接続ツールで解消。ブラウザーの5173番使用中メッセージは専用Viteが空きポートを選ぶ正常動作で、既存サーバーには接続・停止していない。過去文書にあるNode24異常終了や以前のfixture失敗を今回の失敗として数えない。

## 変更ファイル・限界

- backend: `research-output-safety.ts`（予算/型付きエラー）、`index.ts`（scope登録/Session出力catch）、`stage1-analysis.ts`、`goal-map-transfer.ts`、`surveys.ts`、`assessments.ts`（各catch）。
- tests: `verify-research-note-safety.ts`、新規 `research-safety-budget-checks.ts`、frontendの `verify-stage1-analysis-layout-browser.ts`。
- frontend: `auth-client.ts`、`Stage1AnalysisPage.tsx`、`Assessment.tsx`、`Survey.tsx`（固定対処文の伝達）。
- 文書: 本文書、既存保護文書からの参照、今回の集計/性能結果JSON。

今回は隔離合成環境の結果。実研究データ、実機LAN、20端末同時利用、本番のCPU/DB容量は未確認。APIの全面DB停止・長時間の接続待ち、すべての最大サイズデータでの成功は保証しない。今回の未コミット変更のGitHub Actionsは未実行。既存データの変換・削除、認証値の新規平文保存、研究条件やIssueの変更は行わない。

片付け: 作成した `stage1_mock_budget_target_1108` と `stage1_mock_budget_related_1108` をmanifestの名前・64桁ID・nonce・`isolated-mock-reset`ラベルで照合し、コンテナーと付属volumeを削除。専用manifest/Exportキャッシュ、テスト生成のPNGも削除した。実APIテストの独自一時ディレクトリと子プロセスはfinallyで破棄。suiteが生成した既存文書の出力は履歴版を維持し、今回の集計は `safety-budget-*` に保存した。

## 通常規模出力の後続修正

後続の [通常規模出力検証](research-safety-normal-scale.md) で20 Session/4,000履歴の拒否を再現し、検出範囲を維持してexact SHA計算をリクエスト内で再利用する修正を加えた。20,000回上限は維持する。上記の初回測定・候補計算式はその時点の記録であり、現在の重複計算数と区別する。
