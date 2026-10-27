// 自動更新（GitHub Releases から新しい .vsix を取得してインストール）
//
// 流れ:
//   1. GitHub API で最新リリースのタグ（例 "v0.3.0"）と .vsix の URL を取得
//   2. 今の版（package.json の version）より新しければ通知［更新］［後で］
//   3. ［更新］で .vsix を一時フォルダへ保存し、VS Code / Cursor 組み込みのインストールコマンドに渡す
//   4. 拡張の差し替えは再読み込みで反映されるので、再読み込みを促す
// 設定（settings.json）は拡張の外に保存されているので、更新しても消えない。

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./config');

const LAST_CHECK_KEY = 'update.lastCheckAt'; // globalState（全ウィンドウ共通の保存領域）に前回確認時刻を置くキー

function autoCheckEnabled() {
  return vscode.workspace.getConfiguration('claudeAccount').get('update.autoCheck', true);
}

// "v0.3.0" / "0.3.0" → [0, 3, 0]。数字以外の部分（"-beta" 等）は無視する
function parseVersion(v) {
  return String(v || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
}

// a が b より新しければ true。桁ごとに数値で比べる（文字列比較だと "0.10.0" < "0.9.0" になってしまうため）
function isNewer(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// 最新リリースの { version, url } を返す。.vsix が添付されていなければ url は null
async function checkLatest() {
  const res = await fetch(C.UPDATE_API_URL, {
    headers: { 'User-Agent': C.UPDATE_USER_AGENT, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(C.HTTP_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`取得不可 (${res.status})`);
  const body = await res.json();
  const asset = (body.assets || []).find(a => a && /\.vsix$/i.test(a.name || ''));
  return { version: String(body.tag_name || '').replace(/^v/i, ''), url: asset ? asset.browser_download_url : null };
}

// .vsix をダウンロードしてインストールし、再読み込みを促す
async function downloadAndInstall(url, version) {
  const file = path.join(os.tmpdir(), `claude-account-switcher-${version}.vsix`);
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Claude アカウント切替 v${version} をインストールしています…` },
    async () => {
      // github.com の URL は別ホストへリダイレクトされるが、fetch は既定で追従する
      const res = await fetch(url, { headers: { 'User-Agent': C.UPDATE_USER_AGENT } });
      if (!res.ok) throw new Error(`ダウンロード失敗 (${res.status})`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      try {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
      } finally {
        try { fs.unlinkSync(file); } catch { /* 消せなくても一時フォルダなので放置でよい */ }
      }
    });
  const RELOAD = '再読み込み';
  const choice = await vscode.window.showInformationMessage(
    `v${version} をインストールしました。再読み込みすると反映されます。`, RELOAD);
  if (choice === RELOAD) vscode.commands.executeCommand('workbench.action.reloadWindow');
}

// 更新の確認。
//   manual … true ならコマンド・設定画面からの手動確認（結果を必ず表示する）
//            false なら起動時の自動確認（設定オフ・前回から間もない・失敗・最新 のときは何も表示しない）
async function check(context, manual) {
  const current = context.extension.packageJSON.version;
  if (!manual) {
    if (!autoCheckEnabled()) return;
    const last = context.globalState.get(LAST_CHECK_KEY, 0);
    if (Date.now() - last < C.UPDATE_CHECK_INTERVAL_HOURS * 3600 * 1000) return;
    // 失敗しても同じ間隔は空ける（ネットワーク不調時に毎回叩かないため）ので、先に記録する
    await context.globalState.update(LAST_CHECK_KEY, Date.now());
  }

  let latest;
  try {
    latest = manual
      ? await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: '更新を確認しています…' }, checkLatest)
      : await checkLatest();
  } catch (e) {
    if (manual) vscode.window.showErrorMessage(`更新の確認に失敗しました: ${e.message}`);
    return;
  }

  if (!latest.version || !isNewer(latest.version, current)) {
    if (manual) vscode.window.showInformationMessage(`最新版です (v${current})`);
    return;
  }
  if (!latest.url) {
    if (manual) vscode.window.showWarningMessage(`v${latest.version} がありますが、.vsix が添付されていません`);
    return;
  }

  const UPDATE = '更新', LATER = '後で';
  const choice = await vscode.window.showInformationMessage(
    `Claude アカウント切替 v${latest.version} があります（現在 v${current}）`, UPDATE, LATER);
  if (choice !== UPDATE) return;
  try {
    await downloadAndInstall(latest.url, latest.version);
  } catch (e) {
    vscode.window.showErrorMessage(`更新に失敗しました: ${e.message}`);
  }
}

module.exports = { check };
