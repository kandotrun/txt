# txt 開発ルール

## 適用範囲

`spec.md` が実装基準（仕様版 1.0）。本書はその実装リポジトリ全体に適用する。

## 非交渉ルール

- `spec.md` の「必須」「禁止」「受け入れ条件」は実装上の契約。変更する場合は spec を先に更新する。
- 秘密情報（鍵、トークン、実アカウントのデータ）を commit しない。`.dev.vars` は Git 管理外。
- 平文本文・ファイル名・MIME・PRF 出力・VaultKey・fileKey をサーバーへ送らない。
- `toJSON()` や `getClientExtensionResults()` をそのまま送信しない（PRF results の漏洩防止）。
- 平文や鍵を localStorage / sessionStorage に置かない（IndexedDB は暗号化済みドラフトのみ）。
- 実パスキー・実アカウントを使う手動試験は本番で行う前に Kan へ確認する。

## 実装方針

- 依存は固定する。ProseMirror 等を更新するときは IME / 選択 / Undo の回帰試験を行う。
- 暗号契約（`packages/protocol`）は Web と将来の Swift 実装が共有する。バイト列を変える変更は
  テストベクトルと `spec.md` §6.3 を同時に更新する。
- サーバーは平文を検証できない前提で書く。クライアント側の検証と件数制限を信用しない。
- D1 の 0 行 UPDATE は例外ではない。CAS 後の文は「CAS が成功した」ことを SQL でガードする。
- R2 と D1 の分散トランザクションを仮定しない。復旧経路（実体サイズ照合など）を必ず書く。
- 構造の正規化は IME 安全点でのみ行う。入力中に DOM や textStorage を触らない。

## 検証

```bash
npm run check            # typecheck + protocol/editor テスト + Worker テスト
npm run test:e2e         # 実ブラウザー E2E（npm run dev を別途起動）
bash scripts/smoke-prod.sh   # 本番スモーク（txt.2-38.com）
```

- 変更は「実際に動いた」証拠とともに報告する。dry-run や未実行を合格扱いしない。
- 本番デプロイは `npm run deploy`（ビルドを含む）。`npx wrangler deploy` 単体はビルドしない。
- デプロイ後は `scripts/smoke-prod.sh` を実行し、失敗ゼロを確認する。

## 既知の落とし穴

- `wrangler dev` はアセットマニフェストを起動時に固定する。Web をビルドしたら dev サーバーを
  再起動する（`scripts/dev.sh` がこれを行う）。再起動しないと `/` が 500 になる。
- Cloudflare のエッジは origin の ETag を弱形式（`W/"..."`）に書き換えることがある。
  ETag 比較は `normalizeEtag()` を通す。
- `__Host-` プレフィックスの Cookie は http では保存されない。ローカル開発は `txt_session` を使う
  （`sessionCookieName()`）。
- `.dev.vars` はテスト環境では読み込まれない。テストは `vitest.worker.config.ts` の bindings を使う。
- CSP は `unsafe-inline` を許可しない。インラインスクリプトを足す代わりに DOM へ値を注入する。
- `_headers` ファイルが静的アセットのセキュリティヘッダとキャッシュ方針を持つ。HTML を no-store に
  保たないと Cloudflare のキャッシュが古いシェルを配る。

## 未実装（意図的な範囲外）

- ネイティブ iOS/macOS（`spec.md` §16 フェーズ4）: `apps/apple/` と `packages/TxtCore/` は未着手。
- AASA の実値（Team ID / Bundle ID）確定と `.well-known` の公開。
- 実IME（macOS/Windows/iOS）での手動試験、512MiB 動画の実機シーク、独立したセキュリティレビュー。
