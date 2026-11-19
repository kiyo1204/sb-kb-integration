# SBKB_INTEGRATION_V1: 研究用Excel 11シート出力（追加形式）

## 対象

研究者専用の実施単位 `GET /api/research/experiment-runs/:runId/research.xlsx`。
既存の `research.json`、`research.csv`、Sessionごとの `operations.csv`、共通イベントCSV/JSONは残す。
出力ファイル名は `run-<runId>-research.xlsx`。実研究DBへの移行・実験開始許可を意味しない。

## シート構成

| シート | 元データ／計算方法 |
| --- | --- |
| Overview | 実施ID、教材版ID、Session/イベント件数、抽出時刻、品質注意件数、分析上の注意 |
| Events | 既存 `events.csv` と同じ共通列、当該実施所属Sessionに限定 |
| Map_Operations | 既存 `map_operations.csv` と同じ詳細列、当該実施所属Sessionに限定 |
| Activity_Times | 既存 `activity_times.csv` と同じ詳細列、当該実施所属Sessionに限定 |
| Map_States | 既存実施 `research.csv` の18列と同じ保存・開始・受理提出状態 |
| Operations | 既存Session `operations.csv` の27列と同じ保存操作（全登録Sessionを結合） |
| System_Events | 既存 `system_events.csv` と同じ詳細列、当該実施所属Sessionに限定 |
| Researcher_Events | 既存 `researcher_events.csv` と同じ詳細列、当該実施所属Sessionに限定 |
| SB_Analysis | `PRIOR_MAP` のイベント、保存構造前後・差分と経過時間 |
| KB_Analysis | `KB_MAP` のイベント、保存構造前後・差分・一致確認結果・経過時間 |
| Integration_Analysis | `INTEGRATION_MAP` のイベント、Merge/再接続/Provenance差分と経過時間 |

出力元は **同一の REPEATABLE READ READ ONLY トランザクション**。
イベントは `extractionQuery` / `normaliseEvent` / `csvRows` の既存機密保護・列定義を使用する。
`research.xlsx` は原本ではなく可視化用派生物。既存CSV/JSONを原本として保持する。

## 分析列の意味

- `structure_status=AVAILABLE` は保存に成功したv2/v5マップ操作で、検証済みのbefore/afterの両方が存在するときのみ。
- `NOT_SUCCESS` は拒否・失敗等、`NOT_MAP_CHANGE` は活動・動画・フィードバック等、`PAYLOAD_UNAVAILABLE` は本文が機密保護・容量等により非表示、`SNAPSHOT_UNAVAILABLE` は状態が不十分な場合。
- `active_concepts` は `mergedIntoConceptId==null` のConcept数、`hidden_merge_sources` はそれ以外のConcept数。
- `links` はLink数。変更対象ID・Provenanceの差分は保存された前後状態から導出し、値を推定しない。
- Linkの `connection_before/after` は対象Linkの接続元・接続先ID。ラベル等の全文は既存Map_Operationsのbefore/afterに含まれる。
- `feedback_match` はv6の `FEEDBACK_CHECK` で確認処理が成功した際の一致真偽。`SUCCESS` を一致と同一視しない。
- `elapsed_from_stage_start_ms` はサーバー保存時刻とStage開始時刻の差。実作業時間・思考時間を意味しない。端末申告時刻、可視性イベント、送信遅延も分けて解釈する。
- 旧ログの順序スコープはMap、新イベントはSession。Excelの見た目の行順と「実際のクリック順」を同一視しない。

## 上限と欠測

Excelの最大行数1,048,576（ヘッダー含む）、列数16,384、セル文字数32,767は厳守する。
保護のためこの実装はイベント20,000件、展開XML合計128MiBも上限とし、超過はHTTP 413 `research_workbook_limit` とする。
**切り捨て・先頭件数だけの出力・ゼロ補完をしない。** 巨大なMap状態JSONが1セルに収まらないときも同じ扱い。必要な場合は既存のJSON/CSVを使用する。

ID・連番・時刻・自由記述は文字列 (`inlineStr`) として保持し、桁落ち、日時の暗黙変換、Excel式の実行を防ぐ。
算出済みの安全な数値指標は数値セル、真偽値は真偽値セルにする。入力テキストにXMLに不適切な制御文字が含まれる場合は出力全体を拒否する。
未提出や履歴不整合は既存 `Map_States` の `UNAVAILABLE` / `reason` / 空のstateを維持する。

`System_Events` / `Researcher_Events` は当該実施所属Sessionに記録されたイベントだけであり、実施全体の独立した管理監査表や今回のダウンロード監査結果は含まない。
実施にSessionが0件なら無条件に全イベントを抽出しない。共通イベントの出力とSession出力はDBスナップショットを合わせるが、別リクエストで作成された既存CSVとのイベント件数は保存時点の差で異なり得る。

## 検証

- `npm run test:research-workbook --prefix backend` はDB接続なしの合成単体テスト。
- `test:experiment-research` は隔離模擬DBのみでAPI認可（401/403）、XLSX署名・MIME、既存JSON/CSVを照合する。
- 模擬DB外で研究suite・migration・reset・cleanupを実行しない。既存研究データ、`.local/`、検証結果JSONには触れない。
