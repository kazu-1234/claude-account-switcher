// ステータスバー（VS Code 右下）の表示
//
// 項目 1: 現在のアカウント（例「登録1」）… クリックで切替（登録 2 つなら即切替、3 つ以上なら一覧）
// 項目 2: 現在アカウントの残量（例「5時間 32% · 1週間 18%」）… ツールチップに全登録の残量
// メールアドレスはここには一切出さない（拡張のサイドバー内だけで表示する方針）。

const vscode = require('vscode');
const C = require('./config');
const A = require('./accounts');

let accountItem, usageItem;

// switchCommand … アカウント表示を押したとき（切替）、openCommand … 残量表示を押したとき（サイドバー）
function create(context, switchCommand, openCommand) {
  // 同じ優先度だと並びが不定になるので、アカウント → 残量 の順になるよう 1 ずらす
  accountItem = vscode.window.createStatusBarItem('claudeAccount.account', vscode.StatusBarAlignment.Right, C.STATUS_PRIORITY + 1);
  usageItem = vscode.window.createStatusBarItem('claudeAccount.usage', vscode.StatusBarAlignment.Right, C.STATUS_PRIORITY);
  accountItem.name = 'Claude アカウント';
  usageItem.name = 'Claude 残量';
  accountItem.command = switchCommand;
  usageItem.command = openCommand;
  context.subscriptions.push(accountItem, usageItem);
  accountItem.show();
}

function pctText(u) { return u ? `${Math.round(u.pct)}%` : '--'; }

// 使用率の高い方に合わせて背景色を変える（ステータスバーで使えるのは warning / error の 2 色だけ）
function colorFor(entry) {
  const max = Math.max(entry?.fiveHour?.pct ?? 0, entry?.weekly?.pct ?? 0);
  if (max >= C.ERROR_PERCENT) return new vscode.ThemeColor('statusBarItem.errorBackground');
  if (max >= C.WARN_PERCENT) return new vscode.ThemeColor('statusBarItem.warningBackground');
  return undefined;
}

function update(cache, usageEnabled) {
  const cur = A.getCurrent();
  accountItem.text = `$(account) ${cur ? A.labelOf(cur) : 'Claude: 未登録'}`;
  accountItem.tooltip = 'Claude アカウント（クリックで切替）';

  if (!usageEnabled) { usageItem.hide(); return; }
  const e = cache[cur];
  usageItem.text = `$(pulse) 5時間 ${pctText(e?.fiveHour)} · 1週間 ${pctText(e?.weekly)}`;
  usageItem.backgroundColor = colorFor(e);

  // ツールチップ: 全登録の残量を一覧で（登録N だけで表示）
  const md = new vscode.MarkdownString();
  md.appendMarkdown('**Claude 残量**（5時間枠 / 1週間枠）\n\n');
  for (const s of A.listSavedSlots()) {
    const x = cache[s];
    const mark = s === cur ? '▶ ' : '';
    const err = x?.error ? `（${x.error}）` : '';
    md.appendMarkdown(`${mark}${A.labelOf(s)}: 5時間 ${pctText(x?.fiveHour)} / 1週間 ${pctText(x?.weekly)}${err}\n\n`);
  }
  usageItem.tooltip = md;
  usageItem.show();
}

module.exports = { create, update };
