[English](./README.md) · **日本語**

<p align="center">
  <img src="./apps/web/static/og.png" width="640" alt="txt — メールアドレスなしで、1枚のテキストを。">
</p>

<h1 align="center">txt</h1>

<p align="center">
  メールアドレスなしで、1枚のテキストを。パスキーで開いて、端末で暗号化されるメモです。
</p>

<p align="center">
  <a href="https://txt.2-38.com"><img src="https://img.shields.io/badge/website-txt.2--38.com-black" alt="Website"></a>
  <img src="https://img.shields.io/badge/spec-1.4-blue" alt="Spec 1.4">
  <img src="https://img.shields.io/badge/auth-passkey%20only-green" alt="Passkey only">
  <img src="https://img.shields.io/badge/encryption-E2EE-brightgreen" alt="E2EE">
</p>

**txt** は [txt.2-38.com](https://txt.2-38.com) の1枚だけのメモです。タイトルも一覧もありません。開けばすぐ書けて、本文と添付（写真・動画・音声）は端末のブラウザーで暗号化されてから送られるため、サーバーには暗号文しか保存されません。

仕様は [`spec.md`](./spec.md) が実装基準です（仕様版 1.4、Web-only）。このリポジトリは **Webとサーバー（Worker）のみ** を実装します。デスクトップ・スマートフォンのブラウザーから利用でき、ネイティブアプリの導入は不要です。開発ルールは [`AGENTS.md`](./AGENTS.md) を参照してください。

## ✨ 特長

- 📄 **1枚だけ** — アカウントごとに文書は1枚。自動で保存・同期され、タイトルやフォルダの管理が要らない
- 🔑 **パスキーのみ** — メールアドレス・電話番号・パスワードを要求しない。発見可能なパスキー（指紋・顔・端末のロック解除）で開く
- 🔐 **エンドツーエンド暗号化** — パスキーの PRF 出力から導いた KEK でランダムな VaultKey を包む。サーバーは平文・ファイル名・MIME・PRF 出力・鍵を受け取らない
- 🖼️ **暗号化添付** — 写真・動画・音声をファイルごとにチャンク暗号化し、Range 配信で読み戻す
- 🌐 **日本語／英語UI** — 初回はブラウザー言語で自動判定し、「その他」メニューからいつでも切り替え可能。選択は端末に保存される
- 🤖 **AIエージェント接続** — 自分のAIエージェントが、暗号化を弱めることなくローカルMCPサーバー経由で読み書きできる（後述）
- 📱 **レスポンシブ** — モバイルブラウザー、Apple端末のWebAuthn/PRF、暗号化メディアService Workerに対応

## 🔐 暗号化の仕組み

| 層 | 内容 |
| --- | --- |
| パスキー（WebAuthn + PRF） | PRF 出力は端末の外に出ない |
| 鍵暗号化鍵（KEK） | PRF 出力から HKDF で導出 |
| VaultKey | ランダムな32バイト鍵。サーバーには KEK で包んだ形でのみ置かれる |
| 本文・メディア | クライアント側で AES-GCM 暗号化。サーバーは D1 / 非公開 R2 に暗号文を保存 |
| 復旧キー | 登録時に一度だけ表示される `TXT1.` 形式の鍵。パスキーを全て失くしたときの唯一の戻り道 |

セッションは Cookie のみ。保存は ETag の CAS と mutationId で行い、2台の端末が黙って上書きし合うことはありません。競合は表示され、利用者が決めます。

> [!NOTE]
> サーバーは平文を検証できません。内容の検証はすべてクライアント側で行い、サーバーはそれを信用しない前提で書かれています。

## 🤖 AIエージェント接続

**自分のAIエージェント**（Muse等）に、この1枚を扱わせることができます。

- 🔒 **E2EEは維持されます** — 復号は自分のマシン上で動く小さなMCPサーバーのメモリー内だけで行われ、サーバー側に見えるのは従来どおり暗号文だけです。
- 🧑 **管理は利用者の手に** — エージェント追加にはパスキー、ペアリングコード（10分失効）、フィンガープリント照合、トークン権限の選択（読み取りのみ／読み書き）が必要です。トークンは30日で失効し、「その他 → エージェント」からいつでも失効できます。
- ✍️ **書き込みは保守的** — 既定は追記。置換とロールバックは承認制で、競合時はマージや上書きをせず差分を利用者に見せる決まりです。

**手順書はAIに渡してください。** 接続手順はAIエージェント宛てに書かれ、安定URLで配信されています。

| 言語 | 手順書 |
| --- | --- |
| 日本語 | https://txt.2-38.com/agents.ja.md |
| English | https://txt.2-38.com/agents.md |

正本は [`skills/txt-agent/`](./skills/txt-agent/)（[`/llms.txt`](https://txt.2-38.com/llms.txt) の元でもあります）。実装の詳細は [`apps/agent-mcp/README.md`](./apps/agent-mcp/README.md) を参照してください。

## 🧱 構成

| 領域 | 実装 |
| --- | --- |
| ホスト / WebAuthn RP ID | `txt.2-38.com` |
| サーバー | Cloudflare Workers + Hono |
| データ | D1（認証情報・暗号文・同期状態）、非公開 R2（暗号化添付） |
| ログイン | メール・電話・パスワードを要求しない発見可能なパスキー |
| 暗号化 | PRF 由来の KEK で包んだ VaultKey によるクライアント側 E2EE |
| Web | HTML/CSS/JavaScript + 最小限の ProseMirror |
| 保存・同期 | 条件付き HTTP 更新（ETag）/ 短周期ポーリング / BroadcastChannel 補助 |

```
apps/
  web/          # エディター、WebAuthn/PRF、暗号ワーカー、メディア Service Worker、同期
  worker/       # Hono ルーティング、認証、D1、R2、清掃、セキュリティヘッダ
  agent-mcp/    # AIエージェントとメモをつなぐローカルMCPサーバー（端末側で復号）
packages/
  protocol/     # Encode、HKDF/AES-GCM 契約、鍵導出、共通文書モデル、テストベクトル
migrations/     # D1 スキーマ
skills/         # エージェント向けスキル文書（txt-agent 接続手順、llms.txt）
tests/
  protocol/     # 暗号契約の既知入力/期待出力
  editor/       # 文書モデルとメディア挿入の規則
  worker/       # Worker 統合テスト（実際の D1/R2 バインディング）
  e2e/          # 実ブラウザー E2E（CDP 仮想認証器 + PRF）
config/         # ローカル開発用 wrangler 設定
scripts/        # dev サーバー起動、本番スモーク
```

## 🚀 セットアップ

```bash
npm ci

# ローカル開発（ビルド → D1 マイグレーション → wrangler dev）
npm run dev            # http://localhost:8799

# 検証
npm run check          # typecheck + protocol/editor/Web/security テスト + Worker テスト
npm run build          # Webをビルド
npm run test:e2e       # 実ブラウザー E2E（dev サーバーが動いていること）

# 本番
npm run deploy
bash scripts/smoke-prod.sh
```

> [!TIP]
> `npm run dev` がビルドとサーバー起動をまとめて行うのは、`wrangler dev` がアセットマニフェストを起動時に固定するためです。ビルドだけを先に走らせてサーバーを再起動すると、ハッシュ付きファイル名の不整合（`/` が 500）を避けられます。

## ✅ 実装済みの範囲と、正直な未検証

実装済み（spec §16 のフェーズ1〜3、および 1.4 のエージェント接続と多言語対応）:

- **先行検証**: 日本語IME（composition 状態機械）、メディア、Undo、PRF/暗号形式、チャンク暗号文の Range 配信
- **Web基礎**: 登録・復旧・セッション、暗号化本文、共通モデル、CAS、暗号化退避（IndexedDB）
- **Web完成**: 添付、競合、清掃、セキュリティ、公開設定
- **ブラウザー対応**: モバイルのレスポンシブUI、Apple端末のWebAuthn/PRF、暗号化メディアService Worker、Apple-touch iconを維持。対応状況はブラウザー・OS・パスキー保存先の組で確認する
- **オンボーディングと外観（spec §4.1/§4.2/§4.6）**: 「はじめて使う」からの4枚の紹介、登録直後の一度だけの案内、空欄の案内、「活字」基調の外観、広い画面での中央の本文列（最大720px）、編集面を動かさないアニメーションと `prefers-reduced-motion` 対応
- **シェアと検索（spec §4.6/§14）**: OGP・`summary_large_image` のシェアカード（`npm run brand:images` で画像を生成）、検索掲載の許可と `robots.txt`、「その他」→「txt を紹介する」（アプリのURLだけを共有）
- **AIエージェント接続**: エージェントごとの鍵ラップ（P-256 ECDH）、権限付き30日トークン、追記優先・置換/ロールバック承認制の書き込み（設計: [`docs/agent-access-design.md`](./docs/agent-access-design.md)）
- **多言語対応**: ブラウザー言語の自動判定と手動切替による日本語／英語UI（spec §4.7）

動作を確認できる範囲:

- パスキー登録（residentKey required / UV required / attestation none）+ PRF 実出力
- VaultKey のラップ/解除、復旧キー（`TXT1.` 形式）の生成・検証
- 暗号化文書の ETag 条件付き保存、同一 mutationId の冪等再送、412/409/422 の区別
- チャンク単位の暗号化添付、`Range`/`HEAD`/`206`/`416` の配信、参照中のみ配信
- IME composition 中は確定済みスナップショットのみ同期
- 未参照メディアの 24 時間猶予後の清掃、未完了 multipart の清掃

未実装・未検証（正直な範囲）:

- **実IMEでの手動試験（§17.1/§17.2）**: 自動テストは composition イベント順序と状態機械を検証していますが、macOS/Windows/iOS の実IME、フリック入力、ライブ変換は実機で未確認です。
- **512MiB 動画の実機シーク（§17.5）**: チャンク暗号化と Range 配信は検証済みですが、大容量実ファイルでの実機再生は未実施です。
- **独立したセキュリティレビュー（§6.3）**: 未実施。暗号コンテナーはアプリ固有の設計であり、監査済み標準形式ではありません。
- **本番アカウントでの手動パスキー試験**: 自動E2Eは Chromium の仮想認証器で検証しています。実パスキー（1Password / Apple パスワード等）での相互運用は未確認です。

## ⚠️ セキュリティ上の注意

- サーバーは平文本文・ファイル名・MIME・PRF 出力・VaultKey・fileKey を受け取りません。
- `toJSON()` は送信に使いません（PRF results の漏洩防止）。署名検証に必要なフィールドだけの DTO を組み立てます。
- 平文や鍵を `localStorage` / `sessionStorage` に置きません（IndexedDB には暗号化済みドラフトのみ。UI言語の選択は、内容ではない設定として唯一 `localStorage` に置きます）。
- API・暗号文・復号後の応答は `private, no-store`。ハッシュ付き静的資産のみ長期キャッシュします。

## 📄 ライセンス

未定（個人プロジェクト）。
