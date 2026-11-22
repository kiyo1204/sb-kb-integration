# Stage 1研究用学習システム — SB/KB Integration

授業後の概念マップの作成・再構成を支援し、学習過程を研究者が検証できるようにする**開発・模擬研究用プロトタイプ**です。Scratch-Build、Kit-Build、統合マップ、操作履歴、研究イベント、研究者向け分析・出力を扱います。

> [!WARNING]
> **実研究データ・本番研究への利用は想定していません。** 既定構成はローカル開発用で、HTTPSや研究者ごとのアカウント分離は備えていません。実参加者の情報や本番DBを使って検証しないでください。

## 目次

- [システム概要](#システム概要)
- [クイックスタート](#クイックスタート)
- [学習フローと操作練習](#学習フローと操作練習)
- [参加者Sessionの登録取消](#参加者sessionの登録取消)
- [研究データと出力](#研究データと出力)
- [開発・テスト](#開発テスト)
- [実験用4活動フローの有効化](#実験用4活動フローの有効化)
- [LANでの模擬利用](#lanでの模擬利用)
- [安全上の注意と運用制約](#安全上の注意と運用制約)
- [関連ドキュメント](#関連ドキュメント)

## システム概要

| 項目 | 内容 |
| --- | --- |
| フロントエンド | React / TypeScript / Vite |
| API | Express / TypeScript |
| データベース | PostgreSQL |
| 起動 | Docker Compose |
| ローカル画面 | <http://localhost:5173>（既定） |
| 主要な利用者 | 学習者、研究者 |
| 対象用途 | ローカル開発、合成データを用いた模擬実験、研究イベントの検証 |

学習者は、割り当てられたアクセスコードで自分のSessionを開き、学習活動とマップ操作を行います。研究者は教材・実施・参加者の管理、マップの状態や履歴の確認、手動評価、JSON/CSV/Excel出力を行えます。API側で利用者の役割とSessionへのアクセス権を検証します。

### 主な機能

- Concept / Link の作成・編集・移動・削除・接続・再接続、Kit部品の取り込み、Conceptの統合
- 学習者のUndo / Redo、研究者による保存済み履歴の再生、初期スナップショットとProvenanceの追跡
- Kit-BuildのGoal Mapとの一致確認（**明示的な確認操作時**）。一致結果を学習の総合点数として扱いません
- 研究イベント・操作ログの取得、未送信データの再送と受信状態の確認
- 研究者向け分析、JSON / CSV、実施単位の**11シートExcel**出力
- 旧プロトコルの既存データ・操作履歴との互換性

## クイックスタート

### 必要なもの

- Git
- Docker Desktop（Docker Compose v2を含む）
- PowerShell（以下はWindowsでの例）

通常のDocker起動では、Node.jsやPostgreSQLをホストPCへ個別にインストールする必要はありません。ホスト上でテストを実行する場合は、Node.jsと各ディレクトリのnpm依存関係が別途必要です。

### 1. 設定ファイルを準備

リポジトリのルートで実行します。

```powershell
Copy-Item .env.example .env
```

`.env` の `RESEARCHER_API_TOKEN` に**32文字以上のランダムな秘密値**を設定してください。設定しないとAPIは起動できません。`.env`、トークン、DBパスワードはGitへコミットしないでください。

既定では `FRONTEND_BIND_ADDRESS=127.0.0.1` です。APIとDBのホスト公開もループバックに限定されています。`.env.example` のDBパスワードは開発専用の例です。

### 2. 起動・DB更新・開発Kit準備

```powershell
docker compose up --build -d
docker compose exec api npm run db:migrate -- up
docker compose exec api npm run db:seed:dev
```

`db:seed:dev` は開発用のGoal Map / Kitを登録するための操作です。既存環境での再実行が必要かは用途を確認してください。DB migrationは対象とバックアップを確認したうえで行い、実研究DBへ適用しないでください。

### 3. ブラウザーを開く

<http://localhost:5173> にアクセスし、研究者コードでログインします。研究者画面から教材・Kit、実施、参加者を準備し、発行した**学習者用コード**を学習者へ渡します。研究者コードは学習者に共有しません。

### 4. 2回目以降の起動・停止

```powershell
# 起動
docker compose up -d

# 必要な新規migrationを確認してから適用
docker compose exec api npm run db:migrate -- up

# 停止（DBデータを保持）
docker compose down
```

**`docker compose down -v` は実行しないでください。** DBボリュームが削除されます。また、通常の停止や更新にリセット・破壊的migrationを組み込まないでください。

## 学習フローと操作練習

このリポジトリには、作成するSessionの種類により**異なるフロー**があります。混同しないようにしてください。

### Stage 1の新規Session：5活動（`STAGE1_5`）

1. 動画視聴
2. 学習者マップ作成（Scratch-Build）
3. Kit-Build
4. 統合マップ作成
5. アンケート（自由記述・単一選択・段階評価）

新規作成時に実験群・統制群は設定せず、`study_group` は `null` です。Scratch-Buildの初期概念は選ばれたKitの一部から配置され、初期概念は移動・リンク接続できますが名前変更・削除はできません。Kit-Buildの一致判定は確認ボタンを押したときに表示され、提出時はサーバーが最新の保存内容を判定します。統合マップには制限時間と自動提出があります。

旧 `STAGE1_4`（4活動）・`STAGE1_6`（群別6活動）の記録・条件・評価は保持します。旧評価 `assessment` と新アンケート `survey` は別の項目です。[詳細仕様](docs/session-flow-survey.md)を参照してください。

### 実験用の4活動（`SBKB_INTEGRATION_V1`）

**授業・動画 → Scratch-Build → Kit-Build → 統合マップ**の実施フローです。教材の完成登録・実施作成・参加者登録を行い、研究者が実施開始を確定します。通常Composeでは**既定で無効**です。有効化の条件は後述します。

## 参加者Sessionの登録取消

実験用4活動（`SBKB_INTEGRATION_V1`）では、研究者の実施詳細ページ「セッションの削除」から、**準備中・未開始・端末未接続・学習記録なし**の参加者Sessionに限り、確認付きで**登録取消（論理削除）**できます。実施開始後や、端末登録候補・学習記録のあるSessionは取り消せません。サーバーとDBが最終条件を検証します。

取消後のアクセスコードは失効し、当該Sessionは通常の参加者一覧・登録人数・実施単位の `research.json` / `research.csv` / **11シート `research.xlsx`** の対象から外れます。一方、**Session・Stage・登録対応・監査記録は物理削除しません**。「登録取消履歴」から対象ラベル・Session ID・取消日時を確認できます。以前ダウンロードした出力ファイルや端末上の記録は自動消去されません。

操作手順、取消条件、通信断・エラー時の確認方法、履歴・コード・出力の扱いは **[実験用Session登録取消の運用ガイド](docs/experiment-session-withdrawal.md)** を参照してください。これは旧Stage 1のデータ削除とは別機能であり、実研究データの完全消去を保証するものではありません。

### P02からの操作練習

実験用4活動の参加者は、P02「活動の案内」から、本番の研究用マップとは独立した操作練習を行います。

- 練習順序は **Scratch-Build → Kit-Build → 統合マップ**。各練習で必要な操作を終えると、次の練習を選べます。
- 途中で前の練習に戻っても、同じ練習画面内のマップ・達成状態は維持されます。
- 3モードすべてを完了するまで、P02の「セッションを開始」は利用できません。
- 練習終了後はP02に戻り、同じタブで再読み込み（F5）しても完了条件と端末登録を引き継いで開始できます。
- **練習用Concept / Linkは学習Sessionの保存Mapや研究イベントに記録しない設計**です。研究データへの非混入を合成APIブラウザーテストと隔離DB検証で確認しています。

練習完了状態はそのタブ内のSessionとアクセスコードに紐付きます。他の端末や別Sessionへ一律に引き継ぐものではありません。画面幅390pxでもKit部品のドラッグ・接続・再接続を操作できるよう検証しています。

## 研究データと出力

### 記録と分析

保存されるマップにはConcept / Link、接続、操作履歴、初期状態、Provenanceを含む情報があります。研究者は履歴再生、Map比較、U/I/P/V手動評価、振り返りメモ等を利用できます。

ブラウザー観測は一時キューに保持され、再接続時に送信されます。送信済み／確認済み／欠損可能性を区別して扱います。**配信報告がないことは、欠損がない証拠ではありません。** 履歴・スナップショットが不足する場合、再生・差分・保存状態を推測で補完しません。

### 出力形式

| 出力 | 主な用途 |
| --- | --- |
| Session生データJSON | Session、Stage、保存Map、イベント、履歴等の確認 |
| 共通／用途別CSV、イベントJSON、ZIP | 絞り込み研究イベントや操作履歴の抽出 |
| 実施単位 `research.json` / `research.csv` | 実施に属するSessionの状態や研究データの照合 |
| `research.xlsx` | **Overview、Events、Map_Operations、Activity_Times、Map_States、Operations、System_Events、Researcher_Events、SB_Analysis、KB_Analysis、Integration_Analysis** の11シート |

実施単位の3形式（JSON/CSV/11シートExcel）は、登録取消済みSessionを**通常の出力対象から除外**します。ただしDB上の登録・監査履歴および既に取得済みの出力は保持されます。[登録取消の運用ガイド](docs/experiment-session-withdrawal.md)で範囲を確認してください。

Excelは派生出力であり、既存のJSON/CSVを置き換える原本ではありません。Excelの行・セル・展開サイズ等には上限があり、上限超過時は一部切り捨てではなくエラーになります。[Excel仕様](docs/research-workbook-11-sheets.md)・[イベント出力仕様](docs/research-event-export.md)を参照してください。

## 開発・テスト

### 静的チェックとビルド

ホスト側にNode.js / npmと依存関係がある場合、リポジトリのルートから実行します。

```powershell
npm ci --prefix frontend
npm ci --prefix backend

npm run typecheck --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend

npm run typecheck --prefix backend
npm run lint --prefix backend
npm run build --prefix backend
```

Viteの500KB超チャンク警告はビルドの失敗とは異なります。**通常の本番ビルド時には `NODE_ENV=development` を残さないでください**。合成APIのブラウザーテストと、実API・DBテストの意味を区別します。

### ブラウザー受け入れ検証（合成API）

```powershell
npm run test:rehearsal-ui-browser --prefix frontend
npm run test:stage1-analysis-layout-browser --prefix frontend
npm run test:r05-analysis-ui-browser --prefix frontend
```

`test:rehearsal-ui-browser` はP02、3モードの練習、終了/F5/開始、390px操作、既存画面への回帰を検証します。Stage 1 / R05の分析画面テストは合成応答・ブラウザーでの表示検証であり、実DBへの保存検証ではありません。Windowsのブラウザー検証では既存のMicrosoft Edgeを利用します。

既存のスクリーンショットを保護するため、Stage 1分析テストの出力先は一時パスを指定できます。

```powershell
$env:ANALYSIS_SCREENSHOT = Join-Path $env:TEMP "stage1-analysis-check.png"
npm run test:stage1-analysis-layout-browser --prefix frontend
Remove-Item Env:ANALYSIS_SCREENSHOT -ErrorAction SilentlyContinue
```

### 隔離DBと実APIの検証

**既存Compose DBや実研究DBを対象にしないでください。** 専用の合成データPostgreSQLコンテナーと、照合可能な専用manifestを使います。

PowerShellで新規の隔離環境を準備する例：

```powershell
# DATABASE_URLが設定されたシェルでは実行しない
if (Test-Path Env:DATABASE_URL) { throw "DATABASE_URL is set; abort" }

$mockName = "stage1_mock_readme_$(Get-Date -Format 'yyyyMMddHHmmss')"
$env:NODE_ENV = "development"
$env:STAGE1_MOCK_DATA = "ONLY_SYNTHETIC"
$env:RESEARCH_CHECK_REPORT_PREFIX = "readme-$(Get-Date -Format 'yyyyMMddHHmmss')"

docker info
npm run db:mock --prefix backend -- create --name $mockName --mock-data-only
npm run db:mock --prefix backend -- migrate --name $mockName
npm run db:mock --prefix backend -- seed --name $mockName
npm run build --prefix backend
npm run db:mock --prefix backend -- check --name $mockName
```

`check` は模擬レコードを作成します。各コマンドが成功した場合だけ次へ進んでください。テスト対象は必ず新規作成した専用模擬DBに限定します。

```powershell
$env:RESEARCH_BROWSER_CHECKS = "1"
$env:RESEARCH_SUITE_ONLY = "test:experiment-research"
npm run db:mock --prefix backend -- suite --name $mockName
```

登録取消について、同じ模擬DB環境で `$env:RESEARCH_SUITE_ONLY = "test:experiment-withdrawal-acceptance"` を指定すれば、合成参加者2件の登録→1件取消→コード失効→取消履歴→実施単位JSON/CSV/11シートExcelの整合性を検証できます。専用テストも既存の総合CIに含まれます。

隔離DBテストでは、練習専用ラベルのConcept / Link、保存履歴、研究イベント、JSON/CSV/Excelへの非混入を検証します。研究データの自動削除やリセットは行いません。

```powershell
# テスト後は現在のシェル内の設定を解除
Remove-Item Env:NODE_ENV,Env:STAGE1_MOCK_DATA,Env:RESEARCH_BROWSER_CHECKS,Env:RESEARCH_SUITE_ONLY -ErrorAction SilentlyContinue
```

詳しくは[隔離DBの作成・保護・検証手順](docs/development-event-stream-reset.md)を参照してください。`db:mock reset` は**明示的な確認付き操作**であり、通常の開発・回帰確認では使用しません。

### Issue #75 の受け入れ検証

[Issue #75](https://github.com/kiyo1204/sb-kb-integration/issues/75) / [PR #76](https://github.com/kiyo1204/sb-kb-integration/pull/76) で、390pxの実ドラッグ・接続、3モード完了後のF5/開始、研究データ非混入を検証しました。ローカルの型チェック・Lint・ビルド・ブラウザーテスト、隔離DBテストおよびGitHub Actionsの研究イベント整合性CIが成功しています。これは**合成・隔離環境における受け入れ結果**であり、実研究参加者を使った検証を意味しません。

## 実験用4活動フローの有効化

通常Composeでは、`STAGE1_EXPERIMENT_LEARNER_ENABLED=0`（既定）です。教材管理・実施準備ができても、この状態では実施開始や学習者の活動・Map編集・提出を有効化しません。

**対象DBとバックアップを確認し、必要なmigrationを明示的に適用した後に限り**、`.env` の設定を `STAGE1_EXPERIMENT_LEARNER_ENABLED=1` へ変更し、APIコンテナーを**再作成**します。

```powershell
docker compose up -d --no-deps --force-recreate api
```

`.env` を変更して `docker compose restart api` しただけでは環境設定は更新されません。`STAGE1_EXPERIMENT_LEARNER_PREVIEW=1` は別の隔離開発用経路であり、通常Composeの有効化に使用しません。機能停止時は設定を `0` に戻してAPIを再作成します。既存の保存データや終了済み実施をリセットしません。**この設定は実研究での利用許可を意味しません。**

## LANでの模擬利用

閉じたLANでの開発・模擬データ確認に限り、Windowsの起動ショートカットを利用できます。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-shortcuts.ps1
```

作成した「研究用学習システム - LAN起動」を開き、参加者と同じローカルネットワーク上のアダプターを選択します。手動起動・停止用スクリプトは `scripts/start-lan.ps1` / `scripts/stop-lan.ps1` です。

LANモードのHTTP通信は**暗号化されません**。利用する場合はプライベートネットワークに限定し、Windowsファイアウォールの対象ポートをローカルサブネットのみに許可してください。ルーターのポート転送やインターネット公開を行わず、API・DBポートを外部公開しないでください。API・DBはloopback限定です。

通常のローカル接続に戻す例：

```powershell
$env:FRONTEND_BIND_ADDRESS = "127.0.0.1"
docker compose up -d --force-recreate frontend
Remove-Item Env:FRONTEND_BIND_ADDRESS -ErrorAction SilentlyContinue
```

詳しい設定や障害対応は現行運用の手順・[Stage 1研究プロトタイプ仕様](docs/stage1-research-prototype.md)を確認してください。

## 安全上の注意と運用制約

- **実研究参加者のデータを入力・取り込まない。** HTTPS、秘密情報管理、バックアップ、復旧、参加者への説明・同意等の運用要件は別途整備が必要です。
- 研究者用Bearerコードは共有資格情報です。研究者別の個別アカウント・細分化した権限管理ではありません。
- 認証コードやパスワードをURL・スクリーンショット・Gitのコミットに残さないでください。
- 旧プロトコル、既存のDB、マップ・操作ログ、Provenance、出力形式を変更・消去せず保持してください。
- `docker compose down -v`、無条件のDBリセット、`git clean -fd`、`git reset --hard` は使わないでください。
- テスト成果物（`.local/`、`docs/*-results.json`、一時画像など）の削除・上書き・コミットは、所有者と用途を確認してから行ってください。

## 関連ドキュメント

- [Stage 1研究プロトタイプの仕様・制約](docs/stage1-research-prototype.md)
- [新5活動フローとアンケート](docs/session-flow-survey.md)
- [研究イベント・検証マトリクス](docs/research-event-test-matrix.md)
- [研究データ辞書](docs/research-data-dictionary.md)
- [研究イベントの保持・再送・ACK](docs/research-event-delivery.md)
- [イベント出力仕様](docs/research-event-export.md)
- [研究イベントの閲覧](docs/research-event-viewer.md)
- [研究データ管理（旧フローの履歴仕様）](docs/research-data-management.md)
- [実験用Sessionの登録取消・履歴・失効の運用ガイド](docs/experiment-session-withdrawal.md)
- [11シート研究Excelの仕様](docs/research-workbook-11-sheets.md)
- [隔離DBの作成・リセット防護](docs/development-event-stream-reset.md)
- [Kit-Build関連の参考資料](docs/kit-build-interaction-references.md)
- [Issue #75の受け入れ検証](https://github.com/kiyo1204/sb-kb-integration/issues/75)

---

このREADMEは、機能の紹介、ローカルでの立ち上げ、研究データ保護、再現可能な検証の入口をまとめたものです。より詳細な動作・移行・運用条件はリンク先の仕様を優先してください。
