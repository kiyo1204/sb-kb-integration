# 研究イベント・テスト対応表（自動照合）

スキーマ契約の全outcome検証と、実API処理の検証は別である。契約がCANCELLEDを表現可能でも、実際に取消を観測・記録する経路があるとは意味しない。v4はserver-auditのDB検証で確認する。旧形式は固定のschemaVersionを持たず、未知種別は再生不能/本文非表示として扱う。

|イベント|対象|互換schemaVersion|実行する主な検証|非適用・観測限界|
|---|---|---|---|---|
|SESSION_CREATE|SESSION|1,4|test:research-event-schema,test:server-audit|DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。|
|SESSION_START|SESSION|1|test:research-event-schema,test:learning-activity-events|DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。|
|SESSION_COMPLETE|SESSION|1|test:research-event-schema,test:learning-activity-events|DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。|
|SESSION_SETTINGS_CHANGE|SESSION|1,4|test:research-event-schema,test:server-audit|DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。|
|STAGE_DEADLINE|STAGE|1,4|test:research-event-schema,test:server-audit|DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。|
|STAGE_START|STAGE|1|test:research-event-schema,test:learning-activity-events|DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。|
|STAGE_COMPLETE|STAGE|1|test:research-event-schema,test:learning-activity-events|DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。|
|STAGE_PAUSE|STAGE|1|test:research-event-schema,test:learning-activity-events|DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。|
|STAGE_RESUME|STAGE|1|test:research-event-schema,test:learning-activity-events|DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。|
|SCREEN_ENTER|SCREEN|1|test:research-event-schema,test:learning-activity-events|DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。|
|SCREEN_LEAVE|SCREEN|1|test:research-event-schema,test:learning-activity-events|DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。|
|VIDEO_PLAY|VIDEO|1|test:research-event-schema,test:learning-activity-events|DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。|
|VIDEO_PAUSE|VIDEO|1|test:research-event-schema,test:learning-activity-events|DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。|
|VIDEO_SEEK|VIDEO|1|test:research-event-schema,test:learning-activity-events|DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。|
|VIDEO_COMPLETE|VIDEO|1|test:research-event-schema,test:learning-activity-events|DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。|
|ADD_CONCEPT|CONCEPT|1,2,5|test:research-event-schema,test:stage1:integration,test:map-api-v2,test:map-mixed-history|CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。|
|EDIT_CONCEPT|CONCEPT|1,2,5|test:research-event-schema,test:stage1:integration,test:map-api-v2,test:map-mixed-history|CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。|
|MOVE_CONCEPT|CONCEPT|1,2,5|test:research-event-schema,test:stage1:integration,test:map-api-v2,test:map-mixed-history|CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。|
|DELETE_CONCEPT|CONCEPT|1,2,4,5|test:research-event-schema,test:stage1:integration,test:map-api-v2,test:map-mixed-history|CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。|
|MERGE_CONCEPT|CONCEPT|1,2,5|test:research-event-schema,test:stage1:integration,test:map-api-v2,test:map-mixed-history|CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。|
|IMPORT_KIT_CONCEPT|CONCEPT|1,2,5|test:research-event-schema,test:stage1:integration,test:map-api-v2,test:map-mixed-history|CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。|
|ADD_LINK|LINK|1,2,5|test:research-event-schema,test:stage1:integration,test:map-api-v2,test:map-mixed-history|CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。|
|MOVE_LINK|LINK|5|test:parent-followup,test:map-api-v2,test:map-mixed-history|確定時だけ保存。未割当の表示位置は自動配置として座標を補完しない。ドラッグ取消はAPI送信前なら未観測。|
|EDIT_LINK|LINK|1,2,5|test:research-event-schema,test:stage1:integration,test:map-api-v2,test:map-mixed-history|CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。|
|DELETE_LINK|LINK|1,2,4,5|test:research-event-schema,test:stage1:integration,test:map-api-v2,test:map-mixed-history|CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。|
|RECONNECT_LINK|LINK|1,2,5|test:research-event-schema,test:stage1:integration,test:map-api-v2,test:map-mixed-history|CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。|
|IMPORT_KIT_LINK|LINK|1,2,5|test:research-event-schema,test:stage1:integration,test:map-api-v2,test:map-mixed-history|CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。|
|UNDO|MAP|1,2,5|test:research-event-schema,test:stage1:integration,test:map-api-v2,test:map-mixed-history|CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。|
|REDO|MAP|1,2,5|test:research-event-schema,test:stage1:integration,test:map-api-v2,test:map-mixed-history|CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。|
|MAP_SAVE|MAP|1,2,5|test:research-event-schema,test:stage1:integration,test:map-api-v2,test:map-mixed-history|予約語。現在の保存は各編集APIの確定イベントで表す。独立した保存ボタンの成功を観測したとは扱わない。|
|MAP_KIT_ASSIGN|MAP|1,2,5|test:research-event-schema,test:stage1:integration,test:map-api-v2,test:map-mixed-history|CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。|
|MAP_SUBMIT|MAP|1,2,5|test:research-event-schema,test:stage1:integration,test:map-api-v2,test:map-mixed-history|CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。|
|MAP_AUTO_SUBMIT|MAP|1,2,4,5|test:research-event-schema,test:stage1:integration,test:map-api-v2,test:map-mixed-history|CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。|
|FEEDBACK_CHECK|FEEDBACK|1,6|test:research-event-schema,test:learning-activity-events|旧v1のREJECTEDはKit不一致。v6はSUCCESSとdetails.matchedで一致/不一致を分け、REJECTED/FAILUREは操作拒否/技術失敗。DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。|
|FEEDBACK_DISPLAY|FEEDBACK|1|test:research-event-schema,test:learning-activity-events|DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。|
|ASSESSMENT_EDIT|ASSESSMENT|1,3|test:research-event-schema,test:assessment-events|DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。|
|ASSESSMENT_SUBMIT|ASSESSMENT|1,3|test:research-event-schema,test:assessment-events|DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。|
|RESEARCH_ANALYSIS_VIEW|SESSION|1,4|test:research-event-schema,test:server-audit|DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。|
|RESEARCH_ASSESSMENT_CHANGE|ASSESSMENT|1,4|test:research-event-schema,test:server-audit|DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。|
|RESEARCH_EXPORT|SESSION|1,4|test:research-event-schema,test:server-audit|DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。|

旧操作語彙：ADD_CONCEPT, EDIT_CONCEPT, MOVE_CONCEPT, DELETE_CONCEPT, MERGE_CONCEPT, IMPORT_KIT_CONCEPT, ADD_LINK, EDIT_LINK, DELETE_LINK, RECONNECT_LINK, IMPORT_KIT_LINK, UNDO, REDO, MAP_SAVE, MAP_KIT_ASSIGN, MAP_SUBMIT, MAP_AUTO_SUBMIT。Map再生の全分岐・不正状態はUndo/Redo・混在履歴・実Map APIの検証と組み合わせる。
