
# 研究イベント実装の統合検証

統合ブランチ: codex/integrate-research-event-streams  
共通基点: 7ae20d03b8a97dbd212e3fcc70ca6516889e089f（Issue #3 v2）  
統合先: C:/Users/kyoum/.codex/worktrees/integrate-research-event-streams/sb-kb-integration

## 元作業場所と実差分

| Issue | 元作業場所 | ブランチ | 反映したファイル参照数 |
|---|---|---|---:|
| #4 | C:/sb-kb-integration | codex/issue-4-map-operation-events | 22 |
| #5 | C:/Users/kyoum/.codex/worktrees/issue-5-learning-activity-events/sb-kb-integration | codex/issue-5-learning-activity-events | 11 |
| #6 | C:/Users/kyoum/.codex/worktrees/issue-6-assessment-event-logging/sb-kb-integration | codex/issue-6-assessment-event-logging | 10 |
| #7 | C:/Users/kyoum/.codex/worktrees/issue-7-researcher-system-events/sb-kb-integration | codex/issue-7-researcher-system-events | 13 |

全作業場所のHEADは上記共通基点だった。コミットとして存在しない変更をcherry-pickとは扱っていない。git diff HEADの追跡差分とgit ls-filesの未追跡ファイルを読み取り保存し、統合先に実ファイルを反映した。共有ファイルは共通祖先から三方マージし、競合を統合先だけで解消した。package.jsonの検証コマンドは和集合とした。元作業場所の編集・移動・削除・stash・reset・commitは行っていない。

integration-sources.jsonは開始時のブランチ・状態・ファイル一覧・SHA-256、integration-verification.jsonは終了時の元ファイル不変性と統合ファイルのSHA-256を保持する。全56ファイル参照を照合済み。共有ファイルの統合後ハッシュが元と異なるのは競合解決・統合修正による。

## 統合時の調整

- Stage 1のConcept/Link削除はIssue #4のv2イベントだけを保存する。Issue #7の監査ルーターはStage 1の削除をv4として重複記録しない。Session未所属Goal Mapの削除監査はv4を保持する。
- 通常提出とKit-Build提出拒否はIssue #4の記録経路へ一本化し、Issue #5側のv1 MAP_SUBMIT拒否記録を除いた。Stage完了は別の状態遷移としてv1に記録する。
- 自動提出のMapロック・切替境界・完全なv2前後状態・提出更新はIssue #4のトランザクションを採用した。成功はMAP_AUTO_SUBMIT/v2/SYSTEMの1件のみ。Issue #7からは別の事実であるSTAGE_DEADLINE/v4と、提出が戻された際の本文なしFAILUREメタデータを接続した。再起動時も同一処理を使う。
- Map v2の旧ログ参照・冪等キー・サーバー内部登録制限を保持し、v3の設問所有関係・テキスト検証・外部登録拒否と両立させた。学習者のHTTP登録はIssue #5の許可されたブラウザー観測イベントだけ。
- 評価保存はIssue #6の回答変更・提出・履歴の原子性を採用し、Issue #5のStage/Session完了イベントも同じトランザクションに含めた。回答本文は研究者専用v3だけに保持し、v1活動・v4監査へコピーしない。
- 研究者評価・メモの旧ログID／新イベントID参照、混在履歴Export、評価回答CSV、監査APIを維持した。
- Issue #7の単独検証で使っていた独立の自動提出関数は統合先では二重実装にせず、検証は実APIの周期処理を待って確認する。fixtureにはv2が必要とする正規の初期スナップショットを追加した。
- 障害注入で既存の通常ログに例外本文が出ることを確認したため、関連APIの例外出力を固定メッセージ＋許可済みエラーコードへ限定した。判定・保存・活動条件は変更していない。

## 隔離DBと結果

既存DBへ接続していない。専用Docker PostgreSQLを新規作成し、全マイグレーションと模擬seedを適用した。179089以降は179089、179090、179091、179092、179093、179095、179096の順。179094ファイルは元実装に存在しない。179095のv3制約と179096のv4制約・共通イベントの既存外部キーが共存することを確認した。integration-results.jsonに適用名、版別の主体・結果、DB照合結果を保存する。

| 検証 | 結果 |
|---|---|
| Stage 1統合（分析・Export・評価／メモ参照を含む） | PASS |
| Map API v2（CRUD・移動・再接続・統合・Kit・失敗ロールバック・Undo/Redo・DB再生照合） | PASS |
| 通常提出・自動提出v2／Map再生／Export | PASS |
| 旧ログのみ・旧＋新の混在履歴再生 | PASS |
| Undo/Redo単体 | PASS |
| 活動・動画・画面観測・Kitフィードバック | PASS |
| 評価履歴v3（両群・事前事後・同文再保存・拒否・失敗・Export） | PASS |
| 研究者／システム監査v4・認可・保存障害・削除後保持 | PASS |
| イベントスキーマ・認可・順序・既存行保持 | PASS |
| 監査対象解決失敗時の変更阻止 | PASS |
| 実プロセス再起動による回復・二重提出防止 | PASS |
| 実6活動のv1〜v4結合シナリオ | PASS |
| 例外出力の許可リスト | PASS |
| バックエンド型検査・Lint・ビルド | PASS |
| フロントエンド型検査・Lint・ビルド | PASS |

新しいtest:integrated-streamsは、研究者のSession作成から6活動を実APIで通す。研究者によるConcept削除がv2/RESEARCHERの1件、学習者通常提出がv2/LEARNERの1件、システム自動提出がv2/SYSTEMの1件であることを全schemaVersionを横断して確認する。Kit不一致提出もREJECTEDの1件だけ。各Mapのmixed-historyはREPLAYABLEとなりDB状態と一致する。評価履歴が研究者用JSONに含まれ、学習者がイベント一覧を取得できないことも確認した。

test:integration-invariantsでは成功した同一Mapの通常／自動提出の重複0件、v4への状態・本文混入0件、v3設問のSession不一致0件を照合した。障害注入による失敗・拒否イベントは意図した別結果として保持する。

## Issue #8へ進む前の状態

今回の結合検証で未解消の統合エラーはない。変更はすべて統合先に未コミットで保持する。Issue #4〜#7のクローズ、PR作成・マージは行っていない。

一般的な通信再送・未送信キュー・キーなし再試行の同一要求判定はIssue #8で扱う。この作業では追加していない。ブラウザー強制終了の未観測、YouTube／外部動画の観測限界、秘密情報パターン検出の限界、履歴移行前の欠測は元仕様どおりで、統合によって過去のイベントを推測生成しない。

再実行時は新規の隔離DBを指定し、test:stage1:integrationを先に実行してから各API検証を行う。test:server-recoveryは外部の検証APIを停止した状態で実行する（内部でAPIを起動・再起動する）。実データDBへこれらのfixture作成・障害注入検証を実行しない。

