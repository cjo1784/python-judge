// 공통: 화면 도우미, 구글 로그인, 서버 호출 (index.html과 admin.html이 함께 쓴다)

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const errText = e => esc((e && e.message || String(e)).replace(/^Error: /, ''));

// ---------- 로그인 상태 ----------
// 구글 로그인 ID 토큰(1시간 유효)은 이 창(sessionStorage)에만 둔다. 창을 닫으면 로그아웃된다 (공용 PC 대비).
// session.in: '1' = 로그인해서 들어옴, 'guest' = 손님, '' = 아직 고르지 않음
const session = {
  get in() { try { return sessionStorage.getItem('in') || ''; } catch (e) { return ''; } },
  set in(v) { try { sessionStorage.setItem('in', v || ''); } catch (e) {} },
};
function jwtPayload(t) {
  try {
    const b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(Array.from(atob(b), c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')));
  } catch (e) { return null; }
}
const Auth = {
  // 만료 1분 전부터는 없는 것으로 본다
  get token() {
    let t = '';
    try { t = sessionStorage.getItem('idtoken') || ''; } catch (e) {}
    const p = t && jwtPayload(t);
    return p && p.exp * 1000 > Date.now() + 60000 ? t : null;
  },
  set(t) { try { sessionStorage.setItem('idtoken', t); } catch (e) {} session.in = '1'; },
  clear() { try { sessionStorage.removeItem('idtoken'); } catch (e) {} },
};
function logout() {
  Auth.clear(); session.in = '';
  try { google.accounts.id.disableAutoSelect(); } catch (e) {}
  location.reload();
}

// ---------- 구글 로그인 버튼 (Google Identity Services) ----------
let gisLoaded;
const gisReady = new Promise(ok => { gisLoaded = ok; });
let onSignedIn = () => {};
gisReady.then(() => {
  if (!CONFIG.CLIENT_ID) return;
  google.accounts.id.initialize({
    client_id: CONFIG.CLIENT_ID,
    hd: CONFIG.DOMAIN,          // 학교 계정을 먼저 보여 준다
    auto_select: true,          // 전에 로그인한 계정이 하나면 자동으로 다시 로그인
    callback: r => { Auth.set(r.credential); onSignedIn(); },
  });
});
// el 안에 구글 로그인 버튼을 그린다. 설정 전이면 false.
async function renderGoogleButton(el) {
  if (!CONFIG.CLIENT_ID || !el) return false;
  await gisReady;
  google.accounts.id.renderButton(el, { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'signin_with', locale: 'ko', width: Math.min(el.clientWidth || 320, 400) });
  return true;
}

// ---------- 서버 호출 ----------
// 브라우저의 구글 쿠키를 보내지 않으므로(다른 주소에서 부르는 fetch) 구글 계정이 여러 개여도 문제없다.
// - 읽기 요청은 8초 안에 응답이 없으면 자동으로 다시 보낸다 (최대 3번). 여러 번 보내도 결과가 같다.
// - 쓰기 요청(제출, 승인, 초기화)은 중복되면 안 되므로 다시 보내지 않고 90초 뒤에 안내한다.
const READS = ['init', 'getProblems', 'getProblem', 'adminData', 'adminProblemDetail'];
let onAuthExpired = () => {};
async function callOnce(fn, args, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  let r;
  try {
    const res = await fetch(CONFIG.API, {
      method: 'POST', signal: ctl.signal, // 본문을 문자열로 보내 CORS 사전 요청 없이 간다
      body: JSON.stringify({ fn, args, token: Auth.token || '' }),
    });
    r = await res.json();
  } catch (e) {
    throw new Error('NO_RESPONSE');
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) { const e = new Error(r.error); e.code = r.code; throw e; }
  return r.data;
}
async function api(fn, ...args) {
  // 로그인해서 쓰던 중 토큰이 만료됐으면 손님으로 보내지 않고 다시 로그인하게 한다 (기록이 저장되지 않는 일 방지)
  if (session.in === '1' && !Auth.token) {
    const e = new Error('로그인이 만료됐어요. 다시 로그인해 주세요.'); e.code = 'AUTH';
    onAuthExpired(e); throw e;
  }
  const tries = READS.includes(fn) ? 3 : 1;
  for (let i = 1; ; i++) {
    try { return await callOnce(fn, args, tries > 1 ? 8000 : 90000); }
    catch (e) {
      if (e.code === 'AUTH' || e.code === 'DOMAIN') { Auth.clear(); onAuthExpired(e); throw e; }
      if (e.message !== 'NO_RESPONSE') throw e;
      if (i >= tries) throw new Error('서버에 연결하지 못했어요. 인터넷 연결을 확인하고 잠시 뒤 다시 시도해 주세요.');
    }
  }
}
