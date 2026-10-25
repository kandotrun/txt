/**
 * Lightweight i18n (spec §4.7).
 *
 * The Japanese string is the key: `t("閉じる")` returns it unchanged in
 * Japanese, and the English translation in English. This keeps a single
 * source of truth for strings (no duplicated key management) and keeps the
 * Japanese UI — and the tests written against it — byte-identical.
 *
 * Locale resolution order: the choice saved on this device wins; otherwise
 * the browser language decides (Japanese → ja, anything else → en). In
 * non-browser environments (unit tests, tooling) the default is Japanese.
 * Switching language persists the choice and reloads the page, so every
 * string — including ones computed at module load — follows the choice.
 */

export type Locale = "ja" | "en";

const STORAGE_KEY = "txt.locale";

const EN: Record<string, string> = {
  // Static shell / metadata
  "メールアドレスなしで、パスキーだけで使える、あなた専用の1枚のテキスト。本文と添付は端末で暗号化され、サーバーには暗号文だけが保存されます。":
    "A single sheet of text that's yours alone — no email address, just a passkey. Text and attachments are encrypted on your device; only ciphertext is stored on the server.",
  "txt — メールアドレスなしで、1枚のテキストを。": "txt — One sheet of text, no email address.",
  "パスキーだけで使える、あなた専用の1枚。本文と添付は端末で暗号化され、サーバーには暗号文だけが届きます。":
    "Yours alone, opened with just a passkey. Text and attachments are encrypted on your device; only ciphertext ever reaches the server.",
  "txt. — メールアドレスなしで、1枚のテキストを。": "txt. — One sheet of text, no email address.",
  "ここから書く。自動で保存されます。": "Write from here. It saves automatically.",
  テキスト: "Text",
  添付: "Attach",
  その他: "More",
  復旧キーで開く: "Open with a recovery key",
  復旧キー: "Recovery key",
  復旧キーを使う: "Use recovery key",
  スキップ: "Skip",
  閉じる: "Close",

  // Gate / auth
  "メールアドレスなしで、1枚のテキストを。": "One sheet of text, no email address.",
  "パスキーで暗号化された、あなた専用の1枚です。本文と添付は端末で暗号化され、サーバーには暗号文だけが保存されます。":
    "A single sheet of your own, encrypted with a passkey. Text and attachments are encrypted on your device; only ciphertext is stored on the server.",
  もう一度試す: "Try again",
  はじめて使う: "Get started",
  やめる: "Cancel",
  続ける: "Continue",
  進む: "Continue",
  再試行: "Retry",
  パスキーで開く: "Open with a passkey",
  "パスキーを確認しています……": "Checking your passkey…",
  "パスキーを作成しています……": "Creating your passkey…",
  "この環境では、このパスキーで暗号化された内容を開けません。":
    "This environment can't open content encrypted with this passkey.",
  "別の対応パスキー、または復旧キーを使用してください。":
    "Use another supported passkey, or a recovery key.",
  別のパスキーを試す: "Try another passkey",
  "ロックしました。": "Locked.",
  "ロックしました。次回はパスキーが必要です。": "Locked. You'll need your passkey next time.",
  接続できません: "Can't connect",
  "ネットワークを確認して、もう一度お試しください。": "Check your network and try again.",
  登録を完了してください: "Finish setting up",
  "パスキーは作成済みですが、準備が完了していません。":
    "Your passkey was created, but setup isn't complete yet.",
  "暗号化された内容を開くため、パスキーを確認します。":
    "We'll check your passkey to open the encrypted content.",
  うまくいきませんでした: "Something went wrong",
  "操作を完了できませんでした。": "The operation couldn't be completed.",
  "通信に失敗しました ({code}): {message}": "Communication failed ({code}): {message}",
  開けませんでした: "Couldn't open it",
  "{message}。データは変更していません。": "{message} Your data has not been changed.",
  "内容を開けません。データは変更していません。":
    "Couldn't open the content. Your data has not been changed.",

  // Recovery key
  "パスキーを失くしたときに、この1枚を開ける唯一の鍵です。":
    "It's the only key that can open this sheet if you lose your passkey.",
  "復旧キーは端末の外に保管してください。パスキーマネージャーと同じ場所だけに置くと、紛失時に同時に失われます。":
    "Keep your recovery key somewhere outside this device. If you store it only in the same place as your passkey manager, you could lose both at once.",
  復旧キーを保存してください: "Save your recovery key",
  保存しました: "I've saved it",
  あとで: "Later",
  コピー: "Copy",
  コピーしました: "Copied",
  選択しました: "Selected",
  ファイルに保存: "Save to a file",
  "復旧キーを入力してください。": "Enter your recovery key.",
  "復旧しています……": "Recovering…",
  "復旧が完了しました。": "Recovery complete.",
  "復旧キーの保存を確認できませんでした。設定から再度表示できます。":
    "Couldn't confirm that you saved the recovery key. You can display it again from Settings.",

  // Editor / sync status / media
  "この画像を表示できません。": "This image can't be displayed.",
  "文書が更新されました。添付をやり直してください。":
    "The document was updated. Please attach again.",
  "添付に失敗しました: {message}": "Attach failed: {message}",
  取消: "Cancel",
  保存中: "Saving",
  同期済み: "Synced",
  "端末に保存済み・未同期": "Saved on this device · Not synced",
  競合を確認してください: "Please review the conflict",
  再ログインが必要です: "You need to sign in again",
  読み込み中: "Loading",
  "文書を取得できません。": "Couldn't fetch the document.",
  読み込み中のメディア: "Loading media",
  "画像は100MBまでです。": "Images can be up to 100 MB.",
  "動画は10GBまでです。": "Videos can be up to 10 GB.",
  "音声は100MiBまでです。": "Audio can be up to 100 MiB.",
  "この形式のファイルは添付できません。": "This file type can't be attached.",
  "空のファイルは添付できません。": "Empty files can't be attached.",
  "暗号化したパートの長さが一致しません。": "The encrypted part length doesn't match.",
  "メディアを取得できません。": "Couldn't fetch the media.",
  "サーバーに接続できません。": "Couldn't connect to the server.",
  "参照の整合性が取れないため保存できません。": "Couldn't save: the references are inconsistent.",
  "本文の整合性が取れないため保存できません。": "Couldn't save: the content is inconsistent.",
  "再ログインが必要です。": "You need to sign in again.",

  // Conflict / draft dialogs
  この端末の内容: "On this device",
  サーバーの内容: "On the server",
  競合しています: "There's a conflict",
  編集して保存: "Edit and save",
  サーバーの内容を使う: "Use the server version",
  "競合があります。": "There's a conflict.",
  "添付情報の整合性を修復しました。": "Repaired the attachment references.",
  未確定の入力が残っています: "Unconfirmed input remains",
  未同期の入力が残っています: "Unsynced input remains",
  "前回の続きがあります。採用しますか。": "There's input left over from last time. Use it?",
  採用する: "Use it",
  破棄する: "Discard",
  "保存済みの下書きを読み込めませんでした。": "Couldn't load the saved draft.",

  // Vault / WebAuthn errors
  "このパスキー用の鍵が見つかりません。": "No key found for this passkey.",
  "復旧情報が見つかりません。": "No recovery information found.",
  "このアカウントのパスキー情報を取得できません。":
    "Couldn't fetch this account's passkey information.",
  "パスキーの操作が取り消されました。": "The passkey operation was cancelled.",
  "この環境ではパスキーを利用できません。": "Passkeys aren't available in this environment.",
  "パスキーの操作に失敗しました。": "The passkey operation failed.",
  "パスキーの作成が完了しませんでした。": "Passkey creation didn't complete.",
  "パスキーの操作が完了しませんでした。": "The passkey operation didn't complete.",

  // Agents
  名称未設定: "Unnamed",
  有効: "Active",
  登録途中: "Pending",
  失効済み: "Revoked",
  "トークン期限 {date}": "Token expires {date}",
  トークンなし: "No token",
  "{name}（{state}、{tokenNote}）": "{name} ({state}, {tokenNote})",
  "登録済みのエージェントはありません。": "No agents registered.",
  "エージェントはこの端末の外で復号します。本文がエージェント側へ渡る範囲を確認してから追加してください。":
    "Agents decrypt outside this device. Check what part of your sheet will reach the agent before adding one.",
  エージェント: "Agents",
  エージェントを追加: "Add an agent",
  "失効: {name}": "Revoke: {name}",
  エージェントを失効しますか: "Revoke this agent?",
  "{name} の鍵ラップとトークンが無効になり、以後このエージェントは本文を取得できなくなります。":
    "The key wrap and tokens for {name} will be invalidated, and this agent will no longer be able to fetch the sheet.",
  失効する: "Revoke",
  "エージェントを失効しました。": "Agent revoked.",
  "MCPサーバー側で登録コマンドを実行し、このペアリングコードを入力してください。表示された公開鍵を下へ貼り付けると、この画面から登録を進められます（MCP側で公開鍵を送信済みの場合は空欄のまま進んでください）。":
    "Run the enrollment command on the MCP server and enter this pairing code. Paste the public key it shows below to continue registration here (if the MCP side already submitted its public key, leave it blank).",
  "ペアリングコード: {code}": "Pairing code: {code}",
  "登録ID: {id}": "Enrollment ID: {id}",
  表示名: "Display name",
  "エージェントの公開鍵（任意）": "Agent public key (optional)",
  "公開鍵がまだ登録されていません。MCP側で登録してから、もう一度お試しください。":
    "No public key has been registered yet. Register it on the MCP side and try again.",
  フィンガープリントの確認: "Check the fingerprint",
  "MCPサーバー側に表示されたフィンガープリントと一致しますか。\n{fingerprint}":
    "Does this match the fingerprint shown on the MCP server?\n{fingerprint}",
  一致する: "It matches",
  一致しない: "It doesn't match",
  "登録を中止しました。公開鍵を確認してください。":
    "Enrollment cancelled. Please check the public key.",
  "ラップを保存しました。MCP側で有効化を完了してから、トークンを発行してください。":
    "Wrap saved. Complete activation on the MCP side, then issue a token.",
  トークンの権限: "Token permissions",
  "読み取り専用トークンか、読み書きトークン（読み取りを含みます）を選んでください。書き込みはMCPサーバー側の安全策（追記優先・置換は承認制）の対象です。":
    "Choose a read-only token or a read/write token (includes reading). Writes are subject to the MCP server's safeguards (append-first; replacements require approval).",
  読み取りのみ: "Read only",
  読み書き: "Read & write",
  発行しない: "Don't issue",
  "ラップと有効化は完了しました。トークンはエージェント管理から後で発行できます。":
    "Wrap and activation are complete. You can issue a token later from agent management.",
  "エージェント用トークンです。この画面を閉じると二度と表示されません。MCPサーバーの設定へ登録してください。":
    "This is your agent token. It won't be shown again once you close this screen. Register it in the MCP server settings.",
  トークン: "Token",
  トークンを発行しました: "Token issued",
  "AIエージェントに接続作業を任せる場合は、この手順書のリンクをAIに渡してください。":
    "To let an AI agent handle the connection setup, give it the link to this guide.",
  AI向け手順書: "Guide for AI agents",

  // "More" menu
  この端末の保持を解除: "Stop keeping on this device",
  "この端末に保持（30日）": "Keep on this device (30 days)",
  "この端末ではパスキーなしで開けます（{date} まで）。":
    "You can open it on this device without a passkey (until {date}).",
  "この1枚に関する操作です。": "Actions for this sheet.",
  今すぐロック: "Lock now",
  パスキーを追加: "Add a passkey",
  復旧キーを更新: "Rotate recovery key",
  使い方: "How to use",
  "txt を紹介する": "Share txt",
  セッションを終了: "End session",
  アカウントを削除: "Delete account",
  "リンクをコピーしました。": "Link copied.",
  "共有できませんでした。アドレスバーのURLを共有してください。":
    "Couldn't share. Please share the URL from the address bar.",
  "この端末に保持しました（{date} まで）。": "Kept on this device (until {date}).",
  "保持できませんでした: {message}": "Couldn't keep it on this device: {message}",
  "この端末の保持を解除しました。次回はパスキーが必要です。":
    "Device keeping removed. You'll need your passkey next time.",
  "パスキーを追加しました。": "Passkey added.",
  アカウントを削除しますか: "Delete your account?",
  "本文・添付・鍵が削除され、元に戻せません。":
    "Your sheet, attachments and keys will be deleted and can't be restored.",
  削除する: "Delete",
  言語: "Language",
  "表示言語を選んでください。": "Choose the display language.",

  // Onboarding
  "1枚だけ": "Just one sheet",
  "タイトルも一覧もありません。開けばすぐ書けて、自動で保存・同期されます。":
    "No titles, no lists. Open it and write — it saves and syncs automatically.",
  "メールアドレスもパスワードも要りません。指紋・顔・端末のロック解除などで開きます。":
    "No email address, no password. Open it with your fingerprint, face, or device unlock.",
  端末で暗号化: "Encrypted on your device",
  "本文と添付はこの端末で暗号化され、サーバーには暗号文だけが届きます。運営者も中身を読めません。":
    "Text and attachments are encrypted on this device; only ciphertext reaches the server. Not even the operator can read the contents.",
  復旧キーを控える: "Keep a recovery key",
  "パスキーを失くしたときに開ける唯一の鍵です。次の画面で表示されるので、パスキーとは別の場所に保存してください。":
    "It's the only key that can open your sheet if you lose your passkey. It appears on the next screen — store it somewhere separate from your passkey.",
  次へ: "Next",
  パスキーを作成: "Create a passkey",
  戻る: "Back",
  "ここから書く。": "Write from here.",
  空白も改行も: "Blank lines and breaks",
  "そのまま残る。": "stay exactly as written.",
  こんにちは: "Hello",
  わかった: "Got it",
  "写真・動画・音声を本文に入れる": "Add photos, videos and audio to your sheet",
  "ロック・パスキー・復旧キー・使い方": "Lock, passkeys, recovery key, and how to use",
  "メールアドレスなしで、1枚のテキストを。パスキーで開いて、端末で暗号化されるメモです。":
    "One sheet of text, no email address. A note opened with a passkey and encrypted on your device.",
};

function storedLocale(): Locale | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "ja" || value === "en" ? value : null;
  } catch {
    return null;
  }
}

function detectLocale(): Locale {
  if (typeof window === "undefined") return "ja";
  const saved = storedLocale();
  if (saved) return saved;
  const languages =
    typeof navigator !== "undefined" ? (navigator.languages ?? [navigator.language]) : [];
  const first = languages.find((entry) => typeof entry === "string" && entry.length > 0);
  return first && first.toLowerCase().startsWith("ja") ? "ja" : "en";
}

let current: Locale = detectLocale();

/** The active UI locale. */
export function getLocale(): Locale {
  return current;
}

/** BCP 47 tag for date/time formatting that follows the UI language. */
export function localeTag(): string {
  return current === "ja" ? "ja-JP" : "en-US";
}

/**
 * Translates a Japanese source string. `{name}` placeholders are filled
 * from `params`. In Japanese the source is returned as-is (after filling).
 */
export function t(source: string, params?: Record<string, string>): string {
  let text = current === "en" ? (EN[source] ?? source) : source;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, value);
    }
  }
  return text;
}

/**
 * Persists the chosen locale on this device and reloads so every string,
 * including module-level ones, is rendered in the new language.
 */
export function setLocale(locale: Locale): void {
  if (locale === current) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Storage may be unavailable (private mode); the reload still applies
    // the in-memory choice for this session only if we skip persistence —
    // but a reload would lose it, so just update in place instead.
    current = locale;
    return;
  }
  window.location.reload();
}

/**
 * Localizes the static shell: `<html lang>`, meta/OG descriptions, and the
 * fixed labels baked into index.html. Runs once at app startup, before the
 * gate is shown. In Japanese this is a no-op (the shell ships in Japanese).
 */
export function applyStaticLocale(): void {
  if (current === "ja" || typeof document === "undefined") return;
  document.documentElement.lang = "en";
  const setMeta = (selector: string, value: string) => {
    document.querySelector(selector)?.setAttribute("content", value);
  };
  setMeta('meta[name="description"]', t("メールアドレスなしで、パスキーだけで使える、あなた専用の1枚のテキスト。本文と添付は端末で暗号化され、サーバーには暗号文だけが保存されます。"));
  setMeta('meta[property="og:title"]', t("txt — メールアドレスなしで、1枚のテキストを。"));
  setMeta('meta[property="og:description"]', t("パスキーだけで使える、あなた専用の1枚。本文と添付は端末で暗号化され、サーバーには暗号文だけが届きます。"));
  setMeta('meta[property="og:image:alt"]', t("txt. — メールアドレスなしで、1枚のテキストを。"));
  setMeta('meta[property="og:locale"]', "en_US");
  setMeta('meta[name="twitter:title"]', t("txt — メールアドレスなしで、1枚のテキストを。"));
  setMeta('meta[name="twitter:description"]', t("パスキーだけで使える、あなた専用の1枚。本文と添付は端末で暗号化され、サーバーには暗号文だけが届きます。"));

  const setText = (selector: string, value: string) => {
    const node = document.querySelector(selector);
    if (node) node.textContent = value;
  };
  const setAttr = (selector: string, name: string, value: string) => {
    document.querySelector(selector)?.setAttribute(name, value);
  };
  setText(".empty-hint", t("ここから書く。自動で保存されます。"));
  setAttr("#editor", "aria-label", t("テキスト"));
  setAttr("#attach-button", "title", t("添付"));
  setAttr("#attach-button", "aria-label", t("添付"));
  setAttr("#more-button", "title", t("その他"));
  setAttr("#more-button", "aria-label", t("その他"));
  setText(".gate-recovery summary", t("復旧キーで開く"));
  const recoveryLabel = document.querySelector(".gate-recovery .field span");
  if (recoveryLabel) recoveryLabel.textContent = t("復旧キー");
  setText("#recovery-submit", t("復旧キーを使う"));
  setText(".intro-skip", t("スキップ"));
  setAttr(".dialog-close", "aria-label", t("閉じる"));
}
