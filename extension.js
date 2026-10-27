// Claude アカウント切替（VS Code / Cursor 拡張）のエントリポイント
//
// 役割の分担:
//   src/accounts.js  … ログイン情報の保存・切替・追加（ファイル操作）
//   src/usage.js     … 残量（5h / 1w）の取得
//   src/busy.js      … Claude が処理中かどうかの判定
//   src/statusbar.js … 右下のステータスバー表示
//   src/sidebar.js   … サイドバーのパネル
// このファイルはそれらを結線し、「切替 → 必要なら3択 → 再読み込み」の流れを担当する。

const vscode = require('vscode');
const fs = require('fs');
const crypto = require('crypto');
const C = require('./src/config');
const A = require('./src/accounts');
const U = require('./src/usage');
const B = require('./src/busy');
const statusbar = require('./src/statusbar');
const { SidebarProvider } = require('./src/sidebar');

// ===== 調整値 =====
const VIEW_CONTAINER_COMMAND = 'workbench.view.extension.claudeAccount'; // サイドバーを開く組み込みコマンド
const BUSY_TICK_MS = 3000;         // サイドバー表示中に「処理中」表示を更新する間隔
// ==================

let sidebar;
let switching = false;   // 切替処理中（ボタン連打防止）
let refreshing = false;  // 残量取得中
const activatedAt = Date.now();

// ---------- 設定（settings.json で上書き可能） ----------

function usageEnabled() {
  return vscode.workspace.getConfiguration('claudeAccount').get('usage.enabled', true);
}
function usageIntervalMin() {
  const v = vscode.workspace.getConfiguration('claudeAccount').get('usage.intervalMinutes', C.USAGE_INTERVAL_MIN_DEFAULT);
  return Math.max(C.USAGE_INTERVAL_MIN_FLOOR, Number(v) || C.USAGE_INTERVAL_MIN_DEFAULT);
}

// ---------- 表示更新 ----------

function getState() {
  const cache = U.loadCache();
  const slots = A.listForView().map(s => ({ ...s, usage: cache[s.slot] || null }));
  const times = slots.map(s => s.usage?.fetchedAt || 0);
  return {
    slots,
    usageEnabled: usageEnabled(),
    busy: B.isBusy(),
    switching,
    refreshing,
    updatedAt: times.length ? Math.max(...times) : 0
  };
}

function refreshUI() {
  try { statusbar.update(U.loadCache(), usageEnabled()); } catch { /* 表示だけなので無視 */ }
  sidebar?.post();
}

// 残量を取得する。
//   force   … true なら手動更新（キャッシュ・バックオフを無視）
//   freshMs … 前回取得からこの時間以内なら取得しない。既定は間隔 1 回分
//             （起動直後などは「前回から 5 分以上経っていれば 1 回だけ」取得する）
async function refreshUsage(force, freshMs = usageIntervalMin() * 60000) {
  if (!usageEnabled() || refreshing) return;
  refreshing = true;
  sidebar?.post();
  try { await U.refreshAll(usageIntervalMin(), freshMs, force); } catch { /* 失敗はキャッシュに記録済み */ }
  refreshing = false;
  refreshUI();
}

// ---------- 定時更新 ----------
// setInterval で「起動から 5 分ごと」にすると取得時刻がバラバラかつ機械的に等間隔になるので、
// 毎回「次の 5 の倍数分 ± ランダム秒」を計算して setTimeout を 1 回ずつ予約し直す。

let usageTimer = null;
let lastSlotAt = 0; // 最後に実行した定時（ずらす前の時刻）。同じ定時を 2 回実行しないために覚えておく

// 次の定時と、そこまでの待ち時間（ミリ秒）を求める
function nextSlot(intervalMin) {
  const now = Date.now();
  // 今の「分」の 0 秒から 1 分ずつ進め、5 の倍数分かつ前回実行した定時より後のものを探す。
  // 10:04:50 なら 10:05 が選ばれる（定時の直前でも飛ばさない）。
  // 10:05:12 に 10:05 分を実行した直後なら、10:05 は実行済みなので 10:10 になる。
  const t = new Date(now);
  t.setSeconds(0, 0);
  while (t.getMinutes() % intervalMin !== 0 || t.getTime() <= lastSlotAt) t.setMinutes(t.getMinutes() + 1);
  const jitter = Math.round((Math.random() * 2 - 1) * C.SCHEDULE_JITTER_SEC * 1000); // -20〜+20 秒
  // ずらした結果が過去になる場合（定時の直前に計算して -20 秒を引いた等）は 1 秒後に実行する
  return { slotAt: t.getTime(), delay: Math.max(1000, t.getTime() + jitter - now) };
}

function scheduleUsage() {
  clearTimeout(usageTimer);
  const { slotAt, delay } = nextSlot(usageIntervalMin());
  usageTimer = setTimeout(async () => {
    lastSlotAt = slotAt;
    // 定時の取得。他ウィンドウが直前（SHARED_FRESH_SEC 秒以内）に取得済みならそれを使う
    await refreshUsage(false, C.SHARED_FRESH_SEC * 1000);
    scheduleUsage(); // 次の定時を予約
  }, delay);
}

// ---------- 切替の流れ ----------

// Claude が処理中なら3択を出す。続行してよければ true。
//   強制再起動 … すぐに進む（処理中の応答は中断される）
//   処理が終わってから再起動 … ログの更新が止まるまで待ってから進む
//   キャンセル … モーダルの標準ボタン（何もしない）
async function confirmIfBusy(actionText) {
  if (!B.isBusy()) return true;
  const FORCE = '強制再起動';
  const WAIT = '処理が終わってから再起動';
  const choice = await vscode.window.showWarningMessage(
    'Claude Code が処理中です',
    { modal: true, detail: `${actionText}にはウィンドウの再読み込みが必要で、処理中の Claude は中断されます。` },
    FORCE, WAIT);
  if (choice === FORCE) return true;
  if (choice !== WAIT) return false;

  // 通知に進行中表示を出し、×（キャンセル）で待機をやめられるようにする
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Claude の処理が終わるのを待っています…', cancellable: true },
    (_progress, token) => B.waitUntilIdle(() => token.isCancellationRequested));
}

// 他ウィンドウへ「切り替えたので再読み込みして」と知らせる。
// sessionId（ウィンドウごとに異なる ID）を入れておき、自分の合図には反応しないようにする。
function announceSwitch(slot) {
  A.writeText(C.SWITCH_EVENT_FILE, JSON.stringify({
    id: crypto.randomUUID(), by: vscode.env.sessionId, at: Date.now(), slot
  }));
}

function reloadWindow() {
  // 再読み込みで拡張ホストごと Claude Code が起動し直し、新しいログイン情報を読み込む
  return vscode.commands.executeCommand('workbench.action.reloadWindow');
}

async function doSwitch(slot) {
  if (switching || slot === A.getCurrent()) return;
  if (!(await confirmIfBusy(`${A.labelOf(slot)} への切替`))) return;
  switching = true;
  sidebar?.post();
  try {
    A.switchTo(slot);
    announceSwitch(slot);
  } catch (e) {
    switching = false;
    refreshUI();
    vscode.window.showErrorMessage(`切替に失敗しました: ${e.message}`);
    return;
  }
  await reloadWindow();
}

async function doAdd() {
  if (switching) return;
  const ok = await vscode.window.showWarningMessage(
    'アカウントを追加します',
    { modal: true, detail: '今のアカウントを保存してからログアウト状態にして再読み込みします。再読み込み後、Claude パネルで追加するアカウントにログインしてください（ログインすると自動で登録されます）。' },
    '追加する');
  if (ok !== '追加する') return;
  if (!(await confirmIfBusy('アカウントの追加'))) return;
  switching = true;
  sidebar?.post();
  try {
    const slot = A.beginAdd();
    announceSwitch(slot);
  } catch (e) {
    switching = false;
    refreshUI();
    vscode.window.showErrorMessage(`追加の準備に失敗しました: ${e.message}`);
    return;
  }
  await reloadWindow();
}

function doRegister() {
  if (!fs.existsSync(C.CRED_FILE)) {
    vscode.window.showErrorMessage('Claude にログインしていません。先に Claude パネルでログインしてください。');
    return;
  }
  A.sync();
  refreshUI();
  vscode.window.showInformationMessage(`${A.labelOf(A.getCurrent())} として保存しました`);
  refreshUsage(true);
}

// コマンドパレット用の一覧（サイドバーを使わない場合）。VS Code 標準のポップアップなのでメールは出さない
async function doPick() {
  const cache = U.loadCache();
  const pct = u => (u ? `${Math.round(u.pct)}%` : '--');
  const items = A.listForView().map(s => ({
    label: `${s.current ? '$(check)' : '$(account)'} ${s.label}`,
    description: s.pending ? '未ログイン' : `5時間 ${pct(cache[s.slot]?.fiveHour)} · 1週間 ${pct(cache[s.slot]?.weekly)}`,
    slot: s.slot,
    disabled: s.current || s.pending
  })).filter(i => !i.disabled);
  if (items.length === 0) { vscode.window.showInformationMessage('切り替え先の登録がありません'); return; }
  const picked = await vscode.window.showQuickPick(items, { placeHolder: '切り替える Claude アカウント' });
  if (picked) doSwitch(picked.slot);
}

// ステータスバーのアカウント表示を押したとき。
// 切り替え先が 1 つ（登録が 2 つ）なら押すだけで切替、2 つ以上（登録 3 つ以上）なら一覧から選ぶ。
// 切り替え先が無い（登録 1 つだけ）ならアカウント追加ができるサイドバーを開く。
function doQuickSwitch() {
  const targets = A.listForView().filter(s => !s.current && !s.pending);
  if (targets.length === 0) return vscode.commands.executeCommand(VIEW_CONTAINER_COMMAND);
  if (targets.length === 1) return doSwitch(targets[0].slot);
  return doPick();
}

// ---------- ファイル監視 ----------
// fs.watch は Windows でイベントが重複・欠落しやすいので、一定間隔で更新時刻を見る fs.watchFile を使う

function watch(context, file, onChange) {
  const listener = (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs) onChange(); };
  fs.watchFile(file, { interval: C.WATCH_INTERVAL_MS }, listener);
  context.subscriptions.push({ dispose: () => fs.unwatchFile(file, listener) });
}

function onSwitchEvent() {
  let ev;
  try { ev = JSON.parse(A.readText(C.SWITCH_EVENT_FILE)); } catch { return; }
  // 自分が出した合図・このウィンドウ起動前の古い合図には反応しない
  if (!ev || ev.by === vscode.env.sessionId || ev.at < activatedAt) return;
  // 処理中かどうかは切替元のウィンドウで全ウィンドウ分まとめて確認済みなので、ここではすぐ再読み込みする
  // （古いアカウントのまま動き続けると、トークン更新時に古いログイン情報で上書きされてしまうため）
  switching = true;
  reloadWindow();
}

// ログイン情報が変わった（Claude のトークン自動更新・新規ログインなど）→ スロットへ保存
function onCredentialChange() {
  if (switching) return; // 切替中の自分の書き込みには反応しない
  try { if (A.sync()) refreshUsage(false); } catch { /* 書き込み途中の読み取りなどは次回に任せる */ }
  refreshUI();
}

// ---------- 起動・終了 ----------

function activate(context) {
  // 起動時に一度同期（初回は今のアカウントを「登録1」として自動登録）
  try { A.sync(); } catch { /* ログイン情報が無い・読めない場合は未登録表示のまま */ }

  statusbar.create(context, 'claudeAccount.quickSwitch', 'claudeAccount.open');

  sidebar = new SidebarProvider(context.extensionUri, {
    getState,
    onMessage: msg => {
      if (msg.type === 'ready') sidebar.post();
      else if (msg.type === 'switch') doSwitch(String(msg.slot));
      else if (msg.type === 'add') doAdd();
      else if (msg.type === 'register') doRegister();
      else if (msg.type === 'refresh') refreshUsage(true);
    }
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeAccount.view', sidebar),
    vscode.commands.registerCommand('claudeAccount.open', () => vscode.commands.executeCommand(VIEW_CONTAINER_COMMAND)),
    vscode.commands.registerCommand('claudeAccount.pick', doPick),
    vscode.commands.registerCommand('claudeAccount.quickSwitch', doQuickSwitch),
    vscode.commands.registerCommand('claudeAccount.add', doAdd),
    vscode.commands.registerCommand('claudeAccount.register', doRegister),
    vscode.commands.registerCommand('claudeAccount.refreshUsage', () => refreshUsage(true)),
    vscode.workspace.onDidChangeConfiguration(e => {
      // 間隔が変わったら次の定時を計算し直す
      if (e.affectsConfiguration('claudeAccount')) { refreshUI(); refreshUsage(false); scheduleUsage(); }
    }),
    // 他ウィンドウで登録が増えた等にも追従できるよう、フォーカスが戻ったら描き直す
    vscode.window.onDidChangeWindowState(s => { if (s.focused) refreshUI(); })
  );

  watch(context, C.CRED_FILE, onCredentialChange);
  watch(context, C.STATE_FILE, onCredentialChange);
  watch(context, C.CURRENT_FILE, refreshUI);
  watch(context, C.USAGE_CACHE_FILE, refreshUI); // 他ウィンドウが取得した残量を反映
  watch(context, C.SWITCH_EVENT_FILE, onSwitchEvent);

  // サイドバーが見えている間だけ「処理中」表示を更新する（見えていないときはファイル走査しない）
  const busyTimer = setInterval(() => { if (sidebar.view?.visible) sidebar.post(); }, BUSY_TICK_MS);
  context.subscriptions.push({ dispose: () => { clearTimeout(usageTimer); clearInterval(busyTimer); } });

  refreshUI();
  refreshUsage(false); // 起動直後: 前回の取得から間隔以上経っていれば 1 回だけ取得
  scheduleUsage();     // 以降は起動中だけ、毎時 5 の倍数分 ±20 秒に取得
}

function deactivate() {}

module.exports = { activate, deactivate };
