// サイドバー（アクティビティバーのアイコンから開くパネル）
//
// Webview（パネル内に表示する小さな Web ページ）で、登録ごとのカードを描く。
// 拡張側 ⇔ ページ側は postMessage でやり取りする:
//   拡張 → ページ: { type: 'state', ... } 表示データ一式
//   ページ → 拡張: { type: 'switch', slot } / { type: 'add' } / { type: 'register' } / { type: 'refresh' } / { type: 'ready' }
//                  { type: 'checkUpdate' } / { type: 'setAutoUpdate', value } / { type: 'setResume', value }（設定の枠）

const vscode = require('vscode');
const crypto = require('crypto');

class SidebarProvider {
  constructor(extensionUri, handlers) {
    this.extensionUri = extensionUri;
    this.handlers = handlers; // { onMessage(msg), getState() }
    this.view = null;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(msg => this.handlers.onMessage(msg));
    // 非表示 → 再表示のときに最新状態を描き直す
    view.onDidChangeVisibility(() => { if (view.visible) this.post(); });
    view.onDidDispose(() => { this.view = null; });
  }

  // 現在の状態をページへ送る（パネルが閉じていれば何もしない）
  post() {
    if (!this.view) return;
    this.view.webview.postMessage({ type: 'state', ...this.handlers.getState() });
  }

  html(webview) {
    const media = name => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name));
    // CSP（読み込めるものの制限）。nonce が一致するスクリプトだけ実行を許可する
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('view.css')}">
</head>
<body>
  <div id="list"></div>
  <div id="busy" class="busy" hidden>Claude が処理中です</div>
  <div class="actions">
    <button id="add">＋ アカウントを追加</button>
    <button id="register" class="secondary">今のアカウントを登録</button>
    <button id="refresh" class="secondary">残量を更新</button>
  </div>
  <div id="updated" class="muted"></div>
  <!-- 設定の枠: 拡張の更新に関する操作をまとめる -->
  <div class="settings">
    <div class="section-title">設定</div>
    <label class="toggle"><input type="checkbox" id="autoUpdate"> 起動時に更新を自動確認</label>
    <label class="toggle"><input type="checkbox" id="resume"> 切替後に直前の会話を引き継ぐ</label>
    <button id="checkUpdate" class="secondary">更新を確認</button>
    <div id="version" class="muted"></div>
  </div>
  <script nonce="${nonce}" src="${media('view.js')}"></script>
</body>
</html>`;
  }
}

module.exports = { SidebarProvider };
