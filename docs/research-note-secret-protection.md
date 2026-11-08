# Issue #11: 旧4活動の研究者自由記述を保護する

## 範囲と作業基点

- main `359ae31db9d37fc25263c5aaf85d0f4e950173fe` から `codex/research-note-secret-protection` を作成。
- 作業場所: `C:\Users\kyoum\.codex\worktrees\research-note-safety\analysis-layout-repo`。作成直後は未変更。
- LAN用の `lan-main-runtime` は同じmainのdetached HEAD、開始時clean。稼働環境・DBは変更しない。
- Issue #11はopen、コメント0件を確認。Issue/チェックリストの変更は行わない。
- PR #23のSession整理削除、新5活動の特徴量、研究条件は対象外。
- DBスキーマ変更、既存行の書換え・削除、認証値の平文保存追加はない。

## 原因と修正

`stage1-analysis.ts` の `rationale` / `noteText` は必須・長さ検査のみで保存され、分析APIと専用CSVでも生値が返っていた。

`research-output-safety.ts` にある出力保護とGoal Map転送の既知コード照合を共通の `loadResearchTextSafety` にまとめた。保存拒否と読出し時のredactionは同じ `containsSecret` を利用する。Goal Map転送は既存どおり既知認証値の照合を使い、マップ固有の入力制限は変更しない。

- 評価理由・メモと、併記される研究者コードをINSERT前のトランザクション内で確認する。
- 検出時は `400 {error:"sensitive_text_rejected"}` でROLLBACK。検出値・入力文・フィールド内容を返さない。
- 既存行は読出し時に該当する文字列全体を `[REDACTED]` に置き換える。文字列の部分復元やDB内の置換はしない。
- 評価行全体に適用するため、旧 `subjectSnapshot` のラベル、研究者コードなどの入れ子の文字列にも同じ保護が働く。
- 照合先DBの読出しに失敗したら出力を失敗させる。生値を返すフォールバックは追加しない。
- 監査は既存のID・outcome・固定reasonCodeのみ。拒否・DB失敗時も入力本文を監査やエラーに加えない。
- 研究者認可、旧4活動の評価カテゴリ・関連ID・時刻・CSV列順、`csvCell` の式インジェクション防止は維持する。

## 経路の照合

| 経路 | 保護・契約 |
|---|---|
| 評価理由 / メモPOST | 同じ既知値・credential-like検査で保存前に拒否。研究者コードも確認 |
| Session分析API | `propositionEvaluations` / `reflectionNotes` を出力直前に再帰redaction |
| `evaluations.csv` / `reflections.csv` | 同じredaction後に既存CSVエスケープ。列・順序は維持 |
| Session生データJSON | 既存 `buildSessionRawExport` のredactionが共通判定を使用。研究者の評価理由・メモは従来から含まれず、今回も項目を追加しない |
| `operations.csv` / `features.csv` | 同じSession生データExport経由。自由記述テーブルは結合しない。旧特徴量の契約を変更しない |
| 共通イベントJSON/CSV、マップ操作詳細CSV、イベントビュー | 研究者自由記述テーブルは抽出対象外。既存の監査イベントは本文を保存しない。実APIで出力ファイルを照合 |
| 拒否・DB失敗応答、監査・ログ | 固定コード/ID/outcomeのみ。試験時に本文・ヘッダー・監査行・実API子プロセスstdout/stderrを照合 |

## 検出範囲と限界

- 現在の `RESEARCHER_API_TOKEN` は文字列内一致で照合する。過去の研究者トークンの一覧は保存されておらず、ローテーション前の値は一般パターンに該当しない限り照合できない。
- 学習者コードは `sessions.learner_access_token_hash` と既存の `research_identity.revocations.token_hash` にあるSHA-256との一致で照合する。ハッシュから平文を取り出さない。
- 文字列全体・空白区切り・base64url形式の連続部分を候補にする。現在の発行形式43文字に加え、認証APIが受け付ける32〜128文字の範囲を区切りのない英数字の前後付加についても照合する。ハッシュに長さ情報がないため範囲内の候補を照合し、同じ文字列の判定は要求/Export内だけで再利用する。認証形式外の長さや分割・変換された表現は完全には照合できない。
- 失効済みでもハッシュが残る値は照合する。再発行によって上書きされ、失効記録にも残らない過去値は照合できない。検出目的の平文・過去値保管は追加しない。
- Bearer、password/passwd、API key、access token/code、authorization/cookie、token/secret、日本語の秘密値キーと代入、秘密鍵ヘッダーなど既存処理に沿うcredential-likeパターンを対象とする。
- 未知の秘密、別表記・エンコード・分割された秘密を任意の文章から完全に検出できるものではない。意味による秘密判定や個人情報全般の除去を保証しない。
- 良性のURL、改行、引用、「パスワードの仕組み」のような説明文は保持する。credential-likeパターンに似た文章を伏字・拒否する可能性はある。
- 保護は既存データの読出し時に行う。DB自体や過去に取得済みのExport/バックアップから秘密値を消す修正ではない。

## 今回の検証

新規専用コンテナー `stage1_mock_note_68240` と、ガード付き `db:mock` だけを使う。既存の `DATABASE_URL` は受け付けない。LAN用DB・実研究データには接続しない。

対象コマンド:

```powershell
$env:NODE_ENV='development'
$env:STAGE1_MOCK_DATA='ONLY_SYNTHETIC'
# DATABASE_URLを設定しない
npm run db:mock --prefix backend -- create --name stage1_mock_note_68240 --mock-data-only
npm run db:mock --prefix backend -- migrate --name stage1_mock_note_68240
npm run db:mock --prefix backend -- seed --name stage1_mock_note_68240
$env:RESEARCH_SUITE_ONLY='test:research-note-safety'
$env:RESEARCH_CHECK_REPORT_PREFIX='research-note-target'
npm run db:mock --prefix backend -- suite --name stage1_mock_note_68240
```

対象回帰テストは、実APIプロセスに対して評価理由とメモを別々に照合する。現在の研究者トークン、2つのSessionの学習者コード、失効済みコード、旧形式32文字コード、区切りなし43文字コード、credential-like入力を試す。

通常保存を迂回して秘密値を含む旧評価理由・旧メモ・subject snapshotを投入し、分析API/専用CSVのredactionとDB原文維持を照合する。良性文・CSV式安全性、他Sessionのメモ・旧6活動の回答の保持、未認証/別Session学習者の拒否、DB例外時ROLLBACK、照合先欠損時の安全な失敗も確認する。

### 途中の失敗と準備のやり直し

- 初回は合成Sessionに必要な教材URL・Kit参照を指定し忘れ、`sessions_stage1_fields_chk` で停止。プロダクトの不具合ではなくfixtureを修正。
- 修正準備のPython読出しがWindows既定文字コードで失敗し、同じfixtureエラーを再度実行。UTF-8指定で修正。
- Windows Node v24.15.0では対象テスト子プロセスと、別回の関連suite親プロセスが例外表示なく `3221226505` で異常終了した。対象テストは再実行で成功したが、原因未特定のため最終ローカル検証をCIと同じNode22系（v22.23.4）でやり直す。グローバルNodeやLAN環境は変更しない。
- 静的検査初回は共通化後に残った未使用 `PoolClient` importでLint停止。importを除去して再実行。

- 関連suite初回は既存 `verify-server-audit.ts` の無条件 `LIMIT 1` が、旧履歴注釈テストの1活動だけのSessionを選び、分析APIの正当な `inconsistent` 拒否で停止。模擬DBで活動構成 `{PRIOR_MAP}` を確認。監査の成功確認用には全4活動が完了したfixtureを選ぶようテスト前提を修正し、200成功の期待は維持する。

- 旧形式コードの追加確認後、同じ模擬DBで関連suiteを再実行したところ、既存データ削除テストが前回残した模擬受付票（`operation_receipts` の `request_hash=mock`）を含めて数え、`4 !== 2` で停止。使い捨てDBを1回だけ使うsuiteの前提に反する再利用が原因のため、最終関連suiteは別の空の新規DBで実行する。データ削除本体や件数期待値は変更しない。

### 最終結果

2026-11-08、Node v22.23.4で最終確認。対象の単独実行が成功し、その後、空から作成した `stage1_mock_note_node22_68240` で関連14検証がすべてexit 0（集計162,968 ms）となった。

| 確認 | 今回の結果 |
|---|---|
| `test:research-note-safety` | 単独実行PASS、関連suite内でもPASS。評価理由とメモそれぞれ11種類の不正本文、研究者コード欄への秘密値混入2件、既存行、各出力、認可、DB障害/照合先欠損を確認 |
| 関連suite | 14/14 PASS。`research-note-related-suite-results.json` に今回の集計を保存 |
| backend | `npm run typecheck --prefix backend` / `npm run lint --prefix backend` / `npm run build --prefix backend` をNode22で最終実行、全てPASS |
| frontend | `npm run typecheck --prefix frontend` / `npm run lint --prefix frontend` / `npm run build --prefix frontend` をNode22で最終実行、全てPASS |
| 片付け | 今回作成した模擬DB4件を名前・ID・nonce・目的ラベルで確認し、コンテナーとそのvolumeを削除。専用worktreeの模擬DB接続記録とExportキャッシュも削除 |

関連suiteの選択条件:

```text
RESEARCH_SUITE_ONLY=test:research-note-safety,test:stage1:integration,test:data-management,test:event-export,test:goal-map-transfer,test:server-audit,test:audit-routing,test:assessment-events,test:session-flow-survey,test:five-flow-composite,test:five-flow-feature-maps,test:five-flow-features,test:stage1-analysis-layout-browser,test:five-flow-features-browser
RESEARCH_BROWSER_CHECKS=1
BROWSER_CHANNEL=msedge
RESEARCH_CHECK_REPORT_PREFIX=research-note-related
```

`npm run db:mock --prefix backend -- suite --name stage1_mock_note_node22_68240` を上記の条件で実行した。単独テストは `RESEARCH_SUITE_ONLY=test:research-note-safety` / `RESEARCH_CHECK_REPORT_PREFIX=research-note-target` とした。ローカルでは関連範囲を確認し、GitHub Actionsは既存の全体suiteに今回の対象検証を追加して実行する。

途中で停止した関連suiteは別の `research-note-related-attempt-suite-results.json` / `research-note-reused-db-attempt-suite-results.json` に保存し、最終成功集計に混ぜない。Node24の異常終了は上の経過に記録した。

依存準備時の既存監査警告（backend 14件、frontend 13件）はこの修正で解消したとは扱わない。依存バージョンやlockfileを変更していない。

対象・関連suite結果は集計のみ保存し、自由記述・認証値・生イベントは文書へ出力しない。

この結果は合成データによる回帰検証であり、実研究データ、本番運用、実機LAN、20端末同時利用の確認・保証ではない。

## リクエスト共有予算の追加検証

PR #36上の未コミットの負荷制限変更、監査とHTTP応答の対応、今回の性能・回帰結果は [リクエスト共有予算の記録](research-safety-request-budget.md) を参照。上記の既存検証結果とは別の実行である。
