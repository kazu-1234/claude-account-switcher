// 調整値まとめ
//
// 後から変えそうな値（間隔・しきい値・パス・URL・表示文言の書式など）はすべてここに置き、
// 各処理ファイルでは直書きしない。ユーザー設定（settings.json）で上書きできるものは
// extension.js 側で読み取って、ここの値を既定値として使う。

const path = require('path');
const os = require('os');

// ===== パス（Claude Code 本体のログイン情報の置き場所） =====
// Claude Code は Windows では次の 2 か所にログイン情報を持つ。
//   .credentials.json … OAuth トークン本体（accessToken / refreshToken / 期限）
//   .claude.json の "oauthAccount" … メールや組織 ID などの表示用情報
const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const CRED_FILE = path.join(CLAUDE_DIR, '.credentials.json');
const STATE_FILE = path.join(HOME, '.claude.json');
// セッション記録（会話ログ）の置き場所。処理中かどうかの判定に使う
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// ===== 保存先（switch-account.ps1 と同じ形式・同じ場所にして互換を保つ） =====
const ACCOUNTS_DIR = path.join(CLAUDE_DIR, 'accounts');
const CURRENT_FILE = path.join(ACCOUNTS_DIR, 'current.txt');
// 残量の取得結果を全ウィンドウで共有するキャッシュ（同じ API を何度も叩かないため）
const USAGE_CACHE_FILE = path.join(ACCOUNTS_DIR, 'usage-cache.json');
// トークン更新の排他ロック（複数ウィンドウが同時に更新すると古い refresh token が無効化されるため）
const REFRESH_LOCK_FILE = path.join(ACCOUNTS_DIR, '.refresh.lock');
// 切替の合図ファイル。他ウィンドウはこれの変化を見て再読み込みする
const SWITCH_EVENT_FILE = path.join(ACCOUNTS_DIR, 'switch-event.json');

// ===== 表示 =====
const LABEL_PREFIX = '登録';          // スロット "1" → 「登録1」
const STATUS_PRIORITY = 1000;         // ステータスバー右側での並び順（大きいほど左寄り）
const WARN_PERCENT = 80;              // この使用率以上で警告色
const ERROR_PERCENT = 95;             // この使用率以上でエラー色
// 残り時間は時間とともに減るので、ステータスバーをこの間隔で描き直す（キャッシュを読むだけで API は叩かない）
const STATUS_TICK_MS = 60 * 1000;
// 週枠のリセット曜日の表記（Date.getDay() の 0=日 … 6=土 に対応）
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// ===== 残量 API（非公式。Claude Code 本体が使っているもの） =====
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
// トークン更新先。新しい URL が失敗したら旧 URL を試す
const TOKEN_URLS = [
  'https://platform.claude.com/v1/oauth/token',
  'https://console.anthropic.com/v1/oauth/token'
];
// Claude Code の公開 OAuth クライアント ID（本体と同じ値でないと refresh できない）
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const HTTP_TIMEOUT_MS = 15000;
// 接続そのものの失敗（再読み込み直後の一時的な切断など。Node では "fetch failed" になる）のときだけ、
// この時間待って 1 回だけ再試行する。サーバーが応答を返した失敗（401・429 など）は再試行しない
const HTTP_RETRY_DELAY_MS = 3000;
// 取得タイミング: 起動中は「毎時、分がこの値の倍数になる時刻」（既定 5 → :00, :05, :10 …）に取得する。
// きっちり同じ秒に揃うと機械的なアクセスに見えるので、毎回 ±JITTER 秒の範囲でランダムにずらす。
const USAGE_INTERVAL_MIN_DEFAULT = 5; // 既定の間隔（分）
const USAGE_INTERVAL_MIN_FLOOR = 2;   // これより短くはしない（サーバー負荷・BAN リスク対策）
const SCHEDULE_JITTER_SEC = 20;       // 定時からのずらし幅（±秒）
// 他のウィンドウがこの秒数以内に取得済みなら、定時になっても取得しない（複数ウィンドウでの重複防止）。
// ずらし幅の 2 倍（最大 40 秒差）より長く、間隔（5 分）より十分短い値にする
const SHARED_FRESH_SEC = 120;
const BACKOFF_MAX_MIN = 60;           // 失敗が続いたときの最大待ち（分）
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000; // 期限の 1 分前から「切れた」とみなす
const LOCK_STALE_MS = 60 * 1000;      // これより古いロックは残骸とみなして消す

// ===== 自動更新（GitHub Releases） =====
// 最新リリースの情報を返す GitHub API。tag_name（例 "v0.3.0"）と assets（.vsix の URL）を使う
const UPDATE_API_URL = 'https://api.github.com/repos/kazu-1234/claude-account-switcher/releases/latest';
// GitHub API は User-Agent ヘッダが無いと拒否するので、拡張名を名乗る
const UPDATE_USER_AGENT = 'claude-account-switcher';
// 起動時の自動確認はこの時間に 1 回まで（複数ウィンドウでの重複と、無認証 API の 60 回/時 制限対策）
const UPDATE_CHECK_INTERVAL_HOURS = 6;

// ===== 処理中判定 =====
// 会話ログ（*.jsonl）が直近 BUSY_SECONDS 秒以内に書き込まれていれば「Claude が処理中」とみなす
const BUSY_SECONDS = 8;
// 「処理が終わってから」を選んだとき、ログ更新が IDLE_SECONDS 秒止まったら終わったとみなす
// （ツール実行中は数秒ログが止まることがあるので BUSY より長め）
const IDLE_SECONDS = 15;
const WAIT_POLL_MS = 1000;            // 待機中の確認間隔
const SCAN_DEPTH = 3;                 // projects 配下を何階層まで探すか（サブエージェントのログ用）

// ===== 会話の引継ぎ（切替後に直前の会話を開き直す） =====
// Claude Code 拡張の ID。activate() で起動を待ってから会話を開く
const CLAUDE_CODE_EXT_ID = 'anthropic.claude-code';
// Claude Code 拡張が公式に用意している URI ハンドラ（?session=<ID> で過去の会話を再開）。
// 先頭のスキーム（vscode / cursor …）は vscode.env.uriScheme で付けるので、ここにはパスだけ書く
const RESUME_URI_PATH = 'anthropic.claude-code/open';
// Claude 拡張の起動後、会話を開くまで待つ時間。
// 開いてから約 3 秒以内に再読み込みされると「開けなかった」と記録される仕様なので、起動直後の混雑を避けて余裕を持たせる
const RESUME_DELAY_MS = 4000;
// 切替前に保存した「開き直す会話」の有効期限。これより古い情報では開かない（関係ない起動で勝手に開かないため）
const RESUME_MAX_AGE_MS = 2 * 60 * 1000;
// 会話ログの先頭からこのバイト数だけ読み、作業フォルダ（cwd）がこのワークスペースか確かめる
const RESUME_HEAD_BYTES = 64 * 1024;

// ===== 監視 =====
const WATCH_INTERVAL_MS = 1500;       // ファイル変化の確認間隔（fs.watchFile のポーリング）

module.exports = {
  CLAUDE_DIR, CRED_FILE, STATE_FILE, PROJECTS_DIR,
  ACCOUNTS_DIR, CURRENT_FILE, USAGE_CACHE_FILE, REFRESH_LOCK_FILE, SWITCH_EVENT_FILE,
  LABEL_PREFIX, STATUS_PRIORITY, WARN_PERCENT, ERROR_PERCENT, STATUS_TICK_MS, WEEKDAYS,
  UPDATE_API_URL, UPDATE_USER_AGENT, UPDATE_CHECK_INTERVAL_HOURS,
  USAGE_URL, OAUTH_BETA, TOKEN_URLS, OAUTH_CLIENT_ID, HTTP_TIMEOUT_MS, HTTP_RETRY_DELAY_MS,
  USAGE_INTERVAL_MIN_DEFAULT, USAGE_INTERVAL_MIN_FLOOR, SCHEDULE_JITTER_SEC, SHARED_FRESH_SEC, BACKOFF_MAX_MIN,
  TOKEN_EXPIRY_MARGIN_MS, LOCK_STALE_MS,
  BUSY_SECONDS, IDLE_SECONDS, WAIT_POLL_MS, SCAN_DEPTH,
  CLAUDE_CODE_EXT_ID, RESUME_URI_PATH, RESUME_DELAY_MS, RESUME_MAX_AGE_MS, RESUME_HEAD_BYTES,
  WATCH_INTERVAL_MS
};
