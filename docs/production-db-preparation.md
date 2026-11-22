# 学校・研究室LAN用の本番DB準備（**未起動・未適用**）

> このPRは本番PostgreSQLの**構成案**を保存するだけです。Docker起動、volume作成、migration、seed、実研究データの移行・接続は行いません。実参加者データの保存はまだ許可されません。

## 既存環境の保護

- 既存のsbkb-rehearsal-20261122125146（API 3001、Web 5174、DB 5433）、TEST-A・TEST-B、保存Map、履歴、Provenanceを一切操作しません。
- 本番DB設定は compose.production-db.yaml **単独**で使用。開発用 compose.yaml / compose.lan.yaml と同時指定しないでください。
- Composeプロジェクト名は sbkb-production-db に固定。サービスはPostgreSQLのみ、ホスト公開ポートなし、Docker内部ネットワークのみ、専用volume（将来の想定名 sbkb-production-db_pgdata）。
- 既存のリハーサルDB/volume/データを本番DBに流用・コピーしません。
- 管理者パスワードはCompose secretsを用いて外部ファイルから読み込み、Git・チャット・ログに保存しません。PostgreSQL 17イメージは人が承認したSHA-256 digest固定が必須です。

## 今回準備したもの

| パス | 内容 |
| --- | --- |
| compose.production-db.yaml | 本番専用PostgreSQL 17定義。Web・API・DBホスト公開なし |
| production-db.env.example | 設定項目の無秘密テンプレート |
| .github/workflows/production-db-preflight.yml | 合成値でdocker compose configを実行する**静的検証のみ** |
| docs/production-db-preparation.md | 安全な準備と、起動前の承認条件 |

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

## CIの意味

静的CIは、ダミーdigest/秘密ファイルをRunner内で一時生成し、Compose設定の解析と「DBサービス単独・ホストポートなし・内部ネットワーク・secret参照・named volume」を検査します。**Docker up/run、migration、DB/volume作成、研究データの読み書きはしません。** CIがPASSしても本番DBとして運用可能とは判定しません。
