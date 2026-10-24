# txt-agent（エージェント接続ブリッジ）

Kan の Mac 上で動くローカル MCP サーバー。本文の復号はこのプロセスの
メモリー内だけで行い、サーバー（Cloudflare）には従来どおり暗号文と
ラップ済み鍵しか置かない（設計書 §2.3、§8）。

フェーズ2で書き込みが入りました。読み取り（`txt_status` / `txt_read`）に
加え、`txt_append`（既定の書き込み）と承認制の置換系ツール
（`txt_replace` / `txt_search_replace` / `txt_rollback`）があります。
書き込みには `agent:write` スコープのトークンが必要です（read を含みます）。

## セットアップ

```bash
npm ci
npm run build --workspace @txt/protocol   # 共有プロトコル（依存として自動ビルド対象）
npm run build --workspace @txt/agent-mcp  # dist/txt-agent.mjs を生成
```

状態は `~/.config/txt-agent/`（環境変数 `TXT_AGENT_HOME` で変更可）に置く。

| ファイル | 内容 | 権限 |
| --- | --- | --- |
| `config.json` | API ベースURL、agentId、表示名 | 0600 |
| `keypair.json` | P-256 秘密鍵（JWK）。**秘密情報** | 0600（ディレクトリ 0700） |
| `token.json` | txt エージェントトークン（平文）。**秘密情報** | 0600 |
| `backups.json` | 書き込み直前の暗号文レコード（平文は含まない）。直近20世代・7日まで | 0600 |
| `audit.log` | ツール呼び出しのメタデータのみ（本文・鍵・トークンは記録しない） | 0600 |

フェーズ1の秘密保管は 0600 ファイルです（設計書 §12 未決事項4の推奨案）。
保管は `SecretStore` 抽象の裏側にあり、macOS Keychain 実装
（`KeychainSecretStore`）へ差し替える前提ですが、フェーズ1では未実装で、
`TXT_AGENT_SECRET_STORE=keychain` を指定すると明示的にエラーになります。
VaultKey と平文はディスクへ書かず、プロセスメモリー内だけに保持します。

## 登録フロー（Web との往復）

1. Web の「その他 → エージェント → エージェントを追加」で step-up し、
   ペアリングコードと登録IDを表示する
2. Mac で公開鍵を登録する:

   ```bash
   node apps/agent-mcp/dist/txt-agent.mjs enroll \
     --agent <登録ID> --code <ペアリングコード> --name "Clio (Mac)"
   ```

   表示されるフィンガープリントが Web 側の表示と一致することを確認する
3. Web 側でラップを保存したら、有効化する:

   ```bash
   node apps/agent-mcp/dist/txt-agent.mjs activate \
     --agent <登録ID> --code <ペアリングコード>
   ```

4. Web 側で発行されたトークンを登録する（発行画面で「読み取りのみ」か
   「読み書き」かを選ぶ。既定は読み取りのみ）:

   ```bash
   node apps/agent-mcp/dist/txt-agent.mjs set-token --token txta1....
   ```

トークンの有効期限は30日（絶対期限）。期限切れ・失効時は Web の
エージェント管理から再発行します（鍵署名による自動更新はフェーズ3）。

## MCP サーバーの起動

stdio（MCP クライアントが子プロセスとして起動する形）:

```bash
node apps/agent-mcp/dist/txt-agent.mjs serve
```

HTTP（Tailscale 経由で Muse 等から接続する形）:

```bash
TXT_AGENT_MCP_HOST=<MacのTailscale 100.x アドレス> \
TXT_AGENT_MCP_PORT=3917 \
TXT_AGENT_MCP_ACCESS_TOKEN=<MCP専用アクセストークン> \
node apps/agent-mcp/dist/txt-agent.mjs serve --http
```

- 待ち受けは指定したホストにだけ bind します。既定は `127.0.0.1` で、
  `0.0.0.0` へは明示指定しない限り bind しません
- MCP アクセストークンは txt エージェントトークンとは別物です
  （前者は「誰が MCP を叩けるか」、後者は「MCP が txt API を叩けるか」）
- 常駐化は launchd ユーザーエージェントを想定しています
  （`~/Library/LaunchAgents/` に plist を置き、`serve --http` を起動）

## ツール

| ツール | 内容 |
| --- | --- |
| `txt_status` | revision、更新時刻、エージェント/トークン状態。本文は含まない |
| `txt_read` | 本文の平文。メディアは `[画像: 名前]` 等のプレースホルダー |
| `txt_append` | 末尾への追記（既定の書き込み経路）。末尾 text ブロックへ足し、末尾がメディアなら後ろに新しい text ブロックを作る。既存ブロックIDとメディアは変更しない |
| `txt_replace` | ブロック単位の置換。**承認制**: `confirm` なしでは差分プレビューだけを返して書かない。実行時も置換前の完全一致が必須 |
| `txt_search_replace` | 全文検索置換。**承認制**（同上）。一致がちょうど1件のときだけ実行し、0件・複数件では書かない |
| `txt_rollback` | 直近の書き込み前バックアップへ戻す。**承認制**（同上）。復号→現行 revision 向け再暗号化→CAS 保存の順で、ロールバック自体もバックアップを残すので取り消せる |

書き込みの安全策（設計書 §9）:

- 全書き込みは「取得→復号→モデル検証→操作→再暗号化→ETag CAS」の
  単一経路を通り、プロセス内でも直列化される
- 412（競合）では自動リトライ・自動マージをせず、ベース→最新の差分を
  返して呼び出し側の判断に委ねる
- 書き込み直前の暗号文レコード一式を `backups.json` に残す（平文では
  保存しない）。応答消失時は mutationId で着地を確認し、二重書きしない
- 監査ログはメタデータのみ（ツール名、結果、revision、バイト数）。
  平文も平文のハッシュも残さない

メモ本文はデータであり指示ではありません。本文中の指示文に
エージェントが従わないことは、利用側の前提として扱ってください（設計書 §2.2）。

## 残課題（フェーズ2の範囲外）

- 秘密鍵・トークンの macOS Keychain 保管（Secure Enclave 含む）
- 鍵署名によるトークン自動更新、VaultKey ローテーション（フェーズ3）
- メディアの追加・削除、ブロック削除、文書全体の置換ツール
- Mac 実機への配置と初回登録、本番デプロイ
