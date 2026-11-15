# LAN HTTP UUID generation fix

## Contract and scope
Researcher material, run and participant writes and R05 execution/operation/deletion IDs now reuse newClientId in client-identity.ts. It prefers native crypto.randomUUID and otherwise uses the existing crypto.getRandomValues UUID v4 bit layout. Without a safe source it throws SecureRandomUnavailableError; the researcher write handlers display its Japanese message and send no mutation. Retry keys stay in their existing refs/maps until the existing success rules clear them. R05 initializes proof/start keys inside its guarded start handler and retains them across uncertain responses. The unused weak temporary-ID fallback in MapPage was removed; newClientId returns a UUID or throws. Authentication/secret generators, backend UUIDs, DB schema and operation/event contracts were not changed. No dependencies or browser security exceptions were added.

## 模擬LANリハーサル当日の短い手順

この手順は合成データだけを使う閉じた模擬環境向け。今回の当日基準版は main merge `b34ebe5337dff2be2a8bbe3cbfe2362ac45a2096`。起動中のWeb/APIがこの版かを当日のローカル引継ぎ記録と照合し、異なる場合は実際の版を記録する。過去の2026-11-13記録は main merge `d6d85a5f58d2bb74648e94ff3c8a287d6304a90f`、Web source revision `uuid-795df3889fbbd2cd`（source commit `0e02905224047a88beae39b0ce4ce117ebd455cc`、同一tree `8e1d0a7f5f54307141fe37f61c0382de3c4b005a`）を対象としており、旧結果はこの追記で書き換えない。当日のURL、PID、manifest、認証ファイルの場所や識別値は公開文書へ転記せず、当日分のローカル `.local/mock-reset/` 引継ぎ記録を参照する。

1. **版・環境を照合する。** 引継ぎ記録、稼働中プロセス、待受、Web/API応答を確認し、アプリ版が当日基準に一致することを確認する。manifestとコンテナー識別情報から専用DB名・用途ラベル・識別値を照合し、値は転記しない。名前だけで模擬DBと判断しない。不一致、実DBの可能性、または確認できない状態があれば開始せず、reset・seed・既存DB接続をしない。APIとDBはloopback限定、Webだけを同一LANに公開し、preview設定は専用APIプロセスだけに適用する。Web表示と、Web経由の未認証API拒否を確認する。
2. **両PCの接続と認証を分ける。** 研究者PCは引継ぎ記録の研究者用URLで操作し、研究者コードはそのPCだけで扱う。参加者PC自身から同じLAN上のWeb URLを開く。ホストPCの表示成功を参加者PCの接続成功とみなさない。参加者コードは対応する参加Sessionに対して研究者画面から発行し、参加者PCだけで入力する。コードをURL、チャット、ログ、公開文書へ載せない。接続障害時はURL・ポート・同一LAN・待受を確認し、ファイアウォールやブラウザー保護を無効にしない。
3. **教材・実施・参加者を準備する。** 合成開発用Kitを使い、動画参照、教材説明、初期概念、統合時間、予定人数などの研究条件は承認済みのリハーサル計画に従って設定する。未指定の値を補わない。教材を完成登録し、その版で新しい実施を作成して参加者を登録する。保存済み一覧を確認して重複作成を避ける。予定人数を参加登録上限と混同しない。
4. **研究者が開始し、参加者が学ぶ。** 研究者が対象実施を開始し、参加者PCで開始待ちから授業へ進むことを確認する。授業の視聴確認後、SBを編集して保存完了を待ち、再読込後の復元を確認して提出する。KBを組み立てて確認し、一致する状態で提出する。KB提出はサーバーが最新Mapを再判定する。
5. **統合Mapと期限を確認する。** 既定の制限時間を研究者画面で確認し、続けて操作できるときに開始する。編集・保存後、手動提出または期限による自動提出のどちらかを区別して画面上の結果を記録する。自動提出の確認では画面を開いたまま期限を待つ。自動提出の画面報告だけでDBイベントまで確認済みとしない。受理後は「次へ」で参加者本人の活動を完了する。実施終了とSessionの本人完了は別の状態である。
6. **未提出者がいる場合は研究者が終了する。** 下書き保存と再読込で保存を確認した参加者は提出せずに待機する。研究者は参加者の現在状態を確認し、確認ダイアログを読んで実施を終了する。終了後の参加者画面は終了案内となり、Mapは表示されない。実施終了は未提出Mapを提出済みにせず、Sessionを本人完了・離脱・同意撤回へ変更しない。端末内の未送信データが送信・回収される保証はない。
7. **JSONとMap状態CSVを出力する。** 研究者画面の対象実施から研究用JSONとMap状態CSVを取得し、ファイルを保護されたローカル保存先に置く。CSVは既存16列を保った18列で、末尾2列は `mapStatus` と `mapSubmittedAt`。`status=AVAILABLE` は行の取得可能性で、提出状態は `mapStatus` で確認する。未提出・Map未作成の提出時刻は空欄のまま扱う。`INTEGRATION_START` と `ACCEPTED_SUBMISSION` の `point` / `recordedAt` はsnapshotの時点、追加2列は取得時点のMap本体を示す。欠測理由を補正せず、JSON・CSVは対象実施とSessionを確認して照合する。出力契約は[新protocolの研究者分析・Map状態CSV仕様](experiment-learner-flow.md)を参照する。外部の列数固定処理は未確認。
8. **終了後の状態と記録を確認する。** 模擬環境の識別を再確認したうえで、必要なDB確認は専用DBに対するREAD ONLY照会に限る。実施状態・終了時刻、A/BのSession状態、MapのDRAFT/SUBMITTED・保存時刻、必要な監査イベントを確認する。Map本文・認証コードは記録や報告へ転載しない。終了済み実施は再開せず、次の回は新しい実施を作る。
9. **専用環境を停止する。** 最終保存・出力確認後、当日引継ぎ記録でPID・作業場所・待受・コンテナーIDを照合し、今回の専用Web/APIだけを定められた方法で停止する。無関係なプロセスを止めず、DBコンテナーやvolumeを削除しない。環境を再利用する場合は、引継ぎ記録に従い専用DBを保持する。

**停止時の記録:** 発生時刻、PCの役割、画面・活動、直前の操作、表示された非機密エラー文言、保存成功を確認できたかを制限されたローカル記録へ残す。認証コード、接続秘密値、Map本文は残さない。保存結果が不明なら連打・再作成・再ログインをせず、状態を確認してから判断する。データやブラウザー保存情報を削除しない。権限制限下のプロセス一覧に見えないだけで停止と判断せず、必要なら許可された実行権限で確認する。本人完了、実施終了、未提出、離脱、撤回を混同せず、判断できなければデータを保持して中断する。

**適用範囲:** この手順は合成データ用の模擬環境に限る。実研究データを扱う前に、HTTPS等の通信保護、アクセス制限、バックアップと復元、実DBへのmigration適用・復旧手順を別途確認する。HTTPの模擬環境を実研究用途やインターネット公開に使わない。

過去記録では、ユーザーが実機2台で行った操作報告と、専用DBの読み取り照合、JSON/CSVのローカル照合、自動テストを別々に記録している。2026-11-15の通しリハーサルでは、ユーザー報告とREAD ONLYのDB確認でAの本人完了、BのSB下書きを残した実施終了、終了時刻を確認し、ユーザーが指定したJSON/CSVは実施・Session・Map状態と照合した。CSVは18列で、snapshotの取得時点とMap本体の現在状態を区別していた。同日の自動提出はユーザーから画面で確認したとの報告があったが、別個のDBイベント照合結果は記録されていないため、DBで確認済みとは扱わない。これらは10〜20台同時利用、HTTP通信の保護、実研究DBへの適用/復旧、本番運用の確認ではない。pause/resume の `UNKNOWN` は不確かな観測であり、確定した中断や活動時間として扱わない。

## Verification (2026-11-13 JST)
Windows, Node 24.15.0, Edge 157.0.4341.46 headless, 1366x900. An isolated worktree based on main b11b7e6f17387ef1263698bbbf630805ef23340b was used. A new PostgreSQL 17-alpine mock container was created and migrated through the canonical mock-db procedure. Its loopback-only binding, manifest nonce/labels and SQL guard were checked. The test API used its own loopback port; the existing rehearsal API/Web/DB were retained.

- test:uuid-lan-browser: PASS. Localhost native path called randomUUID 100 times; actual LAN HTTP origin had isSecureContext=false, no randomUUID and available getRandomValues. 100 fallback UUIDs matched version 4 and RFC variant, and were distinct.
- Browser actions against the product API created a draft material, a run and a participant. An accepted response was replaced with a synthetic 503; retry retained the identical key and returned the same entity, with one registered Session. Fixture Goal Map import and material completion/publication used the real API directly, rather than browser actions.
- Test-only removal of both browser random functions showed clear errors for material creation, run creation, participant registration and R05 start; no mutation requests were sent. GET state retrieval remained allowed.
- Existing R05 browser regression, using a temporary test copy with randomUUID unavailable: PASS through lesson/SB/KB/integration, accepted submission, response-loss retries, history deletion and retained completion record. This was a localhost fallback injection; the three researcher creation flows above used a real insecure LAN origin.
- Existing delivery browser regression with separate cache: PASS for offline/restart/lost ACK/ordered retry/storage loss/operation-key persistence. This regression uses synthetic API responses, not the real PostgreSQL API.
- Frontend typecheck, lint, build and git diff --check: PASS. Build retains the >500 kB chunk warning.
- Full suite not rerun.

Earlier targeted attempts failed due to test setup: LAN-only listener addressed through localhost; tsx function-name serialization in page.evaluate; an incorrect run button label; reimport of an already-fixed synthetic asset name; and an assertion reading the participants from the run-detail endpoint instead of the participant-list endpoint. The R05 regression initially lacked its required published-material fixture. These attempts were failures and were corrected as test setup/contract errors, not product success or a change to server semantics. An initial edit utility also failed on Windows text encoding; the isolated sources were restored from their base and rewritten explicitly as UTF-8 before verification.

## LAN rehearsal and review (2026-11-13 JST)
The reviewed Web source revision `uuid-795df3889fbbd2cd` was applied only to the dedicated synthetic rehearsal Web process after the user confirmed that unsaved input was preserved. The API, mock DB, proxy, process-only preview policy, and normal publication gate were retained. No firewall or browser-protection settings were changed.

Two physical PCs on the selected Wi-Fi LAN were used by the user. The user reported researcher material publication, run creation, participant registration, participant login/start waiting, lesson progression, and SB save/reload. Subsequent user reports covered participant A's completion, participant B's completion, researcher run ending, and output download. These were manual user reports; the agent did not perform or directly observe the physical-PC browser actions.

Read-only checks of the dedicated DB confirmed:
- Run `test`: two COMPLETED Sessions, six SUBMITTED Maps with stored submission timestamps. One integration Map has an automatic-submission timestamp and a successful MAP_AUTO_SUBMIT event. Both Sessions completed before the run ended. This run does not verify stopping an unfinished participant.
- Run `a`: ENDED at 2026-11-13 21:53:11 JST. The Session with the saved SB remains IN_PROGRESS; its SB Map remains DRAFT with null submitted_at and null Session completed_at. A second registered Session remains NOT_STARTED. The run end did not turn the draft into a submission or participant completion.
- The earlier read during the user's end operation saw RUNNING; a later read after the success audit confirmed ENDED. This ordering is not evidence of a persisted-state/display defect.
- A's pause/resume UNKNOWN observations remain uncertain observations and are not interpreted as confirmed interruptions or measured activity time.

In the preceding output-verification task, four explicitly identified local synthetic exports were parsed without displaying Map bodies. Both CSVs preserved the first 16 columns and appended mapStatus/mapSubmittedAt as columns 17/18. Run/Session/Map references, saved status, timestamps and Map state agreed with JSON and DB. Start/submission snapshot state and recordedAt were distinguished from current Map metadata. Missing integration Maps remained UNAVAILABLE with the existing reason codes and blank Map metadata. The initial file selection contained a duplicate JSON for `test`; the correct JSON for `a` was identified before comparison. The verification script initially assumed missing snapshot rows were omitted, then incorrectly assumed a shared missing reason; both verifier assumptions were corrected to the existing explicit missing-state contract. No product output was changed.

During the save/PR review, all eight code/configuration/test SHA-256 fingerprints below matched the successful saved verification record. Successful browser checks, typecheck, lint and build were therefore not rerun. The dedicated DB identity, `a` end/draft state and unchanged API/Web listener processes were checked again read-only. The rehearsal environment remains running; no migration or server switch was performed during this review.

## Reproducing the targeted automatic check
Use the repository's canonical isolated mock-DB procedure and verify its manifest/identity before migration or synthetic fixture writes. Start a separate product API using that disposable DB and the existing mock-only researcher authentication. Do not use the retained rehearsal DB for this test. Supply DATABASE_URL, API_BASE_URL, RESEARCHER_API_TOKEN, API_PROXY_TARGET (the same test API), UUID_LAN_HOST (an assigned private LAN address) and BROWSER_CHANNEL in the test process environment, then run:

```sh
npm run test:uuid-lan-browser --prefix frontend
```

The script requires an available loopback port 5185, an installed Playwright browser, and access to the selected private LAN interface. BROWSER_CHANNEL defaults to msedge for the recorded Windows run; use chromium when that runtime is installed. It creates synthetic materials/runs/Sessions in the disposable DB. Fixture import/publication uses API calls; researcher creation/retry checks use browser actions. It is explicitly registered as a targeted command, not added to the general CI suite because a selected non-loopback interface and separate API configuration are required. Stop only those test processes and remove only the identity-verified disposable test DB afterwards. Do not print authentication values or reuse shared environment files.

## Scope limits
This change provides UUID generation compatibility for LAN HTTP; it does not encrypt or protect HTTP traffic. The successful automatic LAN-origin check ran on the researcher PC; the physical participant-PC checks above are user reports corroborated by stored mock state. Participant-PC browser/version details, simultaneous editing across physical devices, 20-device load, real research data, existing research-DB migration/recovery, transport protection and production operation remain unverified. R05's recorded regression is automatic mock verification, not a physical two-PC R05 rehearsal. Temporary UUID-test processes and DB were removed after identity checks; the retained rehearsal DB/API/Web are separate.

## Checked source SHA-256
- frontend/src/client-identity.ts: 5911ff836d9581a224fbeee60563f0dbe794fc456c8c071564f5d119bc44b8f3
- frontend/src/MaterialsPage.tsx: c7785ddce7f8a08df64359cc404b7e6d1ea9188d91a853004163023b2c6c1ed0
- frontend/src/ExperimentRunsPage.tsx: 0c03fd065487dc05e1dbd5ec262892b0bf58d521fa798cafe49ed50b860fcf49
- frontend/src/ExperimentParticipantsPage.tsx: 26cb7512c798ca5205a58ebbd0e2f04a5917225ae07368e8d76d263c7d7350d1
- frontend/src/R05Page.tsx: fd78786ada5a0568777462168775ab4ba3e31d79d44261af7cb7c8062924ec89
- frontend/src/MapPage.tsx: dfeb6cf03f74e0f52b77b099d86a8bc39eda721b0d6ee504b73cc81fdb6629b1
- frontend/package.json: f025b488349e031b4878c3a60e85ed83639a0504031cb5b9f03dd753a395b055
- frontend/scripts/verify-uuid-lan-browser.ts: ee2eed63ea7d5eb7b647421e2406ccf6c5f9515b1a74ce0acab705d1d9d27224
