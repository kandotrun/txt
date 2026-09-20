## 1. 目的・位置付け・優先順位

公開URL `https://txt.2-38.com/` を開くと、自分専用の1枚のテキストを読み書きできるアプリを作る。タイトル、文書一覧、フォルダー、文字装飾、変更履歴を持たず、画像・動画・音声だけを本文中に挿入できる。本文と添付は自動保存し、同じ利用者のWeb・iOS・macOS間で同期する。

最初にWebを公開し、その後SwiftによるネイティブiOS・macOSアプリを、参加済みの個人Apple Developer Programアカウントで公開する。ネイティブ版をWebViewで包んだWebアプリにしない。

仕様版: 1.1。更新日: 2026-09-20。本書1ファイルを実装基準とする。リポジトリの従来の統合仕様、先行する設計改善案、日本語IMEを必須とする追加要件を統合した。Cloudflare Access、特定メールドメイン制限、Worker側の本文復号、R2 SSE-Cを主たる暗号化とする旧案は採用しない。

本書の「必須」「禁止」「受け入れ条件」は実装上の契約である。数値、UI配置、暗号コンテナー、状態遷移は本アプリの設計判断で、引用資料が一律に推奨する値ではない。公式APIの根拠は末尾に記載する。仕様の完成と、アプリの実装・実機試験・セキュリティ監査の完了は区別する。

優先順位は、入力とデータを失わないこと、認証・暗号化の境界を守ること、画面と操作を単純にすること、配信サイズの順とする。依存ゼロやバンドル容量目標のためにIME、Undo、同期の正しさを犠牲にしない。

特に、日本語IMEで日常的に入力することを前提とする。Web/Swift間のPRF相互運用、IMEと非同期処理の共存、E2EE動画のシーク再生を先行検証し、合格前に対応済みと宣伝しない。

## 2. 採用する全体構成

| 領域 | 採用仕様 |
| --- | --- |
| 公開ホスト・WebAuthn RP ID | `txt.2-38.com` |
| Web/APIのOrigin | `https://txt.2-38.com` |
| サーバー | Cloudflare Workers + Hono |
| データ | D1に認証情報・最新暗号文・同期/転送状態、非公開R2に暗号化添付 |
| ログイン | メール・電話・通常パスワードを要求しない、発見可能なパスキー |
| パスキー保存先 | 1Password、Appleのパスワード等。OS/ブラウザーの標準選択UIに任せる |
| 暗号化 | PRF由来の鍵で独立したマスター鍵を包む、クライアント側E2EE |
| 復旧 | 独立した復旧キー、追加登録した対応パスキー |
| Web | HTML/CSS/JavaScript + 必要最小限のProseMirror |
| iOS | SwiftUI + UIKit/TextKitの編集面 + AVFoundation |
| macOS | SwiftUI + AppKit/TextKitの編集面 + AVFoundation |
| ネイティブ共通部分 | Swift Packageによるモデル・暗号・API・同期処理 |
| 保存・同期 | 条件付きHTTP更新、短周期ポーリング、同一ブラウザー内通知 |
| 履歴 | サーバーの旧版・履歴UIは作らない。現在の編集セッション内Undoは提供する |

「個人としてリリース」は開発者の名義を意味し、利用者を開発者本人や特定メールドメインに限定しない。一般の利用者もパスキーで作成でき、各アカウントが非共有の1枚を持つ。料金、販売地域、正式ストア名は公開準備で決定する。

Cloudflare Access、`@2-38.com`制限、Access JWT検証はアプリの認証に使用しない。1PasswordへのOAuthログインやApple Accountのソーシャルログインを追加するわけでもない。

React、Vue、Next.js、TipTapの拡張一式、ORM、独自CRDT、Yjs、Durable Objects、KV、Queues、動画変換基盤を初版の必須構成に追加しない。E2EEメディア配信のためのService Worker、重い暗号処理を入力から分離するWeb Workerは許可する。

## 3. 通常の操作と表示

認証・解除状態が有効なら、タイトル入力や文書選択なしで編集面を開く。認証済みでも復号鍵がない場合は「パスキーで開く」を表示する。空文書と未取得・未復号の文書を区別し、読み込み失敗を空文書として保存しない。

文字はPlaintextとして扱う。`# 見出し`、`**太字**`、URL、HTMLタグをそのまま表示し、自動リンク化しない。太字、斜体、見出し、リスト、チェックボックス、色、サイズの編集機能はない。OSの文字拡大・アクセシビリティ設定は尊重する。

保存モデルの改行はLFとする。空行、末尾改行、連続空白、タブ、絵文字を保持し、trim、Unicode正規化、全角半角変換をしない。本文入力中のIMEの変換候補、未確定下線、選択、キャレットをアプリ独自の表示へ置き換えない。

文字の外部貼り付けは`text/plain`を取り込む。画像・動画・音声はファイル選択、ドラッグ＆ドロップ、ブラウザー/OSがファイルを提供する貼り付けに対応する。ファイルを提供しない貼り付け経路は保証せず、ファイル選択を常に用意する。

メディアは本文中の独立した要素で、前後に文字を書ける。回り込み、手動リサイズ、装飾、専用キャプション欄はない。画像は本文幅以内、動画・音声は標準の再生操作を使い、自動再生しない。Web動画は`playsinline`とする。

IMEが処理していないとき、メディアに隣接する最初のBackspace/Deleteは選択、次の操作で削除する。範囲選択に含まれるメディアは範囲削除の対象とする。この処理をIMEの文字削除・候補操作に割り込ませない。

添付中も本文を編集・保存できる。挿入位置と順序は選択時に確保し、完了順に並べ替えない。取消済み添付を遅い完了通知で復活させない。文字入力で既存プレイヤーを作り直さず、再生位置を保持する。

## 4. Web・iOS・macOSのUI設計

### 4.1 共通

常設するアプリ操作は「添付」「その他」の2つだけ。本文タイトル、アプリロゴ、大きなヘッダー、サイドバー、タブバー、保存ボタン、装飾バーを置かない。同期成功は短時間表示して消し、失敗・未同期・競合は解決するまで表示する。色だけで状態を伝えない。

認証、復旧キー保存、競合解決、アカウント管理は必要時だけ別画面・シートにする。セキュリティ説明カードを編集面に常設しない。以下は配置仕様であり、完成画像・実機スクリーンショットではない。

### 4.2 Web

```text
ブラウザーの通常のアドレスバー
┌─────────────────────────────────────────┐
│                                         │
│  ここから普通に書く。                   │
│  空白と改行をそのまま残す。             │
│                                         │
│  ［画像］                               │
│                                         │
│  画像の後にも書く。                     │
│                                         │
│  [添付]                    保存中  […]  │
└─────────────────────────────────────────┘
```

中央のカードや紙の影を作らず、画面幅を利用する。左右余白はモバイル16〜20 CSS px、デスクトップ24〜48 CSS pxを目安とする。本文はシステム等幅系フォントと日本語フォールバック、基準16 CSS px、行高1.6。ズームを禁止せず、ライト/ダークへ追従する。

下端操作はセーフエリア・ソフトウェアキーボードに追従し、入力行を隠さない末尾余白を確保する。タップ領域は44×44 CSS px以上を目標とし、アイコンにアクセシブル名とデスクトップ用ツールチップを付ける。IME候補位置を崩す編集面へのtransformや、キャレット周囲の不必要なクリッピングを避ける。

Webには偽物のAppleウィンドウ枠やステータスバーを描かない。小さな自作SVG等を用い、SF Symbolsの素材を無条件にWebへ転用しない。`<title>`は固定の`txt`とし、本文を反映しない。

### 4.3 iOS

```text
┌─────────────────────────┐
│      OSステータスバー   │
│              [添付] […] │ ← 標準toolbar、タイトルなし
│                         │
│  ここから書く。         │
│                         │
│  ［画像・標準プレイヤー］│
│                         │
│  続きの文章。           │
│                         │
│  必要時だけ同期状態     │
│─────────────────────────│
│  OSキーボード・変換候補 │
└─────────────────────────┘
```

SwiftUIの標準toolbar/sheet/menuを使い、本文は`UIViewRepresentable`経由の`UITextView`とTextKitを使う。メディアは`NSTextAttachment`と対応View Provider等で実装し、プレイヤーはmediaIdで管理する。`TextEditor`のみで全文要件を満たせるとは仮定しない。[S7][S29]

右上の`paperclip`と`ellipsis`から操作する。起動時にキーボードを強制表示せず、本文タップで入力を開始する。本文はDynamic Typeのbody相当・等幅デザイン、日本語はシステムフォールバック。意味的な色を使い、文字サイズを固定しない。

写真はPhotosPicker、ファイルはfileImporter等の標準選択を使う。初版に撮影・録音機能はないため、不要なカメラ・マイク・全写真アクセスを要求しない。OSの音声入力は通常の文字入力として扱い、アプリ独自の録音機能と混同しない。

### 4.4 macOS

```text
メニューバー: txt / ファイル / 編集 / ウインドウ / ヘルプ
┌─────────────────────────────────────────┐
│ OSウィンドウボタン           [添付] […]│
│                                         │
│  ここから普通に書く。                   │
│                                         │
│  ［本文内のメディア］                   │
│                                         │
│  続きの文章。                           │
└─────────────────────────────────────────┘
```

SwiftUIのWindowと`NSViewRepresentable`経由の`NSTextView`/TextKitを使う。標準ウィンドウボタン、統合toolbar、メニューバー、スクロール、コンテキストメニューを利用し、iPhone風UIやWebView主体にしない。

初期サイズ900×680 pt、最小400×320 ptを目安とする。本文タイトルは表示せず、ウィンドウのアクセシビリティ名は「テキスト」。本文をタイトルやDockへ転記しない。設定は標準Settingsシーンと`⌘,`で開く。

コピー、貼り付け、選択、Undo/Redoは標準操作に合わせる。`⌘S`は安全な確定済み内容の即時保存要求とし、名前や保存場所を尋ねない。IME中は要求を保留し、強制確定しない。「新規文書」「別名で保存」「文書を開く」は提供しない。複数ウィンドウも同じ1枚を扱う。

### 4.5 Appleデザインシステムとアクセシビリティ

標準toolbar、sheet、menu、picker、SF Symbols、Dynamic Type、意味的な色を優先する。Liquid Glassは対応OSの標準部品に任せ、本文全面をガラス化したり独自ぼかしで模倣したりしない。古い対応OSではそのOSの標準外観を使う。[S8][S9]

VoiceOver、キーボード、文字拡大、コントラスト、透明度低減、視差効果低減に対応する。ネイティブ操作領域は44 ptを基本目標とし、翻訳や文字拡大でボタンが切れないようにする。同期成功を毎回読み上げず、エラー通知もIME候補の操作やフォーカスを奪わない。

### 4.6 状態別UI

| 状態 | 文言と操作 |
| --- | --- |
| 未登録/未認証 | 「メールアドレスなしで、1枚のテキストを。」／「パスキーで開く」「はじめて使う」「復旧キーで開く」 |
| 新規作成 | パスキー作成 → PRF試験 → 復旧キー保存確認 → 空の編集面 |
| 認証済み・鍵なし | 「パスキーで開く」。空文書に見せない |
| PRF未対応 | 「この環境では、このパスキーで暗号化された内容を開けません。」／別の対応パスキー・復旧キー |
| 保存中 | 「保存中」。IME未確定分や転送中添付を保存済み扱いしない |
| ローカル退避済み | 「端末に保存済み・未同期」 |
| 同期成功 | 「同期済み」を短時間表示して消す |
| 添付中 | 挿入位置に進捗・取消。失敗時はその添付だけ再試行可能 |
| 認証期限切れ | 「再ログインが必要です」。退避した内容を保持 |
| 復号失敗 | 「内容を開けません。データは変更していません。」 |
| 競合 | 両方を端末内で確認し「編集して保存」「サーバーの内容を使う」 |
| 未確定入力の復旧 | 「未確定の入力が残っています」。確認して採用・破棄 |
| 再生不可 | 理由、対応環境の案内、可能な場合の復号後ダウンロード |
| 容量超過 | 超過を説明し、現在の入力を保持。自動切り詰めしない |

「1Passwordでログイン」「Appleでログイン」を別々に並べない。「その他」にはセキュリティ設定、ロック、ログアウト、プライバシー、サポートを置く。セキュリティ設定で追加パスキー、失効、復旧キー更新、セッション終了、アカウント削除を扱う。

## 5. パスキー認証とセッション

### 5.1 利用者の識別

accountIdはUUID、userHandleは32バイト乱数。メール、電話、氏名の列・入力欄を作らない。WebAuthnの`user.name`と`displayName`には`txt-8CF3A2B1`等のランダム表示ラベルを使う。所有者は署名検証済みcredentialとサーバーの対応表で決め、ラベルやクライアント指定accountIdで決めない。[S1]

ランダムID、公開鍵、credential ID、利用時刻、容量、セッション、通信情報は存在する。「完全匿名」「情報を一切収集しない」とは説明しない。

### 5.2 登録・認証

WebはWebAuthn、ネイティブはAuthenticationServices。サーバーは`@simplewebauthn/server`を第一候補とし、Workersでの実行互換性を試験してlockfileで固定する。署名・CBOR・FIDO検証を独自実装しない。[S2]

`residentKey: required`、`userVerification: required`、`attestation: none`を基本とする。保存先を狭める`authenticatorAttachment: platform`固定は行わない。ログインは原則空のallowCredentialsによる発見可能な資格情報を使う。

challengeは32バイト以上の乱数、期限5分、1回限り。登録・ログイン・再認証・追加・復旧の用途、client_kind、必要なaccountIdと結び付ける。消費は原子的に行い、署名検証済み応答の再利用で別セッションや別操作を作れないようにする。

challenge、type、RP ID hash、許可Origin、署名、UP/UV、userHandleとcredentialの所有者対応を検証する。同期パスキーのcounter=0を一律に拒否せず、backupフラグ等をライブラリーの検証規則に沿って扱う。[S1]

WebのOriginは`https://txt.2-38.com`のみ。ネイティブのclientDataJSONも実機の正当な経路をもとに同じRPへ厳密に結び付ける。Origin検証の無効化・ワイルドカードで対処しない。開発/検証環境は別RP・別データとする。

### 5.3 初回の原子的な確定

登録中はpendingで、文書APIを許可しない。パスキー作成・署名確認、PRF実出力取得、VaultKeyのラップと試験復号、復旧キー保存確認の順に進める。登録時にPRF出力がなければ追加assertionを行う。

bootstrap APIで暗号化空文書、資格情報用の鍵ラップ、復旧情報、bootstrapIdを送る。初期revisionは0、初期mutationIdはbootstrapIdとし、D1で保存とactive化を一括確定する。同じbootstrapIdで異なる初期鍵・ペイロードを上書きしない。試験復号は端末内で行う。

PRF非対応しか使えない環境では新規登録を完了させない。別の保存先・環境へ案内し、サーバーが鍵を保管する方式へ落とさない。放置pendingは24時間を目安に清掃する。

### 5.4 認証と解除の分離

パスキーはログインと解除時に使い、保存ごとに生体認証を求めない。通常APIは256bit以上の不透明セッショントークンで認可し、D1にはSHA-256ハッシュだけを保存する。

Webは`__Host-txt_session`のSecure、HttpOnly、SameSite=Strict、Path=/ Cookieを使い、Domain属性を付けない。ネイティブはKeychainのBearerトークンをURLSessionで送る。WebへBearerを返したりlocalStorageへ保存したりしない。

初期期限は絶対45日・無操作30日。CookieのMax-Ageも同じ絶対期限に合わせる。失効とaccountのauth_epochをサーバーで確認する。機密操作は5分以内のstep-up再認証を要求する。セッション期限と端末内の復号鍵保持期限は別である。

Cookie認証の書き込みは厳密なOriginと`X-Txt-Request: 1`を検証し、CORSで他Originを許可しない。Originのないネイティブ要求は検証済みnativeセッションのBearer経路で扱い、任意の`X-Client`でCSRFを迂回させない。CookieとBearerの混在・所有者不一致は拒否する。認証前ceremonyにもクライアント束縛とレート制限を適用する。

## 6. パスキーを使うE2EE

### 6.1 鍵の構成

署名値、公開鍵、credential IDを暗号鍵にしない。PRFの秘密出力からKEKを導出し、独立した32バイト乱数のVaultKeyを包む。[S1][S3][S4]

```text
パスキーAのPRF → HKDF → KEK-A → VaultKeyのラップA
パスキーBのPRF → HKDF → KEK-B → 同じVaultKeyのラップB
復旧キー       → HKDF → KEK-R → 同じVaultKeyのラップR
                                   ↓ 端末内だけで解除
                                VaultKey
                                 ├ 本文の用途別鍵
                                 ├ ローカル退避の用途別鍵
                                 └ 暗号化本文内の各fileKey
```

パスキー追加で動画全体を再暗号化しない。入口の失効と、既にコピーされたVaultKey/平文の失効は別である。侵害後に完全な鍵更新が必要ならデータ再暗号化も必要になり、ラップ交換だけで過去の漏洩を取り消せない。

### 6.2 PRFと鍵ラップ

```text
prfInputV1 = SHA256(UTF8("txt.2-38.com/prf-input/v1"))
prfOutput = OS/ブラウザーのPRF(prfInputV1)
KEK = HKDF-SHA256(prfOutput, wrapSalt32,
                 Encode("txt/v1/passkey-wrap", accountId, credentialId), 32)
wrapAAD = Encode("txt/v1/vault-key", formatVersion, keyVersion,
                 accountId, credentialId)
wrappedVaultKey = AES-256-GCM(KEK, randomNonce12, VaultKey, wrapAAD)
```

公開入力は資格情報の選択前にも分かる固定値とし、デプロイごとに変えない。WebAuthn内部のPRF入力変換をアプリで重ねて行わない。同じ入力バイトでWeb/Swift双方から同じ資格情報を使った相互復号を試験する。

発見可能ログインでは`prf.eval`を使う。空のallowCredentialsに`evalByCredential`を組み合わせない。資格情報別入力を使う将来拡張は別途契約化する。PRFのenabled/isSupportedだけで成功とせず、実出力・ラップ・再解除を確認する。[S1][S3][S5]

PRF出力、KEK、VaultKeyを送信・記録しない。`credential.toJSON()`、`getClientExtensionResults()`、ライブラリーの応答を丸ごとPOSTせず、署名検証に必要なフィールドだけのDTOを作る。PRF resultsを除外する。W3C仕様もtoJSONにPRF resultsが含まれ得ることを明示するため、ネットワーク試験を必須とする。Swiftの送信DTOにもPRF由来の鍵を含めない。[S1]

### 6.3 Web/Swift共通の暗号契約

Web CryptoとCryptoKitのAES-256-GCM、HKDF-SHA256、SHA-256を使う。nonceは12バイト、認証タグは16バイト、バイナリーのJSON表現はパディングなしbase64url。暗号文フィールドはciphertextとtagの連結で、nonceは別フィールドにする。CryptoKitのcombined表現を無加工でWebへ渡さない。[S10][S11]

`Encode`は各フィールドのバイト列にuint32 big-endianの長さを前置して連結する。文字列はUTF-8、UUIDは16バイト、credential IDは元のバイト列、整数はuint64 big-endian。JSONの辞書順、ロケール依存文字列、Swiftのハッシュ順を使わない。

```text
snapshotKey = HKDF-SHA256(VaultKey, mutationIdの16バイト,
                         Encode("txt/v1/document-key", accountId,
                                documentId, keyVersion), 32)
documentAAD = Encode("txt/v1/document", formatVersion, keyVersion,
                     accountId, documentId, mutationId, encryptedRevision)
```

本文は新しいmutationId、nonceで暗号化する。encryptedRevisionはCAS成功後のrevision、bootstrapのみ0。再送は同じmutationId・nonce・暗号文・参照集合をそのまま使う。内容または保存先revisionを変えて暗号化し直す場合は新しいmutationIdとnonceにする。

syncEpochはサーバー復旧時に変更可能な同期識別子で、既存暗号文のAADを後から書き換える用途には使わない。復元後も暗号化時のencryptedRevisionを保存し、初回取得で再照合する。

端末内ドラフトは保存ごとの新しいdraftIdとnonce、`txt/v1/draft-key`/`txt/v1/draft`の別用途名で鍵導出・AADを分離する。AADにはaccountId、documentId、tab/sceneIdを含める。

このコンテナーはアプリ固有の設計で、監査済み標準形式ではない。実装で各バイトを固定し、Web/Swift共通テストベクトル、改変試験、独立したセキュリティレビューを公開条件とする。復号・未知形式・AAD不一致の失敗で空文書へ置き換えない。

### 6.4 端末内の鍵とロック

WebのVaultKeyは解除中メモリーだけに置く。再読み込み後はパスキーまたは復旧キーで再解除する。ただし端末保持（既定30日）が有効な場合は、端末固有の非抽出CryptoKey（`extractable: false`、IndexedDBへ保存）で包んだVaultKeyを端末内に保存し、保持期限内はパスキーなしで再解除してよい。保持期限は解除のたびに延長し、明示ロック・ログアウト・保持解除操作では包んだ鍵と端末鍵を削除する。IndexedDBには暗号化キャッシュ、端末保持の包み鍵、最新未同期ドラフトだけを置き、平文や鍵をlocalStorage/sessionStorageへ置かない。

ネイティブはVaultKeyを端末限定のKeychain項目として保存し、`WhenUnlockedThisDeviceOnly`とuserPresenceを基本候補とする。生体認証・パスコード・利用可能性を実機確認する。一般のAES対称鍵をそのままSecure Enclave内で使用できるとは説明しない。トークンは鍵と別項目にする。[S12]

非表示/バックグラウンド移行から5分で再解除を要求する。タイマー停止を前提に復帰時の時刻で判定する。明示ロック・OSから通知された保護データ利用不可では即座に保護する。WebはOSロックを常に検出できると仮定しない。端末保持が有効な場合、バックグラウンド復帰の再解除は端末保持の包み鍵で行ってよく、パスキーの再要求を必須としない。その場合も平文応答・Object URL・復号バッファーは保持期限と別に再確立する。

ロック時は可能な範囲で暗号化退避し、画面を覆い、再生・進行中の平文応答を止め、Object URLをrevokeし、画面・Web Worker・Service Worker・キューの鍵参照を切る。ネイティブは非アクティブ時のアプリ切替画像も覆う。ログアウトではトークン・保存済み解除鍵も削除する。

IMEのためにロック期限を無期限延長しない。ロックによる入力中断は通常同期と区別し、未確定分を確定済みとして送らない。未同期暗号文は所有者別に隔離して保持し、本人が再認証したときだけ復旧可能にする。退避失敗を隠さない。OS終了直前の入力保存や物理メモリーの完全消去は保証しない。

### 6.5 保護範囲

本文、ファイル名、MIME、復号メディア、PRF出力、VaultKey、fileKey、RecoverySeedをサーバーへ渡さない。R2の標準保存時暗号化は追加層で、Workerが鍵を持つSSE-CをE2EEの代わりにしない。

サーバーにはアカウントID、公開鍵、サイズ、時刻、revision、参照関係、転送状態等が見える。暗号文のサイズ・認可・状態は検証できるが、平文のMIME検査、ウイルス検査、サムネイル作成、動画変換はできない。

Webは配信JavaScriptを信頼する。悪意あるコード配信、XSS、依存侵害、解除済み端末の乗っ取りは別の脅威である。AEADは改変を検出するが、新しい端末に対する古い正当な暗号文の再提示を完全には検出しない。E2EEは削除・サービス停止を防がない。

## 7. パスキー追加・互換性・復旧

追加は既存アカウントの解除とstep-up後に行う。新パスキーの作成、PRF取得、同じVaultKeyのラップ、再認証・試験復号を経て有効化する。新しい入口を試験する前に既存の唯一の入口を削除しない。最後の有効パスキーの通常削除は拒否し、アカウント削除は別操作とする。

同じパスキーの端末間同期と、別の保存先に新しいパスキーを作ることを区別する。別パスキーのPRF出力が同じとは仮定しない。プロバイダー間の移行・エクスポート・別端末経由認証も相互運用試験の対象にする。

認証だけ成功してPRFが使えない場合は解除済みにしない。別の対応パスキーか復旧キーを案内し、サーバーから平文鍵を受け取るフォールバックは作らない。

### 7.1 復旧キー

初回に32バイト乱数RecoverySeedを生成する。短い人間のパスワードに置き換えない。

```text
RecoveryAuth = HKDF-SHA256(RecoverySeed, accountIdの16バイト,
                          UTF8("txt/v1/recovery-auth"), 32)
RecoveryKEK = HKDF-SHA256(RecoverySeed, accountIdの16バイト,
                         UTF8("txt/v1/recovery-wrap"), 32)
recoveryAAD = Encode("txt/v1/recovery-vault", accountId,
                     recoveryVersion, keyVersion)
保存するもの: SHA256(RecoveryAuth)、nonce、RecoveryKEKで包んだVaultKey
保存しないもの: RecoverySeed、RecoveryKEK、VaultKey
```

復旧キーは`TXT1.<accountIdのbase64url>.<RecoverySeedのbase64url>.<checksum>`。checksumはその手前のASCII文字列のSHA-256先頭4バイトをbase64url化し、入力誤り検出にだけ使う。URLやログへ入れない。

初回にコピーまたはファイル保存と保存確認を行う。紛失し得るパスキーマネージャーと同じ保存先だけに依存しないよう説明する。復旧キーを持つ第三者は内容を開けるため、サポートへの送付を促さない。

### 7.2 復旧の確定

TLS上で送信するのは導出済みRecoveryAuthとaccountId等だけで、RecoverySeedや復旧キー全文を送らない。検証後は復旧専用scopeのセッションを発行し、復旧に必要な鍵ラップ・資格情報追加・確定APIだけを許可する。通常文書APIは確定後に利用する。

端末でVaultKeyを開き、新パスキーを登録・試験し、新RecoverySeedの保存確認後に、旧資格情報/セッション失効、auth_epoch更新、復旧情報置換を原子的に確定する。途中で唯一の復旧入口を先に無効にしない。復旧操作IDにより、応答消失後も完了状態を確認できる。

パスキー・利用可能な端末内鍵・復旧キーをすべて失った場合、運営者による本人確認・復号の代行はしない。復旧キー更新は既に漏れたVaultKeyを無効化しない。

## 8. 共通文書モデルと変換規則

WebのProseMirror JSON、HTML、NSAttributedStringアーカイブを通信形式にしない。各クライアントは次の共通JSONへ変換し、全体を暗号化する。

```json
{
  "schemaVersion": 1,
  "blocks": [
    {"id": "TEXT_UUID_1", "type": "text", "text": "最初の文章。\n"},
    {"id": "MEDIA_BLOCK_UUID", "type": "media", "mediaId": "MEDIA_UUID"},
    {"id": "TEXT_UUID_2", "type": "text", "text": "画像の後の文章。"}
  ],
  "media": {
    "MEDIA_UUID": {
      "kind": "image",
      "name": "photo.jpg",
      "mime": "image/jpeg",
      "plainBytes": 123456,
      "cryptoFormat": 1,
      "chunkBytes": 1048576,
      "chunkCount": 1,
      "noncePrefix": "BASE64URL_8_BYTES",
      "fileKey": "BASE64URL_32_BYTES"
    }
  }
}
```

UUID等は説明用記号で、実データは正しい型・長さ・一意性を検証する。許可blockはtext/mediaだけで、未知の型・形式を削除して保存し直さない。media辞書には現在参照中のファイル情報だけを持ち、各mediaブロックの参照先が存在することを検証する。

空文書は空textブロック1個。先頭・末尾・隣接メディアの間には空でも編集可能なtextブロックを確保する。通常の文字編集でIDを再生成しない。メディア挿入でtextを分割するときは左側のIDを維持し右側を新規発行、統合するときは左側IDを維持する。メディア挿入位置はカーソル位置のオフセットで決め、そのtextブロックを分割して間に置く。ブロック境界に丸めない。

保存データに参照されていないmedia辞書エントリが残っていた場合は、それを除去して読み込み（内容の欠落はない）、修復後のモデルを保存し直す。参照先が存在しないmediaブロックなど他の不整合は推測修復せず、従来どおり開けない。

text内の改行はLFという文字で、ブロック境界やメディア表示に必要な改段落を本文のLFへ勝手に変換しない。表示から保存、再表示の往復で末尾改行・空行・空ブロックが増減しないよう共通fixtureで固定する。構造正規化はIME安全点でのみ行う。

コピーのPlaintext表現ではメディアを`[画像: ファイル名]`等に置換する。fileKey、内部キー、暗号文をクリップボードに出さない。通常コピーでメディアを別アカウントへ複製する機能はない。

サーバーの認可・清掃用に、暗号文と別にソート済み・重複なしの`referencedMediaIds`を送る。復号した本文の集合と一致を確認し、不一致を自動修復・自動再保存しない。参照関係は秘匿対象外である。

### 8.1 文字位置

保存本文はUTF-8、編集アダプターのテキスト位置は`blockId + UTF-16 offset + affinity`を基本とする。ProseMirrorの文書位置をそのまま保存せず、Swiftの`String.count`をNSRangeへ直接使用しない。UTF-16とString.Indexを明示変換する。

キャレット・削除範囲をサロゲートペア、結合文字、異体字セレクター、ZWJ絵文字の途中へ独自に設定しない。通常の移動・削除は編集エンジン/OSへ委ねる。本文に入力されたU+FFFCと、attachment属性を持つ内部メディア位置を区別する。

## 9. エディター実装と日本語IME（必須）

### 9.1 状態と責務

各編集面は`idle → composing → settling → idle`の入力状態を持つ。composingは未確定文字列が存在する状態、settlingは確定/取消後の最終入力と編集エンジンの反映を待つ状態である。これとは別に、ロック、未保存、転送中、競合を管理する。

編集中のエンジン状態と、同期へ渡せる確定済みスナップショットを分離する。IME中もProseMirrorのトランザクションとTextKitの入力処理を継続させる。止めるのは、未確定分の同期、新しい全文の外部適用、破壊的な正規化、アプリ独自のメディア挿入等であり、エディターの入力処理そのものではない。

composition開始時に直前の確定済み状態を保持し、通常の新規保存スケジュールを保留する。開始前に送信済みの安全なスナップショットの完了は受け取れるが、その応答で編集中の本文や未保存状態を置き換えない。

### 9.2 Web: ProseMirrorの使い方

`prosemirror-model/state/view`と必要なkeymap、commands、セッション内historyを採用する。marksは空、textBlockと不可分mediaBlockを中心とする制限schemaを使う。textBlockは`text*`を保持し、空白・LFをそのまま扱う。Enter/Shift+Enterの通常入力はLFに対応させ、見出しやリストへ変換しない。[S24][S26]

EditorViewは編集面の寿命中維持する。ローカルトランザクションは通常どおりapply/updateStateするが、入力ごとに新しいEditorState/EditorViewを作り直したり、外部JSONから全文を再インポートしたりしない。`innerHTML`、`replaceChildren`、手書きDOM正規化でエンジン管理DOMを変更しない。[S26]

アプリの入力監視では`compositionstart/update/end`、`InputEvent.isComposing`、`KeyboardEvent.isComposing`、`view.composing`を併用する。単一フラグやキーコードだけで判定しない。keyCode 229の補助利用は実測した互換経路だけに限定し、非推奨APIを主判定にしない。

`beforeinput`には発火しない・取消不能な経路があるため、それだけでPlaintextやIMEの正しさを実現しようとしない。必要なinput/トランザクションの監視を併用する。composition入力のpreventDefaultや、変換途中のDOM巻き戻しはしない。[S25]

ProseMirrorのhandleDOMEvents等では、観測だけならデフォルトの編集処理を止めない。trueを返して処理を引き取るのは、IME外の明確に実装済みの操作に限定する。アプリ独自keymapよりもIMEと標準編集処理を優先する。

### 9.3 Web: 確定・取消・イベント順序

`compositionend`を確定文字列の挿入命令にしない。`event.data`を末尾へ足したり、空のdataだけで取消と決めたりしない。実際の確定結果はエンジンの最新モデルから読む。

compositionend後はsettlingに入り、イベント処理とエンジンのDOM反映が落ち着いた後のタスクで最新世代を再確認する。compositionが再開していないこと、view.composingがfalseであること、処理対象より新しいローカルトランザクションがないことを確認する。追加input/transactionが来たら再評価する。

inputが必ずcompositionendの後に1回だけ来る、keyupが必ず来る、固定100ms待てば確定する、といった前提を置かない。inputだけでなくcomposition終了自体も確定スナップショット評価の契機にする。イベント順序差は実機テストで確認する。[S26][S30][S31]

取消後は実際に残った本文を採用し、不要な空文字挿入や改行をしない。状態を安全に判定できない場合は入力を継続できるまま同期を保留し、最新の暗号化退避と診断を優先する。タイムアウトで強制確定・blurしない。

### 9.4 キー操作と貼り付け

変換中のEnter、Space、Escape、矢印、Backspace/Delete、TabはIMEに任せる。Enterで改行・フォーム送信、Escapeでシート閉じ、Backspaceで添付削除を誤発火させない。編集面を送信用formのEnter動作へ結び付けない。

独自の保存、添付、ショートカットはcomposing/settling中に文書を変更しない。Cmd/Ctrl+Sは保存要求だけを記録し、安全点で実行する。IME中のUndo/RedoもOS/編集エンジンの扱いを優先する。

貼り付け/ドロップのPlaintext化はエンジンの入力経路で行い、HTMLを直接挿入しない。未確定文字があるときのファイル挿入やカスタム置換は安全点まで保留し、位置を追跡する。入力確定を促すためだけにfocus/blurを呼ばない。

Webやネイティブの自動リンク、スマート引用符、スマートダッシュ等、アプリ側で制御可能な自動置換はPlaintext仕様に合わせて無効にする。日本語IME自体の予測・ライブ変換・ユーザー辞書をアプリで無効化しない。OSによる候補確定・音声入力の置換も通常の入力として受け取る。

### 9.5 iOS/macOS: TextKitとSwiftUIの接続

iOSは`markedTextRange != nil`、macOSは`hasMarkedText()`とmarkedRangeを使って未確定状態を観測する。通知の途中だけで確定と判断せず、最終変更後に次のMainActor実行機会で再確認する。marked textの有無を見ずに一定時間後に確定扱いしない。[S27][S28]

UITextView/NSTextViewとCoordinatorの同一性を維持する。`updateUIView`/`updateNSView`で、Binding変更のたびにtext/attributedText/textStorage全体を代入しない。`.id(text)`等で編集ビューを作り直さない。ローカルdelegate変更の再通知を外部変更と区別する。[S29]

Coordinatorは入力世代、適用済み外部世代、composition状態、選択、保留変更を管理する。ローカル編集はモデルへ伝えるが、エコーバックで再適用しない。外部の変更だけを安全点で差分適用し、初回読込や明示的な版採用以外の全置換を避ける。

UIとtextStorage操作はMainActor上で行う。暗号化・通信・大きいJSON処理は不変スナップショットから別処理へ渡す。非同期結果が戻ったら所有者・文書・世代を再確認する。

marked textの間は、アプリから`unmarkText`、resignFirstResponder、全文属性再設定、selectedRange再設定を呼んで確定させない。標準の入力プロトコル、responder chain、UndoManagerを妨げない。添付進捗やテーマ変更で入力ビューを再生成しない。

Dynamic Typeや添付サイズによるレイアウト更新は必要範囲に限定する。未確定範囲の属性変更が必要な場合は安全点へ延期する。候補ウィンドウ、キャレット、選択、スクロール位置を試験し、変換中の入力行を画面外へ飛ばさない。

### 9.6 保存・復旧・上限

composing/settling中の文字列を確定本文としてサーバーへ送らない。確定後はその確定を変更として700msデバウンスを再開し、連続入力の最大待ち時間が既に過ぎているか明示保存要求があれば安全点から速やかに送る。5秒保存目標を守るためにIMEを強制確定しない。

端末内退避は確定済みスナップショットを必須とし、取得できる未確定表示も`provisional=true`の別フィールドとして暗号化退避してよい。未確定分は同期せず、再起動後にIME候補セッションとして復元しない。採用確認後に通常の確定文字列として編集へ取り込む。

容量超過や禁止属性の検証のために未確定範囲を切り詰めない。確定後に保存可能性を検証し、超過時は入力を保持して保存停止を説明する。ローカル容量不足・強制終了で未退避入力を失う可能性は表示とドキュメントで区別する。

### 9.7 添付・遠隔版・Undo

アップロード完了を受信してもcomposing/settling中は編集構造へ挿入しない。完了情報を保留し、安全点で追跡済み位置に反映する。位置が削除・取消済みなら挿入せず、未参照ファイルとして清掃対象にする。[S32]

IME中も既存添付の転送・サーバー取得自体は継続できる。進捗は入力DOM/marked textを変更しないUIで表示する。遠隔版は別に保持し、確定・取消後にローカル変更の有無を再判定する。途中の未確定入力があるのにdirty=falseとして遠隔版へ置き換えない。

セッション内Undoは文字入力、変換確定、メディア挿入/削除を扱う。変換の途中状態をアプリ独自のUndo操作へ分割しない。暗号化・保存応答・進捗・同期表示をUndo履歴へ積まない。メディア挿入は利用者にとって1操作として戻せるようにする。

遠隔版を採用した安全点では、旧版へ戻すUndoを残さないよう当該編集面の履歴をクリアし、新しい基準を作る。手動競合解決の途中ではローカル編集履歴を維持する。Undoで取消済み転送を自動復活させず、必要ならファイル再選択を求める。

### 9.8 性能

全文JSON化・暗号化・全添付走査を毎キー入力の同期処理にしない。保存スナップショット作成はデバウンスし、暗号化と転送をUIから分離する。メディアDOM/プレイヤーの同一性を維持する。

通常文書100KiB・添付10件の基準ケースで入力イベント処理p95 16ms以内を目標とする。1MiB/200添付の上限ケースもプロファイルし、入力中に繰り返す50ms超のメインスレッド処理を修正対象にする。数値は測定目標で、実測済み性能ではない。計測端末・OS・構成を結果に残す。

## 10. 自動保存・同期・競合

### 10.1 クライアントが別々に保持する状態

| 状態 | 意味 |
| --- | --- |
| sessionGeneration / unlockGeneration | アカウント変更・再認証・ロック前後の非同期結果を区別 |
| compositionState | idle/composing/settling |
| editGeneration / committedGeneration | ローカル変更と同期可能な確定済み世代 |
| serverETag / baseSnapshot | 最後に確認した正本とローカル編集の基準 |
| inFlightSave | 送信した世代・mutationId・不変ペイロード |
| pendingAttachments | 挿入ID、追跡位置、順序、取消、転送状態 |
| deferredCompletions | 未適用の添付完了等 |
| remoteCandidate | 取得したが入力面へ未適用の正本 |
| persistedDraftGeneration | 暗号化退避が完了した世代 |

単一dirtyフラグを正しさの根拠にしない。通信、暗号化、ローカル保存、添付、UIの各完了で世代を照合する。

### 10.2 保存と取得

確定済み本文の変更から700ms、連続確定入力でも最後の送信から5秒を目安に保存する。IME中は§9の安全点を優先。同一編集面の保存と暗号化は直列化し、保存応答で入力面を置換しない。後続入力があれば未保存のまま次を送る。

前面操作中は5秒ごと、60秒無操作後は30秒ごとに条件付きGET。非表示時は停止し、前面復帰・フォーカス復帰・オンライン復帰に取得する。前回応答後に次回を予約し、遅い要求を積み上げない。ネイティブのバックグラウンド常時実行を前提にしない。

ETagは`"d-<documentId>-e-<syncEpoch>-r<revision>"`。認証済み所有者から文書を解決し、ID、epoch、revision全てを照合する。`If-Match: *`とLast Write Winsを許可しない。変更なしGETは304とし、本文BLOBや添付情報を無駄に読み出さない。

### 10.3 冪等性とD1の原子性

同じmutationIdで最後の成功時と同じ更新ペイロードなら再更新しない。異なるペイロードは409。それ以降に別更新があれば通常のCAS判定へ進む。last_payload_hashは形式・鍵版・encryptedRevision・nonce・暗号文・ソート済み参照集合の決定的なEncodeから計算し、任意のJSONキー順に依存しない。

本文CAS、参照対象の同一所有者/ready検証、参照集合更新、unreferenced_at更新を同じD1トランザクションで行う。事前SELECTだけで検証を終えない。batchの0行UPDATEは例外とは限らないため、後続SQLをCAS成功したdocumentId・revision・mutationIdでガードする。[S13]

不正参照は422、古いETagは412として区別し、どちらも部分更新しない。GETも本文と参照集合を同一スナップショットで構成する。read replicaは初版に使わない。

### 10.4 遠隔版と競合

自動適用はローカル確定変更なし、IMEなし、送信なし、未完了挿入なし、危険な範囲選択/ドラッグなしの安全点に限定する。単なる取得完了でフォーカスや選択を奪わない。差分適用時は同じblockIdのキャレット位置とスクロールを可能な限り維持し、欠落した位置は安全な境界へ移す。

412では未保存内容を保持して最新暗号文を取得・復号する。正規化済み共通モデルが実際に同じなら同期済みにできる。ランダム化された暗号文の一致だけで平文の同一性を判断しない。

異なれば双方を端末内で表示し、利用者が編集して最新ETagで保存するか、明示確認後にローカルを破棄する。自動全文連結・推測マージ・サーバー側平文マージはしない。解決中の再更新も再度412にする。

### 10.5 タブ・ウィンドウ・所有者の切り替え

BroadcastChannelはdocumentId・syncEpoch・revisionの変更通知だけに使う。鍵・本文は流さず、APIから再取得する。通知欠落でもポーリングで収束する。同一ブラウザー内通知であり端末間通信ではない。[S33]

ネイティブのネットワーク送信は文書単位の共通SyncActorで直列化するが、各sceneの入力・IME・未保存ドラフトは独立管理する。複数ウィンドウの並行編集も遠隔版と同じ競合規則で扱い、一方の入力を上書きしない。

再認証後は条件なし取得で所有者と文書を再確認する。変更時はキュー、鍵、ETag、選択、Object URL、プレイヤーを切り離す。旧sessionGenerationの応答を新画面へ適用しない。文書IDが同じでもsyncEpochが変わったら復旧後の再照合に入り、自動送信を止める。

### 10.6 オフライン・端末退避

未同期ドラフトはaccountId/documentId/tabまたはsceneIdごとに最新1件。本文、基準ETag、mutationIdを含む再送ペイロード、挿入予定位置/状態、必要なローカルメディアマニフェストを暗号化保存する。古い完了通知で新しいドラフトを削除しない。複数タブのドラフトを一括削除しない。

元ファイル全体の永続複製・終了後アップロード再開は保証しない。再選択時の同一性を確認できなければ新しいmediaId/fileKeyでやり直す。暗号化前の元ファイル名等を平文の再開情報として保存しない。

ネイティブは解除できるキャッシュがあればオフライン起動・編集可能。Webは開いているページのオフライン編集を対象にし、通信できない状態からの完全な初回起動は保証しない。

失敗は1/2/4秒から最大30秒のバックオフと乱数幅で再試行する。429のRetry-Afterを尊重。401、復号失敗、未知形式をネットワーク障害として無限再送しない。visibilitychangeでは安全な保存を試みるが、終了イベント/sendBeaconだけに依存しない。

## 11. E2EEメディアの転送・再生・清掃

### 11.1 上限・形式

| 項目 | 初期設計値 |
| --- | --- |
| 本文JSON（暗号化前・メタデータ込み） | UTF-8で1MiB |
| 文書更新リクエスト | 2MiB |
| block数 / メディア数 | 2,000 / 200 |
| 画像 / 音声 / 動画 | 20MiB / 100MiB / 512MiB |
| 暗号化チャンク | 平文1MiB + GCMタグ16バイト |
| 通常multipartパート | 8チャンク = 8,388,736バイト |
| 同時転送 | 2ファイル、ファイル内は原則逐次 |
| アカウント容量 | 暗号文実容量10GiB、転送予約・削除待ちを含む |
| Webの全体Blob復号フォールバック | 原則20MiB以下、メモリーを測定してさらに制限可能 |

種類別上限・MIME/先頭データ検査はクライアントが行う。サーバーには種別を明かさず、全種別共通の最大暗号文容量・パート容量・予約容量を強制する。512MiB平文の最大暗号文容量は536,879,104バイト。メディアをD1に埋め込まない。[S14]

画像JPEG/PNG/WebP/GIF/AVIF/HEIC/HEIF、動画MP4/WebM/MOV、音声MP3/M4A/AAC/WAV/Ogg/WebM/FLACを候補とする。SVG、HTML、PDF、実行ファイル等はUIで拒否する。保存可否と表示/コーデック対応は別で、全環境再生を保証しない。

### 11.2 暗号コンテナー

ファイルごとに新しいfileKey32とnoncePrefix8を生成する。空ファイルは拒否。固定平文チャンク長を1,048,576とし、最終だけ短くてよい。

```text
i = 0 .. chunkCount - 1
nonce(i) = noncePrefix8 || uint32_be(i)
AAD(i) = Encode("txt/v1/media-chunk", cryptoFormat, accountId,
                documentId, mediaId, i, totalPlainBytes, chunkPlainBytes)
C(i) = AES-256-GCM(fileKey, nonce(i), P(i), AAD(i))
R2 object = C(0) || C(1) || ... || C(n-1)
```

chunkPlainBytesは各チャンクの実際の平文長。AADの各整数は§6のuint64表現、nonceのindexだけuint32。chunkCount、総平文容量、noncePrefix、fileKeyは暗号化本文のmanifestで認証される。通常チャンク開始位置は`i × 1,048,592`。

必要な暗号文チャンクを取得し、各タグ検証後にだけ平文を利用する。入替・別ファイルへの差替・切詰めを拒否する。同じfileKey/nonce/mediaIdで変更内容を再暗号化しない。再送は同じ暗号文だけとする。

### 11.3 挿入から完了まで

1. クライアントで容量/形式を確認し、永続的なローカル挿入ID、順序、位置、取消状態を確保する。
2. 開始APIへclientUploadId、暗号文総容量、cryptoFormat、予定パート構成を送る。ファイル名、MIME、鍵は送らない。
3. D1で容量を原子的に予約し、R2 multipartを作る。同じclientUploadIdの再送は同じ状態を返し、異なる条件は409。
4. クライアントで暗号化したパートを送る。Workerは所有者、状態、番号、実容量、暗号文SHA-256を検証する。
5. 全パート確認後にR2完了、D1のready化を行う。本文にはまだ挿入済みとは限らない。
6. IME安全点でローカル挿入を確定し、manifestと参照を含む本文をCAS保存する。この保存が終わって初めて他端末へ表示する。

プレースホルダーは確定本文に含めない。周囲の本文は保存可能。前後の編集に合わせた位置追跡はProseMirrorのtransaction mappingやネイティブアダプターで行う。完了位置を古い数値offsetだけで保持しない。[S32]

### 11.4 パートの冪等性と障害回復

パート番号ごとに暗号文ハッシュと容量を最初の受付で固定する。同じ番号の異なるハッシュは409。受理済みパートを重複要求でR2へ再上書きしない。処理中の同じ番号は並行実行せず、状態照会または再試行へ誘導する。

変更された再送がR2を上書きしてから不一致に気付く実装を避ける。必要ならWorkerで最大1パートだけを有界バッファーに受信し、サイズ/ハッシュを検証後にR2へ送ってよい。これはファイル全体の読み込みではない。並行要求を含むメモリー実測と流量制限を必須とし、全体arrayBuffer/formData化は禁止する。

creating、uploading、completing、ready、deletingの状態を持つ。進行中パートがある間はcompleteへ進まない。処理権/期限を持ち、完了開始後の別パート追加・変更を拒否する。再試行でも同じハッシュ/容量のデータ以外を書かない。[S15]

D1とR2の分散トランザクションを仮定しない。R2完了後のD1失敗は、同じobject keyの実体/容量と記録済みパートを照合してreadyへ進める。期限切れcompletingを永続停止させない。取消・完了・遅いパート応答を試験する。

### 11.5 配信とRange

`GET/HEAD /api/v1/media/:id/cipher`は、認証済み所有者の現在の文書に参照されているready実体だけを暗号文で返す。Content-Typeは`application/octet-stream`。元ファイル名をR2キーやHTTPメタデータへ置かない。

単一bytes Range、suffix Range、HEAD、206、Content-Range、Content-Length、Accept-Ranges、416と全サイズを正しく扱う。複数Rangeは初版では無視して200、If-Range不一致も200とする。クライアントは想定と異なる全体応答を巨大バッファーへ無条件に読み込まない。mediaIdは不変、ETagは不透明な強い識別子とする。

R2公開バケット、r2.dev、公開カスタムドメイン、鍵やBearerを含むURLを作らない。

### 11.6 Webの復号再生

小さな画像は必要時に復号してObject URLにする。画像は遅延読み込み、動画・音声は原則preload=noneとする。

大容量動画・音声はService Workerによる`/_local/media/:id`仮想URLを第一候補とする。標準プレイヤーの平文Rangeを必要な暗号文チャンクへ変換し、端末で認証・復号して必要な部分だけ返す。サーバーはこのパスで平文を配信せず、直接到達時は404/no-storeとする。[S16]

Service WorkerはMessageChannelと実際のclientIdで解除済み編集面へ結び付け、account/document/session/unlock世代を照合する。他タブの解除鍵へフォールバックしない。clientId等の安全な照合ができない要求は拒否する。停止・再起動後は再ハンドシェイクする。

鍵と復号Responseはメモリーのみ。Cache Storage/HTTPキャッシュへ平文を永続化しない。ロックで当該クライアントのキー・バッファーを破棄し、古いストリームを停止する。復号中キャッシュはチャンク数/バイト数で上限を設け、シーク取消で不要取得を止める。

制御開始前に仮想URLで再生しない。Service Workerの更新で未保存エディターを強制reloadしない。旧新プロトコルの不一致は再読み込みの安全な案内へ進め、データを上書きしない。

PWA、通知、バックグラウンド同期は追加しない。不対応環境のBlob復号は上表の小容量だけ。大容量を黙って全体復号したりサーバー復号へ戻したりしない。復号後ダウンロードも実装可能な経路だけ提供する。iPhone Safariの初回制御・Range・中断復帰を公開ゲートとする。

### 11.7 ネイティブの復号再生

AVPlayer/AVPlayerViewController等を使い、AVAssetResourceLoaderDelegateと専用スキームからRangeを受けてURLSession/CryptoKitで取得・復号する構成を第一候補とする。コンテンツ情報、取消、並行要求、シーク、ロック時停止を扱う。[S17]

キャッシュは有界にし、512MiBを一括Data化しない。TextKit再レイアウトでプレイヤーを破棄しない。ネイティブも未検証平文をデコーダーへ渡さない。

### 11.8 参照解除・清掃

本文CAS成功時に参照集合とunreferenced_atを更新する。未参照でreadyになったファイルは完了時刻を起点とする。参照解除後は新規配信を拒否し、未参照が24時間続いたら削除する。この猶予は清掃・競合・現在セッションのUndoのためで、ごみ箱ではない。

清掃はD1トランザクションで再確認してdeletingへ確定し、以後の再参照を拒否する。先に再参照が成功した実体は消さない。R2削除失敗は再試行し、成功後にメタデータと容量予約を除く。

未完了multipartにも24時間を目安とする清掃とR2ライフサイクルを設定する。完成済み全ファイルを一律期限で削除しない。既に物理削除された添付を古いドラフト/Undoから再参照した保存は422とし、元ファイルの再選択を案内する。

## 12. D1データモデルとHTTP契約

### 12.1 データモデル

| テーブル | 必須項目・制約 |
| --- | --- |
| accounts | UUID PK、unique user_handle、表示ラベル、pending/active/deleting、auth_epoch、created_at |
| credentials | unique credential_id、account_id FK、公開鍵、counter、transports、backupフラグ、pending/active/revoked、時刻 |
| key_envelopes | credential_id/account_id、format/key_version、wrap_salt32、nonce12、wrapped_key。所有者対応を外部キー等で固定 |
| recovery | account_idごと現行1件、recovery_version、key_version、auth_hash32、nonce12、wrapped_key |
| challenges | ID、challenge_hash32、purpose、account_id、client_kind、クライアント束縛、期限、consumed_at |
| sessions | token_hash32 unique、account_id、client_kind、auth_epoch、scope、絶対/無操作期限、stepup_at |
| documents | UUID PK、unique account_id、sync_epoch、revision、encrypted_revision、format/key_version、mutation_id、nonce12、ciphertext BLOB、last_payload_hash32、updated_at |
| media | UUID PK、document_id FK、unique object_key、client_upload_id、cipher_bytes、crypto_format、state、upload_id、処理lease、期限、unreferenced_at |
| document_media | document_id/media_idの複合PK。同じdocument_idのmediaへの複合FK |
| upload_parts | media_id/part_numberの複合PK、状態/処理権、固定hash32、容量、ETag |
| operations | bootstrap/復旧/削除のID、所有者、ペイロードハッシュ、期限、進行状態、結果識別子 |

時刻はUTC Unixミリ秒。revision等は非負でJavaScriptの安全整数範囲に制限する。D1の行/BLOB上限を超えないよう本文上限を維持する。パート番号、容量、nonce、ハッシュ、UUID、資格情報の長さをAPIとDB両方で検証する。[S14]

mediaのdocument_id/client_upload_idをuniqueにする。参照集合の同一所有者制約、nonce長、状態enumをマイグレーションで固定する。owner、token_hash、credential_id、清掃状態/期限に索引を置く。容量予約は同時開始でも超過しない条件付き挿入/更新にする。

大量のmediaIdを単純なSQLバインド列へ展開せず、JSON関数等で同一トランザクション内の集合検証を行う。本文履歴テーブルや無期限のmutation履歴は作らない。

### 12.2 API

全て`/api/v1`配下。Webは相対URL、ネイティブは固定HTTPS Originを使う。

| メソッド・パス | 用途 |
| --- | --- |
| POST /auth/register/options・/verify | pending登録・資格情報検証 |
| POST /auth/login/options・/verify | 認証・セッション発行 |
| POST /auth/stepup/options・/verify | 機密操作の再認証 |
| GET /session、DELETE /session | 自分の認証状態・当該セッション終了 |
| POST /bootstrap | 空文書・鍵ラップ・復旧情報の初期確定 |
| GET /keys | 認可された資格情報用の鍵ラップ/公開パラメーター |
| POST /credentials/options・/verify・/activate | 新規パスキーの追加・確認・有効化 |
| GET /credentials、DELETE /credentials/:id | 自分のパスキー管理 |
| POST /recovery/start・/complete、PUT /recovery | 復旧・復旧キー更新 |
| GET /document、PUT /document | 暗号文取得・条件付き更新 |
| POST /media/uploads | 容量予約・multipart開始 |
| GET /media/uploads/:id | 状態・受理済みパート取得 |
| PUT /media/uploads/:id/parts/:partNumber | 暗号文パート転送 |
| POST /media/uploads/:id/complete | 完了/ready確定 |
| DELETE /media/uploads/:id | 未確定転送の取消 |
| GET/HEAD /media/:id/cipher | 参照中暗号文のRange取得 |
| GET /sessions、DELETE /sessions/:id | 自分のセッション管理 |
| GET /operations/:id | 所有者に限定した機密操作の完了状態確認 |
| DELETE /account | step-up・明示確認済み削除開始 |

各APIのscopeはpending/bootstrap、active、recovery、step-upで区別する。credential IDを知るだけで鍵ラップを読めない。他人のIDは404とし、存在を漏らさない。GETで本文や添付を更新せず、サーバーが暗号化空文書を勝手に生成しない。

```http
PUT /api/v1/document
If-Match: "d-DOCUMENT_ID-e-EPOCH-r17"
Content-Type: application/json
X-Txt-Request: 1
```

```json
{
  "mutationId": "UUID",
  "formatVersion": 1,
  "keyVersion": 1,
  "encryptedRevision": 18,
  "nonce": "BASE64URL_12_BYTES",
  "ciphertext": "BASE64URL_CIPHERTEXT_AND_TAG",
  "referencedMediaIds": ["MEDIA_UUID"]
}
```

encryptedRevisionはETagのrevision+1と一致させる。GETの200はaccountId、documentId、syncEpoch、revision、encryptedRevision、formatVersion、keyVersion、mutationId、nonce、ciphertext、referencedMediaIds、updatedAtとETagを返す。所有者はセッションから決め、クライアントの指定で選ばない。

PUT成功は新ETag、revision、mutationId、updatedAtだけを返す。平文本文、ファイル名、鍵は外側へ付けない。Content-Typeとレスポンスschemaを確認し、HTMLや未知データを本文として保存しない。

エラー形は`{"error":{"code":"...","message":"..."}}`。400形式不正、401認証必要、403scope不足、404非存在/他所有者、409冪等性/状態違反、412古いETag、413容量超過、416Range不正、422参照/整合性違反、428条件不足、429制限、500/503障害。鍵・平文・スタックを含めない。

## 13. Webとネイティブのパスキー連携

RP IDを`txt.2-38.com`で共通化する。署名済みアプリに`webcredentials:txt.2-38.com`のAssociated Domains entitlementを設定する。[S6]

```json
{
  "webcredentials": {
    "apps": ["<TEAM_ID>.<IOS_BUNDLE_ID>", "<TEAM_ID>.<MACOS_BUNDLE_ID>"]
  }
}
```

`/.well-known/apple-app-site-association`はHTTPS、未認証取得可能、JSON、リダイレクトなし。Team ID/Bundle IDは実際の署名・登録値を確認する。プレースホルダーのまま公開しない。

iOS 18以降・macOS 15以降を最低対応候補とし、採用APIのavailabilityとPRF実機試験で確定する。OS名だけで互換性を保証せず、OS/ブラウザー/パスキー保存先/ネイティブまたは別端末経由の組で記録する。最新安定SDKを使い、ベータ専用APIを基本機能へ入れない。

Web公開前に小さなSwift検証クライアントでWeb作成パスキーの認証、PRF、VaultKey解除、本文・添付復号を試す。逆方向も試験する。ネイティブ製品版を後にする方針は維持する。

## 14. 公開・運用・セキュリティ

本番の`APP_ORIGIN=https://txt.2-38.com`、`WEBAUTHN_RP_ID=txt.2-38.com`とする。Workers Custom Domainで公開し、HTML、静的資産、API、Service Workerを同一Originに置く。BindingsはDB、MEDIA、ASSETSを基本とする。

workers.dev・プレビューの本番到達経路を無効化する。旧Access保護がある場合はtxtに必要な範囲だけを変更し、他アプリの保護を外さない。公開シェル、認証開始、AASA、privacy、supportは未認証で到達可能。本文・添付・鍵ラップはセッション認証を要求する。

静的配信とAPIルーティングの順序を明確にし、APIや`/_local/`がSPAフォールバックでindex.htmlを返さないようにする。Worker先行を使う場合も、旧Access検証を残してログイン画面やAASAを塞がない。[S34]

CSPはself中心。script-src/connect-src/worker-srcはself、object-src/base-uri/frame-ancestorsはnone、img/mediaのblobは必要範囲のみ。外部CDNスクリプト、eval、任意インラインスクリプト、解析タグ、セッションリプレイを使わない。nosniff、Referrer-Policy:no-referrerを設定する。

API、暗号文、復号後応答はprivate,no-store。ハッシュ付き公開静的資産だけ長期キャッシュする。Service Worker本体は更新確認を妨げない。外部資産やログへファイル名・本文を漏らさない。

運用ログはリクエストID、一般化したルート、状態、時間、容量、エラーコードに限定する。本文、鍵、Cookie、Bearer、復旧認証値、WebAuthn応答、入力イベントのdata、IME候補、DOMを記録しない。IME調査用詳細トレースは開発用の固定テスト文字列だけで実行し、本番入力を採取しない。

公開登録にはアカウント/ネットワーク単位制限、認証失敗制限、容量予約、全体容量/課金アラート、登録停止スイッチを設ける。メールなしで1人1アカウントは保証できない。10GiBを人数無制限で無料保証する設計にはせず、公開前に運用総量を決める。

バックアップは暗号文、公開認証情報、鍵ラップ、復旧認証ハッシュ等を含む機密データとして保護する。利用者の平文鍵を運用バックアップへ混ぜない。テスト用パスキー/復旧キーを別管理し、バックアップ復元と復号を演習する。

D1復元時はsyncEpochを更新し、セッション失効・削除済みアカウントの再無効化を復元手順に含める。元のencryptedRevisionを勝手に書き換えない。CloudflareのTime Travelや端末コピーがあるため、履歴UIなしを即時完全消去と説明しない。[S18]

## 15. 個人名義でのApp Store公開

個人Developer Programアカウントで公開する。App Storeの法的氏名表示は、利用者のメールを取得しない設計とは別の事項として確認する。[S19]

パスキーマネージャーの選択は自社アカウントの資格情報保管であり、その理由だけでSign in with Appleを追加しない。実際の構成を審査時のGuidelines 4.8/5.1等で確認する。[S20]

アプリ内でアカウント削除を開始できるようにする。step-upと確認後にdeletingへ移行し、全セッション・資格情報を失効、本文・添付・鍵ラップ・復旧情報を清掃する。単なるログアウトやメール依頼で代用しない。[S21]

物理削除の再試行に必要な最小状態だけを残し、削除期間とバックアップの扱いを説明する。削除済みアカウントをバックアップから通常運用へ復活させない。パスキーマネージャーの保存項目や、オフライン端末のコピーの自動消去は保証しない。

privacy/supportを公開し、App Privacy、プライバシーポリシー、不要な権限を実装と整合させる。暗号化しているだけで申告不要と判断しない。[S22]

暗号輸出コンプライアンスは実装と配信地域に基づき確認する。標準AES/OS API利用だけを理由にITSAppUsesNonExemptEncryptionを決め打ちしない。[S23]

審査者が通常のパスキー新規登録、復旧キー保存、本文・添付操作を試せる説明をReview Notesへ記載する。審査専用の認証バイパスや共通復号鍵を作らない。審査通過やストア名の使用可否を保証しない。

## 16. 実装構成・リリース順序

```text
spec.md
apps/
  web/                  # HTML/CSS/JS、editor adapter、composition、同期
                        # WebAuthn、暗号Worker、メディアService Worker
  worker/               # Hono、認証、D1、R2、清掃
  apple/                # iOS/macOS、TextKit adapter、Coordinator、標準UI
packages/
  protocol/             # schema、Encode、暗号契約、fixture・テストベクトル
  TxtCore/              # Swiftモデル、CryptoKit、API、SyncActor
migrations/
tests/
  protocol/
  editor/
  sync/
  security/
  media/
  manual-ime/
wrangler.jsonc
```

ProseMirror等の依存バージョンは固定し、更新時にIME/選択/Undo回帰試験を行う。特定OSのUA文字列だけで新しい入力実装へ切り替えず、必要な互換措置を限定・記録する。

Webのgzip 40KiBは絶対条件から外す。初期表示、入力遅延、暗号化負荷、実際の圧縮サイズを同じ機能で測定し、不要依存を削る。性能未測定のまま最速・最軽量と説明しない。

1. 先行検証: 日本語IME＋メディア＋Undoの小さな編集面、Web/SwiftのPRF/暗号形式、E2EE動画Range。
2. Web基礎: 登録・復旧・セッション、暗号化本文、共通モデル、CAS、暗号化退避。
3. Web完成: 添付、競合、清掃、IMEと障害注入、セキュリティレビュー、公開設定。
4. ネイティブ製品版: TxtCore、iOS/Mac標準UI、TextKit入力、オフライン、AVFoundation、審査準備。

「完成」は対象フェーズの受け入れ条件に合格した状態をいう。ネイティブ製品版が未完成でもWeb公開は可能だが、暗号相互運用の先行検証は省略しない。

## 17. 受け入れ条件・検証手順

### 17.1 IME環境表

| 対象 | 必須の確認経路 |
| --- | --- |
| iPhone Web | 対応するSafari、日本語かな/フリック、ローマ字、予測候補、外部キーボード |
| Mac Web | Safari、Chromium系、FirefoxとmacOS日本語入力。ライブ変換ON/OFF |
| Windows Web | Chromium系/FirefoxとMicrosoft IME。対応を掲げるGoogle日本語入力も確認 |
| iOS native | 最低対応OSと公開時安定OS、日本語かな/ローマ字、予測、外部キーボード |
| macOS native | 最低対応OSと公開時安定OS、ライブ変換ON/OFF、再変換 |

実際の機種、OS、ブラウザー、IME、ライブラリーバージョンを記録する。Web公開時はWeb行、ネイティブ公開時はnative行を必須とする。未確認環境を対応済みにしない。

### 17.2 IMEシナリオ

| ID | 操作・重なる処理 | 合格条件 |
| --- | --- | --- |
| IME-01 | 「にほんご」→候補選択→「日本語」確定 | 二重入力・脱落・余分な改行なし |
| IME-02 | 未確定のまま5秒以上入力/候補選択 | 強制確定・未確定分のサーバー保存なし |
| IME-03 | Enter、Space、矢印、Escape、Backspaceで候補操作 | 送信・添付削除・シート閉じが誤発火しない |
| IME-04 | 候補をタップ/クリックして確定、変換取消、再変換 | input順序に依存した取りこぼし・空文字判定なし |
| IME-05 | 変換中に保存応答・304・遠隔更新が到着 | キャレット・未確定下線・候補・本文を保持 |
| IME-06 | 変換中に添付2件が逆順完了 | 確定後に予定位置・順序で挿入 |
| IME-07 | 添付位置を削除/取消後に完了 | 添付が復活しない |
| IME-08 | 長文、文頭/文中/文末、メディア直前直後で変換 | 入力可能、位置ずれ・不可視キャレットなし |
| IME-09 | 確定後Undo/Redo、メディアをまたぐ切り取り/Undo | 文字と参照が一致、保存応答が履歴に入らない |
| IME-10 | フリック、ライブ変換、予測、OS音声入力 | 同じ確定本文を保存・再表示できる |
| IME-11 | 「が」「が」、異体字、ZWJ絵文字、全角空白、タブ、末尾LF | 意図しない正規化・分断・欠落なし |
| IME-12 | 変換中に非表示、認証切れ、ロック、強制終了 | 未確定分を誤同期せず、退避済み分は確認付き復旧 |
| IME-13 | 変換中に本文容量超過・端末保存失敗 | 自動切り詰め・保存済み誤表示なし |
| IME-14 | IME中に文字拡大、キーボード表示変更、添付レイアウト変更 | marked text、候補位置、入力行を不必要に壊さない |

自動テストではcomposition/input/transactionの順序違いと状態機械を検証する。ただし合成イベントやPlaywrightのfillだけでは実IMEを再現したことにならない。上表はOSの実IMEで手動/実機操作も行う。バグ修正時は再現ケースをfixture/回帰試験へ追加する。

### 17.3 認証・暗号

- [ ] メール・電話・通常パスワードなしに登録/ログインできる。
- [ ] PRF非対応、追加assertion、取消、途中終了を扱い、読めないactive文書を作らない。
- [ ] 同じ資格情報でWeb→Swift、Swift→WebのVaultKey・本文・添付相互復号に合格する。
- [ ] nonce、tag配置、Encode、HKDF、base64url、Unicodeの共通既知入力/期待出力が一致する。
- [ ] PRF results等がtoJSON/SDK応答経由でAPI・ログ・監視に出ない。
- [ ] 署名、challenge再利用、UVなし、別Origin、別RP、userHandle不一致を拒否する。
- [ ] 追加パスキー、旧入口失効、復旧キー単独復旧、途中失敗・再送を確認する。
- [ ] 鍵不足・暗号文改変・AAD不一致を空文書として保存しない。

### 17.4 編集・同期・永続化

- [ ] title/一覧なしに1枚を開き、装飾やHTMLを保存しない。
- [ ] Web/TextKit共通fixtureの往復で文字、ID、空行、末尾LF、メディア参照が保持される。
- [ ] 同revisionの別アカウントを誤304/誤PUTにしない。
- [ ] 保存中の追加入力、暗号化完了順逆転、古い応答で新しい入力/ドラフトを消さない。
- [ ] 同ETagからの並行保存を412で検出し、両方の内容を保全する。
- [ ] 保存応答消失の同一ペイロード再送は二重更新しない。異なる再送は409。
- [ ] GET中の更新でも本文・参照が混在しない。CAS失敗では参照だけを変更しない。
- [ ] 5秒/30秒/非表示停止、再表示取得と表示上の説明が一致する。
- [ ] 遠隔版採用後にUndoで旧版を復活させない。
- [ ] 複数タブ/sceneのドラフト、アカウント切替、syncEpoch変更を安全に扱う。

### 17.5 添付・運用・UI

- [ ] 512MiB動画の先頭/中間/末尾シークを全体読み込みなしで実機確認する。
- [ ] チャンク改変・順序入替・切詰めを認証前の平文出力なしで拒否する。
- [ ] Service Worker初回制御・再起動・更新・ロック・複数タブで鍵を取り違えない。
- [ ] native resource loaderの並行要求・取消・Range・キャッシュ上限を確認する。
- [ ] 同一パート再送、変更ペイロード、遅い応答、完了と取消、R2成功/D1失敗から回復する。
- [ ] 再参照と清掃が競合しても参照中実体を削除しない。
- [ ] 他人のID、未参照・未完成メディア、公開R2経路で認可を迂回できない。
- [ ] バックアップ復元時に失効セッション・削除アカウントを再有効化しない。
- [ ] VoiceOver、拡大、ライト/ダーク、標準picker/toolbar/menu、キーボード操作を確認する。
- [ ] AASAの実値・未認証配信、アカウント削除、privacy/support、個人公開時の各申告を確認する。

公開判定では未実施を合格扱いしない。性能、セキュリティ、入力、再生の結果を区別し、対応表に未検証・非対応・合格を記録する。

## 18. 先行改善案の採用結果

| 改善項目 | 本書での扱い |
| --- | --- |
| 編集処理の全面自作を避ける | 最小ProseMirror、native TextKit。依存ゼロ制約を解除（§2/9） |
| 日本語IMEを実装規則へ落とす | composition安全点、marked text、キー操作、退避、実機試験（§9/17） |
| revisionだけのETagを改善 | 文書ID+syncEpoch+revision、所有者確認（§10） |
| 保存と添付のdirtyを分離 | 確定入力、転送、保留完了、遠隔版を別状態化（§10） |
| 添付位置と取消を追跡 | transaction mapping/アダプター、安全点挿入（§9/11） |
| CAS・参照・清掃の整合性 | 同一D1トランザクション、guard、障害注入（§10/11/12） |
| 同期説明と5秒/30秒仕様の不一致 | 状態別取得間隔と受け入れ条件を統一（§10/17） |
| 同一ブラウザー内の更新通知 | BroadcastChannelを補助として採用（§10） |
| Undoが遠隔版を消す問題 | 遠隔版採用時の履歴クリア（§9/10） |
| サーバー暗号鍵の復元手順 | E2EEへ変更したため利用者側パスキー/復旧キーと暗号文バックアップの試験へ置換（§6/7/14） |
| 添付単位の鍵・包み鍵 | fileKeyを暗号化本文内に保持、VaultKeyをパスキー/復旧キーで包む（§6/11） |
| Durable Objects/Yjsの追加 | 初版は見送り。必要になるまでHTTP同期と明示競合解決（§2） |
| PRFや大容量暗号化再生の互換性 | 推測で対応済みにせず先行検証・公開ゲート化（§13/16/17） |

## 19. 対象外と公開時に必要な実値

複数文書、文書タイトル、フォルダー、タグ、検索機能、公開共有、共同編集カーソル、履歴一覧、ごみ箱、Markdown表示、装飾、AI、文字起こし、録音/録画、サーバー動画変換、広告、通知、常時バックグラウンド同期は追加しない。復旧・削除・エラー対応に必要なUI以外を「便利そう」という理由で増やさない。

Apple Team ID、Bundle ID、D1/R2のID、Cloudflare本番設定、公開時の対応バージョン表、運用全体容量、価格/販売地域、実測性能、独立レビュー結果は実装・公開準備で記入する実値である。認証や入力の方式を未定にしているという意味ではない。

本書を更新しただけではDNS、Access、D1、R2、Apple登録、ストア申請、暗号実装、実機UI、IME、動画再生は設定・検証されない。

## 20. 参照資料

従来統合仕様の一次資料[S1]〜[S24]を継承し、今回のIME・編集・同期補強に[S25]〜[S34]を追加した。調査/仕様更新日: 2026-09-20。資料のAPI説明と、本書独自の採用判断・未実測の目標値を区別する。

- [S1] W3C WebAuthn Level 3（PRF、資格情報、検証、PRF resultsの送信注意）: `https://www.w3.org/TR/webauthn-3/`
- [S2] SimpleWebAuthn server: `https://simplewebauthn.dev/docs/packages/server`
- [S3] Apple PRF assertion input: `https://developer.apple.com/documentation/authenticationservices/asauthorizationpublickeycredentialprfassertioninput-swift.struct`
- [S4] 1Password iOS 8.10.74 release notes: `https://releases.1password.com/ios/stable/8.10.74/`
- [S5] SimpleWebAuthn PRF guidance: `https://simplewebauthn.dev/docs/advanced/prf`
- [S6] Apple Connecting to a service with passkeys: `https://developer.apple.com/documentation/authenticationservices/connecting-to-a-service-with-passkeys`
- [S7] Apple TextKit: `https://developer.apple.com/documentation/uikit/textkit`
- [S8] Apple HIG Toolbars: `https://developer.apple.com/design/human-interface-guidelines/toolbars`
- [S9] Apple WWDC25 What's new in SwiftUI: `https://developer.apple.com/videos/play/wwdc2025/256/`
- [S10] MDN Web Crypto: `https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API`
- [S11] Apple CryptoKit: `https://developer.apple.com/documentation/cryptokit`
- [S12] Apple Storing CryptoKit keys in the keychain: `https://developer.apple.com/documentation/cryptokit/storing-cryptokit-keys-in-the-keychain`
- [S13] Cloudflare D1 Database / batch: `https://developers.cloudflare.com/d1/worker-api/d1-database/`
- [S14] Cloudflare D1 limits: `https://developers.cloudflare.com/d1/platform/limits/`
- [S15] Cloudflare R2 Workers API: `https://developers.cloudflare.com/r2/api/workers/workers-api-reference/`
- [S16] MDN FetchEvent.respondWith: `https://developer.mozilla.org/en-US/docs/Web/API/FetchEvent/respondWith`
- [S17] Apple AVAssetResourceLoaderDelegate: `https://developer.apple.com/documentation/avfoundation/avassetresourceloaderdelegate`
- [S18] Cloudflare D1 Time Travel: `https://developers.cloudflare.com/d1/reference/time-travel/`
- [S19] Apple Program enrollment: `https://developer.apple.com/help/account/membership/program-enrollment/`
- [S20] Apple App Review Guidelines: `https://developer.apple.com/app-store/review/guidelines/`
- [S21] Apple Offering account deletion in your app: `https://developer.apple.com/support/offering-account-deletion-in-your-app/`
- [S22] Apple App privacy details: `https://developer.apple.com/app-store/app-privacy-details/`
- [S23] Apple Overview of export compliance: `https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance/`
- [S24] ProseMirror schema guide source: `https://raw.githubusercontent.com/ProseMirror/website/master/markdown/guide/schema.md`
- [S25] MDN beforeinput（IME等で取消不能/未発火となる場合）: `https://developer.mozilla.org/en-US/docs/Web/API/Element/beforeinput_event`
- [S26] ProseMirror Reference（EditorView.composing、transaction、DOM管理）: `https://prosemirror.net/docs/ref/`
- [S27] Apple UITextInput.markedTextRange: `https://developer.apple.com/documentation/uikit/uitextinput/markedtextrange`
- [S28] Apple NSTextInputClient.hasMarkedText: `https://developer.apple.com/documentation/appkit/nstextinputclient/hasmarkedtext()`
- [S29] Apple UIViewRepresentable（Coordinatorと更新経路）: `https://developer.apple.com/documentation/swiftui/uiviewrepresentable`
- [S30] MDN compositionend（確定または取消）: `https://developer.mozilla.org/en-US/docs/Web/API/Element/compositionend_event`
- [S31] ProseMirror開発者によるcomposition状態の説明: `https://discuss.prosemirror.net/t/the-composing-property-of-editorview-may-be-incorrect-within-the-handletextinput-method/8877`
- [S32] ProseMirror公式添付例のソース（位置追跡・取消）: `https://raw.githubusercontent.com/ProseMirror/website/master/example/upload/index.js`
- [S33] MDN Broadcast Channel API: `https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API`
- [S34] Cloudflare Static Assets configuration: `https://developers.cloudflare.com/workers/static-assets/binding/`
