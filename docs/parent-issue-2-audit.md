> 2026-10-31 PR #16 P1修正追補：ログ接続障害時の安全応答と、失敗監査を保持する同一キー再試行を修正。新規隔離DBで追加179104、標準29検証（P1の8シナリオを含む）、静的6件、防護・新形式起動が成功。初回の準備/fixture失敗も分けて記録した。[今回の検証記録](pr16-p1-verification.md)。過去の12/4判定を全面完了へ拡大しない。

> 2026-10-30 PR前全体検証：今回の2修正を含む標準28検証、両型検査/Lint/ビルド6件、隔離DBの防護・新形式起動検証が成功。初回の準備順序による失敗と再実行を含む詳細は [PR前検証記録](pr-preflight-verification.md)。GitHub CI・実機LAN・本番運用は未確認のまま。

> 2026-10-30最終レビュー修正：評価受付の派生スコープ削除と、Link保存・再取得失敗時の既知位置保持について、対象5検証と両型検査/Lintが成功。詳細・観測限界は [追補の修正記録](parent-followup.md) と [今回の対象検証結果](review-fixes-suite-results.json)。12/4判定の範囲は拡大しない。

# 親Issue #2 現在の再評価（2026-10-30、既存記録による確認）

**最新集計：確認済み12／一部確認4／未確認0（16条件）。親Issue全体の全面完了とは判定しない。** 旧9/7を引き継がず、各条件を現在のコードと既存記録から評価し直した。条件2・3・4はv5/v6追補のコード・保存済み検証証拠により確認済みへ更新した。未確認0は16条件の各々に何らかの根拠があるという意味で、GitHub CI・実機LAN・本番運用まで検証済みという意味ではない。

作業ツリー：`C:\Users\kyoum\.codex\worktrees\integrate-research-event-streams\sb-kb-integration`。ブランチ `codex/integrate-research-event-streams`、HEAD `7ae20d03b8a97dbd212e3fcc70ca6516889e089f`。git worktree登録・ルート・statusを対象場所で確認。共通Git管理先は `C:/sb-kb-integration/.git/worktrees/sb-kb-integration3` で、別のC:/sb-kb-integrationチェックアウトは評価対象外。

GitHub親Issue本文を読み取り再取得し、保存済み `parent-audit-issue-criteria.json` の16条件と一致することを照合。Issue本文の更新日時は2026-10-27T16:44:12Z。Issue/チェックリスト/ラベル/コメントは変更していない。

今回はテストの追加・実行、型検査・Lint・ビルド、DB接続を行っていない。下表の「確認済み」は現行実装の静的照合と**過去の隔離模擬環境の実行記録**に基づく限定判定である。過去の成功記録を今回の実行成功とは扱わず、その後の全ファイルの同一性/全動作の再保証もしていない。

## 16条件の再採点

コード名は主にbackend/src、画面名はfrontend/src、文書名はdocsを基点とする。検証名は既存npm script名。

|番号|親Issueの完了条件|最新判定|現在コード・文書|既存検証名・証拠|範囲・制約|
|---|---|---|---|---|---|
|1|記録対象のイベント一覧と共通スキーマが定義されている|確認済み|research-event-catalog.ts / research-events.ts / research-event-map-v5.ts / research-event-feedback-v6.ts / research-events-v1.md|test:event-catalog、test:research-event-schema、test:research-events|40語彙、v1〜v6を定義。v2の意味を上書きせずv5座標とv6判定真偽を追加。予約語は実収集と区別。|
|2|意味のある操作が正確な対象・結果・時刻で保存される|確認済み|index.ts / system-submission.ts / assessments.ts / MapPage.tsx|test:map-api-v2、test:parent-followup、test:link-position-browser、test:learning-activity-events、test:assessment-events|旧部分判定を更新。Link位置もドラッグ確定時にMOVE_LINK/v5でDB前後・対象・actor・時刻・順序を保存。MAP_SAVEは独立UIのない予約語。観測できない操作を生成しない。|
|3|成功・失敗・拒否・取消が区別されている|確認済み|research-event-feedback-v6.ts / index.ts / EventTimeline.tsx / event-export-contract.ts|test:parent-followup、test:map-api-v2、test:server-audit、test:research-log-ui|旧部分判定を更新。v6確認処理成功はSUCCESS、学習上の一致/不一致はmatched真偽。拒否/技術失敗は結果なし。旧v1 REJECTED=不一致の意味は維持。観測可能な明示取消だけ記録。|
|4|変更前後の状態とテキスト編集履歴が記録される|確認済み|research-event-map-v5.ts / research-event-assessment-v3.ts / map-history.ts / assessments.ts|test:parent-followup、test:assessment-events、test:map-mixed-history|旧部分判定を更新。全エンティティ・Provenance・Link位置と確定回答の前後を保存。初回未割当位置は自動配置の欠測として保持し過去座標を補完しない。|
|5|学習者・研究者・システムの操作を区別できる|確認済み|access-control.ts / research-events.ts / server-audit.ts|test:research-events、test:server-audit、test:audit-routing、test:integration-invariants|認証主体をサーバー確定。重複提出なし/unsafeAudit=0の記録。共有研究者コードは個人研究者を識別しない。|
|6|活動時間や中断時間を分析できる|一部確認|index.ts / frontend/src/learning-events.ts / event-export-contract.ts / research-event-delivery.md|test:learning-activity-events、test:delivery-reliability、test:server-recovery|サーバー確定開始/完了と観測中断区間を分析可能。ブラウザー終了等の未観測区間を含む実作業/中断の全時間は算出できない。|
|7|通信エラー後の再送で欠損・重複を防止できる|一部確認|observation-outbox.ts / operation-client.ts / delivery-reliability.ts / delivery-reports.ts|test:delivery-browser、test:delivery-reliability、test:server-recovery|固定キー再試行・ACK・順序・再起動・上限/期限/破損申告を確認。領域喪失・申告前終了・キーなし再試行の完全防止には証拠なし。申告なしを欠損なしと扱わない。|
|8|JSONと用途別CSVを出力でき、共通IDで対応づけられる|確認済み|event-export-contract.ts / event-export-service.ts / research-export.ts / docs/samples/event-export|test:event-export、test:event-export-samples、test:parent-followup|出力形式v2、17模擬イベント/9ファイル。ID/件数/時刻/outcome、v5状態、v6 feedback_match、v4本文なし契約を照合。|
|9|指定した条件で出力範囲を絞り込める|確認済み|event-export-query.ts / event-export-routes.ts / EventExportPage.tsx|test:event-export、test:event-export-browser|Session/仮名ID/群/活動/操作/結果、UTC [from,to)、条件内OR・条件間AND、空結果を確認。|
|10|研究者向け閲覧・検索画面が利用できる|確認済み|EventTimeline.tsx / EventExportPage.tsx / DeliveryStatus.tsx / event-export-routes.ts|test:research-log-ui、test:event-export-browser、test:event-scale|固定抽出集合の安定ページ、前後/関連先/品質/理由/時刻、申告と保存状態の区別。4000件は単機模擬fixtureで同時20端末の証拠ではない。|
|11|新ログ形式でマップの履歴再生が正常に動作する|確認済み|map-mixed-history.ts / map-history.ts / map-undo-redo.ts / index.ts|test:map-mixed-history、test:parent-followup、test:undo-redo:unit、test:stage1:integration|旧→境界→v2/v5、旧/新対象Undo/Redo、Link座標・ProvenanceとDB状態一致。欠損/不整合は理由付きPARTIAL。位置UIのHTTP fixtureと実DB API検証は別経路。|
|12|仮名IDとアクセス制御が適切に機能する|確認済み|data-management.ts / access-control.ts / App.tsx / event-export-query.ts|test:data-management、test:research-events、test:event-export、test:data-management-browser|P-ID投影、内部参加者対応表非公開、明示的関連付け/再発行、学習者API/画面拒否。資源UUIDは合意した既存契約を維持。実データ用認証/暗号化を保証しない。|
|13|保存期限の管理と安全な手動削除ができる|一部確認|data-management.ts / DataManagementPage.tsx / assessment-drafts.ts / observation-outbox.ts|test:data-management、test:data-management-browser、test:delivery-browser、test:research-log-ui|識別可能なSession/参加者データは期限表示・範囲/件数プレビュー・確認削除・rollback・失効再送拒否。所有者不明旧下書きは確定方針どおり研究者へ件数だけ表示して隔離保持し、紐付け/復元/移動/削除しない。未接続/不明端末は確認待ち。平文保存期限/保護と全保存先消去は未確認。|
|14|開発用データのリセット手順が整備されている|確認済み|scripts/mock-db.ts / development-event-stream-reset.md / README.md|issue12-results.jsonのchecksPassed、issue13-results.jsonのadditionalPassed、parent-followup-results.jsonのfresh safety/seed/check記録|既定dry-run、開発/模擬設定、専用Docker ID/nonce/DB marker/system identifier、対象DB/backup/計画指紋を照合。通常起動/学習者経由のリセットなし。旧ログ変換なし。バックアップ復元訓練/Linux実走行は未確認。|
|15|全イベントの保存・出力に対する自動テストが整備されている|一部確認|event-test-matrix.ts / scripts/verify-event-catalog.ts / run-research-event-suite.ts / .github/workflows/stage1-prototype.yml|test:event-catalog、test:event-export-samples、test:integrated-streams、親追補一括28件|40語彙と対応表のキー完全一致・生成辞書一致、468契約ケース、実API/ブラウザー回帰の成功記録。契約fixtureは予約語/未観測分岐の実収集を証明しない。CI設定は存在するがGitHub Ubuntu/Node22/Chromiumの実行証拠なし。|
|16|操作ログの仕様、出力構造、分析上の注意点が文書化されている|確認済み|research-events-v1.md / research-data-dictionary.md / research-event-test-matrix.md / samples/event-export/data-dictionary.md / research-event-delivery.md|test:event-catalog、test:event-export-samples、parent-followup-results.json|v1〜v6、出力形式v2、順序/関連ID/actor/outcome/UTC/空値/欠測/申告/秘密検出限界を記載。過去の辞書/検証数は歴史的証拠と区別。|

## 証拠の時点と未確認事項

- `parent-followup-complete-suite-results.json`：28件すべてexitCode=0。`parent-followup-results.json`：40種/468ケース、backend/frontend型検査・Lint・ビルド成功、追加179102/179103と別fresh DBのsafety→seed→check成功の記録。`issue12-results.json` はリセット防護・明示リセットの専用DB実行を記録する。旧26件/39種/354ケースの記録は上書きしない。
- `parent-followup-complete-invariants.json`：179089〜179103の順序適用、通常/自動提出の重複0、unsafeAudit=0、wrongQuestions=0。既存DBの状態を表したものではない。
- `parent-followup-complete-scale-results.json`：20模擬Session/4000イベント/25件×160ページ、準備約6.15秒、中央値約7.62ms/p95約11.73ms、取得照合約0.27秒。Windows/Node24.15/PostgreSQL17.11単機SQL fixture。20端末同時収集・実機LAN・本番性能は未確認。
- GitHub上のUbuntu/Node22/Chromium CI実走行、OS/ブラウザー横断、複数APIプロセス、バックアップ復元訓練、本番認証・通信保護・倫理・実研究データの安全性は未確認。模擬環境の合格から補完しない。Windows native exit 0xC0000409が途中1回発生した記録は残り、原因未特定（再試行/最終一括は成功）。
- 所有者不明の旧下書きは保持方針が確定済み。研究者にはそのブラウザー/originの隔離件数だけ表示する。Sessionと対応する新下書きの確認付き削除と区別する。旧本文を推測して紐付けたり、通常復元・一般Exportへ流したりしない。ローカル平文を暗号化する隔離機構ではなく、他origin/不明端末/バックアップまでの削除を保証しない。

## Git差分の分類と今回の変更範囲

開始時は追跡済み変更29件、未追跡ファイルは下記一覧。既存の実装・マイグレーション・検証記録・辞書・サンプル・監査文書は必要な成果物として保持する。2監査文書も未追跡の監査成果物で、HEADには存在しないため通常git diffには出ない。

`.vite/deps/_metadata.json` はVite依存最適化のhash/configHash/optimized/chunksメタデータ、同ディレクトリのpackage.jsonはtype=moduleのみ。インストール済みViteのcacheDir既定コードと合わせ生成キャッシュと確認した。既存.gitignore末尾へ `/.vite/deps/` だけを追加する。キャッシュ自体は削除しない。

### CI・依存関係・起動・共通設定（必要な成果物）：7件

```text
 M .github/workflows/stage1-prototype.yml
 M .gitignore
 M README.md
 M backend/package-lock.json
 M backend/package.json
 M frontend/package-lock.json
 M frontend/package.json
```

### 実装コード（必要な成果物）：47件

```text
 M backend/src/access-control.ts
 M backend/src/assessments.ts
 M backend/src/index.ts
 M backend/src/map-history.ts
 M backend/src/map-undo-redo.ts
 M backend/src/research-event-map-v2.ts
 M backend/src/research-events.ts
 M backend/src/research-export.ts
 M backend/src/stage1-analysis.ts
 M backend/src/stage1-features.ts
 M frontend/src/App.tsx
 M frontend/src/Assessment.tsx
 M frontend/src/HomePage.tsx
 M frontend/src/MapPage.tsx
 M frontend/src/SessionFlowPage.tsx
 M frontend/src/Stage1AnalysisPage.tsx
 M frontend/src/auth-client.ts
 M frontend/src/design-system.css
?? backend/src/csv.ts
?? backend/src/data-management.ts
?? backend/src/delivery-reliability.ts
?? backend/src/delivery-reports.ts
?? backend/src/event-export-contract.ts
?? backend/src/event-export-dictionary.ts
?? backend/src/event-export-query.ts
?? backend/src/event-export-routes.ts
?? backend/src/event-export-samples.ts
?? backend/src/event-export-service.ts
?? backend/src/event-test-matrix.ts
?? backend/src/map-mixed-history.ts
?? backend/src/research-event-assessment-v3.ts
?? backend/src/research-event-catalog.ts
?? backend/src/research-event-feedback-v6.ts
?? backend/src/research-event-map-v5.ts
?? backend/src/research-output-safety.ts
?? backend/src/safe-server-error.ts
?? backend/src/server-audit.ts
?? backend/src/system-submission.ts
?? frontend/src/DataManagementPage.tsx
?? frontend/src/DeliveryStatus.tsx
?? frontend/src/EventExportPage.tsx
?? frontend/src/EventTimeline.tsx
?? frontend/src/assessment-drafts.ts
?? frontend/src/client-identity.ts
?? frontend/src/learning-events.ts
?? frontend/src/observation-outbox.ts
?? frontend/src/operation-client.ts
```

### 検証・模擬DB管理スクリプト（必要な成果物）：32件

```text
 M backend/src/scripts/verify-research-event-schema.ts
 M backend/src/scripts/verify-research-events.ts
 M backend/src/scripts/verify-stage1.ts
?? backend/src/scripts/generate-event-export-samples.ts
?? backend/src/scripts/mock-db.ts
?? backend/src/scripts/run-research-event-suite.ts
?? backend/src/scripts/verify-assessment-events.ts
?? backend/src/scripts/verify-audit-routing.ts
?? backend/src/scripts/verify-data-management.ts
?? backend/src/scripts/verify-delivery-reliability.ts
?? backend/src/scripts/verify-event-catalog.ts
?? backend/src/scripts/verify-event-export-samples.ts
?? backend/src/scripts/verify-event-export.ts
?? backend/src/scripts/verify-event-scale.ts
?? backend/src/scripts/verify-integrated-streams.ts
?? backend/src/scripts/verify-integration-invariants.ts
?? backend/src/scripts/verify-learning-activity-events.ts
?? backend/src/scripts/verify-map-api-v2.ts
?? backend/src/scripts/verify-map-auto-submit-v2.ts
?? backend/src/scripts/verify-map-mixed-history.ts
?? backend/src/scripts/verify-mock-reset-new-stream.ts
?? backend/src/scripts/verify-mock-reset-safety.ts
?? backend/src/scripts/verify-parent-followup.ts
?? backend/src/scripts/verify-safe-server-error.ts
?? backend/src/scripts/verify-server-audit.ts
?? backend/src/scripts/verify-server-recovery.ts
?? backend/src/scripts/verify-test-target-guards.ts
?? frontend/scripts/verify-data-management-browser.ts
?? frontend/scripts/verify-delivery-browser.ts
?? frontend/scripts/verify-event-export-browser.ts
?? frontend/scripts/verify-link-position-browser.ts
?? frontend/scripts/verify-research-log-ui.ts
```

### 監査文書・仕様・辞書・サンプル（必要な成果物）：21件

```text
 M docs/research-events-v1.md
?? docs/development-event-stream-reset.md
?? docs/issue8-resume.md
?? docs/parent-followup.md
?? docs/parent-issue-2-audit.md
?? docs/research-data-dictionary.md
?? docs/research-data-management.md
?? docs/research-event-delivery.md
?? docs/research-event-export.md
?? docs/research-event-integration.md
?? docs/research-event-test-matrix.md
?? docs/research-event-viewer.md
?? docs/samples/event-export/activity_times.csv
?? docs/samples/event-export/assessment_events.csv
?? docs/samples/event-export/data-dictionary.md
?? docs/samples/event-export/events.csv
?? docs/samples/event-export/events.json
?? docs/samples/event-export/manifest.json
?? docs/samples/event-export/map_operations.csv
?? docs/samples/event-export/researcher_events.csv
?? docs/samples/event-export/system_events.csv
```

### 生成キャッシュ（除外対象・削除しない）：2件

```text
?? .vite/deps/_metadata.json
?? .vite/deps/package.json
```

### 追加マイグレーション（必要な成果物）：12件

```text
?? backend/migrations/1790910000000_create_map_history_boundaries.js
?? backend/migrations/1790920000000_add_event_legacy_reference.js
?? backend/migrations/1790930000000_add_research_annotation_event_refs.js
?? backend/migrations/1790950000000_add_assessment_events_v3.js
?? backend/migrations/1790960000000_add_server_audit_events.js
?? backend/migrations/1790970000000_add_delivery_reliability.js
?? backend/migrations/1790980000000_allow_unknown_delivery_storage.js
?? backend/migrations/1790990000000_allow_delivery_in_flight.js
?? backend/migrations/1791000000000_add_research_data_management.js
?? backend/migrations/1791010000000_allow_explicit_history_deletion.js
?? backend/migrations/1791020000000_add_link_positions_feedback_v6.js
?? backend/migrations/1791030000000_align_v5_jsonb_storage_guard.js
```

### 保存済み検証結果・指紋・出所記録（監査証拠）：44件

```text
?? docs/integration-results.json
?? docs/integration-sources.json
?? docs/integration-verification.json
?? docs/issue10-baseline.json
?? docs/issue10-results.json
?? docs/issue11-baseline.json
?? docs/issue11-results.json
?? docs/issue12-baseline.json
?? docs/issue12-results.json
?? docs/issue13-baseline.json
?? docs/issue13-invariants.json
?? docs/issue13-results.json
?? docs/issue13-scale-results.json
?? docs/issue13-suite-results.json
?? docs/issue8-invariants.json
?? docs/issue8-results.json
?? docs/issue8-source-verification.json
?? docs/issue8-suite-results.json
?? docs/issue9-baseline.json
?? docs/issue9-invariants.json
?? docs/issue9-preservation.json
?? docs/issue9-results.json
?? docs/issue9-suite-results.json
?? docs/parent-audit-baseline.json
?? docs/parent-audit-invariants.json
?? docs/parent-audit-issue-criteria.json
?? docs/parent-audit-results.json
?? docs/parent-audit-scale-results.json
?? docs/parent-audit-suite-results.json
?? docs/parent-followup-baseline.json
?? docs/parent-followup-browser-suite-results.json
?? docs/parent-followup-complete-invariants.json
?? docs/parent-followup-complete-scale-results.json
?? docs/parent-followup-complete-suite-results.json
?? docs/parent-followup-final-invariants.json
?? docs/parent-followup-final-suite-results.json
?? docs/parent-followup-initial-suite-results.json
?? docs/parent-followup-results.json
?? docs/parent-followup-resumed-suite-results.json
?? docs/parent-followup-scale-results.json
?? docs/parent-followup-second-suite-results.json
?? docs/parent-followup-suite-results.json
?? docs/parent-followup-targeted-suite-results.json
?? docs/parent-followup-third-suite-results.json
```

今回の編集は `.gitignore`、本監査文書、`parent-followup.md` のみ。ステージ/コミット/切替/reset/stash/PR操作なし。既存結果JSON・元作業場所・DB・研究データは編集していない。以下は過去時点の監査本文で、最新判定には上記12/4を使用する。

---

> この報告の判定・数値は2026-10-29監査時点。2026-10-30の残課題修正と新しい検証結果は [追補報告](parent-followup.md) を参照。元の監査証跡は保持する。

## 2026-10-30追補：旧評価下書きの取扱方針と親条件の再評価

確定方針：Sessionや参加者との所属を特定できない旧評価下書きは、研究者向けに隔離件数を示して保持する。所有者を推測して復元・紐付けせず、自動削除・移動もしない。これは未決の削除作業ではなく、未解決データを誤って扱わないための確定した取扱方針である。10月29日付の以下の監査表・未解決項目は当時の状態を示す履歴として保持し、現在の評価はこの追補と [追補報告](parent-followup.md) による。

### 親Issue #2 条件13の現在判定

|完了条件|現在判定|再評価|
|---|---|---|
|保存期限の管理と安全な手動削除ができる|一部確認（保持・隔離方針は確認済み）|Session/参加者との所属がサーバー上で確認できるデータは、研究者が件数・範囲を確認して明示削除できる。旧Session別キーの下書きは本人・端末・入力来歴を証明できないため、本文を読まず隔離件数だけを研究者画面に表示して保持する。Session削除へ混ぜず、推測による紐付けや削除をしない。この方針とコードの挙動は一致している。未接続・別origin・不明端末、バックアップ等の消去や、旧下書きの保存期限・暗号化は保証できないため、親条件全体は一部確認のままとする。|

識別可能なデータへの確認付き削除と、所属不明データの保持は別の扱いである。後者は削除・移動していない。根拠は `frontend/src/assessment-drafts.ts`、`frontend/src/DataManagementPage.tsx`、`frontend/src/Assessment.tsx`、`docs/research-data-management.md` と、既存模擬ブラウザー検証 `test:delivery-browser` / `test:data-management-browser`（[追補一括結果](parent-followup-complete-suite-results.json)）である。これらの検証は模擬データ・ブラウザー内の挙動を確認したもので、利用者の保存領域を調査・変更したものではない。未コミット差分、既存DB、GitHub上のIssue・CIは変更していない。

# 親Issue #2 最終統合監査（2026-10-29）

判定: 確認済み9 / 一部確認7 / 未確認0（親の16条件）。**親Issueを全面完了とは判定しない。** 未確認0は本番保証の意味ではなく、全16条件に何らかの検証根拠があるという分類。未確認の運用・プラットフォーム項目は末尾に別記する。

作業場所: `C:\Users\kyoum\.codex\worktrees\integrate-research-event-streams\sb-kb-integration`。ブランチ `codex/integrate-research-event-streams`、HEAD `7ae20d03b8a97dbd212e3fcc70ca6516889e089f`。元の作業場所へ移動・編集せず、reset/stash/commit/ブランチ切替/PR/Issue編集なし。GitHubはIssue本文の読取りだけ。親子の実際の完了条件・更新日時は [取得スナップショット](parent-audit-issue-criteria.json)。以前の報告値を今回の実行結果として扱わない。

## 親Issueの16条件

|番号|完了条件|判定|現在のファイル・実行根拠|確認範囲・残る制約|
|---|---|---|---|---|
|1|記録対象のイベント一覧と共通スキーマが定義されている|確認済み|research-event-catalog.ts / research-events.ts / research-event-map-v2.ts / research-event-assessment-v3.ts / server-audit.ts / test:event-catalog（39種・354契約ケース）, test:research-event-schema, test:research-events|現カタログとv1〜v4の型・DB・登録/研究者取得契約を照合。Link位置の収集不足は項目2で扱う。|
|2|意味のある操作が正確な対象・結果・時刻で保存される|一部確認|index.ts / map-history.ts / index.ts / learning-events.ts / server-audit.ts / MapPage.tsx / test:map-api-v2, test:learning-activity-events, test:assessment-events, test:server-audit|保存を伴う確定操作・対象・サーバー時刻は一致。Link文字ドラッグは表示用ローカル位置だけで記録なし。MAP_SAVEは予約語で独立した保存操作は現行UI/APIにない。|
|3|成功・失敗・拒否・取消が区別されている|一部確認|map-history.ts / index.ts / research-events.ts / EventTimeline.tsx / research-data-dictionary.md / test:map-api-v2, test:assessment-events, test:server-audit, test:research-log-ui|四分類と観測可能なADD_LINK取消を確認。ただしFEEDBACK_CHECKのREJECTEDは従来のKit不一致で、確認処理そのものの拒否ではない。表示を明確化し、保存仕様の再定義は保留。|
|4|変更前後の状態とテキスト編集履歴が記録される|一部確認|research-event-map-v2.ts / research-event-assessment-v3.ts / MapPage.tsx / test:map-api-v2, test:assessment-events, test:map-mixed-history|Concept/Link本文・接続・統合・Provenance、確定回答の前後は一致。表示だけのLink位置はv2状態に含まれず再現できない。|
|5|学習者・研究者・システムの操作を区別できる|確認済み|access-control.ts / research-events.ts / server-audit.ts / test:research-events, test:server-audit, test:integration-invariants|actorをサーバーで確定。共有研究者コードでは個人の研究者を識別しない。|
|6|活動時間や中断時間を分析できる|一部確認|learning-events.ts / index.ts / frontend/src/learning-events.ts / event-export-contract.ts / test:learning-activity-events, test:delivery-reliability|活動開始/完了の確定時刻と観測した中断/復帰は利用可能。未観測の終了や無操作・注意は不明で、正確な実作業/中断時間の完全再計算はできない。|
|7|通信エラー後の再送で欠損・重複を防止できる|一部確認|observation-outbox.ts / operation-client.ts / delivery-reliability.ts / research-event-delivery.md / test:delivery-browser, test:delivery-reliability, test:server-recovery|固定キー・順次再送・ACK喪失・再起動・容量/期限/破損を検証。キュー喪失、報告前終了、キーなし再試行の完全復旧/重複防止は保証しない。|
|8|JSONと用途別CSVを出力でき、共通IDで対応づけられる|確認済み|event-export-service.ts / event-export-routes.ts / event-export-contract.ts / research-export.ts / samples/event-export / test:event-export, test:event-export-samples, test:event-export-browser|同一抽出集合のJSON/共通CSV/用途別CSVをID・件数・順序・日時・outcomeで照合。サンプル12イベントも一致。|
|9|指定した条件で出力範囲を絞り込める|確認済み|event-export-query.ts / EventExportPage.tsx / test:event-export, test:event-export-browser|Session/仮名ID/群/活動/操作/結果/[from,to)、条件内OR・条件間AND、空結果、JST→UTCを確認。|
|10|研究者向け閲覧・検索画面が利用できる|確認済み|EventExportPage.tsx / EventTimeline.tsx / DeliveryStatus.tsx / test:event-export, test:research-log-ui, test:event-export-browser|固定スナップショットID+offsetの25件ページ、詳細・本文品質・申告/保存記録の区別。3000件全ページで重複欠落なし。|
|11|新ログ形式でマップの履歴再生が正常に動作する|確認済み|map-mixed-history.ts / map-history.ts / index.ts / map-undo-redo.ts / test:map-mixed-history, test:map-api-v2, test:undo-redo:unit, test:stage1:integration|旧→境界→新のDB状態再生、旧/新両方へのUndo/Redo、Provenance、境界不整合・欠測・保存失敗を確認。Linkの未保存表示位置までの再現は項目4の未完了。|
|12|仮名IDとアクセス制御が適切に機能する|確認済み|data-management.ts / access-control.ts / migrations/179100* / test:data-management, test:research-events, test:event-export, test:data-management-browser|P-ID投影・対応表非公開・再発行/明示関連付け・学習者API拒否。資源UUIDは既存契約維持。暗号化や個人研究者認証の本番評価は未確認。|
|13|保存期限の管理と安全な手動削除ができる|一部確認|data-management.ts / DataManagementPage.tsx / assessment-drafts.ts / observation-outbox.ts / test:data-management, test:data-management-browser, test:delivery-browser, test:research-log-ui|期限表示/確認削除/DB rollback/失効再送拒否/未接続確認待ちは確認。新下書きの消去漏れを修正。所属不明の旧下書き・未接続端末の即時消去・平文下書き保護方針は残る。|
|14|開発用データのリセット手順が整備されている|確認済み|scripts/mock-db.ts / docs/development-event-stream-reset.md / README.md / db:mock safety, db:mock check, test:test-target-guards|新規Docker模擬DBのみ。既定dry-run、環境/manifest/nonce/DB marker/system identifier/対象確認/計画指紋を多重照合。通常起動や学習者APIにリセットなし。|
|15|全イベントの保存・出力に対する自動テストが整備されている|一部確認|event-test-matrix.ts / scripts/verify-event-catalog.ts / .github/workflows/stage1-prototype.yml / 26検証すべて成功。39種・354契約ケース、旧17語彙、実API・ブラウザー結合検証|新種別の対応表漏れと辞書ずれを検出。契約fixtureの保存/出力合格は、予約語や未観測分岐の実収集を証明しない。Link文字移動のnative経路は未実装。GitHub/Linux CIの実走行は未実施。|
|16|操作ログの仕様、出力構造、分析上の注意点が文書化されている|確認済み|research-events-v1.md / research-data-dictionary.md / samples/event-export/data-dictionary.md / research-event-test-matrix.md / test:event-catalog, test:event-export-samples, 本監査のコード照合|バージョン/順序/結合/日時/空値/観測限界/秘密検出限界を照合し、今回の不一致と未解決事項を追記。|

表のファイル名はbackend/src、frontend/src、docsを省略したものを含む。現在ファイルを照合した結果で、過去のIssue完了報告の引用ではない。

## 分割Issue #3〜#13の47条件

### Issue #3

[[操作ログ][設計] イベントカタログ・共通スキーマ・DBを設計する](https://github.com/kiyo1204/sb-kb-integration/issues/3)

|番号|GitHubの完了条件|判定|根拠|範囲・理由|
|---|---|---|---|---|
|1|イベント定義表に対象・発火タイミング・必須項目・outcomeの扱いが明記されている|確認済み|research-events-v1.md; research-event-test-matrix.md; test:event-catalog|イベント定義・時点・必須項目・結果を39語彙の対応表で照合。|
|2|共通DB/型/APIに対するスキーマ検証と基本保存・取得テストがある|確認済み|research-events.ts; migrations/179089〜179101; test:research-events; test:research-event-schema|v1〜v4と旧互換、未知/秘密フィールド拒否・保存取得を新規DBで確認。|
|3|同一マップ内の操作順序と異なる主体のイベントが識別できる|確認済み|research-events.ts; map-mixed-history.ts; test:map-api-v2; test:research-events|Session内連番・Map境界・actorを照合し、競合時一意性を検証。|
|4|旧ログに依存する箇所と移行/リセット要否が明示されている|確認済み|research-events-v1.md; development-event-stream-reset.md; test:mock-reset-new-stream|旧ログ依存と混在読取/新規書込・開発リセットを区別。|

### Issue #4

[[操作ログ][マップ] Scratch/Kit/Integrationの編集操作と履歴再生を新形式に対応](https://github.com/kiyo1204/sb-kb-integration/issues/4)

|番号|GitHubの完了条件|判定|根拠|範囲・理由|
|---|---|---|---|---|
|1|3種類のマップでイベント一覧に対応する操作が収集される|一部確認|map-history.ts / index.ts; MapPage.tsx; test:map-api-v2|3種類の保存APIからv2を記録するが、Link文字の表示位置移動はDB/カタログ外。MAP_SAVEは予約語。|
|2|操作の成功・失敗・拒否・取消と変更前後が整合する|確認済み|map-history.ts / index.ts; test:map-api-v2; test:integration-invariants|成功・拒否・rollback後の失敗・限定取消で状態不変/更新と安全理由を確認。|
|3|Undo/Redoを含むリプレイ最終状態が保存されたマップの状態と一致する|確認済み|map-mixed-history.ts; map-undo-redo.ts; test:map-api-v2; test:map-mixed-history|境界前旧操作・新操作へのUndo/RedoとDB最終内容一致を確認。未保存表示位置は対象外。|
|4|再現不能な履歴は原因/欠損状態を明示できる|確認済み|map-mixed-history.ts; test:map-mixed-history; test:research-log-ui|欠測/境界不一致は正常再生とせず理由を返し実画面で表示。|
|5|試行回数やドラッグ中イベント数ではなく「確定した操作単位」で保存する|確認済み|MapPage.tsx; test:map-api-v2; test:stage1:integration|確定API単位。Conceptドラッグ確定/ラベル確定のみ記録、キーストロークなし。|

### Issue #5

[[操作ログ][学習活動] 動画・活動遷移・中断復帰・Kitフィードバックを記録](https://github.com/kiyo1204/sb-kb-integration/issues/5)

|番号|GitHubの完了条件|判定|根拠|範囲・理由|
|---|---|---|---|---|
|1|各活動について開始/終了・遷移の時刻が記録される|確認済み|index.ts / frontend/src/learning-events.ts; test:learning-activity-events; test:server-recovery|両群活動開始/完了とSession遷移をサーバー確定、期限は別イベント。|
|2|中断・復帰とブラウザー終了などで不確実な状態を区別できる|確認済み|learning-events.ts; research-event-delivery.md; test:learning-activity-events|ブラウザー申告とDB状態を区別、未観測の終了を生成しない。|
|3|学習者の活動時間をログから再計算できる|一部確認|event-export-contract.ts; research-data-dictionary.md; test:learning-activity-events|観測区間・server elapsedは再計算可能。未観測終了を含む実作業/中断時間の正確な総量は不明。|
|4|Kitの判定結果のログ収集が正解内容の不適切な開示を起こさない|確認済み|index.ts; index.ts / frontend/src/learning-events.ts; test:learning-activity-events|本人/current Stageだけ、Goal/正解本文はイベントに含めない。Kit不一致のREJECTED意味を明記。|

### Issue #6

[[操作ログ][評価] 事前・事後評価と自由記述の確定編集履歴を記録](https://github.com/kiyo1204/sb-kb-integration/issues/6)

|番号|GitHubの完了条件|判定|根拠|範囲・理由|
|---|---|---|---|---|
|1|確定した回答変更のbefore/afterと関連設問を追跡できる|確認済み|assessments.ts; research-event-assessment-v3.ts; test:assessment-events|確定回答の前後と対象設問をDB内容/Exportで照合。|
|2|事前/事後評価を混同せず、同一参加者内で関連づけられる|確認済み|assessments.ts; research-export.ts; test:assessment-events; test:data-management|評価時点はDB/研究者出力で維持、P-ID投影で関連付け。|
|3|保存/提出成功と失敗が区別される|確認済み|assessments.ts; test:assessment-events; test:delivery-reliability|保存・Stage提出・イベント原子性と失敗/拒否、安全理由を確認。|
|4|キー入力単位での過剰記録を行わない|確認済み|Assessment.tsx; test:assessment-events|onBlur/提出で確定し同値では編集イベントなし。localStorageは最新値の下書き。|

### Issue #7

[[操作ログ][主体] 研究者・システム処理と拒否/失敗イベントを収集](https://github.com/kiyo1204/sb-kb-integration/issues/7)

|番号|GitHubの完了条件|判定|根拠|範囲・理由|
|---|---|---|---|---|
|1|研究者・システムイベントが学習者イベントと同じスキーマで検索できる|確認済み|server-audit.ts; event-export-service.ts / event-export-routes.ts; test:server-audit; test:event-export|研究者/システム主体をサーバー確定し共通抽出/閲覧で検索。|
|2|提出拒否、保存エラー、自動提出が理由・主体を区別して残る|確認済み|server-audit.ts; map-history.ts / index.ts; test:map-auto-submit-v2; test:server-recovery; test:integration-invariants|通常・自動提出と拒否/保存失敗、期限回復を区別し重複なし。|
|3|失敗イベントの記録が認証情報等を漏洩させない|確認済み|server-audit.ts; safe-server-error.ts; test:server-audit; test:safe-server-error|既知機密・本文・例外は安全コードへ。未知秘密の完全検出は保証外。|
|4|重複するフロント/サーバーイベントは関連IDで整理できる|確認済み|delivery-reliability.ts; test:audit-routing; test:integrated-streams|関連ID/receipt/重複キーとMap監査のroutingを検証。|

### Issue #8

[[操作ログ][信頼性] 未送信ログの保持・再送・重複防止・欠損検知](https://github.com/kiyo1204/sb-kb-integration/issues/8)

|番号|GitHubの完了条件|判定|根拠|範囲・理由|
|---|---|---|---|---|
|1|オフライン・タイムアウト・サーバー再起動時の再送が検証される|確認済み|observation-outbox.ts; test:delivery-browser; test:delivery-reliability; test:server-recovery|実ブラウザー再起動・切断・ACK喪失と実API再起動を検証。|
|2|再送しても同一event_idのログが重複しない|確認済み|delivery-reliability.ts; test:delivery-reliability|固定キーの同時再送は同じID/sequence。キーなし同一性の推定はしない。|
|3|操作順序・送信状態・欠損疑いを確認できる|確認済み|DeliveryStatus.tsx; test:delivery-browser; test:research-log-ui|client順序とserver順序、報告/保存を別表示。未報告は欠損有無不明。|
|4|未送信キューにアクセスコード/トークンを保存しない|確認済み|observation-outbox.ts; research-event-delivery.md; test:delivery-browser|観測キューは固定v1数値payloadのみ、認証/回答/v2-v4を保存しない。別の評価下書き保護は未解決。|

### Issue #9

[[操作ログ][Export] JSON＋共通CSV/詳細CSVを絞り込み出力](https://github.com/kiyo1204/sb-kb-integration/issues/9)

|番号|GitHubの完了条件|判定|根拠|範囲・理由|
|---|---|---|---|---|
|1|JSONとCSVがイベントID・件数・時刻・outcomeで一致する|確認済み|event-export-service.ts / event-export-routes.ts; test:event-export; test:event-export-samples|新旧/v1-v4の同一集合・共通ID/件数/時刻/結果/順序を照合。|
|2|詳細CSVの行から共通CSVのイベントへ参照できる|確認済み|event-export-contract.ts; test:event-export; test:event-export-samples|用途別各行のevent_idが共通CSVに存在することを照合。|
|3|絞り込み後にも識別子の整合性が保たれる|確認済み|event-export-query.ts; test:event-export; test:event-export-browser|全条件・AND/OR・空・UTC境界と仮名ID投影を確認。|
|4|認証情報を出力せず、研究者のみがExportできる|確認済み|access-control.ts; event-export-service.ts / event-export-routes.ts; test:event-export; test:data-management|学習者403/未認証401、既知秘密拒否/除外、CSV式防護。未知秘密完全検出は対象外。|
|5|サンプルファイルとデータ辞書がある|確認済み|samples/event-export; test:event-export-samples|12模擬イベント・9ファイル、生成物の完全一致とv4本文なし契約を再検証。|

### Issue #10

[[操作ログ][UI] 研究者向け時系列ログ閲覧・絞り込み・詳細表示](https://github.com/kiyo1204/sb-kb-integration/issues/10)

|番号|GitHubの完了条件|判定|根拠|範囲・理由|
|---|---|---|---|---|
|1|絞り込み条件がイベント検索/Exportと整合する|確認済み|EventExportPage.tsx; event-export-query.ts; test:event-export-browser|検索と出力は同じfilter/固定snapshotを共有。|
|2|変更前後/拒否理由/関連イベントが追跡できる|確認済み|EventTimeline.tsx; test:event-export; test:research-log-ui|before/after・拒否理由・旧/新関連先・時刻/品質を詳細で確認。|
|3|数の多いイベントでも閲覧できる|確認済み|test:event-export; test:event-scale; parent-audit-scale-results.json|3000件全ページと4000件代表測定、同時追加でも固定ページ。20台同時ではない。|
|4|学習者権限によるアクセスがAPI/画面で拒否される|確認済み|access-control.ts; App.tsx; test:event-export; test:event-export-browser|研究者API/ルートの未認証・学習者拒否を確認。|

### Issue #11

[[操作ログ][データ管理] 仮名ID・権限制御・保存期限・明示削除](https://github.com/kiyo1204/sb-kb-integration/issues/11)

|番号|GitHubの完了条件|判定|根拠|範囲・理由|
|---|---|---|---|---|
|1|仮名IDがSession内の学習データを結び付けられる|確認済み|data-management.ts; test:data-management|P-ID投影、明示的なSession間紐づけ・再発行でもFK不変。|
|2|秘密情報が保存・JSON/CSVに混入しない|一部確認|data-management.ts; assessment-drafts.ts; test:data-management; test:delivery-browser|サーバー/出力/新下書きの既知秘密を防護。未知秘密、所属不明の旧平文キャッシュの扱いは完全保証不可。|
|3|研究者以外がログを取得/削除できない|確認済み|access-control.ts; data-management.ts; test:data-management; test:research-events|研究者専用ログ/管理API、対応表非公開、他者アクセス拒否。|
|4|保存期限の可視化と、確認を伴う明示削除ができる|確認済み|DataManagementPage.tsx; test:data-management; test:data-management-browser|期限未設定/近い/超過の表示、DELETE確認、変更検出による拒否。自動削除なし。|
|5|削除に関連するデータの整合性と権限がテストされる|一部確認|test:data-management; test:delivery-browser; test:research-log-ui; research-data-management.md|DB関連削除・rollback/再送拒否/新下書き消去を検証。未接続端末・未知旧キー・バックアップ等は完全消去未確認。|

### Issue #12

[[操作ログ][切替] 旧ログの開発用リセットと新形式への安全な切替](https://github.com/kiyo1204/sb-kb-integration/issues/12)

|番号|GitHubの完了条件|判定|根拠|範囲・理由|
|---|---|---|---|---|
|1|旧ログ移行なしで開発用環境を新形式へ初期化できる|確認済み|scripts/mock-db.ts; db:mock migrate/seed/check|新規模擬DBを空の旧ストリームで初期化。変換/移行なし。|
|2|意図しないデータ削除が起こらない防護と明示手順がある|確認済み|test:mock-reset-safety; test:test-target-guards|dry-run・環境・ラベル/nonce・DB marker・system identifier・計画/対象/backup確認を実検証。|
|3|新形式に切り替えた環境で主要機能が起動する|確認済み|test:mock-reset-new-stream; db:mock check|新規6活動から編集/Undo/Redo/提出/分析/JSON/CSVを通し実行。|
|4|README・切替手順にデータ消去の影響が明記されている|確認済み|README.md; development-event-stream-reset.md; scripts/mock-db.ts|対象テーブル・バックアップ・復元不能・再起動手順を実装と照合。|

### Issue #13

[[操作ログ][検証] 網羅的な自動テスト・整合性確認・研究用データ辞書](https://github.com/kiyo1204/sb-kb-integration/issues/13)

|番号|GitHubの完了条件|判定|根拠|範囲・理由|
|---|---|---|---|---|
|1|カタログ上の各イベントに対応するテストがある|一部確認|event-test-matrix.ts; test:event-catalog; test:map-api-v2|39種/354fixtureと旧17語彙対応、追加漏れ/辞書ずれ検出は通過。全native操作の網羅証明ではなく、Link位置/予約語は未収集。|
|2|主要な復旧・履歴再生・出力・権限テストがCIで動く|一部確認|stage1-prototype.yml; parent-audit-suite-results.json|CIは専用DB/Node22/Linux/Chromiumの構成済み。同等26検証はWindowsで成功、GitHub/Linux実走行は未実施。|
|3|研究用JSON/CSVのサンプルとデータ辞書がある|確認済み|research-data-dictionary.md; samples/event-export; test:event-export-samples|JSON/共通/用途別CSVと辞書の一致を確認、v4サンプル明示検証を追加。|
|4|既知の観測限界と取得できない情報が文書化されている|確認済み|research-data-dictionary.md; research-event-delivery.md; research-data-management.md|ブラウザー終了・未観測末尾/注意・平文ドラフト・Link位置・完全秘密検出不可を明記。|

## 監査で行った最小修正

1. 評価ドラフトをSessionハッシュ+Stageのキーへ限定し、認可後に対応が分かる旧キーだけを移す。削除410/研究者の同一ブラウザー削除時に新ドラフトと回答欄を消去。遅い読込・再キャッシュを防ぎ、ブラウザー保存不能の案内を上書きしない。既知資格情報パターンは新ドラフトへ保存しない。問題・回答データ形式・Stage順・サーバー保存契約は変更していない。
2. キュー消去対象のSHA-256を既存の同期実装で計算し、HTTP LANでcrypto.subtleがない場合にも実行する。対象Session以外のキュー・下書きを保持する。IndexedDBにキューがなくても対応する新ドラフトを消去する。ACKは全端末/旧キーの完全消去証明としない。
3. FEEDBACK_CHECK/REJECTEDを時系列で「不一致（確認完了）」、結果条件で「拒否・Kit不一致」と表示。数値・outcome・保存済み行は変更せず、辞書/対応表/生成サンプルの辞書・manifestを一致させた。
4. サンプル検証がv4を明示スキップしていたため、server-onlyの主体・イベント語彙・対象・本文なし・quality/時刻契約を検証する。公開イベントAPIへのv4登録は許可していない。
5. 検証結果の接頭辞RESEARCH_CHECK_REPORT_PREFIXを固定文字種/長さで検証して指定できるようにし、従来のissue13-*.jsonを上書きせず今回のparent-audit-*.jsonへ保存。CIの既定名は不変。

変更ファイル一覧は [監査結果JSON](parent-audit-results.json) のchangedExistingFilesと下記新規ファイル。既存のマイグレーションは変更/追加なし。新規ソースは `frontend/src/assessment-drafts.ts`、監査証跡は `docs/parent-audit-*` とこの文書。ビルドキャッシュtsbuildinfoは検証による生成差分。監査前ファイルのSHA-256は [開始時スナップショット](parent-audit-baseline.json)。削除された開始時ファイルは0、過去issue13集計の変更0。

## 実行環境とDB防護

新規 `stage1_mock_parent_audit` の専用Dockerコンテナだけに接続。NODE_ENV=development、STAGE1_MOCK_DATA=ONLY_SYNTHETIC、既存DATABASE_URLを使わずCLIから限定URLを内部生成。manifestのコンテナID/nonce/ラベル、DBガード/system identifierを照合した。アプリの既存DBや研究データへ接続・適用・削除していない。通常起動の自動リセット処理・UIリセット操作を追加していない。
179089以降の現存12マイグレーションを順に含め全体を適用。現物の並びは [整合性結果](parent-audit-invariants.json)。安全性テストの実resetはこの新規DBだけで、その後模擬seed→空旧ストリーム6活動フロー→結合検証を実施。

## 実行コマンドと結果

DBコマンド前は `$env:NODE_ENV="development"`、`$env:STAGE1_MOCK_DATA="ONLY_SYNTHETIC"`、DATABASE_URL未設定。suite時は `$env:RESEARCH_BROWSER_CHECKS="1"`、`$env:RESEARCH_CHECK_REPORT_PREFIX="parent-audit"`。実資格情報や接続秘密はここに保存しない。

|コマンド|最終終了コード|内容|
|---|---|---|
|`npm run db:mock --prefix backend -- create --name stage1_mock_parent_audit --mock-data-only`|0|今回新規に専用Dockerコンテナを作成。既存DATABASE_URL未使用。|
|`npm run db:mock --prefix backend -- migrate --name stage1_mock_parent_audit`|0|全マイグレーションを順に適用。179089以降の現存12本はinvariants.jsonに列挙。|
|`npm run db:mock --prefix backend -- safety --name stage1_mock_parent_audit`|0|拒否条件/既定dry-run/実resetをこの新規模擬DBだけで確認。|
|`npm run db:mock --prefix backend -- seed --name stage1_mock_parent_audit`|0|模擬seed。|
|`npm run db:mock --prefix backend -- check --name stage1_mock_parent_audit`|0|空の旧ログで新形式6活動/編集/Undo/Redo/分析/出力まで確認。|
|`npm run db:mock --prefix backend -- suite --name stage1_mock_parent_audit`|0|RESEARCH_BROWSER_CHECKS=1、RESEARCH_CHECK_REPORT_PREFIX=parent-audit。26検証すべて成功。|
|`npm run typecheck --prefix backend`|0|最終修正後。|
|`npm run lint --prefix backend`|0|最終修正後。|
|`npm run build --prefix backend`|0|型検査を含む。|
|`npm run typecheck --prefix frontend`|0|frontend buildでも再確認。|
|`npm run lint --prefix frontend`|0|最終修正後。|
|`npm run build --prefix frontend`|0|Vite production build成功、52モジュール。|
|`npm run test:research-log-ui --prefix frontend`|0|最終追加fixture: 実評価コンポーネントの下書き/機密キャッシュ拒否/削除時クリア、Kit不一致表示も成功。|
|`npm run test:delivery-browser --prefix frontend`|0|HTTP LANでsubtleなし、対象ドラフト/キュー消去・別Session保持・旧キー移行・削除後再キャッシュ拒否を追加し再検証。|
|`npm run test:event-export-samples --prefix backend`|0|模擬RESEARCHER_API_TOKENのみで実行、DB接続なし。v1-v3 + server-only v4、全CSV/JSONの一致。|

### suiteが実行した26検証

|検証名（npm run）|終了コード|所要時間ms|
|---|---|---|
|test:test-target-guards|0|1490|
|test:event-catalog|0|3091|
|test:research-event-schema|0|1324|
|test:undo-redo:unit|0|1377|
|test:map-mixed-history|0|1308|
|test:research-events|0|3715|
|test:event-export-samples|0|1384|
|test:event-export|0|26047|
|test:data-management|0|4049|
|test:stage1:integration|0|26271|
|test:map-api-v2|0|7866|
|test:map-auto-submit-v2|0|3666|
|test:learning-activity-events|0|5547|
|test:assessment-events|0|7495|
|test:server-audit|0|8050|
|test:audit-routing|0|2288|
|test:integrated-streams|0|5869|
|test:integration-invariants|0|1977|
|test:safe-server-error|0|1304|
|test:server-recovery|0|5566|
|test:delivery-reliability|0|10370|
|test:event-scale|0|14185|
|test:research-log-ui|0|11382|
|test:delivery-browser|0|19422|
|test:event-export-browser|0|32337|
|test:data-management-browser|0|10940|

suiteの26件は監査修正途中の時点。変更したフロント機能は、その後に追加した実画面検証とdelivery-browserを再実行して合格。追加v4サンプル契約・型検査/Lintも再実行した。未変更のDB処理を再度動かして同じ結果を水増ししていない。
初回失敗も区別する: 新effectの宣言順のlint、追加fixtureのCJS/tsx読込方式2回、模擬トークン未設定の単独サンプル起動拒否があった。いずれも修正/模擬設定後は成功。最終の機能テスト失敗を隠して成功扱いにしたものではない。

### カタログ・出力・削除の照合

- eventTargetsの39キーとeventTestMatrixのキーを完全比較、対応npm scriptの存在確認、生成辞書の完全一致を要求する。新種別追加時の対応表/辞書漏れは失敗。旧語彙17も別に扱う。354契約ケースは全結果値の表現・検証を確認し、実UIで発生できる分岐とは区別する。
- v4契約fixtureはロールバック内で全許可語彙/結果の保存契約を確認し、実APIの研究者/システムactor・本文なしは別のserver-auditとinvariantsで検証。通常/自動提出の重複0、unsafeAudit0、wrongQuestions0。
- JSON/共通CSV/用途別CSVは同じイベント集合。12イベントのサンプル9ファイルをバイト単位で再生成照合し、ID/件数/時刻/outcome/所有者/参照を検証。v1〜v3型に加えv4の安全なserver-only項目も明示確認。CSV式防護による文字列アポストロフィは文書化した相違で、数値を勝手に変えない。
- 削除APIのDB内全件数・FK・失敗rollback、410再登録/キュー再送拒否、確認ACK後のpending減少と未接続/未知端末の待ち表示を検証。新下書きの消去・別Session保持・回答欄クリアも実ブラウザーで追加確認。未知旧キーや全端末の消去を成功と推定しない。

### 今回の代表規模（性能保証ではない）

20模擬Session×200件=4,000件を抽出。25件×160ページ。出力準備8.218秒、ページ中央値10.30ms、p95 14.12ms、JSON/共通CSV取得・照合0.332秒。計測時DB全体は47 Session / 新7,420イベント / 旧5ログ。fixture生成1.267秒。Windows 10.0.26300、Node24.15.0、PostgreSQL17.11、Ryzen7 7730U/16論理CPU/約14.9GB RAM。SQL模擬fixtureの単機計測で20台同時ブラウザー/収集性能/本番保証ではない。詳細は [代表計測](parent-audit-scale-results.json)。

## 未解決・未実行の確認

- Linkラベル位置移動は画面内だけ。DB/v2/イベント語彙/Undo/Redoに追加するか未決定。研究上の収集・保存仕様を勝手に拡張していない。
- FEEDBACK_CHECKのREJECTEDは従来Kit不一致。確認処理の成否と結果を別項目へ分離するスキーマ判断は未実施。保存済み行を再解釈しない。
- 所属不明の旧Stage単位localStorage下書きの自動消去、平文下書きの保存期限・暗号化・実データ用保護は未解決。新下書きの対象消去と画面クリアは修正済み。
- 未観測の終了/無操作/注意・ブラウザー領域喪失・未接続端末/別タブ/別origin・ACK喪失・キーなし再試行は完全復元や完全消去を保証しない。
- MAP_SAVEは予約語。全outcomeの契約fixtureは全UI操作/例外分岐の実収集を証明しない。
- GitHub/Linux Node22 Chromium CIの実走行、20台同時ブラウザー、OS/ブラウザー横断、複数APIプロセス、実DB/研究データ、本番セキュリティ/暗号化/倫理・バックアップ物理消去は未確認。

研究条件・保存モデルの判断が必要なLink位置/結果分離/旧ドラフト保護は勝手に実装しない。検証合格だけを根拠にIssue #2/#3〜#13を閉じたりチェックを更新したりしていない。

今回新規作成した隔離コンテナだけを、ID・purpose・nonceの一致確認後に停止・削除済み。既存DBのコンテナは操作していない。後片付け状態は [監査結果JSON](parent-audit-results.json) のdisposableCleanup。GitHub上のCIを動かすためのcommit/pushはしていない。親Issueの全面完了は、上記一部確認項目の範囲・方針を解決してから判断する。
