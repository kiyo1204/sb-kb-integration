# 期限直後のHTTP 500／DBデッドロック調査（2026-10-31）

## 範囲と元の観測

専用worktree `fix-autosubmit-deadlock/sb-kb-integration`、ブランチ `codex/fix-autosubmit-deadlock`。起点はmainのb73e18c5c3cea16d5c8173d4851b0f50efa6b2a1。開始時にorigin/mainとremote mainが同コミットであることを確認した。元の統合worktreeは1c505f9のまま、7文書の変更・未追跡成果物を保持する。

元の実機LAN記録は2026-10-31 03:58:43.220ZのSESSION分類HTTP 500と、03:58:43.212ZのDBデッドロック。統制群開始03:57:41.919482Z、実験群開始03:57:41.957824Z、共通60秒。実験群は03:58:42.204610Zに自動提出済みだった。元記録にはAPIパス・要求相関ID・ロック循環がないため、当日の失敗要求そのものを後から一意には特定できない。

今回は実機LANを再試験せず、Windows上のAPI＋PostgreSQL 17の新規模擬コンテナーで同種の競合を再現した。Node v24.15.0、Docker Engine 29.7.2、ブラウザー回帰はローカルEdge。GitHubの操作・CI実行、既存DB・研究データへの接続は行わない。

## 再現した原因

実APIは `POST /api/sessions/:sessionId/events`（SCREEN_ENTER、学習者、固定Idempotency-Key）。認可済みの自分のSession/Stageを用い、次の順序をテスト専用advisory gateで固定した。ゲート・故障トリガーは模擬DBにのみ作り、finallyで除去する。クライアント時刻で期限を延ばす製品変更はしていない。fixture開始時刻を過去に置くテストなので、今回の検証は実時間60秒待機ではない。

|処理|保持したロック|次に待つもの|
|---|---|---|
|観測イベントAPI|Session内のresearch_event_counters行|research_events INSERTの外部キー確認が要求するSession/MapのKEY SHARE|
|期限監査|SessionのFOR UPDATE|同じSessionのresearch_event_counters行|
|自動提出・Mapイベント|MapのFOR UPDATE（初回境界トリガーも再取得）|同じSessionのresearch_event_counters行|

この循環をDBログとpg_blocking_pidsで確認した。修正前APIはHTTP 500 / event_save_failed / logSaved:false。イベント・receiptはロールバックされ、処理完了後の同じキー再送は201、同じeventId/sequenceのACKを返した。

採取例（すべて新規模擬DB、UTC）：

- 08:38:57.368：API PID116がtransaction781/PID120を待ち、PID120がtransaction779/PID116を待つ。外部キーのKEY SHARE対象はsessions。
- 08:38:06.945：API PID104がtransaction770/PID103を待ち、PID103がtransaction771/PID104を待つ。対象はmaps。
- 08:40:39.669：アプリ側Mapロックを弱めた後も、初回境界トリガーのFOR UPDATEが残り、PID140/PID139間でmapsのKEY SHARE待ちが再発した。

固定SQLSTATE分類は40P01。証拠JSONには時刻・PID・トランザクション番号・待ち先・関係テーブル名だけを保存し、任意例外本文・SQLパラメーター・コード・トークン・回答本文は含めない。

## 修正

- `backend/src/system-submission.ts`：期限監査のSessionロックをFOR NO KEY UPDATEへ。
- `backend/src/index.ts`：共通Mapロック3経路と、失敗・拒否記録のMapロックをFOR NO KEY UPDATEへ。自動提出、通常編集、Undo/Redoは引き続き同じMap行で排他される。
- `backend/src/sessions.ts`：活動開始・完了のSession/StageロックをFOR NO KEY UPDATEへ。期限後の活動完了と画面観測の競合も対象にする。
- 追加マイグレーション `1791050000000_allow_boundary_event_key_share.js`：インストール済みvalidate_map_history_boundaryの行ロックだけをFOR NO KEY UPDATEへ変更。定義が想定と異なる場合は拒否する。既適用マイグレーション・既存行・旧ログ・境界スナップショット・FK・一意制約は変更しない。旧ログ追記禁止と境界不変のトリガーを維持する。

これらはIDを変更しない更新の排他ロックであり、他の更新・削除とは引き続き競合する一方、外部キーのKEY SHAREとは共存する。キー変更やデータ削除を許可する変更ではない。PostgreSQL公式の[行ロック互換表](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS)と一致する。

イベントカウンターや冪等キー、期限時刻・群割当・提出条件・保存形式は変更しない。Map更新・境界・イベントは引き続き同一トランザクション。HTTP 500を成功に変換する処理や広範な自動リトライを追加していない。アプリと179105を組み合わせて検証しており、適用前のDBで同じ結果を保証しない。既存DBへの適用作業は今回行わない。

## 新しい回帰検証

`backend/src/scripts/verify-autosubmit-deadlock.ts` / `test:autosubmit-deadlock`を既存suiteへ追加。既存CIは同じsuiteを呼ぶため新テストもその対象になるが、今回はGitHub CIを実行していない。

1. 統制群：観測イベントが連番を保持した状態で、実際の期限監査を重ねる。
2. 実験群：先行する期限監査から分離するため、実際の自動提出UPDATEをMapロック後に待ち合わせ、Map付き観測イベントと競合させる。初回境界も作られる。
3. 統制群：期限後の活動完了APIと観測イベントを重ねる。活動完了が先行し監査が未観測の場合に、存在しない期限監査イベントを要求しない。
4. 自動提出の成功イベント保存を故障注入で拒否し、MapはDRAFT、提出時刻はnull、初回境界0件へロールバックすることを確認。故障解除後の既存スキャンで成功1件・SYSTEM actor・REPLAYABLEへ回復する。

各競合で、HTTP 201、同じキーの再送と3並行再送のeventId/sequence一致、receipt1件、研究者向け送信状態の申告ACKとサーバー保存数の区別、Session内の連番・時刻を検証。統制群の期限前2マップ取得と期限後404/一覧409、研究者取得200を検証。実験群の期限前取得200、期限後404、自動提出1件、活動は自動完了せず、再生とDB状態の一致を検証する。これは今回fixtureの送信ACKであり、元LANリハーサルの削除ACK待ち1件とは別で、後者は未解決のまま。

## 実行コマンドと準備・失敗の区別

全DBコマンドは専用worktreeでNODE_ENV=development、STAGE1_MOCK_DATA=ONLY_SYNTHETIC、既存DATABASE_URLを除いた状態で実施。db:mockのDockerラベル・nonce・loopback公開・専用DBマーカーを照合する。

```powershell
npm ci --prefix backend --prefer-offline --no-audit --no-fund
npm ci --prefix frontend --prefer-offline --no-audit --no-fund
npm run db:mock --prefix backend -- create --name stage1_mock_deadlock_20261031 --mock-data-only
npm run db:mock --prefix backend -- migrate --name stage1_mock_deadlock_20261031
npm run db:mock --prefix backend -- seed --name stage1_mock_deadlock_20261031
npm run build --prefix backend
# 修正前: DEADLOCK_EXPECT_BASELINE=1 / RESEARCH_SUITE_ONLY=test:autosubmit-deadlock
npm run db:mock --prefix backend -- suite --name stage1_mock_deadlock_20261031
# 179105追加後、同DBでmigrate、baselineフラグを外して再検証
npm run db:mock --prefix backend -- migrate --name stage1_mock_deadlock_20261031
npm run db:mock --prefix backend -- suite --name stage1_mock_deadlock_20261031

npm run db:mock --prefix backend -- create --name stage1_mock_deadlock_regression --mock-data-only
npm run db:mock --prefix backend -- migrate --name stage1_mock_deadlock_regression
npm run db:mock --prefix backend -- seed --name stage1_mock_deadlock_regression
# RESEARCH_BROWSER_CHECKS=1 / BROWSER_CHANNEL=msedge / selectionなし
npm run db:mock --prefix backend -- suite --name stage1_mock_deadlock_regression
npm run typecheck --prefix backend
npm run lint --prefix backend
npm run build --prefix backend
npm run typecheck --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
```

- Docker Engine停止で初回準備が待機。Desktop起動後に新規DB作成を実施。
- 初回の再現補助は自動提出終了前に再送して再度500となり停止。完了後の再送に揃えて、修正前2条件の500再現・ロールバック・再送成功を確認した。
- 編集補助はWindows既定cp932で一度停止。UTF-8を明示して続行した。セッション側だけの変更で通った弱い試験を最終結果には採用せず、自動提出がMapロックを保持する強い待ち合わせへ変更し、残る境界トリガー競合を検出した。
- 179105後、活動完了が期限スキャンに先行する場合にも期限監査イベントを必須とした試験が停止。製品条件に合わせて未観測を許容し、3競合＋保存失敗の4条件が通過した。
- 新worktreeのcore.autocrlf=trueにより、カタログMarkdown、サンプルJSON、サンプル辞書のバイト照合が順に停止した。内容差ではなくCRLF/LFだけであることを確認。専用worktreeの照合ファイルをLFへ揃え、CSVの規定CRLFは維持して再実行した。元の7文書・Git共通設定は変更しない。

## 最終結果と後片付け

|確認|最終結果|
|---|---|
|修正前の専用再現|2条件で期待した500を再現、イベント/receiptロールバック、障害後の同じキー再送201|
|修正後の専用再現|3競合＋イベント保存失敗/回復の4条件PASS。新規DBの全体suite内でも再実行してPASS|
|全体suite|既存29件＋test:autosubmit-deadlockの計30/30件PASS。混在履歴、Undo/Redo、Map API、通常/自動提出、評価、監査、Export、削除、再送、再起動、ブラウザー5件を含む|
|静的検査|backend/frontendのtypecheck・lint・build、6/6件PASS。git diff --checkもPASS|
|追加マイグレーション|調査DBに37→38本、新規回帰DBに全38本を順番に適用。再度migrateはNo migrations to runで成功|
|修正後のDBログ|新規回帰DBの稼働全期間でdeadlock detectedは0件。修正前/段階修正を含む調査DBの6件と混同しない|
|後片付け|専用コンテナー2個をID/名前/purpose/nonce/DB名/loopback限定ポートで照合後、匿名ボリューム込みで除去。不在を確認|
|元作業の保持|7変更文書＋未追跡を含む16ファイルのSHA-256が全一致。元ブランチ/HEAD、削除ACK記録、Gitステージ状態を保持|

後片付け対象：stage1_mock_deadlock_20261031（9bfd39149ee39bfa0a5063286cf5279f81206267dc6a386359b1e812665554b7）、stage1_mock_deadlock_regression（afee81e14a88c146669f1b6498c22fc6a321e213e7ba5629ee55e673b04e4b72）。17:51 JSTに除去済み。既存DBや他のコンテナーは対象にしない。テスト準備で揃えた文書・サンプルの改行は、このworktreeの元のチェックアウト形式へ戻し、内容差を残していない。

証拠：

- [修正前API結果と安全なDB待ち情報](autosubmit-deadlock-baseline.json)
- [修正後4ケース](autosubmit-deadlock-cases.json)
- [全体30件の結果・所要時間](autosubmit-deadlock-regression-suite-results.json)
- [整合性検証結果](autosubmit-deadlock-regression-invariants.json)
- [合成20Session/4000イベントの参考計測](autosubmit-deadlock-regression-scale-results.json)（実端末20台・本番性能の保証ではない）
- [静的確認・元ファイル保持・後片付け](autosubmit-deadlock-verification.json)
- [修正前限定suite](deadlock-baseline-suite-results.json)、[修正後限定suite](deadlock-fixed-suite-results.json)。各1検証であり、全体30件とは区別する。

実機LAN再現、実参加者データ、既存研究DBへの適用、本番同時利用の検証には広げていない。元のLANの個別APIとの対応は未確認であり、この再現原因が当日の唯一の原因だったとも断定しない。Issue #2/#5/#11の状態・判断、削除ACK待ち1件、標準起動/停止の未確認状態は変更しない。GitHub CI・コミット・push・PR・マージ・デプロイは実施せず、修正を専用worktreeの未コミット状態で保持する。

## 追補：PR準備時の再照合

前段のGitHub操作なし・未コミットという記述は調査終了時点の記録である。PR準備では、前回結果だけではソース指紋との対応を確定できないため、別の新規模擬DBで6静的確認と全体30件を再実行した。検証前後143ファイルのSHA-256一致、PR対象7ソースのGit blob ID、DB全38本・デッドロック0件・専用DB除去を[ソース対応付き記録](autosubmit-deadlock-pr-source-verification.json)に保存した。[PR前レビュー](autosubmit-deadlock-pr-review.md)を参照。元のLAN要求との個別API一致、実機LAN再試験、既存DB適用・復元訓練、本番運用は未確認のままである。CIの結果はPR上の実走行を別途参照する。
