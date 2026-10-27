// アカウントの保存・切替・追加
//
// 仕組み（switch-account.ps1 と同じ）:
//   ログイン情報 = .credentials.json（トークン）＋ .claude.json の "oauthAccount"（表示用情報）
//   これをスロット（"1", "2", …）ごとに accounts\ へコピーして退避し、切替時に書き戻す。
//   CLAUDE.md・settings.json・skills・memory などは触らないので全アカウント共通のまま。

const fs = require('fs');
const path = require('path');
const C = require('./config');

const OAUTH_KEY = '"oauthAccount"';

// ---------- ファイル読み書きの小道具 ----------

// 読めなければ null。先頭の BOM は JSON.parse の邪魔になるので外す
function readText(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^﻿/, ''); } catch { return null; }
}

// BOM なし UTF-8 で書く（BOM が付くと Claude 側の JSON 読み込みで失敗しうるため）
function writeText(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, { encoding: 'utf8' });
}

function credPath(slot) { return path.join(C.ACCOUNTS_DIR, `${slot}.credentials.json`); }
function oauthPath(slot) { return path.join(C.ACCOUNTS_DIR, `${slot}.oauth.json`); }

function labelOf(slot) { return `${C.LABEL_PREFIX}${slot}`; }

// ---------- .claude.json の oauthAccount 部分だけを扱う ----------
// .claude.json は Claude Code の設定が大量に入った大きなファイル。
// JSON.parse → JSON.stringify で丸ごと書き直すと整形や未知の値の表現が変わるおそれがあるので、
// "oauthAccount": { ... } の { } の範囲だけを括弧の対応で探して差し替え、他は 1 文字も変えない。

function findOauthSpan(text) {
  const keyStart = text.indexOf(OAUTH_KEY);
  if (keyStart < 0) return null;
  const braceStart = text.indexOf('{', keyStart + OAUTH_KEY.length);
  if (braceStart < 0) return null;

  // 値が null の場合（"oauthAccount": null）は { より前に null が来るので対象外にする
  const between = text.slice(keyStart + OAUTH_KEY.length, braceStart);
  if (!/^\s*:\s*$/.test(between)) return null;

  let depth = 0, inStr = false, esc = false;
  for (let i = braceStart; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      // 文字列の中の { } は数えない。\" のエスケープも考慮する
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { keyStart, valueStart: braceStart, valueEnd: i + 1 };
    }
  }
  return null;
}

// 今ログイン中のアカウントの oauthAccount（文字列）。無ければ null
function getActiveOauthText() {
  const state = readText(C.STATE_FILE);
  if (!state) return null;
  const span = findOauthSpan(state);
  return span ? state.slice(span.valueStart, span.valueEnd) : null;
}

// oauthAccount を差し替える（キーが無ければ先頭に追加）
function putOauth(oauthText) {
  let state = readText(C.STATE_FILE) || '{}';
  const span = findOauthSpan(state);
  if (span) {
    state = state.slice(0, span.valueStart) + oauthText + state.slice(span.valueEnd);
  } else {
    const first = state.indexOf('{');
    const rest = state.slice(first + 1).trim();
    // 空オブジェクト {} のときは後ろにカンマを付けない
    const comma = rest.startsWith('}') ? '' : ',';
    state = state.slice(0, first + 1) + `\n  ${OAUTH_KEY}: ${oauthText}${comma}` + state.slice(first + 1);
  }
  writeText(C.STATE_FILE, state);
}

// "oauthAccount": {...} を丸ごと削除する（前後のカンマも整える）
function removeOauth() {
  const state = readText(C.STATE_FILE);
  if (!state) return;
  const span = findOauthSpan(state);
  if (!span) return;
  let start = span.keyStart, end = span.valueEnd;
  const after = state.slice(end);
  // カンマの後ろの改行・空白も一緒に消して、空行が残らないようにする
  const m = after.match(/^\s*,\s*/);
  if (m) {
    end += m[0].length;               // 後ろにカンマがあればそこまで消す
  } else {
    const before = state.slice(0, start).trimEnd();
    if (before.endsWith(',')) start = before.length - 1; // 最後の要素なら直前のカンマを消す
  }
  writeText(C.STATE_FILE, state.slice(0, start) + state.slice(end));
}

// oauthAccount 文字列からアカウントを一意に表す ID を取り出す（同一アカウント判定に使う）
function uuidOf(oauthText) {
  if (!oauthText) return '';
  try { return JSON.parse(oauthText).accountUuid || ''; } catch { return ''; }
}

function emailOf(oauthText) {
  if (!oauthText) return '';
  try { return JSON.parse(oauthText).emailAddress || ''; } catch { return ''; }
}

// ---------- スロット一覧・現在値 ----------

function getCurrent() { return (readText(C.CURRENT_FILE) || '').trim(); }
function setCurrent(slot) { writeText(C.CURRENT_FILE, slot); }

// 保存済みスロット（accounts\<名前>.credentials.json があるもの）。数字順に並べる
function listSavedSlots() {
  let names = [];
  try {
    names = fs.readdirSync(C.ACCOUNTS_DIR)
      .filter(f => f.endsWith('.credentials.json'))
      .map(f => f.slice(0, -'.credentials.json'.length));
  } catch { /* フォルダ未作成ならまだ 0 件 */ }
  return names.sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b));
}

function slotUuid(slot) { return uuidOf(readText(oauthPath(slot))); }

// 次に使う番号。「追加」の途中（current.txt だけ先に新番号になっている）ならその番号を使い回す
function nextSlot() {
  const saved = listSavedSlots();
  const cur = getCurrent();
  if (cur && !saved.includes(cur)) return cur;
  const nums = saved.map(Number).filter(n => Number.isInteger(n));
  return String(nums.length ? Math.max(...nums) + 1 : 1);
}

// 画面表示用の一覧。メールアドレスはサイドバーでだけ使う（ステータスバー等には渡さない）
function listForView() {
  const cur = getCurrent();
  const slots = listSavedSlots();
  if (cur && !slots.includes(cur)) slots.push(cur); // 追加途中でまだ未ログインのスロット
  return slots.map(slot => ({
    slot,
    label: labelOf(slot),
    email: emailOf(readText(oauthPath(slot))),
    current: slot === cur,
    pending: !fs.existsSync(credPath(slot))
  }));
}

// ---------- 同期（いまのログイン情報 → スロットへ保存） ----------
// Claude Code は使用中にトークンを自動更新（refresh）するので、保存済みスロットの中身はすぐ古くなる。
// 起動時・ファイル変化時・切替直前にこれを呼んで、現在スロットへ最新を書き戻す。
// 戻り値: 何かを書き換えたら true
function sync() {
  const credText = readText(C.CRED_FILE);
  if (!credText) return false;          // ログアウト状態（追加の途中など）なら何もしない
  const oauthText = getActiveOauthText();
  const activeUuid = uuidOf(oauthText);
  const saved = listSavedSlots();
  let cur = getCurrent();
  let changed = false;

  if (!cur) {
    // 初回起動: 今のアカウントを自動で登録する（既に同じアカウントがあればそれを現在にする）
    cur = (activeUuid && saved.find(s => slotUuid(s) === activeUuid)) || nextSlot();
    setCurrent(cur);
    changed = true;
  } else if (activeUuid) {
    const curUuid = slotUuid(cur);
    const known = saved.find(s => slotUuid(s) === activeUuid);
    if (curUuid && curUuid !== activeUuid) {
      // この拡張の外（Claude の /login など）でアカウントが変わった → 該当スロットへ付け替える
      cur = known || nextSlot();
      setCurrent(cur);
      changed = true;
    } else if (!curUuid && known && known !== cur) {
      // 「追加」で既に登録済みのアカウントにログインした → 重複させず既存スロットを現在にする
      cur = known;
      setCurrent(cur);
      changed = true;
    }
  } else if (slotUuid(cur)) {
    // ログイン直後でまだ表示用情報が書かれていない。別アカウントのトークンで上書きしないよう待つ
    return changed;
  }

  if (readText(credPath(cur)) !== credText) {
    writeText(credPath(cur), credText);
    changed = true;
  }
  if (oauthText && readText(oauthPath(cur)) !== oauthText) {
    writeText(oauthPath(cur), oauthText);
    changed = true;
  }
  return changed;
}

// ---------- 切替・追加 ----------

// target スロットに切り替える（ファイルの差し替えだけ。再読み込みは呼び出し側）
function switchTo(target) {
  const cred = readText(credPath(target));
  if (!cred) throw new Error(`${labelOf(target)} はまだログインしていません`);
  sync(); // 切替前に、今のアカウントの最新トークンを元のスロットへ書き戻す

  writeText(C.CRED_FILE, cred);
  const oauth = readText(oauthPath(target));
  if (oauth) putOauth(oauth);
  else removeOauth(); // 表示用情報が無いスロットでは前のアカウントの情報を残さない（Claude が取り直す）
  setCurrent(target);
}

// 新しいアカウントを追加するため、ローカルのログイン情報だけを外す。
// /logout はサーバー側でトークンを失効させる可能性があるので使わない。
// 戻り値: 新しいスロット名
function beginAdd() {
  sync();
  const slot = nextSlot();
  try { fs.unlinkSync(C.CRED_FILE); } catch { /* 既に無ければそのまま */ }
  removeOauth();
  setCurrent(slot);
  return slot;
}

module.exports = {
  readText, writeText, credPath, oauthPath, labelOf,
  getCurrent, listSavedSlots, listForView,
  sync, switchTo, beginAdd
};
