# txt

`https://txt.2-38.com/` — メールアドレスなしで、パスキーで暗号化された1枚のテキストを読み書きできるアプリ。

仕様は [`spec.md`](./spec.md) が実装基準です（仕様版 1.0）。このリポジトリはそのうち **Web版とサーバー（Worker）** を実装しています。

## 構成

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
packages/
  protocol/     # Encode、HKDF/AES-GCM 契約、鍵導出、共通文書モデル、テストベクトル
migrations/     # D1 スキーマ
tests/
  protocol/     # 暗号契約の既知入力/期待出力
  editor/       # 文書モデルとメディア挿入の規則
  worker/       # Worker 統合テスト（実際の D1/R2 バインディング）
  e2e/          # 実ブラウザー E2E（CDP 仮想認証器 + PRF）
config/         # ローカル開発用 wrangler 設定
scripts/        # dev サーバー起動、本番スモーク
```

## セットアップ

```bash
npm install

# ローカル開発（ビルド → D1 マイグレーション → wrangler dev）
npm run dev            # http://localhost:8799

# 検証
npm run check          # typecheck + protocol/editor テスト + Worker テスト
npm run test:e2e       # 実ブラウザー E2E（dev サーバーが動いていること）

# 本番
npm run deploy
bash scripts/smoke-prod.sh
```

`npm run dev` がビルドとサーバー起動をまとめて行うのは、`wrangler dev` がアセットマニフェストを起動時に固定するためです。ビルドだけを先に走らせてサーバーを再起動すると、ハッシュ付きファイル名の不整合（`/` が 500）を避けられます。

## 実装済みの範囲（spec §16 のフェーズ1〜3に相当）

- **先行検証**: 日本語IME（composition 状態機械）、メディア、Undo、PRF/暗号形式、チャンク暗号文の Range 配信
- **Web基礎**: 登録・復旧・セッション、暗号化本文、共通モデル、CAS、暗号化退避（IndexedDB）
- **Web完成**: 添付、競合、清掃、セキュリティ、公開設定

### 動作を確認できる範囲

- パスキー登録（residentKey required / UV required / attestation none）+ PRF 実出力
- VaultKey のラップ/解除、復旧キー（`TXT1.` 形式）の生成・検証
- 暗号化文書の ETag 条件付き保存、同一 mutationId の冪等再送、412/409/422 の区別
- チャンク単位の暗号化添付、`Range`/`HEAD`/`206`/`416` の配信、参照中のみ配信
- IME composition 中は確定済みスナップショットのみ同期
- 未参照メディアの 24 時間猶予後の清掃、未完了 multipart の清掃

## 未実装・未検証（正直な範囲）

- **ネイティブ iOS/macOS（spec §16 フェーズ4）**: `apps/apple/` と `packages/TxtCore/` は未着手。この環境（Linux）には Xcode/Swift がないため、実装も実機検証も行っていません。`spec.md` §13 の Web/Swift 相互運用試験、§4.3/§4.4 の TextKit 編集面、§11.7 の AVAssetResourceLoader は未実施です。
- **AASA（§13）**: `TxtTeamId` / `TxtIosBundleId` / `TxtMacosBundleId` に実値が入るまで `/.well-known/apple-app-site-association` は 404 を返します（プレースホルダーは公開しない方針）。Team ID / Bundle ID の確認は未完了です。
- **実IMEでの手動試験（§17.1/§17.2）**: 自動テストは composition イベント順序と状態機械を検証していますが、macOS/Windows/iOS の実IME、フリック入力、ライブ変換は実機で未確認です。
- **512MiB 動画の実機シーク（§17.5）**: チャンク暗号化と Range 配信は検証済みですが、大容量実ファイルでの実機再生は未実施です。
- **独立したセキュリティレビュー（§6.3）**: 未実施。暗号コンテナーはアプリ固有の設計であり、監査済み標準形式ではありません。
- **本番アカウントでの手動パスキー試験**: 自動E2Eは Chromium の仮想認証器で検証しています。実パスキー（1Password / Apple パスワード等）での相互運用は未確認です。

## セキュリティ上の注意

- サーバーは平文本文・ファイル名・MIME・PRF 出力・VaultKey・fileKey を受け取りません。
- `toJSON()` は送信に使いません（PRF results の漏洩防止）。署名検証に必要なフィールドだけの DTO を組み立てます。
- 平文や鍵を `localStorage` / `sessionStorage` に置きません（IndexedDB には暗号化済みドラフトのみ）。
- API・暗号文・復号後の応答は `private, no-store`。ハッシュ付き静的資産のみ長期キャッシュします。

## ライセンス

未定（個人プロジェクト）。
