import { EXPORT_VERSION, commonColumns, detailColumns } from "./event-export-contract.js";
const descriptions: Record<string, string> = {
  event_id:
    "イベント結合キー。新形式は保存済みUUID、旧ログはlegacy:UUID。全CSVの参照先。",
  source_format: "EVENT / LEGACY。旧ログを新イベントと再解釈しない。",
  schema_version: "保存済み1/2/3/4/5/6。旧形式は未設定（null）。",
  session_id: "Session UUID。Session未所属監査はnull。",
  learner_id:
    "P-UUID。明示的に関連付けたSession間で共有する仮名。人物をコード一致で推測しない。再発行後は現在の仮名で投影する。",
  study_group: "EXPERIMENTAL / CONTROL / null。旧ログはSessionの現在情報。",
  activity: "保存済み活動種別。旧ログは関連Stageの種別。未所属はnull。",
  stage_id: "関連Stage UUID。",
  map_id: "関連Map UUID。",
  actor_type:
    "LEARNER / RESEARCHER / SYSTEM。旧ログは未記録のためUNKNOWN。共有研究者コードでは個人識別不可。",
  event_type: "カタログの固定名。判別不能な旧種別はUNKNOWN_EVENT_TYPE。",
  target_type:
    "SESSION/STAGE/MAP/CONCEPT/LINK/ASSESSMENT/VIDEO/FEEDBACK/SCREEN。",
  target_id: "保存済み対象UUID。",
  outcome:
    "SUCCESS / FAILURE / REJECTED / CANCELLED / UNKNOWN。旧ログは成功と推測せずUNKNOWN。旧v1 FEEDBACK_CHECKのREJECTEDは確認完了時の不一致であり通信失敗ではない。",
  feedback_match: "v6 FEEDBACK_CHECK/SUCCESSの一致判定。true=一致、false=学習上の不一致、null=結果未保存/非該当。旧v1はoutcomeを保持し、この列を補完しない。",
  reason_code: "保存済み固定理由。旧ログは未記録（null）。",
  sequence_number: "10進整数文字列。JS/Excelの浮動小数精度で丸めない。",
  sequence_scope:
    "MAP（旧ログ）/SESSION（新形式）/GLOBAL（未所属監査）。混在を通した単一の連番ではない。",
  client_timestamp: "申告されたクライアント時刻。UTC ISO 8601、未記録はnull。",
  client_time_quality:
    "OBSERVED/ESTIMATED/MISSING/NOT_APPLICABLE/UNKNOWN。申告はサーバーの時刻確定とは異なる。",
  server_timestamp:
    "保存されたサーバー時刻をUTC ISO 8601で出力。期間フィルターの基準。旧ログは元のtransaction timestampの場合がある。",
  related_event_id:
    "新UUIDまたはlegacy:旧UUID。関連元は期間/条件の外にある場合がある。自動補完しない。",
  related_legacy_operation_log_id: "保存済み旧ログ参照UUID。",
  before_quality:
    "保存済み変更前の品質。旧ログはUNKNOWN。マスク状態はpayload_statusで別途確認。",
  after_quality: "保存済み変更後の品質。旧ログはUNKNOWN。",
  payload_status:
    "EXPORTED / NO_PAYLOAD / REDACTED_OR_UNSUPPORTED / OVERSIZE。非公開や未対応を欠測/該当なしと混同しない。",
  boundary_status:
    "LEGACY_ONLY / WITHIN_LEGACY_BOUNDARY / INVALID_AFTER_BOUNDARY / AFTER_LEGACY_BOUNDARY / MISSING_BOUNDARY / NOT_APPLICABLE。メタデータ確認であり再生成功の保証ではない。",
  legacy_boundary_count: "保存済み切替境界の旧件数。未導入はnull。",
  legacy_boundary_last_id: "保存済み境界直前の旧ログUUID。",
  before_json: "認可・検証した変更前構造。",
  after_json: "認可・検証した変更後構造。",
  details_json: "許可された詳細。v6のmatchedは真偽値。任意本文は不可。",
  stage_started_at:
    "Stage DBの開始時刻（UTC）。イベントを推測生成した値ではない。",
  server_elapsed_ms:
    "server_timestamp - stage_started_at。保存までの差であり作業/視聴時間ではない。負数を0で補正しない。",
  elapsed_quality:
    "MISSING / INCONSISTENT_ORDER / COMPUTED_SERVER_DIFFERENCE。",
  recorded_duration_ms:
    "元のdetails.durationMsがある場合のみ。測定主体・正確性を推測しない。",
  from_seconds: "保存済みシーク元の秒数。",
  to_seconds: "保存済みシーク先の秒数。",
  timepoint: "PRE / POST / null。研究者向けの評価時点。",
  question_id:
    "v3確定編集に明示される設問UUIDのみ。提出の対象Stageを設問とみなさない。",
  before_answer: "v3編集前の回答。初回null。研究者専用。",
  after_answer: "v3編集後の回答。研究者専用。",
};
function typeOf(key: string) {
  if (key === "feedback_match") return "boolean | null";
  if (key === "schema_version") return "integer | null";
  if (key.endsWith("_ms") || key.endsWith("_seconds")) return "number | null";
  if (key.endsWith("_json")) return "JSON | null";
  return "string | null";
}
export function dataDictionary(chronological = false) {
  let text =
    `# 研究イベント出力データ辞書 v${EXPORT_VERSION}\n\nJSON: export_schema_version=${EXPORT_VERSION}。日時は全てUTCのISO 8601（Z）。新形式イベントのschema_version 1〜4は変更せず、5は保存Link位置を含む状態、6はKit確認結果。従来の共通CSV列は意味と順序を保ち末尾にfeedback_matchを追加。CSVはUTF-8 BOM、CRLF、RFC 4180引用符。nullは空セル。空文字とnullの解釈には品質とJSONを参照する。整数連番/IDは文字列として取り込む。\n\n`;
  text +=
    "## 共通抽出\n\n条件内の選択肢はOR、異なる条件はAND。空配列は無制限。Session/仮名IDフィルターは未所属監査を除く。群/活動のUNASSIGNEDはnullを選択する。期間はserver_timestampの開始以上・終了未満 [from,to)。入力はZまたは時差を必須としUTCへ正規化する。空結果も0件JSONとヘッダーのみCSVを作る。\n\n同じexport_idの全ファイルは1つのREPEATABLE READスナップショットから一度だけ生成する。後から同条件で再生成したexport_idとは同一集合を保証しない。期間外の関連イベントや未観測の終了は補完しない。\n\n";
  text +=
    "## 順序と旧履歴\n\nSession UUID昇順（未所属は最後）、旧ログを先、新イベントを後とする。旧ログ内はMap UUID→元のMap連番→ID、新形式はSession/Global連番→ID。サーバー時計の前後だけで切替境界を逆転させない。旧ログにはイベント版・主体・結果がないため補わない。legacy:UUIDは出力用の識別接頭辞でありDB変更ではない。境界の完全再生照合は既存の混在履歴APIで確認する。絞り込み出力単独で完全再生できるとは限らない。\n\n";
  text +=
    "## 安全性とCSVの復元\n\n研究者専用。参加者コード・認証ヘッダー・アクセスコード・トークン・Cookie・例外・任意JSONを新出力へコピーしない。Map/評価はバージョン別に検証し、既知資格情報との一致も確認する。不正・未対応・上限超過の本文は省略しpayload_statusを残す。未知の秘密情報や自由記述内の個人情報を完全検出するものではない。JSONの回答/ラベルは必要な研究内容として研究者だけに含める。\n\nCSVのテキストが空白/制御・書式文字の後に =,+,-,@（全角を含む）で始まる場合、またはタブ/改行で始まる場合は先頭にアポストロフィを追加する。数値型の負値は数値のまま。JSONは元の検証済みテキストを保持する。CSVのアポストロフィを無条件に取り除かず、厳密な文字列復元にはJSONを用いる。\n\n";
  text += "## 共通列（全CSVに共通）\n\n|列|型|意味|\n|---|---|---|\n";
  for (const key of commonColumns)
    text +=
      "|" +
      key +
      "|" +
      typeOf(key).replaceAll("|", " / ") +
      "|" +
      descriptions[key] +
      "|\n";
  for (const [name, cols] of Object.entries(detailColumns)) {
    text +=
      "\n## " +
      name +
      "\n\n共通列に次を追加する。各行はevent_idでevents.csvへ結合する。複数の用途別CSVへ同じイベントが含まれることがあるため、用途別件数を合計して総イベント件数にしない。\n\n|列|型|意味|\n|---|---|---|\n";
    for (const key of cols.filter(
      (x) => !commonColumns.includes(x as (typeof commonColumns)[number]),
    ))
      text +=
        "|" +
        key +
        "|" +
        typeOf(key).replaceAll("|", " / ") +
        "|" +
        descriptions[key] +
        "|\n";
  }
  if (chronological) text = text.replace(/Session UUID昇順[\s\S]*?逆転させない。/, "閲覧検索経由：server_timestamp昇順、同値はevent_id順。この順序は履歴再生順とは異なる。");
  return (
    text +
    "\n## 分類\n\nmap_operations: MAP/CONCEPT/LINK対象。activity_times: 開始・完了・期限・可視性・動画・フィードバックの時間観測。assessment_events: ASSESSMENT対象（v3回答とv4問題設定を区別）。system_events: SYSTEM主体。researcher_events: RESEARCHER主体。JSONは各イベントのbefore/after/detailsと時間由来を保持する。欠損申告は確定イベントとは別なのでこのイベント集合には追加せず、既存delivery出力で確認する。\n"
  );
}
