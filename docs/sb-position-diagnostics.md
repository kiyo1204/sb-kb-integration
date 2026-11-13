# SB概念移動の保存待ち診断

2026-11-13、main `1a9936665b9b3c78f3d54edf233f7d062c7d7990` 基点。
対象は [main CI run 43352755053](https://github.com/kiyo1204/sb-kb-integration/actions/runs/43352755053) の `test:experiment-learner` → `verify-experiment-learner-browser.ts` にあるSB概念移動の保存応答待ち。Linux/Chromiumの30秒待機タイムアウトの原因は未特定であり、この変更は修正や原因確定ではない。以前のWindows/Edge/Node 22での実API・PostgreSQLのSB成功3試行は過去の結果で、CI環境の問題や製品不具合を否定しない。

## 追加する情報

`frontend/scripts/sb-position-diagnostic.ts` が、対象の概念IDを内部で使って位置保存PATCHだけを監視する。要求・通信失敗・応答のリスナーと、pointerdownのcaptureリスナーはマウス操作前に登録し、成功・失敗後に解除する。従来のマウス操作、待機時間、HTTP 200の成功条件を変えず、再試行しない。正常時の診断出力はない。

失敗時だけ次の固定形式の要約を出力する。

| フィールド | 意味と限界 |
| --- | --- |
| `check` | 固定値 `sb-position-save` |
| `pointerReached` | pointerdownの実際の対象または祖先が予定の概念か。falseは到達を観測できなかったこと、nullは診断読取り不能。ドラッグの成立やReactハンドラー実行までは証明しない |
| `requests` | 対象位置PATCHのブラウザー送出を観測した件数。サーバー受理の証明ではない |
| `requestFailures` | 対象PATCHのrequestfailed件数。通信失敗の詳細文字列は出力しない |
| `responses` / `statuses` | 応答ヘッダー受信件数とHTTPステータス（最大5件）。本文受信やDB確定まで証明しない。HTTPエラーはrequestfailedと区別する |
| `dbCheck` | `NOT_PERFORMED`。このブラウザー診断はDBへの追加接続や保存確認をしない。送出・応答だけからDB結果を推定しない |

ID、URL、ラベル、座標、コード、トークン、ヘッダー、要求・応答本文、通信失敗・例外の詳細は診断レコードに含めない。診断読取りと後片付けの追加待機はそれぞれ最大500ms。読取り・出力が失敗しても、元の例外オブジェクトをそのまま再throwする。既存の検証失敗表示は変更しない。製品コード、保存契約、認証、通常公開ゲートには変更しない。

## 今回の検証

- `npm run test:sb-position-diagnostic --prefix frontend`：loopback HTTPサーバー・合成DOM・実Edgeを使う診断専用検証。正常時は無出力、別概念へのpointerdownと無関係PATCHでは対象件数0、対象PATCHの通信中止は要求1・失敗1・応答0、HTTP 503は応答として記録する。短い200msの待機はこの自己検証だけの設定で、製品フロー検証の待機時間は変えない。
- 診断読取りと出力を両方失敗させても、元の操作例外と同一オブジェクトが返ることを確認。秘密値を模したsentinelが要約に含まれないこと、pointer監視の後片付けを確認。通信中止・503は隔離したテスト経路への注入で、製品APIの障害再現ではない。
- Windows/Edge、Node **22.23.5**、新規使い捨てPostgreSQL `stage1_mock_sb_diag`。既存の安全確認付きmockツールで作成・migration・seedし、`RESEARCH_SUITE_ONLY=test:sb-position-diagnostic,test:experiment-learner`、`RESEARCH_BROWSER_CHECKS=1` で対象だけを実行。**2/2成功**（診断5.564秒、既存学習フロー99.465秒）。通常公開を閉じたまま専用APIプロセスのみ既存mock previewを使用。教材・Sessionは合成データ、実際の既存認証・API・DBとEdgeを使用し、P01〜P08、SB位置保存、既存の認可・提出・終了関連検証が成功。対象suite実行後に自己検証の型定義対応だけを修正し、自己検証を再実行して成功した。
- 新規診断2ファイルの個別TypeScript確認成功（Node型は既存backendのtypeRootsを指定）。backend/frontendの型検査・Lint成功、`git diff --check`成功。製品ソース・設定を変更しないため、ローカル全体suiteとbuildは繰り返さない。CIは別途実行される。
- mockコンテナーをID・用途・nonceで照合し、今回のコンテナー・volume・manifestだけを削除。生成した集計JSONはローカルに保持し、コミットには含めない。

## 途中の失敗と限界

- 制限環境内での初回Edge起動は失敗し、ブラウザーを起動できる実行環境で確認した。製品テストの失敗とは区別する。
- 自己検証の初回は、意図的に失敗させた操作のPlaywright応答待機がまだ終了していない時点でリスナー数0を要求して失敗。非公開のlistenerCount APIへの依存も型検査で判明したため、公開APIによるpointer監視後片付けの確認に修正した。診断の元例外保持は維持する。
- 最初の個別型確認はfrontendにNode型がない条件で失敗。既存backendのNode型を明示して再確認し、成功した。依存追加はしない。
- 診断追加前に再現できなかった元のLinux/Chromiumタイムアウトが解消したとは扱わない。DB結果の自動診断、実ネットワーク障害、実研究データ、実機LAN、本番運用は未確認。GitHub CI結果はローカル結果とは別に扱う。
