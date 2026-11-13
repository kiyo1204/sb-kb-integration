# R03/R04 教材一覧・教材編集

## 基点・範囲

2026-11-09 JST。GitHub mainは `ea5319416cecf11b2ace35308c21047ac4d69d25`、PR #37はopen・未マージ（head `f7430345885d6b9e4c00ea272acbb645d41d86d1`）。PR #37の差分を取り込んでいない。

worktreeは `<repository-root>`、branch `codex/experiment-foundation`、HEADは上記main。前段の保存基盤（179107 migration、内部サービス、ガード、検証・記録）が未コミットの状態で開始し、そのまま拡張した。ブランチ切替・reset・stash・他worktreeへの編集を行っていない。単位A/B文書は元worktreeに保持する。

仕様書v1.0のR04契約と、Figmaファイル `eSgsQfqam4eOdVSuW8fltS` のR04 `3:88` を読み取り参照。深緑ヘッダー、教材概要/操作、左ナビ、中央編集、右完成チェックを既存React/CSSの部品・トークンで実装した。Figmaが返した `primitives` コンポーネントはこのリポジトリの依存/実装にはないため、既存のフォーム要素・ボタンクラスを使う。静的画像/SVGアセットはこのノードにない。Figmaは変更していない。

今回公開するのは研究者専用の教材管理だけ。新protocolの参加者コード発行、実施作成画面R06、開始/終了、学習者進行、分析/Exportは追加しない。

## 保存契約

追加migration: `1791080000000_add_material_catalog.js`。既存migration（前段の179107を含む）は変更しない。旧行の変換・再関連付け・ID置換はしない。

| 新規テーブル | 内容・制約 |
| --- | --- |
| material_catalog_series | 教材系列のIDとサーバー作成時刻。Study/Participant/Sessionとは別概念 |
| material_catalog_versions | 系列内版番号、更新番号、DRAFT/PUBLISHED、編集本文、元完成版ID、固定教材版ID、サーバー時刻。系列内版番号一意、系列ごと編集中下書きは1件 |
| material_catalog_requests | 一意な要求キー、操作種別、要求hash、版ID、返却したID/状態/更新番号等のメタデータ。入力本文/コード平文は受付票に保存しない |
| material_catalog_audit | 研究者の管理操作、対象版ID、最終HTTP status、outcome/reason、固定理由コード、サーバー時刻。自由記述・例外詳細なし |

下書き本文は教材名、研究者向け説明、動画参照、SB/KB/統合説明、Kit ID、Kit内seed ID選択、統合整数秒。未設定の文字列は空、Kitと秒数はnull、seedは空配列で開始する。教材内容や時間、最初のKit・seedを自動選択しない。

下書きの資材IDは選択情報であり、正規資材の別管理ではない。古い参照を含む下書きが、通常の未使用資材の削除をFKで阻害しないよう、下書き本文には資材へのFKを作らない。完成チェックと完成登録で現在の資材・Kit所属を再検査する。完成登録では既存 `experiment_material_versions` と `experiment_material_seeds` に実FK付き参照を作り、カタログ版から固定教材版へ一意なFKを持つ。Concept/Linkの名称・座標・内容をカタログへ複製しない。

完成済みカタログ本文はその版の教材説明等の記録として不変。DB triggerで固定教材版のフィールドとKit/seed選択の一致を検査する。研究者向け説明はカタログ側の不変メタデータであり、学習者フローの新規設定には使っていない。

## 入力・完成条件

| 項目 | 下書き | 完成登録 |
| --- | --- | --- |
| 教材名 | 空可、120文字以内 | 必須、有効な名前 |
| 研究者向け説明 | 空可、10,000文字以内 | 任意 |
| 動画参照 | 空可、2,048文字以内 | HTTP(S) URLまたは公開ファイルの絶対パスが必須 |
| SB/KB/統合説明 | 各空可、各10,000文字以内 | すべて必須 |
| Goal/Kit | 未選択・古い選択でも保存可 | Goal全体に対応し、現在利用可能なKitが必須 |
| SB初期概念 | 空可 | 同じKit内の概念部品を重複なく1件以上選択 |
| 統合制限時間 | null/空欄可 | 1〜2,147,483,647の整数秒が必須 |

制限時間の必須性/整数範囲は、承認済み保存基盤の `integration_seconds integer NOT NULL CHECK(>0)` と内部サービスの32bit整数上限による。実験時間の推奨値ではない。今回、具体値も共通設定からの初期値も設定しない。seedの上限1,000は既存Goal転送の概念数上限と整合する技術上限であり、推奨個数ではない。本文の長さ上限は既存保存基盤に合わせ、研究者向け説明にも同等の技術上限を置く。

新規保存は既存 `loadResearchTextSafety` で既知秘密値/credential-like文字列を検査し、出力は同じ処理でredactする。処理量超過・照合不能は安全扱いしない。未知の秘密を完全検出できるとは保証しない。

クライアントは未設定・形式・Kit/seed・時間の不足を表示し、サーバーは保存済み最新状態を再検査する。完成チェックで不足欄へ移動/フォーカスできる。資材の構造不整合や古い不正ラベルもKit欄へ案内する。チェック後の変更は確認済み表示を失効させ、完成登録は保存済み更新番号で実施する。サーバーはチェック成功だけを信用せず、登録直前にも確認する。

## API・認可・原子性

画面は `/research/materials`（R03）、`/research/materials/:id`（R04）。既存 `ResearcherOnly` と認証APIで研究者以外には表示しない。各APIも既存accessControlに加え、研究者主体を明示確認する。

| API（/api/research/materials基点） | 動作 |
| --- | --- |
| GET / | 系列ID・版・状態・固定教材版IDを含む一覧 |
| GET /assets | 既存Goal/Kitの選択肢、利用可否、固定済みか、概念部品 |
| GET /:id | 保存済み教材版・下書きの取得 |
| POST / | 空の系列/初版下書き作成 |
| PUT /:id | expectedRevisionと完全な編集本文で下書き保存 |
| POST /:id/check | サーバーの不足一覧。チェック自体が成功すればHTTP 200、ready=falseもあり得る |
| POST /:id/publish | expectedRevisionを確認して完成登録 |
| POST /:id/next-draft | 完成済み版を基に同じ系列の次版下書きを作成 |
| DELETE /:id | 変更/削除を公開しないため409で明示拒否 |

書込み4種（CREATE/SAVE/PUBLISH/NEXT）はUUIDのIdempotency-Keyを必須にし、要求キーlockと要求hashを照合する。同一キー同内容の再送は保存済み結果を返し、異内容は競合拒否。更新番号と版行lockで古い画面の上書きを防ぐ。次版作成は系列行をlockし、既存下書きを上書きしない。

完成登録は既存 `publishMaterialVersionInTransaction` を合成境界として再利用する。カタログ更新、固定教材版、seed、受付票、成功監査を同じBEGIN/COMMIT内で扱う。途中のseed保存・監査保存が失敗した場合も一部だけ作らない。既存の単独保存サービスのPool/トランザクション契約は変えない。

教材管理監査は上記専用テーブルに記録し、参加者のMap操作イベントや旧JSON/CSVへ管理操作を混ぜない。既存 `research_events` のイベント意味・列は変更しない。最終status/codeを先に決め、監査を保存した後でJSONを返す。response.sendの差替えは追加していない。`X-Material-Audit-Saved` で記録の成否を示す。

| 場合 | HTTP / 理由コード | 監査 |
| --- | --- | --- |
| 保存/完成成功 | 200（作成は201） | SUCCESS / reasonなし |
| 入力形式不正 | 400 material_invalid_request | REJECTED / VALIDATION |
| 完成不足 | 422 material_not_ready + 固定文の不足一覧 | REJECTED / VALIDATION |
| 秘密値検出 | 422 material_sensitive_text | REJECTED / VALIDATION |
| 照合予算超過 | 422 safety_budget_exceeded | REJECTED / VALIDATION |
| 古い更新/既存下書き/完成版変更/資材競合 | 409 固定コード | REJECTED / CONFLICT |
| 照合障害 | 503 safety_lookup_unavailable | FAILURE / SERVER |
| 保存先等の技術障害 | 503 material_storage_unavailable | FAILURE / SERVER |

拒否監査は入力本文・秘密値・例外本文を保存しない。照合/整形が済むまで出力を開始しない。DB/監査先そのものが利用不能の場合は固定エラーと記録不能のheaderを返す。成功監査を保存できない書込みはrollbackする。

## 不変性・互換性

完成済み版、固定版との結合、受付票、監査は通常DMLで変更/削除不可。次版作成は新しいID/版番号で、完成済み本文を明示的に引き継ぐ。既存実施の固定教材版IDは更新しない。

参照Goal/Kit/Concept/Link/部品の不変性は前段179107のtrigger/FK/APIガードで保証し、API上も409 `experiment_asset_frozen`。新しい版へ内容を変更する場合は別資材を選ぶ。旧来の「Kit登録済みGoalは編集禁止」も緩和しない。未登録の通常Goalは編集できる。

Goal JSON取込みは有効なJSONから新しいGoal/Kit/部品IDを作る従来契約を維持する。固定済みIDへの取込み上書き機能はなく、そのような未知項目を含む要求は拒否する。独立した新資材の取込みまで一律禁止しない。

保証範囲は通常アプリDMLとtrigger/FKが有効なDB権限の範囲。管理者によるDDL/trigger無効化やバックアップの直接変更を防ぐ保証ではない。動画参照の固定はリンク先内容・公開状態の不変性を保証しない旨をUIにも表示する。

旧4/5/6のSession/Stage/Map/認証/イベント/回答/分析/Exportの契約を変更しない。新protocolの保存専用ガードも保持する。参加者コード、開始/終了、編集権、人物/Studyの実施所属を公開する経路はない。

## R05/R06と研究上の未決事項

安全な独立R05実行経路は既存システムにない。Tutorialは別の練習であり、研究者向け全フローテストとして流用しない。上部テスト実行はdisabled、ナビは準備中の説明だけに移動する。研究Session/本番イベントを作らない。テスト未実施でも確認ダイアログを経て完成登録できる。

R06の実施・参加者作成画面、開始/終了、コード発行/再発行、編集端末切替、停止/離脱/撤回、新学習者フロー、分析/Export対応は後段。具体的な教材・動画・Goal・seed数、全Kit要素使用、活動時間の定義、撤回後の保存/物理削除/バックアップ、Study所属・再参加、未同期回収は未決のまま。統合時間の具体値は研究者が入力する。

実研究データ・実機LAN・20端末同時利用・本番運用は今回の模擬検証で保証しない。操作数/構造から理解・困難・学習成果・認知状態を断定しない。

## 今回の検証と途中失敗

環境: Windows、Node v22.23.4、PostgreSQL 17、Edge headless。対象は新規 `stage1_mock_materials`、全体初回は別の新規 `stage1_mock_materials_full`、最終再実行はさらに新規の `stage1_mock_materials_final`。既存DATABASE_URLは解除し、NODE_ENV=development、STAGE1_MOCK_DATA=ONLY_SYNTHETIC、db:mockの識別/loopback/nonce防護を使用。テスト内容・601秒等は合成fixture値で、既定値・推奨値ではない。

途中の失敗（最終成功とは別）:

1. 初回DB createは `--mock-data-only` 宣言不足で `synthetic_attestation_required` と拒否。DBは作成されず、フラグを付けて新規作成し直した。環境変数名の誤りではなかった。
2. API対象テストの末尾で、Kit登録済みGoalの編集を200と期待して409になった。これは既存仕様どおり。検証fixtureを実際に編集可能な未登録Goalへ修正し、製品側の制限は緩めていない。
3. ブラウザーテストの「テスト実行」が上部とナビの2要素に一致した。上部操作領域にlocatorを限定し、状態反映/フォーカスを条件で待つよう修正。固定sleepは追加していない。
4. 不足案内の目視確認後、右側に重複していた詳細理由を折りたたみに整理した。全体suiteの実行中にこの表示変更を入れたため、読み込み済みの旧ブラウザーテストが非表示の一覧を30秒待って失敗した（47件中46成功/1失敗）。この検証順序の誤りは最終結果と混同せず、`materials-attempt-*` に分離した。差分確定後に対象API/ブラウザーを再成功させ、さらに新しいDBで全体を再実行する。

実行コマンド:

```powershell
# 上記の専用環境だけで実行。createのみ --mock-data-only が必要。
npm run db:mock --prefix backend -- create --name stage1_mock_materials --mock-data-only
npm run db:mock --prefix backend -- migrate --name stage1_mock_materials
npm run db:mock --prefix backend -- safety --name stage1_mock_materials
npm run db:mock --prefix backend -- seed --name stage1_mock_materials
# RESEARCH_SUITE_ONLY=test:material-catalog,test:material-catalog-browser
# RESEARCH_BROWSER_CHECKS=1 / BROWSER_CHANNEL=msedge / prefix=materials-target
npm run db:mock --prefix backend -- suite --name stage1_mock_materials

# materials_finalも新規create/migrate/safety/seed/check後、ONLYを解除。
# RESEARCH_BROWSER_CHECKS=1 / BROWSER_CHANNEL=msedge / prefix=materials-full
npm run db:mock --prefix backend -- suite --name stage1_mock_materials_final

npm run typecheck --prefix backend
npm run lint --prefix backend
npm run build --prefix backend
npm run typecheck --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
```

既存suiteのサンプル厳密比較に合わせ、開始時cleanだったサンプル作業コピーだけ改行をLFへ合わせる。終了後は元に戻す。今回の結果は `materials-target-*` / `materials-full-*` に分離し、前段foundationの記録やGitHub CIの過去結果を今回の実行結果とは扱わない。

対象検証はAPI/SQLの6グループと、実APIを使うブラウザー1件。下書き不足、Kit/seed不整合、チェック後の資材変更、秘密値/予算/DB障害と監査、更新競合、seed/監査途中失敗のrollback、同一キー再送/並行完成登録、固定資材API/SQL、次版と実施の旧版維持、既存Session行不変を検証する。画面は未設定・不足案内・完成可能・完成済み・次版・保存失敗・競合・デスクトップ/390px幅を確認する。学習者の実API拒否と、UIの研究者限定ガードを別に確認する。

最終集計・後片付け・変更一覧は検証完了後に下へ追記する。

## 導入・復旧上の注意

今回は既存DBに適用していない。実環境への導入は別承認でバックアップと権限を確認し、前段179107・今回179108を含む必要な追加migrationと対応アプリを揃える必要がある。未対応旧版APIと新基盤の書込みを混在させない。

downで新規データをDROPする処理は用意せず、明示的に拒否する。異常時は新規教材書込みを停止し、固定版/下書き/監査/受付票を保持して対応版へ修正する。新データの消去や旧DB行の変換による復旧は提案していない。DB管理者のバックアップ運用や撤回後の保管方針を、この技術的復旧策で確定したとは扱わない。

## 今回の主な変更ファイル

- `backend/migrations/1791080000000_add_material_catalog.js`: カタログ4表、整合性/不変性/一意性制約、Kitの構造利用可否。
- `backend/src/material-catalog.ts`: 下書き・完成・次版・取得・完成チェック・管理監査のサービス。
- `backend/src/material-catalog-routes.ts`: 研究者専用APIと最終status/codeに対応する安全な応答。
- `backend/src/experiment-foundation.ts`: カタログのトランザクションから既存完成登録を再利用する合成境界を追加。既存の単独保存入口は維持。
- `backend/src/index.ts`: 教材ルート登録。前段のガード差分は保持。
- `frontend/src/MaterialsPage.tsx`, `frontend/src/materials.css`: R03/R04。`App.tsx`に研究者限定ルート、`HomePage.tsx`に研究者導線を追加。
- `backend/src/scripts/verify-material-catalog.ts`, `frontend/scripts/verify-material-catalog-browser.ts`: API/SQL・ブラウザー回帰。
- 両`package.json`と`backend/src/scripts/run-research-event-suite.ts`: 検証の登録。固定資材を作る検証は既存検証の後で実行する。
- 本書と`materials-*`の今回の集計記録。前段の`foundation-*`記録や単位A/B文書を上書きしない。

## 最終結果と作業状態（今回の実行）

| 検証 | 最終結果 |
| --- | --- |
| 専用新規DB 3件のcreate/migrate/safety/seed、全体用2件のcheck | 成功 |
| 対象 API/SQL（test:material-catalog） | 6グループ成功 |
| 対象実API/Edge（test:material-catalog-browser） | 成功。表示整理後も対象2件を再成功 |
| 最終全体suite（stage1_mock_materials_final） | **47件成功・失敗0**。各検証所要時間の合計421.66秒 |
| backend typecheck / lint / build | すべて成功 |
| frontend typecheck / lint / build | 表示整理後もすべて成功 |
| git diff --check | 成功 |

途中の全体試行（46成功/1失敗）は `materials-attempt-suite-results.json`、最終成功は `materials-full-suite-results.json` と関連集計に分離した。最終実行中・後片付け後の未コミットコード/設定18件の集約SHA-256は `114ef0957ad1f85841d8a213beedb4c8ea4d097bc2811556b7e2296786609287` で一致し、最終suite中にコード・テストを差し替えていない。

最終suiteは旧4/5/6進行・動画確認・アンケート・認可・秘密値保護・監査・冪等性・Session削除・履歴再生・Merge解除・特徴量・JSON/CSV・送信回復・既存ブラウザー回帰・保存専用基盤・今回教材管理を含む。保存済みの以前のCI結果から成功件数を転記していない。

R03、R04の不足/完成可能/完成済み/次版、1366pxと390px幅をブラウザー実行と画像で確認した。研究者向けUIは実APIに接続し、未保存エラー表示の一部は安全な503応答を注入、古い画面の競合は実API更新と照合した。学習者UIガードは模擬principal表示、学習者API拒否は実コード認証で別に検証した。確認用画像は `<local-verification-artifacts>/materials-r03-r04/` に保持する。

後片付け: 今回作成した3コンテナーはmanifestのID/名前/purpose label/nonce・host bindなしを確認してから削除し、専用manifestとExportキャッシュも削除した。改行調整した旧サンプルと既存suite生成の旧結果JSONは開始時の内容に戻し、既存ブラウザーテストの一時PNGを削除した。今回の集計記録と画面確認画像を残す。元worktreeの単位A/B文書は以前のSHA-256と一致し、変更していない。

最終branch `codex/experiment-foundation`、HEAD `ea5319416cecf11b2ace35308c21047ac4d69d25`。前段基盤と今回の変更はすべて未コミット。GitHub mainは終了前確認でも同SHA、PR #37はopen・未マージだった。コミット/push/PR・Issue更新、既存DBへの適用、R05/R06や新フローの有効化は行っていない。
