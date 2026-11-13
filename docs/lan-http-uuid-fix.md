# LAN HTTP UUID generation fix

## Contract and scope
Researcher material, run and participant writes and R05 execution/operation/deletion IDs now reuse newClientId in client-identity.ts. It prefers native crypto.randomUUID and otherwise uses the existing crypto.getRandomValues UUID v4 bit layout. Without a safe source it throws SecureRandomUnavailableError; the researcher write handlers display its Japanese message and send no mutation. Retry keys stay in their existing refs/maps until the existing success rules clear them. R05 initializes proof/start keys inside its guarded start handler and retains them across uncertain responses. The unused weak temporary-ID fallback in MapPage was removed; newClientId returns a UUID or throws. Authentication/secret generators, backend UUIDs, DB schema and operation/event contracts were not changed. No dependencies or browser security exceptions were added.

## 模擬LANリハーサル当日の短い手順

この手順は合成データだけを使う閉じた模擬環境向け。今回の記録対象は main merge `d6d85a5f58d2bb74648e94ff3c8a287d6304a90f`、Web source revision `uuid-795df3889fbbd2cd`（source commit `0e02905224047a88beae39b0ce4ce117ebd455cc`、merge commitと同じtree `8e1d0a7f5f54307141fe37f61c0382de3c4b005a`）。別日に行う場合は、起動中のWeb/APIの識別情報を当日の引継ぎ記録と照合し、この版と異なる場合は実際に使ったcommitを記録する。

1. **環境を照合する。** 当日のローカル引継ぎ記録が指定するmanifestとコンテナー情報で、専用DB名・コンテナーID・用途ラベル・識別値が一致することを確認する。識別値は照合だけに使い、公開記録へ転記しない。名前だけで模擬DBと判断しない。不一致、稼働中プロセス不明、実DBの可能性があれば停止し、resetや既存DBへの接続をしない。DB/APIはloopback限定、Webだけを同一LAN向けにする。参加者PC自身から引継ぎ記録のWeb URLを開いてログイン画面を確認する。接続しない場合は参加者PCで `Test-NetConnection <研究者PCのLANアドレス> -Port <Webポート>` を実行する。HTTPは通信を暗号化しないため模擬データ専用とし、ファイアウォールやブラウザー保護を無効にしない。
2. **研究者PCで準備する。** 研究者コードは研究者PCだけで扱う。模擬用Kitを選び、動画参照・各活動の説明・SB初期概念・統合制限時間は研究者が決めて入力する（固定の推奨値や教材内容を補わない）。完成登録後、その完成教材版を選んで実施を作成する。予定人数は記録値で参加者登録の上限ではない。仮名ラベルA・Bの参加Sessionを登録し、参加者コードは参加者PCでのみ入力する。コードはチャット、ログ、引継ぎ記録へ書かない。紛失時は研究者画面から再発行し、旧コードを使わない。登録後に研究者が「実施開始（模擬検証専用）」を明示操作する。
3. **参加者PCで活動する。** 参加者本人のコードでログインし、授業の動画視聴確認（自己申告）を行う。SBを編集し、保存完了を画面で確認してから再読込し、復元を確認した後に提出する。KBを組み立てて一時確認し、最新の確認が一致する状態で最終提出する。最終提出時にもサーバーが最新Mapを判定する。統合Mapは、実施に固定された時間を研究者画面で確認し、続けて操作できるときに開始する。編集・Merge/解除後に手動提出するか、期限時自動提出となったかを保存結果で区別し、受理後に「次へ」で本人の活動を完了する。新protocolにアンケートはない。
4. **未提出者を残して終了する。** 未提出にする参加者は、下書き保存の完了を確認して提出せずに止める。研究者は実施詳細でA/Bの状態を確認し、「実施を終了」を押す前に確認文を読む。終了後は参加者の操作が止まり、未提出Mapは未提出のまま、参加者には終了案内だけが表示される。終了は提出・本人完了・離脱・撤回を作らない。端末内の未送信変更が後から回収される保証はない。
5. **結果を出力・照合する。** 研究者画面の対象実施から「実施の研究用JSON」と「実施のMap状態CSV」をダウンロードする。CSVは18列で、既存16列の末尾に `mapStatus` と `mapSubmittedAt` がある。既存 `status` は行の取得状態、`mapStatus` は取得時点のMap本体の状態。提出時刻は保存値のみで、未提出・Map未作成では空欄。開始/提出snapshotの `point` と `recordedAt` はsnapshotの時点を表し、追加2列の現在Map情報とは別である。出力契約と欠測理由は[新protocolの研究者分析・Map状態CSV仕様](experiment-learner-flow.md)を参照する。外部の列数固定処理は未確認。
6. **止まった場合は状態を先に確認する。** ローカルの制限された記録先に、アプリcommit/Web revision、模擬実施ラベル、役割PC、参加者仮名（A/B等）、時刻、活動と操作段階、画面の非機密な文言、保存確認の有無、研究者画面の状態、出力ファイル名を記す。コード、トークン、Map本文は記録しない。保存応答が不明なら再操作や再読込の前に研究者画面で状態を確認する。終了済み実施は再開できない。続ける必要があれば新しい模擬実施を作り、教材を変える場合は新しい下書き版を完成登録する。既存DBをreset・seedし直さない。

過去記録では、ユーザーが実機2台で行った操作報告と、専用DBの読み取り照合、JSON/CSVのローカル照合、自動テストを別々に記録している。実機2台の報告・合成DBでの状態確認・18列CSVの照合は、10〜20台同時利用、HTTP通信の保護、実研究DBへの適用/復旧、本番運用の確認ではない。pause/resume の `UNKNOWN` は不確かな観測であり、確定した中断や活動時間として扱わない。

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

