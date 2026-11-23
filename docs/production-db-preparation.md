# 学校・研究室LAN用の本番DB準備（**未起動・未適用**）

> このPRは本番PostgreSQLの**構成案**を保存するだけです。Docker起動、volume作成、migration、seed、実研究データの移行・接続は行いません。実参加者データの保存はまだ許可されません。

## 既存環境の保護

- 既存のsbkb-rehearsal-20261122125146（API 3001、Web 5174、DB 5433）、TEST-A・TEST-B、保存Map、履歴、Provenanceを一切操作しません。
- 本番DB設定は compose.production-db.yaml **単独**で使用。開発用 compose.yaml / compose.lan.yaml と同時指定しないでください。
- Composeプロジェクト名は sbkb-production-db に固定。サービスはPostgreSQLのみ、ホスト公開ポートなし、Docker内部ネットワークのみ、専用volume（将来の想定名 sbkb-production-db_pgdata）。
- 既存のリハーサルDB/volume/データを本番DBに流用・コピーしません。
- 管理者パスワードはCompose secretsを用いて外部ファイルから読み込み、Git・チャット・ログに保存しません。PostgreSQL 17イメージは人が承認したSHA-256 digest固定が必須です。

## 同一PCで本番DBを準備する場合（2026-11-22追加）

この方式は**同じPCに別のDockerプロジェクトとDBボリュームを置く**ものです。論理的にデータを分離できますが、**PCの故障・ディスク満杯・Docker Desktop停止は両環境に影響**します。実運用では空き容量とメモリ、電源、別媒体または別PCへのバックアップを必須として計画します。

1. 現在のリハーサルが使用しているソース作業フォルダー・既存Dockerコンテナ・volume・network・.envは**そのまま保護**します。実験中の作業フォルダーへ直接git pullしたり、compose up/down、DB migration、リセット等を実行しません。
2. 本番準備用のソースは**別ディレクトリ**に固定リビジョンを取り出します。まだアプリやDBは起動せず、研究DBへの接続設定も作りません。
3. Docker Desktopが利用できる同じWindows PCで、別ディレクトリのソースに含まれる次の**読み取り専用チェック**を実行します。Docker contextとコンテナ・volumes・networksの名前/Composeプロジェクトラベルだけを確認し、データ内容・環境変数・パスワードは取得しません。

~~~powershell
# 本番準備用の独立フォルダーで実行（既存リハーサルフォルダーは更新しない）
powershell -NoProfile -File .\scripts\preflight-production-db-same-pc.ps1
~~~

4. 出力で**予期した本番用の名前に既存リソースが存在しないこと**を確認します。衝突があれば停止・再利用・削除はせず調査します。リハーサル候補が見つからない場合も、Docker contextと実際のリハーサル識別子を管理者が照合するまで、以後の作業を止めます。
5. 保存先の残容量・RAM・自動起動の影響と、別媒体バックアップを確定します。**同一PC内の別volumeだけではバックアップにはなりません。**
6. 承認後の別工程で管理者専用の秘密ファイルと .env.production-db を設定して、**docker compose configのみ**で静的検証します。実DBの起動・schema適用・データ投入はさらに後の明示的な承認事項です。

この事前チェックはGitHub上では実行できません。実際のPCのDocker状態を確認したとみなさないでください。リハーサル環境のDockerプロジェクト名が記録上の sbkb-rehearsal-20261122125146 と一致しない可能性があるため、名前の不検出を「環境がない」という証拠にしません。

## 今回準備したもの

| パス | 内容 |
| --- | --- |
| compose.production-db.yaml | 本番専用PostgreSQL 17定義。Web・API・DBホスト公開なし |
| production-db.env.example | 設定項目の無秘密テンプレート |
| .github/workflows/production-db-preflight.yml | 合成値でdocker compose configを実行する**静的検証のみ** |
| docs/production-db-preparation.md | 安全な準備と、起動前の承認条件 |
| scripts/preflight-production-db-same-pc.ps1 | 同一PCのDocker context・名前衝突を読み取り専用で確認 |

## 管理者が後から行う準備（**今回未実施**）

1. 本番専用のサーバー/ディスク/保存先を決定し、リハーサルと物理的にも分離できるか確認します。電源、空き容量、OS/ストレージ暗号化、監視、OS更新の運用も決めます。
2. 別の専用作業ディレクトリにレビュー済みのソースを配置します。production-db.env.example を .env.production-db にコピーし、DB名、専用管理者名、**公式PostgreSQL 17-alpineの検証済みマニフェストdigest**を入力します。既存の開発用 .env はコピーしません。
3. 管理者専用の独立したランダムパスワードを生成し、**リポジトリ外**のアクセス制限済みファイルに保存します。SBKB_PROD_DB_ADMIN_PASSWORD_FILEには**絶対パスだけ**指定します。研究者認証コードやリハーサルDBのパスワードを使い回しません。パスワードそのものをチャットに送らないでください。
4. 現在のDockerコンテナ・volume・ネットワークを読み取り照合します。sbkb-production-db と同名の既存リソースがあれば、**起動せず**帰属を確認します。
5. 以下の静的検証を実施します。**DBは起動しません。**

~~~powershell
Copy-Item production-db.env.example .env.production-db
# .env.production-db に必要項目を設定し、秘密ファイルはリポジトリ外へ
docker compose --project-name sbkb-production-db --env-file .env.production-db -f compose.production-db.yaml config --quiet
~~~

.gitignoreの既存規則 .env.* により .env.production-db はGit追跡対象外です。上記が成功しても、DB自体が起動・初期化されたことや秘密ファイル権限の妥当性を示すものではありません。

## 起動前の必須承認ゲート

- 本番DB用の管理者権限と、**管理者資格情報を使わない最小権限のアプリ用DBロール**を別途設計する。現在はアプリロールを作成していません。
- バックアップ周期・保存期間・暗号鍵管理・別媒体保管・復元目標（RPO/RTO）を確定する。**独立した隔離DBで復元テスト**を行う手順を準備する。現在はバックアップ自動化も復元テストも未実施です。
- マイグレーション計画とロールバック互換性をレビューする。db:seed:devやdb:mock系の操作を本番に使用しない。
- データ保存期限、同意・撤回・削除、監査の運用責任者を決める。
- Docker接続先、プロジェクト名、volume、ネットワーク、DB名の相互照合を行い、リハーサルへの接続がないことを確認する。
- 本番APIは現時点で未構築・未接続。実参加者のデータは投入しない。

## 禁止

- compose.production-db.yamlを開発用Composeと同時使用すること。
- down -v、volume rm、DROP/TRUNCATE、DB reset、mock reset、開発seedなど、既存データを失う操作。
- 本番DBの5432を学内LANやインターネットへ直接公開すること。
- CIのダミー資格情報・合成データを本番に使うこと。

## 旧Session削除と最小権限の両立（適用前）

> **本番適用判定：BLOCKED。** 今回確認したのはローカルの分離模擬DBと手順案のみです。本番接続先、実際の移行履歴・ACL、直前バックアップと復元可能性の確認、および本番適用の個別承認が残っています。


旧Sessionの確定削除と未開始Sessionの整理は、同じトランザクションで対象状態・依存関係を確認します。スナップショットの読み取り・追記に必要な権限だけをアプリに付与し、削除時の排他ロックは対象テーブル所有者の補助関数へ委譲します。

- マイグレーションは public.map_initial_snapshots の所有者である専用マイグレーターで実行します。関数は引数なしの SECURITY DEFINER、固定 search_path=pg_catalog, pg_temp、ONLY public.map_initial_snapshots への EXCLUSIVE ロックだけを行い、同じマイグレーショントランザクションで PUBLIC の EXECUTE を取り消します。実行後は関数所有者と対象テーブル所有者が一致し、sbkb_prod_migrator であることを照合します。
- production-app-acl-51-review.sql は検査と明示モードのACL適用用です。既定の apply_acl=0 は永続変更を行いません。apply_acl=1 は同一トランザクション内で、sbkb_prod_migrator が public に今後作成するオブジェクトについて、sbkb_prod_app へのテーブルSELECTとシーケンスUSAGEの既知のデフォルト付与だけを取り消し、その後に必要最小限の権限を設定・照合します。既存オブジェクトのACL、PUBLICや他ロールの付与、別スキーマの付与は一括取消しません。スキーマ指定のREVOKEはグローバルデフォルト付与を打ち消さないため、グローバルまたは別スキーマの対象付与が残れば照合失敗となります。想定外の実効権限・デフォルトACLがあればトランザクション全体をロールバックして停止し、全体取消しへ広げません。
- 一時的なデータベースCREATE権限はマイグレーション試行の後に別SQLで取り消します。成功・失敗どちらの経路でも、revoke-migrator-database-create-950b0be.sql を対象DB名で照合して実行し、実効CREATE権限が残らないことを確認します。継承や別の付与元により残る場合、スクリプトは対象外の権限を変更せず失敗します。APIは起動しません。

ACL SQLと一時CREATE取消SQLは役割が異なります。ACL SQLはDB所有者または必要なGRANT権限とsbkb_prod_migratorのデフォルト権限を管理できる承認済み管理ロールで実行し、最初はapply_acl=0で照合します。既知のデフォルト付与だけを取り消す適用は別途承認後にapply_acl=1で行います。マイグレーション自体はsbkb_prod_migratorで実行し、一時CREATEの付与元と同じ権限管理ロールが、成功時・失敗時ともマイグレーション処理終了後の新しいpsql接続で取消SQLを実行します。失敗したpsqlトランザクション内で後続の取消を続けません。実効権限が残るときは停止し、別付与元・継承先を一括変更しません。
- 削除APIは従来のロック順序、同一トランザクション、5秒のロックタイムアウト、削除条件、資格情報失効、対象外データ保護を維持します。補助関数やACLが不足すれば削除はロールバックされます。APIを旧版へ戻す場合も関数を残しますが、最小権限ACL下では旧版の確定削除は失敗するため、修正版との整合を確認します。

### 移行履歴の完全照合

期待履歴は正式チェックアウトのマイグレーションファイルから作り、DB履歴から生成しません。今回の51件候補は、HEAD 950b0be2a71e32971920b60b912eb6c0112c0800 の50ファイルに、未コミットの51件目 1791260000000_lock_initial_snapshots_for_deletion.js（SHA-256: 9629be8c78b808daf4fc2440c67e79d1a026ffb5c2490f993d2ee1da91993fab）を加え、node-pg-migrateのtimestamp順で作成しました。対応する候補一覧SQLのSHA-256は ca4c03427f849da936de9d0ee0a0aa79042b52fcb146a7a5d7432c9986b6546b です。ソースコミットまたは51件目のファイルが変わった場合はこの一覧を再生成し、古い一覧を使いません。

verify-migration-history-950b0be.sql は pgmigrations の name を適用順 run_on, id で並べ、候補位置・名前・件数を完全比較する読み取り専用検査です。比較SQLはSELECTとpsql変数だけで構成し、read-only transaction内で一時表等のDDLも実行しません。適用前は expected_migration_count=50 とし先頭50件のみを許容し、適用後は 51 として全件一致を要求します。同じ件数での差替え、欠落、余分な行、順序違いはいずれも失敗します。履歴テーブルがない空DBや別件数のDBには使用せず、空DBの全件移行試験は分離した模擬DBで別に行います。候補一覧と比較SQLは scripts/production-db/ に配置し、SQL内の \ir 参照先も同じディレクトリに保ちます。

以下のコマンド例は、対象チェックアウトのリポジトリルートを作業ディレクトリにして実行します。psqlの-fに指定する相対パスは作業ディレクトリ基準です。SQL内の \ir は呼出元SQLファイルのあるディレクトリ基準で解決されます。参照先を同じ scripts/production-db/ に配置しているため、リポジトリルート以外から作業する場合も、-fには対象チェックアウト内のSQLへのパスを指定すれば相対参照が解決します。別チェックアウトでは、このSQL一式を含む同じ版を使用してください。

配置したSQLの役割と実行条件:

- approved-migration-history-950b0be.sql は、HEAD 950b0beと51件目の候補マイグレーションに対応する版固有の51件一覧です。マイグレーション構成が変わった場合は再生成し、別版へ流用しません。
- migration-history-compare-950b0be.sql は、期待一覧とDB履歴を名前・件数・順序で比較する共通断片です。verify-migration-historyとACL確認SQLから相対参照され、単独実行しません。
- verify-migration-history-950b0be.sql は履歴の読み取り専用照合です。既存50件からの適用前確認は50件、適用後は51件を指定し、空DBでは実行しません。
- production-app-acl-51-review.sql の apply_acl=0 は比較用で、永続ACLを変更しません（内部で一時オブジェクトを使います）。apply_acl=1 は既知のデフォルト付与を変更するため、対象・実行ロール・事前差分を確認したうえで個別承認後に限ります。
- revoke-migrator-database-create-950b0be.sql の apply_revoke=1 はDB CREATE権限を永続的に取り消します。マイグレーションの成功・失敗が確定した後、新しい接続を使い、許可された権限管理ロールから実行する個別承認対象です。

履歴照合は読み取り専用です。ACL比較モードと権限変更SQLは役割が異なるため、比較を権限変更と取り違えず、変更モードを事前承認なしに指定しません。
照合コマンド例（確認済みDB名を個別に渡し、接続文字列は記録・表示しない）:

    psql -X -v expected_database=<確認済みDB名> -v expected_migration_count=50 -f scripts/production-db/verify-migration-history-950b0be.sql

    psql -X -v expected_database=<確認済みDB名> -v expected_migration_count=51 -f scripts/production-db/verify-migration-history-950b0be.sql

    psql -X -v expected_database=<確認済みDB名> -v apply_acl=0 -f scripts/production-db/production-app-acl-51-review.sql

    # 個別承認後のACL適用時だけ apply_acl=1 を指定する。
    psql -X -v expected_database=<確認済みDB名> -v apply_acl=1 -f scripts/production-db/production-app-acl-51-review.sql

    # マイグレーション成功後・失敗後のいずれも、新しい接続で実行する。
    psql -X -v expected_database=<確認済みDB名> -v apply_revoke=1 -f scripts/production-db/revoke-migrator-database-create-950b0be.sql

本番適用前の順序:

1. Docker context、Composeラベル、コンテナ、DB名、volume、ネットワーク、使用ロールを読み取り確認し、対象の帰属を確定します。不明なら停止します。
2. 変更直前にDBとロール定義を別名でバックアップし、別媒体に保管して隔離環境で復元可能性を確認します。これは別途承認後に行います。
3. migration前に履歴50件の完全一致を確認します。既存50件からの更新で不一致、履歴の欠落・余分・順序違い、想定外の同名関数、ACL差分があれば停止します。
4. 必要と個別承認された場合だけ、専用マイグレーターへ一時CREATEを付与し、テーブル所有者としてマイグレーションを試行します。成否にかかわらず直後に専用の取消SQLを実行し、実効CREATEがないことを確認します。失敗時はmigration履歴と差分を保全し、APIを起動せず、自動逆マイグレーションもしません。
5. 成功後に履歴51件の完全一致を確認します。対象ACL案は権限変更前に既定モードで照合し、別途承認された適用時のみ apply_acl=1 を指定します。関数所有者、アプリの限定EXECUTE、直接DELETE・排他ロック拒否、実効ACL差分0を確認してから、さらに別途承認されたAPI起動へ進みます。

検証では正式チェックアウトのAPIビルド・型検査・変更対象Lint、隔離PostgreSQLでの51本適用、データ管理・未開始Session整理・マップ履歴・参加者アクセスの選択回帰4件が成功しました。別の空の模擬DBで移行後のACL差分0件と、制限付きアプリ用ロールでの確定削除、資格情報失効、対象外データ保護を確認しました。最初の専用ロール試験では模擬DBのガードとロール切替が衝突し、最小権限API試験の初回は先行試験の合成データが検証件数に混ざりました。どちらも検証を分離して解消しました。本番側の照合と直前バックアップは未実施です。

今回の分離模擬DBでは、read-only SQLによる履歴50件・51件の完全一致を確認し、同件数差替え・欠落・余分・順序違いをすべて停止できました。既知のpublicデフォルト権限取消、全51本のマイグレーション成功後と合成の失敗トランザクション後の一時CREATE取消を確認し、継承による実効CREATEが残る場合も停止しました。これらはローカル模擬DBのみの結果で、本番側の履歴・ACL・接続先の確認ではありません。
## CIの意味

静的CIは、ダミーdigest/秘密ファイルをRunner内で一時生成し、Compose設定の解析と「DBサービス単独・ホストポートなし・内部ネットワーク・secret参照・named volume」を検査します。**Docker up/run、migration、DB/volume作成、研究データの読み書きはしません。** CIがPASSしても本番DBとして運用可能とは判定しません。
