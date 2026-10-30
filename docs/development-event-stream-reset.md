# 開発用リセットと新イベントへの切替（Issue #12）

## 二つの環境を混同しない

既存環境は旧ログを変換せず保持し、Mapごとの切替境界に従って旧→新を読み取る。単に旧テーブルが存在するだけで旧形式の運用とは判断しない。境界・初期スナップショット・イベント・DB最終状態の一致で確認する。

本手順は**新しく作った、開発・模擬データ専用DB**だけを初期化する。既存Compose DBを対象に指定する手順は用意しない。リセットは画面・API・通常起動・Compose起動・マイグレーション・seedから自動実行されない。学習者から呼び出せないローカルCLIである。実研究データの運用・削除や移行に利用しない。

## 旧ログ依存の棚卸し

|箇所|依存と切替方針|
|---|---|
|`backend/src/index.ts`|Map更新のappendMapOperationLog、初期スナップショット、履歴照合、Undo/Redo。Stage 1は境界後にv2のみ記録、非Stage 1は旧経路を維持。旧関数名を理由に旧ログへの二重書きと解釈しない。|
|`map-history.ts` / `map-undo-redo.ts` / `map-mixed-history.ts`|初期状態から旧ログを適用し境界以後v2へつなぐ。既存旧履歴のみ・混在・新形式のみのいずれも保持。不整合はPARTIALで示す。|
|`stage1-analysis.ts` / `Stage1AnalysisPage.tsx`|旧・新操作の一貫した読取と履歴比較。評価・メモの旧ID外部キーと新event_idの両方を残す。|
|`research-export.ts` / `event-export-query.ts`|既存JSON/CSVとIssue #9/10の旧・新集合。空の旧ストリームでもv1〜v4のイベントを出力。|
|`research-events.ts` / v2検証|relatedLegacyOperationLogIdは既存参照のため維持。新規Mapはlegacy_count=0の境界を作成する。|
|`data-management.ts`|Issue #11の研究者による対象限定削除。全DB開発リセットとは別であり挙動を変更しない。|
|179070 / 179080 / 179083|旧ログ、研究者の評価・メモ参照、Undo/Redoの基盤。既適用ファイルを変更しない。|
|179089〜179101|v1〜v4、混在境界、旧ID参照、信頼性、仮名管理、対象限定削除。新規DBにも順に適用し、互換テーブルを残す。|
|`seed-dev.ts`|開発Goal/Kitを準備する。履歴変換・削除・リセットを行わない。新形式検証前の旧ログと新イベントが0件であることを確認。|
|`verify-stage1.ts` / `verify-map-api-v2.ts` / `verify-research-events.ts` / `verify-event-export.ts` / `verify-data-management.ts`|旧形式を意図的に生成するものは互換・境界・削除の検証用fixtureであり削除しない。新形式のみの起動確認は専用`verify-mock-reset-new-stream.ts`を追加する。|
|README / Compose / LAN・Windows起動|既存の起動手順を維持。リセットを通常起動に組み込まない。専用CLIだけで隔離DBを作成・接続する。|

## 防護条件と限界

- NODE_ENV=development と STAGE1_MOCK_DATA=ONLY_SYNTHETIC を両方要求する。DATABASE_URLが既に設定されている場合は接続前に拒否する。
- 対象名はstage1_mock_接頭辞と英小文字・数字・アンダースコアだけ。リポジトリの`.local/mock-reset/<name>.json`に専用作成時のコンテナーID・nonceを記録する（資格情報なし、Git対象外）。既存DBをこのmanifestへ取り込む機能はない。
- 毎回Dockerから実体ID・名前・専用purposeラベル・nonceラベル・DB名・専用role・127.0.0.1のみの動的ポート・外部bindなしを照合する。
- DBに接続した後も、専用schema内のONLY_SYNTHETICマーカー、nonce、PostgreSQL system_identifier、実際のDB名・role、許可したschemaを照合する。マーカーがない・違う・環境が不明なら拒否する。
- 他のDBクライアント（idleを含む）がある場合、リセットしない。APIを停止してから行う。テーブルは同じトランザクションでロックし、全行の指紋と件数から作ったドライランhashが現在と一致する場合だけ実行する。
- `--execute`だけでは動作しない。DB名の再入力、plan hash、バックアップ確認、模擬データ再確認が全て必要。単一変数で本番を識別する方式ではない。
- これらは専用環境の来歴を検証する防護であり、自由記述の中身から実参加者データを完全判別するものではない。実データのimport、専用manifest/markerの偽造、管理者によるコンテナー差し替えは行わない。模擬専用の来歴を確認できない既存環境には利用しない。DB/OS/Docker管理者に対するセキュリティ境界ではない。

## Windows PowerShell: 初回準備

Docker Desktopを起動し、Node/npmを準備する。リポジトリルートで次を実行する。既存Compose DBの停止・削除・移動は不要。

```powershell
npm ci --prefix backend
$env:NODE_ENV = 'development'
$env:STAGE1_MOCK_DATA = 'ONLY_SYNTHETIC'
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
npm run db:mock --prefix backend -- create --name stage1_mock_demo --mock-data-only
npm run db:mock --prefix backend -- migrate --name stage1_mock_demo
npm run db:mock --prefix backend -- seed --name stage1_mock_demo
npm run build --prefix backend
npm run db:mock --prefix backend -- check --name stage1_mock_demo
```

createは新しいpostgres:17-alpineコンテナーを作り、DBポートはloopbackの空きポートだけに割り当てる。既存名・manifestを上書きしない。migrate/seed/checkは検証済みDBのURLを子プロセス環境へだけ渡し、URL・パスワードを端末やログに出さない。checkは実際の模擬データを作るので、実行後はDBが空ではない。6活動の統制群Sessionを実APIで完了し、期限確認用fixtureの自主学習開始時刻だけを2分前に設定して待機時間を短縮する。アプリの活動順や期限判定は変更しない。

## ドライラン→明示実行

先にmock serve/APIとDB検査ツールを終了する。バックアップが必要か確認し、必要なら対象コンテナーのpg_dumpをローカルに保存する。バックアップにも模擬回答等が含まれるためGitへ追加しない。

```powershell
# manifestのcontainerIdを目視確認し、この専用コンテナーだけでdumpする。
$mock = Get-Content .local/mock-reset/stage1_mock_demo.json | ConvertFrom-Json
# テキストSQLのバックアップ。エラー時は実行を進めない。
docker exec $mock.containerId pg_dump -U stage1mock -d stage1_mock_demo --no-owner --no-privileges | Set-Content -Encoding utf8 "$env:TEMP/stage1_mock_demo-backup.sql"
if ($LASTEXITCODE -ne 0) { throw 'バックアップに失敗しました' }

npm run db:mock --prefix backend -- plan --name stage1_mock_demo
# resetだけでもドライラン。表示されたDB名・環境・全テーブル件数を確認する。
npm run db:mock --prefix backend -- reset --name stage1_mock_demo
# 以下のPLAN_HASHは直前のplanHashへ置き換える。
npm run db:mock --prefix backend -- reset --name stage1_mock_demo --execute --confirm-db stage1_mock_demo --confirm-plan PLAN_HASH --backup-reviewed --mock-data-only
```

DB内のpublic/research_identityのアプリテーブルを**全て**空にする。map_operation_logsだけでなく、Map・Concept/Link・Provenance・初期snapshot・境界・research_events・評価回答/問題・研究者評価/メモ・送信receipt・仮名対応・失効情報・削除receipt・研究設定・Goal/Kitも対象。明示表示する件数はその時点のDB行数である。PostgreSQLのTRUNCATEを全対象へ同時に行い、外部schemaからの未対応参照があればCASCADEせず拒否する。

pgmigrationsと専用guardは保持し、既定の研究行だけを空状態の初期値として再作成する。旧ログの変換・新イベントへのコピーは一切しない。件数・行内容が変わった場合は新しいドライランが必要。DB処理はトランザクションでロールバックする。API停止後、専用`.local/mock-reset/<name>/exports`だけを削除する（realpathがリポジトリの専用領域と一致することを検証し、symlink/junctionによる逸脱なら拒否）。一時ファイルは先に消え、DB確定が失敗する可能性があるため必要なら再出力する。他の作業場所・通常APIの一時出力は対象外。

消去した研究データをリセット後のアプリから復元することはできない。Undo/Redoもバックアップの代わりにならない。必要なdumpがない場合の復元はできない。復元確認は別の隔離コンテナーで行い、通常DBへimportしない。ブラウザーIndexedDB、取得済みファイル、バックアップはDBリセットの対象外。模擬練習専用ブラウザープロファイルを使い、該当originのキューを明示消去してから再利用する。リセット後に通常DB向け資格情報で模擬操作しない。

## 再初期化後の起動

```powershell
npm run db:mock --prefix backend -- seed --name stage1_mock_demo
npm run build --prefix backend
npm run db:mock --prefix backend -- check --name stage1_mock_demo
# 手動UI確認用の模擬研究者コード。実運用のコードを指定しない。
$env:RESEARCHER_API_TOKEN = 'mock-only-local-development-researcher-code'
npm run db:mock --prefix backend -- serve --name stage1_mock_demo
# 別端末でfrontendを起動（API_PROXY_TARGETは通常のlocalhost:3000）
# npm ci --prefix frontend
# npm run dev --prefix frontend
```

serveはlocalhostだけでAPIを起動し、フロントは従来どおりプロキシで接続する。通常のNode/API起動の既定値は変更しない。模擬serveでポート3000が既存APIと競合する場合は他の作業を止めず、別の空きPORTと対応するAPI_PROXY_TARGETを手動指定する。テストcheckは空きポートを使用する。研究者コードは環境へ設定するだけでURL・ログへは出力しない。

終了はAPI/フロントの端末でCtrl+C、その後 `docker stop stage1_mock_demo`。データを残す停止でありリセットではない。再起動は `docker start stage1_mock_demo` の後、同じガードで確認して利用する。manifestを失った場合は既存DBを推測して登録し直さず、新しい名前で模擬環境を作る。

## 自動検証

`npm run db:mock --prefix backend -- safety --name stage1_mock_demo` はこの模擬専用DBを実際にリセットする検証なので、同じ防護を通った隔離fixtureに限る。通常起動やCIの無条件ステップには追加しない。checkは新形式のみ、既存の混在履歴検証は旧・新の共存を検証する。両方を残す。
