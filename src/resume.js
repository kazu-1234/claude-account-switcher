// 会話の引継ぎ（アカウント切替の再読み込み後に、直前の会話を開き直す）
//
// 会話ログ ~/.claude/projects/<ワークスペース>/<セッションID>.jsonl はアカウントに関係なく共通なので、
// 切替前に「このワークスペースで最後に使っていた会話の ID」を覚えておき、再読み込み後にその ID で開き直せば、
// これまでの内容を持ったまま新しいアカウントで会話を続けられる。
// 開き直しには Claude Code 拡張の公式 URI ハンドラ（…/open?session=<ID>）を使う。

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const C = require('./config');

// workspaceState（ワークスペースごとの保存領域。再読み込みしても消えない）に使うキー
const STATE_KEY = 'claudeAccount.resume';

// Windows はパスの大文字小文字を区別しないので、比較用に揃える（区切りも \ に統一）
function normPath(p) {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

// ワークスペースのパスに対応する projects 配下のフォルダを探す。
// Claude Code はパスの英数字以外を "-" に置き換えたものをフォルダ名にする（例: c:\Users\a b → c--Users-a-b）。
// ドライブ文字の大小が環境で揺れるので、大文字小文字を無視して比べる
function projectDirOf(folderPath) {
  const want = folderPath.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  let names;
  try { names = fs.readdirSync(C.PROJECTS_DIR); } catch { return null; }
  const hit = names.find(n => n.toLowerCase() === want);
  return hit ? path.join(C.PROJECTS_DIR, hit) : null;
}

// 会話ログの先頭を読み、記録されている作業フォルダ（cwd）を返す。見つからなければ ''
// 日本語などが全部 "-" になるため別のフォルダとフォルダ名が衝突しうるので、中身で本人確認する
function cwdOf(file) {
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(C.RESUME_HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      text = buf.toString('utf8', 0, n);
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
  // 1 行 = 1 件の JSON。読み取りの末尾で切れた行は parse に失敗するだけなので飛ばす
  for (const line of text.split('\n')) {
    try {
      const cwd = JSON.parse(line).cwd;
      if (cwd) return cwd;
    } catch { /* 途中で切れた行・JSON でない行 */ }
  }
  return '';
}

// このワークスペースで最後に更新された会話の ID（= .jsonl のファイル名）。無ければ null
function latestSessionId(folderPath) {
  const dir = projectDirOf(folderPath);
  if (!dir) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  // 直下の .jsonl だけを新しい順に見る（サブフォルダはサブエージェントのログなので対象外）
  const files = entries
    .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
    .map(e => {
      const p = path.join(dir, e.name);
      try { return { p, name: e.name, mtime: fs.statSync(p).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  const want = normPath(folderPath);
  for (const f of files) {
    const cwd = cwdOf(f.p);
    // cwd が読めない（先頭が巨大な行など）場合はフォルダ名の一致を信じて採用する
    if (!cwd || normPath(cwd) === want) return f.name.slice(0, -'.jsonl'.length);
  }
  return null;
}

// 切替の直前に呼ぶ。開き直す会話の ID を覚えておく（フォルダを開いていないウィンドウでは何もしない）
function remember(context) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== 'file') return Promise.resolve();
  const sessionId = latestSessionId(folder.uri.fsPath);
  if (!sessionId) return Promise.resolve();
  return context.workspaceState.update(STATE_KEY, { sessionId, at: Date.now() });
}

// 起動時に呼ぶ。覚えておいた会話があれば開き直す。
//   enabled … false なら開かずに、覚えていた情報だけ消す
async function restore(context, enabled) {
  const saved = context.workspaceState.get(STATE_KEY);
  if (!saved) return;
  // 先に消しておく（開いている最中に再読み込みされても、次の起動で何度も開き直さないように）
  await context.workspaceState.update(STATE_KEY, undefined);
  if (!enabled || !saved.sessionId || Date.now() - saved.at > C.RESUME_MAX_AGE_MS) return;

  try {
    // Claude Code 拡張が起動して URI を受け取れる状態になるまで待つ
    const ext = vscode.extensions.getExtension(C.CLAUDE_CODE_EXT_ID);
    if (!ext) return;
    await ext.activate();
    await new Promise(r => setTimeout(r, C.RESUME_DELAY_MS));
    // uriScheme は VS Code なら "vscode"、Cursor なら "cursor"。既に開いていればそのタブが前に出るだけ
    const uri = vscode.Uri.parse(`${vscode.env.uriScheme}://${C.RESUME_URI_PATH}?session=${encodeURIComponent(saved.sessionId)}`);
    await vscode.env.openExternal(uri);
  } catch { /* 開けなくても切替自体は済んでいるので何もしない */ }
}

module.exports = { remember, restore };
