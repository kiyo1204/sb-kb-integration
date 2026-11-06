# 群なし5活動フロー・アンケート・初期概念

## プロトコルと互換性

新規作成APIはSTAGE1_5だけを作成する。LESSON → PRIOR_MAP → KB_MAP → INTEGRATION_MAP → SURVEY。群はnullで、SELF_STUDY、PRE_ASSESSMENT、POST_ASSESSMENTを作らない。旧STAGE1_4/STAGE1_6の意味、順序、群、評価、保存済みイベントは変更しない。旧プロトコルのAPI検証は隔離DB専用fixtureで継続する。公開APIから旧プロトコルを新規作成する経路は残さない。

179106はmain最大179105の後へ追加。sessionsの許容プロトコル・コード制約とsession_stagesのSURVEYを拡張し、新しいsurvey_questions/survey_answers/session_seed_concepts/seeded_map_conceptsを追加する。既存行のUPDATE/DELETE、旧評価の変換、通常起動時のリセットはしない。破壊的なdownは拒否する。適用確認は新規の使い捨て模擬DBのみ。既存研究DBへの適用・復元訓練は未確認。

## 作成と初期概念

研究者は当該セッションのKitを選び、その既存kit_concept_items.idを重複なしで選択する。0個から、そのKitの利用可能な全概念まで選択でき、小さな選択数制限は設けない。Map全体の既存上限（概念1000、リンク2000、状態4MB、ラベル512文字等）は維持する。存在しないID・別KitのIDはサーバーで拒否する。別セッションの独立した選択情報をコピーするAPIはない。

新しいPRIOR_MAPの作成時に選択概念だけを格子配置し、教師側のリンク・位置・正解接続をコピーしない。CLONED_FROMのProvenance、初期スナップショット、session_seed_concepts/seeded_map_conceptsで由来を識別する。研究者のセッションJSONはseedConceptsにKit部品ID・元Concept ID・配置先IDを出力する。学習者へはisSeedフラグを返し、教師Goal Mapやその接続を返さない。

この固定条件は学習者マップ（PRIOR_MAP）に適用する。初期Conceptの名前変更・削除・統合はAPIとDBトリガーで拒否し、画面の該当操作も無効にする。移動とリンク作成・Undo/Redoは許可する。新規追加したConceptや統合マップの複製Conceptは既存操作条件を維持する。初期化は学習者のADD_CONCEPTと偽って記録せず、初期状態として再生する。

## アンケート

研究者の作成要求はsurveyQuestionsを含む。設問は1〜1000、promptは1〜10000文字。回答形式はTEXT（自由記述）、CHOICE（単一選択）、RATING（整数段階評価）。CHOICEは重複なしの2〜1000選択肢、1選択肢512文字以内。RATINGは-100〜1000の整数範囲で最小<最大、幅1000以内、両端表示ラベル512文字以内。自由記述は既存評価と同じ100000文字以内・空白だけや既知の認証情報パターンを拒否。未知の秘密情報の完全検出は保証せず、認証情報・個人情報を入力しない。

PUT /api/research/stage1/sessions/:sessionId/survey/questions はNOT_STARTEDのセッションをロックして追加・編集・順序変更・削除を保存する。既存設問IDは同じセッションのものだけ許可する。開始と設定保存は同じ行で排他し、開始後は409。教師Kit選択・初期概念選択は作成時に固定する。

GET /api/session-stages/:stageId/survey は認証済み本人の現在進行中SURVEYの設問・現在回答だけを返す。POST survey/save は確定した途中回答を保存し、survey/submit は必須設問の未回答・選択肢不一致・範囲外・別設問IDをAPIでも拒否する。途中保存は未入力項目を残せるが、入力として送った空白回答は保存しない。任意設問の省略は回答なしとして扱う。省略値を推定して補わない。

回答変更・提出・活動／セッション完了・イベント挿入を同一DBトランザクションで確定する。イベント保存失敗なら全てロールバック。Idempotency-Keyは既存operation_receiptsの契約を使い、同一要求の再送を二重反映しない。拒否・技術失敗は安全な理由だけを別フェーズで記録し、本文を含めない。DB停止で監査も保存できない場合はlogSaved:falseとする。

学習者画面は現在活動だけを示し、全活動一覧・次活動予告を追加しない。回答は画面内で保持し、明示的に保存する。新アンケート本文をlocalStorage/IndexedDBの下書きや観測イベント送信待ちキューへ入れない。画面を閉じる前に保存が必要であり、ブラウザー終了前の未保存回答の復元は保証しない。再送情報のIndexedDBには既存契約どおりハッシュ・キー・時刻だけを保持する。

## 統合マップと時間

既存のサーバー時刻・共通制限時間をセッションへ保存する。新5活動は期限前の手動提出を許可し、その提出とINTEGRATION_MAPの完了を同時に行うが、SURVEYは学習者が開始する。期限後の自動提出は既存の各MapトランザクションとMAP_AUTO_SUBMIT（SYSTEM）を再利用し、活動は自動完了しない。「次へ」で完了してSURVEYへ進む。通常提出はMAP_SUBMITと区別する。期限後は学習者の再表示・編集を拒否する。旧群別6活動の時間・提出・自主学習例外は変更しない。

## イベントと出力辞書

v1〜v6を再解釈せずv7を追加。SURVEY_EDIT / SURVEY_SUBMITのtargetTypeはASSESSMENT（回答一般）、activityはSURVEYであり旧評価のPRE/POSTを付与しない。actorは認証からLEARNER/RESEARCHER、群・仮名はセッションから確定。targetIdは編集時questionId、提出時stageId。クライアント時刻はNOT_APPLICABLE、サーバー時刻とセッション内sequenceを保持する。

SURVEY_EDITの成功状態は {questionId: UUID, kind: TEXT|CHOICE|RATING, value: string|integer|null} だけ。before/afterはDBから取得し、同じ値の保存ではイベントを増やさない。nullは観測した回答なしで、MISSING（不明）とは異なる。提出は本文なしのライフサイクルイベント。拒否・失敗は本文なしのREJECTED/FAILUREとVALIDATION/CONFLICT/SERVER。未知フィールド・任意JSONを拒否し、学習者の直接イベント登録は不可。UI送信前の取消や1文字ごとの入力は未観測。

研究者のみのGET /api/research/stage1/sessions/:sessionId/survey は設問・現在回答・v7履歴を返す。survey-answers.csvはprotocolKey/participantCode（公開仮名）/sessionId/stageId/questionId/kind/prompt/required/answer/updatedAtで、未回答は空、answerはTEXT/CHOICE文字列またはRATING整数。旧assessment-answers.csvは旧評価だけを保持する。

共通イベント出力schemaVersion=3は旧列の意味を維持しprotocol_keyを末尾に追加。survey_events.csvは共通結合キー+question_id/before_value/after_value/before_json/after_json。旧assessment_events.csvにv7を混ぜない。JSON/events.csv/各詳細CSVは同じ絞り込み集合を使う。日時はUTCのISO 8601、未設定群はnull（CSV空欄）、CSVの式保護は既存共通実装を使う。サンプルはdocs/samples/event-export、実際の列辞書は同フォルダーdata-dictionary.md。

## データ管理・確認範囲

確認付きセッション／参加者削除に新4テーブルを含め、件数プレビュー・同一トランザクション・失敗時ロールバック・失効した学習者コードの再送拒否を維持する。所有者不明の旧下書きの隔離保持は変更しない。端末ACK待ち・バックアップ・ブラウザー保存域喪失など既存の限界も維持する。

本変更の検証は隔離模擬DB・単一PCのEdge/模擬APIを利用する。実機LAN、10〜20端末の同時利用、既存研究DB適用、本番運用は確認済みとしない。実行結果と準備／再実行の区別はsession-flow-survey-verification.mdを参照する。
