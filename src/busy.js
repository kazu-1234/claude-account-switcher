// Claude Code が「処理中」かどうかの判定
//
// Claude Code は会話の内容を ~/.claude/projects/<プロジェクト>/<セッション>.jsonl に逐次追記していく。
// 応答の生成中・ツール実行中はこのファイルが数秒おきに更新されるので、
// 「どれかの .jsonl が直近 N 秒以内に更新されたか」で処理中を判定する。
// VS Code・Cursor・ターミナル版のどれで動いていても同じ場所に書くので、全ウィンドウ分をまとめて見られる。

const fs = require('fs');
const path = require('path');
const C = require('./config');

// projects 配下の .jsonl のうち、最も新しい更新時刻（ミリ秒）を返す
function lastActivityMs(dir = C.PROJECTS_DIR, depth = C.SCAN_DEPTH) {
  let latest = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      // サブエージェントのログはセッション名のサブフォルダに入るので数階層だけ潜る
      if (depth > 1) latest = Math.max(latest, lastActivityMs(p, depth - 1));
    } else if (e.name.endsWith('.jsonl')) {
      try { latest = Math.max(latest, fs.statSync(p).mtimeMs); } catch { /* 途中で消えたファイル */ }
    }
  }
  return latest;
}

function isBusy() {
  return Date.now() - lastActivityMs() < C.BUSY_SECONDS * 1000;
}

// ログの更新が IDLE_SECONDS 秒止まるまで待つ。
// isCancelled() が true を返したら中断して false を返す。終わるのを確認できたら true。
function waitUntilIdle(isCancelled) {
  return new Promise(resolve => {
    const timer = setInterval(() => {
      if (isCancelled()) { clearInterval(timer); resolve(false); return; }
      if (Date.now() - lastActivityMs() >= C.IDLE_SECONDS * 1000) { clearInterval(timer); resolve(true); }
    }, C.WAIT_POLL_MS);
  });
}

module.exports = { isBusy, waitUntilIdle };
