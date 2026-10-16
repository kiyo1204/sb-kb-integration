# Stage 1研究用学習システム

## このシステムについて

授業後のマップ作成・再構成の過程を記録し、研究者が後から分析できるようにするローカル動作確認用プロトタイプです。React / TypeScriptの画面、Express / TypeScriptのAPI、PostgreSQLのデータベースで構成し、Docker Composeで起動します。

### 学習者の活動

学習者向けのSessionは次の4活動で構成されます。研究者分析はSessionの外で行い、学習者向けの第5段階には含めません。

1. **授業動画** — Sessionに設定された授業動画を視聴します。
2. **Scratch-Build** — 授業後に概念マップを自由作成します。初期状態は概念「注意」のみです。
3. **Kit-Build** — Goal Map全体を再構成できるKit部品を使ってマップを作ります。構造変更のたびに一致状況と見直す箇所を表示し、Goal Mapと一致するまで提出できません。完成Goal Mapや正解の接続先は学習者に表示しません。
4. **Integration** — Scratch-Buildの提出マップを引き継ぎ、Kit部品や自由入力を使って統合します。

旧チュートリアル、事前説明問題、事後説明問題は現行アプリの学習フローから除いています。

### 記録・分析機能

- Concept / Linkの追加、編集、削除、移動、再接続、Kit部品の取込み、Conceptの統合
- Concept / LinkのIDとProvenanceを含む操作ログ、マップ編集開始時の初期スナップショット
- 研究者向けの読み取り専用履歴再生と、学習者向けUndo / Redo
- 3種類のマップと操作履歴の研究者向け表示
- 研究者によるU/I/P/V手動評価、評価理由・評価者コード、操作や命題に結び付けた振り返りメモ
- JSON / CSV Exportと`stage1-descriptive-v2`記述的特徴量
- Kit-Buildに限り、Goal Mapとの一致状況を概念・関係の集計で反復フィードバックします。Stage 1 SessionにはGoal Map全体を含むKitDefinitionだけを割り当てられます。フィードバック判定は操作ログに記録せず、Integrationには表示しません。

履歴再生は保存された初期状態と操作ログを適用します。スナップショット導入前のマップや、ログに欠損がある場合は完全再生できず、利用可能な履歴状態を明示します。操作数やU/I/P/Vを学習の良さを示す点数として扱う機能はありません。Kit-Buildの一致確認以外の正誤診断やAI評価は行いません。

### アクセス制御と適用範囲

- 研究者は研究者用BearerコードでSessionを作成・分析し、評価・振り返り・Exportを行います。
- 学習者はSession専用コードでログインし、自分に割り当てられたSessionとKit部品を利用します。他参加者のデータ、Goal Map、研究者用分析APIにはアクセスできません。
- API側でロールとSessionの権限を確認します。ブラウザーの画面表示だけに依存した制御ではありません。

研究者コードは全研究Sessionにアクセスできる共有資格情報で、個別研究者アカウントや研究者ごとの権限管理はありません。Composeの公開ポートは既定で`127.0.0.1`にバインドされ、HTTPSも設定されません。この構成はローカル確認用です。LANやインターネットでの公開、実参加者を受け入れる運用にそのまま使用しないでください。運用上の仕様と制約は[Stage 1研究プロトタイプ](docs/stage1-research-prototype.md)を参照してください。

## 必要なもの

- Git
- Docker Desktop（Docker Compose v2を含む）

Node.jsとPostgreSQLはコンテナ内で動作するため、PCへ個別にインストールする必要はありません。

## 初回起動

リポジトリのルートで`.env.example`を`.env`へコピーし、`.env`の`RESEARCHER_API_TOKEN`に32文字以上のランダムな秘密値を設定します。空欄ではAPIは起動しません。`.env`やトークンをGitへコミットしないでください。

PowerShell:

```powershell
Copy-Item .env.example .env
```

その後、リポジトリのルートで実行します。

```sh
docker compose up --build -d
docker compose exec api npm run db:migrate -- up
docker compose exec api npm run db:seed:dev
```

最後のコマンドで開発用Kitを登録します。ブラウザーで<http://localhost:5173>を開き、研究者コードでログインしてください。独自のGoal Mapを登録する場合は、トップ画面の「Goal Mapを作成・管理」から新しいマップを作成し、ConceptとLinkを編集してKitとして登録します。Kit登録後は元のGoal Mapが読み取り専用になります。Stage 1 Session作成画面で使用するKitを選び、発行された学習者コードを渡してください。

`.env`のデータベース初期値はローカル開発用です。パスワードを変更する場合は、Composeが`DATABASE_URL`を組み立てられるURL安全な文字を使ってください。`STAGE1_BIND_ADDRESS`の既定値は`127.0.0.1`です。

## 2回目以降の起動と停止

```sh
docker compose up -d
```

ブラウザーで<http://localhost:5173>を開きます。停止するときは次を実行します。

```sh
docker compose down
```

通常の停止ではデータベースの内容は保持されます。Dockerfileや依存パッケージを変更した場合は、`docker compose up --build -d`でイメージを再構築してください。

Windowsで日本語を含むパスからDockerイメージの構築に失敗する場合は、`C:\work`など英数字だけのフォルダーにリポジトリを置いて起動してください。

## 参考資料

Kit-Build手法の論文引用、既存実装の調査、ライセンスの扱いは[Kit-Buildの参考資料](docs/kit-build-interaction-references.md)を参照してください。
