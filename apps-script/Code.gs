/*************************************************************
 *  派工後端 (Google Apps Script)
 *  一支處理兩種來源：
 *    1) LINE 打字 → webhook → 雲端 Gemini 解析 → 寫進 Sheet → 回覆確認
 *    2) 網頁「＋新增」表單 → POST → 寫進 Sheet
 *  跟 GitHub 看板讀的是同一張 Sheet。
 *
 *  ── 密鑰放「指令碼屬性」，原始碼不含任何金鑰，可安全進 git ──
 *  Apps Script → 專案設定(齒輪) → 指令碼屬性 → 新增：
 *    SHEET_ID    Google Sheet ID（網址 /d/ 後那串）
 *    SHEET_NAME  分頁名稱（可省略，預設「工作表1」）
 *    LINE_TOKEN  LINE Channel access token
 *    GEMINI_KEY  Gemini API key（留空則自動退回規則解析，不會壞掉）
 *
 *  ── Sheet 欄序（第一列標題要一致）──
 *  日期 | 結束 | 客戶 | 地點 | 類型 | 負責人 | 狀態 | 備註
 *************************************************************/

const GEMINI_MODEL = 'gemini-2.5-flash';   // 非密鑰；想更省額度可改 gemini-2.5-flash-lite

function cfg_(key, required) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (required && !v) throw new Error('指令碼屬性缺少 ' + key + '：請到 專案設定 → 指令碼屬性 補上');
  return v || '';
}

/* === 入口：LINE 和 網頁（新增/編輯/刪除）都打這支 === */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    let body = null;
    if (e.postData && /json/.test(e.postData.type || '')) body = JSON.parse(e.postData.contents);
    lock.waitLock(10000);
    if (body && body.events) { handleLine(body); return ok_(); }   // 來自 LINE
    const f = e.parameter || {};                                    // 來自網頁表單
    if (f.action === 'update') { updateJob(f); return ok_(); }
    if (f.action === 'delete') { deleteJob(f); return ok_(); }
    if (!f.date && !f.cust) throw new Error('缺少必要欄位（日期/客戶）');
    appendJob({
      date: f.date, end: f.end, cust: f.cust, loc: f.loc,
      type: f.type, who: f.who, status: f.status || '待辦', note: f.note
    });
    return ok_();
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/* GET ?action=list → 全部派工 JSON（看板即時讀取用，無發布 CSV 的快取延遲） */
function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.action === 'list') {
      return ContentService.createTextOutput(JSON.stringify({ ok: true, jobs: listJobs() }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (p.action === 'health') return health_();
    return ok_('alive');
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/* 健康檢查：只回報各設定「有沒有貼」與 Gemini 是否真的可用，不洩漏金鑰內容 */
function health_() {
  const r = {
    ok: true,
    sheet_id: !!cfg_('SHEET_ID'),
    sheet_name: cfg_('SHEET_NAME') || '(預設 工作表1)',
    line_token: !!cfg_('LINE_TOKEN'),
    gemini_key: !!cfg_('GEMINI_KEY'),
    gemini_works: false
  };
  if (r.gemini_key) {
    const t = parseWithGemini('明天 測試客戶 維修 阿明');
    r.gemini_works = !!(t && t.date);
  }
  return ContentService.createTextOutput(JSON.stringify(r))
    .setMimeType(ContentService.MimeType.JSON);
}

/* === 一次性設定：建立試算表＋設定 SHEET_ID/SHEET_NAME（不含金鑰）===
 * 首次部署時在編輯器選 setup → 執行 → 授權。之後可刪。
 * 金鑰（GEMINI_KEY / LINE_TOKEN）請另外貼到「指令碼屬性」。
 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SHEET_ID')) {
    Logger.log('已設定過 SHEET_ID，略過建表。現有 = ' + props.getProperty('SHEET_ID'));
    return '已設定過，未重複建表';
  }
  const ss = SpreadsheetApp.create('派工資料');
  const sh = ss.getSheets()[0];
  sh.setName('工作表1');
  sh.getRange(1, 1, 1, 8).setValues([[
    '日期', '結束', '客戶', '地點', '類型', '負責人', '狀態', '備註'
  ]]);
  sh.setFrozenRows(1);
  props.setProperty('SHEET_ID', ss.getId());
  props.setProperty('SHEET_NAME', '工作表1');
  Logger.log('SHEET_ID = ' + ss.getId());
  Logger.log('URL = ' + ss.getUrl());
  return ss.getUrl();
}

function ok_(msg) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, msg: msg || '' }))
    .setMimeType(ContentService.MimeType.JSON);
}

/* === LINE 訊息 === */
function handleLine(body) {
  body.events.forEach(function (ev) {
    if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;
    const text = (ev.message.text || '').trim();
    if (/^(help|說明|格式|\?|？)$/i.test(text)) { reply(ev.replyToken, helpText()); return; }
    const job = parseJob(text);
    if (!job) { reply(ev.replyToken, '看不懂這筆 🙈\n\n' + helpText()); return; }
    appendJob(job);
    reply(ev.replyToken, confirmText(job));
  });
}

/* === 解析：先用雲端 Gemini；缺的欄位用規則解析補，兩邊互補 === */
function parseJob(text) {
  const ai = parseWithGemini(text);
  const rb = parseText(text);
  if (ai && ai.date) {
    if (rb) {
      if ((!ai.who || ai.who === '未指派') && rb.who && rb.who !== '未指派') ai.who = rb.who;
      if (!ai.cust && rb.cust) ai.cust = rb.cust;
      if (!ai.type && rb.type) ai.type = rb.type;
      if (!ai.loc && rb.loc) ai.loc = rb.loc;
      if (!ai.end && rb.end) ai.end = rb.end;
    }
    return ai;
  }
  return rb;
}

function parseWithGemini(text) {
  const key = cfg_('GEMINI_KEY');
  if (!key) return null;                         // 沒填 key 就跳過，走規則解析
  const now = new Date();
  const wd = '日一二三四五六'[now.getDay()];
  const todayStr = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  const prompt =
    '你是派工排程解析器。今天是 ' + todayStr + '（星期' + wd + '）。\n' +
    '從這句話抽出欄位，只輸出 JSON，不要任何說明或程式碼框：\n' +
    '{"date":"YYYY-MM-DD","end":"YYYY-MM-DD 或空字串","cust":"客戶","type":"類型","who":"負責人","loc":"地點"}\n' +
    '規則：date 是開始日；單日 end 給空字串；看得懂「今天/明天/後天/下週三」等相對日期；\n' +
    '抓不到的欄位給空字串；type 例如 維修/配線/安裝/調機/試車；\n' +
    '句尾單獨出現的稱呼或人名（如 阿明、阿華、小王、老陳）通常就是負責人 who，務必抓出來。\n句子：' + text;
  try {
    const res = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent',
      {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-goog-api-key': key },
        payload: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' }
        }),
        muteHttpExceptions: true
      });
    const data = JSON.parse(res.getContentText());
    const out = data.candidates && data.candidates[0].content.parts[0].text;
    if (!out) return null;
    const o = JSON.parse(out.replace(/```json|```/g, '').trim());
    if (!o.date) return null;
    return {
      date: o.date, end: o.end || '', cust: o.cust || '', type: o.type || '',
      who: o.who || '未指派', loc: o.loc || '', status: '待辦', note: ''
    };
  } catch (err) {
    return null;
  }
}

/* === 規則解析（備援）：日期 客戶 類型 負責人 地點 === */
function parseText(text) {
  let parts = text.split(/[,，]/).map(trim).filter(Boolean);
  if (parts.length < 2) parts = text.split(/\s+/).map(trim).filter(Boolean);
  if (parts.length < 2) return null;
  const d = parseDateField(parts[0]);
  if (!d) return null;
  return {
    date: d.start, end: d.end, cust: parts[1] || '', type: parts[2] || '',
    who: parts[3] || '未指派', loc: parts[4] || '', status: '待辦', note: ''
  };
}

function parseDateField(s) {
  const seg = s.split(/[-~～—到]/).map(trim);
  const start = normDate(seg[0]);
  if (!start) return null;
  return { start: start, end: seg[1] ? normDate(seg[1]) : '' };
}

function normDate(s) {
  const y = new Date().getFullYear();
  let m = s.match(/^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})$/);
  if (m) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})$/);
  if (m) return y + '-' + pad(m[1]) + '-' + pad(m[2]);
  return '';
}

/* === Sheet 存取 === */
const COL = { date: 1, end: 2, cust: 3, loc: 4, type: 5, who: 6, status: 7, note: 8 };

function sheet_() {
  const ss = SpreadsheetApp.openById(cfg_('SHEET_ID', true));
  const name = cfg_('SHEET_NAME') || '工作表1';
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('找不到分頁：' + name);
  return sh;
}

function appendJob(j) {
  sheet_().appendRow([
    j.date || '', j.end || '', j.cust || '', j.loc || '',
    j.type || '', j.who || '未指派', j.status || '待辦', j.note || ''
  ]);
}

function listJobs() {
  const vals = sheet_().getDataRange().getValues();
  const jobs = [];
  for (let r = 1; r < vals.length; r++) {
    const v = vals[r];
    const date = cell_(v[0]);
    if (!date && !cell_(v[2])) continue;   // 全空列跳過
    jobs.push({
      row: r + 1,
      date: date, end: cell_(v[1]), cust: cell_(v[2]), loc: cell_(v[3]),
      type: cell_(v[4]), who: cell_(v[5]), status: cell_(v[6]), note: cell_(v[7])
    });
  }
  return jobs;
}

/* 日期儲存格可能是 Date 物件或字串，一律轉成 yyyy-MM-dd 字串 */
function cell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v == null ? '' : v).trim();
}

/* 更新/刪除：row 是 Sheet 列號；guard（客戶名）用來確認列沒被動過，避免刪錯 */
function updateJob(f) {
  const sh = sheet_();
  const row = rowOf_(sh, f);
  Object.keys(COL).forEach(function (k) {
    if (f[k] !== undefined) sh.getRange(row, COL[k]).setValue(f[k]);
  });
}

function deleteJob(f) {
  const sh = sheet_();
  sh.deleteRow(rowOf_(sh, f));
}

function rowOf_(sh, f) {
  const row = parseInt(f.row, 10);
  if (!row || row < 2 || row > sh.getLastRow()) throw new Error('該列不存在，請重新整理看板後再試');
  if (f.guard !== undefined && cell_(sh.getRange(row, COL.cust).getValue()) !== String(f.guard).trim()) {
    throw new Error('看板資料已過期（該列已被修改或移動），請重新整理後再試');
  }
  return row;
}

/* === LINE 回覆（reply 不吃推播額度）=== */
function reply(token, text) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + cfg_('LINE_TOKEN', true) },
    payload: JSON.stringify({ replyToken: token, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true
  });
}

function confirmText(j) {
  const span = j.end ? (j.date + ' ~ ' + j.end) : j.date;
  return '✅ 已排入派工\n📅 ' + span + '\n🏢 ' + j.cust + '\n🔧 ' + (j.type || '-') +
         '\n👤 ' + j.who + (j.loc ? '\n📍 ' + j.loc : '');
}

function helpText() {
  return '直接打就行，不用逗號。例如：\n'
    + '・明天 客戶A 維修 阿明\n'
    + '・下週三 客戶B 台中 配線 阿華\n'
    + '・7/1到7/3 客戶C 高雄 安裝 阿強\n'
    + '（聽得懂 今天 / 明天 / 下週幾 這類說法）';
}

function trim(s) { return String(s).trim(); }
function pad(n) { return String(n).padStart(2, '0'); }
