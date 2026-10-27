// 残量（5時間枠・週枠の使用率）の取得
//
// Claude Code 本体が /usage 表示に使っている非公式 API を、保存済みトークンで呼ぶ。
// BAN・負荷のリスクを下げるための方針:
//   - 読み取り専用の API だけを使う
//   - 取得結果は全ウィンドウ共通のキャッシュファイルに保存し、間隔内は再取得しない
//   - 失敗が続いたら待ち時間を倍々に延ばす（指数バックオフ）
//   - 使用中アカウントのトークンは「読むだけ」。更新（refresh）は Claude Code 本体に任せて競合させない
//   - 使っていないアカウントは、期限切れのときだけ本体と同じ手順で refresh し、新しいトークンを必ず保存する

const fs = require('fs');
const C = require('./config');
const A = require('./accounts');

// ---------- キャッシュ ----------
// 形: { "<slot>": { fetchedAt, fiveHour:{pct,resetsAt}, weekly:{pct,resetsAt}, error, failCount, nextTryAt } }

function loadCache() {
  try { return JSON.parse(A.readText(C.USAGE_CACHE_FILE) || '{}'); } catch { return {}; }
}
function saveCache(cache) {
  try { A.writeText(C.USAGE_CACHE_FILE, JSON.stringify(cache, null, 2)); } catch { /* 表示用なので失敗しても続行 */ }
}

// ---------- HTTP ----------

async function httpJson(url, options) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(C.HTTP_TIMEOUT_MS) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* JSON でない応答（HTML のエラーページ等） */ }
  return { status: res.status, body };
}

// API の応答から 5h / 1w を取り出す。
// 新形式は limits 配列（kind: "session" = 5時間枠, "weekly_all" = 週枠、percent は 0〜100）。
// 旧形式の five_hour / seven_day（utilization も 0〜100）にも対応しておく。
function parseUsage(body) {
  const pick = (kind, legacyKey) => {
    const lim = Array.isArray(body.limits) ? body.limits.find(l => l && l.kind === kind) : null;
    if (lim && typeof lim.percent === 'number') return { pct: lim.percent, resetsAt: lim.resets_at || null };
    const old = body[legacyKey];
    if (old && typeof old.utilization === 'number') return { pct: old.utilization, resetsAt: old.resets_at || null };
    return null;
  };
  return { fiveHour: pick('session', 'five_hour'), weekly: pick('weekly_all', 'seven_day') };
}

// ---------- トークン ----------

function readCreds(file) {
  try { return JSON.parse(A.readText(file)); } catch { return null; }
}

function isExpired(oauth) {
  return !oauth || !oauth.expiresAt || oauth.expiresAt - C.TOKEN_EXPIRY_MARGIN_MS < Date.now();
}

// 複数ウィンドウが同時に同じ refresh token を使うと、片方が古いトークンを送ることになり
// アカウントのログインが無効化されることがある。ファイルを「新規作成のみ（wx）」で開けた側だけが更新する。
function tryLock() {
  try {
    const st = fs.statSync(C.REFRESH_LOCK_FILE);
    if (Date.now() - st.mtimeMs > C.LOCK_STALE_MS) fs.unlinkSync(C.REFRESH_LOCK_FILE); // 落ちたウィンドウの残骸
  } catch { /* ロックなし */ }
  try {
    fs.mkdirSync(C.ACCOUNTS_DIR, { recursive: true });
    fs.closeSync(fs.openSync(C.REFRESH_LOCK_FILE, 'wx'));
    return true;
  } catch { return false; }
}
function unlock() { try { fs.unlinkSync(C.REFRESH_LOCK_FILE); } catch { /* 既に無い */ } }

// 使っていないスロットのトークンを更新してスロットファイルへ保存する。戻り値: 新しい accessToken
async function refreshSlot(slot) {
  if (!tryLock()) throw new Error('他のウィンドウが更新中');
  try {
    // ロック取得までの間に別ウィンドウが更新済みかもしれないので読み直す
    const file = A.credPath(slot);
    const creds = readCreds(file);
    const oauth = creds && creds.claudeAiOauth;
    if (!oauth || !oauth.refreshToken) throw new Error('トークンなし');
    if (!isExpired(oauth)) return oauth.accessToken;

    let lastErr = '更新失敗';
    for (const url of C.TOKEN_URLS) {
      try {
        const r = await httpJson(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: C.OAUTH_CLIENT_ID })
        });
        if (r.status === 200 && r.body && r.body.access_token) {
          // refresh token は使うたびに新しいものに入れ替わる（ローテーション）ので、必ず保存し直す
          oauth.accessToken = r.body.access_token;
          if (r.body.refresh_token) oauth.refreshToken = r.body.refresh_token;
          if (r.body.expires_in) oauth.expiresAt = Date.now() + r.body.expires_in * 1000;
          A.writeText(file, JSON.stringify(creds));
          return oauth.accessToken;
        }
        lastErr = `更新失敗 (${r.status})`;
        // 400/401 は「この refresh token は使えない」意味なので、別 URL で再送しない（無駄打ち防止）
        if (r.status === 400 || r.status === 401) break;
      } catch (e) {
        lastErr = '通信エラー';
      }
    }
    throw new Error(lastErr);
  } finally {
    unlock();
  }
}

// スロット 1 つ分の残量を取得する
async function fetchSlot(slot, isActive) {
  let token;
  if (isActive) {
    // 使用中アカウントは Claude Code 本体のファイルを読むだけ
    const oauth = (readCreds(C.CRED_FILE) || {}).claudeAiOauth;
    if (!oauth) throw new Error('未ログイン');
    if (isExpired(oauth)) throw new Error('トークン期限切れ（Claude を使うと自動更新）');
    token = oauth.accessToken;
  } else {
    const oauth = (readCreds(A.credPath(slot)) || {}).claudeAiOauth;
    if (!oauth) throw new Error('未ログイン');
    token = isExpired(oauth) ? await refreshSlot(slot) : oauth.accessToken;
  }

  const r = await httpJson(C.USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': C.OAUTH_BETA, 'Content-Type': 'application/json' }
  });
  if (r.status !== 200 || !r.body) throw new Error(r.status === 429 ? '取得制限中' : `取得不可 (${r.status})`);
  return parseUsage(r.body);
}

// 全スロットの残量を更新してキャッシュを返す。
//   intervalMin … 定時更新の間隔（分）。失敗時の待ち時間の基準に使う
//   freshMs     … 前回取得からこの時間以内のスロットはキャッシュをそのまま使う（他ウィンドウが取得済みなど）
//   force       … true なら上の判定とバックオフを無視して取得（手動更新ボタン）
let running = null; // 同じウィンドウ内で二重に走らせない
function refreshAll(intervalMin, freshMs, force) {
  if (running) return running;
  running = (async () => {
    const cache = loadCache();
    const cur = A.getCurrent();
    const now = Date.now();
    for (const slot of A.listSavedSlots()) {
      const prev = cache[slot] || {};
      // 他ウィンドウが取得したばかり／バックオフ中ならスキップ
      if (!force && prev.fetchedAt && now - prev.fetchedAt < freshMs) continue;
      if (!force && prev.nextTryAt && now < prev.nextTryAt) continue;
      try {
        const u = await fetchSlot(slot, slot === cur);
        cache[slot] = { fetchedAt: Date.now(), fiveHour: u.fiveHour, weekly: u.weekly, error: null, failCount: 0 };
      } catch (e) {
        const failCount = (prev.failCount || 0) + 1;
        // 失敗するたびに間隔を 2 倍（上限あり）。古い数値は残して「取得不可」と併記する
        const waitMin = Math.min(intervalMin * 2 ** (failCount - 1), C.BACKOFF_MAX_MIN);
        cache[slot] = { ...prev, error: e.message || '取得不可', failCount, fetchedAt: Date.now(), nextTryAt: Date.now() + waitMin * 60000 };
      }
    }
    saveCache(cache);
    return cache;
  })().finally(() => { running = null; });
  return running;
}

module.exports = { loadCache, refreshAll };
