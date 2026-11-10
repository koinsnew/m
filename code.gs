// =============================================================
//  스마트 지출관리 - 백엔드 API (데이터 · 로그인 · 가족 그룹 전용)
//  · 화면(index.html)은 GitHub가 담당, 이 스크립트는 API 서버
//  · 모든 요청은 POST(JSON). 로그인 후 받은 '토큰'으로 인증한다.
//    (비밀번호는 주소창에 실리지 않고, 시트에는 해시로 저장된다)
//  · 시트 구성
//      Users    : 아이디 | 비밀번호(해시) | 이름 | 그룹ID | 카카오ID | 가입시각
//                 ← 가입은 앱에서 초대코드로(또는 여기서 직접 추가)
//      Data     : 아이디 | 고정지출 데이터(JSON) | 요약(JSON) | 수정시각
//      Groups   : 그룹ID | 이름 | 초대코드 | 만든사람 | 만든시각
//      Entries  : 수입·지출 장부(한 줄 = 한 건, 입력자 포함)
// =============================================================

// 사용자의 구글 시트 ID
const SPREADSHEET_ID = '11qRs3Z6HD__xtBigMhoDC-MahwezU7cCbOoj2YihkY0';

const TZ = 'Asia/Seoul';
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 로그인 유지 30일
const MAX_LOGIN_FAILS = 8;                        // 10분 내 실패 허용 횟수
const MAX_GROUP_MEMBERS = 6;
const ENTRY_HEADERS = ['id', 'groupId', 'owner', 'ownerName', 'type', 'date', 'category', 'amount', 'memo', 'createdAt', 'updatedAt', 'deleted'];
const GROUP_HEADERS = ['groupId', 'name', 'inviteCode', 'createdBy', 'createdAt'];
// 카카오 로그인: 스크립트 속성 KAKAO_REST_KEY, KAKAO_CLIENT_SECRET 에 키 보관
const KAKAO_REDIRECTS = ['https://koinsnew.github.io/m/'];   // 허용된 돌아올 주소

// -------------------------------------------------------------
//  진입점
// -------------------------------------------------------------

/**
 * GET: 상태 확인용. (예전 화면이 보내던 login/load/save 는 보안상 더 이상 받지 않는다)
 * 폰 자동화가 GET 으로 보내는 카드문자(tx)만 선택적으로 허용.
 */
function doGet(e) {
  const p = (e && e.parameter) ? e.parameter : {};
  let result;
  try {
    if (!p.action || p.action === 'ping') {
      result = { success: true, message: 'API 정상 작동 중입니다.' };
    } else if (p.action === 'tx') {
      result = handleSms(p.text || p.message || '', p.username || '', p.key || '');
    } else {
      result = { success: false, code: 'OUTDATED', message: '화면이 업데이트되었습니다. 새로고침 해주세요.' };
    }
  } catch (err) {
    result = { success: false, message: '서버 오류가 발생했습니다.' };
  }
  return outputResult(result, p.callback);
}

/**
 * POST
 *  - 앱: 본문 JSON { action, token, ... }
 *  - 카드문자 자동화: ?action=tx&username=아이디(&key=..) + 본문에 문자 원문
 */
function doPost(e) {
  let result;
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
    if (raw.length > 200000) {
      result = { success: false, message: '요청이 너무 큽니다.' };
    } else {
      let body = {};
      if (raw) { try { body = JSON.parse(raw); } catch (ig) { body = {}; } }
      if (body === null || typeof body !== 'object') body = {};
      const action = p.action || body.action;

      if (action === 'tx') {
        const smsText = body.text || body.message || (p.action ? raw : '');
        result = handleSms(smsText, body.username || p.username || '', body.key || p.key || '');
      } else {
        result = handleApi(action, body);
      }
    }
  } catch (err) {
    result = { success: false, message: '서버 오류: ' + err };
  }
  return outputResult(result, null);
}

function outputResult(obj, callback) {
  const json = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(String(callback).replace(/[^\w.$]/g, '') + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// -------------------------------------------------------------
//  API 라우팅 (login 외에는 전부 토큰 필수)
// -------------------------------------------------------------
function handleApi(action, body) {
  if (action === 'login') return doLogin(body.username, body.password);
  if (action === 'register') return withLock(function () { return doRegister(body); });
  if (action === 'kakaoLogin') return kakaoLogin(body);
  if (action === 'kakaoComplete') return withLock(function () { return kakaoComplete(body); });

  const auth = verifyToken(body.token);
  if (!auth) return { success: false, code: 'AUTH', message: '로그인이 만료되었습니다. 다시 로그인해주세요.' };
  const user = auth.username;

  switch (action) {
    case 'sync':          return syncAll(user, body);
    case 'saveData':      return withLock(function () { return saveUserBlob(user, body); });
    case 'groupCreate':   return withLock(function () { return groupCreate(user, body.name); });
    case 'groupJoin':     return withLock(function () { return groupJoin(user, body.code); });
    case 'groupLeave':    return withLock(function () { return groupLeave(user); });
    case 'entryAdd':      return withLock(function () { return entryAdd(user, body); });
    case 'entryUpdate':   return withLock(function () { return entryUpdate(user, body); });
    case 'entryDelete':   return withLock(function () { return entrySetDeleted(user, body.id, 1); });
    case 'entryRestore':  return withLock(function () { return entrySetDeleted(user, body.id, 0); });
    case 'cardBenefit':   return getCardBenefit(body.query);
    case 'kakaoLink':     return kakaoLink(user, body);
    case 'kakaoUnlink':   return withLock(function () { return kakaoUnlink(user); });
    case 'txList':        return { success: true, list: getRecentTransactions(user, body.limit) };
    default:              return { success: false, message: '알 수 없는 요청입니다.' };
  }
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (e) {
    return { success: false, message: '서버가 바쁩니다. 잠시 후 다시 시도해주세요.' };
  }
  try { return fn(); } finally { lock.releaseLock(); }
}

// -------------------------------------------------------------
//  인증: 비밀번호 해시 · 토큰 · 로그인 시도 제한
// -------------------------------------------------------------
function sha256Hex(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
function hashPw(pw) {
  const salt = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  return 'sha256$' + salt + '$' + sha256Hex(salt + pw);
}
function checkPw(stored, pw) {
  stored = String(stored);
  if (!stored || stored.indexOf('kakao$') === 0) return false;   // 카카오 전용 계정은 비밀번호 로그인 불가
  if (stored.indexOf('sha256$') === 0) {
    const parts = stored.split('$');
    return parts.length === 3 && sha256Hex(parts[1] + pw) === parts[2];
  }
  return stored === String(pw);   // 예전 평문 계정(로그인 성공 시 자동으로 해시로 교체)
}

function getSecret() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('TOKEN_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('TOKEN_SECRET', s); }
  return s;
}
function signToken(username) {
  const payload = username + '|' + (Date.now() + TOKEN_TTL_MS);
  const sig = Utilities.computeHmacSha256Signature(payload, getSecret());
  return Utilities.base64EncodeWebSafe(payload, Utilities.Charset.UTF_8) + '.' + Utilities.base64EncodeWebSafe(sig);
}
function verifyToken(token) {
  try {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
    const expected = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, getSecret()));
    if (expected !== parts[1]) return null;
    const i = payload.lastIndexOf('|');
    const exp = Number(payload.slice(i + 1));
    if (!exp || exp < Date.now()) return null;
    return { username: payload.slice(0, i) };
  } catch (e) { return null; }
}

function failKey(username) { return 'lf_' + sha256Hex(String(username).toLowerCase()).slice(0, 20); }

function doLogin(username, password) {
  username = String(username || '').trim();
  password = String(password || '');
  if (!username || !password) return { success: false, message: '아이디와 비밀번호를 입력해주세요.' };

  const cache = CacheService.getScriptCache();
  const fails = parseInt(cache.get(failKey(username)) || '0', 10);
  if (fails >= MAX_LOGIN_FAILS) {
    return { success: false, message: '로그인 시도가 너무 많습니다. 10분 뒤 다시 시도해주세요.' };
  }

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName('Users');
  if (!sheet) return { success: false, message: '구글 시트에 "Users" 시트를 만들어주세요.' };

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === username && checkPw(data[i][1], password)) {
      cache.remove(failKey(username));
      // 평문 비밀번호는 로그인 성공 시 해시로 교체
      if (String(data[i][1]).indexOf('sha256$') !== 0) sheet.getRange(i + 1, 2).setValue(hashPw(password));
      return {
        success: true, token: signToken(username), username: username,
        name: data[i][2] || username
      };
    }
  }
  cache.put(failKey(username), String(fails + 1), 600);
  return { success: false, message: '아이디 또는 비밀번호가 일치하지 않습니다.' };
}

// -------------------------------------------------------------
//  시트 도우미
// -------------------------------------------------------------
function getSS() { return SpreadsheetApp.openById(SPREADSHEET_ID); }

function getUserInfo(username) {
  const sheet = getSS().getSheetByName('Users');
  if (!sheet) return null;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(username)) {
      return { sheet: sheet, row: i + 1, username: String(data[i][0]), name: data[i][2] || String(data[i][0]), groupId: String(data[i][3] || ''),
        kakaoId: String(data[i][4] || ''), kakaoOnly: String(data[i][1] || '').indexOf('kakao$') === 0 };
    }
  }
  return null;
}

function ensureSheet(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    if (name === 'Entries') sh.getRange('F:F').setNumberFormat('@');   // 날짜가 자동 변환되지 않게 텍스트로
  }
  return sh;
}

function toDateStr(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return String(v || '');
}
function currentYm() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM'); }
function todayStr() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }

// 그룹 변경 감지용 리비전(폴링 시 바뀐 게 없으면 가볍게 응답)
function revKey(user, groupId) { return groupId ? 'rev_g_' + groupId : 'rev_u_' + sha256Hex(user).slice(0, 12); }
function newRev() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function bumpRev(user, groupId) {
  CacheService.getScriptCache().put(revKey(user, groupId), newRev(), 21600);
}
function getRev(user, groupId) {
  const cache = CacheService.getScriptCache();
  let v = cache.get(revKey(user, groupId));
  if (!v) { v = newRev(); cache.put(revKey(user, groupId), v, 21600); }
  return v;
}
function bumpGroupMembersRev(groupId) { if (groupId) CacheService.getScriptCache().put(revKey('', groupId), newRev(), 21600); }

// -------------------------------------------------------------
//  가족 그룹
// -------------------------------------------------------------
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeInviteCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  return s;
}

function getGroupMembers(groupId) {
  const sheet = getSS().getSheetByName('Users');
  const out = [];
  if (!sheet || !groupId) return out;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][3] || '') === groupId) out.push({ username: String(data[i][0]), name: data[i][2] || String(data[i][0]) });
  }
  return out;
}

function getGroupRow(groupId) {
  const sheet = getSS().getSheetByName('Groups');
  if (!sheet || !groupId) return null;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === groupId) return { groupId: groupId, name: String(data[i][1]), inviteCode: String(data[i][2]) };
  }
  return null;
}

function groupCreate(user, name) {
  const me = getUserInfo(user);
  if (!me) return { success: false, message: '계정을 찾을 수 없습니다.' };
  if (me.groupId) return { success: false, message: '이미 가족 그룹에 속해 있습니다.' };

  const ss = getSS();
  const sh = ensureSheet(ss, 'Groups', GROUP_HEADERS);
  const groupId = 'g' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
  const gname = String(name || '').trim().slice(0, 20) || (me.name + '네 가족');
  const code = makeInviteCode();
  sh.appendRow([groupId, gname, code, user, new Date()]);
  me.sheet.getRange(me.row, 4).setValue(groupId);
  bumpRev(user, ''); bumpGroupMembersRev(groupId);
  return { success: true, group: { groupId: groupId, name: gname, inviteCode: code } };
}

function groupJoin(user, code) {
  const me = getUserInfo(user);
  if (!me) return { success: false, message: '계정을 찾을 수 없습니다.' };
  if (me.groupId) return { success: false, message: '이미 가족 그룹에 속해 있습니다. 먼저 나가기를 해주세요.' };

  // 초대코드 무작위 대입 방지: 10분에 10번까지
  const cache = CacheService.getScriptCache();
  const k = 'jf_' + sha256Hex(user).slice(0, 12);
  const tries = parseInt(cache.get(k) || '0', 10);
  if (tries >= 10) return { success: false, message: '시도가 너무 많습니다. 10분 뒤 다시 시도해주세요.' };

  code = String(code || '').trim().toUpperCase();
  const sh = getSS().getSheetByName('Groups');
  let found = null;
  if (sh && code) {
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][2]).toUpperCase() === code) { found = { groupId: String(data[i][0]), name: String(data[i][1]), inviteCode: String(data[i][2]) }; break; }
    }
  }
  if (!found) {
    cache.put(k, String(tries + 1), 600);
    return { success: false, message: '초대 코드를 찾을 수 없습니다. 코드를 다시 확인해주세요.' };
  }
  if (getGroupMembers(found.groupId).length >= MAX_GROUP_MEMBERS) {
    return { success: false, message: '이 그룹은 정원(' + MAX_GROUP_MEMBERS + '명)이 찼습니다.' };
  }
  me.sheet.getRange(me.row, 4).setValue(found.groupId);
  bumpRev(user, ''); bumpGroupMembersRev(found.groupId);
  return { success: true, group: found };
}

function groupLeave(user) {
  const me = getUserInfo(user);
  if (!me) return { success: false, message: '계정을 찾을 수 없습니다.' };
  if (!me.groupId) return { success: true };
  const gid = me.groupId;
  me.sheet.getRange(me.row, 4).setValue('');
  bumpRev(user, ''); bumpGroupMembersRev(gid);
  return { success: true };
}

// -------------------------------------------------------------
//  내 고정지출 데이터(카드·대출·현금) 저장 — 사람별 소유
// -------------------------------------------------------------
function cleanSummary(s) {
  const out = { card: 0, loan: 0, cash: 0, discount: 0, savings: 0, cats: {} };
  if (!s || typeof s !== 'object') return out;
  ['card', 'loan', 'cash', 'discount', 'savings'].forEach(function (k) {
    const n = Number(s[k]);
    out[k] = isFinite(n) && n > 0 ? Math.round(n) : 0;
  });
  if (s.cats && typeof s.cats === 'object') {
    Object.keys(s.cats).slice(0, 40).forEach(function (name) {
      const n = Number(s.cats[name]);
      if (isFinite(n) && n > 0) out.cats[String(name).slice(0, 30)] = Math.round(n);
    });
  }
  return out;
}

function ensureDataSheet(ss) {
  let sheet = ss.getSheetByName('Data');
  if (!sheet) { sheet = ss.insertSheet('Data'); sheet.appendRow(['아이디', '데이터', '요약', '수정시각']); }
  return sheet;
}

function findDataRow(sheet, username) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(username)) return { row: i + 1, data: data[i][1], summary: data[i][2], rev: data[i][3] };
  }
  return null;
}

function saveUserBlob(user, body) {
  const jsonData = body.data;
  if (typeof jsonData !== 'string' || jsonData.length < 2) return { success: false, message: '저장할 데이터가 없습니다.' };
  if (jsonData.length > 49000) return { success: false, message: '데이터가 너무 큽니다. 항목을 줄여주세요.' };
  try { JSON.parse(jsonData); } catch (e) { return { success: false, message: '데이터 형식이 올바르지 않습니다.' }; }

  const sheet = ensureDataSheet(getSS());
  const existing = findDataRow(sheet, user);
  const summary = JSON.stringify(cleanSummary(body.summary));
  const rev = Date.now();

  if (existing) {
    // 다른 기기에서 먼저 저장했다면 덮어쓰지 않고 알려준다
    if (existing.rev && String(body.baseRev || '') !== String(existing.rev) && !body.force) {
      return { success: false, conflict: true, dataRev: String(existing.rev), message: '다른 기기에서 먼저 수정된 내용이 있습니다.' };
    }
    sheet.getRange(existing.row, 2, 1, 3).setValues([[jsonData, summary, rev]]);
  } else {
    sheet.appendRow([user, jsonData, summary, rev]);
  }
  const me = getUserInfo(user);
  bumpRev(user, me ? me.groupId : '');
  if (me && me.groupId) bumpGroupMembersRev(me.groupId);
  return { success: true, dataRev: String(rev) };
}

// -------------------------------------------------------------
//  수입·지출 장부 (Entries)
// -------------------------------------------------------------
function validateEntry(body) {
  const type = body.type === 'income' ? 'income' : (body.type === 'expense' ? 'expense' : '');
  if (!type) return { error: '구분(수입/지출)을 선택해주세요.' };
  const amount = Math.round(Number(body.amount));
  if (!isFinite(amount) || amount <= 0 || amount > 100000000000) return { error: '금액을 올바르게 입력해주세요.' };
  const date = String(body.date || todayStr());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: '날짜 형식이 올바르지 않습니다.' };
  const category = String(body.category || '').trim().slice(0, 30);
  if (!category) return { error: '분류를 선택해주세요.' };
  const memo = String(body.memo || '').trim().slice(0, 100);
  return { value: { type: type, amount: amount, date: date, category: category, memo: memo } };
}

function entryAdd(user, body) {
  const me = getUserInfo(user);
  if (!me) return { success: false, message: '계정을 찾을 수 없습니다.' };
  if (!me.groupId) return { success: false, code: 'NOGROUP', message: '먼저 가족 그룹을 만들거나 참여해주세요.' };
  const v = validateEntry(body);
  if (v.error) return { success: false, message: v.error };

  const sh = ensureSheet(getSS(), 'Entries', ENTRY_HEADERS);
  const id = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const now = Date.now();
  sh.appendRow([id, me.groupId, user, me.name, v.value.type, v.value.date, v.value.category, v.value.amount, v.value.memo, now, now, 0]);
  bumpGroupMembersRev(me.groupId);
  return { success: true, entry: rowToEntry([id, me.groupId, user, me.name, v.value.type, v.value.date, v.value.category, v.value.amount, v.value.memo, now, now, 0]) };
}

function findEntryRow(sh, id) {
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) { if (String(data[i][0]) === String(id)) return { row: i + 1, vals: data[i] }; }
  return null;
}

function entryUpdate(user, body) {
  const me = getUserInfo(user);
  if (!me || !me.groupId) return { success: false, message: '가족 그룹이 필요합니다.' };
  const sh = getSS().getSheetByName('Entries');
  const f = sh ? findEntryRow(sh, body.id) : null;
  if (!f || String(f.vals[1]) !== me.groupId) return { success: false, message: '내역을 찾을 수 없습니다.' };
  if (String(f.vals[2]) !== user) return { success: false, message: '내가 입력한 내역만 수정할 수 있습니다.' };
  const v = validateEntry(body);
  if (v.error) return { success: false, message: v.error };
  const now = Date.now();
  // type, date, category, amount, memo (E..I) + updatedAt (K)
  sh.getRange(f.row, 5, 1, 5).setValues([[v.value.type, v.value.date, v.value.category, v.value.amount, v.value.memo]]);
  sh.getRange(f.row, 11).setValue(now);
  bumpGroupMembersRev(me.groupId);
  return { success: true };
}

function entrySetDeleted(user, id, flag) {
  const me = getUserInfo(user);
  if (!me || !me.groupId) return { success: false, message: '가족 그룹이 필요합니다.' };
  const sh = getSS().getSheetByName('Entries');
  const f = sh ? findEntryRow(sh, id) : null;
  if (!f || String(f.vals[1]) !== me.groupId) return { success: false, message: '내역을 찾을 수 없습니다.' };
  if (String(f.vals[2]) !== user) return { success: false, message: '내가 입력한 내역만 삭제할 수 있습니다.' };
  sh.getRange(f.row, 11, 1, 2).setValues([[Date.now(), flag]]);
  bumpGroupMembersRev(me.groupId);
  return { success: true };
}

function rowToEntry(r) {
  return {
    id: String(r[0]), owner: String(r[2]), ownerName: String(r[3]), type: String(r[4]),
    date: toDateStr(r[5]), category: String(r[6]), amount: Number(r[7]) || 0, memo: String(r[8] || ''),
    createdAt: Number(r[9]) || 0, updatedAt: Number(r[10]) || 0
  };
}

function getGroupEntries(groupId, ym) {
  const sh = getSS().getSheetByName('Entries');
  if (!sh || !groupId) return [];
  const data = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (String(r[1]) !== groupId || Number(r[11]) === 1) continue;
    const e = rowToEntry(r);
    if (e.date.slice(0, 7) !== ym) continue;
    out.push(e);
  }
  out.sort(function (a, b) { return (b.date + String(b.createdAt)).localeCompare(a.date + String(a.createdAt)); });
  return out;
}

// -------------------------------------------------------------
//  동기화: 화면이 주기적으로 호출 → 바뀐 게 없으면 'unchanged'
// -------------------------------------------------------------
function syncAll(user, body) {
  const me = getUserInfo(user);
  if (!me) return { success: false, code: 'AUTH', message: '계정을 찾을 수 없습니다.' };

  const ym = /^\d{4}-\d{2}$/.test(String(body.ym || '')) ? body.ym : currentYm();
  const rev = getRev(user, me.groupId);
  // 내 그룹 변경(rev)과 내 개인 변경(rev_u)을 합쳐서 비교
  const myRev = me.groupId ? getRev(user, '') : rev;
  const combined = rev + ':' + myRev;

  if (!body.force && !body.withData && body.rev && body.rev === combined) {
    return { success: true, unchanged: true, rev: combined, serverTime: Date.now() };
  }

  const out = { success: true, rev: combined, serverTime: Date.now(), ym: ym, me: { username: me.username, name: me.name, groupId: me.groupId, kakao: !!me.kakaoId, kakaoOnly: !!me.kakaoOnly }, group: null, entries: [] };

  const dataSheet = getSS().getSheetByName('Data');
  const mine = dataSheet ? findDataRow(dataSheet, user) : null;
  out.dataRev = mine && mine.rev ? String(mine.rev) : '';
  if (body.withData) out.data = mine ? mine.data : null;

  if (me.groupId) {
    const g = getGroupRow(me.groupId);
    if (g) {
      const members = getGroupMembers(me.groupId).map(function (m) {
        const row = dataSheet ? findDataRow(dataSheet, m.username) : null;
        let summary = null;
        if (row && row.summary) { try { summary = JSON.parse(row.summary); } catch (e) { summary = null; } }
        // 같은 그룹 구성원은 서로의 고정지출(카드·대출·현금) 상세도 볼 수 있다(보기 전용, 수정은 본인만)
        const shared = (m.username !== user && row && row.data) ? row.data : null;
        return { username: m.username, name: m.name, summary: summary, summaryAt: row && row.rev ? Number(row.rev) : 0, data: shared };
      });
      out.group = { groupId: g.groupId, name: g.name, inviteCode: g.inviteCode, members: members };
      out.entries = getGroupEntries(me.groupId, ym);
    }
  }
  return out;
}

// =============================================================
//  카드 혜택 조회 (Google Gemini 호출)
//  · API 키는 프론트엔드에 노출되지 않도록 여기(서버)에서만 사용
//  · 사용 전 준비:
//    1) Google AI Studio(aistudio.google.com)에서 API 키 발급
//    2) Apps Script → 프로젝트 설정(톱니바퀴) → 스크립트 속성 →
//       속성: GEMINI_API_KEY, 값: 발급받은 키  로 저장
//    3) 저장 후 doGet을 한 번 실행하면 외부요청 권한 승인창이 뜸(허용)
// =============================================================
function getCardBenefit(query) {
  query = (query || '').toString().trim();
  if (!query) return { success: false, message: '카드 이름을 입력해주세요.' };

  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) {
    return { success: false, message: 'Gemini API 키가 설정되지 않았습니다. (스크립트 속성 GEMINI_API_KEY 등록 필요)' };
  }

  // 모델명은 시기에 따라 바뀔 수 있음(gemini-2.5-flash / gemini-3.5-flash 등)
  const model = 'gemini-2.5-flash';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key;

  const prompt =
    '한국 신용카드 "' + query + '"의 주요 혜택을 정리해줘.\n' +
    '아래 항목으로 구분해서 간결하게:\n' +
    '1) 연회비\n2) 전월 실적 조건\n3) 주요 할인/적립 혜택 (분야별)\n4) 특징 및 주의사항\n' +
    '정확한 최신 정보 위주로 답하고, 확실하지 않은 부분은 추정하지 말고 "확인 필요"라고 표시해. 한국어로 답해줘.';

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    // 최신 정보를 위해 구글 검색 그라운딩 사용. 만약 도구 관련 오류가 나면 아래 tools 줄을 지우면 됨.
    tools: [{ google_search: {} }]
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const res = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();
    const data = JSON.parse(res.getContentText());

    if (code !== 200) {
      const msg = (data && data.error && data.error.message) ? data.error.message : ('HTTP ' + code);
      return { success: false, message: 'Gemini 오류: ' + msg };
    }

    let text = '';
    const cand = data.candidates && data.candidates[0];
    if (cand && cand.content && cand.content.parts) {
      text = cand.content.parts.map(function (pt) { return pt.text || ''; }).join('');
    }
    return { success: true, text: text || '결과를 가져오지 못했습니다.' };
  } catch (e) {
    return { success: false, message: '요청 실패: ' + e.toString() };
  }
}

// =============================================================
//  카드 문자 자동 기록
//  · 폰 자동화 앱(안드로이드 MacroDroid/Tasker, 아이폰 단축어)에서
//    카드 승인 문자 원문을 이 웹앱 주소로 POST 하면 자동 파싱·기록됨
//    body 예시: { "action":"tx", "username":"내아이디", "text":"문자원문" }
//  · 또는 scanCardEmails()에 시간 트리거를 걸어 메일에서 자동 수집
// =============================================================

// 카드 승인 문자 파싱 (우리카드 등 일반 형식 대응)
function parseCardSms(text) {
  if (!text) return null;
  const t = text.toString().replace(/\r/g, '');
  const lines = t.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l; });

  // 카드사
  let issuer = '';
  const issuerM = t.match(/(우리|삼성|신한|현대|국민|KB|롯데|하나|농협|NH|BC|씨티|카카오|토스)\s*카드/);
  if (issuerM) issuer = issuerM[0].replace(/\s+/g, '');

  // 카드 끝자리 (괄호 안 숫자)
  let last4 = '';
  const l4 = t.match(/\((\d{3,4})\)/);
  if (l4) last4 = l4[1];

  // 승인 / 취소 / 거절
  let type = '승인';
  if (/취소/.test(t)) type = '취소';
  else if (/거절|실패|거부/.test(t)) type = '거절';

  // 결제 방식
  let pay = '';
  const inst = t.match(/할부\s*([0-9]+)\s*개월/) || t.match(/([0-9]+)\s*개월/);
  if (/일시불/.test(t)) pay = '일시불';
  else if (inst) pay = '할부 ' + inst[1] + '개월';

  // 금액 (총누적/누적 뒤의 금액은 제외 → 첫 거래금액만)
  let amount = 0;
  const re = /([0-9][0-9,]*)\s*원/g;
  let mm;
  while ((mm = re.exec(t)) !== null) {
    const before = t.slice(Math.max(0, mm.index - 6), mm.index);
    if (/누적/.test(before)) continue;
    amount = parseInt(mm[1].replace(/,/g, ''), 10);
    break;
  }

  // 누적 금액
  let total = 0;
  const totalM = t.match(/누적\s*([0-9,]+)\s*원/);
  if (totalM) total = parseInt(totalM[1].replace(/,/g, ''), 10);

  // 날짜/시간 (MM/DD HH:mm) — 연도 없으면 올해로
  let datetime = '';
  const dm = t.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (dm) {
    const yr = new Date().getFullYear();
    datetime = yr + '-' + pad2(dm[1]) + '-' + pad2(dm[2]) + ' ' + pad2(dm[3]) + ':' + dm[4];
  }

  // 가맹점 (보통 마지막 줄, 누적 줄이면 그 앞 줄)
  let merchant = '';
  if (lines.length) {
    let last = lines[lines.length - 1];
    if (/누적/.test(last) && lines.length >= 2) last = lines[lines.length - 2];
    merchant = last;
  }

  if (!amount && !merchant) return null;
  return {
    issuer: issuer, last4: last4, type: type, pay: pay,
    amount: amount, total: total, datetime: datetime, merchant: merchant, raw: text.toString()
  };
}

function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

// 파싱 결과를 'Transactions' 시트에 기록
function saveTransaction(text, username) {
  const parsed = parseCardSms(text);
  if (!parsed) return { success: false, message: '문자 형식을 인식하지 못했습니다.' };
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    let sheet = ss.getSheetByName('Transactions');
    if (!sheet) {
      sheet = ss.insertSheet('Transactions');
      sheet.appendRow(['기록시각', '사용자', '카드사', '카드끝자리', '구분', '결제', '거래일시', '가맹점', '금액', '누적', '원문']);
    }
    sheet.appendRow([new Date(), username, parsed.issuer, parsed.last4, parsed.type, parsed.pay, parsed.datetime, parsed.merchant, parsed.amount, parsed.total, parsed.raw]);
    return { success: true, parsed: parsed };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

// 최근 거래내역 조회 (앱에서 표시용)
function getRecentTransactions(username, limit) {
  try {
    limit = parseInt(limit, 10) || 30;
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName('Transactions');
    if (!sheet) return [];
    const data = sheet.getDataRange().getValues();
    const out = [];
    for (let i = data.length - 1; i >= 1 && out.length < limit; i--) {
      const r = data[i];
      if (username && r[1] && r[1] != username) continue;
      out.push({
        card: r[2], last4: r[3], type: r[4], pay: r[5],
        datetime: r[6], merchant: r[7], amount: r[8], total: r[9]
      });
    }
    return out;
  } catch (e) {
    return [];
  }
}

// (선택) 이메일 경유 자동 수집 — Gmail로 들어온 카드 알림을 파싱해 기록
//  · 카드사 알림메일 제목/발신자에 맞게 검색어를 조정하세요
//  · 이 함수에 '시간 기반 트리거'(예: 10분마다)를 걸면 자동 실행됩니다
function scanCardEmails() {
  const query = 'from:(cardnoti OR 우리카드 OR 카드) newer_than:1d is:unread';
  const threads = GmailApp.search(query, 0, 20);
  threads.forEach(function (th) {
    th.getMessages().forEach(function (msg) {
      if (msg.isUnread()) {
        const body = msg.getPlainBody();
        saveTransaction(body, '');   // 필요 시 사용자 매핑 로직 추가
        msg.markRead();
      }
    });
  });
}

// 폰 자동화(문자 전송) 입구 — 스크립트 속성 TX_KEY 를 설정하면 key 가 일치해야만 기록됨
function handleSms(text, username, key) {
  const required = PropertiesService.getScriptProperties().getProperty('TX_KEY');
  if (required && String(key) !== required) return { success: false, message: '인증 키가 올바르지 않습니다.' };
  return saveTransaction(text, username);
}


// =============================================================
//  회원가입 (초대코드 필수) · 카카오 로그인
// =============================================================
// 가입·카카오 시도 남용 방지 (전체 기준 10분에 30번 실패까지)
function signupGuard() {
  const n = parseInt(CacheService.getScriptCache().get('su_fail') || '0', 10);
  return n >= 30 ? { success: false, message: '시도가 너무 많습니다. 10분 뒤 다시 시도해주세요.' } : null;
}
function signupFail(res) {
  const c = CacheService.getScriptCache();
  c.put('su_fail', String(parseInt(c.get('su_fail') || '0', 10) + 1), 600);
  return res;
}
function findInvite(code) {
  code = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return null;
  const sh = getSS().getSheetByName('Groups');
  if (!sh) return null;
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][2]).toUpperCase() === code) return { groupId: String(data[i][0]), name: String(data[i][1]) };
  }
  return null;
}
function usersSheet() {
  const ss = getSS();
  let sh = ss.getSheetByName('Users');
  if (!sh) { sh = ss.insertSheet('Users'); sh.appendRow(['아이디', '비밀번호', '이름', '그룹ID', '카카오ID', '가입시각']); }
  return sh;
}
function usernameTaken(sh, username) {
  const data = sh.getDataRange().getValues(), u = String(username).toLowerCase();
  for (let i = 1; i < data.length; i++) if (String(data[i][0]).toLowerCase() === u) return true;
  return false;
}
function checkInviteForJoin(code) {
  const g = findInvite(code);
  if (!g) return { err: signupFail({ success: false, field: 'invite', message: '초대 코드를 찾을 수 없습니다. 코드를 다시 확인해주세요.' }) };
  if (getGroupMembers(g.groupId).length >= MAX_GROUP_MEMBERS) return { err: { success: false, field: 'invite', message: '이 그룹은 정원(' + MAX_GROUP_MEMBERS + '명)이 찼습니다.' } };
  return { group: g };
}
function cleanName(n) { return String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20); }

function doRegister(body) {
  const g0 = signupGuard(); if (g0) return g0;
  const name = cleanName(body.name);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!name) return { success: false, field: 'name', message: '이름을 입력해주세요.' };
  if (!/^[A-Za-z0-9_.-]{4,20}$/.test(username)) return { success: false, field: 'username', message: '아이디는 영문·숫자 4~20자로 만들어주세요.' };
  if (/^kakao_/i.test(username)) return { success: false, field: 'username', message: '이 아이디는 쓸 수 없습니다.' };
  if (password.length < 8) return { success: false, field: 'password', message: '비밀번호는 8자 이상으로 만들어주세요.' };
  const inv = checkInviteForJoin(body.inviteCode); if (inv.err) return inv.err;
  const sh = usersSheet();
  if (usernameTaken(sh, username)) return { success: false, field: 'username', message: '이미 있는 아이디입니다. 다른 아이디를 써주세요.' };
  sh.appendRow([username, hashPw(password), name, inv.group.groupId, '', new Date()]);
  bumpRev(username, ''); bumpGroupMembersRev(inv.group.groupId);
  return { success: true, token: signToken(username), username: username, name: name, group: inv.group.name };
}

function kakaoKeys() {
  const p = PropertiesService.getScriptProperties();
  return { rest: p.getProperty('KAKAO_REST_KEY') || '', secret: p.getProperty('KAKAO_CLIENT_SECRET') || '' };
}
// 인가 코드 → 카카오 회원번호·닉네임
function kakaoProfile(code, redirectUri) {
  const k = kakaoKeys();
  if (!k.rest) return { error: '카카오 로그인이 아직 설정되지 않았습니다.' };
  if (KAKAO_REDIRECTS.indexOf(String(redirectUri)) < 0) return { error: '허용되지 않은 주소입니다.' };
  if (!code || String(code).length > 512) return { error: '카카오 인증 정보가 올바르지 않습니다.' };
  const payload = { grant_type: 'authorization_code', client_id: k.rest, redirect_uri: redirectUri, code: String(code) };
  if (k.secret) payload.client_secret = k.secret;
  const tr = UrlFetchApp.fetch('https://kauth.kakao.com/oauth/token', { method: 'post', payload: payload, muteHttpExceptions: true });
  let tj = {}; try { tj = JSON.parse(tr.getContentText()); } catch (e) {}
  if (tr.getResponseCode() !== 200 || !tj.access_token) return { error: '카카오 인증이 만료됐어요. 다시 시도해주세요.' };
  const ur = UrlFetchApp.fetch('https://kapi.kakao.com/v2/user/me', { headers: { Authorization: 'Bearer ' + tj.access_token }, muteHttpExceptions: true });
  let uj = {}; try { uj = JSON.parse(ur.getContentText()); } catch (e) {}
  if (ur.getResponseCode() !== 200 || !uj.id) return { error: '카카오 회원 정보를 가져오지 못했습니다.' };
  const nick = (uj.kakao_account && uj.kakao_account.profile && uj.kakao_account.profile.nickname) || (uj.properties && uj.properties.nickname) || '';
  return { id: String(uj.id), nickname: cleanName(nick) };
}
function findByKakao(kid) {
  const sh = getSS().getSheetByName('Users');
  if (!sh || !kid) return null;
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) if (String(data[i][4] || '') === kid) return { row: i + 1, username: String(data[i][0]), name: data[i][2] || String(data[i][0]) };
  return null;
}

function kakaoLogin(body) {
  const g0 = signupGuard(); if (g0) return g0;
  const pf = kakaoProfile(body.code, body.redirectUri);
  if (pf.error) return signupFail({ success: false, message: pf.error });
  const u = findByKakao(pf.id);
  if (u) return { success: true, token: signToken(u.username), username: u.username, name: u.name };
  // 처음 온 카카오 회원: 초대코드를 받아야 가입 (10분짜리 가입표)
  const ticket = Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('kt_' + ticket, JSON.stringify(pf), 600);
  return { success: false, code: 'NEED_INVITE', ticket: ticket, nickname: pf.nickname };
}

function kakaoComplete(body) {
  const g0 = signupGuard(); if (g0) return g0;
  const cache = CacheService.getScriptCache();
  const raw = cache.get('kt_' + String(body.ticket || '').replace(/[^a-f0-9]/g, ''));
  if (!raw) return { success: false, code: 'TICKET', message: '가입 시간이 지났어요. 카카오 로그인을 다시 눌러주세요.' };
  const pf = JSON.parse(raw);
  const exist = findByKakao(pf.id);
  if (exist) { cache.remove('kt_' + body.ticket); return { success: true, token: signToken(exist.username), username: exist.username, name: exist.name }; }
  const name = cleanName(body.name) || pf.nickname || '카카오 사용자';
  const inv = checkInviteForJoin(body.inviteCode); if (inv.err) return inv.err;
  const sh = usersSheet();
  let username = 'kakao_' + pf.id;
  if (usernameTaken(sh, username)) username += '_' + Math.random().toString(36).slice(2, 6);
  sh.appendRow([username, 'kakao$' + Utilities.getUuid(), name, inv.group.groupId, pf.id, new Date()]);
  cache.remove('kt_' + body.ticket);
  bumpRev(username, ''); bumpGroupMembersRev(inv.group.groupId);
  return { success: true, token: signToken(username), username: username, name: name, group: inv.group.name };
}

// 로그인한 계정에 카카오 연결 / 해제
function kakaoLink(user, body) {
  const pf = kakaoProfile(body.code, body.redirectUri);
  if (pf.error) return { success: false, message: pf.error };
  return withLock(function () {
    const other = findByKakao(pf.id);
    if (other && other.username !== user) return { success: false, message: '이 카카오 계정은 이미 다른 계정(' + other.name + ')에 연결돼 있습니다.' };
    const me = getUserInfo(user);
    if (!me) return { success: false, message: '계정을 찾을 수 없습니다.' };
    me.sheet.getRange(me.row, 5).setValue(pf.id);
    bumpRev(user, me.groupId);
    return { success: true, nickname: pf.nickname };
  });
}
function kakaoUnlink(user) {
  const me = getUserInfo(user);
  if (!me) return { success: false, message: '계정을 찾을 수 없습니다.' };
  if (me.kakaoOnly) return { success: false, message: '카카오로 가입한 계정은 연결을 해제할 수 없습니다.' };
  me.sheet.getRange(me.row, 5).setValue('');
  bumpRev(user, me.groupId);
  return { success: true };
}
