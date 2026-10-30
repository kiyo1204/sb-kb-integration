# 絞り込み研究イベント出力 v2（Issue #9）

## 既存出力との関係

既存のSession生データJSON（exportVersion 1/2）、操作・評価・振り返り・特徴量CSVは維持する。新しいイベント出力は別のAPI/形式であり、既存の列やschemaVersion 1〜4、旧ログを変換・削除しない。CSVセルの式対策だけは既存CSVにも共通適用する。

研究者トップ、Session画面、分析画面の「研究イベントを絞り込み出力」から開く。旧4活動・新6活動と、学習中/完了済みを含む。既存の完了済みSession生データ出力条件は変更しない。

## 抽出・スナップショット

`POST /api/research/event-exports` の本文は `{ "filters": { ... } }` のみ。許可されるフィルターは次の通り。未知フィールド、配列以外、上限100件超、未知のコード、不正UUID/日時は400で拒否し、入力値を応答・監査へエコーしない。

|条件|値|動作|
|---|---|---|
|sessionIds|Session UUIDの配列|同一条件内はOR|
|learnerIds|P-UUID（L-SessionUUIDも互換入力として許可）の配列|同一条件内はOR|
|groups|EXPERIMENTAL / CONTROL / UNASSIGNED|UNASSIGNEDは群がnullの旧Session・未所属監査|
|activities|LESSON / PRIOR_MAP / KB_MAP / PRE_ASSESSMENT / INTEGRATION_MAP / SELF_STUDY / POST_ASSESSMENT / UNASSIGNED|UNASSIGNEDは活動null|
|eventTypes|共通カタログの固定イベント名|カタログ取得はGET /api/research/event-exports/catalog|
|from / to|タイムゾーン付きISO 8601またはnull|server_timestamp >= from かつ < to|

異なる条件はAND。省略/空配列/nullの期間境界は無制限。期間は開始以上・終了未満 `[from,to)`、両方指定した場合はfrom < to必須。Zまたは明示した時差を必須とし、UTCのミリ秒付きISO 8601へ正規化する。研究者画面の日付入力はブラウザーOS設定に依存せず日本時間+09:00として送る。Session/仮名ID条件はSession未所属の監査を除く。条件に一致しない場合も成功し、イベント0件JSON・ヘッダーだけのCSVを生成する。

抽出API自体には追加スキーマ変更は不要。Issue #11以降は分離された対応表のP-UUIDを現在の仮名として投影する。明示的に関連付けたSession間だけを共有し、再発行でもイベント・回答の内部FKは変えない。L-SessionUUIDは旧条件の互換入力として維持する。内部参加者UUID・対応表・元のparticipant_code・認証用の値は新出力へ含めない。保存期限・明示削除の詳細は research-data-management.md を参照。

1回のPOSTで、READ ONLY / REPEATABLE READの同じDBスナップショットからサーバー側SQLで絞り込む。カーソルから2件ずつ取得し、**1つのイベントをJSONと該当CSVへ同時に書く**。生成中の追加記録はその出力へ途中から入らない。POSTはexportId、snapshotAt、expiresAt、eventCount、ファイルごとの件数/bytes、注意件数、auditSavedを返す。

`GET /api/research/event-exports/:exportId/:file` で生成済みの同じファイルを取得する。JSON/CSVの個別取得でもZIP一括でも同じexportIdの集合・順序・本文を使う。条件が同じでも別のPOSTで生成したexportIdは、後から追加されたイベントを含む場合がある。比較時はexportIdとsnapshotAtを確認する。

## ファイルと共通参照

- events.json：export_schema_version=1、元のschema_version、before/after/detailsを保持する詳細JSON。
- events.csv：1行1イベント。
- map_operations.csv：MAP / CONCEPT / LINK対象。
- activity_times.csv：活動開始・完了・期限、可視性、動画、フィードバックの時間情報。
- assessment_events.csv：回答・提出・研究者の問題設定を元の版/種別で区別。
- system_events.csv：SYSTEM主体。
- researcher_events.csv：RESEARCHER主体。
- data-dictionary.md：全列、型、値、空値、時刻、注意点。
- manifest.json：集合・件数・ファイル情報。
- bundle.zip：上記全ファイルを1つにまとめる。

全CSVの先頭は同じ共通列。用途別の各行はevent_idでevents.csvの**ちょうど1行**へ結合でき、Session・仮名ID・群・活動・日時・outcomeも同じ値となる。1イベントが複数の用途別CSVに入るため、用途別件数の合計を総数としない。manifestは自分自身とZIPのサイズを再帰的に含めず、HTTPのファイル一覧にはそれらも追加する。

列定義は[データ辞書](samples/event-export/data-dictionary.md)。実データを含まない[JSON](samples/event-export/events.json)、[共通CSV](samples/event-export/events.csv)、[各用途別CSV](samples/event-export/)を追加した。`npm run samples:event-export` でDBや認証情報を使わず再生成でき、`test:event-export-samples` が件数・参照・時刻・outcomeとファイルの一致を確認する。

## 旧ログ、新形式、欠測の意味

旧map_operation_logsは `source_format=LEGACY`、schema_versionはnull、event_idは `legacy:元UUID`。旧ログの元IDや順序を変換・DB移行しない。主体・結果・品質は未記録のためUNKNOWNとし、ログの存在だけでSUCCESSやLEARNERと推測しない。旧ログのSession/活動/群は関連する現在のSession/Stageから得た文脈で、過去の属性を証明するものではない。

並びはSession UUID昇順（未所属は最後）、旧ログ→新形式。旧ログ内はMap UUID→Map連番→ID、新形式内はSession/Global連番→ID。旧ログの時計が新形式より後でも境界順を逆転させない。sequence_scopeでMAP/SESSION/GLOBALを区別し、統一した架空連番を発行しない。

保存済みのlegacy_boundary_count/last_idと境界側を出力する。欠けた境界や境界後の旧追記は注意として残す。これだけで完全再生成功を証明せず、既存の混在履歴APIで照合する。絞り込み外の関連イベントは追加しないため、関連先がファイル外を指す場合や、出力単独で履歴再生できない場合がある。

未観測の終了、欠測、UNKNOWN、NOT_APPLICABLE、CANCELLED、FAILURE、REJECTED、ESTIMATEDを補完・統合しない。before_quality/after_quality等をそのまま保持する。payload_statusは元データの品質とは別で、本文なし・検証不能/非公開・上限超過を明示する。NO_PAYLOADはbefore/after/detailsがないという意味で、イベント自体が未観測という意味ではない。

活動時間CSVのserver_elapsed_msは保存済みサーバー時刻とStage DB開始時刻の差。遅延再送も含むので実作業/視聴/中断時間とは扱わない。負値を0へ丸めず、欠測や順序不整合を示す。durationMs等は元にある値だけを出し、測定主体や正確性を推測しない。前後のイベントがフィルターで欠けても継続時間を自動補完しない。

## 認可・内容・CSV対策

POST/GET/DELETE/catalogの全てで研究者権限をサーバー側検証する。現行の共有研究者コードは全研究Sessionへアクセスでき、個人研究者識別・研究者ごとのSession割当はない。学習者はexportIdやURLを知っても取得できない。認証情報は既存のAuthorizationヘッダーだけに使い、URL・出力・監査本文には入れない。

列を明示的に投影し、任意JSONを出力しない。v1の数値状態、v2のMap、v3の回答を既存のバージョン別契約で検証する。旧スナップショットは既知フィールド・型・ラベル・UUID参照を検証する。既知の研究者コード/学習者コードとの一致も確認し、不正/機微/未対応の本文は省略してpayload_statusへ残す。状態はSQL上の安全な受信上限8MBを超えれば取得せず、取得後も契約上のJSON実サイズ4MBを検証する（PostgreSQLが加える区切り空白で正当な状態を除外しない）。64KBを超えるdetailsも取得しない。上限超過はOVERSIZEとし、黙ってイベントを欠落させない。

自由記述は研究に必要な本文として研究者だけが取得できる。未知の秘密情報や個人情報を完全検出するものではなく、原データの精査・保存管理を代替しない。旧形式の生データ出力への遡及的な機微情報修復はこの作業では行わない。現行LANは引き続き開発・模擬データ専用である。

CSVセルの処理は新旧出力で共通化した。テキストが先頭の空白/制御文字/書式文字の後に =,+,-,@（全角を含む）で始まる、またはタブ/改行で始まる場合、アポストロフィを付ける。数値型の負数は数値のまま。JSONは検証済みの元テキストを保持する。CSVから厳密に元テキストを復元する際はJSONを参照し、アポストロフィを無条件に除去しない。全CSVはUTF-8 BOM、CRLF、引用符エスケープを統一する。

出力準備の確定結果だけをRESEARCH_EXPORT/v4として1回記録する。個別ファイルやZIPの再取得で同じ出力を二重記録しない。監査はスナップショット取得後に保存するため、その出力自身の監査イベントを抽出へ後付けしない。監査に回答・出力本文・条件の自由入力・例外本文を入れない。auditSaved/HTTPヘッダーは準備操作の監査結果であり、ブラウザーで保存が完了した保証ではない。監査失敗でも出力成功と区別して表示する。アーカイブ内manifestのauditSaved=nullは、準備後の監査結果を後付けしないためである。

## 大量データと一時ファイル

専用の読出用DBプールは最大2接続、接続待ちは5秒。SQL条件の適用・DBカーソル取得とファイルへの逐次書込みを使い、全イベントやZIPをサーバーの配列/Bufferへ読み込まない。1出力の生成本文は最大256MiB、ZIPも最大256MiB、抽出/圧縮の処理期限は2分、SQLは各30秒、保持ジョブは最大4件。上限を超えた場合は全体を失敗させて途中ファイルを除き、条件を絞る/前の一時出力を削除する案内を返す。件数で黙って打ち切らない。ブラウザーのダウンロードは既存のBlob方式で、この上限内のメモリを使う。

ファイルはOSの一時領域 stage1-event-export-cache のUUIDディレクトリだけに生成し、可能なOSではディレクトリ700・ファイル600とする。静的公開ディレクトリへ置かず、取得APIでも認可する。暗号化保管の機能ではない。本文生成時に確定する15分の有効期限（圧縮時間を含む）、1分周期の回収、研究者の明示削除を設け、DBの元データは削除しない。ダウンロード中のファイルは終了まで保持する。API再起動後は古いexportIdで取得できず、残ファイルは次の起動/回収時に20分以上経過したものだけを削除する。異常停止・OS/ディスク障害時の即時削除は保証しない。

## 検証

今回の変更にDBマイグレーションは追加していない。既存DBには接続せず、専用の使い捨てDBに既存マイグレーションを準備用として適用し、模擬データだけで検証する。

- `test:event-export`: v1〜v4・旧ログ、各絞り込みとAND/OR、境界・空結果・UTC、全CSV参照/件数/時刻/outcome、ZIPの一致、秘密情報/不正本文・式対策・認可、上限・期限・ダウンロード中の削除、3,000件と生成中の追加記録のスナップショット分離。
- `test:event-export-samples`: DBを読まず、サンプルの識別子・件数・時刻・結果・Map/Stageの所有関係とファイル生成の一致。
- frontend `test:event-export-browser`: 実Edgeと隔離APIで、画面の条件指定・JST変換・JSON/ZIP取得・一時出力削除・学習者への非表示。
- 既存Stage 1、Undo/Redo、混在履歴、Map/活動/評価/監査、Export、型検査・Lint・ビルドを再確認する。

結果・未確認事項はissue9-results.json、既存差分の確認はissue9-preservation.jsonを参照。

## Issue #10との共通条件

`outcomes` 配列も指定できる（SUCCESS/FAILURE/REJECTED/CANCELLED/UNKNOWN）。未指定・空配列は無制限。閲覧検索 `/api/research/event-views` から生成したJSON/CSVはサーバー時刻→イベントID順で、一覧と同一スナップショットになる。通常の出力APIは従来の旧→新ストリーム順を維持する。


## 2026-10-30追補: v5/v6とfeedback_match

抽出出力export_schema_version / exportSchemaVersion=2。共通CSV末尾にfeedback_match（boolean、true/false、結果なしは空セル）を追加し、JSONでは同名の真偽値/nullを持つ。旧共通列の意味・順序と既存Session全体JSON exportVersion 1/2は維持する。全用途別CSVにも共通列があるため同じevent_idで結合可能。v5のLink座標はMap操作CSVのbefore_json/after_json、v6の一致結果はJSON details.matchedと共通feedback_matchで確認する。

v6は処理が返った一致/不一致をともにSUCCESSで出す。一致=falseとREJECTEDを混同しない。REJECTED/FAILUREに結果を補完しない。旧v1のFEEDBACK_CHECK/REJECTEDは不一致という過去契約を保持し、feedback_matchはnullのまま。結果フィルターSUCCESSはv6の不一致も含む。過去のCSV列数を前提にした利用者は形式v2と列名を確認すること。旧出力ファイルを変換・削除しない。

生成サンプルは17イベント、9ファイル（JSON、共通CSV、用途別5CSV、manifest、辞書）。40種カタログの全てがサンプルで発生可能だとは示さず、契約テストと実APIテストを分ける。
