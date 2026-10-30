> 2026-10-30追補: 新しいStage 1 Map確定操作はv5、Kit確認結果はv6。v1〜v4と旧履歴の意味を維持する。現在の追加契約と確認結果は [監査残課題対応](parent-followup.md) を参照。

> 統合先の現在仕様・競合解消・結合検証結果は [研究イベント統合記録](research-event-integration.md) を参照。以下のIssue別節には元ブランチ時点の制約・統合注意も履歴として残す。

# 研究イベント仕様 v1（Issue #3）

本基盤は追加方式。保存済みv2を保持し、現在のStage 1のマップ操作はv5イベントとして収集し、履歴照合とUndo/Redoでは旧ログと連結する。研究者向け分析・既存出力にも混在履歴を含める。開発・模擬データ用であり実研究向けの安全性は別途確認する。名称は `対象_操作` または既存操作名とし、実行結果は eventType ではなく outcome に入れる。登録成功は操作成功を意味しない。

## 共通フィールド

`eventId` はサーバー生成 UUID、`schemaVersion` は 1。`sessionId`、`stageId`、`mapId` は所有関係をサーバーが検証し、mapId があれば対応する stageId を導出する。`participantCode` と `studyGroup` は Session から取得した記録時点の値（旧形式の群は null）。`activity` は紐付いた活動の種別で、活動がない場合 null。`actorType` は LEARNER / RESEARCHER / SYSTEM、外部 API では認証済み主体から決定する。共有研究者コードのため研究者個人は識別できない。SYSTEM はサーバー内部の登録のみ。

`eventType` と `targetType` は下表。`targetId` は UUID（SESSION/STAGE/MAP は省略時に関連IDを補う）。`outcome` は SUCCESS / FAILURE / REJECTED / CANCELLED / UNKNOWN。`reasonCode` は NOT_APPLICABLE / UNKNOWN / VALIDATION / PERMISSION / DEADLINE / CONFLICT / NETWORK / SERVER / USER_CANCELLED / OTHER、任意、文字列説明や例外は受け取らない。省略は **未記録**、NOT_APPLICABLE は理由が該当しない、UNKNOWN は確認したが不明。`relatedEventId` は同一 Session の先行イベントに限る。UUID を秘密情報の格納先として使わない。

`sequenceNumber` は同一 Session の保存確定順を表す10進文字列（bigint）、mapId で絞れば同一マップの順序が分かる。専用カウンターの行更新と挿入を同じトランザクションで行い、同時登録時も重複せず、ロールバックでは進まない。発生順、クライアント送信順、旧ログ sequence とは限らない。`serverTimestamp` はDB挿入時刻、`clientTimestamp` は申告値で信頼できる時計とみなさない。`clientTimeQuality` は OBSERVED / ESTIMATED（時刻必須）と MISSING（未取得）/ NOT_APPLICABLE（該当しない）/ UNKNOWN（不明）（時刻禁止）を区別。推定値は観測値として扱わない。

`before` / `after` は `beforeQuality` / `afterQuality` により OBSERVED（観測）・ESTIMATED（推定）・MISSING（欠測）・NOT_APPLICABLE（該当なし）・UNKNOWN（不明）を区別する。値がある場合の既定は OBSERVED、ない場合の既定は MISSING。値なしの理由は品質欄で明示し、null だけから判断しない。v1の登録口は `positionX` / `positionY` の有限数値だけを受け付ける。`details` は `durationMs`、`positionSeconds`、`fromSeconds`、`toSeconds` の非負有限数値のみを受け付け、省略時は空オブジェクト。個々の詳細項目の欠測理由やテキストの詳細スキーマは後続Issueで追加設計する。空オブジェクトと未記録を同一視しない。自由記述・ラベル・認証情報・URL・ヘッダー・エラー本文を受け入れない。入力は未知フィールドを拒否し、認証情報、コード、トークン、Cookie、パスワードを記録・出力しない。参加者コードは既存の研究用仮名コードであり、認証情報を入れない運用が必要。登録時に現在の研究者コードや登録済み学習者コードと完全一致する参加者コードは拒否するが、未知の秘密情報まで検出できるものではない。今後、テキスト等を収集する際は認証情報の混入防止とアクセス制御を別途設計し、スキーマを拡張する。

保存APIの `logSaved: true` はイベント行がコミットされたことのみを示す。エラー時の `logSaved: false` は操作が失敗したことを意味しない。通信断では保存結果も不明。再送・重複防止・欠損検知は #8。イベントが存在しないことから操作がなかったと推測しない。

## イベントカタログ

共通必須項目は schemaVersion、sessionId（URL）、eventType、targetType、outcome、clientTimeQuality。対象の Stage / Map に紐づくものは stageId / mapId が必要。Concept / Link のv1記録とv2の成功操作では mapId と targetId を使う。確定対象のないv2失敗・拒否・取消では targetId を省略できる。対象の特定、before/after、reasonCode、relatedEventId は判明する場合に追加する。各イベントは実行後の結果を一件に表し、失敗・拒否・取消も同じ eventType の異なる outcome で表す。未実装の記録契機は後続Issueが担当する。

| eventType | 対象 | 記録契機 |
|---|---|---|
| SESSION_CREATE / SESSION_START / SESSION_COMPLETE | SESSION | Session作成・開始・完了の結果 |
| SESSION_SETTINGS_CHANGE | SESSION | 研究者による設定変更の確定結果 |
| STAGE_DEADLINE | STAGE | サーバー時計による期限到達の観測（完了・提出ではない） |
| STAGE_START / STAGE_COMPLETE / STAGE_PAUSE / STAGE_RESUME | STAGE | 活動開始・完了・中断・再開の結果 |
| SCREEN_ENTER / SCREEN_LEAVE | SCREEN | 画面への移動・離脱を観測した時 |
| VIDEO_PLAY / VIDEO_PAUSE / VIDEO_SEEK / VIDEO_COMPLETE | VIDEO | 再生・停止・位置移動・再生完了を観測した時 |
| ADD_CONCEPT / EDIT_CONCEPT / MOVE_CONCEPT / DELETE_CONCEPT / MERGE_CONCEPT | CONCEPT | 追加・編集確定・移動確定・削除・統合の結果 |
| IMPORT_KIT_CONCEPT | CONCEPT | Kit概念を取り込んだ結果 |
| ADD_LINK / EDIT_LINK / DELETE_LINK / RECONNECT_LINK | LINK | 関係の追加・編集確定・削除・再接続の結果。未接続Linkの明示的取消を含む |
| IMPORT_KIT_LINK | LINK | Kit関係を接続・取込みした結果。未接続Kit Linkの明示的取消を含む |
| UNDO / REDO | MAP | 操作の取り消し・やり直し結果。対象に応じて relatedEventId または relatedLegacyOperationLogId で関連付ける |
| MAP_SAVE / MAP_SUBMIT / MAP_AUTO_SUBMIT | MAP | 保存・提出・サーバー自動提出の結果 |
| MAP_KIT_ASSIGN | MAP | Kitの割当変更の結果 |
| FEEDBACK_CHECK / FEEDBACK_DISPLAY | FEEDBACK | 一致確認の結果・画面表示時 |
| ASSESSMENT_EDIT / ASSESSMENT_SUBMIT | ASSESSMENT | 回答編集の確定・提出結果 |
| RESEARCH_ANALYSIS_VIEW / RESEARCH_EXPORT | SESSION | 研究者の分析画面閲覧・出力結果 |
| RESEARCH_ASSESSMENT_CHANGE | ASSESSMENT | 研究者による問題設定変更の結果 |

マウス軌跡、ホバー、1文字ごとの入力、無操作の推測は対象外。上記は収集予定の語彙であり、現在の実装がすべての契機を記録しているという意味ではない。成功以外には可能な範囲で reasonCode を付ける。before/after のないレコードは再生可能とは限らない。

## APIと認可

`POST /api/sessions/:sessionId/events` は `schemaVersion: 1` と上記項目を受け取り、201 で `eventId`, `sequenceNumber`, `logSaved` を返す。詳細は上記の数値だけを受け付け、任意文字列・認証情報・participantCode・studyGroup・actorType は受け付けない。学習者は自分の Session のみ、マップ指定時は既存のマップ閲覧認可も必要。学習者によるMAP / CONCEPT / LINK対象のイベント登録は拒否し、マップ履歴にクライアント申告を混入させない。研究者・システム専用イベントを学習者は登録できない。登録イベントはクライアント申告であり、事実の保証にはならない。システム主体はサーバーの `insertResearchEvent` を既存トランザクション内で呼び出す。Map編集のサーバー側収集は接続済み。

`GET /api/research/sessions/:sessionId/events?after=<sequence>` は研究者専用、順序昇順で最大200件。次ページは最後の sequenceNumber を after に指定。学習者は自他のイベント一覧を取得できない。認可不能な Session / Stage / Map / relatedEvent は 404。時刻・状態を省略した場合の解釈は上記のとおり。保存失敗の応答を記録成功と取り違えない。

## バージョンと旧ログ

v1の入力や意味を破壊する変更は新しい schemaVersion とマイグレーションを用い、旧行を再解釈しない。新しい安全な details / before / after はイベント別にキー・型・欠測・機微情報の扱いを確定し、検証器とDB制約、互換性、テスト、カタログを一緒に更新する。新しい意味のあるイベントの追加は既存名を再利用しない。

旧 `map_operation_logs` は `index.ts` の Map 操作と Undo/Redo、`map-history.ts`、`stage1-analysis.ts` の再生・評価・メモ参照、`research-export.ts` および CSV と分析に使われる。旧ログには上記の Concept / Link / Kit / UNDO / REDO 13種が記録され、Map 編集開始時スナップショットと組み合わせて再生する。新イベントへの二重書き・移行・削除・リセットはしない。#4 で収集と新形式の再生を、#9/#10 で出力・閲覧を、#12 で安全な切替と開発用リセットを扱う。互換性検証と対象の明示なしに旧ログやスナップショットを削除してはならない。




## マップ状態の追加契約 v2

v1は変更しない。`schemaVersion: 2` はマップ操作に限る。`snapshotVersion: 1` の `MapHistorySnapshot` と同じ完全なマップ状態を `before` / `after` に保持し、複数の変更を同時に表現する。形式は `{snapshotVersion, mapId, mapType, basedOnMapId, kitDefinitionId, concepts, links}` のみ。mapTypeは PRIOR / KB / INTEGRATION。各 Concept は `{id, mapId, label, positionX, positionY, mergedIntoConceptId, provenance}`、各 Link は `{id, mapId, label, sourceConceptId, targetConceptId, provenance}`。Provenance は `{id, targetConceptId, sourceConceptId, relationType, createdAt}` または `{id, targetLinkId, sourceLinkId, relationType, createdAt}`。概念の relationType は CLONED_FROM / IMPORTED_FROM / MERGED_FROM、リンクは CLONED_FROM / IMPORTED_FROM / RECONSTRUCTED_FROM。Kit由来は kitDefinitionId と provenance の source ID で表す。source は別マップの場合があるため、スナップショット内の存在を要求しない。UUIDの構文は検証するが、source IDのDB上の実在・由来の正しさは検証しない。

未知の項目は拒否する。IDはUUID、対象mapIdは外側のmapIdと一致、対象先は対応エンティティIDと一致する必要がある。概念の統合先とリンク両端は同じ状態内に存在する。重複した概念・リンク・同じ所有者のProvenance IDは拒否する。日時はタイムゾーン付きISO形式、座標は絶対値10000000以下の有限数、Concept最大1000件、Link最大2000件、各Provenance最大1000件、各状態のJSONはUTF-8で4000000バイト以内。各ラベルは空白のみ不可、最大512 UTF-16コード単位、制御文字不可。HTTP登録はExpress既定のリクエストサイズ上限（100KB）も受ける。Stage 1の更新では同一トランザクション内で更新前後の状態を検証し、上限超過を拒否してMap更新もロールバックする。更新前から上限外の場合も変更を拒否し、データを切り詰めない。

全v2イベントにはmapIdが必要。成功時には before と after 両方が必須で、mapTypeとbasedOnMapIdは両者で一致させる。kitDefinitionIdはMAP_KIT_ASSIGNでのみ変更できる。ADD_CONCEPT / IMPORT_KIT_CONCEPT / MERGE_CONCEPT と ADD_LINK / IMPORT_KIT_LINK は対象IDがbeforeに存在せずafterに存在する。DELETE_CONCEPT / DELETE_LINK は逆。EDIT_CONCEPT / MOVE_CONCEPT / EDIT_LINK / RECONNECT_LINK は対象が両方に存在する。UNDO / REDO は両状態と対象の旧ログまたは新イベントへの参照を要する。MAP_SAVE / MAP_SUBMIT / MAP_AUTO_SUBMIT は両状態を持つ。失敗・拒否・取消・不明では状態省略を許すが、状態を渡す場合は同じ検証を行う。各イベントの適用時には直前状態とbeforeの一致を検証する。状態を全体として扱うため、概念削除に伴うリンク削除、統合での複数概念・リンク変更も表現できる。各品質欄の意味はv1と同じ。スナップショットに提出状態・提出時刻は含まれず、提出イベントの種別と時刻から記録を確認する。

自由なJSON、ヘッダー、URL、エラー本文、認証情報の専用欄はない。ラベルには研究に必要な文字列のみを許し、URL、認証情報の値を伴うキー表記、Bearer認証、英小文字・英大文字・数字を含む32文字以上のトークン状文字列を拒否する。単語だけの「password」「パスワード」は拒否しない。現在の研究者コードと一致または包含する文字列、登録済み学習者コードに一致する文字列も登録時に拒否する。これは既知の漏えい形式を減らす対策であり、任意のテキスト中の未知のパスワード・個人情報を完全に識別できる保証ではない。研究実施前にはデータ収集と入力内容の運用・倫理審査が必要。拒否は無言の伏字化を行わず失敗とし、状態の再生可能性を誤認させない。上記の禁止条件に該当する正当なラベルも記録できない。

v2のマップ状態はHTTP登録を拒否し、サーバー内部でのみ登録できる。v1などHTTPで受けたイベントは認証されたクライアントによる申告であり、DBのマップ状態と一致する保証はない。読み出しは既存どおり研究者専用。Stage 1のMap更新APIはサーバーの編集トランザクションから確定した状態を記録し、初期スナップショット・順序・対象イベントを検証して再生する。旧ログの削除や移行は行わない。v1行は再解釈せず、v1/v2をschemaVersionで区別して返す。v2を許可するマイグレーションは既存行を変更しない。

## 旧・新履歴の切替基盤

`map_history_boundaries` はMapごとの旧ログ件数・最終ID・切替時点の状態を保持するための追加テーブル。挿入時にはMap行をロックし、旧ログの連番と件数を検査する。境界作成後は旧ログへの追加および境界の変更・削除をDBで拒否する。既存行は変更せず、マイグレーション時に境界は作成しない。`replayMixedMapHistory` は指定された境界と旧ログ、新イベントの順序・前後状態を照合する。研究者専用 `GET /api/research/sessions/:sessionId/maps/:mapId/mixed-history` は、この関数を使って旧履歴、境界、v2イベント、現在の保存状態を照合する。Map編集・Undo/Redo・履歴照合・既存研究者向け出力・評価/メモ参照に接続している。不成功の取消・拒否・失敗イベントは状態不変項目として再生される。既存行の削除や切替時のリセットは行わない。


`relatedLegacyOperationLogId` は境界以前の旧Map操作を指す場合に使う。`relatedEventId` と同時には指定できず、登録時に指定Mapの旧操作であることを確認する。`idempotencyKey` はMapごとに一意な内部用キーとして保持する。Undo/Redo APIは対象の形式に応じていずれかの参照を記録する。

研究者向けの既存マップ出力は `operationLogs` に旧ログを先頭、新イベントを境界後に続ける。既存の `id`・`operationType`・`sequenceNumber` 等は残し、`historySource` (`LEGACY` / `EVENT`) で識別する。イベント行には `eventId`、`schemaVersion`、`eventType`、`actorType`、`outcome`、Session内の `eventSequenceNumber`、関連先、前後の完全状態、サーバー時刻を追加する。従来の操作CSVにも同じ追加列を末尾に置く。提出は `MAP_SUBMIT` / `MAP_AUTO_SUBMIT` とサーバー時刻で区別し、提出状態は既存のMap行に保持する。状態スナップショットに提出状態を重複保存しない。

研究者の命題評価・メモは、旧 `operation_log_id` を維持しつつ `event_id` を追加する。両方を同時には指定できない。評価の変更前・変更後はどちらか一方を要し、新イベントでは対象SessionとMapの所属および該当状態のLinkを検証する。現在状態の評価はどちらも指定しない。メモの新イベント参照も対象SessionとMapを確認する。研究者画面と既存CSVは旧IDと新IDを別欄で返す。追加マイグレーション `179093` は既存行を更新しない。研究者用分析・Exportには従来の権限制御を適用する。

## Issue #4: 切替前の記録経路の棚卸し

各行は `index.ts` のMap行ロックを使う `withTransaction` 内で、DB変更の後に `appendMapOperationLog` を呼ぶ。以下は切替前の旧ログの形であり、v2では変更前後の完全な状態を記録する。

| 操作 | API | 旧ログの前後データ |
|---|---|---|
| 概念追加 | `POST /api/maps/:mapId/concepts` | 追加前null・追加後概念 |
| 概念編集 | `PATCH /api/concepts/:conceptId/label` | 更新前後の概念 |
| 概念移動 | `PATCH /api/concepts/:conceptId/position` | 更新前後の概念 |
| 概念削除 | `DELETE /api/concepts/:conceptId` | 削除前の概念・関連リンク・由来、削除後null |
| 概念統合 | `POST /api/maps/:mapId/concepts/merge` | 対象概念・関連リンクと統合後の概念・リンク・由来 |
| 関係追加 | `POST /api/maps/:mapId/links` | 追加前null・追加後リンク |
| Kit関係再構成 | `POST /api/maps/:mapId/kit-links/:kitLinkItemId` | 追加前null・追加後リンクと由来 |
| Kit関係取込み | `POST /api/maps/:mapId/kit-links/:kitLinkItemId/import` | 追加前null・追加後リンクと由来 |
| Kit概念取込み | `POST /api/maps/:mapId/kit-concepts/:kitConceptItemId/import` | 追加前null・追加後概念と由来 |
| 関係編集 | `PATCH /api/links/:linkId/label` | 更新前後のリンク |
| 関係再接続 | `PATCH /api/links/:linkId/reconnect` | 更新前後のリンク |
| 関係削除 | `DELETE /api/links/:linkId` | 削除前リンクと由来、削除後null |
| Undo/Redo | `POST /api/maps/:mapId/undo-redo` | 変更対象の概念・リンクの差分と対象旧操作ID |

通常提出 `POST /api/maps/:mapId/submit` と期限後自動提出 `submitExpiredIntegrationMaps` は、状態更新と提出イベントを同一トランザクションで記録する。各編集時の旧ログの before / after は部分データであり、Map全体のv2状態としてそのまま使えない。初回境界では変更前にMapをロックして完全なDB状態を取得し、旧履歴再生と一致させる。Undo/Redoは旧ログと新イベントを連結して対象を選択する。独立した保存APIはなく、各編集の確定が保存となるため、別途MAP_SAVEイベントは生成しない。

既存Undo/Redoの履歴読取は旧ログに続くv2の完全状態を検証できるが、切替後のUndo/Redoは旧操作または新イベントを参照してv2イベントを書き込む。Stage 1の編集・提出はv2イベントを記録する。
失敗・拒否イベントは、認証済み要求が到達し、サーバーがStage 1の所有Mapと操作種別を確認できた時点で、失敗応答を返す前に別トランザクションで記録する。入力不備は REJECTED / VALIDATION、期限は REJECTED / DEADLINE、提出済み・競合・活動順序の拒否は REJECTED / CONFLICT または PERMISSION、処理例外・更新トランザクション失敗は FAILURE / SERVER とする。状態・要求本文・入力値は記録せず、before/after は MISSING とするため失敗イベントは再生状態を変えない。応答には `operationOutcome` と `logSaved` を付け、失敗応答とイベント保存結果を分けて示す。イベント保存に失敗した場合も元のエラー応答を維持し `logSaved: false` とする。`Idempotency-Key` にUUIDを指定した要求は既存のMap単位一意キーで再試行を重複記録しない。キーのない要求は再試行を同一操作と判定できない。

対象Session/Mapを認証主体に結び付けられない要求、認証拒否、所有を確認できない404、およびMap操作として特定できない要求は記録しない。同一Session内の提出済みMapに対する拒否は、APIの404応答を保ったまま記録する。学習者画面に既存の明示的な中止操作がある場合、`POST /api/maps/:mapId/operation-cancellations/:eventType[/:targetId]` がその操作に対応する既存のMapイベント種別だけを `CANCELLED / USER_CANCELLED` として記録する。許可する種別は `ADD_CONCEPT`、`EDIT_CONCEPT`、`DELETE_CONCEPT`、`MERGE_CONCEPT`、`ADD_LINK`、`EDIT_LINK`、`DELETE_LINK`、`RECONNECT_LINK`、`IMPORT_KIT_LINK`、`MAP_SUBMIT` に限定する。編集・削除・再接続は対象Concept/Link IDをパスで渡し、そのIDが当該Mapに属することをAPI側で確認する。APIは任意のイベント本文を受け取らず、認証済み本人のSession、現在進行中のMap Stage、Map種別、提出前Map、期限をサーバー側で検証する。イベントに含めるのはサーバーが確認したMap/Session/Stage/対象IDだけであり、入力本文、ラベル、Map全体の状態、例外本文を含めず、before/after は MISSING とする。Map状態・Stage進行状態は変わらない。対象の明示的なキャンセルUIには、概念・リンクの追加フォーム、仮Linkの作成・Kit Linkの接続、Concept/Link編集、削除確認、Link再接続、Merge確認、提出確認を含む。Kit Conceptのドラッグ中断などサーバーから観測できる明示的な中止操作がないものは記録しない。ブラウザー内でこの専用APIを送る前に中断された操作は記録したことにしない。Map行ロック下で既存境界と混在履歴の整合性を検証し、必要な履歴境界と取消イベントを同一トランザクションで保存する。画面が `Idempotency-Key` を送る場合は同じMap内の同じキー・種別・対象を重複記録せず、キーの異なる操作への再利用は競合として拒否する。キーのない要求は再試行を同一操作と判定できず、Issue #8の再送・重複防止範囲とする。例外本文や入力ラベルはイベントに入れない。ラベル検出は指定パターンに限られ、未知の秘密情報を完全には検出できない。


## Issue #5: 学習活動の記録

Session・活動の開始／完了は既存APIがDB状態を変更した後、認証済みの操作主体で記録する。Session開始は SESSION_START、活動開始は STAGE_START、開始済み活動の再開要求は STAGE_RESUME、活動完了は STAGE_COMPLETE、既存処理によるSession完了は SESSION_COMPLETE。評価回答や課題本文は含めない。clientTimeQuality=NOT_APPLICABLE とし、serverTimestamp がサーバーで確認した時刻を示す。活動順・時間・完了条件は変更しない。

実験群は INTEGRATION_MAP、統制群は SELF_STUDY を activity に持つ。studyGroup・参加者コード・活動種別はSessionとStageから導出する。統合マップの自動提出だけで活動を完了扱いにしない。時間終了後の既存「次へ」による完了を記録する。

学習者のブラウザー報告は SCREEN_ENTER/LEAVE、STAGE_PAUSE/RESUME、VIDEO_PLAY/PAUSE/SEEK/COMPLETE に限定する。Stage開始・完了、Map操作、フィードバック判定などを汎用APIから申告できない。自身のSessionとStageの関連、現在活動、Mapとの関連を検証し、イベント一覧は研究者専用とする。画面離脱は完了直後の活動でも受理し、次の活動へ移動した際の離脱を欠落させない。

SCREEN_ENTER/LEAVE は活動画面のマウント・離脱、pagehide/pageshowで観測する。ブラウザーの visibilitychange は STAGE_PAUSE/RESUME として outcome=UNKNOWN、reasonCode=UNKNOWN で記録する。これはタブの可視状態という申告値であり、学習の実際の中断・再開やDB状態の確定ではない。ブラウザー報告は clientTimeQuality=OBSERVED とクライアント時刻を持つが、時計の正確さや申告内容は保証しない。閉じる際の送信は keepalive を用いるが、通信断・強制終了・端末停止では未観測になり得る。イベントの欠落から完了・離脱・無操作を推定しない。

HTML video の play（初回再生と再開）、pause、seeked、ended だけを記録する。VIDEO_SEEK の details は fromSeconds/toSeconds のみ。timeupdateはシーク元位置の保持だけに使い、イベントを連続送信しない。YouTube iframe・外部リンクは既存プレーヤーから同じ通知を取得できないため動画操作を記録しない。動画URL・ヘッダーは送信しない。VIDEO_COMPLETE はプレーヤー終端の観測であり、視聴理解や活動完了を意味しない。

明示的な一致確認APIは FEEDBACK_CHECK を記録する。当初のv1イベントのoutcomeは一致判定の結果で、SUCCESS=一致、REJECTED=不一致。新しいv6の意味は下記追補に従う。HTTP 200は判定処理が返ったことを示す。一致数・正解ラベル・Goal Map・署名をイベントへ保存せず、従来の集計フィードバック応答だけを維持する。Kit-Build不一致による提出拒否は MAP_SUBMIT/REJECTED/VALIDATION。結果ダイアログが表示された後、本文を持たない POST /api/maps/:mapId/kit-feedback/display で FEEDBACK_DISPLAY を記録する。再表示も記録し、過去の確認と現在の判定を推測で関連付けない。表示報告はブラウザーからの申告であり、実際の可視性を保証しない。表示のclientTimeQualityはMISSING（クライアント時刻未収集）、serverTimestampは報告を保存した時刻。研究者による確認・閲覧は学習者イベントとして記録しない。

状態遷移とフィードバック処理では SAVEPOINT 内でイベント保存を試みる。保存失敗時はイベント部分だけ戻し、確定した学習操作は継続する。応答の logSaved（提出・評価では activityLogSaved）は操作結果とは別の記録結果。falseなら画面で記録保存の問題を知らせる。該当イベントを試みない場合はnull。DBや通信自体の障害で応答が届かない場合は両方の結果が不明になり得る。イベントが保存できなかった回数や時刻をDBから完全復元できるとは扱わない。再送・永続キュー・キーなし再試行の重複防止はIssue #8の対象。スキーマと既存保存行は変更せず、Issue #4のMap記録・履歴には接続しない。


## Issue #6: 評価回答履歴 v3

schemaVersion=3はASSESSMENT_EDIT / ASSESSMENT_SUBMIT専用。v1の数値状態とMap専用v2は維持する。成功したEDITのbefore/afterは {questionId: UUID, answer: string | null} の2フィールドだけ。targetIdとquestionIdは一致必須。nullは保存済み回答行がないことを明示し、空文字の保存とは区別する。未回答入力の禁止は維持する。従来の保存APIで省略された回答行を削除する場合も、after.answer=nullとして追跡する。同文再保存は編集イベントを追加しない。SUBMITはstageIdをtargetIdとし本文を重複保持しない。拒否・失敗は状態を持たず、targetIdはStage ID。自由JSONや未知フィールド、Map参照、任意detailsは受け付けない。

回答長は既存と同じ最大100,000 UTF-16コード単位。既存HTTP本文サイズ上限も維持する。空白だけ、NUL、Bearer形式、password/api-key/access-token/authorization/cookie等の値付き代入、秘密鍵ブロックを拒否する。単なる「パスワード」などの単語だけでは拒否しない。登録済み学習者コードのハッシュ・設定済み研究者コードとの一致も内部登録時に検査する。検出は完全ではないため、認証情報・個人情報を回答へ入力しない運用が必要。未知の秘密や別形式の秘密を完全検出するものではない。既存回答に検出対象が含まれる場合、履歴を切り詰めたり伏せて正常扱いにせず操作全体を拒否する（既知認証情報の内部検出を含む保存障害は安全な500）。拒否された本文・リクエスト全体・ヘッダー・例外本文をログや応答に含めない。

サーバーが現在の評価Stage・Session・設問所有関係を検証し、Session行／Stage行ロック下でDB保存前後を取得する。回答更新、履歴、提出によるStage／Session完了は同一トランザクション。イベント挿入が失敗すれば全体がロールバックする。actor、群、仮名コード、activity=PRE_ASSESSMENT/POST_ASSESSMENTは認証とDBから導出し、学習者向け見出しは中立のまま。時刻はDBのserverTimestamp、clientTimeQuality=NOT_APPLICABLE。保存要求を受けた時刻でありキー入力時刻や正確なブラウザー編集時刻ではない。

保存確定は欄のフォーカス離脱、復旧したローカル下書きの保存、最終提出による。キー入力はローカル下書きの更新だけで、1文字単位のイベントを送信しない。ブラウザー内確認ダイアログの取消・API未送信の未回答・通信断はサーバーが観測した取消や拒否として扱わない。

認証済みで自身の評価Stageと判定できる拒否／失敗だけ、ロールバック後の別トランザクションで本文なしに記録する。REJECTEDはVALIDATION/CONFLICT、FAILUREはSERVER。成功の応答はoperationOutcome=SUCCESS/logSaved=true、拒否・失敗のlogSavedはその結果メタデータの保存可否。falseなら結果記録も欠測。通信断では操作・記録の双方が不明になり得る。再送で同じ回答を保存しても編集差分は増えないが、拒否要求などのキーなし重複はIssue #8の対象。

POST /sessions/:sessionId/eventsはv3および評価編集／提出の直接登録を研究者・学習者とも拒否する。履歴は内部の回答APIからだけ作る。履歴・未提出回答の研究者API、CSV、JSONは既存認証で研究者専用。学習者GETは現在進行中の評価だけで、他時点・他Session・履歴を返さない。取得不能な古いイベントを後付け生成しない。実装前の既存回答は現在値のみを保持し、最初の新履歴のbeforeはその時点のDB回答を表す。

assessmentSnapshotのeventsに順序付きv3履歴を追加し、研究者画面と既存生データJSONにも含める。既存評価回答CSVの元10列とANSWER行の意味を保持し、末尾にrecordTypeとイベント識別・順序・時刻・前後回答・品質列を追加。EVENT行は元のanswer列を空にし、beforeAnswer/afterAnswerで履歴と区別する。recordType=ANSWERで既存の現在回答だけを抽出できる。EVENT行のtimepoint・群・設問は保存時のサーバー確定情報を使う。提出／拒否／失敗など設問単位でない行はquestionIdを空にする。

179095マイグレーションは追加方式。既存v1/v2行・旧Mapログ・評価回答を移行／削除しない。v2制約はv3へ適用されない形で保持し、v3の許可状態・キー・型・関連IDを追加チェックする。アプリケーション経由のテキスト検査・認可はDBへ直接書く管理者SQLを保護するものではない。


## Issue #7: 研究者・システム監査 v4

既存カタログの SESSION_CREATE / SESSION_SETTINGS_CHANGE / RESEARCH_ANALYSIS_VIEW / RESEARCH_EXPORT / RESEARCH_ASSESSMENT_CHANGE / DELETE_CONCEPT / DELETE_LINK / MAP_AUTO_SUBMIT を使う。STAGE_DEADLINEだけは対応する既存名がないため追加する。期限到達は活動完了・提出とは異なる観測で、活動順・状態・時間条件は変えない。ブラウザーの試行イベントは追加せず、サーバーが処理した結果を記録する。

schemaVersion=4は本文なしのサーバー監査専用。共通カラムと同じSession内連番を使い、before/afterはNULL、品質はNOT_APPLICABLE、detailsは空オブジェクト、clientTimestampは未収集（NOT_APPLICABLE）。actorTypeは内部呼出でRESEARCHER/SYSTEMに限定する。Session・Stage・Mapの関連、参加者コード・群・activityはDBから導出する。外部イベントAPIはv4と研究者・システム専用の既存イベント名の直接登録を拒否する。共有研究者コードのため個人研究者は識別しない。評価者コード等をactorに転用しない。

共通時間設定、Session作成失敗、Session未所属Goal Mapの要素削除はSessionを持たない。v1の意味を変えず、v4だけsessionId/participantCodeのNULLを許可する。専用のグローバル連番を用い、Session連番と混同しない。研究者専用 GET /api/research/system/events?after=0 で最大200件を取得できる。Sessionに結びつくv4は既存 GET /api/research/sessions/:sessionId/events に含まれる。どちらも学習者には公開しない。Session未所属記録を架空の参加者へ結び付けない。

Session作成、共通時間設定、学習者コード再発行、研究者の評価・メモ保存、評価問題設定、Concept/Link手動削除の成功監査は変更と同じDBトランザクションで保存する。監査失敗なら変更も戻す。削除対象のConcept/Link IDは監査上のUUID値として保持し、その行への外部キーにはしない。Map/Sessionへの既存RESTRICT参照は維持し、現行にないMap/Session全体の削除APIは追加しない。削除テストは隔離DBのダミー要素のみを対象とする。

分析・履歴表示と既存JSON/CSV出力は、サーバーが生成した結果の監査をレスポンス送信前の別トランザクションで保存する。読取データ、評価理由、回答、出力本文、認証情報、URL、ヘッダー、任意例外本文は監査に保存しない。HTTP 2xxは生成成功であり、ブラウザーが表示・ダウンロードを完了した証明ではない。読取監査の保存失敗で既存の出力自体を失敗扱いにしない。

X-Research-Event-Saved応答ヘッダーは、成功監査またはその拒否・失敗メタデータが保存されたかを示し、学習操作や出力の成功とは別。監査対象の400系はREJECTED、409はCONFLICT、500系はFAILURE/SERVER、その他入力拒否はVALIDATION。認証不成立・学習者の研究者APIアクセス・存在や所有関係を確認できない404は記録しない。Session作成が戻された場合はSession未所属の失敗として扱う。取消要求のない現行UIの確認ダイアログ取消・切断は、観測したCANCELLEDとして記録しない。エラー本文は理由コードへ置換する。DB障害で監査も保存できない場合、ヘッダーfalseまたは固定のevent_missingサーバーログとなり、欠測を後から完全復元できるとは扱わない。

期限走査は両群の現在進行中Stageをサーバー時計で再確認し、STAGE_DEADLINE/SYSTEM/SUCCESS/DEADLINEを一度だけ保存する。統制群は閲覧期限の観測だけで活動状態を変更しない。実験群のMapが存在しない場合もStage期限だけを観測し、空Mapを作成・提出しない。既存の画面のエラー表示を維持する。

実験群の自動提出はSession→Mapのロック後に現在Stage・期限・DRAFTを再確認し、保存済みMapの提出時刻・自動提出時刻とMAP_AUTO_SUBMITを同一トランザクションで確定する。Stageは自動完了しない。起動時と定期走査は同じ関数を使い、ブラウザーが閉じていても回復する。既存提出済みMapへの後付けイベントは作らない。v4内部のaudit_dedup_keyは期限Stage・提出Map・初回失敗を識別し、トランザクションロックと一意制約で並行実行・再起動後の重複を防ぐ。失敗はロールバック後の別トランザクションで本文なしに保存し、同一Stage/Mapの同種失敗は最初の一件だけ保持する。全再試行回数は表さない。再起動という別の成功イベントは重複追加しない。対象特定前の走査・接続障害は固定コードの通常ログだけで、架空Sessionのイベントは作らない。

179096は追記型のマイグレーション。既存のschemaVersion許容式を保持して4を追加し、v1/v2行の内容・必須Sessionを維持する。機微情報のパターン検出や既知コードとの一致確認は完全ではない。既存の旧操作ログ・回答をこの作業で変換・削除・機微情報除去しない。

### Issue #4〜#6との統合時

このブランチの基点は7ae20d0（Issue #3 v2）。混在履歴・Issue #4の収集器は存在しないため混在履歴検証はここでは実行できない。Issue #4の作業ツリーを変更・コピーして検証しない。

Issue #4の自動提出はすでにv2記録と境界確認を持つ。統合時はそのMap更新＋v2記録トランザクションを採用し、こちらのMAP_AUTO_SUBMIT/v4を同じ成功へ二重挿入しない。手動削除の研究者v4もStage 1ではIssue #4の単一Mapイベントにactorを統合し、Goal MapのSession未所属監査だけを残す。期限観測は提出とは別に一度だけ残す。自動提出関数、appendMapOperationLog、共通ロック順・重複キー・研究者分析の手動トランザクションが主な競合点。

Issue #5のStage観測とサーバー確定イベントを維持し、期限をSTAGE_COMPLETEへ変換しない。外部イベントAPIの観測限定認可と、本ブランチのサーバー専用イベント拒否を両方維持する。Issue #6のv3回答履歴・厳密な原子性を維持し、v4監査に回答本文をコピーしない。179095→179096の順でv3制約を保持する設計。研究者問題設定の監査と回答履歴は別操作。research-events.ts / assessments.ts / stage1-analysis.ts / index.ts は統合後に型・認可・全履歴再生・Exportを再検証する必要がある。Issue #8の一般的なキーなしHTTP再送対策を先取りしない。


監査対象のSession/Mapを最初に解決するDB照会が失敗した場合は、後続の変更処理を実行せず503 audit_target_unavailableとX-Research-Event-Saved=falseを返す。未解決の対象を推測して監査記録しない。HTTP障害注入検証はnpm run test:audit-routingで実行する（他の検証と同様にRESEARCHER_API_TOKENを設定する）。

## Issue #8: 送信信頼性の追加契約

v1〜v4の意味を維持したまま、観測のIndexedDB保持・固定キー・ACK、操作APIの原子的な再取得、欠損申告を追加した。詳細と固定フィールド・順序・保存上限・保護限界は[保持・再送・ACK仕様](research-event-delivery.md)を参照する。欠損申告とサーバー保存確認は別テーブルであり、クライアント報告を確定した学習操作へ変換しない。研究者用生データJSONのdeliveryは追加項目で、既存列・schemaVersionを再解釈しない。

上記Issue #7の「このブランチの基点」「統合時」は元の単独作業ブランチの記録である。現在の統合ブランチでの重複解消・混在履歴の実行はresearch-event-integration.md、今回の再検証はissue8-results.jsonで確認する。

## Issue #9: 絞り込み出力

記録済みv1〜v4と旧ログは変更せず、新しい出力APIで同一スナップショットのJSON・共通CSV・用途別CSVを生成する。詳細は[出力仕様](research-event-export.md)・[固定列と値のデータ辞書](samples/event-export/data-dictionary.md)。旧ログの主体・結果を推定せずUNKNOWNを保持し、出力用のlegacy:IDと元の版/順序スコープを区別する。カタログは認証/DBの副作用を持たないresearch-event-catalog.tsへ分離し、research-events.tsの既存エクスポート名は維持する。Issue #8の保持・ACK、Mapの切替境界や操作記録の契約は変更しない。


## 2026-10-30: Link位置v5・Kit確認v6（追記型179102）

v1〜v4の検証・保存行・既存マイグレーションを上書きしない。v5はv2の完全Map状態に、Link単位の `labelPositionX` / `labelPositionY` を追加する。snapshotVersion=1の旧必須フィールドは同じだが、拡張状態を許可するのはschemaVersion=5だけ。v2は座標拡張キーを引き続き拒否する。両座標は同時に存在する有限数で絶対値10,000,000以内。ラベル512文字、Concept1000、Link2000、各Provenance1000、1状態のcompact UTF-8 JSON 4,000,000 bytesという既存上限を共有する。DBは列のペア・数値範囲、イベントの構造・バージョン・参照を制約し、登録前にAPIと内部登録の厳密な状態検証を必須とする。PostgreSQL jsonb::textの空白込みサイズとcompact JSONのサイズを同一値とは扱わない。

`MOVE_LINK` / LINKは、接続済みラベルのドラッグを離した確定時だけを記録する。前後はMapロック下で読んだ完全なDB状態、対象は当該Link、actorは認証主体、clientTimestampは申告、serverTimestampとSession内sequenceはサーバー確定。同座標への更新は新しい編集イベントにしない。位置はLinkのsource/targetやKit判定データとは別で、向き・一致判定は変えない。ドラッグ中の軌跡、未確定部品の移動、ズーム・パンをMap編集として記録しない。未確定部品の位置はLinkが作成された後に初めて保存対象となる。

未割当の既存Link位置はDBの両NULL、v5状態では両キー省略で「自動配置」。最初の移動前に存在しなかった固定座標を推定して数値化しない。描画上の初期位置は画面寸法等に依存し、保存済み座標の実測とは区別する。v5 MOVE_LINK成功では変更後の両座標が必須。状態を記録する新規Stage 1 Map成功操作をv5へ揃え、位置を持ったLinkの編集・統合・削除・取込み・Undo/Redo・提出後も全状態を保持する。既存のGoal Map編集・チュートリアル等の表示操作を新しいSessionイベントへ紛れ込ませない。今回の位置APIはStage 1の3種類を対象とする。

旧ログ→凍結境界→v2/v5のSession sequence順で再生。境界は再作成せず、同一トランザクションのMap変更・イベント保存を維持する。Undo/Redoは旧参照または新参照の一方のみ、v2対象もv5対象も復元できる。列NULLの自動配置へのUndoも可能。位置APIも既存の期限・提出・所有者認可と操作Idempotency-Keyを使い、再送・競合・イベント保存失敗で部分更新を残さない。新形式の任意状態を学習者のイベントAPIへ直接登録する経路はない。

v6はFEEDBACK_CHECK / FEEDBACKだけ。対象MapとStageをサーバーが結び付け、targetId=mapId、before/afterなし、各qualityとclient時刻はNOT_APPLICABLE。判定が返ったときは一致/不一致の両方ともoutcome=SUCCESS、detailsは厳密な `{matched:boolean}` だけ（理由なし）。入力/状態による拒否はREJECTEDと固定理由、所有者を安全に特定した後の技術障害はFAILURE/SERVER。後二者は一致結果なし・details空でありfalseへ補完しない。保存失敗はlogSaved=falseとして確認処理の結果と区別する。未認証・他Session・対象特定前の失敗は本人イベントとして記録しない。

正解ラベル・Goal Map・対応関係・回答本文はv6へ含めない。実際の判定基準・一致数・学習者フィードバック本文は不変。FEEDBACK_DISPLAYは従来のv1ブラウザー表示申告を維持し、同じ本人Map/Stageに関連付けるが、画面が実際に見られた保証や特定結果との未保存の対応を作らない。保存済みv1 FEEDBACK_CHECKは既存のSUCCESS=一致/REJECTED=不一致のまま残す。取消要求を観測できない確認処理にCANCELLEDを生成しない。


179103追補: PostgreSQLのjsonb::textは空白の追加や極小有限数の展開でcompact JSONより大きくなるため、DBの粗い保存ガードを8,000,000 bytesへ合わせる。APIと内部イベント登録の共通上限はcompact UTF-8 JSON 4,000,000 bytesのまま。102は書き換えず追記で適用し、有効な1000概念/2000リンク・極小座標の模擬状態がDB表現だけを理由に拒否されないことを自動検証する。

既存の明示取消経路は、本文を持たないv2のCANCELLEDとして維持する。位置を含む成功状態をv2へ書くものではなく、混在読取りでv2/v5を順に扱う。


## 2026-10-31: PR #16 P1追補（179104、失敗記録と成功の冪等性）

イベントのschemaVersion・eventType・outcome・前後状態の意味は変更しない。179104は179103の後に適用し、既存行を更新・削除・変換せず、旧Map単位キーの一意インデックスだけを次の2つに置き換える。

- SUCCESS: `(map_id, idempotency_key)` ごとに1件。
- SUCCESS以外: `(map_id, idempotency_key, outcome)` ごとに1件。同じ結果区分の再送を監査の新規発生とは推定せず、既存eventIdを返す。全試行回数は表さない。

同じ論理要求がFAILURE/REJECTEDの後に成功した場合、以前の監査行と新しいSUCCESS行が共存する。失敗行を上書き・削除せず、異なるeventIdとSession保存順序を持つ。キー自体を「成功済みイベントID」と解釈しない。Undo/Redoの適用済み判定はSUCCESSだけ、明示取消の重複判定はCANCELLEDだけを参照する。混在履歴では不成功イベントがMapを変更しない既存契約を維持する。

操作結果receipt・認証主体のスコープ・本文ハッシュ・advisory lock・Map行ロックは維持する。失敗により操作トランザクションが戻った要求は、障害解消後に同じキー/同じ本文で実行できる。成功とMap変更・イベント・receiptは原子的に確定し、同一キーの並行再送は元の結果を返して二重適用しない。異なる本文での確定済みキー再利用や現在の閲覧権限の検証は緩めない。

Mapエラー応答の記録は、pool.connect・BEGIN・イベント保存・COMMIT・ROLLBACK・releaseを含むcallback全体をrespondToMapFailureで捕捉する。保存不能でも元のHTTPステータスと操作失敗を維持し、operationOutcomeとlogSaved:falseを返す。DB例外本文・スタック・機密入力を応答へコピーしない。未送信の応答自体が切断等で書けない場合は接続を閉じ、未処理Promise拒否にしない。ログを保存できなかった試行を後から完全復元できるとは扱わない。

適用時は単一APIを停止してバックアップと追加マイグレーションを確認し、179104適用後に対応する更新済みAPIを起動する。旧APIと新APIを混在稼働させない。旧インデックスを戻すと共存した監査行が衝突するためdownは拒否する。既存DBへの適用・本番更新訓練は今回実施しない。

検証: test:map-failure-retryを標準suiteへ追加。テスト専用preloadによる実APIのログ接続拒否、接続後の保存失敗、Undo/Redo/Link移動の失敗後の同一キー再送・並行再送、失敗行保持、拒否後の回復、混在再生・Exportを確認する。実行結果は[PR16 P1修正検証記録](pr16-p1-verification.md)で過去の28件記録と区別する。
