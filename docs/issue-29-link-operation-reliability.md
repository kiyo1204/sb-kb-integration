# Issue #29 リンク操作の再現と修正

## 基点と範囲

2026-11-08。GitHub mainとPR #23のmerge commit `ea5319416cecf11b2ace35308c21047ac4d69d25` が一致することを確認。専用worktree `C:/Users/kyoum/.codex/worktrees/issue-29-link-operations/analysis-layout-repo` を作成し、branch `codex/issue-29-link-operation-reliability`、開始HEADは上記main、statusはclean。AGENTS.mdは見つからなかった。既存worktreeのファイルは変更していない。

Issue #29/#30/#33/#34はいずれもopen。#29の報告自体は対象操作も未特定なので、報告者と同じ環境/操作を完全に再現したとは主張しない。以下の具体的な操作不良をブラウザーで確認して修正した。Issue本文/状態、PR #21、研究手順、方向/接続先、Provenance、DB schema、イベント契約は変更しない。

## 再現手順と観測

1. 編集可能なPRIOR MapでConceptを横に配置する（例: (100,100)、(550,100)）。Linkを作り、ラベルの保存位置を(320,220)へずらす。
2. ラベルを経由して見えるLinkの線上をマウスでクリックする。
3. 修正前はクリック位置のelementFromPointが `concept-canvas` になり、Link hit targetのaria-pressedがfalseのままだった。クリックでLinkを選択できない。固定のAPI待機や通信遅延はこの再現に不要。
4. ラベルをずらした方向と元の線が近い位置では動くことがあり、リンクによって反応が違う状態になる。透明領域が表示されていない別経路に残ることをコードで確認。
5. 実API版ではラベル枠の空白/縁が `link-connector` 自体に当たり、ボタンへ届かず選択されないケースも確認した。

修正前の再現テストは `clicking the visible line must select its link` でfalse/true不一致となり、修正後は同じマウスクリックが `concept-edge-hit-target` に当たって成功した。強制clickやReact handlerの直接呼出しは使用しない。

## 原因と最小修正

`ConceptCanvas` は見える線を `connectorEndpointPoints` と現在のラベルcenterから2本の線分として描く一方、透明な `concept-edge-hit-target` は `getEdgeGeometry().path`（旧経路）を使っていた。手動位置・複数リンクの曲線配置などで両者が離れる。見えているstrokeはpointer-events:noneなので、そこをクリックしても透明領域へ届かない。

MapPage.tsxのみを製品コードとして変更した。ヒット領域dを、実際に表示する始点側/終点側の線分と一致させる。接続中に非表示の線分はヒット領域からも外す。endpointsがない場合の既存fallbackは保持。見える線のd・矢印・ラベル座標は変えない。

保存済みLinkのラベル枠に、targetが枠自身の場合だけ選択するonClickを追加した。子ボタンのドラッグ/端点接続/クリックを二重実行しない。線の描画変更やz-index変更で問題を隠す処理はない。新しい操作イベント・計測・DB項目もない。

## 回帰条件

`verify-link-operations-browser.ts`: 修正前に失敗した画面fixture。実マウスの表示線選択、ラベル移動、CSS scale 0.8、再読込、拒否/応答喪失/再読込失敗時の元表示保持と復旧、提出済みread-onlyを確認する。既存link-position-browserも引き続き実行する。

`verify-link-operations-api-browser.ts`: 専用mock DBのguardを通ってからPoolを作る。Session/Stageの合成fixtureを作り、Map/Concept/Linkは実APIで作成する。通常Concept3件＋追加20件＋初期資源、Link17件。APIの実レスポンスをブラウザーへ渡し、変更要求も実サーバーへ送る。

- 見える対象線の選択、3回の連続ラベルドラッグと再読込。各保存座標がUIと一致。
- PATCHに180msの模擬遅延を付け、完了レスポンスと表示結果を待つ。固定sleepで保存完了を判定しない。
- Link UPDATEを専用triggerで失敗させ、500後の表示位置/DBの不変とFAILUREイベントを確認。triggerはfinallyで削除。
- 端点ハンドルをマウスでConceptへドラッグして再接続。方向・保存先がAPIと一致。
- Undo/Redo後に再読込して選択できる。mixed-historyがREPLAYABLEで、全LinkのID/接続先/ラベル/座標がAPI現在状態と一致し、実DBの端点・座標とも一致。
- ラベル枠の実ヒット位置をマウスクリックし選択。scale/viewportスクロール後の見える線も選択。
- 実APIのfive-flow-compositeでKit取込みされたLinkを研究者の提出済みMap画面で選択。提出済みMapを編集可能にする処理はない。

多数リンクで同一点に重なったstrokeは上側のLinkがヒットする。テストは対象が実際に見える非遮蔽部分を選ぶ。全く重なる線から任意の下層Linkを選ぶUIを新設したとは扱わない。表示準備はハンドルのenabledと描画フレームを待ってから座標を取得する。

## 別Issueと未確認

#30の接続確定時の位置飛びは今回の製品修正対象にしない。検証で再接続後/選択drawer変更後にレイアウトが変わるため、準備前の座標でクリックするテストは修正した。これを#30の原因と断定しない。

#33の接続手順/方向表示のUI再設計は行わない。#34の線・ラベル経路と完全重なりの解消も行わない。今回の線の見た目は既存のまま。未知の報告条件全て、実研究データ、実機LAN、20端末同時利用、本番の保証ではない。

## 実行環境と記録

Windows/Node v22.23.4、Edge headless、PostgreSQL17。既存DATABASE_URLを解除しdevelopment/ONLY_SYNTHETIC、db:mockのmanifest/guardだけで新規DBに接続した。

対象用 `stage1_mock_issue29_target`: create/migrate/seed。RESEARCH_SUITE_ONLY=test:five-flow-composite,test:link-operations-browser,test:link-operations-api-browser、RESEARCH_BROWSER_CHECKS=1、BROWSER_CHANNEL=msedge、prefix issue29-targetで `npm run db:mock --prefix backend -- suite --name stage1_mock_issue29_target`。最終3/3成功。

全体用 `stage1_mock_issue29_full`: 別の空のDBをcreate/migrate/safety/seed/checkし、対象を限定せず、同じbrowser設定、prefix issue29-fullでsuiteを実行する。旧辞書/サンプルのJSON/Markdownは生成器のLFへ作業コピーだけ合わせ、内容は変更せず、終了後に元の形式へ戻す。

backend/frontendのtypecheck・lint・buildを実行。scopeはMapPage.tsx、frontend scripts2件、frontend/package.json、suite登録、文書/集計だけ。lockfile/依存バージョンを変更しない。npm ciが報告した既存の依存監査警告はこの修正で解消したとは扱わない。

途中の失敗: 最初のブラウザー起動はViteのcwdがrootだったため404。修正適用準備にもcwdを取り違えた1回があり、修正前の再現を再度実行した。実APIテスト初回はfrontendにpgがないため停止し、backend依存から解決するよう修正。描画/認可準備前の座標取得、追加リンクが対象の全線を覆うfixture、ラベル枠の実不具合による失敗を分けて調査した。最終成功と混同しない。初回集計はissue29-target-initial-suite-results.json、最終はissue29-target-suite-results.json。既存DB・研究データを使った試行はない。

## 最終ローカル結果

対象3/3、全体46/46（追加2件を含むブラウザー13検証）、backend/frontendのtypecheck/lint/build全6件がPASS。全体子プロセス集計 431,155ms。全体suite内でも新しい実APIリンク回帰がPASS。過去の試行失敗と最終成功は区別する。生成済みの既存辞書/サンプル/旧検証結果は内容を保持し、今回の結果だけをissue29-*で保存した。

後片付け: 今回の専用DB2件をmanifestの名前・ID・nonce・目的ラベルで照合して、コンテナー/volumeと専用manifest/Exportキャッシュを削除済み。テスト子プロセス・Vite・ブラウザーはfinallyで終了し、生成PNGも除去した。他worktree、既存DB、PR #21、Issueの状態は変更していない。
