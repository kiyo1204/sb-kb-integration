# PR #36 通常規模出力の追加検証（2026-11-08）

## 基点と変更

`C:\Users\kyoum\.codex\worktrees\research-note-safety\analysis-layout-repo`、`codex/research-note-secret-protection`、HEAD `d0c39166a0bf0987a749640a9aaa98da7eb9255b`。開始時の13 tracked変更および前回の未追跡テスト・文書・結果を保持した。GitHub PR #36はopen、base main (`359ae31`)、同じheadで、公開済みPR/push CIはともに成功。今回の未コミット変更を公開CIで検証したという意味ではない。

外側の応答差し替えは共通照合処理に存在しない。各routeが型付きエラーを422/503へ変換した後、既存監査middlewareへ渡す構成を維持した。通常データで20,000回上限を再評価したところ、不必要な拒否を再現したためコードを修正した。

変更は `research-output-safety.ts` のリクエスト内のexact SHA-256 digestキャッシュ。全体文字列、空白区切り、連続文字列、同じ長さの窓に同じ値が現れても、そのexact値のハッシュ計算は1回にする。異なる長さ・位置の候補窓の列挙は維持する。20,000回という実SHA計算上限は引き上げていない。

UUID等の構造値も検査を省かない。認証形式が英数字・`_`・`-`を許すため、「UUIDなので秘密を含み得ない」と一律に判定する契約は採用しなかった。利用者テキストも同じ検出範囲を維持する。通常の36文字UUID1件は重複計算を含む18回から15回へ減る。snapshot・API内の別照合でもexact digestを共有する。キャッシュは安全/不安全という判定結果ではなくdigestなので、後続loadで照合先のハッシュが変われば必ず新しい集合と比較する。新規回帰でこれを確認した。

キャッシュはAsyncLocalStorageのリクエストstore内にあり、モジュール共通カウンターではない。新規digest格納にも残予算を要するため、格納件数は20,000以下。応答終了後の利用拒否、並行予算分離、合算超過、長文の安全な拒否は前回テストを維持する。既存DB変換・schema変更・秘密の平文保存は追加しない。

## 通常データの再現経路

新規専用DB `stage1_mock_normal_1108` のみを使用。既存の `verify-research-note-safety.ts::fixture` と旧履歴の保存形式を再利用し、`research-safety-normal-output.ts::checkNormalOutput` を追加した。

- 20 Session（旧4活動7件、新5活動7件、旧6活動6件）。
- 合計54マップ。各マップに165概念を追加し、隣接概念間にLinkを作成。既存fixtureのPRIOR概念2件・Link1件も保持。
- 各SessionのPRIORに200件、全体4,000件の旧形式マップ操作履歴。before/afterにテスト専用ラベル・位置・IDを持つ。旧履歴で初期snapshotがない場合の既存の注意表示を変更しない。このfixtureを履歴再生の完全性検証とは扱わない。
- 全Sessionに研究者評価理由・メモ。5活動には設問と回答、6活動には旧評価問題と回答を追加。
- API分析、生データJSON、操作CSV、4活動の評価/メモCSV、アンケートJSON/CSV、旧評価JSON/CSVを計100要求。全対象は通常の日本語とサーバー生成UUID。

同じ生成条件の修正前実装は **56/100要求が422**、修正後は **100/100要求が200**。修正後は関連suiteの別の空DBでも100/100成功した。fixtureのUUIDは各回新規生成し、内容・件数・構造を同じにした。

結果: `safety-normal-before-normal-output.json`、`safety-normal-after-normal-output.json`、`safety-normal-related-normal-output.json`。

20 Sessionを一度に返す共通分析APIは存在しないため、各Sessionは別要求として検査した。これに加えて既存 `test:event-scale` を選択し、別途20 Session・4,000 VIDEO_PLAY研究イベントの一括view、JSON、CSV、ID・順序・時刻・outcomeの一致を検証する。イベント一括Exportは `normaliseEvent` の別契約を使い、この共通候補窓照合を呼ばない点は区別する。

## 測定条件と結果

Windows、Node v22.23.4、AMD Ryzen 7 7730U、Dockerの専用PostgreSQL。`performance.now()`の壁時計ms、ローカル実API・認証・監査記録・本文の全受信を含む。通常出力は各Session/経路1回（分析/JSON/操作CSVは各20標本）。これは同一payloadの多数回反復ベンチマークではない。20 Sessionは蓄積データ規模であり20台同時接続を意味しない。

| 経路 | 修正前中央値ms（422を含む） | 修正後中央値ms（全200） | 標本数/実装 |
|---|---:|---:|---:|
| 分析API | 153.31 | 172.68 | 20 |
| Session JSON | 153.12 | 148.68 | 20 |
| 操作CSV | 149.22 | 149.47 | 20 |
| アンケートCSV | 33.48 | 38.96 | 7 |
| 旧評価CSV | 34.67 | 32.48 | 6 |

拒否から全件検査完了へ動作が変わったため、上表を単純な高速化率として扱わない。20,000回は今回の普通の大きな出力を通しつつ、依然として異なる長い英数字の照合を打ち切る上限として維持する。すべての最大サイズ・全履歴件数を通す保証ではない。超過時は部分出力ではなく固定理由の422とする。

長文・通常文章・複数行の関数/API測定も対象テスト内で再実行した（関数/API各5回、過去の無制限列挙の再現ループ3回、並行要求は1バッチ）。`safety-normal-before-performance.json` と `safety-normal-after-performance.json` に修正前後を分けて保存。前回のNode24測定・前回文書の値と区別する。

## 監査・安全契約

各共通照合APIの超過・照合先障害・保存/出力境界は `checkSafetyBudget` で実API再検証する。

| 原因 | HTTP | 監査対象ルートでの outcome / reason |
|---|---|---|
| 合算予算超過 | 422 `safety_budget_exceeded` | REJECTED / VALIDATION |
| 照合先query失敗 | 503 `safety_lookup_unavailable` | FAILURE / SERVER |

監査対象外だったGoal Map転送、survey/assessment JSONへ新たな監査契約を作らない。CSVヘッダー設定後も失敗はJSONのみとなり、添付ヘッダーを除去する。全検査が送信開始前に完了する。拒否時の評価・メモ・Map/Kit・受付票の部分更新なし、拒否/失敗監査1件のみ、本文/秘密値の応答・監査・実APIログ非露出を再確認する。

現在・失効・旧32/128文字と埋め込みを実APIで、32〜128の全長を関数で回帰確認する。未知・分割・変換された秘密、ハッシュのない過去値を完全に検出できない限界は同じ。検査を省略するフィールド分類は導入しなかった。

## 実行と途中経過

Node22は作業プロセスのPATHだけに指定。`DATABASE_URL`を解除、`NODE_ENV=development`、`STAGE1_MOCK_DATA=ONLY_SYNTHETIC`。`db:mock create/migrate/seed --name stage1_mock_normal_1108`で作成。

修正前は `SAFETY_NORMAL_BASELINE=1`（失敗statusを測定して記録するテスト専用設定）、`RESEARCH_SUITE_ONLY=test:research-note-safety`、`RESEARCH_CHECK_REPORT_PREFIX=safety-normal-before` で `npm run db:mock --prefix backend -- suite --name stage1_mock_normal_1108`。修正後はbaseline設定を外し、prefixを `safety-normal-after` として同じコマンド。通常出力が1件でも200以外ならテスト失敗にする。

最初のfixture準備はenum型の明示cast不足で停止。修正準備のPythonがWindows既定文字コードで止まり、同じfixtureエラーを再度実行した。UTF-8とenum castを指定して解消。この2回はプロダクトの照合失敗ではない。以降の修正前56拒否はプロダクトの再現結果であり、修正後成功と混同しない。

関連suiteは別の空の `stage1_mock_normal_related_1108` をcreate/migrate/seed。prefix `safety-normal-related`、`RESEARCH_BROWSER_CHECKS=1`、`BROWSER_CHANNEL=msedge`、前回の関連14検証に `test:event-scale` を追加して `db:mock suite` を実行。集計は `safety-normal-related-suite-results.json`。backend/frontendそれぞれtypecheck・lint・buildも実行。

今回追加/変更: `research-output-safety.ts`、`research-safety-normal-output.ts`、`verify-research-note-safety.ts`（通常出力と専用fixtureの片付け）、`research-safety-budget-checks.ts`（照合先変更とcache整合）、本文書・集計JSON。以前からの未コミット変更は保持。

実研究データ、実機LAN、本番、20端末同時利用、DB全面停止時の可用性は今回の保証対象外。commit/push/merge/Issue変更は行わない。

## 今回の確定結果

関連15検証はすべてexit 0（`safety-normal-related-suite-results.json`）。Node22でbackend/frontendのtypecheck・lint・buildも全成功。既存イベント規模テストは20 Session・4,000イベント、JSON 3,988,944 bytes、CSV 1,496,270 bytesを全件照合し、生成6,291ms、ページ取得中央値8.80ms、取得/検証298msで成功した。これは共通照合と別のイベントExport契約の測定である。

通常出力の件数検査（JSONの全Map/Concept、操作CSV200行）を追加後、対象を再実行して成功。最終結果は `safety-normal-final-*` に保存し、前後の比較には同一条件の `before/after` を用いる。

今回の前後比較（関数/API各5反復、中央値ms）:

| 入力/経路 | 修正前の予算実装 | exact計算共有後 | 結果 |
|---|---:|---:|---|
| 関数 英数字10,000文字 | 58.33 | 52.54 | 両方とも上限拒否 |
| 関数 英数字1,000文字×10行 | 54.38 | 51.99 | 両方とも全体拒否 |
| 関数 日本語1,000文字×10行 | 0.42 | 0.31 | 両方とも検査完了 |
| API 長文メモ | 84.25 | 77.71 | 両方とも422/監査REJECTED |
| API 日本語メモ | 27.44 | 25.23 | 両方とも201 |

上限20,000回の維持により長文の安全な拒否時間は維持され、通常出力は拒否から成功へ改善した。処理時間の変動や実行時負荷を含むため応答時間SLAにしない。

後片付け完了: 今回作成した2コンテナーをmanifestの名前・ID・nonce・目的ラベルで照合し、付属volumeとともに削除。専用manifest/Exportキャッシュと今回生成のPNGを削除した。既存の検証記録は保持し、suiteによる既存レポートの自動生成差分は作業開始時の内容へ戻した。最終HEADは開始時のままで、変更は未コミット。
