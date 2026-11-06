# 未開始Sessionの整理削除

作業指示39518。作業場所は `C:\Users\kyoum\.codex\visualizations\2026\11\06\01a1aec2-e76a-7bf2-a3f8-eb3738f49022\analysis-layout-repo`。
開始時は `codex/session-analysis-layout` / `9286e06081cc9137704298ec99f3d9c24439e318`、git statusはclean。
remote mainをfetchし、`775359271e18c5855f1e4eb99013b7b947879041` から `codex/session-cleanup-delete` を作成。
PR #19の `011d5386`、#20の `f7147c75`、#22の `77535927` がmainの祖先であることを確認した。他のworktreeは操作していない。

## APIと判定

研究者専用 `POST /api/research/data-management/cleanup` に `{sessionId, confirm:"DELETE_UNSTARTED"}` を送る。認証は既存accessControlと研究者用data-management middlewareを再利用する。UIの未開始表示は候補表示であり、許可判定は必ずサーバーで行う。

- SessionはNOT_STARTED、開始・完了時刻なし。全SessionStageはPENDINGで開始・完了時刻なし。
- アンケート・評価・説明回答、旧マップ操作ログ、履歴境界、配信報告・配信受付票、研究評価・メモが1行でもあれば拒否。
- 学習者の操作受付票があれば拒否。イベントはRESEARCHER/SYSTEMのSESSION_CREATE、SESSION_SETTINGS_CHANGE、RESEARCH_ASSESSMENT_CHANGE、RESEARCH_ANALYSIS_VIEW、RESEARCH_EXPORTだけを許す。それ以外は拒否する。研究者による開始も拒否される。
- Session専用マップはDRAFTかつ未提出。空マップで初期スナップショットがない場合は許す。初期スナップショットがある場合は概念・リンクの件数、ID、名称、座標、接続先、統合先が現状と一致することを検証する。不明・欠損・不一致は拒否する。現在は空でも初期状態にデータがあれば拒否する。
- 他のマップのbased_on_map_idから参照されるマップは拒否する。その他の外部キー競合も全体をロールバックする。

開始済み・記録ありは409 confirmed_deletion_requiredと既存 `/research/data-management` への案内を返す。データベース障害は秘密や生の例外を含まない固定エラーとし、削除成功として扱わない。

## 削除範囲と監査

既存確認付き削除からトランザクション内の削除本体を共通化し、確認付きフローのpreview/signature/DELETE確認は保持した。対象Sessionと活動、設定・設問・初期概念選択、専用マップ・概念・リンク・初期状態、選択範囲のID対応・操作受付票を一貫して処理する。学習者コードは既存の失効表へ移し、端末データ削除状態は既存方針のPENDING_OR_UNKNOWNとする。

対象Sessionの研究者・システムイベントは既存の確認付き削除方針と同じく対象データと一緒に削除し、Session外部キーを持たないresearch_deletion_receiptsに時刻と件数を残す。削除済みSessionを参照する新しいイベントは追加しない。孤立した参加者対応は既存処理で除去し、他Sessionと共有する参加者は保持する。

共有Goal Map、Kit定義・教師用KB元データ、他Session、studyは削除しない。DB変更・マイグレーションは追加していない。

## 競合対策

既存削除と同じadvisory lock 111011、関連テーブルのEXCLUSIVE lock、5秒のlock_timeoutを使い、判定から削除を1トランザクションにする。開始・回答・編集が先に確定した場合は、その記録を判定して拒否する。削除が先なら後続の開始・回答は対象がなく成功できない。デッドロック・タイムアウトはロールバックして安全に失敗する。

Idempotency-Key付き学習者要求は、認証と保存の間にSessionが消える競合もあるため、reliableOperationが親SessionをFOR KEY SHAREで再確認し受付票のcommitまで保持する。削除後の要求から孤立したlearner操作受付票を新規作成しない。

ロックは既存削除と同様にテーブル単位なので、短時間ほかの書込みも待つ場合がある。

## 検証

新規Docker模擬DB `stage1_mock_39518` と `stage1_mock_39518_related` だけでcreate/migrate/seed/suiteを実行。既存DATABASE_URLは渡していない。両コンテナーはmanifest・ID・nonce・用途ラベルを照合後、volumeとともに削除し、manifest/cacheも除去した。

- 対象API: 新旧Session、初期概念・設定・設問、研究者作成イベント、削除受付票、一覧からの消失、学習者イベント・回答・ログ・提出・配信記録・初期状態不一致の拒否、未認証・自他Session学習者の拒否、障害注入ロールバック、安全なエラー、共有資材保持を確認。
- 競合: 実APIの開始/削除、Idempotency-Key付き活動開始/削除を並列実行。開始トランザクションを保留し、pg_stat_activityで削除のロック待ちを観測してからcommitする確定的検証でも、開始済みSessionが残り簡易削除が拒否されることを確認。
- 対象ブラウザー: 対象ID・影響範囲の確認、キャンセル時APIなし、409案内、成功時対象行のみ除去を確認。
- 関連: 既存data-management、Stage1 integration、5活動survey、Goal Map転送、delivery-reliability、cleanup API/UIが成功。
- backend/frontendのtypecheck・lint・buildは成功。最終backend buildと対象回帰も成功。
- 成功集計はcleanup-target-final-suite-results.json、cleanup-related-final-suite-results.json。既存data-managementは最初の関連実行で成功したが、その直後に親NodeプロセスがWindows 0xC0000409で終了したため、残りの6検証を別実行で完了した。対象suiteも一度テスト開始前に同じWindows異常終了があり、再実行は成功。途中停止を一括成功とは扱っていない。

全体suiteはGitHub Actionsの新規隔離DBで実行する。チュートリアル専用アクセスコードはこのPRの範囲に含まない。
