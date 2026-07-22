// 租屋資訊網爬蟲 — 591 社會住宅/可租補 三房物件
// 執行：跑爬蟲.bat（借用 D:\BLI_Auto_git\node_modules 的 playwright）
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const JSON_FILE = path.join(DATA_DIR, 'listings.json');
const JS_FILE = path.join(DATA_DIR, 'listings.js');

const SEARCHES = [
  { name: '板橋-社會住宅', group: '板橋', social: true,
    url: 'https://rent.591.com.tw/list?region=3&section=26&layout=3&other=social-housing' },
  { name: '板橋-可租補', group: '板橋', social: false,
    url: 'https://rent.591.com.tw/list?region=3&section=26&layout=3&other=rental-subsidy' },
  { name: '萬華中正-社會住宅', group: '台北', social: true,
    url: 'https://rent.591.com.tw/list?region=1&section=1,6&layout=3&other=social-housing' },
  { name: '萬華中正-可租補', group: '台北', social: false,
    url: 'https://rent.591.com.tw/list?region=1&section=1,6&layout=3&other=rental-subsidy' },
];

const MAX_PAGES = 10;
const today = new Date().toISOString().slice(0, 10);

function parsePrice(txt) {
  // 只抓「元/月」前的數字，避免誤抓「降500元」等降價提示的降幅
  const m = (txt || '').replace(/,/g, '').match(/(\d+)\s*元\/月/);
  return m ? parseInt(m[1], 10) : null;
}

async function scrapeSearch(page, search) {
  const items = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = search.url + (p > 1 ? `&page=${p}` : '');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    try {
      await page.waitForSelector('.item[data-id]', { timeout: 15000 });
    } catch {
      break; // 沒有物件（0 筆或最後一頁之後）
    }
    await page.waitForTimeout(1500);
    // 逐步捲動觸發圖片 lazy-load
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 800) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 200));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(800);
    const pageItems = await page.$$eval('.item[data-id]', (els) =>
      els.map((it) => {
        const pick = (sel) => [...it.querySelectorAll(sel)].map((e) => e.textContent.trim()).filter(Boolean);
        return {
          id: it.dataset.id,
          title: it.querySelector('.item-info-title')?.textContent.trim() || '',
          link: 'https://rent.591.com.tw/' + it.dataset.id,
          priceText: it.querySelector('[class*="price"]')?.textContent.trim() || '',
          txts: pick('.item-info-txt'),
          tags: pick('.item-info-tag .tag'),
          img: [...it.querySelectorAll('img')].map((im) => im.currentSrc || im.src || im.dataset.src || '').find((s) => s.startsWith('http')) || '',
        };
      })
    );
    const newOnPage = pageItems.filter((i) => !items.some((x) => x.id === i.id));
    if (newOnPage.length === 0) break; // 591 超過頁數會重複顯示第一頁
    items.push(...newOnPage);
    console.log(`  ${search.name} 第 ${p} 頁：${newOnPage.length} 筆`);
    if (pageItems.length < 20) break;
  }
  return items.map((i) => ({
    id: i.id,
    title: i.title,
    link: i.link,
    price: parsePrice(i.priceText),
    priceText: (parsePrice(i.priceText) || 0).toLocaleString() + ' 元/月',
    spec: i.txts[0] || '',
    address: i.txts.find((t) => t.includes('區')) || '',
    distance: i.txts.find((t) => t.startsWith('距')) || '',
    tags: i.tags,
    img: i.img,
    group: search.group,
    social: search.social || i.tags.includes('社會住宅'),
    source: search.name,
  }));
}

(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let db = {};
  if (!process.env.RESET && fs.existsSync(JSON_FILE)) db = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
    locale: 'zh-TW',
  });
  const page = await ctx.newPage();

  let scrapedTotal = 0;
  let anyFailed = false;
  for (const s of SEARCHES) {
    console.log(`🔍 ${s.name}`);
    try {
      const items = await scrapeSearch(page, s);
      if (items.length === 0) throw new Error('抓到 0 筆，可能被 591 擋下或頁面結構改變');
      scrapedTotal += items.length;
      for (const it of items) {
        const old = db[it.id];
        if (!old) {
          db[it.id] = { ...it, firstSeen: today, lastSeen: today, priceHistory: [{ date: today, price: it.price }] };
        } else {
          const merged = { ...old, ...it, firstSeen: old.firstSeen, lastSeen: today, priceHistory: old.priceHistory || [] };
          const lastPrice = merged.priceHistory.at(-1)?.price;
          if (it.price != null && it.price !== lastPrice) merged.priceHistory.push({ date: today, price: it.price });
          // 社宅搜尋來源優先保留
          merged.social = old.social || it.social;
          db[it.id] = merged;
        }
      }
      console.log(`  ✅ 共 ${items.length} 筆`);
    } catch (e) {
      anyFailed = true;
      console.error(`  ❌ ${s.name} 失敗：${e.message}`);
    }
  }

  // 下架即刪：本次沒掃到的物件連紀錄帶縮圖一起刪除
  // （若任一搜尋失敗則跳過清理，避免誤把整批物件當成下架刪掉）
  if (!anyFailed) {
    const IMG_DIR_C = path.join(DATA_DIR, 'img');
    let removed = 0;
    for (const [id, it] of Object.entries(db)) {
      if (it.lastSeen !== today) {
        const f = path.join(IMG_DIR_C, id + '.jpg');
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
        delete db[id];
        removed++;
      }
    }
    if (removed) console.log(`🧹 已刪除 ${removed} 筆下架物件（含縮圖）`);
  } else {
    console.log('⚠️ 有搜尋失敗，本次跳過下架清理');
  }
  // 下載封面縮圖到本機（data/img/物件ID.jpg），避免圖床防盜連
  // CI（GitHub Actions）不下載也不 commit 圖片，網頁自動改用直連圖床備援
  if (process.env.CI) {
    console.log('🖼️ CI 環境，略過縮圖下載');
  } else {
    const IMG_DIR = path.join(DATA_DIR, 'img');
    fs.mkdirSync(IMG_DIR, { recursive: true });
    let dl = 0;
    for (const it of Object.values(db)) {
      if (!it.img) continue;
      const file = path.join(IMG_DIR, it.id + '.jpg');
      if (!fs.existsSync(file)) {
        try {
          const res = await page.request.get(it.img, { headers: { referer: 'https://rent.591.com.tw/' }, timeout: 15000 });
          if (res.ok()) { fs.writeFileSync(file, await res.body()); dl++; }
        } catch {}
      }
      if (fs.existsSync(file)) it.imgLocal = 'data/img/' + it.id + '.jpg';
    }
    console.log(`🖼️ 新下載 ${dl} 張縮圖`);
  }
  await browser.close();

  const meta = { updatedAt: new Date().toISOString(), runDate: today, total: Object.keys(db).length, scrapedTotal };
  fs.writeFileSync(JSON_FILE, JSON.stringify(db, null, 1), 'utf8');
  fs.writeFileSync(JS_FILE, 'window.LISTINGS=' + JSON.stringify(db) + ';window.META=' + JSON.stringify(meta) + ';', 'utf8');
  console.log(`\n📦 資料庫共 ${meta.total} 筆（本次掃到 ${scrapedTotal} 筆），已寫入 data/`);
})();
