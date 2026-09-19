## 1. 目的と本書の位置付け

公開URL `https://txt.2-38.com/` を開くと、自分専用の1枚のテキストを読み書きできるアプリを作る。タイトル、文書一覧、フォルダー、文字装飾、変更履歴を持たず、画像・動画・音声だけを本文中に挿入できる。本文・添付は自動保存し、同じ利用者のWeb・iOS・macOS間で同期する。

最初にWebを公開し、その後SwiftによるネイティブiOS・macOSアプリを個人名義でリリースする。ネイティブアプリはWebViewでWeb画面を包む方式にしない。

仕様更新日: 2026-09-20。これは実装前の統合仕様であり、動作確認済みのアプリやセキュリティ監査の報告ではない。以前のCloudflare Access・Worker側復号・R2 SSE-C中心の仕様、およびそれを前提とした設計レビューを、本書で置き換える。画面案、数値上限、暗号コンテナー、APIは本アプリの設計判断である。公式資料は末尾の参照番号で示す。

最優先の実機検証は、同じパスキーのWeb/Swift間のPRF互換性と、暗号化された大きな動画のシーク再生である。この2点の合格前に、対応環境やE2EE動画機能の完成を宣伝しない。

## 2. 採用する全体構成

| 領域 | 採用仕様 |
| --- | --- |
| 公開ホスト・WebAuthn RP ID | `txt.2-38.com`。WebのOriginは `https://txt.2-38.com` |
| サーバー | Cloudflare Workers + Hono |
| データ | D1に認証情報・最新の暗号文・同期状態。非公開R2に暗号化添付 |
| ログイン | メール・電話・パスワードを要求しない、発見可能なパスキー |
| パスキーの保存先 | 1Password、Appleのパスワード等。OS/ブラウザー標準の選択UIに任せる |
| 暗号化 | PRFで復元する鍵でマスター鍵を包む、クライアント側E2EE |
| 復旧 | 独立した復旧キーと、追加登録したパスキー |
| Web | HTML/CSS/JavaScript + 最小構成のProseMirror。React等は使わない |
| iOS | SwiftUIの外枠 + UIKit/TextKitの編集面 + AVFoundation |
| macOS | SwiftUIの外枠 + AppKit/TextKitの編集面 + AVFoundation |
| ネイティブ共通部分 | Swift Packageによるモデル・暗号・API・同期処理 |
| 保存・同期 | 条件付きHTTP更新、短周期ポーリング。CRDT・常時接続は初版に入れない |
| 履歴 | 最新状態だけ。セッション内Undoは可能、サーバーの版履歴は作らない |

「個人としてリリース」は開発者の名義を意味し、利用者を開発者本人や特定メールドメインに限定しない。一般の利用者もパスキーで作成でき、各アカウントが非共有の1枚を持つ。料金・販売地域・正式なストア名は本書では決定しない。

Cloudflare Accessのログイン、`@2-38.com`制限、Access JWT検証は本アプリから削除する。1Password自体のアカウントへOAuthログインする機能や、Apple Accountでのソーシャルログインを代わりに追加するわけではない。

## 3. 通常の操作と表示

起動済みの認証・解除状態が有効なら、タイトル入力や選択画面なしで編集面を開く。認証は有効でも復号鍵が端末にない場合は「パスキーで開く」を表示する。空の本文と、まだ読めていない本文を区別する。読込・復号失敗時に空文書で上書きしない。

本文は装飾のない文字列として扱う。`# 見出し`、`**太字**`、URL、HTMLタグは文字のまま表示し、自動リンク化しない。太字、斜体、見出し、リスト、チェックボックス、文字色・文字サイズの編集は提供しない。システムの文字拡大やアクセシビリティ上の太字設定は尊重する。

改行はLFに統一する。それ以外の空白除去、Unicode正規化、全角半角変換を行わない。空行、連続スペース、タブ、絵文字、日本語IME、複数行選択を保持する。貼り付けの文字は `text/plain` のみ取り込む。日本語変換中の再描画・同期適用を避ける。

画像・動画・音声は本文中の独立したメディア要素とする。文字をその前後に書ける。回り込み、手動リサイズ、装飾、専用キャプション欄はない。動画・音声は標準コントロールを使い、自動再生しない。メディアに隣接する最初のBackspace/Deleteは選択、次の操作で削除する。選択範囲に含まれるメディアは範囲削除の対象になる。

アップロード中も本文を編集できる。挿入時に位置・順序・取消状態を確保し、完了順に並べ直さない。取り消した挿入を遅い完了応答で復活させない。文字編集で既存の動画プレイヤーを作り直さず、再生位置を維持する。

## 4. Web・iOS・macOSのUI設計

### 4.1 共通の情報設計

常設するアプリ操作は「添付」と「その他」の2つだけ。本文タイトル、アプリロゴ、大きなヘッダー、サイドバー、タブバー、保存ボタン、文字装飾バーを置かない。同期状態は操作付近に控えめに表示し、正常時は短時間で消す。未保存・失敗・競合は消さず、色だけでなく文字でも示す。

通常画面は本文のための場所であり、セキュリティ説明や設定カードを常設しない。認証、復旧キー保存、競合解決、アカウント管理は必要なときだけ別画面・シートで扱う。

以下はレイアウトのワイヤーフレームであり、完成画像や実機スクリーンショットではない。角括弧は操作、点線は説明上の領域境界で、本文に枠線を描画する指示ではない。

### 4.2 Web: 余白のある1枚

```text
ブラウザーの通常のアドレスバー
┌──────────────────────────────────────────────┐
│                                              │
│  ここから普通に書く。                        │
│  空白や改行をそのまま残す。                  │
│                                              │
│  ［本文幅以内の画像］                        │
│                                              │
│  画像の後にも書く。                          │
│                                              │
│                                              │
│  [添付]                         保存中   […] │
└──────────────────────────────────────────────┘
```

画面幅を利用し、左右余白はモバイル16〜20 CSS px、デスクトップ24〜48 CSS pxを設計目安とする。中央のカードや紙の影は作らない。本文はシステムの等幅系フォントと日本語フォールバック、基準16 CSS px、行高1.6。ブラウザーズームを禁止しない。OSのライト/ダーク設定へ追従する。

下端の添付・その他操作はセーフエリアとソフトウェアキーボードを考慮する。入力行を隠さない末尾余白を確保する。タップ領域は44×44 CSS px以上を目標にし、デスクトップにも同じ操作を残す。通常表示のボタンはアイコン中心、アクセシブル名とツールチップを付ける。

WebにApple固有のウィンドウ枠、信号ボタン、偽物のiOSステータスバーを描かない。アイコンは小さな自作SVG等を用い、SF Symbolsの素材を安易にWebへ転用しない。ブラウザーの `<title>` は固定の `txt` とし、本文の先頭行をタイトルにしない。

### 4.3 iOS: Apple標準の編集画面

```text
┌─────────────────────────┐
│      OSのステータスバー │
│              [添付] […] │ ← 標準toolbar、タイトルなし
│                         │
│  ここから書く。         │
│                         │
│  ［画像］               │
│                         │
│  ［動画の標準操作］     │
│                         │
│  続きの文章。           │
│                         │
│   必要なときだけ保存状態│
│─────────────────────────│
│    OSのキーボード       │
└─────────────────────────┘
```

SwiftUIを画面・標準toolbar・sheet・menuに使い、本文は `UIViewRepresentable` 経由の `UITextView` とTextKitを使う。`TextEditor`だけで画像・動画・音声を含む編集の要件を満たせるとは仮定しない。メディアには `NSTextAttachment` と対応するView Provider等を使い、動画・音声の状態はmediaIdで管理する。内部でAttributedStringを使っても、保存できる内容は文字とメディアに限定する。[S7]

toolbarの右側に `paperclip` と `ellipsis` を置き、標準メニューを開く。タイトル・戻るボタンは階層がある場面だけに使う。初回からキーボードを強制表示せず、本文タップで入力を始める。設定・復旧・競合は標準sheetとして表示する。

本文のベースはDynamic Typeのbody相当・等幅デザインとし、日本語はシステムフォールバックを使う。文字サイズを固定しない。背景・文字・区切りはシステムの意味的な色を用いる。写真選択はPhotosPicker、ファイルはfileImporterを使い、全写真への許可を最初から要求しない。録音・撮影機能がない初版でマイク・カメラ権限を求めない。

### 4.4 macOS: 普通のMacの小さなテキストアプリ

```text
macOSのメニューバー: txt / ファイル / 編集 / ウインドウ / ヘルプ
┌────────────────────────────────────────────────┐
│ ● ● ●                              [添付] […] │
│                                                │
│  ここから普通に書く。                          │
│                                                │
│  ［画像］                                      │
│                                                │
│  ［音声の標準操作］                            │
│                                                │
│  続きの文章。                                  │
│                                                │
└────────────────────────────────────────────────┘
```

SwiftUIのWindowと `NSViewRepresentable` 経由の `NSTextView` / TextKitを使う。macOS版をiPhone風の画面やWebViewにしない。標準のウィンドウボタン・統合toolbar・メニューバー・スクロール・コンテキストメニューを利用する。

初期サイズ900×680 pt、最小400×320 ptを設計目安とする。本文の表示タイトルはなく、ウィンドウのアクセシビリティ名は「テキスト」とする。本文をウィンドウタイトルやDockの補助表示へ転記しない。設定は標準Settingsシーンと `⌘,` で開ける。

`⌘Z`、`⇧⌘Z`、`⌘A`、コピー・貼り付けなどを標準動作に合わせる。`⌘S` は現在の未保存内容を即時送信するが、文書名・保存場所のダイアログを出さない。「新規文書」「別名で保存」「文書を開く」は提供しない。OS標準の終了・非表示操作を妨げない。

### 4.5 Appleのデザインシステムへの合わせ方

Appleの標準toolbar、sheet、menu、picker、意味的な色、Dynamic Type、SF Symbolsを優先する。Liquid Glassは対応OSの標準コンポーネントに任せ、本文全面をガラス化したり、独自のぼかし・グラデーションで模倣したりしない。古い対応OSではそのOSの標準外観を使う。外観目的で最新のベータAPIを必須にしない。[S8][S9]

VoiceOver、キーボード操作、選択とフォーカス、文字拡大、コントラスト、透明度低減、視差効果低減へ対応する。ネイティブの操作領域は44 ptを基本目標とし、サイズ固定による長い翻訳の切れを避ける。マウス用の見た目とタップ可能領域は分けて設計してよい。

### 4.6 初回・ロック・例外状態の文言

| 状態 | 表示・操作 |
| --- | --- |
| 未登録/未認証 | 「メールアドレスなしで、1枚のテキストを。」／「パスキーで開く」「はじめて使う」「復旧キーで開く」 |
| 新規作成 | OSのパスキー作成 → PRF動作確認 → 復旧キー保存 → 空の編集面 |
| 認証済み・鍵なし | 「パスキーで開く」。本文の空表示はしない |
| PRF未対応 | 「この環境では、このパスキーで暗号化された内容を開けません。」／別のパスキー・復旧キーの選択 |
| ローカル変更あり | 「保存中」または「端末に保存済み・未同期」 |
| 同期成功 | 「同期済み」を短時間表示して消す |
| 添付転送中 | 挿入位置に進捗と取消。本文の保存成功だけで全体を同期済みにしない |
| 認証期限切れ | 暗号化ドラフトを退避し「再ログインが必要です」。内容を削除しない |
| 復号失敗 | 「内容を開けません。データは変更していません。」／再試行・別の解除方法 |
| 競合 | 両方の内容を端末内で確認。「編集して保存」「サーバーの内容を使う」。破棄には確認 |
| 再生不可 | 添付位置に理由と、対応環境の案内・利用可能な復号後ダウンロード |

「1Passwordでログイン」「Appleでログイン」という別々のソーシャルログインボタンは作らない。共通のパスキー操作からOS/ブラウザーの保存先選択へ進む。

その他メニューには、セキュリティ設定、ロック、ログアウト、プライバシー、サポートを置く。セキュリティ設定には追加パスキー・失効・復旧キーの更新・セッション終了・アカウント削除をまとめる。設定をゼロにするために復旧や削除を省略しない。

## 5. パスキー認証と利用者の識別

### 5.1 メールアドレスを持たないアカウント

アカウントIDはランダムUUID、WebAuthnのuserHandleは32バイトの乱数とする。メール・電話・氏名の列や入力欄を作らない。WebAuthnの `user.name` と `displayName` に必要なラベルは `txt-8CF3A2B1` 等のランダムな表示名とし、所有者判定には使わない。ラベルを同じにしても別のパスキーやアカウントは自動連結しない。[S1]

個人情報を一切処理しないという意味ではない。アカウントID、公開鍵、credential ID、利用時刻、容量、セッション、通信に伴う情報は存在する。プライバシー説明で「完全匿名」「データ収集なし」と一律に宣言しない。

### 5.2 登録・認証の要件

WebはWebAuthn、ネイティブはAuthenticationServicesを使う。サーバー検証は `@simplewebauthn/server` を第一候補にし、Workersでの互換性と本番バンドルを実証してバージョンを固定する。暗号署名、CBOR、FIDO検証を独自実装しない。認証ライブラリーの採用をPRFの自動的な安全性保証と解釈しない。[S2]

`residentKey: required`、`userVerification: required`、`attestation: none` を基本とする。1Password等を排除する `authenticatorAttachment: platform` の固定は行わない。ログイン時は原則として空のallowCredentialsによる発見可能な資格情報を使う。

challengeは32バイト以上の乱数、期限5分、1回限りとし、登録・認証・追加・削除・復旧の用途と対象アカウントを結び付ける。サーバーはchallenge、type、RP ID hash、許可Origin、署名、UP/UV、所有アカウントを検証する。同期型パスキーのcounterやbackupフラグの意味を踏まえ、counter=0を一律に不正としない。[S1]

Webの許可Originは `https://txt.2-38.com` のみ。ネイティブから届くclientDataJSONのOrigin等は実機で採取した正常系をもとに同じRPへ厳密に結び付ける。動かすためにOrigin検証を無効化したり、ワイルドカードを使ったりしない。ローカル/検証環境は本番とは別のRP・データ・資格情報を使う。

### 5.3 初回の確定順序

登録中アカウントはpendingとし、通常の文書APIを許可しない。パスキー作成・署名検証後、クライアントがPRFの実出力を取得し、マスター鍵のラップと試験復号を行う。登録時にPRF出力が得られない場合は追加のassertionを行う。

次に復旧キーを生成し、保存操作と保存確認を済ませる。暗号化された空文書、パスキー用のラップ済み鍵、復旧用情報を一括してbootstrap APIへ渡す。D1でそれらの保存とactiveへの遷移を原子的に確定する。通信失敗時の再試行にはbootstrapIdを使い、同じアカウントへ別の初期鍵を黙って上書きしない。

復号可能性の試験はクライアントが行う。サーバーはそのために平文の鍵を受け取らない。初版の新規登録はPRFを実際に利用できる経路を必要条件とする。PRF非対応しか使えない環境では別の保存先/環境へ案内し、読めないアカウントを完成させない。放置したpending登録は24時間を目安に清掃する。

### 5.4 セッションと解除は別

パスキーはログイン・鍵の解除に用い、文字を保存するたびにFace IDや1Passwordを要求しない。通常APIはランダムな256bit以上の不透明セッショントークンで認可し、D1にはそのハッシュを保存する。

Webは `__Host-txt_session` のSecure・HttpOnly・SameSite=Strict・Path=/ Cookieを使用し、Domain属性を付けない。ネイティブはKeychainに保存したBearerトークンをURLSessionで送る。ブラウザー向けAPIはトークンをlocalStorageへ保存しない。

絶対期限30日、無操作期限7日を初期設計値とし、サーバーで失効を確認する。セキュリティ操作は5分以内の再認証を要求する。これらの期限は鍵のメモリー保持期限と独立して扱う。

Cookie付き書込はOriginとカスタムヘッダーを検証する。Originを通常付けないネイティブは、ネイティブ用の検証済みセッションとBearer認証で区別する。任意の `X-Client` ヘッダーをCSRF検証の迂回条件にしない。認証前のceremonyもクライアント種別・challengeの払い出しと検証を対応させる。

## 6. パスキーを使うE2EE

### 6.1 何をパスキーから作るか

パスキーの署名値、公開鍵、credential IDを本文の暗号鍵にしない。PRF拡張の秘密の出力から鍵暗号化鍵を導出し、それで独立したマスター鍵を包む。AppleのAuthenticationServicesにはPRF用のAPIがあり、1PasswordのiOS安定版でもiOS 18向けPRF対応が公開されている。ただしブラウザー・OS・保存先・呼出経路の組み合わせごとに確認が必要である。[S1][S3][S4]

```text
パスキーAのPRF出力 → HKDF → KEK-A → マスター鍵を包んだ小さな暗号文A
パスキーBのPRF出力 → HKDF → KEK-B → 同じマスター鍵を包んだ暗号文B
復旧キー          → HKDF → KEK-R → 同じマスター鍵を包んだ暗号文R
                                      ↓ 端末内だけで解除
                            ランダム32バイトのVaultKey
                               ├─ 本文・ドラフトの暗号化
                               └─ 本文内に保護された各メディア鍵
```

パスキー追加・変更のたびに動画全体を暗号化し直さなくてよい設計にする。パスキーの削除はその入口を無効にする操作であり、過去にコピーされたマスター鍵や平文まで消去するものではない。侵害後の完全な鍵更新には別途データの再暗号化が必要になる。

### 6.2 PRF入力とラップ

発見可能なパスキーを選ぶ前にも分かる、公開のアプリ共通入力を用いる。

```text
prfInputV1 = SHA256(UTF8("txt.2-38.com/prf-input/v1"))
prfOutput = WebAuthn/AuthenticationServicesのPRF(prfInputV1)
KEK = HKDF-SHA256(prfOutput, wrapSalt32,
                 Encode("passkey-wrap", accountId, credentialId), 32)
wrappedVaultKey = AES-256-GCM(KEK, randomNonce12, VaultKey, wrapAAD)
```

PRF入力は秘密ではない。同じ入力でも資格情報ごとに秘密の出力が異なる。アプリの入力とWebAuthnが内部で行う処理を混同して二重変換しない。WebとSwiftでまったく同じ入力バイトを渡した場合の鍵導出を試験する。公開入力のバージョンをデプロイのたびに変えない。

ラップはcredential ID・account ID・暗号形式・鍵バージョンをAADに結び付ける。wrapSaltとnonceと暗号文はD1へ保存できる。PRFの `enabled/isSupported` 表示だけで成功とせず、実際の出力・ラップ・再解除を確認する。[S3][S5]

PRF出力やKEKをAPI・ログへ送らない。認証応答は送信フィールドをホワイトリスト化し、`getClientExtensionResults()`、`credential.toJSON()`、ライブラリーの戻り値を丸ごとPOSTしない。PRFのresultsを除外したことをネットワーク試験で検証する。Swift側でもPRF由来のSymmetricKeyをサーバー送信用モデルへ入れない。

### 6.3 共通の暗号形式

暗号はWeb CryptoとCryptoKitのAES-256-GCM、HKDF-SHA256、SHA-256を利用し、アルゴリズム自体を自作しない。nonceは12バイト、認証タグは16バイト。暗号文表現はciphertextとtagを連結し、nonceを別フィールドとする。JSON内のバイナリーはパディングなしbase64urlを使う。[S10][S11]

本書の暗号コンテナーはアプリ固有の設計であり、第三者監査済みの標準コンテナーと称さない。実装前に形式を固定し、独立したセキュリティレビューとWeb/Swift共通の既知入力・期待出力テストを行う。

`Encode` はUTF-8文字列・バイナリーの各フィールドを4バイトbig-endian長で区切って連結する。UUIDは16バイト、整数はunsigned 64bit big-endianを基本とする。用途名に `txt/v1/` を前置し、長さ・順序・文字コードをテストベクトルに固定する。JSONのキー順やSwiftの辞書列挙順をAADの規則にしない。

本文保存は変更ごとに新しいmutationIdを生成し、`VaultKey`からmutationIdをsaltとする用途別HKDFでスナップショット鍵を導出する。AADにaccount ID・document ID・形式バージョン・mutationId・保存先revisionを含め、新しい乱数nonceで暗号化する。再送は同じmutationIdと暗号文バイトを使い、内容を変えたら新しいmutationIdにする。

復号失敗、未対応形式、AAD不一致を、空の成功データへ置き換えない。AEADは整合性を保護するが、初めて使う端末に対するサーバーの古い正当な暗号文の再提示まで完全に検出する仕組みではない。E2EEはサーバーによる削除やサービス停止も防がない。

### 6.4 鍵・端末内データ

Webの初版はマスター鍵をメモリーにのみ保持し、再読み込み後はパスキーまたは復旧キーで解除する。IndexedDBには暗号化された最新本文キャッシュ・未同期ドラフトだけを置く。ドラフトは用途別鍵と保存ごとの新しい識別子/nonceで保護する。localStorage、sessionStorageへ鍵や平文本文を置かない。

ネイティブは本人確認を伴う端末内解除を可能にするため、VaultKeyをKeychainの端末限定・ロック状態を考慮した保護で保存する。`WhenUnlockedThisDeviceOnly` とuserPresenceを基本候補とし、Face ID/Touch ID/パスコードの動作を実機確認する。対称鍵がそのままSecure Enclave内で汎用AES鍵として使えるとは説明しない。セッショントークンは復号鍵と別項目にする。[S12]

ロック・ログアウトでは表示を覆い、再生を停止し、Object URLを破棄し、画面・Service Worker・処理キューの鍵参照を切る。ネイティブは非アクティブ時のアプリ切替画像も覆う。バックグラウンド移行から5分で再解除を要求する初期方針とし、明示ロック・端末ロック時はより早く解除状態を終了する。タイマー停止を考慮し、復帰時に必ず時刻で再判定する。

未保存内容がある場合はロック前に暗号化退避を試みる。退避失敗を隠さない。ブラウザーのメモリーや一時領域の完全消去、OSやブラウザープロファイルを支配する攻撃者への保護は保証しない。

### 6.5 サーバーに見えるもの・見えないもの

本文、元ファイル名、MIME、復号された添付、VaultKey、メディア鍵、復旧キーはサーバーへ渡さない。D1・R2はクライアントが暗号化したデータを保管する。R2標準の保存時暗号化は追加層として使うが、Workerが鍵を持つSSE-CをE2EEの代わりにしない。

所有者のランダムID、credential公開鍵、容量、revision、時刻、アップロード状態、メディア参照関係等はサーバーから見える。サーバーは認可・容量・暗号文サイズ・状態遷移を検証できるが、平文のMIME判定、ウイルス検査、サムネイル生成、動画変換はできない。

Web版のE2EEは、配信されたJavaScriptを信頼する境界を持つ。運営者による悪意あるコード配信、XSS、依存コード侵害、解除済み端末の乗っ取りは別の脅威である。「運営者がどのような操作をしても絶対に読めない」とは説明しない。

## 7. パスキー追加・互換性・復旧

### 7.1 追加と未対応環境

「パスキーを追加」は、既存アカウントにログインして内容を解除した状態から始める。新しいパスキーの作成・PRF確認後、同じVaultKeyを新しいKEKでラップして登録する。新しいパスキーで再認証・試験復号できるまでは既存の入口を削除しない。

同じパスキーが1Password等を通じて同期される場合と、新しい別パスキーをAppleのパスワードへ追加する場合を区別する。別パスキーのPRF出力が同じになるとは仮定しない。プロバイダー間の移行やエクスポート後も互換性試験を必要とする。

既存アカウントではパスキー認証が成功しても、PRF非対応なら内容はまだ解除できない。別の対応パスキーか復旧キーのローカル入力を案内する。サーバーが復号鍵を渡す方式へのダウングレードは行わない。対応表はOS名だけでなく、ブラウザー、保存先、ネイティブ/ブラウザー/別端末経由の組み合わせで管理する。

### 7.2 復旧キーは認証と復号の両方を復旧する

メールによる再設定は用意しない。初期設定時に暗号学的乱数32バイトのRecoverySeedを生成する。コピー/ファイル保存で利用者に渡し、保存したことを確認する。表示名は「復旧キー」とする。

```text
RecoveryAuth = HKDF-SHA256(RecoverySeed, accountId,
                          "txt/v1/recovery-auth", 32)
RecoveryKEK  = HKDF-SHA256(RecoverySeed, accountId,
                          "txt/v1/recovery-wrap", 32)
サーバーに保存: SHA256(RecoveryAuth)、RecoveryKEKで包んだVaultKey
サーバーに保存しない: RecoverySeed、RecoveryKEK、VaultKey
```

認証用と復号用の導出を分離し、復旧認証でRecoveryAuthをTLS越しに送っても、サーバーがRecoveryKEKを計算できない構成にする。復旧APIへRecoverySeedそのものや復旧キー文字列全体を送らない。

復旧キー形式は `TXT1.<accountIdの16バイトをbase64url化>.<RecoverySeedのbase64url>.<検査用文字列>` とする。検査用文字列はそれ以前のASCII文字列のSHA-256先頭4バイトをbase64url化し、入力誤りの検出にだけ用いる。復旧キーをURL・クエリー・アクセスログへ載せない。これは人が決める短いパスワードではない。

復旧時はRecoveryAuthを検証して用途限定セッションを発行し、ラップ済みVaultKeyを端末で解除する。新しいパスキーを登録・試験復号し、新しい復旧キーを保存確認してから、既存の資格情報・セッションの失効と復旧情報の置換を原子的に確定する。旧キーを先に消費して、途中失敗で唯一の復旧手段を失わない。再送は復旧操作IDで識別する。

紛失したパスキーと同じ保管先だけに復旧キーを置くと、保管先ごと失った場合の救済にならない。独立した安全な保存先も用意するよう説明する。復旧キーを持つ第三者は内容を開けるので、通常の共有・サポート送付を促さない。

すべてのパスキー、利用可能な端末内鍵、復旧キーを失った場合、運営者は復号もアカウントの安全な本人確認も代行できない。失った暗号文を新しい鍵で読めるようにする機能はない。復旧キーのローテーションは過去に流出したVaultKeyを無効化しない。

## 8. 共通の文書モデル

WebのProseMirror JSON、HTML、NSAttributedStringのアーカイブを同期形式にしない。共通のバージョン付きJSONへ各クライアントが変換する。次の構造は暗号化前の端末内表現であり、APIへ平文送信しない。

```json
{
  "schemaVersion": 1,
  "blocks": [
    {"id": "UUID", "type": "text", "text": "最初の文章。\n"},
    {"id": "UUID", "type": "media", "mediaId": "MEDIA_UUID"},
    {"id": "UUID", "type": "text", "text": "画像の後の文章。"}
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

上のUUID等は説明用の記号であり、そのまま有効な実データではない。実際は型・長さを厳密に検証する。メディアの暗号化マニフェストは本文内で認証される。同期時はJSON全体を暗号化する。

空文書は空のtextブロック1個。許可するblock typeはtext/mediaのみ。通常の編集でIDを作り直さず、先頭・末尾・メディアの間で入力できる領域を確保する。隣接textの統合で空白・改行を消さない。`media`には現在の本文に必要な添付情報だけを保存する。

サーバー側の所有権確認・清掃のため、暗号文と別に `referencedMediaIds` の集合を送る。この参照関係は秘密にしない設計である。クライアントは復号後の本文とその集合の一致を確認する。不一致を勝手に正常化して再保存しない。

## 9. 自動保存・同期・競合

入力停止700msで保存し、連続入力でも最後の送信から5秒を目安に保存する。IME変換中は確定を待つ。同一文書の送信は直列化し、暗号化前のスナップショットと編集世代を保持する。遅い応答で後続の入力や未保存フラグを消さない。

前面操作中は5秒ごと、60秒無操作後は30秒ごとに条件付き取得する。非表示時は定期取得を止め、前面復帰・フォーカス復帰・オンライン復帰時に即座に取得する。ネイティブもバックグラウンドの常時実行を前提にしない。更新反映の目安は保存成功後に上記間隔＋通信時間であり、全状態で5秒以内とは保証しない。

ETagは `"d-<documentId>-e-<syncEpoch>-r<revision>"` とする。所有者、文書ID、世代、revisionを検証したIf-MatchによるCASでのみ保存し、成功時にrevisionを1増やす。`If-Match: *`、時刻ベースの無条件最終書込優先、クライアント指定所有者を許可しない。

mutationIdが最後に確定した更新と同じで、暗号文・参照集合等の更新ペイロードも同じなら二重更新せず成功を返す。同じmutationIdの異なる内容は409。別の更新が既に入った場合は通常のCAS判定に戻す。再試行のために無限の更新履歴を保存しない。

本文更新と参照集合の更新はD1の同一トランザクション内に入れる。参照対象の同一所有者・ready状態も確定時に検証する。CASが0行更新でもSQLエラーにならないため、後続の参照変更を成功したCASの条件でガードする。取得時も本文・参照集合を同一スナップショットとして読む。[S13]

競合は412とし、未保存内容を残して最新の暗号文を取得・復号する。自動連結、独自の推測マージ、サーバーによる平文マージは行わない。利用者が両方を見て編集し、最新ETagで再保存するか、確認後にローカル変更を破棄する。

「未保存の文字」「送信中スナップショット」「未完了のメディア挿入」「未適用の遠隔版」を別々に持つ。dirty=falseだけで画面全体を置き換えない。添付挿入中は遠隔版の適用を保留してよい。Undoは現在の編集セッション内だけで、遠隔版採用後の古いUndoが他端末の変更を消さないように再基準化する。

Webの別タブへの通知はBroadcastChannelで文書ID・revisionのみを流し、正本はAPIから取得する。鍵や平文を放送しない。ネイティブの複数ウィンドウは共通の同期Actorで同じ状態を管理する。

ローカルドラフトはアカウント・文書・端末/タブごとの最新1件とし、編集世代順に暗号化保存する。新しい退避を古い保存完了で削除しない。アカウントが切り替わったらキュー、ETag、選択、プレイヤー、鍵を分離し、旧セッション世代の応答を適用しない。

ネットワーク失敗は1/2/4秒の指数バックオフと乱数幅、最大30秒を基本とする。429のRetry-Afterを尊重する。401と復号失敗をネットワーク再送だけで無限に繰り返さない。終了時のイベントやsendBeaconだけに保存を依存させない。

ネイティブは解除可能な暗号化キャッシュがあればオフラインで開いて編集できる。Webの初版は開いているページのオフライン編集を対象とし、通信できない状態からの完全な初回起動は保証しない。オフライン・削除済み端末上のコピーを遠隔から必ず消せるとは説明しない。

## 10. E2EEメディアの保存・再生

### 10.1 容量と形式

| 項目 | 初期設計値 |
| --- | --- |
| 本文JSON（暗号化前、メタデータ込み） | UTF-8で1MiB以下 |
| 文書更新HTTPリクエスト | 2MiB以下 |
| 本文ブロック / メディア | 2,000 / 200以下 |
| 画像 / 音声 / 動画 | 20MiB / 100MiB / 512MiB以下 |
| 暗号化チャンク | 平文1MiB + GCMタグ16バイト |
| multipartの通常パート | 暗号化チャンク8個 = 8,388,736バイト |
| 同時転送 | 2ファイル。ファイル内のパートは原則逐次 |
| 利用者あたり保存容量 | 暗号文実容量で10GiB。未完了・削除待ちを含む |

E2EEではサーバーにファイル種別を明かさないため、種類別の20/100/512MiB上限とMIME/先頭データの検査はクライアント側の仕様とする。サーバーは全種別共通の最大暗号文サイズ・パートサイズ・予約容量を強制する。サーバーが暗号化前の形式を検証できると称さない。

画像JPEG/PNG/WebP/GIF/AVIF/HEIC/HEIF、動画MP4/WebM/MOV、音声MP3/M4A/AAC/WAV/Ogg/WebM/FLACを受付候補にし、SVG・HTML・PDF・実行ファイル等はUIで拒否する。保存できる形式と再生可能なコーデックは別であり、HEIC/MOV等の全環境再生は保証しない。

大容量の全文をWorkerへ読み込まない。D1のBLOB/行上限を踏まえて上記本文上限を守り、メディアをD1へ埋め込まない。[S14]

### 10.2 ランダムアクセスできる暗号化形式

メディアごとに新しい32バイトのfileKeyと8バイトのnoncePrefixを端末で生成する。平文を1MiBずつに分け、各チャンクを独立したAES-GCMで暗号化する。

```text
nonce(i) = noncePrefix8 || uint32_be(i)     // iは0から
AAD(i)   = Encode("media-chunk", formatVersion, accountId,
                  documentId, mediaId, i, totalPlainBytes, chunkPlainBytes)
C(i)     = AES-GCM(fileKey, nonce(i), P(i), AAD(i))
R2 object = C(0) || C(1) || ... || C(n-1)
```

全チャンク数・全平文サイズ・鍵・noncePrefixは暗号化本文のマニフェストで保護する。通常チャンクの暗号文サイズは1,048,592バイトで、i番目の開始位置は `i × 1,048,592`。最終チャンクだけ短くなり得る。空ファイルは拒否する。

各チャンクは認証タグの検証を完了してからデコーダーへ渡す。チャンク順序の入替・別ファイルへの差替・切詰めを検出する。変更された内容を同じfileKey・nonce・mediaIdで再暗号化しない。元ファイルを再選択する再開時は内容同一性を検証できなければ新しい鍵とIDでやり直す。

この配置により、動画の平文Rangeに必要な暗号文チャンクだけを取得し、復号して必要な部分を切り出せる。1MiBや8チャンクは設計値であり、OSの再生挙動とメモリー実測により、公開前なら形式バージョンと一緒に調整できる。

### 10.3 アップロードと清掃

ローカルで位置を確保し、開始APIにclientUploadIdと暗号文サイズを渡す。元ファイル名・MIME・fileKeyは渡さない。Workerは所有者と容量予約を原子的に確認し、D1の進行状態とR2 multipartを作る。

クライアントは8個の暗号化チャンクを1パートとして送信する。Workerは全体を保持せずストリームでR2へ送り、実受信サイズ・パート番号・ETag・暗号文ハッシュを記録する。再送は同じ番号・同じ暗号文とし、完了処理中の別内容への差替を拒否する。通常パートはR2の最小パート条件を満たし、最終パートのみ短くてよい。[S15]

完了APIはパート集合・サイズを検証してR2を完了し、D1をreadyにする。その後、クライアントが本文に暗号化マニフェストとメディア参照を入れて通常保存する。アップロード中の仮表示はサーバーの確定本文へ保存しない。

状態は `creating → uploading → completing → ready → deleting` とし、完了に期限付き処理権を設ける。D1とR2をまたぐ原子性は仮定しない。R2成功/D1失敗なら同じ完了APIで実体のサイズ等を照合して回復する。開始応答消失、パート再送、取消と完了の競合を試験する。

未完成・未参照添付には24時間の清掃猶予を設ける。参照削除後は新しい配信を認可せず、猶予後に原子的にdeletingへ確定してR2を削除する。deletingの再参照を本文保存で拒否し、現在参照中の実体を清掃しない。R2の未完了multipartにも回収用ライフサイクルを設定する。

### 10.4 Workerは暗号文のRangeだけを配信する

`GET/HEAD /api/v1/media/:id/cipher` は認証済み所有者の現在参照中・readyのオブジェクトだけを返す。常に暗号文で、`application/octet-stream` とする。単一Range、suffix Range、206、416、Content-Range、Content-Length、Accept-Ranges、If-Rangeを正しく扱う。公開R2 URLやr2.devを使わない。

メディア取得権限はランダムなIDを知っていることではなく、セッション・文書所有権・現在の参照で確認する。暗号鍵やトークンをURLに入れない。

### 10.5 Web: 復号ストリームを標準プレイヤーへ渡す

小さな画像は必要時に端末で復号し、Object URLで表示する。動画・音声の大きなファイルを全体Blob化してから再生する方式を標準にしない。

Webの第一候補は、Service Workerが `/_local/media/:id` を処理するローカル仮想URLである。video/audioのRange要求を受け、認可付きAPIから必要な暗号文チャンクをfetchし、端末内で認証・復号したResponseを返す。サーバーにその仮想URLの平文配信処理は作らない。[S16]

Service Workerへ鍵を渡す場合は、制御中の正しいクライアントとMessageChannelで結び付け、セッション世代・document ID・解除状態を確認する。鍵はメモリーにのみ保持する。Service Workerが停止・再起動したら、解除済みクライアントとの再ハンドシェイクが必要である。ロック後の要求を古い鍵で処理し続けない。

Service Workerのインストール・制御開始前は仮想URLで再生を始めない。鍵、復号Response、Blobの平文をCache StorageやHTTPキャッシュへ永続保存しない。ブラウザー/OSによる一時処理まで完全にディスク不使用とは保証しない。

このService WorkerはE2EEメディア配信のための例外的な追加であり、PWA化・通知・バックグラウンド同期を追加するものではない。iPhone Safariを含むRange、停止/復帰、初回制御、鍵再取得、メモリー使用量の実測を公開条件にする。FetchEvent APIの存在だけで動画再生互換性が確認できたとはしない。

不対応環境では、小容量に限った全体復号へのフォールバック、対応クライアントの案内、実装可能な復号後ダウンロードを提供する。大容量を黙って全メモリー復号したり、サーバー復号へ戻したりしない。大容量再生を主要対応環境で実証できない間は、その環境の動画対応を完成扱いにしない。

### 10.6 ネイティブ: AVFoundationへ復号データを供給する

AVPlayer/AVPlayerViewController等の標準操作を使う。AVAssetResourceLoaderDelegateと専用URLスキーム等で要求範囲を受け、同じチャンク形式をURLSessionとCryptoKitで取得・復号して渡す構成を第一候補とする。[S17]

必要範囲だけを保持する上限付きキャッシュと取消処理を設け、512MiBを一括Data化しない。TextKit側の再レイアウトでプレイヤーやローディング状態を破棄しない。AVFoundationの実際の要求パターン、コンテンツ情報、コーデック、シーク、アプリ非アクティブ化を試験する。

## 11. D1データモデルとHTTP契約

### 11.1 テーブルの責務

| テーブル | 主な項目と制約 |
| --- | --- |
| accounts | id、unique user_handle、ランダム表示ラベル、pending/active/deleting、created_at、auth_epoch |
| credentials | globally unique credential_id、account_id、公開鍵、counter、transports、backupフラグ、状態、時刻。PRF秘密出力は持たない |
| key_envelopes | credential_id、account_id、format_version、key_version、wrap_salt、nonce、wrapped_key。資格情報と所有者を一致させる |
| recovery | account_idごとに現行1件、recovery_version、auth_hash、nonce、wrapped_key。seedは持たない |
| challenges | ランダムID、challenge hash、用途、account_id、client_kind、期限、消費状態 |
| sessions | token_hash、account_id、client_kind、auth_epoch、権限scope、期限、最終利用、stepup時刻 |
| documents | id、unique account_id、sync_epoch、revision、format_version、mutation_id、nonce、ciphertext BLOB、last_payload_hash、updated_at |
| media | id、document_id、object_key、client_upload_id、cipher_bytes、状態、upload_id、期限・lease・未参照時刻 |
| document_media | document_id/media_idの複合主キー。同じ文書に所属するmediaだけを参照 |
| upload_parts | media_id/part_numberの複合主キー、ETag、暗号文サイズ、暗号文ハッシュ |
| operations | bootstrap・復旧・削除等の期限付き冪等性/回復状態。本文履歴には使わない |

主キー・外部キー・所有者とcredentialの対応・clientUploadIdの文書内一意性・revision非負・nonce長・容量正数をマイグレーションで制約化する。容量予約は同時開始でも上限を超えない条件付き挿入とする。認証セッションから解決した所有者を常に使い、クライアントのaccountIdだけを信用しない。

D1は初版ではプライマリーの読み書きを使い、古いread replicaの読み取りによる競合判定を導入しない。大量の参照IDをバインドへ展開して上限を超えず、JSON関数等で集合を同一トランザクションに扱う。公開鍵、ハッシュ、暗号文、nonceのサイズ検証とインデックスは実装マイグレーションで固定する。[S13][S14]

### 11.2 API一覧

すべて `/api/v1` 配下。Webは相対URL、ネイティブは固定のHTTPS Originを使う。

| メソッド・パス | 用途 |
| --- | --- |
| POST /auth/register/options・/verify | pending登録・WebAuthn資格情報の検証 |
| POST /auth/login/options・/verify | パスキー認証・セッション発行 |
| POST /auth/stepup/options・/verify | セキュリティ操作の再認証 |
| GET /session | 現在のアカウント・権限・セッション状態 |
| DELETE /session | 当該セッション失効 |
| POST /bootstrap | 暗号化空文書・鍵ラップ・復旧情報の初期確定 |
| GET /keys | 認可された資格情報用のラップ済み鍵と公開パラメーター |
| POST /credentials/options・/verify・/activate | 新規パスキー追加。署名確認とラップ保存を経て有効化 |
| GET /credentials | 自分のパスキーの管理情報 |
| DELETE /credentials/:id | 再認証後に失効。最後の利用可能なパスキーを不用意に消さない |
| POST /recovery/start・/complete | 復旧認証・制限付き再設定の確定 |
| PUT /recovery | 解除・再認証済み利用者による復旧キー更新 |
| GET /document | 暗号文・現在ETag・参照集合を取得 |
| PUT /document | If-Match付き暗号文更新 |
| POST /media/uploads | 容量予約・multipart開始 |
| GET /media/uploads/:id | 進行状態・受理済みパートを取得 |
| PUT /media/uploads/:id/parts/:partNumber | 暗号化されたパートの送信 |
| POST /media/uploads/:id/complete | 完了とready確定 |
| DELETE /media/uploads/:id | 未確定アップロード取消 |
| GET/HEAD /media/:id/cipher | 参照中メディアの暗号文Range配信 |
| GET /sessions・DELETE /sessions/:id | 自分のセッション確認・終了 |
| DELETE /account | 再認証・確認済みのアカウント削除 |

公開パラメーター取得を含め、credential IDを知るだけで他アカウントのラップ済み鍵を取得させない。復旧セッションは復旧に必要なエンドポイントだけを許可する。未認証・未確定・削除中アカウントの状態を使った所有権迂回を防ぐ。

文書更新例:

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
  "nonce": "BASE64URL_12_BYTES",
  "ciphertext": "BASE64URL_CIPHERTEXT_AND_TAG",
  "referencedMediaIds": ["MEDIA_UUID"]
}
```

成功時は新しいETag・revision・mutationIdを返す。本文平文、元ファイル名、fileKeyを外側へ添付しない。GETは同じ暗号形式と参照集合を返し、If-None-Match一致時は304とする。GETで暗号化空文書をサーバーが自動生成しない。

エラーは `{"error":{"code":"...","message":"..."}}`。主要コードは400形式不正、401認証必要、403権限不足、404非存在/他所有者、409冪等性違反・状態競合、412revision不一致、413容量超過、416Range不正、422参照等不整合、428If-Match不足、429制限、500/503障害。PRF未対応・復号失敗は主にクライアント状態であり、サーバーに秘密を送って原因分析しない。

## 12. Webとネイティブを同じパスキーへ結び付ける

RP IDを `txt.2-38.com` で共通化し、ネイティブに `webcredentials:txt.2-38.com` のAssociated Domains entitlementを設定する。ドメイン側にApple App Site Associationファイルを置く。[S6]

```json
{
  "webcredentials": {
    "apps": [
      "<TEAM_ID>.<IOS_BUNDLE_ID>",
      "<TEAM_ID>.<MACOS_BUNDLE_ID>"
    ]
  }
}
```

`/.well-known/apple-app-site-association` はHTTPSで未認証取得可能、JSON、リダイレクトなしとする。Team IDとBundle IDは実際の署名・登録値を確認する。上のプレースホルダーを実値と称しない。AASAの配信だけでPRF相互運用が検証済みになるわけではない。

iOS 18以降・macOS 15以降を初期の最低対応候補とするが、採用APIのavailabilityと実機試験で最終決定する。最新安定SDKでビルドし、ベータ限定APIを基本機能へ使わない。新しいOSの外観は標準コンポーネント経由で取り込む。

Webの公開前に、薄いSwiftの検証クライアントで、Web作成パスキーの認証・同じPRF入力・VaultKeyの解除・本文復号を試す。iOS/Macの製品版を後で作る方針と、この先行検証は両立する。

## 13. 公開・運用・安全性

Workersのカスタムドメインを `txt.2-38.com` とし、HTML・静的ファイル・Service Worker・APIを同一Originで配信する。R2公開URLを作らない。`workers.dev` とプレビューの本番到達経路は無効にし、本番RPの別ホスト利用を許可しない。

旧Access設定がホストやワイルドカードを保護している場合、txtに必要な範囲だけを見直す。他の `2-38.com` アプリの保護を外さない。公開シェル、認証開始、AASA、プライバシー、サポートは未認証で到達可能にし、文書・メディア・鍵ラップAPIはアプリのセッション認証を要求する。既存のCloudflare実設定の変更は、本書を保存しただけでは完了しない。

CSPはself中心とし、外部解析タグ、外部CDNスクリプト、eval、任意インラインスクリプトを使わない。script-src/connect-src/worker-srcはself、object-srcはnone、base-uri/frame-ancestorsはnoneを基本とし、メディア用blobは必要範囲のみ許可する。`nosniff`、`Referrer-Policy: no-referrer` を付ける。

API・暗号文・解除後のメディア応答は `private, no-store` を基本とする。公開ハッシュ付き静的資産だけを安全に長期キャッシュする。Service Worker本体は更新を妨げないキャッシュ方針とし、新旧クライアントで鍵/文書形式が混在しても未知形式を上書きしない。

ログに本文、元ファイル名、鍵、復旧トークン、Cookie、Bearer、WebAuthn応答ボディを残さない。エラー監視へのDOM添付・セッションリプレイは使わない。IP等の濫用対策情報は必要最小限の短期保持とし、保持内容をプライバシー説明へ反映する。

公開登録にはアカウント単位・ネットワーク単位のレート制限、認証失敗制限、アップロード予約、全体容量/課金アラート、登録停止スイッチを設ける。メールなし登録では1人1アカウントを保証できないため、10GiBを無制限人数に開放したときの費用を無視しない。課金モデルが未決定でも全体の運用上限を公開前に決める。

D1/R2のバックアップには暗号文・鍵ラップ・公開パラメーターを含めるが、クライアントの秘密鍵を運用バックアップへ混ぜない。復旧演習では利用者側のテスト用パスキー/復旧キーも別途用意する。D1を過去へ戻す場合はsyncEpochを変更してクライアントを再照合し、古い未保存内容を自動送信しない。

アプリの履歴を持たないことと、CloudflareのTime Travel等の復旧保持や端末上のコピーが存在しないことは別である。バックアップ保持・削除の実態を確認し、即時完全消去と誤説明しない。[S18]

## 14. 個人名義でのApp Store公開

本アプリは個人のApple Developer Programアカウントで公開する前提とする。法人化や新たな企業用認証基盤をアーキテクチャの必要条件にしない。個人登録ではApp Store上に開発者の法的な氏名が表示される点を、利用者のメールを取得しない設計と混同しない。[S19]

このパスキー方式は自社のアカウント認証であり、1PasswordやAppleのパスワードを選ぶことは外部ソーシャルアカウントのログインとは異なる。Sign in with Appleをこの理由だけで追加しない。公開時は実際のログイン構成をApp Review Guidelines 4.8に照らして確認する。[S20]

アカウントを作成するため、アプリ内にアカウント削除を設ける。再認証と明確な確認後、すべてのセッション・資格情報を失効し、本文・添付・ラップ済み鍵・復旧情報を削除処理へ進める。単なるログアウト/非表示で代用しない。メール送信やサポートへの連絡を削除の必須条件にしない。[S21]

削除開始後はactive APIを拒否する。物理削除の再試行用に必要な最小限の処理状態を残し、実際の削除期間とバックアップの扱いを表示する。削除済みアカウントの暗号文がバックアップから復元されても、通常運用へ復活させない手順を設ける。保存先のパスキーマネージャー内の項目が自動消去されるとは約束しない。

`/privacy` と `/support` を公開し、App Storeの申告・プライバシーポリシーを実装に合わせる。暗号化していても収集データの申告が自動的に不要になるとは判断しない。不要な追跡SDK・広告ID・連絡先・全写真権限を導入しない。[S22]

暗号利用に関する輸出コンプライアンスはAppleの質問票と実装内容で判定する。AESやOS標準APIを使うという理由だけで `ITSAppUsesNonExemptEncryption=false` と決め打ちしない。必要な資料・配信地域の条件は提出時に確認する。[S23]

審査者が通常の新規パスキー登録から試せる手順と、復旧キー保存・添付の説明をApp Review Notesへ記載する。審査用の本番認証バイパスや共通マスター鍵を作らない。審査通過、ストア名の利用可能性、全地域での公開可否を本書で保証しない。

## 15. 実装構成と進め方

```text
spec.md                         # 本書。要件・UI・プロトコルの統合仕様
apps/
  web/                          # HTML/CSS/JS、最小ProseMirror、WebAuthn、media SW
  worker/                       # Hono、認証検証、D1、R2、清掃
  apple/                        # 後続のiOS/macOS Xcodeプロジェクト
packages/
  protocol/                     # JSON schema、暗号形式、Web/Swift共通テストベクトル
  TxtCore/                      # Swift Package: モデル、CryptoKit、API、同期Actor
migrations/
tests/
wrangler.jsonc
```

WebのエディターはProseMirrorのmodel/state/viewと必要なキー操作・Undoのみを選ぶ。marksを空にし、許可ノードを制限する。編集エンジンのデータ形式はadapterで共通JSONへ変換する。ネイティブも同様に、表示属性や添付ビューを保存モデルへ混ぜない。[S24]

依存ゼロやgzip 40KiBを絶対条件にせず、同じ機能を持つ本番ビルドのサイズ・入力遅延・初期表示を測る。重いフロントエンドフレームワーク、ORM、CRDT、Durable Objects、動画変換サービスを、今回のためだけに先回りして追加しない。

1. 技術検証: Web/Swift/1Password/AppleのPRFと解除互換、暗号形式テスト、E2EE動画Rangeの実機試験。
2. Web基礎: パスキー登録・復旧・セッション・暗号化本文・CAS同期・日本語編集。
3. Web完成: メディア、暗号化ローカル退避、競合/清掃/障害試験、公開前セキュリティレビュー。
4. ネイティブ: TxtCore、iOS・Macの標準編集UI、オフラインキャッシュ、AVFoundation、App Store準備。

## 16. 公開前の受け入れ条件

### 認証・鍵・復旧

- [ ] メール・電話・通常パスワードを入力せずに作成・ログインできる。
- [ ] Webで作成した対応パスキーからSwiftで同じVaultKeyを解除でき、逆方向も試験する。
- [ ] Safari/Chromium系・1Password拡張・Appleのパスワード・iOS/macOSネイティブの組み合わせを実機で記録する。
- [ ] PRF未対応・取消・追加assertion・途中終了を扱い、読めないactive文書を作らない。
- [ ] API/ログ/監視にPRF出力、KEK、VaultKey、fileKey、RecoverySeedが出ない。
- [ ] 新しいパスキー追加後に旧パスキーを失効しても、同じ本文・添付を開ける。
- [ ] 全パスキーを失った想定でも、復旧キーだけから認証と内容の両方を復旧できる。
- [ ] 復旧途中の応答消失・再送で旧入口を先に失わず、完了後は旧トークンが失効する。
- [ ] 解除失敗時にサーバー復号・公開値由来の鍵・空本文上書きへ切り替えない。

### 編集・同期

- [ ] 起動後はタイトルや文書一覧なしに1枚を使える。
- [ ] IME、絵文字、LF、空白、タブ、メディアをまたぐ選択・削除・Undoが各クライアントで一致する。
- [ ] ProseMirrorとTextKitの相互変換で、末尾改行や空ブロックが増減しない。
- [ ] 通信中の追加入力、古い応答、別ユーザーへの切替で本文を失わない。
- [ ] 5秒/30秒/非表示停止の同期動作と表示上の約束が一致する。
- [ ] 同じETagから2端末が保存すると一方が競合し、双方の内容を確認できる。
- [ ] 添付の逆順完了・挿入取消・転送中の遠隔更新でも位置と取消状態を保つ。
- [ ] OSの終了・通信停止・容量不足を注入し、保存できていないものを同期済みと表示しない。

### メディア・バックエンド

- [ ] 512MiBの動画を端末/Workerへ丸ごと載せず、先頭・中間・末尾から再生できる。
- [ ] 暗号文の改変・順序変更・切詰めを、未検証平文をデコーダーへ渡す前に拒否する。
- [ ] Web Service Workerの初回制御・再起動・ロック後の再要求・復帰を試験する。
- [ ] ネイティブのresource loaderの取消・並行要求・不正Range・メモリー上限を試験する。
- [ ] R2成功/D1失敗、同一パート再送、完了と取消、参照と清掃の競合から回復する。
- [ ] D1/R2の取得結果だけで本文・ファイル名・メディアを復号できない。
- [ ] 他アカウントのID、未参照メディア、未完成アップロードへアクセスできない。
- [ ] 削除・バックアップ復元後にアカウントが勝手に再有効化されない。

### UI・公開

- [ ] iOS/Macは標準toolbar・picker・menu・sheet・再生操作を利用し、WebView主体ではない。
- [ ] ライト/ダーク、文字拡大、VoiceOver、キーボード、透明度低減を確認する。
- [ ] AASAが未認証で取得でき、実際の署名済みiOS/Macアプリが同じRPを利用できる。
- [ ] アカウント削除、復旧キーの注意、プライバシー、サポートへ到達できる。
- [ ] 個人名義の表示、App Privacy、暗号輸出、審査手順を実装と整合させる。

## 17. 対象外と未検証事項

複数文書、タイトル、フォルダー、公開共有、他人との共同編集カーソル、履歴一覧、ごみ箱、Markdown表示、装飾、AI、文字起こし、録音/録画、サーバー側動画変換、広告、通知、バックグラウンドの常時同期は追加しない。

本書は設計までを対象とする。CloudflareのDNS・Access・D1・R2設定、Apple Team ID/Bundle ID、App Store申請、実際のパスキー作成、実機UI、暗号実装、バンドル容量、費用、動画互換性は本書の保存によって設定・検証されたものではない。

## 18. 参照した一次資料

確認日: 2026-09-20。仕様上の採用判断と、各資料が説明するAPI/規則を区別する。OS・ライブラリーの最低バージョンと互換性は実装時にも再確認する。

- [S1] W3C WebAuthn Level 3（PRF、発見可能な資格情報、検証手順）: `https://www.w3.org/TR/webauthn-3/`
- [S2] SimpleWebAuthn server: `https://simplewebauthn.dev/docs/packages/server`
- [S3] Apple PRF assertion input: `https://developer.apple.com/documentation/authenticationservices/asauthorizationpublickeycredentialprfassertioninput-swift.struct`
- [S4] 1Password iOS 8.10.74 release notes（2025-04-29、iOS 18向けPRF追加）: `https://releases.1password.com/ios/stable/8.10.74/`
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
- [S19] Apple Program enrollment（個人名義）: `https://developer.apple.com/help/account/membership/program-enrollment/`
- [S20] Apple App Review Guidelines §4.8・§5.1: `https://developer.apple.com/app-store/review/guidelines/`
- [S21] Apple Offering account deletion in your app: `https://developer.apple.com/support/offering-account-deletion-in-your-app/`
- [S22] Apple App privacy details: `https://developer.apple.com/app-store/app-privacy-details/`
- [S23] Apple Overview of export compliance: `https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance/`
- [S24] ProseMirror schema guide source: `https://raw.githubusercontent.com/ProseMirror/website/master/markdown/guide/schema.md`
