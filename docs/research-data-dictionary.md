# 研究イベントの統合データ辞書・検証案内

この辞書は開発・模擬データ用の記録を説明する。本番研究データの安全性・完全性や学習効果を保証しない。出力列の完全な辞書は [生成サンプルの列定義](samples/event-export/data-dictionary.md)、イベントごとの定義・契機は [共通スキーマ仕様](research-events-v1.md)、各種別の検証対応は [自動照合する40種別の表](research-event-test-matrix.md) を正本とする。

## 形式とバージョン

|形式|意味・状態|検証|
|---|---|---|
|旧map_operation_logs|schemaVersionなし。操作payloadは旧契約。actor/outcome等が未保存ならUNKNOWNのまま。legacy:UUIDは出力での参照名で、元行を書き換えない。|旧・新混在、Undo/Redo、境界・欠測・所有者不一致。未知の旧文字列を新イベントへ再解釈しない。|
|イベントv1|数値限定before/after、固定numeric details。現行の動画・画面等の申告観測と活動開始完了のサーバー処理。語彙の後方互換検証が通っても、任意クライアントにその操作を許可する意味ではない。|既存39語彙（追加MOVE_LINKはv5専用）の型・結果・未知/機密フィールド拒否、収集許可subsetと認可。|
|イベントv2|snapshotVersion=1のMap状態。Concept、Link、統合、Kit/Provenance。Map変更・記録は同一トランザクション。|追加/削除/編集/移動/再接続/統合/Kit/Undo/Redo/通常・自動提出、失敗rollback。|
|イベントv3|設問IDと確定回答の前後。1文字ごとの入力を記録しない。同値の保存は編集イベントなし。|事前/事後、必須回答、対象設問、提出、原子性、履歴Export。|
|イベントv4|研究者・システム監査。before/afterなし、detailsは空。回答・出力本文・例外を格納しない。|全対応語彙×全outcomeのDB契約検証と実API監査。契約fixtureは実操作の発生を意味しない。|
|イベントv5|v2必須項目を保ったMap状態にLinkのlabelPositionX/Yを追加。新しいStage 1確定操作。未割当は両省略=自動配置で、旧表示位置を推定しない。|3種類の実API位置保存/再読込/Undo/Redo/削除Undo/原子性/認可、v2-v5混在再生。|
|イベントv6|Kit確認処理の成否と一致真偽を分離。SUCCESS+details.matched true/false、拒否/失敗は結果なし。|実APIの一致/不一致/拒否/技術失敗とJSON/CSV共通ID。|
|抽出JSON export_schema_version=2|新旧イベント集合とfilter、snapshot_at、件数、注意件数。イベントschema_versionとは別。|JSON/CSVの同じevent_id・順序・件数・時刻・結果。|
|旧Session JSON exportVersion=1/2|旧4活動/新6活動用の既存全体出力。上記抽出JSONとは別契約。|6活動完了フロー、分析、Map・評価履歴の互換性。|

v2の現在上限はラベル512文字、Concept 1000、Link 2000、各Provenance 1000、座標絶対値10000000、1状態UTF-8 JSON 4,000,000 bytes。v3回答は100,000文字。超過を黙って切り詰めず入力を拒否する。v1・旧データへ新しい意味を付けない。JSONのbefore/after全文は研究者限定で必要なときにだけ展開し、本文の非表示・超過はpayload_statusで追跡する。

## 結合キー・順序・時刻

- event_idは新イベントUUID、旧はlegacy:UUID。詳細CSVのevent_idからevents.csvへ結合する。絞り込み外の関連先は補完しない。related_event_idとrelated_legacy_operation_log_idを区別し、Undo/Redo対象は両方同時に指定しない。
- learner_idはP-UUIDで、明示的に関連付けたSessionだけ共有。人物をコード一致で推測しない。再発行で現在の投影は変わるが回答・イベントの内部FKは不変。L-UUIDは旧条件の互換入力で、現在のサンプルはP形式。内部参加者UUID/対応表は出力しない。Session/Stage/Map/設問/イベントの資源UUIDはユーザー確認済みの結合・操作キーとして維持する。
- sequence_numberはJSON/CSVでは10進文字列。新はSession保存順、Session未所属はGLOBAL、旧はMapごと。クライアント観測順（client_sequence）、端末時計、到着順、サーバー保存順を同一としない。
- 再生はMap境界の旧→新の順。通常の抽出出力もSession/stream/連番順。時系列閲覧からの出力はserver_timestamp→event_id昇順で、再生順とは異なる。固定snapshot ID+offsetの25件ページングで、生成後の追加がページへ入り込まない。
- server_timestampはDB記録時刻、client_timestampは申告時計。出力はUTCのISO 8601（Z）。入力はタイムゾーン必須、画面入力はJST。開始を含み終了を含まない[from,to)。同じ種類の複数条件はOR、種類間はAND。
- durationMs/elapsed_ms等はms、動画positionSeconds/fromSeconds/toSecondsは秒、座標はcanvas座標。時刻差によるserver_elapsed_msは保存時刻−活動開始時刻であり、実作業・注意・動画視聴時間を意味しない。負の差は整合性注意として残し勝手に0へ直さない。

## 結果・欠測・主体

|値|解釈|
|---|---|
|SUCCESS|その収集経路で成功と確定した意味。プレーヤー報告はブラウザーでの観測であり、動画を理解した証明ではない。|
|FAILURE|処理が失敗したと観測。Map更新はrollback後に失敗記録する場合があり、DB障害では失敗ログ自体が未保存の場合もある。|
|REJECTED|旧v1 FEEDBACK_CHECKでは従来契約としてKit不一致（確認APIは成功）も表す。新v6のREJECTEDは操作拒否だけ。その他は入力・権限・期限・状態等により拒否。別Session・未認証試行を対象参加者の行為として記録しない。|
|CANCELLED|サーバーが受け取った明示的な取消。現行の確定前Link作成取消経路を対象とし、API送信前のブラウザー内取消を観測済みとしない。|
|UNKNOWN|結果を確定できない。旧ログ、可視性報告等を成功や欠損へ補完しない。|
|OBSERVED|そのフィールドを観測している。観測元はserver/clientと収集経路で判断。|
|ESTIMATED|推定値。観測・確定値と区別し、学習量等へ自動変換しない。|
|MISSING|値を取得できない／保存されていない。0や空文字の実測と区別。|
|NOT_APPLICABLE|項目自体が該当しない。MISSING/UNKNOWNとは別。|

nullだけで欠測理由を判断せず、quality、outcome、reason_code、payload_status、boundary_statusを併せて読む。空detailsは「何も観測されなかった」証拠ではない。actorはLEARNER/RESEARCHER/SYSTEM、旧の未保存主体はUNKNOWN。共有研究者コードでは個人を識別できない。理由は固定コードだけで、例外・自由記述を理由欄に格納しない。

Mapの提出はMAP_SUBMIT/MAP_AUTO_SUBMITのライフサイクルイベント。v2状態は内容・Provenanceの再生用で、提出状態/提出時刻を重複格納しない。再生一致は内容の一致、提出条件は実DB状態・ライフサイクルイベントを別途検証する。

## 通信、削除、記録されないもの

DB処理の成功、イベント保存、クライアントACKは別状態。同じIdempotency-Keyの再試行は同じ結果へ結び付け、Keyなしの別試行を同一要求と推測しない。クライアントキューは観測v1のみで、Map v2・回答v3・監査v4や資格情報を投入しない。件数・容量・期限・記憶領域障害を申告し、保存receipt/欠番とは分けて表示する。

強制終了、未接続端末、無効化されたストレージ、ブラウザー外の操作、画面を離れてから送信できなかった終了、報告自体の喪失は記録できない場合がある。マウス移動、ホバー、キーストローク、無操作時間、視線、注意、理解を収集/推定しない。操作数を学習の質や有利不利の指標にしない。未報告を「欠損なし」、ACK未確認を「確定欠損」と扱わない。

明示削除後は失効資格情報で再登録を拒否し、再接続時に対象IndexedDBを消去してACKする。未接続・未知端末・ACK喪失は確認待ちが残る。取得済みファイル、バックアップ、通信済みバイト、WAL等の消去を保証しない。研究保存期限は表示だけで、自動削除しない。開発リセットは専用隔離DBのみで、通常起動に組み込まない。

## 安全性とCSV

入力の厳密な型・フィールド検証、Map/回答の共通制限、既知トークン/機密パターンの拒否または除外、研究者専用APIを維持する。通常の「パスワード」等の単語だけでは拒否しないが、未知の資格情報・個人情報の完全検出はできない。認証情報を入力しない運用が必要。

CSVはUTF-8 BOM、CRLF、RFC4180引用。文字列が空白/制御文字の後に =,+,-,@（全角含む）で始まる場合や先頭tab/改行はアポストロフィで防護する。数値型の負値は数値のまま。JSONが検証済み元テキストの参照先であり、CSVから無条件にアポストロフィを除いて式として実行しない。

## テストと代表規模

[CI構成](../.github/workflows/stage1-prototype.yml)は専用Docker DBを新規作成し、マイグレーション→リセット防護→新形式6活動→カタログ/実API/混在/復旧/再送/Export/認可/削除→ブラウザーを実行する。GitHub・研究用外部秘密情報は不要。実行結果は集計JSONのみを保存し、生のイベント/資格情報はartifactへ出さない。

20模擬Sessionに各200イベント（計4000）を用意し、実HTTP検索・25件ページング・JSON/CSVを測る。SQLで生成したfixtureであり収集速度や20台同時ブラウザーの性能テストではない。環境・所要時間・件数・サイズはissue13-scale-results.json。単一開発PCの結果から本番性能を保証しない。詳細テスト結果はissue13-suite-results.jsonとissue13-results.json。

## 今回の代表計測（Windowsローカル）

20 Session / 4,000イベント、25件×160ページ。最終計測の出力準備は約9.11秒、ページ中央値約10.5ms、95パーセンタイル約13.7ms、JSON/共通CSV取得・照合約0.35秒。Windows 10.0.26300、Node 24.15.0、PostgreSQL 17.11、Ryzen 7 7730U（16論理CPU、約14.9GB RAM）。抽出前の模擬DB全体は92 Session / 新14796イベント / 旧10ログ（互換テストfixtureを含む）。対象はそのうち20 Sessionの4000イベントで、20ブラウザー同時操作ではない。fixture生成約1.47秒は検索時間に含めない。本番性能・遅延上限・学習記録の欠損率を保証する計測ではない。

DBを使用する検証は単独起動時も専用Docker manifestとDB内ガードの照合を要求する。旧Issueごとの固定ポート・DB名だけの許可は廃止し、来歴不明のDBへの誤接続を防ぐ。問題設定全体の監査など単一対象がないイベントのtarget_idはnullで、Session/Stage関連から範囲を読む。

再起動結合検証は各要求をConnection: closeで行い、終了済みプロセスへのKeep-Alive再利用を避ける。これは本番の接続復旧保証ではなく、操作APIの同一キー再試行・保存整合性を測るためのテスト条件である。実ブラウザーの未送信・ACK喪失・再送・オフラインは別のIndexedDB検証で確認する。

v1にMap操作の語彙があっても、数値状態をv2の完全状態や旧Mapスナップショットと再解釈しない。混在Map再生で採用する新ストリームはv2だけで、v1のMap語彙は共通イベントの数値契約・出力互換として扱う。MAP_SAVEは予約語で、現在は各編集APIの確定イベントが保存を表し、独立した保存ボタンの収集経路はない。欠如を未保存と推測しない。


## 親Issue #2監査で明確にした境界（2026-10-30更新）

新しいFEEDBACK_CHECKはv6。確認処理成功と一致結果をSUCCESS/feedback_match（JSON details.matched）で分ける。不一致falseを拒否や技術失敗にしない。旧v1のREJECTEDは既存の不一致のまま保存し、旧形式と分かる表示にする。結果を記録できなかった場合のnullをfalseへ補完しない。共通CSV末尾にfeedback_matchを追加したため抽出JSON/manifestの出力形式をv2とし、既存共通列の意味・順序やSession生データexportVersionを維持する。

Link文字ドラッグはStage 1の3種類でv5 MOVE_LINKとして保存・再生・Undo/Redoへ接続。座標はcanvas座標（画面上の拡大後pixelではない）。Linkの向き・接続先・Kit判定を変更しない。未割当の旧Linkは両NULL/状態キー省略=自動配置。最初の変更前に固定座標が存在したと捏造しない。位置APIと全Map更新は同じMapロック/完全状態検証/トランザクションを使う。

所有者不明の旧下書きは自動復元/移行を止め、本文なしで件数だけを研究者へ示す。安全な個別識別ができないため削除保留。新しいSession別下書きの消去、HTTP LAN対応、未接続確認待ちは維持する。平文保護・未知秘密の検出・全端末消去の限界は解消と扱わない。

前回の実行値はparent-audit-*.jsonのまま保持し、今回の変更・検証は [監査残課題対応](parent-followup.md) とparent-followup-*.jsonへ記録する。以前の報告を今回の結果として再利用しない。


2026-10-31追補（179104）: Map操作の再試行キーはeventIdではない。失敗・拒否の監査行を保持したまま同じキーで成功を保存できるため、キーから成功を推測しない。JSON/CSVの結合は従来どおりevent_idを使い、outcome別の行と保存順序を保つ。同じ結果区分の重複要求は1件へ集約され、監査件数は全試行回数ではない。CSV列・出力schemaVersion・40イベント語彙の変更はない。
