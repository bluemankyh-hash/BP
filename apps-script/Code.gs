/**
 * 혈압 관리 웹앱 — 서버 코드 (Google Apps Script)
 *
 * 구조:  [화면: GitHub Pages]  ⇄ (doPost JSON) ⇄  [API 함수 api*]  ⇄  [저장소 Repo]  ⇄  [구글 시트]
 *        카카오 로그인 돌아오기·카톡 버튼은 doGet이 처리합니다.
 *
 * ▶ B안(정식 앱 + 데이터베이스)으로 옮길 때는 아래 "저장소(Repo)" 부분만
 *   Firebase/Supabase 호출로 바꾸면 됩니다. 화면과 API 함수는 그대로 둡니다.
 */

// ───────────────────────── 설정 ─────────────────────────
const CONFIG = {
  SHEET_RECORDS: '기록',
  SHEET_MEALS: '식사',
  SHEET_CUSTOM_FOODS: '내음식사전',
  SHEET_RESTAURANTS: '식당',
  SHEET_COURSES: '코스',
  SHEET_RUNS: '러닝',
  // 1행 제목(영문 키). 나중에 데이터베이스로 옮길 때 이 이름이 그대로 칸 이름이 됩니다.
  RECORD_COLUMNS: ['date', 'systolic', 'diastolic', 'pulse', 'weight_kg', 'run_km', 'memo', 'updated_at'],
  MEAL_COLUMNS: ['id', 'date', 'meal', 'food', 'matched', 'qty', 'unit', 'kcal', 'sodium_mg', 'source', 'created_at'],
  CUSTOM_FOOD_COLUMNS: ['name', 'unit', 'kcal', 'sodium_mg', 'updated_at'],
  RESTAURANT_COLUMNS: ['id', 'name', 'category', 'address', 'phone', 'tip', 'link', 'created_at'],
  COURSE_COLUMNS: ['id', 'name', 'km', 'points', 'created_at'],
  RUN_COLUMNS: ['id', 'date', 'started_at', 'km', 'duration_s', 'pace', 'kcal', 'points', 'source', 'created_at'],
  FRONTEND_URL: 'https://bluemankyh-hash.github.io/BP/', // 화면 주소 (스크립트 속성 FRONTEND_URL로 바꿀 수 있음)
  DEFAULT_CENTER: { lat: 35.5038, lng: 128.7466 }, // 밀양시청 부근
  TZ: 'Asia/Seoul',
  SODIUM_GOAL: 2000,
  // 카톡 알림: 종류별 실행 함수와 시각
  NOTIFY: {
    morning: { fn: 'notifyMorning', hour: 8, label: '아침 8시 혈압 알림' },
    evening: { fn: 'notifyEvening', hour: 20, label: '저녁 8시 운동 확인' },
    weekly: { fn: 'notifyWeekly', hour: 8, weekday: 'MONDAY', label: '월요일 8시 주간 리포트' },
  },
  TEXT_COLUMNS: ['date', 'updated_at', 'created_at', 'id', 'phone', 'started_at', 'pace'], // 구글 시트가 날짜·숫자로 바꾸지 않도록 글자 형식으로 고정
  MEALS: ['아침', '점심', '저녁', '간식'],
  SEARCH_RADIUS_M: 10000, // 반경 10km
};

// 저염 친화 메뉴 테마 (검색어 + 주문 팁)
const LOW_SALT_THEMES = [
  { key: 'shabu', label: '샤브샤브·월남쌈', queries: ['샤브샤브', '월남쌈'], tip: '육수는 마시지 말고 채소·고기 위주로. 마지막 칼국수·죽은 생략하세요.' },
  { key: 'salad', label: '샐러드·포케', queries: ['샐러드', '포케'], tip: '드레싱은 따로 달라고 해서 절반만 쓰세요.' },
  { key: 'fish', label: '생선구이', queries: ['생선구이'], tip: '간장·쌈장은 찍지 말고, 국·찌개는 건더기만 드세요.' },
  { key: 'tofu', label: '두부·쌈밥', queries: ['두부요리', '쌈밥'], tip: '쌈장은 조금만, 찌개 국물은 남기세요.' },
  { key: 'bibim', label: '비빔밥', queries: ['비빔밥'], tip: '고추장은 따로 받아서 반만 넣으세요.' },
];

// ───────────────────────── 웹앱 진입점 ─────────────────────────
/**
 * 웹앱 입구. 주소 뒤에 붙는 값에 따라 나뉩니다.
 *  ?k=비밀열쇠          → 앱 화면
 *  ?code=…&state=…     → 카카오 로그인에서 돌아온 경우 (카톡 연결)
 *  ?act=…&t=…          → 카톡 메시지 버튼 (러닝 한 번에 기록)
 */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.code || p.error) return handleKakaoCallback_(p);
  if (p.act) return handleAction_(p);
  if (keyOk_('APP_KEY', p.k)) {
    return page_('앱 주소가 바뀌었어요', '<p>혈압 관리 앱이 새 주소로 옮겼습니다. 아래 버튼으로 열고 홈 화면에 다시 추가해 주세요.</p>' + backLink_());
  }
  return page_('혈압 관리 데이터 서버', '<p class="s">이 주소는 앱의 데이터 저장소입니다. Apps Script 편집기에서 <b>showMyLinks</b>를 실행하면 내 앱 주소가 나옵니다.</p>');
}

/** 화면(GitHub Pages)이 데이터를 주고받는 입구. 요청: {k: 비밀열쇠, fn: 함수 이름, args: [...]} */
function doPost(e) {
  let req = {};
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { req = {}; }
  if (!keyOk_('APP_KEY', req.k)) return json_({ ok: false, error: '열쇠가 맞지 않습니다. showMyLinks로 받은 주소로 다시 열어 주세요.', code: 'KEY' });
  const fn = API_FUNCS[req.fn];
  if (!fn) return json_({ ok: false, error: '알 수 없는 요청입니다: ' + req.fn });
  try {
    return json_({ ok: true, data: fn.apply(null, Array.isArray(req.args) ? req.args : []) });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** 화면에서 부를 수 있는 함수 목록 (여기 없는 함수는 밖에서 부를 수 없습니다) */
const API_FUNCS = {
  apiGetData: apiGetData, apiSaveRecord: apiSaveRecord, apiDeleteRecord: apiDeleteRecord,
  apiAddMeals: apiAddMeals, apiDeleteMeal: apiDeleteMeal,
  apiSaveRestaurant: apiSaveRestaurant, apiDeleteRestaurant: apiDeleteRestaurant,
  apiAddPlace: apiAddPlace, apiDeletePlace: apiDeletePlace, apiSearchRestaurants: apiSearchRestaurants,
  apiSaveCourse: apiSaveCourse, apiDeleteCourse: apiDeleteCourse, apiWalkSegment: apiWalkSegment,
  apiSaveRun: apiSaveRun, apiDeleteRun: apiDeleteRun,
  apiSetNotify: apiSetNotify, apiSendTest: apiSendTest, apiUnlinkKakao: apiUnlinkKakao,
};

/**
 * 최초 1회(그리고 코드를 새 버전으로 바꾼 뒤 1회): 편집기에서 이 함수를 선택해 [실행]하세요.
 * 시트 탭과 제목 줄을 만들고, 이 스프레드시트를 앱의 저장소로 등록합니다. 여러 번 실행해도 안전합니다.
 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('구글 시트의 [확장 프로그램 → Apps Script]에서 연 프로젝트에서 실행해 주세요.');
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', ss.getId());
  if (!props.getProperty('APP_KEY')) props.setProperty('APP_KEY', randomKey_());
  if (!props.getProperty('ACTION_KEY')) props.setProperty('ACTION_KEY', randomKey_());
  ensureSheet_(ss, CONFIG.SHEET_RECORDS, CONFIG.RECORD_COLUMNS);
  ensureSheet_(ss, CONFIG.SHEET_MEALS, CONFIG.MEAL_COLUMNS);
  ensureSheet_(ss, CONFIG.SHEET_CUSTOM_FOODS, CONFIG.CUSTOM_FOOD_COLUMNS);
  ensureSheet_(ss, CONFIG.SHEET_RESTAURANTS, CONFIG.RESTAURANT_COLUMNS);
  ensureSheet_(ss, CONFIG.SHEET_COURSES, CONFIG.COURSE_COLUMNS);
  ensureSheet_(ss, CONFIG.SHEET_RUNS, CONFIG.RUN_COLUMNS);
  Logger.log('준비 완료: ' + ss.getName());
}

// ───────────────────────── API (화면에서 호출) ─────────────────────────
function apiGetData() {
  const props = PropertiesService.getScriptProperties();
  return {
    records: Repo.listRecords(),
    meals: Repo.listMeals(),
    customFoods: Repo.listCustomFoods(),
    foods: foodDb_(),
    restaurants: Repo.listRestaurants(),
    courses: Repo.listCourses(),
    runs: Repo.listRuns().slice(-60),
    places: listPlaces_(),
    settings: {
      hasKakaoKey: !!props.getProperty('KAKAO_REST_KEY'),
      center: CONFIG.DEFAULT_CENTER,
      kakao: kakaoStatus_(),
    },
    themes: LOW_SALT_THEMES.map(function (t) { return { key: t.key, label: t.label }; }),
  };
}

function apiSaveRecord(input) {
  const rec = cleanRecord_(input);
  rec.updated_at = nowText_();
  withLock_(function () { Repo.upsertRecord(rec); });
  return Repo.listRecords();
}

function apiDeleteRecord(date) {
  withLock_(function () { Repo.deleteRecord(String(date)); });
  return Repo.listRecords();
}

/**
 * 한 끼에 먹은 음식들을 저장합니다.
 * items: [{ food, matched, qty, unit, kcal, sodium_mg, source, remember }]
 * remember가 true인 항목은 '내음식사전'에 1단위 기준으로 저장해 다음부터 자동 계산합니다.
 */
function apiAddMeals(date, meal, items) {
  date = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('날짜 형식이 올바르지 않습니다.');
  if (CONFIG.MEALS.indexOf(meal) < 0) throw new Error('아침·점심·저녁·간식 중에서 골라 주세요.');
  if (!items || !items.length) throw new Error('먹은 음식을 입력해 주세요.');
  if (items.length > 30) throw new Error('한 번에 30개까지 입력할 수 있습니다.');
  const now = nowText_();
  const rows = items.map(function (it) {
    const m = cleanMealItem_(it);
    m.id = Utilities.getUuid(); m.date = date; m.meal = meal; m.created_at = now;
    return m;
  });
  withLock_(function () {
    Repo.addMeals(rows);
    items.forEach(function (it, i) {
      const r = rows[i];
      if (it && it.remember && r.kcal !== '' && r.qty > 0) {
        Repo.upsertCustomFood({
          name: r.food, unit: r.unit || '1회',
          kcal: Math.round(r.kcal / r.qty),
          sodium_mg: r.sodium_mg === '' ? '' : Math.round(r.sodium_mg / r.qty),
          updated_at: now,
        });
      }
    });
  });
  return { meals: Repo.listMeals(), customFoods: Repo.listCustomFoods() };
}

function apiDeleteMeal(id) {
  withLock_(function () { Repo.deleteMeal(String(id)); });
  return Repo.listMeals();
}

function apiSaveRestaurant(input) {
  const r = cleanRestaurant_(input);
  withLock_(function () { Repo.addRestaurant(r); });
  return Repo.listRestaurants();
}

function apiDeleteRestaurant(id) {
  withLock_(function () { Repo.deleteRestaurant(String(id)); });
  return Repo.listRestaurants();
}

/** 자주 쓰는 장소(집·회사 등)를 주소로 찾아 저장합니다. 같은 이름이면 덮어씁니다. */
function apiAddPlace(name, address) {
  name = String(name || '').trim().slice(0, 20);
  address = String(address || '').trim();
  if (!name) throw new Error('장소 이름을 입력해 주세요. 예: 집, 회사');
  if (!address) throw new Error('주소를 입력해 주세요.');
  const found = geocode_(address);
  const places = listPlaces_().filter(function (p) { return p.name !== name; });
  places.push({ name: name, label: found.label, lat: found.lat, lng: found.lng });
  if (places.length > 10) throw new Error('장소는 10개까지 저장할 수 있습니다.');
  PropertiesService.getScriptProperties().setProperty('PLACES', JSON.stringify(places));
  return places;
}

function apiDeletePlace(name) {
  const places = listPlaces_().filter(function (p) { return p.name !== name; });
  PropertiesService.getScriptProperties().setProperty('PLACES', JSON.stringify(places));
  return places;
}

/**
 * 기준 좌표 반경 10km 안의 저염 친화 식당을 거리순으로 찾습니다.
 * origin: { lat, lng } (내 위치 또는 저장한 장소), themeKey: 테마 키 또는 'all'
 */
function apiSearchRestaurants(themeKey, origin) {
  if (!PropertiesService.getScriptProperties().getProperty('KAKAO_REST_KEY')) {
    throw new Error('카카오 REST API 키가 아직 설정되지 않았습니다.');
  }
  origin = origin || {};
  const lat = Number(origin.lat), lng = Number(origin.lng);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new Error('기준 위치가 없습니다. 내 위치를 허용하거나 장소를 먼저 저장해 주세요.');
  }
  const themes = themeKey === 'all' ? LOW_SALT_THEMES : LOW_SALT_THEMES.filter(function (t) { return t.key === themeKey; });
  if (!themes.length) throw new Error('알 수 없는 메뉴 종류입니다.');
  const maxPage = themeKey === 'all' ? 1 : 3;

  const found = {};
  themes.forEach(function (theme) {
    theme.queries.forEach(function (q) {
      for (let page = 1; page <= maxPage; page++) {
        const res = kakaoGet_('/v2/local/search/keyword.json', {
          query: q, x: lng, y: lat, radius: CONFIG.SEARCH_RADIUS_M,
          category_group_code: 'FD6', sort: 'distance', size: 15, page: page,
        });
        (res.documents || []).forEach(function (d) {
          if (found[d.id]) return;
          found[d.id] = {
            id: 'kakao-' + d.id,
            name: d.place_name,
            category: String(d.category_name || '').split('>').pop().trim(),
            address: d.road_address_name || d.address_name,
            phone: d.phone || '',
            distance_km: d.distance ? Math.round(Number(d.distance) / 100) / 10 : null,
            link: d.place_url,
            tip: theme.tip,
            theme: theme.label,
          };
        });
        if (!res.meta || res.meta.is_end) break;
      }
    });
  });
  return Object.keys(found).map(function (k) { return found[k]; })
    .sort(function (a, b) { return (a.distance_km || 0) - (b.distance_km || 0); })
    .slice(0, 60);
}

/**
 * GPS로 기록한 러닝을 저장하고, 그날 기록의 러닝 거리(km)에 더합니다.
 * input: { date, started_at, km, duration_s, kcal, points: [[lat, lng], ...] }
 */
function apiSaveRun(input) {
  input = input || {};
  const date = String(input.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('날짜 형식이 올바르지 않습니다.');
  const km = num_(input.km, 0.01, 200, '러닝 거리');
  const dur = num_(input.duration_s, 10, 24 * 3600, '러닝 시간');
  if (km === '' || dur === '') throw new Error('거리와 시간이 필요합니다.');
  const kcal = num_(input.kcal === undefined ? '' : Math.round(Number(input.kcal)), 0, 10000, '칼로리');
  let points = Array.isArray(input.points) ? input.points.slice(0, 600) : [];
  points = points.filter(function (p) { return Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]); })
    .map(function (p) { return [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5]; });
  const paceS = Math.round(dur / km);
  const run = {
    id: 'run-' + Utilities.getUuid(), date: date, started_at: String(input.started_at || '').slice(0, 20),
    km: Math.round(km * 100) / 100, duration_s: Math.round(dur), pace: Math.floor(paceS / 60) + ':' + ('0' + (paceS % 60)).slice(-2),
    kcal: kcal, points: JSON.stringify(points), source: 'gps', created_at: nowText_(),
  };
  withLock_(function () {
    Repo.addRun(run);
    addRunKm_(date, run.km);
  });
  return { records: Repo.listRecords(), runs: Repo.listRuns().slice(-60) };
}

function apiDeleteRun(id) {
  withLock_(function () {
    const run = Repo.listRuns().filter(function (r) { return r.id === id; })[0];
    if (!run) return;
    Repo.deleteRun(id);
    addRunKm_(run.date, -run.km);
  });
  return { records: Repo.listRecords(), runs: Repo.listRuns().slice(-60) };
}

/** 그날 기록의 run_km에 거리를 더하거나 뺍니다 (다른 값은 그대로). */
function addRunKm_(date, deltaKm) {
  const rec = Repo.listRecords().filter(function (r) { return r.date === date; })[0];
  const total = Math.max(0, Math.round((((rec && rec.run_km) || 0) + deltaKm) * 100) / 100);
  const row = { date: date, updated_at: nowText_() };
  ['systolic', 'diastolic', 'pulse', 'weight_kg', 'memo'].forEach(function (k) { row[k] = rec && rec[k] !== null && rec[k] !== undefined ? rec[k] : ''; });
  row.run_km = total || '';
  Repo.upsertRecord(row);
}

/** 러닝 코스를 저장합니다. points: [[lat, lng], ...] */
function apiSaveCourse(input) {
  input = input || {};
  const name = String(input.name || '').trim().slice(0, 30);
  if (!name) throw new Error('코스 이름을 입력해 주세요.');
  const km = num_(input.km, 0.05, 100, '코스 거리');
  if (km === '') throw new Error('코스 거리를 확인해 주세요.');
  let points = Array.isArray(input.points) ? input.points.slice(0, 400) : [];
  points = points.filter(function (p) { return Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]); })
    .map(function (p) { return [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5]; });
  const course = {
    id: String(input.id || '') || 'course-' + Utilities.getUuid(),
    name: name, km: Math.round(km * 100) / 100, points: JSON.stringify(points), created_at: nowText_(),
  };
  withLock_(function () { Repo.upsertCourse(course); });
  return Repo.listCourses();
}

function apiDeleteCourse(id) {
  withLock_(function () { Repo.deleteCourse(String(id)); });
  return Repo.listCourses();
}

/**
 * ▶ 카카오가 안 될 때: 편집기에서 이 함수를 골라 [실행]하고 '실행 로그'를 확인하세요.
 *   (권한 요청이 뜨면 허용하세요. 외부 사이트 접속 권한이 필요합니다.)
 */
function testKakao() {
  const key = PropertiesService.getScriptProperties().getProperty('KAKAO_REST_KEY');
  if (!key) {
    Logger.log('❌ 스크립트 속성에 KAKAO_REST_KEY가 없습니다. 이름 철자(대문자, 밑줄)를 확인하세요.');
    return;
  }
  Logger.log('키 확인: ' + key.slice(0, 4) + '…' + key.slice(-4) + ' (' + key.length + '자, REST API 키는 보통 32자)');
  try {
    const res = kakaoGet_('/v2/local/search/keyword.json', { query: '밀양시청', size: 1 });
    const d = (res.documents || [])[0];
    Logger.log('✅ 카카오 연결 성공: ' + (d ? d.place_name + ' / ' + d.address_name : '결과 없음'));
  } catch (e) {
    Logger.log('❌ ' + e.message);
  }
}

// ───────────────────────── 도보 길찾기 ─────────────────────────
/**
 * 두 점 사이를 카카오 도보 길찾기로 잇습니다. a, b: [lat, lng]
 * 길을 못 찾으면 직선으로 잇고 straight: true를 돌려줍니다.
 */
function apiWalkSegment(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) throw new Error('좌표가 올바르지 않습니다.');
  const straight = function (reason) {
    return { km: Math.round(haversineKm_(a, b) * 1000) / 1000, path: [a, b], straight: true, reason: reason || '' };
  };
  if (haversineKm_(a, b) < 0.005) return straight('');
  let res;
  try {
    res = kakaoGet_('/v2/routing/walk', { start_x: a[1], start_y: a[0], end_x: b[1], end_y: b[0] });
  } catch (e) {
    if (/429/.test(e.message)) return straight('오늘 길찾기 무료 사용량을 다 써서 직선으로 이었습니다.');
    throw e;
  }
  if (!res || res.status !== 'OK' || !res.route) return straight('이 구간은 길을 못 찾아 직선으로 이었습니다.');
  const path = [];
  (res.route.legs || []).forEach(function (leg) {
    (leg.steps || []).forEach(function (st) {
      ((st.path && st.path.points) || []).forEach(function (pt) {
        const ll = [Math.round(pt[1] * 1e5) / 1e5, Math.round(pt[0] * 1e5) / 1e5];
        const last = path[path.length - 1];
        if (!last || last[0] !== ll[0] || last[1] !== ll[1]) path.push(ll);
      });
    });
  });
  if (path.length < 2) { path.length = 0; path.push(a, b); }
  return { km: Math.round(res.route.properties.totalDistance) / 1000, path: path, straight: false };
}

function haversineKm_(a, b) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLng = (b[1] - a[1]) * toR;
  const h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.pow(Math.sin(dLng / 2), 2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ───────────────────────── 비밀 열쇠 · 내 주소 ─────────────────────────
function randomKey_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 40); }

function keyOk_(name, given) {
  const key = PropertiesService.getScriptProperties().getProperty(name);
  return !!key && String(given || '') === key;
}

/** 배포한 웹앱 주소 (스크립트 속성 WEBAPP_URL). */
function webappUrl_() {
  return String(PropertiesService.getScriptProperties().getProperty('WEBAPP_URL') || '').trim().replace(/\?.*$/, '');
}

/** 화면(GitHub Pages) 주소 */
function frontendUrl_() {
  return String(PropertiesService.getScriptProperties().getProperty('FRONTEND_URL') || CONFIG.FRONTEND_URL).trim();
}

/** 열쇠가 붙은 내 앱 주소. 열쇠와 데이터 주소는 # 뒤에 붙여서 서버 기록에 남지 않게 합니다. */
function appLink_(extra) {
  const api = webappUrl_();
  if (!api) return '';
  const key = PropertiesService.getScriptProperties().getProperty('APP_KEY');
  return frontendUrl_() + '#k=' + encodeURIComponent(key) + '&api=' + encodeURIComponent(api) + (extra || '');
}

function actionLink_(params) {
  const base = webappUrl_();
  const t = PropertiesService.getScriptProperties().getProperty('ACTION_KEY');
  const q = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
  return base + '?' + q + '&t=' + encodeURIComponent(t);
}

/**
 * ▶ 편집기에서 실행: 휴대폰에 저장할 '내 앱 주소'와 카카오에 등록할 주소를 알려줍니다.
 */
function showMyLinks() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('APP_KEY')) { setup(); }
  const base = webappUrl_();
  if (!base) {
    Logger.log('❌ 스크립트 속성에 WEBAPP_URL이 없습니다. [배포 → 배포 관리]의 웹 앱 URL(…/exec)을 WEBAPP_URL로 넣어 주세요.');
    return;
  }
  if (!/\/exec$/.test(base)) Logger.log('⚠️ WEBAPP_URL은 …/exec 로 끝나야 합니다. 지금 값: ' + base);
  Logger.log('① 내 앱 주소 (휴대폰 사파리로 열고 홈 화면에 추가하세요):\n' + appLink_());
  Logger.log('② 카카오 [카카오 로그인 → Redirect URI]에 등록할 주소:\n' + base);
  Logger.log('③ 카카오 [플랫폼 → Web 사이트 도메인]에 등록할 주소:\nhttps://script.google.com');
}

function page_(title, bodyHtml) {
  const html = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{margin:0;font:17px/1.6 -apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;background:#f6f8f9;color:#18212f;padding:32px 20px}' +
    'h1{font-size:22px;margin:0 0 12px}p{margin:0 0 16px}a.b{display:block;text-align:center;background:#0f5c63;color:#fff;text-decoration:none;padding:14px;border-radius:14px;font-weight:700;margin:10px 0}' +
    'a.o{background:#fff;color:#18212f;border:1px solid #dde3e8}.s{color:#6b7480;font-size:14px}</style></head><body>' +
    '<h1>' + title + '</h1>' + bodyHtml + '</body></html>';
  return HtmlService.createHtmlOutput(html).setTitle(title).addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function escHtml_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}

// ───────────────────────── 카카오톡 연결 (나에게 보내기) ─────────────────────────
function kakaoStatus_() {
  const props = PropertiesService.getScriptProperties();
  const base = webappUrl_();
  const state = notifyState_();
  return {
    linked: !!props.getProperty('KAKAO_REFRESH_TOKEN'),
    ready: !!(base && props.getProperty('KAKAO_REST_KEY')),
    authUrl: base && props.getProperty('KAKAO_REST_KEY')
      ? 'https://kauth.kakao.com/oauth/authorize?response_type=code&scope=talk_message' +
        '&client_id=' + encodeURIComponent(String(props.getProperty('KAKAO_REST_KEY')).trim()) +
        '&redirect_uri=' + encodeURIComponent(base) +
        '&state=' + encodeURIComponent(props.getProperty('ACTION_KEY') || '')
      : '',
    notify: state,
  };
}

/** 카카오 로그인에서 돌아왔을 때: 코드를 토큰으로 바꿔 저장합니다. */
function handleKakaoCallback_(p) {
  if (p.error) return page_('카카오톡 연결이 취소됐어요', '<p>' + escHtml_(p.error_description || p.error) + '</p>' + backLink_());
  if (!keyOk_('ACTION_KEY', p.state)) return page_('연결할 수 없어요', '<p>앱의 알림 설정 화면에서 [카카오톡 연결하기]를 다시 눌러 주세요.</p>');
  try {
    const tok = kakaoTokenRequest_({ grant_type: 'authorization_code', redirect_uri: webappUrl_(), code: p.code });
    saveKakaoToken_(tok);
    return page_('카카오톡 연결 완료 ✅', '<p>이제 알림을 켜면 카카오톡 "나와의 채팅"으로 메시지가 옵니다.</p>' + backLink_());
  } catch (e) {
    return page_('카카오톡 연결 실패', '<p>' + escHtml_(e.message) + '</p>' + backLink_());
  }
}

function backLink_() {
  const link = appLink_();
  return link ? '<a class="b" href="' + escHtml_(link) + '" target="_top">앱 열기</a>' : '';
}

function kakaoTokenRequest_(params) {
  const props = PropertiesService.getScriptProperties();
  params.client_id = String(props.getProperty('KAKAO_REST_KEY') || '').trim();
  const secret = String(props.getProperty('KAKAO_CLIENT_SECRET') || '').trim();
  if (secret) params.client_secret = secret;
  const res = UrlFetchApp.fetch('https://kauth.kakao.com/oauth/token', { method: 'post', payload: params, muteHttpExceptions: true });
  let body = {};
  try { body = JSON.parse(res.getContentText()); } catch (e) { body = {}; }
  if (res.getResponseCode() !== 200 || !body.access_token) {
    const why = body.error_description || body.error || ('오류 ' + res.getResponseCode());
    let hint = '';
    if (/redirect/i.test(why)) hint = ' → 카카오 [카카오 로그인 → Redirect URI]에 웹앱 주소(…/exec)를 정확히 등록했는지 확인하세요.';
    else if (/client_secret|secret/i.test(why)) hint = ' → 카카오 [보안 → Client Secret] 값을 스크립트 속성 KAKAO_CLIENT_SECRET에 넣어 주세요.';
    else if (/KOE/i.test(why) || /invalid_client/i.test(why)) hint = ' → 카카오 로그인이 ON인지, REST API 키가 맞는지 확인하세요.';
    throw new Error('카카오 토큰 오류: ' + why + hint);
  }
  return body;
}

function saveKakaoToken_(tok) {
  const props = PropertiesService.getScriptProperties();
  const out = {
    KAKAO_ACCESS_TOKEN: tok.access_token,
    KAKAO_ACCESS_EXPIRES: String(Date.now() + (Number(tok.expires_in) || 3600) * 1000),
  };
  if (tok.refresh_token) out.KAKAO_REFRESH_TOKEN = tok.refresh_token;
  props.setProperties(out);
}

function kakaoAccessToken_() {
  const props = PropertiesService.getScriptProperties();
  const refresh = props.getProperty('KAKAO_REFRESH_TOKEN');
  if (!refresh) throw new Error('카카오톡이 아직 연결되지 않았습니다. 앱의 🔔 알림 설정에서 연결해 주세요.');
  const exp = Number(props.getProperty('KAKAO_ACCESS_EXPIRES') || 0);
  if (props.getProperty('KAKAO_ACCESS_TOKEN') && exp - Date.now() > 5 * 60 * 1000) return props.getProperty('KAKAO_ACCESS_TOKEN');
  try {
    saveKakaoToken_(kakaoTokenRequest_({ grant_type: 'refresh_token', refresh_token: refresh }));
  } catch (e) {
    props.deleteProperty('KAKAO_REFRESH_TOKEN');
    throw new Error('카카오톡 연결이 만료됐습니다. 앱에서 다시 연결해 주세요. (' + e.message + ')');
  }
  return props.getProperty('KAKAO_ACCESS_TOKEN');
}

/** 내 카톡 '나와의 채팅'으로 보냅니다. text는 200자까지 보입니다. */
function sendKakaoMemo_(text, buttonTitle, url) {
  const link = url || appLink_();
  const tpl = { object_type: 'text', text: String(text).slice(0, 200), link: { web_url: link, mobile_web_url: link }, button_title: buttonTitle || '앱 열기' };
  const res = UrlFetchApp.fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
    method: 'post', headers: { Authorization: 'Bearer ' + kakaoAccessToken_() },
    payload: { template_object: JSON.stringify(tpl) }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    let why = res.getContentText().slice(0, 200);
    try { const b = JSON.parse(res.getContentText()); why = b.msg || why; } catch (e) { /* 그대로 */ }
    let hint = '';
    if (/scope|consent|insufficient/i.test(why)) hint = ' → 카카오 [동의항목]에서 "카카오톡 메시지 전송"을 켜고 다시 연결하세요.';
    throw new Error('카톡 보내기 실패: ' + why + hint);
  }
  return true;
}

function apiSendTest() {
  sendKakaoMemo_('✅ 혈압 관리 앱 테스트 메시지예요.\n알림이 이렇게 "나와의 채팅"으로 옵니다.', '앱 열기');
  return true;
}

function apiUnlinkKakao() {
  const props = PropertiesService.getScriptProperties();
  ['KAKAO_ACCESS_TOKEN', 'KAKAO_ACCESS_EXPIRES', 'KAKAO_REFRESH_TOKEN'].forEach(function (k) { props.deleteProperty(k); });
  Object.keys(CONFIG.NOTIFY).forEach(function (k) { setNotify_(k, false); });
  return kakaoStatus_();
}

// ───────────────────────── 알림 예약 ─────────────────────────
function notifyState_() {
  const fns = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  const out = {};
  Object.keys(CONFIG.NOTIFY).forEach(function (k) { out[k] = fns.indexOf(CONFIG.NOTIFY[k].fn) >= 0; });
  return out;
}

function setNotify_(kind, on) {
  const n = CONFIG.NOTIFY[kind];
  if (!n) throw new Error('알 수 없는 알림입니다.');
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === n.fn) ScriptApp.deleteTrigger(t); });
  if (!on) return;
  let b = ScriptApp.newTrigger(n.fn).timeBased().inTimezone(CONFIG.TZ).atHour(n.hour).nearMinute(0);
  b = n.weekday ? b.onWeekDay(ScriptApp.WeekDay[n.weekday]) : b.everyDays(1);
  b.create();
}

function apiSetNotify(kind, on) {
  if (on && !PropertiesService.getScriptProperties().getProperty('KAKAO_REFRESH_TOKEN')) throw new Error('먼저 카카오톡을 연결해 주세요.');
  withLock_(function () { setNotify_(kind, !!on); });
  return kakaoStatus_();
}

function seoulDate_(offsetDays) {
  return Utilities.formatDate(new Date(Date.now() + (offsetDays || 0) * 86400000), CONFIG.TZ, 'yyyy-MM-dd');
}

function dayIntake_(meals, date) {
  const list = meals.filter(function (m) { return m.date === date; });
  if (!list.length) return null;
  return {
    kcal: list.reduce(function (a, m) { return a + (m.kcal || 0); }, 0),
    sodium: list.reduce(function (a, m) { return a + (m.sodium_mg || 0); }, 0),
  };
}

function fmtNum_(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

/** 아침 8시: 혈압 재기 알림 */
function notifyMorning() {
  const recs = Repo.listRecords();
  const y = recs.filter(function (r) { return r.date === seoulDate_(-1); })[0];
  const last = recs.filter(function (r) { return r.systolic !== null && r.date < seoulDate_(0); }).slice(-1)[0];
  let text = '☀️ 좋은 아침이에요. 혈압 잴 시간입니다.\n화장실 다녀온 뒤 1~2분 앉아 쉬고 재세요.';
  if (last) text += '\n\n지난 기록 ' + last.date.slice(5).replace('-', '.') + ': ' + last.systolic + '/' + last.diastolic + (last.weight_kg ? ', ' + last.weight_kg + 'kg' : '');
  if (y && y.run_km) text += '\n어제 러닝 ' + y.run_km + 'km 👏';
  sendKakaoMemo_(text, '혈압 기록하기', appLink_());
}

/** 저녁 8시: 오늘 운동 확인 (뛰었으면 칭찬, 아니면 코스 고르기 버튼) */
function notifyEvening() {
  const today = seoulDate_(0);
  const rec = Repo.listRecords().filter(function (r) { return r.date === today; })[0] || {};
  const intake = dayIntake_(Repo.listMeals(), today);
  const food = intake ? '\n오늘 식사 ' + fmtNum_(intake.kcal) + 'kcal · 나트륨 ' + fmtNum_(intake.sodium) + 'mg' + (intake.sodium > CONFIG.SODIUM_GOAL ? ' (목표 초과)' : ' 👍') : '';
  if (rec.run_km) {
    sendKakaoMemo_('🏃 오늘 ' + rec.run_km + 'km 뛰셨네요. 잘하셨어요!' + food, '오늘 기록 보기', appLink_());
    return;
  }
  const courses = Repo.listCourses();
  const names = courses.slice(0, 3).map(function (c) { return c.name + ' ' + c.km + 'km'; }).join(', ');
  sendKakaoMemo_('🏃 오늘 운동하셨나요?\n뛰었다면 아래 버튼에서 코스를 고르면 바로 저장돼요.' + (names ? '\n(' + names + ')' : '') + food,
    '러닝 기록하기', actionLink_({ act: 'pick', date: today }));
}

/** 월요일 8시: 지난주(월~일) 리포트 */
function notifyWeekly() {
  const days = function (from, to) { const out = []; for (let i = from; i <= to; i++) out.push(seoulDate_(-i)); return out; };
  const cur = days(1, 7), prev = days(8, 14);
  const recs = Repo.listRecords(), meals = Repo.listMeals();
  const pick = function (dates, key) { return recs.filter(function (r) { return dates.indexOf(r.date) >= 0 && r[key] !== null; }).map(function (r) { return r[key]; }); };
  const avg = function (a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; };
  const s1 = avg(pick(cur, 'systolic')), s0 = avg(pick(prev, 'systolic')), d1 = avg(pick(cur, 'diastolic'));
  const w1 = avg(pick(cur, 'weight_kg')), w0 = avg(pick(prev, 'weight_kg'));
  const run = pick(cur, 'run_km').reduce(function (a, b) { return a + b; }, 0);
  const intakes = cur.map(function (d) { return dayIntake_(meals, d); }).filter(Boolean);
  const na = avg(intakes.map(function (i) { return i.sodium; }));
  const low = intakes.filter(function (i) { return i.sodium <= CONFIG.SODIUM_GOAL; }).length;
  const arrow = function (a, b, d, unit) { if (a === null || b === null) return ''; const x = a - b; return ' (' + (x > 0 ? '▲' : x < 0 ? '▼' : '') + Math.abs(x).toFixed(d) + unit + ')'; };
  const lines = ['📊 지난주 리포트 (' + cur[6].slice(5).replace('-', '.') + '~' + cur[0].slice(5).replace('-', '.') + ')'];
  lines.push('혈압 ' + (s1 === null ? '기록 없음' : Math.round(s1) + '/' + Math.round(d1) + arrow(s1, s0, 0, '')));
  lines.push('체중 ' + (w1 === null ? '기록 없음' : w1.toFixed(1) + 'kg' + arrow(w1, w0, 1, 'kg')));
  lines.push('러닝 ' + run.toFixed(1) + 'km');
  lines.push('나트륨 ' + (na === null ? '기록 없음' : '평균 ' + fmtNum_(na) + 'mg, 목표 지킨 날 ' + low + '/' + intakes.length));
  sendKakaoMemo_(lines.join('\n'), '추이 보기', appLink_('&tab=trend'));
}

// ───────────────────────── 카톡 버튼으로 기록 ─────────────────────────
function handleAction_(p) {
  if (!keyOk_('ACTION_KEY', p.t)) return page_('열 수 없는 링크예요', '<p>링크가 올바르지 않습니다.</p>');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(p.date || '') ? p.date : seoulDate_(0);
  const nice = Number(date.slice(5, 7)) + '월 ' + Number(date.slice(8, 10)) + '일';
  const courses = Repo.listCourses();
  if (p.act === 'pick') {
    const btns = courses.map(function (c) {
      return '<a class="b" href="' + escHtml_(actionLink_({ act: 'run', date: date, course: c.id })) + '" target="_top">' + escHtml_(c.name) + ' · ' + c.km + 'km</a>';
    }).join('');
    return page_(nice + ' 러닝 기록', '<p>뛴 코스를 누르면 바로 저장됩니다.</p>' + (btns || '<p class="s">아직 저장한 코스가 없습니다. 앱의 [＋ 코스 만들기]에서 먼저 만들어 주세요.</p>') +
      (appLink_() ? '<a class="b o" href="' + escHtml_(appLink_()) + '" target="_top">다른 거리 직접 입력</a>' : ''));
  }
  if (p.act === 'run') {
    const c = courses.filter(function (x) { return x.id === p.course; })[0];
    if (!c) return page_('코스를 찾지 못했어요', '<p>삭제된 코스일 수 있습니다.</p>' + backLink_());
    const props = PropertiesService.getScriptProperties();
    let done = [];
    try { done = JSON.parse(props.getProperty('RUN_DONE') || '[]'); } catch (e) { done = []; }
    const tag = date + '|' + c.id;
    if (done.indexOf(tag) >= 0) return page_('이미 저장되어 있어요', '<p>' + nice + ' ' + escHtml_(c.name) + ' ' + c.km + 'km는 이미 기록했습니다.</p>' + backLink_());
    let total = c.km;
    withLock_(function () {
      addRunKm_(date, c.km);
      total = (Repo.listRecords().filter(function (r) { return r.date === date; })[0] || {}).run_km || c.km;
      done.push(tag);
      props.setProperty('RUN_DONE', JSON.stringify(done.slice(-60)));
    });
    return page_('저장했어요 ✅', '<p>' + nice + ' ' + escHtml_(c.name) + ' <b>' + c.km + 'km</b>를 기록했습니다.' + (total !== c.km ? ' (이 날 합계 ' + total + 'km)' : '') + '</p>' + backLink_());
  }
  return page_('알 수 없는 링크예요', backLink_());
}

// ───────────────────────── 저장소 (Repo) ─────────────────────────
// B안 전환 시 이 객체만 교체하면 됩니다.
const Repo = {
  listRecords: function () {
    return readObjects_(CONFIG.SHEET_RECORDS, CONFIG.RECORD_COLUMNS)
      .filter(function (r) { return r.date; })
      .map(function (r) {
        return {
          date: r.date,
          systolic: toNum_(r.systolic), diastolic: toNum_(r.diastolic), pulse: toNum_(r.pulse),
          weight_kg: toNum_(r.weight_kg), run_km: toNum_(r.run_km),
          memo: String(r.memo || ''), updated_at: String(r.updated_at || ''),
        };
      })
      .sort(byDate_);
  },

  upsertRecord: function (rec) {
    const sheet = getSheet_(CONFIG.SHEET_RECORDS, CONFIG.RECORD_COLUMNS);
    const row = rowFor_(sheet, rec);
    const idx = findRow_(sheet, 'date', rec.date);
    if (idx) sheet.getRange(idx, 1, 1, row.length).setValues([row]);
    else sheet.appendRow(row);
  },

  deleteRecord: function (date) {
    const sheet = getSheet_(CONFIG.SHEET_RECORDS, CONFIG.RECORD_COLUMNS);
    const idx = findRow_(sheet, 'date', date);
    if (idx) sheet.deleteRow(idx);
  },

  listMeals: function () {
    return readObjects_(CONFIG.SHEET_MEALS, CONFIG.MEAL_COLUMNS)
      .filter(function (m) { return m.id && m.date; })
      .map(function (m) {
        return {
          id: String(m.id), date: m.date, meal: String(m.meal || ''), food: String(m.food || ''),
          matched: String(m.matched || ''), qty: toNum_(m.qty), unit: String(m.unit || ''),
          kcal: toNum_(m.kcal), sodium_mg: toNum_(m.sodium_mg), source: String(m.source || ''),
          created_at: String(m.created_at || ''),
        };
      })
      .sort(function (a, b) { return byDate_(a, b) || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0); });
  },

  addMeals: function (rows) {
    const sheet = getSheet_(CONFIG.SHEET_MEALS, CONFIG.MEAL_COLUMNS);
    const values = rows.map(function (r) { return rowFor_(sheet, r); });
    sheet.getRange(sheet.getLastRow() + 1, 1, values.length, values[0].length).setValues(values);
  },

  deleteMeal: function (id) {
    const sheet = getSheet_(CONFIG.SHEET_MEALS, CONFIG.MEAL_COLUMNS);
    const idx = findRow_(sheet, 'id', id);
    if (idx) sheet.deleteRow(idx);
  },

  listCustomFoods: function () {
    return readObjects_(CONFIG.SHEET_CUSTOM_FOODS, CONFIG.CUSTOM_FOOD_COLUMNS)
      .filter(function (f) { return f.name && toNum_(f.kcal) !== null; })
      .map(function (f) {
        return { name: String(f.name).trim(), unit: String(f.unit || '1회'), kcal: toNum_(f.kcal), sodium_mg: toNum_(f.sodium_mg) };
      });
  },

  upsertCustomFood: function (f) {
    const sheet = getSheet_(CONFIG.SHEET_CUSTOM_FOODS, CONFIG.CUSTOM_FOOD_COLUMNS);
    const row = rowFor_(sheet, f);
    const idx = findRow_(sheet, 'name', f.name);
    if (idx) sheet.getRange(idx, 1, 1, row.length).setValues([row]);
    else sheet.appendRow(row);
  },

  listCourses: function () {
    return readObjects_(CONFIG.SHEET_COURSES, CONFIG.COURSE_COLUMNS)
      .filter(function (c) { return c.id && c.name; })
      .map(function (c) {
        let pts = [];
        try { pts = JSON.parse(c.points || '[]'); } catch (e) { pts = []; }
        return { id: String(c.id), name: String(c.name), km: toNum_(c.km), points: pts };
      });
  },

  upsertCourse: function (c) {
    const sheet = getSheet_(CONFIG.SHEET_COURSES, CONFIG.COURSE_COLUMNS);
    const row = rowFor_(sheet, c);
    const idx = findRow_(sheet, 'id', c.id);
    if (idx) sheet.getRange(idx, 1, 1, row.length).setValues([row]);
    else sheet.appendRow(row);
  },

  deleteCourse: function (id) {
    const sheet = getSheet_(CONFIG.SHEET_COURSES, CONFIG.COURSE_COLUMNS);
    const idx = findRow_(sheet, 'id', id);
    if (idx) sheet.deleteRow(idx);
  },

  listRuns: function () {
    return readObjects_(CONFIG.SHEET_RUNS, CONFIG.RUN_COLUMNS)
      .filter(function (r) { return r.id && r.date; })
      .map(function (r) {
        return { id: String(r.id), date: r.date, started_at: String(r.started_at || ''), km: toNum_(r.km), duration_s: toNum_(r.duration_s),
          pace: String(r.pace || ''), kcal: toNum_(r.kcal), source: String(r.source || '') };
      })
      .sort(byDate_); // 같은 날은 저장한 순서대로
  },

  addRun: function (run) {
    const sheet = getSheet_(CONFIG.SHEET_RUNS, CONFIG.RUN_COLUMNS);
    sheet.appendRow(rowFor_(sheet, run));
  },

  deleteRun: function (id) {
    const sheet = getSheet_(CONFIG.SHEET_RUNS, CONFIG.RUN_COLUMNS);
    const idx = findRow_(sheet, 'id', id);
    if (idx) sheet.deleteRow(idx);
  },

  listRestaurants: function () {
    return readObjects_(CONFIG.SHEET_RESTAURANTS, CONFIG.RESTAURANT_COLUMNS)
      .filter(function (r) { return r.id && r.name; })
      .map(function (r) {
        const o = {};
        CONFIG.RESTAURANT_COLUMNS.forEach(function (c) { o[c] = String(r[c] || ''); });
        return o;
      });
  },

  addRestaurant: function (r) {
    const sheet = getSheet_(CONFIG.SHEET_RESTAURANTS, CONFIG.RESTAURANT_COLUMNS);
    if (findRow_(sheet, 'id', r.id)) return; // 이미 저장됨
    sheet.appendRow(rowFor_(sheet, r));
  },

  deleteRestaurant: function (id) {
    const sheet = getSheet_(CONFIG.SHEET_RESTAURANTS, CONFIG.RESTAURANT_COLUMNS);
    const idx = findRow_(sheet, 'id', id);
    if (idx) sheet.deleteRow(idx);
  },
};

// ───────────────────────── 내부 도우미 ─────────────────────────
function spreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('먼저 편집기에서 setup 함수를 한 번 실행해 주세요.');
  return active;
}

/** 시트가 없으면 만들고, 1행 제목에 빠진 칸이 있으면 오른쪽 끝에 추가합니다(기존 데이터 보존). */
function ensureSheet_(ss, name, columns) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  const width = Math.max(sheet.getLastColumn(), 1);
  const current = sheet.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h).trim(); });
  if (current.join('') === '') {
    sheet.getRange(1, 1, 1, columns.length).setValues([columns]).setFontWeight('bold').setBackground('#e8eef7');
    sheet.setFrozenRows(1);
  } else {
    const missing = columns.filter(function (c) { return current.indexOf(c) < 0; });
    if (missing.length) {
      sheet.getRange(1, current.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold').setBackground('#e8eef7');
    }
  }
  headerOf_(sheet).forEach(function (h, i) {
    if (CONFIG.TEXT_COLUMNS.indexOf(h) >= 0) sheet.getRange(1, i + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
  });
  return sheet;
}

function getSheet_(name, columns) {
  const ss = spreadsheet_();
  const sheet = ss.getSheetByName(name);
  if (!sheet) return ensureSheet_(ss, name, columns);
  const header = headerOf_(sheet);
  const complete = columns.every(function (c) { return header.indexOf(c) >= 0; });
  return complete ? sheet : ensureSheet_(ss, name, columns);
}

function headerOf_(sheet) {
  const width = sheet.getLastColumn();
  if (width < 1) return [];
  return sheet.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h).trim(); });
}

/** 객체를 시트의 1행 제목 순서에 맞춘 한 줄로 바꿉니다. (열 순서가 바뀌거나 늘어나도 안전) */
function rowFor_(sheet, obj) {
  return headerOf_(sheet).map(function (h) {
    const v = obj[h];
    return v === null || v === undefined ? '' : v;
  });
}

/** 시트를 [{열이름: 값}] 목록으로 읽습니다. */
function readObjects_(name, columns) {
  const sheet = getSheet_(name, columns);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const header = values[0].map(function (h) { return String(h).trim(); });
  const tz = Session.getScriptTimeZone();
  return values.slice(1).map(function (row) {
    const o = {};
    header.forEach(function (h, i) {
      let v = row[i];
      if (isDate_(v)) v = Utilities.formatDate(v, tz, h === 'date' ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm');
      o[h] = v;
    });
    return o;
  });
}

/** key 열의 값이 value인 행 번호(1부터)를 찾습니다. 없으면 0. */
function findRow_(sheet, key, value) {
  const col = headerOf_(sheet).indexOf(key) + 1;
  const last = sheet.getLastRow();
  if (col < 1 || last < 2) return 0;
  const tz = Session.getScriptTimeZone();
  const vals = sheet.getRange(2, col, last - 1, 1).getValues();
  for (let i = 0; i < vals.length; i++) {
    let v = vals[i][0];
    if (isDate_(v)) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    if (String(v).trim() === String(value).trim()) return i + 2;
  }
  return 0;
}

function cleanRecord_(input) {
  input = input || {};
  const date = String(input.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('날짜 형식이 올바르지 않습니다.');
  const rec = {
    date: date,
    systolic: num_(input.systolic, 60, 260, '수축기 혈압'),
    diastolic: num_(input.diastolic, 30, 160, '이완기 혈압'),
    pulse: num_(input.pulse, 30, 220, '맥박'),
    weight_kg: num_(input.weight_kg, 20, 300, '체중'),
    run_km: num_(input.run_km, 0, 100, '러닝 거리'),
    memo: String(input.memo || '').slice(0, 500),
  };
  if ((rec.systolic === '') !== (rec.diastolic === '')) throw new Error('혈압은 수축기와 이완기를 함께 입력해 주세요.');
  if (rec.systolic !== '' && rec.diastolic >= rec.systolic) throw new Error('이완기 혈압이 수축기보다 클 수 없습니다. 순서를 확인해 주세요.');
  const hasAny = ['systolic', 'pulse', 'weight_kg', 'run_km'].some(function (k) { return rec[k] !== ''; }) || rec.memo;
  if (!hasAny) throw new Error('입력된 값이 없습니다.');
  return rec;
}

function cleanMealItem_(it) {
  it = it || {};
  const food = String(it.food || '').trim().slice(0, 60);
  if (!food) throw new Error('음식 이름이 비어 있습니다.');
  const qty = num_(it.qty === '' || it.qty === undefined ? 1 : it.qty, 0.05, 50, food + ' 수량');
  return {
    food: food,
    matched: String(it.matched || '').slice(0, 60),
    qty: qty,
    unit: String(it.unit || '').slice(0, 10),
    kcal: num_(it.kcal === '' || it.kcal === undefined ? '' : Math.round(Number(it.kcal)), 0, 10000, food + ' 칼로리'),
    sodium_mg: num_(it.sodium_mg === '' || it.sodium_mg === undefined ? '' : Math.round(Number(it.sodium_mg)), 0, 30000, food + ' 나트륨'),
    source: ['builtin', 'custom', 'manual'].indexOf(it.source) >= 0 ? it.source : 'manual',
  };
}

function cleanRestaurant_(input) {
  input = input || {};
  const name = String(input.name || '').trim();
  if (!name) throw new Error('식당 이름을 입력해 주세요.');
  return {
    id: String(input.id || '').trim() || 'manual-' + Utilities.getUuid(),
    name: name.slice(0, 100),
    category: String(input.category || '').slice(0, 50),
    address: String(input.address || '').slice(0, 200),
    phone: String(input.phone || '').slice(0, 30),
    tip: String(input.tip || '').slice(0, 300),
    link: /^https?:\/\//.test(String(input.link || '')) ? String(input.link) : '',
    created_at: nowText_(),
  };
}

function num_(v, min, max, label) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  if (!isFinite(n) || n < min || n > max) throw new Error(label + ' 값을 확인해 주세요 (' + min + '~' + max + ').');
  return n;
}

function toNum_(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function byDate_(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }

function nowText_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/** 저장한 장소 목록. 예전 버전의 '기준 위치'가 있으면 '기준'이라는 이름으로 옮겨 옵니다. */
function listPlaces_() {
  const props = PropertiesService.getScriptProperties();
  let places = [];
  try { places = JSON.parse(props.getProperty('PLACES') || '[]'); } catch (e) { places = []; }
  if (!places.length && props.getProperty('BASE_LAT')) {
    places = [{ name: '기준', label: props.getProperty('BASE_LABEL') || '', lat: Number(props.getProperty('BASE_LAT')), lng: Number(props.getProperty('BASE_LNG')) }];
  }
  return places;
}

/** 주소나 장소 이름을 좌표로 바꿉니다. */
function geocode_(text) {
  let doc = (kakaoGet_('/v2/local/search/address.json', { query: text }).documents || [])[0];
  if (doc) return { label: doc.address_name, lat: Number(doc.y), lng: Number(doc.x) };
  doc = (kakaoGet_('/v2/local/search/keyword.json', { query: text }).documents || [])[0];
  if (!doc) throw new Error('"' + text + '"을(를) 찾지 못했습니다. 도로명 주소나 "밀양시청"처럼 입력해 보세요.');
  return { label: doc.place_name + ' (' + (doc.road_address_name || doc.address_name) + ')', lat: Number(doc.y), lng: Number(doc.x) };
}

function kakaoGet_(path, params) {
  const key = String(PropertiesService.getScriptProperties().getProperty('KAKAO_REST_KEY') || '').trim();
  if (!key) throw new Error('카카오 REST API 키가 아직 설정되지 않았습니다.');
  const qs = Object.keys(params).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  const res = UrlFetchApp.fetch('https://dapi.kakao.com' + path + '?' + qs, {
    headers: { Authorization: 'KakaoAK ' + key },
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code !== 200) {
    let detail = '';
    try { const body = JSON.parse(res.getContentText()); detail = body.message || body.msg || ''; } catch (e) { detail = res.getContentText().slice(0, 150); }
    let hint = '';
    if (/disabled/i.test(detail) || /OPEN_MAP_AND_LOCAL/i.test(detail)) hint = '카카오 개발자 사이트의 내 앱 → [카카오맵] → 사용 설정을 ON으로 켜 주세요.';
    else if (code === 401) hint = 'REST API 키가 틀렸습니다. JavaScript 키나 Admin 키가 아닌 "REST API 키"인지, 앞뒤 공백이 없는지 확인하세요.';
    else if (code === 403) hint = '카카오가 접근을 막았습니다. [카카오맵] 사용 설정과 앱 상태를 확인하세요.';
    else if (code === 429) hint = '오늘 사용 한도를 넘었습니다. 내일 다시 시도하세요.';
    throw new Error('카카오 오류 ' + code + (detail ? ' (' + detail + ')' : '') + (hint ? ' → ' + hint : ''));
  }
  return JSON.parse(res.getContentText());
}

// ───────────────────────── 음식 사전 (1회 기준 평균 추정치) ─────────────────────────
// [이름|다른 이름들, 기준 단위, kcal, 나트륨 mg, 기준 단위 1개의 그램(선택), {다른 단위: 기준 단위 대비 배수}(선택)]
// 식당·조리법마다 차이가 큽니다. 내 값으로 고치려면 '내음식사전' 시트에 같은 이름으로 적으면 그 값이 우선합니다.
const FOOD_TABLE = [
  // 밥·덮밥
  ['공기밥|밥|쌀밥|흰밥|흰쌀밥|공기', '공기', 300, 5, 210],
  ['현미밥|잡곡밥|보리밥|흑미밥', '공기', 300, 5, 210],
  ['비빔밥', '그릇', 650, 1200],
  ['돌솥비빔밥', '그릇', 700, 1300],
  ['김밥|야채김밥', '줄', 480, 1000, null, { 개: 0.1, 조각: 0.1 }],
  ['참치김밥', '줄', 550, 1100, null, { 개: 0.1, 조각: 0.1 }],
  ['볶음밥', '그릇', 700, 1300],
  ['김치볶음밥', '그릇', 650, 1500],
  ['오므라이스', '그릇', 750, 1300],
  ['카레라이스|카레', '그릇', 650, 1500],
  ['제육덮밥', '그릇', 800, 1700],
  ['불고기덮밥', '그릇', 750, 1500],
  ['회덮밥', '그릇', 600, 900],
  ['짜장밥', '그릇', 750, 2000],
  ['초밥', '개', 50, 120],
  ['주먹밥|삼각김밥', '개', 200, 450],
  // 국밥·탕
  ['돼지국밥', '그릇', 600, 2300],
  ['순대국|순대국밥', '그릇', 700, 2500],
  ['콩나물국밥', '그릇', 450, 2000],
  ['국밥', '그릇', 550, 2200],
  ['설렁탕', '그릇', 450, 1500],
  ['곰탕', '그릇', 450, 1300],
  ['갈비탕', '그릇', 550, 2000],
  ['삼계탕', '그릇', 900, 1600],
  ['육개장', '그릇', 450, 2800],
  ['감자탕|뼈해장국|해장국', '그릇', 700, 2800],
  ['추어탕', '그릇', 500, 2000],
  ['떡국|떡만둣국', '그릇', 650, 2300],
  ['죽|야채죽', '그릇', 350, 900],
  ['전복죽', '그릇', 400, 1000],
  // 찌개·국
  ['김치찌개', '인분', 250, 1900],
  ['된장찌개', '인분', 200, 2000],
  ['순두부찌개|순두부', '인분', 300, 2000],
  ['부대찌개', '인분', 600, 3000],
  ['청국장', '인분', 250, 2000],
  ['동태찌개|동태탕', '인분', 250, 2400],
  ['찌개', '인분', 250, 1900],
  ['미역국', '그릇', 120, 1000],
  ['된장국', '그릇', 80, 900],
  ['북엇국|북어국', '그릇', 150, 1300],
  ['콩나물국', '그릇', 50, 900],
  ['계란국|달걀국', '그릇', 80, 900],
  ['어묵탕|오뎅탕', '그릇', 300, 2000],
  ['국', '그릇', 100, 1000],
  // 면
  ['라면', '개', 500, 1800],
  ['짜파게티|짜장라면', '개', 600, 1000],
  ['컵라면', '개', 300, 1300],
  ['짜장면|자장면', '그릇', 800, 2400],
  ['짬뽕', '그릇', 700, 4000],
  ['우동', '그릇', 450, 3400],
  ['칼국수', '그릇', 600, 2900],
  ['잔치국수|국수', '그릇', 450, 2400],
  ['비빔국수', '그릇', 550, 1900],
  ['물냉면|냉면', '그릇', 550, 2600],
  ['비빔냉면', '그릇', 600, 2400],
  ['밀면|물밀면', '그릇', 550, 2600],
  ['비빔밀면', '그릇', 600, 2400],
  ['쫄면', '그릇', 600, 1800],
  ['스파게티|파스타|토마토파스타', '접시', 650, 1400],
  ['크림파스타', '접시', 850, 1500],
  ['소바|메밀소바|메밀국수', '그릇', 400, 1700],
  ['쌀국수', '그릇', 450, 2000],
  ['마라탕', '그릇', 700, 3500],
  // 고기·생선·반찬
  ['삼겹살', '인분', 800, 150, 200],
  ['목살', '인분', 600, 150, 200],
  ['돼지갈비', '인분', 700, 1100, 250],
  ['소갈비|갈비', '인분', 750, 900, 250],
  ['불고기', '인분', 400, 900, 200],
  ['제육볶음', '인분', 450, 1300, 200],
  ['닭갈비', '인분', 550, 1800],
  ['닭볶음탕|닭도리탕', '인분', 500, 1500],
  ['치킨|후라이드치킨|프라이드치킨', '마리', 2000, 2500, null, { 조각: 0.125 }],
  ['양념치킨', '마리', 2400, 3200, null, { 조각: 0.125 }],
  ['족발', '인분', 800, 1800],
  ['보쌈|수육', '인분', 700, 1300],
  ['돈까스|돈가스', '인분', 800, 1200],
  ['탕수육', '인분', 700, 800],
  ['고등어구이|생선구이', '토막', 250, 500],
  ['갈치구이', '토막', 150, 400],
  ['회|생선회|광어회', '접시', 250, 150, 200],
  ['연어|연어회', '접시', 300, 80, 150],
  ['계란후라이|계란프라이|달걀프라이|후라이', '개', 90, 70],
  ['삶은계란|삶은달걀|계란|달걀', '개', 75, 65],
  ['계란말이', '인분', 200, 400],
  ['계란찜|달걀찜', '인분', 150, 500],
  ['두부부침', '인분', 200, 300],
  ['두부', '모', 250, 20, 300],
  ['김치|배추김치', '접시', 15, 300, 50],
  ['깍두기', '접시', 15, 250, 50],
  ['나물|시금치나물|콩나물무침', '접시', 40, 200],
  ['멸치볶음', '접시', 80, 400],
  ['잡채', '접시', 250, 600],
  ['김|조미김', '봉', 25, 100],
  ['상추|쌈채소|쌈', '접시', 15, 5],
  ['닭가슴살', '개', 120, 300, 100],
  // 분식·빵·간식
  ['떡볶이', '인분', 500, 1600],
  ['라볶이', '인분', 650, 2200],
  ['순대', '인분', 450, 1000],
  ['튀김', '개', 100, 120],
  ['어묵|오뎅', '개', 80, 350],
  ['만두|군만두|찐만두', '개', 55, 120],
  ['식빵', '장', 100, 150],
  ['토스트', '개', 350, 600],
  ['샌드위치', '개', 400, 800],
  ['햄버거|버거', '개', 500, 1000],
  ['피자', '조각', 280, 600, null, { 판: 8 }],
  ['도넛|도너츠', '개', 250, 200],
  ['케이크|케익', '조각', 350, 200],
  ['떡', '개', 100, 150],
  ['과자', '봉지', 500, 500],
  ['초콜릿|초콜렛', '개', 160, 20],
  ['아이스크림', '개', 200, 80],
  ['고구마', '개', 150, 20],
  ['감자', '개', 100, 5],
  ['옥수수', '개', 150, 5],
  // 과일·견과
  ['사과', '개', 100, 0],
  ['배', '개', 150, 0],
  ['바나나', '개', 90, 0],
  ['귤', '개', 40, 0],
  ['딸기', '접시', 35, 0],
  ['포도', '송이', 100, 0],
  ['수박', '조각', 60, 0],
  ['방울토마토', '접시', 30, 5],
  ['토마토', '개', 30, 5],
  ['견과류|아몬드|호두|땅콩', '줌', 120, 0, 20],
  // 음료·주류
  ['우유', '잔', 130, 100, 200],
  ['두유', '팩', 120, 120],
  ['아메리카노|커피|블랙커피', '잔', 10, 5],
  ['카페라떼|라떼', '잔', 180, 100],
  ['믹스커피|커피믹스', '봉', 50, 10],
  ['콜라|사이다|탄산음료', '캔', 110, 10],
  ['주스|오렌지주스', '잔', 110, 5],
  ['맥주', '캔', 230, 20],
  ['소주', '병', 400, 0, null, { 잔: 0.14 }],
  ['막걸리', '병', 350, 20, null, { 잔: 0.25 }],
  ['와인', '잔', 120, 5],
  // 샐러드·저염 친화
  ['샐러드|야채샐러드|그린샐러드', '그릇', 150, 300],
  ['닭가슴살샐러드', '그릇', 350, 600],
  ['포케', '그릇', 550, 1000],
  ['샤브샤브', '인분', 450, 1200],
  ['월남쌈', '인분', 350, 700],
  ['요거트|요구르트|그릭요거트', '개', 100, 60],
  ['오트밀', '그릇', 150, 5],
];

function foodDb_() {
  return FOOD_TABLE.map(function (r) {
    return { names: r[0].split('|'), unit: r[1], kcal: r[2], sodium_mg: r[3], g: r[4] || null, alt: r[5] || null };
  });
}
