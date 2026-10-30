# 研究イベントの時系列閲覧（Issue #10）

研究者トップの「研究イベントの時系列ログ」から `/research/events` を開く。研究者専用。画面・一覧API・詳細API・出力APIのそれぞれで研究者認可を要求する。

## 条件と出力

Issue #9 の `parseFilters` / `extractionQuery` / `normaliseEvent` を共用する。sessionIds、learnerIds（現在のP-UUID、L-SessionUUIDは旧条件の互換入力）、groups、activities、eventTypes、from/to に outcomes（SUCCESS、FAILURE、REJECTED、CANCELLED、UNKNOWN）を追加した。省略・空配列は制限なし。同じ条件内はOR、条件間はAND。開始を含み終了を含まない。入力はJST、保存日時はUTCのISO 8601。旧ログの結果はUNKNOWNのまま、成功と推測しない。既存の出力でも同じ結果フィルターを利用できる。

検索POST `/api/research/event-views` は `{filters}` を受け、Issue #9 と同じ一時出力のID・件数・期限・条件を返す。REPEATABLE READの同じスナップショットから安全な一覧用データとJSON/CSVを生成する。生成後のイベントは次の検索まで含めない。検索条件を編集しても検索を実行するまでは前回結果・前回出力のまま。ダウンロードは既存 `/api/research/event-exports/:exportId/:file` を使う。別の条件で再抽出しない。既存出力の旧・新ストリーム順は維持し、閲覧検索からの出力のみ時系列順になる。検索準備操作は既存RESEARCH_EXPORT監査として記録し、クリックした個々の行を新たな分析操作として記録しない。

## ページ・詳細

`GET /api/research/event-views/:exportId?offset=0` は最大25件、次offsetまたはnullを返す。カーソルはランダムなスナップショットIDと整数offsetの組。固定ファイルの位置なので並行追加・時刻の同値でページが移動しない。順序はサーバー保存時刻昇順、同値はevent_idの文字列順。これは履歴再生順とは異なる。旧ログIDはlegacy:を保つ。`detail=1` は指定位置の1件を返す。一覧にはbefore/after/detailsを含めず、詳細だけに検証済み状態を含める。未知query/不正offsetは400、期限切れ・不明IDは404、通信障害は503。

一時NDJSONとバイト位置索引はサーバー内のみ。ZIPや個別出力ファイルに追加しない。各イベントの読み出しは個別に行い全結果をUIへ返さない。Issue #9の容量・同時数・15分TTL・削除時のreader保護・再起動後の無効化を共有する（検索前に全抽出を準備するため、初回の待機時間・120秒上限も共有する）。索引のメモリはイベント数に比例する。プロセス再起動・期限切れは再検索が必要。DBスキーマ変更なし。

## 注意の根拠

payload_status、before_quality、after_quality、boundary_statusとoutcomeを別々に表示する。非表示や未確認を確定欠損としない。詳細の関連IDは保持し、条件外の親イベントが結果にない場合も補完しない。大きな状態は折りたたみ、上限・秘密情報除外はIssue #9と同じサーバー検証を通す。

選択イベントのセッションについてIssue #8の `ResearchDeliveryStatus` を再利用し、15秒ごとに最新状態を取得する。ブラウザー最終申告（送信待ち・再送・ACK・復旧不能理由と受信日時）とサーバーreceipt数・欠番を分ける。ACKは申告であってイベント固有の証明ではない。再送後の保存確認は最新ACKとreceiptから判断できる範囲のみ示し、観測していない復旧経緯は作らない。報告なしや古い報告から欠損なしと推定しない。通信注意はセッション全体の現在情報で、検索時点の個別イベント状態とは異なる。

## 検証

既存 `test:event-export` にHTTP検索→3000件の全ページ→詳細→JSONのID・順序・前後状態一致、結果条件、学習者403/未認証401、不正カーソル400/削除後404を追加した。既存の出力・秘匿検証も維持する。実DB検証は新規の隔離DBだけを使用する。


親Issue #2監査: FEEDBACK_CHECKのREJECTEDは既存契約のKit不一致で、確認APIの通信失敗とは区別する。一覧は「不一致（確認完了）」、検索の結果条件は「拒否・Kit不一致」と表示し、出力のoutcome値は維持する。詳細は[研究データ辞書](research-data-dictionary.md#親issue-2監査で明確にした境界)。


2026-10-30追補: 新v6はSUCCESSとfeedback_matchで「一致/不一致（確認完了）」を表示する。REJECTEDは「拒否」、FAILUREは「失敗」。旧v1/REJECTEDは「不一致（旧形式・確認完了）」として区別し保存行を変更しない。MOVE_LINKはLinkの位置変更として検索・詳細・Map比較に含む。抽出形式v2の追加列は[出力仕様](research-event-export.md)を参照。
