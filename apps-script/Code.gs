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

/* === 入口：LINE 和 網頁新增都打這支 === */
function doPost(e) {
  try {
    let body = null;
    if (e.postData && /json/.test(e.postData.type || '')) body = JSON.parse(e.postData.contents);
    if (body && body.events) { handleLine(body); return ok_(); }   // 來自 LINE
    const f = e.parameter || {};                                    // 來自網頁表單
    appendJob({
      date: f.date, end: f.end, cust: f.cust, loc: f.loc,
      type: f.type, who: f.who, status: f.status || '待辦', note: f.note
    });
    return ok_();
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet() { return ok_('alive'); }

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

/* === 解析：先用雲端 Gemini，失敗才退回規則解析 === */
function parseJob(text) {
  const ai = parseWithGemini(text);
  if (ai && ai.date) return ai;
  return parseText(text);
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
    '抓不到的欄位給空字串；type 例如 維修/配線/安裝/調機/試車。\n句子：' + text;
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

/* === 寫入 Sheet === */
function appendJob(j) {
  const ss = SpreadsheetApp.openById(cfg_('SHEET_ID', true));
  const name = cfg_('SHEET_NAME') || '工作表1';
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('找不到分頁：' + name);
  sh.appendRow([
    j.date || '', j.end || '', j.cust || '', j.loc || '',
    j.type || '', j.who || '未指派', j.status || '待辦', j.note || ''
  ]);
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
