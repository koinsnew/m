// =============================================================
//  스마트 지출관리 - 백엔드 API (데이터 · 로그인 · 가족 그룹 전용)
//  · 화면(index.html)은 GitHub가 담당, 이 스크립트는 API 서버
//  · 모든 요청은 POST(JSON). 로그인 후 받은 '토큰'으로 인증한다.
//    (비밀번호는 주소창에 실리지 않고, 시트에는 해시로 저장된다)
//  · 시트 구성
//      Users    : 아이디 | 비밀번호(해시) | 이름 | 그룹ID | 카카오ID | 가입시각 | 상태 | 자동기록키(해시)
//                 ← 로그인은 카카오만. 새 가입은 '대기'로 들어오고 운영자가 앱에서 승인
//                   (상태: 빈칸=사용 중, pending=승인 대기, rejected=거절)
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
// 운영자: 이름이 아래와 같고 예전부터 쓰던(비밀번호가 있는) 계정, 또는 스크립트 속성 ADMIN_USERS(아이디, 쉼표 구분)
const ADMIN_NAMES = ['옥영훈'];
const MAX_PENDING = 30;
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
      result = withLock(function () { return autoTx(p.key || '', p.text || p.message || ''); });
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
        // 폰 자동화: 주소에 ?action=tx&key=개인키, 본문에 알림 글자 그대로 (또는 JSON {key, text})
        const smsText = body.text || body.message || (p.action ? raw : '');
        result = withLock(function () { return autoTx(body.key || p.key || '', smsText); });
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
  if (action === 'login' || action === 'register') return { success: false, message: '이제 카카오 로그인만 사용할 수 있어요.' };
  if (action === 'kakaoLogin') return kakaoLogin(body);
  if (action === 'kakaoMerge') return withLock(function () { return kakaoMerge(body); });
  if (action === 'kakaoApply') return withLock(function () { return kakaoApply(body); });

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
    case 'adminList':     return adminList(user);
    case 'adminDecide':   return withLock(function () { return adminDecide(user, body); });
    case 'autoKeyCreate': return withLock(function () { return autoKeySet(user, true); });
    case 'autoKeyRevoke': return withLock(function () { return autoKeySet(user, false); });
    case 'autoTest':      return autoTest(user, body);
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
        kakaoId: String(data[i][4] || ''), kakaoOnly: String(data[i][1] || '').indexOf('kakao$') === 0, status: String(data[i][6] || ''),
        autoKey: String(data[i][7] || '') };
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

  const out = { success: true, rev: combined, serverTime: Date.now(), ym: ym, me: { username: me.username, name: me.name, groupId: me.groupId, kakao: !!me.kakaoId, kakaoOnly: !!me.kakaoOnly, admin: isAdmin(me), pending: isAdmin(me) ? pendingCount() : 0,
      auto: !!me.autoKey, autoLast: Number(CacheService.getScriptCache().get('al_' + me.username) || 0) || null }, group: null, entries: [] };

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
//  카드 알림 자동 기록
//  · 폰 자동화 앱(안드로이드 MacroDroid)이 카드사 앱 푸시·문자·카톡 알림 글자를
//    https://…/exec?action=tx&key=개인키  로 POST 하면 이달 지출에 자동 기록
//  · 개인키는 앱 설정에서 만들고, 시트에는 해시만 저장(Users H열)
//  · 같은 결제의 알림이 여러 개 와도 한 번만 기록, '취소' 알림은 원래 기록을 지움
// =============================================================
const AUTO_HEADERS = ['dedupe', 'owner', 'entryId', 'status', 'at', 'merchant', 'amount', 'raw'];

function sha256hex(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

// 알림 글자 → { cancel, amount, month, day, hh, mi, last4, merchant }
function parseCardAlert(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (/거절|실패|거부/.test(t)) return { skip: '거절·실패 알림' };
  const cancel = /취소/.test(t);
  // 금액: 누적·잔여·한도 뒤의 금액은 제외
  let amount = 0, amtStr = '';
  const re = /([0-9][0-9,]*)\s*원/g; let m;
  while ((m = re.exec(t)) !== null) {
    if (/(누적|잔여|한도|잔액)[^0-9]{0,8}$/.test(t.slice(Math.max(0, m.index - 14), m.index))) continue;
    amount = parseInt(m[1].replace(/,/g, ''), 10); amtStr = m[0]; break;
  }
  if (!amount) return null;
  // 날짜·시간: 11/10 14:02 · 11.11 09:44 · 2026/11/11 09:44:59 · 11-11 09:44
  const dm = t.match(/(?:\d{4}[./-])?(\d{1,2})[./-](\d{1,2})\.?\s*(\d{1,2}):(\d{2})/);
  const l4 = t.match(/(?:신용|체크|카드)\s*\(?(\d{4})\)?/) || t.match(/(\d{4})\s*(?:승인|취소)/) || t.match(/\((\d{4})\)/);
  // 광고·안내 알림(예: '최대 10,000원 캐시백')은 무시: 승인/취소 글자와 날짜·카드번호 중 하나가 있어야 함
  if (!/승인|취소|사용\s*알림|결제/.test(t) || (!dm && !l4)) return null;
  // 가맹점: 알려진 조각을 지우고 남는 글자
  let s = t.replace(/(누적|잔여|한도|잔액).*$/, '').replace(/(\.\.\.|…).*$/, '').replace(/\[[^\]]*\]/g, ' ');
  if (dm) s = s.replace(dm[0], ' ');
  s = s.replace(amtStr, ' ')
    .replace(/\((결제|승인|취소|승인취소|해외|국내)\)/g, ' ')
    .replace(/(신용|체크)\s*\([^)]*\)/g, ' ')
    .replace(/\(주\)|㈜|주식회사/g, ' ')
    .replace(/[\/|]/g, ' ')
    .replace(/[가-힣A-Za-z]*카드\s*\(?\d{0,4}\)?/g, ' ')
    .replace(/(신용|체크)\s*\d{4}/g, ' ')
    .replace(/[가-힣]{0,2}\*[가-힣]{0,2}\s*님?/g, ' ')
    .replace(/일시불|\d+\s*개월|할부|무이자/g, ' ')
    .replace(/(승인|취소)(완료|되었습니다|됨)?/g, ' ')
    .replace(/KB\s*Pay|사용\s*알림|Web발신/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  return {
    cancel: cancel, amount: amount,
    month: dm ? +dm[1] : 0, day: dm ? +dm[2] : 0, hh: dm ? pad2(dm[3]) : '', mi: dm ? dm[4] : '',
    last4: l4 ? l4[1] : '', merchant: s.slice(0, 40)
  };
}

// 가맹점 이름 → 분류 (앱의 지출 분류에 맞춤)
const AUTO_CATS = [
  ['교통', /주유|오일|에너지|SK네트웍스|GS칼텍스|S-?OIL|현대오일|택시|카카오\s*T|코레일|KTX|SRT|지하철|버스|티머니|하이패스|도로공사|주차|파킹|아마노|쏘카|그린카/i],
  ['장보기', /마트|이마트|홈플러스|롯데마트|코스트코|트레이더스|하나로|농협|킴스클럽|식자재|정육|청과|GS\s*더\s*프레시|노브랜드/i],
  ['의료', /병원|의원|약국|치과|한의원|안과|피부과|소아과|정형외과|내과|검진|메디/i],
  ['교육', /학원|교습|서점|교보문고|영풍문고|예스24|알라딘|어린이집|유치원|학교|에듀/i],
  ['여가', /CGV|메가박스|롯데시네마|넷플릭스|NETFLIX|유튜브|YOUTUBE|디즈니|티빙|웨이브|멜론|스포티파이|골프|볼링|노래|PC방|키즈카페|놀이|여행|호텔|숙박|야놀자|여기어때|에어비앤비|항공/i],
  ['공과금', /한국전력|한전|도시가스|가스공사|수도|관리비|아파트|SKT|KT\s|LG\s*U|통신|인터넷/i],
  ['쇼핑', /쿠팡|11번가|G마켓|옥션|SSG|무신사|올리브영|다이소|네이버\s*페이|네이버페이|카카오페이|29CM|지그재그|백화점|아울렛|유니클로|자라|H&M/i],
  ['식비', /식당|김밥|분식|치킨|피자|버거|맥도날드|롯데리아|KFC|맘스터치|스타벅스|투썸|이디야|메가커피|컴포즈|빽다방|커피|카페|베이커리|파리바게뜨|뚜레쥬르|배달의민족|배민|요기요|쿠팡이츠|편의점|CU|GS25|세븐일레븐|이마트24|국밥|고기|횟집|초밥|스시|면옥|반점|족발|보쌈/i]
];
function guessCategory(merchant) {
  for (let i = 0; i < AUTO_CATS.length; i++) if (AUTO_CATS[i][1].test(merchant)) return AUTO_CATS[i][0];
  return '기타';
}

function findUserByAutoKey(key) {
  if (!/^sx_[A-Za-z0-9]{20,40}$/.test(String(key))) return null;
  const h = sha256hex(key);
  const sh = getSS().getSheetByName('Users'); if (!sh) return null;
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) if (String(data[i][7] || '') === h && !String(data[i][6] || '')) return String(data[i][0]);
  return null;
}

function autoKeySet(user, on) {
  const me = getUserInfo(user);
  if (!me) return { success: false, message: '계정을 찾을 수 없습니다.' };
  if (!on) { me.sheet.getRange(me.row, 8).setValue(''); bumpRev(user, me.groupId); return { success: true }; }
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let key = 'sx_';
  const rnd = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  for (let i = 0; i < 28; i++) key += chars[parseInt(rnd.substr(i * 2, 2), 16) % chars.length];
  me.sheet.getRange(me.row, 8).setValue(sha256hex(key));
  bumpRev(user, me.groupId);
  return { success: true, key: key };
}

// 테스트: 알림 글자를 넣어보면 어떻게 읽히는지 (기록은 안 함)
function autoTest(user, body) {
  const p = parseCardAlert(body.text);
  if (!p) return { success: false, message: '금액을 찾지 못했어요.' };
  if (p.skip) return { success: false, message: p.skip + '은 기록하지 않아요.' };
  return { success: true, parsed: p, category: guessCategory(p.merchant) };
}

function autoTx(key, text) {
  const user = findUserByAutoKey(key);
  if (!user) return { success: false, message: '자동 기록 키가 올바르지 않습니다.' };
  const cache = CacheService.getScriptCache(), ck = 'ar_' + user;
  const used = parseInt(cache.get(ck) || '0', 10);
  if (used >= 200) return { success: false, message: '오늘 자동 기록 한도를 넘었어요.' };
  cache.put(ck, String(used + 1), 21600);
  const p = parseCardAlert(text);
  if (!p) return { success: false, message: '카드 승인 알림이 아니에요.' };
  if (p.skip) return { success: true, skipped: p.skip };
  const me = getUserInfo(user);
  if (!me || !me.groupId) return { success: false, message: '먼저 가족 그룹을 만들거나 참여해주세요.' };

  // 거래 날짜 (연도 없으면 올해, 다음 달 이후로 보이면 작년)
  const now = new Date(Utilities.formatDate(new Date(), 'Asia/Seoul', "yyyy-MM-dd'T'HH:mm:ss"));
  let y = now.getFullYear();
  if (p.month && p.month > now.getMonth() + 2) y -= 1;
  const date = p.month ? y + '-' + pad2(p.month) + '-' + pad2(p.day) : todayStr();
  const dedupe = [user, p.last4, date, p.hh + p.mi, p.amount, p.cancel ? 'C' : 'A'].join('|');

  const ss = getSS(), log = ensureSheet(ss, 'AutoTx', AUTO_HEADERS);
  const rows = log.getDataRange().getValues();
  for (let i = rows.length - 1; i >= 1; i--) if (String(rows[i][0]) === dedupe) return { success: true, duplicate: true };

  if (p.cancel) {
    // 같은 카드·같은 금액의 가장 최근 승인 기록을 지움
    for (let i = rows.length - 1; i >= 1; i--) {
      const r = rows[i];
      if (String(r[1]) !== user || String(r[3]) !== 'ok' || Number(r[6]) !== p.amount) continue;
      const parts = String(r[0]).split('|');
      if (p.last4 && parts[1] && parts[1] !== p.last4) continue;
      const del = entrySetDeleted(user, String(r[2]), 1);
      log.getRange(i + 1, 4).setValue('cancelled');
      log.appendRow([dedupe, user, String(r[2]), 'cancel', new Date(), p.merchant, p.amount, String(text).slice(0, 300)]);
      cache.put('al_' + user, String(Date.now()), 21600 * 4);
      return { success: true, cancelled: !!(del && del.success) };
    }
    log.appendRow([dedupe, user, '', 'cancel-unmatched', new Date(), p.merchant, p.amount, String(text).slice(0, 300)]);
    return { success: true, cancelled: false };
  }

  const merchant = p.merchant || '카드 결제';
  const res = entryAdd(user, { type: 'expense', date: date, category: guessCategory(merchant), amount: p.amount, memo: '[자동] ' + merchant });
  if (!res.success) return res;
  log.appendRow([dedupe, user, res.entry.id, 'ok', new Date(), merchant, p.amount, String(text).slice(0, 300)]);
  cache.put('al_' + user, String(Date.now()), 21600 * 4);
  return { success: true, recorded: { date: date, amount: p.amount, merchant: merchant, category: res.entry.category } };
}


// =============================================================
//  카카오 로그인 · 기존 계정 합치기 · 운영자 승인 가입
// =============================================================
// 남용 방지 (전체 기준 10분에 30번 실패까지)
function signupGuard() {
  const n = parseInt(CacheService.getScriptCache().get('su_fail') || '0', 10);
  return n >= 30 ? { success: false, message: '시도가 너무 많습니다. 10분 뒤 다시 시도해주세요.' } : null;
}
function signupFail(res) {
  const c = CacheService.getScriptCache();
  c.put('su_fail', String(parseInt(c.get('su_fail') || '0', 10) + 1), 600);
  return res;
}
function usersSheet() {
  const ss = getSS();
  let sh = ss.getSheetByName('Users');
  if (!sh) { sh = ss.insertSheet('Users'); sh.appendRow(['아이디', '비밀번호', '이름', '그룹ID', '카카오ID', '가입시각', '상태']); }
  return sh;
}
function usernameTaken(sh, username) {
  const data = sh.getDataRange().getValues(), u = String(username).toLowerCase();
  for (let i = 1; i < data.length; i++) if (String(data[i][0]).toLowerCase() === u) return true;
  return false;
}
function cleanName(n) { return String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20); }

function isAdmin(info) {
  if (!info || info.status) return false;
  const list = String(PropertiesService.getScriptProperties().getProperty('ADMIN_USERS') || '').split(',').map(function (x) { return x.trim(); }).filter(String);
  if (list.indexOf(info.username) >= 0) return true;
  return ADMIN_NAMES.indexOf(String(info.name)) >= 0 && !info.kakaoOnly;
}
function pendingCount() {
  const sh = getSS().getSheetByName('Users'); if (!sh) return 0;
  const data = sh.getDataRange().getValues(); let n = 0;
  for (let i = 1; i < data.length; i++) if (String(data[i][6] || '') === 'pending') n++;
  return n;
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
  for (let i = 1; i < data.length; i++) if (String(data[i][4] || '') === kid) return { row: i + 1, username: String(data[i][0]), name: data[i][2] || String(data[i][0]), status: String(data[i][6] || '') };
  return null;
}
function statusReply(u) {
  if (u.status === 'pending') return { success: false, code: 'PENDING', name: u.name, message: '가입 승인을 기다리고 있어요. 운영자가 승인하면 바로 쓸 수 있어요.' };
  if (u.status === 'rejected') return { success: false, code: 'REJECTED', message: '가입이 승인되지 않았어요. 운영자에게 문의해주세요.' };
  return { success: true, token: signToken(u.username), username: u.username, name: u.name };
}
function takeTicket(ticket) {
  const t = String(ticket || '').replace(/[^a-f0-9]/g, '');
  const raw = t ? CacheService.getScriptCache().get('kt_' + t) : null;
  return raw ? { key: 'kt_' + t, pf: JSON.parse(raw) } : null;
}

// 1) 카카오 로그인: 연결된 계정이면 바로 로그인, 처음이면 '합치기 또는 가입 신청' 선택용 표 발급
function kakaoLogin(body) {
  const g0 = signupGuard(); if (g0) return g0;
  const pf = kakaoProfile(body.code, body.redirectUri);
  if (pf.error) return signupFail({ success: false, message: pf.error });
  const u = findByKakao(pf.id);
  if (u) return statusReply(u);
  const ticket = Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('kt_' + ticket, JSON.stringify(pf), 1200);
  return { success: false, code: 'NEW', ticket: ticket, nickname: pf.nickname };
}

// 2) 예전 아이디·비밀번호를 한 번 확인해 기존 계정에 카카오를 합침 (데이터 그대로)
function kakaoMerge(body) {
  const tk = takeTicket(body.ticket);
  if (!tk) return { success: false, code: 'TICKET', message: '시간이 지났어요. 카카오 로그인을 다시 눌러주세요.' };
  const username = String(body.username || '').trim(), password = String(body.password || '');
  if (!username || !password) return { success: false, message: '예전에 쓰던 아이디와 비밀번호를 입력해주세요.' };
  const cache = CacheService.getScriptCache();
  const fails = parseInt(cache.get(failKey(username)) || '0', 10);
  if (fails >= MAX_LOGIN_FAILS) return { success: false, message: '시도가 너무 많습니다. 10분 뒤 다시 시도해주세요.' };
  const exist = findByKakao(tk.pf.id);
  if (exist) { cache.remove(tk.key); return statusReply(exist); }
  const sh = usersSheet(), data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) !== username || !checkPw(data[i][1], password)) continue;
    if (String(data[i][6] || '')) break;   // 대기·거절 계정은 합칠 수 없음
    if (String(data[i][4] || '')) return { success: false, message: '이 계정은 이미 다른 카카오 계정과 연결돼 있어요.' };
    cache.remove(failKey(username));
    if (String(data[i][1]).indexOf('sha256$') !== 0) sh.getRange(i + 1, 2).setValue(hashPw(password));
    sh.getRange(i + 1, 5).setValue(tk.pf.id);
    cache.remove(tk.key);
    bumpRev(username, String(data[i][3] || ''));
    return { success: true, merged: true, token: signToken(username), username: username, name: data[i][2] || username };
  }
  cache.put(failKey(username), String(fails + 1), 600);
  return { success: false, message: '아이디 또는 비밀번호가 맞지 않아요.' };
}

// 3) 처음 쓰는 사람: 가입 신청 → 운영자 승인 대기
function kakaoApply(body) {
  const tk = takeTicket(body.ticket);
  if (!tk) return { success: false, code: 'TICKET', message: '시간이 지났어요. 카카오 로그인을 다시 눌러주세요.' };
  const exist = findByKakao(tk.pf.id);
  if (exist) { CacheService.getScriptCache().remove(tk.key); return statusReply(exist); }
  if (pendingCount() >= MAX_PENDING) return { success: false, message: '지금은 가입 신청이 많아 받을 수 없어요. 운영자에게 문의해주세요.' };
  const name = cleanName(body.name) || tk.pf.nickname || '카카오 사용자';
  const sh = usersSheet();
  let username = 'kakao_' + tk.pf.id;
  if (usernameTaken(sh, username)) username += '_' + Math.random().toString(36).slice(2, 6);
  sh.appendRow([username, 'kakao$' + Utilities.getUuid(), name, '', tk.pf.id, new Date(), 'pending']);
  CacheService.getScriptCache().remove(tk.key);
  return { success: false, code: 'PENDING', applied: true, name: name, message: '가입 신청을 보냈어요. 운영자가 승인하면 바로 쓸 수 있어요.' };
}

// 로그인한 계정에 카카오 연결 (예전 방식 계정용)
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

// ---------- 운영자: 가입 승인 ----------
function adminList(user) {
  const me = getUserInfo(user);
  if (!isAdmin(me)) return { success: false, message: '운영자만 볼 수 있어요.' };
  const data = me.sheet.getDataRange().getValues(), pending = [], accounts = [];
  for (let i = 1; i < data.length; i++) {
    const st = String(data[i][6] || ''), at = data[i][5] instanceof Date ? data[i][5].getTime() : 0;
    if (st === 'pending') pending.push({ username: String(data[i][0]), name: String(data[i][2] || ''), at: at });
    else if (!st && !String(data[i][4] || '')) accounts.push({ username: String(data[i][0]), name: String(data[i][2] || '') });
  }
  return { success: true, pending: pending, accounts: accounts };
}
// decision: approve | reject | merge(target = 카카오를 아직 연결 안 한 기존 아이디)
function adminDecide(user, body) {
  const me = getUserInfo(user);
  if (!isAdmin(me)) return { success: false, message: '운영자만 할 수 있어요.' };
  const p = getUserInfo(String(body.username || ''));
  if (!p || p.status !== 'pending') return { success: false, message: '이미 처리됐거나 없는 신청이에요.' };
  const d = String(body.decision || '');
  if (d === 'approve') { p.sheet.getRange(p.row, 7).setValue(''); return { success: true }; }
  if (d === 'reject') { p.sheet.getRange(p.row, 7).setValue('rejected'); return { success: true }; }
  if (d === 'merge') {
    const t = getUserInfo(String(body.target || ''));
    if (!t || t.status || t.kakaoId) return { success: false, message: '합칠 수 있는 기존 계정이 아니에요.' };
    t.sheet.getRange(t.row, 5).setValue(p.kakaoId);
    p.sheet.deleteRow(p.row);
    bumpRev(t.username, t.groupId);
    return { success: true };
  }
  return { success: false, message: '알 수 없는 처리예요.' };
}
