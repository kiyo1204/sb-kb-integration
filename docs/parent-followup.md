> 2026-10-31 PR #16 P1修正追補：ログ接続障害時の安全応答と、失敗監査を保持する同一キー再試行を修正。新規隔離DBで追加179104、標準29検証（P1の8シナリオを含む）、静的6件、防護・新形式起動が成功。初回の準備/fixture失敗も分けて記録した。[今回の検証記録](pr16-p1-verification.md)。過去の12/4判定を全面完了へ拡大しない。

> 2026-10-30 PR前全体検証：今回の2修正を含む標準28検証、両型検査/Lint/ビルド6件、隔離DBの防護・新形式起動検証が成功。初回の準備順序による失敗と再実行を含む詳細は [PR前検証記録](pr-preflight-verification.md)。GitHub CI・実機LAN・本番運用は未確認のまま。

> 2026-10-30再評価：最新集計は確認済み12／一部確認4／未確認0。Link位置v5・Kit結果v6の証拠により条件2・3・4を更新した。旧9/7は過去時点の値。今回は新規テストを追加・実行せず、現行コードと保存済み検証記録だけを照合した。未確認のCI実走行・実機LAN・本番運用は合格に含めない。詳細とGit差分分類は [最新監査](parent-issue-2-audit.md) を参照。

# 親Issue #2 監査残課題の対応（2026-10-30）

既存統合作業場所/ブランチcodex/integrate-research-event-streamsで実施。Issue #3〜#13と前回監査の未コミット変更を保持し、元の作業場所や既存DBへ接続・変更しない。GitHubは読取りのみでIssue/チェック/コメント/ラベルを変更しない。コミット/PRなし。

|残課題|判定|根拠|
|---|---|---|
|Link位置の記録・再生|解消（Stage 1の3種類）|index.tsの位置API・完全状態v5、MapPageのドラッグ確定保存、map-history/map-mixed-history/map-undo-redo、test:parent-followup、test:map-mixed-history、test:link-position-browser|
|Kit不一致と拒否・失敗の分類|解消|research-event-feedback-v6.ts / index.ts、EventTimeline、CSV feedback_match、test:parent-followup、test:event-export-samples|
|所有者不明の旧評価下書き|確定方針に沿って隔離・保持（模擬ブラウザー検証済み）|assessment-drafts.tsで旧本文の復元/移行禁止、DataManagementPageは研究者向けに隔離件数だけを表示。推測による紐付け・自動削除・移動なし。test:delivery-browser、test:data-management-browser|
|既修正項目の回帰・対応表/辞書/CI|解消（模擬環境）|一括28検証成功。40種/468契約ケース、17イベント/9サンプル。型検査・Lint・両ビルド成功。CI構成は更新、GitHub実走行は未確認。|

## 保存契約

179102を追加する。既適用の179089〜179101は変更しない。既存v1〜v4を再解釈せず、全新規Stage 1 Map成功操作はv5へ揃えて座標を持つ状態を以降の編集/統合/削除/Undo/提出でも保持する。Map変更とイベントは同一トランザクション。現行の境界を保持し、旧→v2/v5を連番順に再生する。Link APIは既存の本人/Stage/期限/提出認可・同一キーの再試行を使い、他者・Goal情報を返さない。

位置は両座標が揃うcanvas座標。未割当はDB NULL/状態キー省略=自動配置。旧Linkの画面依存の表示位置を過去の固定座標として補完しない。ドラッグ中・取消・ズーム・パン・チュートリアルは保存イベントにしない。Stage 1以外のGoal Map等は従来動作を維持し、このAPIへ切り替えていない。

v6 FEEDBACK_CHECKではSUCCESSは確認処理成功、details.matchedが一致真偽。拒否/技術失敗はREJECTED/FAILUREと固定理由で結果なし。正解内容/対応関係を含めない。元の判定基準・集計数・学習者の成功/不一致メッセージは不変。旧v1の不一致REJECTEDはそのまま。表示申告FEEDBACK_DISPLAYは本人の同じMap/Stageへの観測で、見られたことや未保存の関連先を推定しない。

CSV末尾にfeedback_matchを追加したため、抽出出力形式はv2へ上げる（イベントv2とは別）。既存列・Session JSON exportVersion・過去ファイルを変更しない。17模擬イベントのサンプルと辞書を生成し、全ファイルのID・件数・日時・結果を照合する。

## 所有者不明データ（確定方針：隔離件数を示して保持）

2026-10-30に取扱方針を確定した。Sessionや参加者との所属を特定できない旧評価下書きは、研究者向けに隔離件数を表示して保持する。所有者を推測して紐付けたり、自動削除・移動したりしない。旧キー・回答本文は削除も移動もしていない。通常の学習者画面から読み出さず、研究者画面もこのブラウザー/接続先のlocalStorageにある対象キーの件数だけを集計する。他の端末や接続先の件数とは扱わない。旧データの回答/キー/Stage ID/回答ハッシュをAPI・監査へ出さない。新Session別キーを旧件数へ混ぜない。

画面実装では `/research/data-management` を `ResearcherOnly` で囲み、`quarantinedDraftCount` はキーの接頭辞を数えるだけで値を読み取らない。学習者の評価画面は現在の評価APIを取得した後、Session別の新キーだけを復元し、旧キーは読まない。一般のJSON/CSV出力もサーバー上の認可済みデータから生成され、ブラウザーの旧localStorageキーや回答本文を送信・列挙する経路はない。

旧形式に来歴を証明する認証主体の記録がないため、画面上の回答本文やStage IDから所有者を推測する機能は作らない。旧下書きは未解決データとして識別可能なまま隔離する。領域全体削除を安全な個別削除の代替とは案内しない。

一方、Session/参加者との所属が確認できる既存データは、研究者が削除プレビューで範囲・件数を確認し、最終確認して削除する既存手順の対象である。対象SessionのDB関連データと対応する新Session別下書きは削除され、未接続端末は確認待ちとして残る。所有者不明の旧キーはSessionへ帰属させられないので、プレビュー件数に加えず、この確認削除でも消さない。両者を混同しない。

新しい既知Session下書きの消去・画面クリア、crypto.subtleなしのHTTP LAN消去、未接続端末の確認待ちは維持。暗号化/自動期限のない平文下書き、未知秘密の検出、別タブ/別端末/バックアップの完全消去は未解決・未確認である。

## 検証と未確認

### 親Issue #2 条件13の再評価

|範囲|判定|根拠・残る範囲|
|---|---|---|
|所属を確認できるデータの期限表示・確認付き削除|確認済み（模擬環境）|`test:data-management`、`test:data-management-browser`、`test:delivery-browser`。件数・削除範囲の確認、DB削除のrollback、削除後の再登録/再送拒否、対応する新下書きの消去を確認。|
|所有者不明の旧下書きの扱い|確定方針・実装とも確認済み（模擬ブラウザー）|`recoverAssessmentDraft` はSession別の新キーだけを読み、旧キーは復元・移行しない。研究者向け画面は件数だけ表示し、模擬の旧値を画面に出さず保存を維持する。`test:delivery-browser` は `recovered=false` / `migrated=false` / `legacyKept=true`、`test:data-management-browser` は本文非表示と保存維持を検証。|
|全端末・別origin・バックアップを含む消去、平文下書きの暗号化/保存期限|未確認・未対応|ブラウザーが未接続・不明、別origin、バックアップ等は本アプリから確認できない。所属不明データは確定方針どおり保持するため、所有者別の削除完了を示すものではない。|

したがって、親Issue #2の「保存期限の管理と安全な手動削除」は **一部確認（保持・隔離方針は確認済み）** とする。識別可能な対象の明示削除は検証済みであり、所有者不明データを削除しないことは意図した確定方針である。残る一部確認は、オフライン端末・他origin・バックアップ等の到達不能な保存先と平文保護の範囲による。親Issue全体は現行コード・既存記録による16条件の再採点で確認済み12/一部確認4/未確認0に更新した。最新の各条件・根拠・制約は [最新監査](parent-issue-2-audit.md) を参照。GitHub上のチェック状態を変更したものではない。

新規stage1_mock_parent_followupだけでマイグレーション/模擬seed/検証を実行。既存DATABASE_URLは使用しない。途中のfixture開始日時不足、追加コードのLint・JSX重複指定は修正して再検証する。前回のparent-audit/issue13結果を今回の結果で上書きしない。

最終コマンド・結果・変更ファイルはparent-followup-results.jsonへ記録する。GitHub/Linux CI実走行、実研究データ、20端末同時、本番通信保護、全端末の物理消去は今回保証しない。親Issueの全面完了とはしない。


179103追補: PostgreSQLのjsonb::textは空白の追加や極小有限数の展開でcompact JSONより大きくなるため、DBの粗い保存ガードを8,000,000 bytesへ合わせる。APIと内部イベント登録の共通上限はcompact UTF-8 JSON 4,000,000 bytesのまま。102は書き換えず追記で適用し、有効な1000概念/2000リンク・極小座標の模擬状態がDB表現だけを理由に拒否されないことを自動検証する。


## 最終検証結果

`RESEARCH_BROWSER_CHECKS=1`、`RESEARCH_CHECK_REPORT_PREFIX=parent-followup-complete`、`RESEARCH_SUITE_ONLY`未設定で最初から実行した **28検証がすべて終了コード0**。途中停止分の合算を最終一括の代わりにしていない。詳細は [一括結果](parent-followup-complete-suite-results.json)、[制約/主体/重複の整合性](parent-followup-complete-invariants.json)、[実行コマンド・変更ファイル](parent-followup-results.json)。

追加実API検証test:parent-followupは、3種類の位置保存、旧4活動/新6活動、研究者/学習者actor、並列再送、同座標no-op、対象ID/前後状態、Undo/Redo、Concept/Link削除後の位置復元、他Session/未認証/Goal拒否、期限後拒否、イベント保存失敗rollbackを確認。上限外の既存Mapでは新しい境界も部分更新も作らず拒否する。新しいv5語彙を未知の旧ログと読み替えないことも混在再生の単体検証で確認する。

同じ検証でKit一致/不一致をSUCCESS+true/false、入力・設定拒否をREJECTED/VALIDATION、所有者特定後の読取障害をFAILURE/SERVERとして確認し、JSON/CSVのID・時刻・outcome・feedback_matchを照合。秘密本文・Goalの正解情報をイベントへ含めない。サンプルはv5/v6を実際の出力正規化関数にも通して、本文状態と真偽値が一致することを確認した。v4の本文なし契約検証も維持。

実ブラウザーtest:link-position-browserは、移動中送信0件→ドラッグ確定1件、再読込で位置保持、0.8倍拡大のcanvas座標、読み取り専用で更新0件を確認。test:research-log-uiは新旧Kit結果5分類と削除後回答欄クリアを確認。test:delivery-browserはcrypto.subtleなし、対象Sessionのみのキュー/新下書き消去、別Session保持、旧下書きの非復元/非移行/保持、削除後再キャッシュ拒否。test:data-management-browserは所有者不明本文を表示せず保持し、学習者の管理画面拒否を確認。

最新179103適用後の別の新規DBstage1_mock_parent_freshで、safety→seed→checkも成功。リセットはこの使い捨てDBだけで実行した。既存DB、研究データ、他作業場所には接続/適用/削除していない。自動リセットや学習者からのリセット操作を追加していない。

型検査・Lint・ビルドはbackend/frontend両方成功。CIの標準suiteに追加の実API・実画面検証を含め、40種カタログと明示対応表のキー一致・生成辞書の一致を検証する。GitHubでCIを起動するためのcommit/pushは行っていない。

途中には追加fixture/型/Lint/JSXの修正、旧v2固定の失敗注入・期待値の更新が必要だった。また代表規模検証がWindows native exit 0xC0000409で1回終了したが、単独再試行と最終一括の両方で成功した。原因は特定しておらず、本番環境での安定性を保証する結果ではない。

最終計測は20模擬Session/4000イベント、25件×160ページ。準備約6.15秒、ページ中央値約7.62ms/p95約11.73ms、JSON/CSV取得・照合約0.27秒。単機Windows/Node24.15/PostgreSQL17.11の模擬fixtureであり、20端末同時の保証ではない。詳細は [代表規模結果](parent-followup-complete-scale-results.json)。

## 保持と未解決

ブランチ/HEADを維持し、開始時ファイルの削除0、179101までのマイグレーション変更0、以前のIssue/監査集計JSONの上書き0。開始時の指紋はparent-followup-baseline.json。既存v2状態検証ファイルも変更しない。元々未追跡だったファイルも含め、既存の変更へ追加する形で保持した。

所有者不明データは確定方針どおり **隔離件数を示して保持**。実ユーザーのブラウザー保存領域を読み取り/削除したのではなく、挙動は模擬ブラウザーで確認した。所有者不明の旧データは個別削除の対象外であり、識別可能なデータに対する確認付き削除とは別に扱う。平文下書き保護、未接続端末やバックアップの完全消去は未解決。実データ/実機LAN/GitHub CI/複数APIプロセス/本番安全性は未確認。親IssueのGitHub状態は変更していない。


後片付け: 今回作成した2つの模擬DBコンテナだけを、固定のコンテナID・purposeラベル・nonceが作成時manifestと一致することを確認して停止/volume削除した。既存のComposeやDBコンテナは操作していない。コードと報告は未コミットのまま保持した。

## 2026-10-30 最終レビューの2指摘に対する修正・対象検証

Session削除はoperation_receiptsの基本スコープ `LEARNER:<Session UUID>` と、同じスコープにコロンが続く全派生フェーズを削除対象にした。単なる接頭辞一致は使わない。結果本文中のリソースIDによる既存条件も維持。DBマイグレーションは追加していない。

Linkラベルの保存を確認できず、保存後の再取得もできない間は、画面の最後の確認済み値＝ドラッグ前の座標を位置キャッシュに保持する。未保存のドラッグ座標や自動配置へ切り替えない。これはサーバーでの保存失敗確定を意味しない。サーバーで成功して応答だけ失われた可能性もあるので、メッセージは「保存を確認できません」とし、通信復旧後の再読込でサーバー値へ同期する。所有者不明の旧下書きの隔離保持方針は維持した。

今回の検証先は新規作成した `stage1_mock_review_fixes` のみ。既存DATABASE_URLは使用せず、専用manifestの防護を通したmigrate（179103まで）→模擬seed→対象suiteを実行した。

- `test:data-management`：基本スコープ/REJECTED/FAILURE/将来の多段フェーズを削除。別Session、Session UUID直後にコロンがない似た接頭辞の記録は保持。結果本文にMap IDを持つ研究者受付記録も削除。削除途中のSession削除トリガー失敗時、Session・回答・全fixture受付記録がrollbackで保持されることを確認。受付fixtureは実登録契約と同じスコープ/真偽値の模擬行を用意し、削除は実APIを通した。
- `test:link-position-browser`：実Map画面とHTTP fixtureで保存/再取得の両失敗を注入。保存自体の拒否と、サーバー相当のfixture更新後の応答喪失の両方で、ドラッグ前のx/yが保持されることを確認。通信復旧・再読込後はそれぞれ元のサーバー値/更新済みサーバー値へ同期。既存の確定時1回保存・ズーム・読取専用も合格。
- 関連既存検証 `test:map-mixed-history`、`test:parent-followup`（実DB APIのv5記録/再生/Undo/Redo/rollback・v6分類）、`test:delivery-browser`（HTTP LAN能力・削除済みキュー/下書き消去を含む）も合格。
- backend/frontendのtypecheck・lint成功。今回buildと全28件の再実行は行っていない。対象5件の保存記録は [review-fixes-suite-results.json](review-fixes-suite-results.json)。元の28件の証拠ファイルは上書きしない。

実DB連携検証とブラウザー障害注入は別の検証である。実機LANでの通信断、GitHub CI、本番運用は引き続き未確認。この成功範囲に限り2指摘を解消とし、親Issueの12確認済み/4一部確認の判定は拡大しない。既存の未コミット変更は保持し、コミット/PR/Issue変更は行っていない。今回作成した模擬DBはコンテナID・purpose・nonceを照合後、専用コンテナとvolumeを削除済み。
