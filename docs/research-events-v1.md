# 研究イベント仕様 v1（Issue #3）

本基盤は追加方式。現時点では既存操作を自動収集せず、既存のログとは統合しない。開発・模擬データ用であり実研究向けの安全性は別途確認する。名称は `対象_操作` または既存操作名とし、実行結果は eventType ではなく outcome に入れる。登録成功は操作成功を意味しない。

## 共通フィールド

`eventId` はサーバー生成 UUID、`schemaVersion` は 1。`sessionId`、`stageId`、`mapId` は所有関係をサーバーが検証し、mapId があれば対応する stageId を導出する。`participantCode` と `studyGroup` は Session から取得した記録時点の値（旧形式の群は null）。`activity` は紐付いた活動の種別で、活動がない場合 null。`actorType` は LEARNER / RESEARCHER / SYSTEM、外部 API では認証済み主体から決定する。共有研究者コードのため研究者個人は識別できない。SYSTEM はサーバー内部の登録のみ。

`eventType` と `targetType` は下表。`targetId` は UUID（SESSION/STAGE/MAP は省略時に関連IDを補う）。`outcome` は SUCCESS / FAILURE / REJECTED / CANCELLED / UNKNOWN。`reasonCode` は NOT_APPLICABLE / UNKNOWN / VALIDATION / PERMISSION / DEADLINE / CONFLICT / NETWORK / SERVER / USER_CANCELLED / OTHER、任意、文字列説明や例外は受け取らない。省略は **未記録**、NOT_APPLICABLE は理由が該当しない、UNKNOWN は確認したが不明。`relatedEventId` は同一 Session の先行イベントに限る。UUID を秘密情報の格納先として使わない。

`sequenceNumber` は同一 Session の保存確定順を表す10進文字列（bigint）、mapId で絞れば同一マップの順序が分かる。専用カウンターの行更新と挿入を同じトランザクションで行い、同時登録時も重複せず、ロールバックでは進まない。発生順、クライアント送信順、旧ログ sequence とは限らない。`serverTimestamp` はDB挿入時刻、`clientTimestamp` は申告値で信頼できる時計とみなさない。`clientTimeQuality` は OBSERVED / ESTIMATED（時刻必須）と MISSING（未取得）/ NOT_APPLICABLE（該当しない）/ UNKNOWN（不明）（時刻禁止）を区別。推定値は観測値として扱わない。

`before` / `after` は `beforeQuality` / `afterQuality` により OBSERVED（観測）・ESTIMATED（推定）・MISSING（欠測）・NOT_APPLICABLE（該当なし）・UNKNOWN（不明）を区別する。値がある場合の既定は OBSERVED、ない場合の既定は MISSING。値なしの理由は品質欄で明示し、null だけから判断しない。v1の登録口は `positionX` / `positionY` の有限数値だけを受け付ける。`details` は `durationMs`、`positionSeconds`、`fromSeconds`、`toSeconds` の非負有限数値のみを受け付け、省略時は空オブジェクト。個々の詳細項目の欠測理由やテキストの詳細スキーマは後続Issueで追加設計する。空オブジェクトと未記録を同一視しない。自由記述・ラベル・認証情報・URL・ヘッダー・エラー本文を受け入れない。入力は未知フィールドを拒否し、認証情報、コード、トークン、Cookie、パスワードを記録・出力しない。参加者コードは既存の研究用仮名コードであり、認証情報を入れない運用が必要。登録時に現在の研究者コードや登録済み学習者コードと完全一致する参加者コードは拒否するが、未知の秘密情報まで検出できるものではない。今後、テキスト等を収集する際は認証情報の混入防止とアクセス制御を別途設計し、スキーマを拡張する。

保存APIの `logSaved: true` はイベント行がコミットされたことのみを示す。エラー時の `logSaved: false` は操作が失敗したことを意味しない。通信断では保存結果も不明。再送・重複防止・欠損検知は #8。イベントが存在しないことから操作がなかったと推測しない。

## イベントカタログ

共通必須項目は schemaVersion、sessionId（URL）、eventType、targetType、outcome、clientTimeQuality。対象の Stage / Map に紐づくものは stageId / mapId、Concept / Link は mapId と targetId が必須。対象の特定、before/after、reasonCode、relatedEventId は判明する場合に追加する。各イベントは実行後の結果を一件に表し、失敗・拒否・取消も同じ eventType の異なる outcome で表す。未実装の記録契機は後続Issueが担当する。

| eventType | 対象 | 記録契機 |
|---|---|---|
| SESSION_CREATE / SESSION_START / SESSION_COMPLETE | SESSION | Session作成・開始・完了の結果 |
| SESSION_SETTINGS_CHANGE | SESSION | 研究者による設定変更の確定結果 |
| STAGE_START / STAGE_COMPLETE / STAGE_PAUSE / STAGE_RESUME | STAGE | 活動開始・完了・中断・再開の結果 |
| SCREEN_ENTER / SCREEN_LEAVE | SCREEN | 画面への移動・離脱を観測した時 |
| VIDEO_PLAY / VIDEO_PAUSE / VIDEO_SEEK / VIDEO_COMPLETE | VIDEO | 再生・停止・位置移動・再生完了を観測した時 |
| ADD_CONCEPT / EDIT_CONCEPT / MOVE_CONCEPT / DELETE_CONCEPT / MERGE_CONCEPT | CONCEPT | 追加・編集確定・移動確定・削除・統合の結果 |
| IMPORT_KIT_CONCEPT | CONCEPT | Kit概念を取り込んだ結果 |
| ADD_LINK / EDIT_LINK / DELETE_LINK / RECONNECT_LINK | LINK | 関係の追加・編集確定・削除・再接続の結果 |
| IMPORT_KIT_LINK | LINK | Kit関係を接続・取込みした結果 |
| UNDO / REDO | MAP | 操作の取り消し・やり直し結果。対象イベントを relatedEventId で関連付ける |
| MAP_SAVE / MAP_SUBMIT / MAP_AUTO_SUBMIT | MAP | 保存・提出・サーバー自動提出の結果 |
| FEEDBACK_CHECK / FEEDBACK_DISPLAY | FEEDBACK | 一致確認の結果・画面表示時 |
| ASSESSMENT_EDIT / ASSESSMENT_SUBMIT | ASSESSMENT | 回答編集の確定・提出結果 |
| RESEARCH_ANALYSIS_VIEW / RESEARCH_EXPORT | SESSION | 研究者の分析画面閲覧・出力結果 |
| RESEARCH_ASSESSMENT_CHANGE | ASSESSMENT | 研究者による問題設定変更の結果 |

マウス軌跡、ホバー、1文字ごとの入力、無操作の推測は対象外。上記は収集予定の語彙であり、現在の実装がすべての契機を記録しているという意味ではない。成功以外には可能な範囲で reasonCode を付ける。before/after のないレコードは再生可能とは限らない。

## APIと認可

`POST /api/sessions/:sessionId/events` は `schemaVersion: 1` と上記項目を受け取り、201 で `eventId`, `sequenceNumber`, `logSaved` を返す。詳細は上記の数値だけを受け付け、任意文字列・認証情報・participantCode・studyGroup・actorType は受け付けない。学習者は自分の Session のみ、マップ指定時は既存のマップ閲覧認可も必要。研究者・システム専用イベントを学習者は登録できない。登録イベントはクライアント申告であり、事実の保証にはならない。システム主体はサーバーの `insertResearchEvent` を既存トランザクション内で呼び出す。自動収集はまだ接続していない。

`GET /api/research/sessions/:sessionId/events?after=<sequence>` は研究者専用、順序昇順で最大200件。次ページは最後の sequenceNumber を after に指定。学習者は自他のイベント一覧を取得できない。認可不能な Session / Stage / Map / relatedEvent は 404。時刻・状態を省略した場合の解釈は上記のとおり。保存失敗の応答を記録成功と取り違えない。

## バージョンと旧ログ

v1の入力や意味を破壊する変更は新しい schemaVersion とマイグレーションを用い、旧行を再解釈しない。新しい安全な details / before / after はイベント別にキー・型・欠測・機微情報の扱いを確定し、検証器とDB制約、互換性、テスト、カタログを一緒に更新する。新しい意味のあるイベントの追加は既存名を再利用しない。

旧 `map_operation_logs` は `index.ts` の Map 操作と Undo/Redo、`map-history.ts`、`stage1-analysis.ts` の再生・評価・メモ参照、`research-export.ts` および CSV と分析に使われる。旧ログには上記の Concept / Link / Kit / UNDO / REDO 13種が記録され、Map 編集開始時スナップショットと組み合わせて再生する。新イベントへの二重書き・移行・削除・リセットはしない。#4 で収集と新形式の再生を、#9/#10 で出力・閲覧を、#12 で安全な切替と開発用リセットを扱う。互換性検証と対象の明示なしに旧ログやスナップショットを削除してはならない。



