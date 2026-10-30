import type { EventType } from "./research-event-catalog.js";
type Policy = { versions: number[]; suites: string[]; limitation: string };
// Explicit reviewed registry: adding a catalog key requires updating this matrix.
export const eventTestMatrix = {
  SESSION_CREATE: {
    versions: [1, 4],
    suites: ["test:research-event-schema", "test:server-audit"],
    limitation:
      "DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。",
  },
  SESSION_START: {
    versions: [1],
    suites: ["test:research-event-schema", "test:learning-activity-events"],
    limitation:
      "DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。",
  },
  SESSION_COMPLETE: {
    versions: [1],
    suites: ["test:research-event-schema", "test:learning-activity-events"],
    limitation:
      "DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。",
  },
  SESSION_SETTINGS_CHANGE: {
    versions: [1, 4],
    suites: ["test:research-event-schema", "test:server-audit"],
    limitation:
      "DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。",
  },
  STAGE_DEADLINE: {
    versions: [1, 4],
    suites: ["test:research-event-schema", "test:server-audit"],
    limitation:
      "DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。",
  },
  STAGE_START: {
    versions: [1],
    suites: ["test:research-event-schema", "test:learning-activity-events"],
    limitation:
      "DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。",
  },
  STAGE_COMPLETE: {
    versions: [1],
    suites: ["test:research-event-schema", "test:learning-activity-events"],
    limitation:
      "DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。",
  },
  STAGE_PAUSE: {
    versions: [1],
    suites: ["test:research-event-schema", "test:learning-activity-events"],
    limitation:
      "DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。",
  },
  STAGE_RESUME: {
    versions: [1],
    suites: ["test:research-event-schema", "test:learning-activity-events"],
    limitation:
      "DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。",
  },
  SCREEN_ENTER: {
    versions: [1],
    suites: ["test:research-event-schema", "test:learning-activity-events"],
    limitation:
      "DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。",
  },
  SCREEN_LEAVE: {
    versions: [1],
    suites: ["test:research-event-schema", "test:learning-activity-events"],
    limitation:
      "DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。",
  },
  VIDEO_PLAY: {
    versions: [1],
    suites: ["test:research-event-schema", "test:learning-activity-events"],
    limitation:
      "DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。",
  },
  VIDEO_PAUSE: {
    versions: [1],
    suites: ["test:research-event-schema", "test:learning-activity-events"],
    limitation:
      "DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。",
  },
  VIDEO_SEEK: {
    versions: [1],
    suites: ["test:research-event-schema", "test:learning-activity-events"],
    limitation:
      "DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。",
  },
  VIDEO_COMPLETE: {
    versions: [1],
    suites: ["test:research-event-schema", "test:learning-activity-events"],
    limitation:
      "DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。",
  },
  ADD_CONCEPT: {
    versions: [1, 2, 5],
    suites: [
      "test:research-event-schema",
      "test:stage1:integration",
      "test:map-api-v2",
      "test:map-mixed-history",
    ],
    limitation:
      "CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。",
  },
  EDIT_CONCEPT: {
    versions: [1, 2, 5],
    suites: [
      "test:research-event-schema",
      "test:stage1:integration",
      "test:map-api-v2",
      "test:map-mixed-history",
    ],
    limitation:
      "CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。",
  },
  MOVE_CONCEPT: {
    versions: [1, 2, 5],
    suites: [
      "test:research-event-schema",
      "test:stage1:integration",
      "test:map-api-v2",
      "test:map-mixed-history",
    ],
    limitation:
      "CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。",
  },
  DELETE_CONCEPT: {
    versions: [1, 2, 4, 5],
    suites: [
      "test:research-event-schema",
      "test:stage1:integration",
      "test:map-api-v2",
      "test:map-mixed-history",
    ],
    limitation:
      "CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。",
  },
  MERGE_CONCEPT: {
    versions: [1, 2, 5],
    suites: [
      "test:research-event-schema",
      "test:stage1:integration",
      "test:map-api-v2",
      "test:map-mixed-history",
    ],
    limitation:
      "CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。",
  },
  IMPORT_KIT_CONCEPT: {
    versions: [1, 2, 5],
    suites: [
      "test:research-event-schema",
      "test:stage1:integration",
      "test:map-api-v2",
      "test:map-mixed-history",
    ],
    limitation:
      "CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。",
  },
  ADD_LINK: {
    versions: [1, 2, 5],
    suites: [
      "test:research-event-schema",
      "test:stage1:integration",
      "test:map-api-v2",
      "test:map-mixed-history",
    ],
    limitation:
      "CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。",
  },
  MOVE_LINK: {
    versions:[5], suites:["test:parent-followup","test:map-api-v2","test:map-mixed-history"],
    limitation:"確定時だけ保存。未割当の表示位置は自動配置として座標を補完しない。ドラッグ取消はAPI送信前なら未観測。",
  },
  EDIT_LINK: {
    versions: [1, 2, 5],
    suites: [
      "test:research-event-schema",
      "test:stage1:integration",
      "test:map-api-v2",
      "test:map-mixed-history",
    ],
    limitation:
      "CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。",
  },
  DELETE_LINK: {
    versions: [1, 2, 4, 5],
    suites: [
      "test:research-event-schema",
      "test:stage1:integration",
      "test:map-api-v2",
      "test:map-mixed-history",
    ],
    limitation:
      "CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。",
  },
  RECONNECT_LINK: {
    versions: [1, 2, 5],
    suites: [
      "test:research-event-schema",
      "test:stage1:integration",
      "test:map-api-v2",
      "test:map-mixed-history",
    ],
    limitation:
      "CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。",
  },
  IMPORT_KIT_LINK: {
    versions: [1, 2, 5],
    suites: [
      "test:research-event-schema",
      "test:stage1:integration",
      "test:map-api-v2",
      "test:map-mixed-history",
    ],
    limitation:
      "CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。",
  },
  UNDO: {
    versions: [1, 2, 5],
    suites: [
      "test:research-event-schema",
      "test:stage1:integration",
      "test:map-api-v2",
      "test:map-mixed-history",
    ],
    limitation:
      "CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。",
  },
  REDO: {
    versions: [1, 2, 5],
    suites: [
      "test:research-event-schema",
      "test:stage1:integration",
      "test:map-api-v2",
      "test:map-mixed-history",
    ],
    limitation:
      "CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。",
  },
  MAP_SAVE: {
    versions: [1, 2, 5],
    suites: [
      "test:research-event-schema",
      "test:stage1:integration",
      "test:map-api-v2",
      "test:map-mixed-history",
    ],
    limitation:
      "予約語。現在の保存は各編集APIの確定イベントで表す。独立した保存ボタンの成功を観測したとは扱わない。",
  },
  MAP_KIT_ASSIGN: {
    versions: [1, 2, 5],
    suites: [
      "test:research-event-schema",
      "test:stage1:integration",
      "test:map-api-v2",
      "test:map-mixed-history",
    ],
    limitation:
      "CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。",
  },
  MAP_SUBMIT: {
    versions: [1, 2, 5],
    suites: [
      "test:research-event-schema",
      "test:stage1:integration",
      "test:map-api-v2",
      "test:map-mixed-history",
    ],
    limitation:
      "CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。",
  },
  MAP_AUTO_SUBMIT: {
    versions: [1, 2, 4, 5],
    suites: [
      "test:research-event-schema",
      "test:stage1:integration",
      "test:map-api-v2",
      "test:map-mixed-history",
    ],
    limitation:
      "CANCELLEDは明示的なLink作成取消だけを収集。他は取消要求が観測できず非適用。Undo/Redoは編集結果を参照する別イベント。",
  },
  FEEDBACK_CHECK: {
    versions: [1, 6],
    suites: ["test:research-event-schema", "test:learning-activity-events"],
    limitation:
      "旧v1のREJECTEDはKit不一致。v6はSUCCESSとdetails.matchedで一致/不一致を分け、REJECTED/FAILUREは操作拒否/技術失敗。DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。",
  },
  FEEDBACK_DISPLAY: {
    versions: [1],
    suites: ["test:research-event-schema", "test:learning-activity-events"],
    limitation:
      "DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。",
  },
  ASSESSMENT_EDIT: {
    versions: [1, 3],
    suites: ["test:research-event-schema", "test:assessment-events"],
    limitation:
      "DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。",
  },
  ASSESSMENT_SUBMIT: {
    versions: [1, 3],
    suites: ["test:research-event-schema", "test:assessment-events"],
    limitation:
      "DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。",
  },
  RESEARCH_ANALYSIS_VIEW: {
    versions: [1, 4],
    suites: ["test:research-event-schema", "test:server-audit"],
    limitation:
      "DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。",
  },
  RESEARCH_ASSESSMENT_CHANGE: {
    versions: [1, 4],
    suites: ["test:research-event-schema", "test:server-audit"],
    limitation:
      "DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。",
  },
  RESEARCH_EXPORT: {
    versions: [1, 4],
    suites: ["test:research-event-schema", "test:server-audit"],
    limitation:
      "DB処理の失敗/拒否とブラウザー観測の未確認を区別。UI送信前の取消は未観測。Undo/Redoはこの活動には非適用。",
  },
} satisfies Record<EventType, Policy>;
export const legacyOperationTypes = [
  "ADD_CONCEPT",
  "EDIT_CONCEPT",
  "MOVE_CONCEPT",
  "DELETE_CONCEPT",
  "MERGE_CONCEPT",
  "IMPORT_KIT_CONCEPT",
  "ADD_LINK",
  "EDIT_LINK",
  "DELETE_LINK",
  "RECONNECT_LINK",
  "IMPORT_KIT_LINK",
  "UNDO",
  "REDO",
  "MAP_SAVE",
  "MAP_KIT_ASSIGN",
  "MAP_SUBMIT",
  "MAP_AUTO_SUBMIT",
] as const;
