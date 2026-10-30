# 研究イベントの保持・再送・ACK（Issue #8）

## 対象と境界

統合ブランチ `codex/integrate-research-event-streams` の v1〜v4 を利用する。イベントの意味やスキーマバージョン、研究条件、活動順、回答形式、Mapの切替境界は変えない。新しい保存状態は研究イベントの架空の成功・欠損イベントとして挿入せず、専用のreceipt・申告テーブルに保持する。

| 種類 | 保存・再送方法 |
|---|---|
| ブラウザーの画面・動画・可視性・フィードバック表示の観測（v1） | IndexedDBの観測キューから順次再送 |
| Stage開始・完了、Kit一致確認要求と結果 | 既存のサーバー確定処理。観測キューから状態を変更しない |
| Map編集・提出・Undo/Redo（v2）、評価保存・提出（v3） | 操作APIのトランザクション内で状態・イベント・操作receiptを確定。イベント単独の後送は禁止 |
| 研究者・システム監査（v4）・自動提出 | 既存のサーバー処理と重複防止を維持。ブラウザーキューには入れない |

Map取消は既存の限定APIとMap単位の重複キーを維持する。任意イベント登録は再開しない。未認証・他Session・Goal Map・回答履歴・研究者用データのアクセス制御を維持する。

## 観測キュー

IndexedDB `stage1-observation-outbox` / `sessions` を使う。Sessionごとに `clientId`（ランダムUUID）、次の観測連番、報告連番、ACK累計、送信試行累計、最終応答、損失疑いの理由別累計とitemsを保持する。

各itemは固定UUID `id`、`order`、`created`（ブラウザー時計）、`attempts`、`last`（UNSENT / RETRYING / UNKNOWN）、厳密なv1観測だけを含む。許可するイベントは SCREEN_ENTER / SCREEN_LEAVE / STAGE_PAUSE / STAGE_RESUME / VIDEO_PLAY / VIDEO_PAUSE / VIDEO_SEEK / VIDEO_COMPLETE / FEEDBACK_DISPLAY。UUID参照・観測時刻・固定結果だけを受け付け、シークだけ移動元/移動先の非負有限秒数を許可する。フィードバック本文・判定結果・動画URL・任意テキストは保持しない。読出時も型・未知フィールド・順序・イベントを再検証し、不正な保存内容を送信しない。

上限はSession当たり500件・UTF-8 JSONのitems 1,000,000 bytes・7日、同一originで32 Session。件数または容量を超えると古いitemを除いてcapacityLostへ、保持期間を過ぎたitemを読出/再送/追加時に除いてexpiredLostへ計上する。上限・期限は保持の条件であり、研究活動の期限判定には使わない。Session識別・累計メタデータは上限32件の中で保持し、過去の欠損申告を自動消去しない。32 Sessionを超える新規保持も黙って破棄せず、保持不能として表示・申告する。

認証トークン・アクセスコード・Cookie・パスワード・回答本文・Map状態・v2/v3/v4を投入する経路はない。現在の認証は送信時にのみ取得し、`/api/me` のSessionが一致するときだけ送る。別の学習者でログインしても前のSessionのキューを送らない。

初回表示、pageshow、online、15秒周期、観測追加時に再送する。同じタブの並行flushはまとめ、先頭1件を送ってACKを受け取ってから次へ進む。認証確認・送信・報告には10秒のタイムアウトがある。通信失敗・5xx・ACKの欠落はUNKNOWNとして保持し、次の機会に再試行する。401でも保持して再認証を待つ。400/403/404/409/410/422の確定拒否はrejectedLostに計上して次へ進む。itemの削除はACKまたは明示した損失理由に限る。

## ACK・順序・同時送信

`POST /api/sessions/:sessionId/events` で `Idempotency-Key`（item UUID）、`X-Client-Stream-Id`、`X-Client-Sequence` を送る。再送しても全て不変とする。サーバーは認証済み本人、Stage・MapのSession所有関係、v1観測の許可フィールドを検証する。

同一Session+イベントキーと同一Session+clientId+観測順序に一意制約を持つ。キーとストリームのロック、共通sequence割当、イベント挿入、receipt挿入を同じDBトランザクションで行う。同じキー・本文・ストリーム・順序の再送は既存のeventIdとsequenceNumberを返し、sequenceを消費しない。同じキーの変更は409 delivery_conflict、未保存の逆順は409 delivery_order_conflict。異なるタブから同じ先頭を送ってもDBとACK累計を二重加算しない。

ACKは2xxかつ `logSaved=true` とeventId/sequenceNumberを得た場合だけ。HTTP送信完了や画面操作の成功だけではACKとみなさない。送信試行数・最終応答は保持する。ACK済みitemの本文は削除し、累計とサーバーreceiptを残す。

client_sequenceはそのブラウザーのSession別ストリームの観測順。research_events.sequence_numberはSession内の全主体・全スキーマの**サーバー保存順**。両者やclientTimestamp/serverTimestampを同一視しない。遅延した観測は本人の開始済み（画面入場は現在の未開始も可）Stageへ関連付けられるが、完了済みStageを再開せずMap内容も返さない。クライアント時刻・可視性・視聴報告の真実性はサーバー確定情報ではない。

## 操作APIの再試行

`apiFetch` はMap/Concept/Link/Kit/Stageの対象更新に固定UUIDのIdempotency-Keyを付ける。本文・認証ヘッダーを保存せず、メソッド・パス・JSON文字列のSHA-256、キー、作成時刻だけをIndexedDB `stage1-operation-keys` に保持する。HTTP LANではgetRandomValuesと純粋JSのSHA-256を使う。最大100件、同じ本文は再読込・ブラウザー再起動・同時タブでも同じキーを使う。異なる本文を同一操作と推測しない。本文自体は自動復元・自動送信しない。

ネットワーク失敗/タイムアウト時は同じ要求を最大1回直ちに再試行し、それでも不明ならキーを残す。再度同じ要求を送る場合も同じキーを使う。確定応答後にメタデータを削除する。ローカルACK削除に失敗しても、受け取った操作成功を失敗に変換しない。7日を超えた未確認キーは新しいキーへ置換せず、保存状態の確認を促して送信しない。上限超過も送信前に通知する。

サーバーは認証済み主体（学習者Session/共有研究者権限）にキーをスコープし、メソッド・パス・正規化本文のハッシュを確認する。既存のMap/評価トランザクション内でキーをロックして、状態変更・イベント・内部結果receiptを一緒にCOMMITする。途中失敗は全て戻す。ロールバック後に残す失敗/拒否の評価イベントは別の結果区分で重複を防ぐ。Map拒否/失敗・取消の既存Map単位キーも維持する。

同一の確定要求は保存済みの内部結果から元のAPI応答を再構成し、状態やイベントを再実行しない。`X-Operation-Recorded=true` はreceiptのある処理、`X-Operation-Replayed=true` は再取得を表す。**操作の成功を意味するヘッダーではない**。既存のoutcome/logSavedで操作結果とイベント保存結果を判断する。サーバーからブラウザーが応答を受け取ったかは確定できない。

再取得でも現在の所有関係とMap閲覧条件を適用する。提出・削除・期限終了・活動移動後には、Map作成APIの再送を含めて旧結果のMap内容を返さない。409 operation_already_committedで安全な処理済み情報だけを返し、セッションの再読込を案内する。確認できる提出成功以外の結果を成功と推測しない。7日後は410 operation_result_expiredで再実行を拒否する。サーバーreceiptは同じキーを再利用させない識別記録として保持する。既知の入力検証より前に未確認の他者資源を公開せず、他Session/Goal Mapの404を維持する。

Idempotency-Keyのない旧クライアント/直接APIについて、同一要求であるとは推定しない。UUIDの新規発行は新しい論理操作を表す。障害前後に本文や時刻・Undo対象を変えて新しい要求を作った場合も、無理に以前の操作へ結び付けない。

## 研究者の確認と欠損申告

研究者のセッション画面・分析画面の「操作記録の送信状態」、`GET /api/research/sessions/:id/delivery-status`、既存生データJSONの追加項目deliveryで確認する。既存の回答・操作CSV列、Map履歴、監査は維持する。表示の短いclientIdを照合して同じストリームの申告と保存件数を区別する。

本人の `POST /api/sessions/:id/delivery-status` だけが申告可能。許可項目はclientId、reportSequence、pending、retrying、attempts、acknowledged、capacityLost、expiredLost、rejectedLost、storageLost、lastResponseだけ。数値は0〜10億の整数、retrying<=pending、reportSequence>0。lastResponseはNONE / SENDING / ACK / NETWORK / RETRYABLE / REJECTED / STORAGEの固定コード。自由記述やイベント本文、秘密フィールドは拒否する。旧報告や重複報告は単調なreportSequenceで上書きを防ぐ。

SENDINGは送信開始時の申告で、現在も接続している保証ではない。未送信、送信/再送中、再試行待ち、ACK済み、確定拒否、容量/期限超過を最終受信時刻とともに示す。storageLostは観測を新たに保持できなかった既知件数。記憶領域の破損・読出不能ではSTORAGEとし、過去の未送信/ACK/欠損件数を0と表示せず不明とする。報告自体を保持できない場合の最小報告はメモリーだけなので、届く前の終了では失われる。

サーバー検証済みの情報はreceipt件数、最大観測連番、`max(client_sequence)-count(*)` の欠番数。欠番は申告順序の欠損疑いであり、実際の行動の欠測数・原因を保証しない。後続の観測が来ない末尾欠損や、ブラウザー領域全体の消去は連番だけでは分からない。報告のないブラウザー・古い報告から「欠損なし」と推定しない。

## 回答ドラフトと保護の限界

既存Assessment.tsxは最新の入力だけを `stage1-assessment-draft-v2:<Session UUIDのSHA-256>:<stageId>` としてlocalStorageに平文保存し、欄を離れた保存が同じ内容で成功すると削除、提出成功でも削除、再表示時には設問IDを照合して復元する。1文字ごとの履歴を研究イベントへ送るものではない。これはIssue #6由来の既存ドラフトで、新しい観測キュー・操作receiptメタデータには回答を追加していない。旧Stage単位キーは所有者不明として通常復元から隔離し、値の読取り・自動移行・紐付け・削除を行わない。削除時の対象下書き消去と、対応不明の旧キーの限界は[データ管理仕様](research-data-management.md#親issue-2監査-評価下書きの削除範囲)を参照する。既存ドラフトには自動期限や暗号化がなく、送信不能のまま残ることがある。実験中にブラウザー領域を消去すると未保存回答も失われる。同一originのスクリプトから読めるため、これを秘密情報の安全な保管場所と案内しない。

HTTP LANは暗号化されず、認証トークンの既存sessionStorage経路も別に存在する。新しいキューにコピーしないことは、アプリ全体の通信/保存の暗号化を意味しない。現行LANは開発・模擬データ専用。未知の秘密情報を完全に検出できるとは説明しない。

ブラウザー強制終了前に観測できなかった操作、IndexedDB COMMIT前の終了、ストレージ消去/破損、プライベートモードの終了、PC変更、異なるIP/ポート（origin）の利用、失われた認証、報告到達前の終了は復旧を保証できない。保存済みキューは同一origin・同じ学習者の再認証後に再送できる。過去の操作や未観測の動画終了を推測で生成しない。

## DBと検証

179097は専用receipt/申告テーブルと一意制約、179098/179099はSTORAGE/SENDINGの固定状態を追記する。適用済みの179089〜179096や保存済みイベントの意味を変えない。今回、既存DBへ接続・適用せず、隔離DBだけで全マイグレーションを順に確認する。

- backend `test:delivery-reliability`: 実APIの同時再送、順序競合、遅延観測、本人認可、報告検証、サーバー再起動、Map/評価の原子性・保存障害・応答喪失想定の再取得、提出後/期限後の内容保護。
- frontend `test:delivery-browser`: 実Edge/IndexedDB、通信断・ACK喪失、ページ/ブラウザープロセス再起動、順次再送、保持上限・期限、操作キーの同時取得/再起動保持、不正保存/秘密フィールド拒否、保存不能の件数不明申告。既定はEdge、BROWSER_CHANNELでPlaywrightの導入済みブラウザーへ変更可能。
- 既存Stage 1、Map API、自動提出、Undo/Redo、混在履歴、評価、監査、認可、Exportとv1〜v4結合検証、型検査・Lint・両ビルドも実行する。結果はissue8-results.jsonを参照。
