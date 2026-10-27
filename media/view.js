// サイドバーのページ側スクリプト
// 拡張から届いた state を元にカードを描き直し、ボタン操作を拡張へ送る。

(function () {
  const vscode = acquireVsCodeApi(); // 拡張との通信口（1 ページで 1 回だけ取得できる）
  const $ = id => document.getElementById(id);

  // ===== 調整値 =====
  const WARN_PERCENT = 80;
  const ERROR_PERCENT = 95;
  const TICK_MS = 30 * 1000; // 「あと◯時間」表示を描き直す間隔
  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']; // Date.getDay() の 0=日 … 6=土
  // ==================

  let state = null;

  // 時刻を「15:40」の形に（2 桁ゼロ埋め）
  function hhmm(date) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  // リセットまでの残り時間と更新時刻を
  //   5時間枠: 「あと 3時間12分（15:40 更新）」
  //   週枠   : 「あと 2日5時間（金 14:00 更新）」（withWeekday = true のとき曜日を付ける）
  // の形にする。
  function untilText(iso, withWeekday) {
    if (!iso) return '';
    const at = new Date(iso);
    const ms = at.getTime() - Date.now();
    if (!(ms > 0)) return 'まもなくリセット';
    const min = Math.floor(ms / 60000);
    const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
    let left;
    if (d > 0) left = `あと ${d}日${h}時間`;
    else if (h > 0) left = `あと ${h}時間${m}分`;
    else left = `あと ${m}分`;
    const when = withWeekday ? `${WEEKDAYS[at.getDay()]} ${hhmm(at)}` : hhmm(at);
    return `${left}（${when} 更新）`;
  }

  function level(pct) {
    if (pct >= ERROR_PERCENT) return 'error';
    if (pct >= WARN_PERCENT) return 'warn';
    return 'ok';
  }

  // 使用率バー 1 本分の要素を作る（textContent を使い、HTML として解釈させない）
  //   withWeekday … true なら更新時刻に曜日を付ける（週枠用）
  function bar(title, u, withWeekday) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const head = document.createElement('div');
    head.className = 'bar-head';
    const left = document.createElement('span');
    left.textContent = `${title} ${u ? Math.round(u.pct) + '%' : '--'}`;
    const right = document.createElement('span');
    right.className = 'muted';
    right.textContent = u ? untilText(u.resetsAt, withWeekday) : '';
    head.append(left, right);

    const track = document.createElement('div');
    track.className = 'track';
    const fill = document.createElement('div');
    fill.className = `fill ${u ? level(u.pct) : ''}`;
    fill.style.width = `${u ? Math.min(100, Math.max(0, u.pct)) : 0}%`;
    track.append(fill);
    row.append(head, track);
    return row;
  }

  function render() {
    if (!state) return;
    const list = $('list');
    list.textContent = '';

    if (state.slots.length === 0) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'まだ登録がありません。Claude にログインした状態で「今のアカウントを登録」を押してください。';
      list.append(p);
    }

    for (const s of state.slots) {
      const card = document.createElement('div');
      card.className = 'card' + (s.current ? ' current' : '');

      const head = document.createElement('div');
      head.className = 'card-head';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = s.label + (s.current ? '（使用中）' : '');
      head.append(name);

      // 切替ボタン: 使用中・未ログイン・切替処理中は押せない
      const switchable = !(s.current || s.pending || state.switching);
      const requestSwitch = () => vscode.postMessage({ type: 'switch', slot: s.slot });
      const btn = document.createElement('button');
      btn.textContent = s.current ? '使用中' : '切替';
      btn.disabled = !switchable;
      btn.addEventListener('click', e => {
        // ボタンのクリックがカード側にも伝わって 2 回送られないよう、ここで止める
        e.stopPropagation();
        requestSwitch();
      });

      // カードの枠のどこを押しても切り替えられるようにする（切替できるカードだけ）
      if (switchable) {
        card.classList.add('clickable');
        card.title = `${s.label} に切り替え`;
        card.addEventListener('click', requestSwitch);
      }
      head.append(btn);
      card.append(head);

      const email = document.createElement('div');
      email.className = 'muted email';
      email.textContent = s.pending ? '未ログイン（Claude パネルでログインしてください）' : (s.email || 'メール不明');
      card.append(email);

      if (state.usageEnabled && !s.pending) {
        card.append(bar('5時間', s.usage?.fiveHour, false), bar('週', s.usage?.weekly, true));
        if (s.usage?.error) {
          const err = document.createElement('div');
          err.className = 'err';
          err.textContent = s.usage.error;
          card.append(err);
        }
      }
      list.append(card);
    }

    $('busy').hidden = !state.busy;
    $('refresh').hidden = !state.usageEnabled;
    $('refresh').disabled = !!state.refreshing;
    $('updated').textContent = state.updatedAt ? `残量更新: ${new Date(state.updatedAt).toLocaleTimeString()}` : '';
  }

  window.addEventListener('message', e => {
    if (e.data?.type === 'state') { state = e.data; render(); }
  });
  $('add').addEventListener('click', () => vscode.postMessage({ type: 'add' }));
  $('register').addEventListener('click', () => vscode.postMessage({ type: 'register' }));
  $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

  setInterval(render, TICK_MS);
  vscode.postMessage({ type: 'ready' }); // 準備できたので最初の state を要求
})();
