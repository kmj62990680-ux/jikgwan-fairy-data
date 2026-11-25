// 직관 승리요정 · 경기 결과 수집기
//
// auto: 시작 시간 + 경기 길이가 지났는데 결과가 비어 있는 경기가 있을 때만 그 리그 공식 누리집을 연다.
//       없으면 브라우저도 켜지 않고 끝낸다(공식 누리집에 부담을 주지 않기 위해).
// full: 하루 한 번(새벽) 시즌 전체 일정과 공식 순위를 다시 읽는다.
//
// 안전장치: 팀 이름이 목록에 없거나, 끝난 경기 수가 줄어들면 아무것도 쓰지 않는다.
// 공식 순위와 결과로 계산한 승패가 다르면 경고만 남기고 결과는 그대로 둔다(순위 반영이 늦는 경우가 있어서).
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const MODE = process.argv[2] || "auto";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA = path.join(ROOT, "data");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DURATION_MIN = { kbl: 120, wkbl: 120, vm: 150, vw: 150, kbo: 240, k1: 130, k2: 130 }; // 시작 후 이만큼 지나면 끝났다고 본다
const SEASON_MONTHS = ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04"];
// 야구 · 축구는 한 해가 한 시즌. 2026 시즌은 끝났지만 "올해 간 경기"를 고를 수 있게 넣어 둔다
const SUMMER_YEAR = "2026";
const KBO_MONTHS = ["03", "04", "05", "06", "07", "08", "09", "10"];
const KLEAGUE_MONTHS = ["02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];

const TEAMS = {
  kbl: { 소노: "고양 소노", KT: "수원 KT", LG: "창원 LG", DB: "원주 DB", 삼성: "서울 삼성", SK: "서울 SK", 정관장: "안양 정관장", 한국가스공사: "대구 한국가스공사", 현대모비스: "울산 현대모비스", KCC: "부산 KCC" },
  wkbl: { KB스타즈: "청주 KB스타즈", "BNK 썸": "부산 BNK", BNK썸: "부산 BNK", 삼성생명: "용인 삼성생명", 하나은행: "부천 하나은행", 신한은행: "인천 신한은행", 우리은행: "아산 우리은행" },
  vm: { 대한항공: "대한항공", 현대캐피탈: "현대캐피탈", KB손해보험: "KB손해보험", 삼성화재: "삼성화재", 우리카드: "우리카드", OK저축은행: "OK저축은행", 한국전력: "한국전력" },
  vw: { 흥국생명: "흥국생명", 현대건설: "현대건설", 정관장: "정관장", IBK기업은행: "IBK기업은행", GS칼텍스: "GS칼텍스", 한국도로공사: "한국도로공사", SOOP: "SOOP 수퍼스" },
  kbo: { KIA: "KIA 타이거즈", 삼성: "삼성 라이온즈", KT: "KT 위즈", LG: "LG 트윈스", 두산: "두산 베어스", SSG: "SSG 랜더스", 롯데: "롯데 자이언츠", NC: "NC 다이노스", 한화: "한화 이글스", 키움: "키움 히어로즈" },
  k1: { 강원: "강원FC", 광주: "광주FC", 김천: "김천상무", 대전: "대전하나시티즌", 부천: "부천FC", 서울: "FC서울", 안양: "FC안양", 울산: "울산HD", 인천: "인천유나이티드", 전북: "전북현대", 제주: "제주SK", 포항: "포항스틸러스" },
  k2: { 경남: "경남FC", 김포: "김포FC", 김해: "김해FC", 대구: "대구FC", 부산: "부산아이파크", 서울E: "서울이랜드", 성남: "성남FC", 수원: "수원삼성", 수원FC: "수원FC", 안산: "안산그리너스", 용인: "용인FC", 전남: "전남드래곤즈", 천안: "천안시티FC", 충남아산: "충남아산FC", 충북청주: "충북청주FC", 파주: "파주프런티어", 화성: "화성FC" }
};
const STANDING_NAMES = {
  wkbl: { 신한은행: "인천 신한은행", 삼성생명: "용인 삼성생명", 우리은행: "아산 우리은행", "BNK 썸": "부산 BNK", BNK썸: "부산 BNK", KB스타즈: "청주 KB스타즈", 하나은행: "부천 하나은행" }
};

const log = (...a) => console.log(new Date().toISOString(), ...a);
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")); } catch { return d; } };
const writeJSON = (f, v) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(v, null, 0) + "\n");
const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000); // KST를 UTC 필드로 다룬다
const kstString = () => kstNow().toISOString().slice(0, 16).replace("T", " ");
const startOf = (g) => new Date(g[0] + "T" + (g[1] || "19:00") + ":00Z"); // KST 기준

// ---------- 어떤 리그가 확인할 때가 됐나 ----------
function dueLeagues(schedule) {
  const now = kstNow();
  const due = {};
  for (const [lg, games] of Object.entries(schedule.leagues || {})) {
    for (const g of games) {
      if (g[4] !== null) continue;
      const start = startOf(g);
      const ended = new Date(start.getTime() + DURATION_MIN[lg] * 60000);
      if (ended <= now && now - start < 72 * 3600 * 1000) { (due[lg] = due[lg] || new Set()).add(g[0].slice(0, 7)); }
    }
  }
  return due; // { kbl: Set(["2026-11"]) }
}

// ---------- 각 리그 읽기 ----------
async function readKBL(page, months) {
  await page.goto("https://www.kbl.or.kr/match/schedule", { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500));
  const out = [];
  const parse = () => page.evaluate(() => {
    const t = document.body.innerText.split("\n").map((x) => x.trim()).filter(Boolean);
    const mIdx = t.findIndex((x) => /^\d{4}\. \d{1,2}$/.test(x));
    const [y, m] = t[mIdx].split(". ");
    const res = []; let date = null;
    for (let i = mIdx + 1; i < t.length; i++) {
      if (/^\d{2}\.\d{2}$/.test(t[i])) { date = y + "-" + t[i].replace(".", "-"); continue; }
      if (t[i] === "정규시즌" && date && /^\d{1,2}:\d{2}$/.test(t[i + 1])) {
        const [time, venue, h, hs, a, as, next] = t.slice(i + 1, i + 8);
        const played = next === "기록";
        res.push([date, time, h, a, played ? +hs : null, played ? +as : null]);
      }
    }
    return { ym: y + "-" + String(m).padStart(2, "0"), res };
  });
  const move = (dir) => page.evaluate((dir) => {
    const label = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && /^\d{4}\. \d{1,2}$/.test(e.textContent.trim()));
    let box = label; for (let k = 0; k < 4 && box; k++) { box = box.parentElement; if (box && box.querySelectorAll("button, a").length >= 2) break; }
    const b = [...box.querySelectorAll("button, a")]; (dir < 0 ? b[0] : b[b.length - 1]).click();
  }, dir);
  let cur = await parse();
  const want = [...months].sort();
  // 가장 이른 달까지 뒤로 갔다가 앞으로 가며 읽는다
  for (let guard = 0; cur.ym > want[0] && guard < 12; guard++) { await move(-1); await new Promise((r) => setTimeout(r, 2500)); cur = await parse(); }
  for (let guard = 0; guard < 12; guard++) {
    if (want.includes(cur.ym)) out.push(...cur.res);
    if (cur.ym >= want[want.length - 1]) break;
    await move(1); await new Promise((r) => setTimeout(r, 2500)); cur = await parse();
  }
  return out.map(([d, t, h, a, hs, as]) => [d, t, name("kbl", h), name("kbl", a), hs, as]);
}

async function readWKBL(page, months) {
  // 목록 표는 늦게 붙거나 안 붙을 때가 있어, 항상 있는 달력 표에서 읽는다. 팀 이름 목록으로 경기를 잘라 낸다.
  // 달력에는 시작 시간이 없어서 평일 19:00, 주말 14:00으로 두고 결과 확인 시점만 잡는 데 쓴다.
  const names = Object.keys(TEAMS.wkbl).sort((a, b) => b.length - a.length);
  const out = [];
  for (const ym of months) {
    await page.goto("https://www.wkbl.or.kr/game/sch/schedule1.asp?gun=1&ym=" + ym.replace("-", ""), { waitUntil: "networkidle2", timeout: 60000 });
    const rows = await page.evaluate((ym, names) => {
      const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const alt = names.map(esc).join("|");
      const re = new RegExp("(" + alt + ")\\s+vs\\s+(" + alt + ")(?:\\s*\\[(\\d+)\\s+vs\\s+(\\d+)\\])?", "g");
      const cal = [...document.querySelectorAll("table")].find((t) => t.rows[0] && t.rows[0].textContent.replace(/\s+/g, "") === "일월화수목금토");
      if (!cal) return [];
      const res = [];
      [...cal.querySelectorAll("td")].forEach((td) => {
        const txt = td.textContent.replace(/\s+/g, " ").trim();
        const dm = /^(\d{1,2})\b/.exec(txt); if (!dm) return;
        const date = ym + "-" + String(+dm[1]).padStart(2, "0");
        const dow = new Date(date + "T00:00:00Z").getUTCDay();
        let m; re.lastIndex = 0;
        while ((m = re.exec(txt))) res.push([date, dow === 0 || dow === 6 ? "14:00" : "19:00", m[1], m[2], m[3] ? +m[3] : null, m[4] ? +m[4] : null]);
      });
      return res;
    }, ym, names);
    out.push(...rows);
  }
  return out.map(([d, t, h, a, hs, as]) => [d, t, name("wkbl", h), name("wkbl", a), hs, as]);
}

async function readKOVO(page) {
  await page.goto("https://kovo.co.kr/games/v-leagues/schedules?season=023&gender=all&league=201", { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 3000));
  for (let i = 0; i < 6; i++) { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await new Promise((r) => setTimeout(r, 700)); }
  const rows = await page.evaluate(() => {
    const t = document.body.innerText.split("\n").map((x) => x.trim()).filter(Boolean);
    const out = [];
    for (let i = 0; i < t.length; i++) {
      if ((t[i] === "남자부" || t[i] === "여자부") && t[i + 1] === "정규리그") {
        const m = /^(\d{2})\.(\d{2})\.(\d{2})\s+\S+\s+(\d{1,2}:\d{2})/.exec(t[i + 3] || ""); if (!m) continue;
        const h = t[i + 5], score = t[i + 6], state = t[i + 7], a = t[i + 8];
        const sm = /^(\d)\s*:\s*(\d)$/.exec(score || "");
        const done = state === "경기종료" && sm;
        out.push([t[i] === "남자부" ? "vm" : "vw", "20" + m[1] + "-" + m[2] + "-" + m[3], m[4], h, a, done ? +sm[1] : null, done ? +sm[2] : null]);
      }
    }
    return out;
  });
  const res = { vm: [], vw: [] };
  rows.forEach(([lg, d, t, h, a, hs, as]) => res[lg].push([d, t, name(lg, h), name(lg, a), hs, as]));
  return res;
}

// KBO: 공식 누리집이 일정 화면에 쓰는 데이터를 그 화면 안에서 같은 방식으로 받는다(정규시즌만)
async function readKBO(page, months) {
  await page.goto("https://www.koreabaseball.com/Schedule/Schedule.aspx", { waitUntil: "networkidle2", timeout: 60000 });
  const out = [];
  for (const mm of months) {
    const rows = await page.evaluate(async (year, mm) => {
      const body = new URLSearchParams({ leId: "1", srIdList: "0,9,6", seasonId: year, gameMonth: mm, teamId: "" });
      const res = await fetch("/ws/Schedule.asmx/GetScheduleList", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }, body });
      const j = await res.json();
      const strip = (h) => { const d = document.createElement("div"); d.innerHTML = h; return d; };
      const res2 = []; let day = null;
      for (const r of j.rows || []) {
        const cells = r.row;
        const dc = cells.find((c) => c.Class === "day"); if (dc) day = /(\d{2})\.(\d{2})/.exec(dc.Text);
        const tc = cells.find((c) => c.Class === "time"), pc = cells.find((c) => c.Class === "play");
        if (!day || !tc || !pc) continue;
        const note = (cells[cells.length - 1].Text || "").trim();
        if (/취소|연기/.test(note)) continue;
        const d = strip(pc.Text); const spans = [...d.querySelectorAll(":scope > span")].map((x) => x.textContent.trim());
        const sc = [...d.querySelectorAll("em span")].map((x) => x.textContent.trim());
        const away = spans[0], home = spans[spans.length - 1];
        const as = /^\d+$/.test(sc[0] || "") ? +sc[0] : null, hs = /^\d+$/.test(sc[2] || "") ? +sc[2] : null;
        res2.push([year + "-" + day[1] + "-" + day[2], strip(tc.Text).textContent.trim(), home, away, hs, as]);
      }
      return res2;
    }, SUMMER_YEAR, mm);
    out.push(...rows);
  }
  return out.map(([d, t, h, a, hs, as]) => [d, t || "18:30", name("kbo", h), name("kbo", a), hs, as]);
}

// K리그: 공식 누리집 일정 화면이 쓰는 데이터를 그 화면 안에서 받는다(리그 경기만, 승강 플레이오프 · 컵 대회 제외)
async function readKLeague(page, lg) {
  const leagueId = lg === "k1" ? "1" : "2";
  await page.goto("https://www.kleague.com/schedule.do?leagueId=" + leagueId, { waitUntil: "networkidle2", timeout: 60000 });
  const out = [];
  for (const mm of KLEAGUE_MONTHS) {
    const rows = await page.evaluate(async (leagueId, year, mm) => {
      const res = await fetch("/getScheduleList.do", { method: "POST", headers: { "Content-Type": "application/json", "Accept-Language": "ko-KR,ko;q=0.9" }, body: JSON.stringify({ leagueId, teamId: "", year, month: mm, ticketYn: "" }) });
      const j = await res.json();
      return (j.data.scheduleList || [])
        .filter((g) => String(g.leagueId) === leagueId && /K리그[12] \d{4}$/.test(g.meetName || ""))
        .map((g) => [g.gameDate.replace(/\./g, "-"), g.gameTime || "19:00", g.homeTeamName, g.awayTeamName, g.endYn === "Y" ? g.homeGoal : null, g.endYn === "Y" ? g.awayGoal : null]);
    }, leagueId, SUMMER_YEAR, mm);
    out.push(...rows);
  }
  return out.map(([d, t, h, a, hs, as]) => [d, t, name(lg, h), name(lg, a), hs, as]);
}

function name(lg, raw) {
  const v = TEAMS[lg][raw];
  if (!v) throw new Error("모르는 팀 이름: " + lg + " " + raw);
  return v;
}

// ---------- 공식 순위 읽기 (full 때만) ----------
async function readStandings(page) {
  const st = {};
  await page.goto("https://www.kbl.or.kr/match/team-ranking", { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500));
  st.kbl = await page.evaluate(() => {
    const r = {}; document.querySelectorAll("table tr").forEach((tr) => { const c = [...tr.children].map((x) => x.innerText.trim()); if (/^\d+$/.test(c[0]) && /^\d+$/.test(c[2])) r[c[1]] = [+c[2], +c[3]]; }); return r;
  });
  await page.goto("https://www.wkbl.or.kr/game/team_rank.asp", { waitUntil: "networkidle2", timeout: 60000 });
  const wk = await page.evaluate(() => {
    const r = {}; document.querySelectorAll("table tr").forEach((tr) => { const c = [...tr.children].map((x) => x.innerText.trim()); const m = /(\d+)승\s*(\d+)패/.exec(c[3] || ""); if (/^\d+$/.test(c[0]) && m) r[c[1]] = [+m[1], +m[2]]; }); return r;
  });
  st.wkbl = {};
  for (const [k, v] of Object.entries(wk)) { const key = Object.keys(STANDING_NAMES.wkbl).find((n) => k.startsWith(n.split(" ")[0])); if (key) st.wkbl[STANDING_NAMES.wkbl[key]] = v; }
  await page.goto("https://www.kovo.co.kr/", { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 3000));
  const kv = await page.evaluate(() => {
    const t = document.body.innerText.split("\n").map((x) => x.trim()).filter(Boolean);
    const grab = (from) => { const r = {}; let i = from; while (i < t.length && /^\d$/.test(t[i])) { r[t[i + 1]] = [+t[i + 4], +t[i + 5]]; i += 6; } return r; };
    const a = t.indexOf("패"); const men = grab(a + 1);
    const wIdx = t.indexOf("여자부 순위"); const b = t.indexOf("패", wIdx); const women = grab(b + 1);
    return { men, women };
  });
  st.vm = {}; for (const [k, v] of Object.entries(kv.men)) st.vm[name("vm", k)] = v;
  st.vw = {}; for (const [k, v] of Object.entries(kv.women)) st.vw[name("vw", k)] = v;
  const kblNames = {}; for (const full of Object.values(TEAMS.kbl)) kblNames[full] = full;
  for (const k of Object.keys(st.kbl)) if (!kblNames[k]) throw new Error("모르는 KBL 순위 팀: " + k);
  return st;
}

function recordFrom(games) {
  const r = {};
  for (const [, , h, a, hs, as] of games) {
    if (hs === null) continue;
    if (hs === as) { (r[h] = r[h] || [0, 0, 0])[2] = (r[h][2] || 0) + 1; (r[a] = r[a] || [0, 0, 0])[2] = (r[a][2] || 0) + 1; continue; }
    const [w, l] = hs > as ? [h, a] : [a, h];
    (r[w] = r[w] || [0, 0, 0])[0]++; (r[l] = r[l] || [0, 0, 0])[1]++;
  }
  return r;
}
const played = (games) => games.filter((g) => g[4] !== null).length;

// ---------- 실행 ----------
async function main() {
  const schedule = readJSON("schedule.json", { asOf: null, leagues: {} });
  const standings = readJSON("standings.json", { asOf: null, leagues: {} });
  let targets;
  if (MODE === "full") {
    targets = { kbl: new Set(SEASON_MONTHS), wkbl: new Set(SEASON_MONTHS.filter((m) => m >= "2026-11")), vm: true, vw: true, kbo: true, k1: true, k2: true };
  } else {
    targets = dueLeagues(schedule);
    if (!Object.keys(targets).length) { log("확인할 경기 없음 — 공식 누리집에 접속하지 않음"); return; }
    log("확인할 리그:", Object.keys(targets).join(", "));
  }

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    await page.setUserAgent((await browser.userAgent()).replace("HeadlessChrome", "Chrome") + " jikgwan-fairy-results/1.0"); // 일반 크롬 표시 + 수집기 이름
    await page.setViewport({ width: 1280, height: 1600 }); // 좁으면 WKBL 일정이 달력 모양으로 바뀐다
    await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR,ko;q=0.9" }); // 해외 서버(GitHub)에서 돌면 K리그가 영어 팀 이름을 준다(11/25 실패 원인)
    const next = { ...schedule.leagues };
    const merge = (lg, fresh) => {
      const months = new Set(fresh.map((g) => g[0].slice(0, 7)));
      const kept = (next[lg] || []).filter((g) => !months.has(g[0].slice(0, 7)));
      const merged = [...kept, ...fresh].sort((x, y) => (x[0] + x[1]).localeCompare(y[0] + y[1]));
      if (played(merged) < played(next[lg] || [])) throw new Error(lg + ": 끝난 경기 수가 줄어듦 — 쓰지 않음");
      next[lg] = merged;
    };
    // 한 리그가 실패해도 다른 리그 결과는 반영한다(실패한 리그는 이전 결과 유지, 경고만 남김)
    const safe = async (lg, fn) => { try { await fn(); } catch (e) { console.log(`::warning::${lg} 읽기 실패 — 이전 결과 유지: ${e.message}`); } };
    if (targets.kbl) await safe("kbl", async () => { const k = await readKBL(page, targets.kbl); log("KBL 읽음", k.length); merge("kbl", k); });
    if (targets.wkbl) await safe("wkbl", async () => { const w = await readWKBL(page, targets.wkbl); log("WKBL 읽음", w.length); merge("wkbl", w); });
    if (targets.vm || targets.vw) await safe("kovo", async () => { const k = await readKOVO(page); if (targets.vm) merge("vm", k.vm); if (targets.vw) merge("vw", k.vw); });
    if (targets.kbo) await safe("kbo", async () => { const k = await readKBO(page, KBO_MONTHS); log("KBO 읽음", k.length); merge("kbo", k); });
    for (const lg of ["k1", "k2"]) if (targets[lg]) await safe(lg, async () => { const k = await readKLeague(page, lg); log(lg + " 읽음", k.length); merge(lg, k); });

    const changed = JSON.stringify(next) !== JSON.stringify(schedule.leagues);
    if (changed) {
      writeJSON("schedule.json", { asOf: kstString(), leagues: next });
      log("결과 반영:", Object.entries(next).map(([k, v]) => k + " " + played(v) + "경기").join(" · "));
    } else log("새 결과 없음 — 다음 확인 때 다시");

    if (MODE === "full") {
      const off = await readStandings(page);
      for (const lg of ["kbl", "wkbl", "vm", "vw"]) {
        const calc = recordFrom(next[lg] || []);
        for (const [team, wl] of Object.entries(off[lg])) {
          const c = calc[team] || [0, 0];
          if (c[0] !== wl[0] || c[1] !== wl[1]) log("경고: 순위와 결과가 다름", lg, team, "공식", wl.join("-"), "결과", c.join("-"));
        }
      }
      for (const lg of ["kbo", "k1", "k2"]) {
        const calc = recordFrom(next[lg] || []), off2 = (standings.leagues || {})[lg] || {};
        for (const [team, wl] of Object.entries(off2)) { const c = calc[team] || [0, 0, 0]; if (c[0] !== wl[0] || c[1] !== wl[1] || (wl[2] || 0) !== (c[2] || 0)) log("경고: 순위와 결과가 다름", lg, team, "공식", wl.join("-"), "결과", c.join("-")); }
      }
      const kept = standings.leagues || {};
      writeJSON("standings.json", { asOf: kstString().slice(0, 10), leagues: { ...kept, ...off } });
      log("공식 순위 반영");
    }
  } finally { await browser.close(); }
}

main().catch((e) => { console.error("실패:", e.message); process.exit(1); });
