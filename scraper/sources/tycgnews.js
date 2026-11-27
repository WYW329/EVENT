// 桃園、台北市府各局處、區公所的「最新消息」RSS（同一套網站系統）。從消息裡挑出民眾活動，並讀出活動日期、地點。
import * as cheerio from 'cheerio';
import { fetchText, makeEvent, makeTime, cleanText, taipeiNow, todayTaipei, findDistrict, supportedCity, findCity, SUPPORTED_CITIES } from '../util.js';

export const TYCG_FEEDS = [
  ['桃園區公所', 'https://www.tao.tycg.gov.tw/OpenData.aspx?SN=B9FA1D8CD0C10792', '桃園區'],
  ['中壢區公所', 'https://www.zhongli.tycg.gov.tw/OpenData.aspx?SN=171C5660E425DF35', '中壢區'],
  ['平鎮區公所', 'https://www.pingzhen.tycg.gov.tw/OpenData.aspx?SN=D259A243B760DE7A', '平鎮區'],
  ['八德區公所', 'https://www.bade.tycg.gov.tw/OpenData.aspx?SN=6151A5469975A45A', '八德區'],
  ['楊梅區公所', 'https://www.yangmei.tycg.gov.tw/OpenData.aspx?SN=349C187CE3D725A4', '楊梅區'],
  ['蘆竹區公所', 'https://www.luzhu.tycg.gov.tw/OpenData.aspx?SN=389AD9EC1F7F0E89', '蘆竹區'],
  ['大園區公所', 'https://www.dayuan.tycg.gov.tw/OpenData.aspx?SN=E9C00607E2A95226', '大園區'],
  ['觀音區公所', 'https://www.guanyin.tycg.gov.tw/OpenData.aspx?SN=584CBE52E2C7B284', '觀音區'],
  ['新屋區公所', 'https://www.xinwu.tycg.gov.tw/OpenData.aspx?SN=33ED99C547BF34E1', '新屋區'],
  ['龍潭區公所', 'https://www.longtan.tycg.gov.tw/OpenData.aspx?SN=195B5E3C6F08D44E', '龍潭區'],
  ['大溪區公所', 'https://www.daxi.tycg.gov.tw/OpenData.aspx?SN=245231F15F4B3CEF', '大溪區'],
  ['復興區公所', 'https://www.fuxing.tycg.gov.tw/OpenData.aspx?SN=C2B1A04ED419140A', '復興區'],
  ['農業局', 'https://agriculture.tycg.gov.tw/OpenData.aspx?SN=B5011D7C6A875FBC'],
  ['青年事務局', 'https://youth.tycg.gov.tw/OpenData.aspx?SN=C70B732F9E006ED5'],
  ['客家事務局', 'https://www.hakka.tycg.gov.tw/OpenData.aspx?SN=BCA8635B3DCF0C4F'],
  ['原住民族行政局', 'https://ipb.tycg.gov.tw/OpenData.aspx?SN=835FE0CFE25F380A'],
  ['婦幼發展局', 'https://dowcd.tycg.gov.tw/OpenData.aspx?SN=1E03A304123FC0BC'],
  ['地政局', 'https://land.tycg.gov.tw/OpenData.aspx?SN=AA317148E9706020'],
  ['社會局', 'https://sab.tycg.gov.tw/OpenData.aspx?SN=515B7187963B1967'],
  ['經濟發展局', 'https://edb.tycg.gov.tw/OpenData.aspx?SN=F1B1153D28102C6F'],
  ['水務局', 'https://wrb.tycg.gov.tw/OpenData.aspx?SN=34A2220020E0235D'],
  ['風景區管理處', 'https://www.scenic.tycg.gov.tw/OpenData.aspx?SN=B29B4BBBAF638163'],
  ['家庭教育中心', 'https://family.tycg.gov.tw/OpenData.aspx?SN=9DD79A5C8218B5EF'],
  ['民政局', 'https://cab.tycg.gov.tw/OpenData.aspx?SN=06ABE2DB72875BF3'],
  ['動物保護處', 'https://animal.tycg.gov.tw/OpenData.aspx?SN=5348010A49E08CEA'],
];

// 是民眾可以參加的活動
export const EVENT_RE = /活動|講座|課程|研習|工作坊|市集|音樂會|演唱|表演|展覽|特展|展出|體驗|導覽|走讀|營隊|夏令營|冬令營|比賽|競賽|升旗|晚會|嘉年華|節|祭|電影|放映|健走|路跑|親子|說故事|讀書會|園遊會|博覽會|義診|篩檢|領養|晚會|演出|音樂|藝術|文化季|農遊|採果|小旅行|揪團|報名/;
// 不是活動（公告、招募、行政）
export const SKIP_RE = /實施計畫|入選|遴選|徵文|提案|湧入|人次|一覽表|評選|表揚|媒合|營運資訊|變更|財產|創生|說明會|宣導|講習會|研討|論壇|座談|檔案展|招生|簡章|招商|攤商|學分|學程|碩士|博士|在職專班|海外|圓夢|基金|獎學金|徵件|徵稿|投稿|徵選|志工招募|徵才|招募|招考|甄選|甄試|約僱|職缺|錄取|榜單|招標|標案|決標|補助|補貼|津貼|申請|申辦|租金|停水|停電|施工|封閉|管制|交通改道|颱風|防災|地震|疫苗|稅|繳費|公告.*名單|成果|花絮|圓滿|感謝|新聞稿|記者會|會議|說明會.*(工程|都更|計畫)|服務時程|輔具|據點|開放時間異動|休館|閉館|暫停/;

const OTHER_CITY_RE = /臺北|台北|新北|基隆|新竹|苗栗|臺中|台中|彰化|南投|雲林|嘉義|臺南|台南|高雄|屏東|宜蘭|花蓮|臺東|台東|澎湖|金門|連江|馬祖/;
// 台北的來源：寫了雙北以外縣市、又沒提到雙北的不收
const NOT_TAIPEI_RE = /桃園|基隆|新竹|苗栗|臺中|台中|彰化|南投|雲林|嘉義|臺南|台南|高雄|屏東|宜蘭|花蓮|臺東|台東|澎湖|金門|連江|馬祖/;

// 臺北市府（gov.taipei）也是同一套系統，用「活動訊息」「基層藝文」這類 RSS
export const TAIPEI_FEEDS = [
  ['中正區公所', 'https://zzdo.gov.taipei/OpenData.aspx?SN=0C6B482B4DCCD6D6', '中正區'],
  ['中正區公所', 'https://zzdo.gov.taipei/OpenData.aspx?SN=2E7D9380FB4709AF', '中正區'],
  ['大同區公所', 'https://dtdo.gov.taipei/OpenData.aspx?SN=1FA573C4C16AA6CC', '大同區'],
  ['中山區公所', 'https://zsdo.gov.taipei/OpenData.aspx?SN=EB80537B7C6BAD7A', '中山區'],
  ['松山區公所', 'https://ssdo.gov.taipei/OpenData.aspx?SN=9B3858FA69505BB5', '松山區'],
  ['大安區公所', 'https://dado.gov.taipei/OpenData.aspx?SN=02A3667FED9E6B98', '大安區'],
  ['大安區公所', 'https://dado.gov.taipei/OpenData.aspx?SN=BB32D8ED217A2217', '大安區'],
  ['萬華區公所', 'https://whdo.gov.taipei/OpenData.aspx?SN=C07A4E0160AC69CE', '萬華區'],
  ['信義區公所', 'https://xydo.gov.taipei/OpenData.aspx?SN=58556754C67AC125', '信義區'],
  ['士林區公所', 'https://sldo.gov.taipei/OpenData.aspx?SN=59F951C617E8AC72', '士林區'],
  ['士林區公所', 'https://sldo.gov.taipei/OpenData.aspx?SN=281249C16C30814A', '士林區'],
  ['北投區公所', 'https://btdo.gov.taipei/OpenData.aspx?SN=EBDEAEDEC639490C', '北投區'],
  ['北投區公所', 'https://btdo.gov.taipei/OpenData.aspx?SN=4AB77FB5C324175E', '北投區'],
  ['內湖區公所', 'https://nhdo.gov.taipei/OpenData.aspx?SN=0775D186E2307F53', '內湖區'],
  ['內湖區公所', 'https://nhdo.gov.taipei/OpenData.aspx?SN=AE59230D67746860', '內湖區'],
  ['南港區公所', 'https://ngdo.gov.taipei/OpenData.aspx?SN=B9FB2A800D03E15C', '南港區'],
  ['南港區公所', 'https://ngdo.gov.taipei/OpenData.aspx?SN=0B6F0C60A143D5A5', '南港區'],
  ['文山區公所', 'https://wsdo.gov.taipei/OpenData.aspx?SN=F1692E370E0FE900', '文山區'],
  ['臺北市文化局', 'https://culture.gov.taipei/OpenData.aspx?SN=1B936A6D33FD42AC'],
  ['臺北市社會局', 'https://dosw.gov.taipei/OpenData.aspx?SN=FBD1DC869C9C15A1'],
  ['臺北市原民會', 'https://www.ipc.gov.taipei/OpenData.aspx?SN=F22F184B86B127A1'],
  ['臺北市公園處', 'https://pkl.gov.taipei/OpenData.aspx?SN=15EF25F9BE92CC83'],
  ['臺北市公園處', 'https://pkl.gov.taipei/OpenData.aspx?SN=4304B250A8C1501E'],
  ['臺北市大地處', 'https://www.geo.gov.taipei/OpenData.aspx?SN=F5E9B748D65E92B1'],
  ['臺北市體育局', 'https://sports.gov.taipei/OpenData.aspx?SN=2D58889BB41F75D7'],
  ['臺北市民政局', 'https://ca.gov.taipei/OpenData.aspx?SN=4DA811EF46E4E6F4'],
  ['臺北市立天文館', 'https://tam.gov.taipei/OpenData.aspx?SN=352100000A1A37FB', '士林區'],
  ['臺北市立天文館', 'https://tam.gov.taipei/OpenData.aspx?SN=B130F13BC7E70F5F', '士林區'],
  ['臺北市中山堂', 'https://www.zsh.gov.taipei/OpenData.aspx?SN=F4D16A14CA2E7DA0', '中正區'],
  ['臺北市藝文推廣處', 'https://www.tapo.gov.taipei/OpenData.aspx?SN=3B770880CF2CDE7D', '中山區'],
  ['臺北市藝文推廣處', 'https://www.tapo.gov.taipei/OpenData.aspx?SN=E2018C5392F991DF', '中山區'],
  ['臺北市立動物園', 'https://www.zoo.gov.taipei/OpenData.aspx?SN=2859F17A6DE391A1', '文山區'],
  ['臺北市環保局', 'https://www.dep.gov.taipei/OpenData.aspx?SN=7F569FE8F620BCE7'],
  ['臺北市勞動局', 'https://bola.gov.taipei/OpenData.aspx?SN=B983F3296606A47B'],
  ['臺北市產業局', 'https://www.doed.gov.taipei/OpenData.aspx?SN=6C26BB63625DACE7'],
  ['臺北市動保處', 'https://www.tcapo.gov.taipei/OpenData.aspx?SN=AC3BB5CD01A89DDC'],
  ['臺北市立圖書館', 'https://tpml.gov.taipei/OpenData.aspx?SN=BF42F24130B56DF1'],
  ['臺北市立圖書館', 'https://tpml.gov.taipei/OpenData.aspx?SN=24C1A4661875547B'],
  ['臺北市立圖書館', 'https://tpml.gov.taipei/OpenData.aspx?SN=3054D3D4DD31F97D'],
  ['臺北市客委會', 'https://hac.gov.taipei/OpenData.aspx?SN=CF5AD75A421CA71A'],
  ['臺北市立兒童新樂園', 'https://www.tcap.taipei/OpenData.aspx?SN=2579EEDA59881496', '士林區'],
  ['臺北自來水園區', 'https://waterpark.water.gov.taipei/OpenData.aspx?SN=DACE8C0169ADBD49', '中正區'],
];

const pad = (n) => String(n).padStart(2, '0');

/**
 * 從消息內文找活動日期（可帶時間）和結束日期。優先找「活動日期／時間：」後面的，找不到就用內文第一個日期。
 * 支援 115年12月16日、2026/12/16、12月16日、12/16，時間支援 9時30分、09:30、下午2點。
 */
export function extractEventDates(text, refMs = Date.now()) {
  // 「12 月1 6 日」這種數字中間有空白的先合起來
  const s = String(text ?? '').replace(/\s+/g, ' ').replace(/(\d)\s+(?=\d)/g, '$1');
  const keyIdx = s.search(/(活動|辦理|舉辦|展覽|演出|課程|報名)?\s*(日期|時間|期間)\s*[:：]/);
  const zone = keyIdx >= 0 ? s.slice(keyIdx, keyIdx + 120) : s.slice(0, 400);
  const DATE = /(?:(\d{3,4})\s*[年/.-]\s*)?(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*日?(?:\s*[（(]\s*(?:星期|週|周)?[一二三四五六日天]\s*[)）])?(?:\s*(上午|早上|中午|下午|晚上)?\s*(\d{1,2})\s*(?:[:：時點])\s*(\d{1,2})?\s*分?)?/g;
  const found = [];
  let m;
  while ((m = DATE.exec(zone)) && found.length < 2) {
    const [all, y, mo, d, period, hh, mi] = m;
    const month = Number(mo);
    const day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    // 沒有年、沒有月日字樣的「1/2」容易誤判，要求前面有關鍵字區段
    if (!y && !/[月日]/.test(all) && keyIdx < 0) continue;
    let year = y ? Number(y) : null;
    if (year && year < 1911) year += 1911;
    if (!year) {
      const ref = taipeiNow(new Date(refMs));
      year = ref.y;
      // 消息常提前發；比發布日早 2 個月以上的就是明年
      if (Date.UTC(year, month - 1, day) < Date.UTC(ref.y, ref.m - 1, ref.d) - 60 * 86400000) year += 1;
    }
    let hour = hh !== undefined ? Number(hh) : null;
    if (hour !== null && /下午|晚上/.test(period ?? '') && hour < 12) hour += 12;
    found.push(hour !== null && hour < 24 ? makeTime(year, month, day, hour, mi ? Number(mi) : 0) : makeTime(year, month, day));
  }
  if (!found.length) return null;
  // 第二個日期要在第一個之後、而且中間有「至、~、-」才算結束日
  const rangeEnd = found[1] && /[至~～\-－]/.test(zone) && found[1] >= found[0] ? found[1] : null;
  return { start: found[0], end: rangeEnd };
}

function extractVenue(text) {
  const m = String(text ?? '').replace(/\s+/g, ' ').match(/(?:活動)?(?:地點|地址|集合地點|場地)\s*[:：]\s*([^。；;，,]{2,60})/);
  return m ? m[1].replace(/[（(]地址[:：].*$/, '').trim() : null;
}

export function parseFeedItems(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $('item')
    .map((_, el) => {
      const it = $(el);
      return {
        title: it.find('title').text().trim(),
        link: it.find('link').text().trim(),
        pubDate: it.find('pubDate').text().trim(),
        text: cleanText(cheerio.load(it.find('description').text()).text(), 3000),
      };
    })
    .get();
}

// ---------- 桃園市立圖書館「活動消息」（總館＋分館；列表顯示活動日期、類別、館別） ----------
export function parseLibraryList(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('.list-item').each((_, el) => {
    const box = $(el);
    const a = box.find('a[href*="/Activity/Content/"]').first();
    const href = a.attr('href');
    if (!href) return;
    const strongs = box.find('p strong').map((_, s) => $(s).text().trim()).get();
    items.push({
      id: href.match(/Content\/(\d+)/)?.[1],
      url: new URL(href, 'https://www.typl.gov.tw/').href,
      title: box.find('.newslist-title').text().trim() || box.attr('data-title'),
      date: box.find('time').attr('datetime')?.slice(0, 10) ?? null,
      type: strongs[0] ?? null,
      branch: strongs[1] ?? null,
      image: box.find('img').attr('src') ? new URL(box.find('img').attr('src'), 'https://www.typl.gov.tw/').href : null,
    });
  });
  return items;
}

const LIB_TYPE = { 演講研習: '講座課程', 藝文展演: '展覽', 電影欣賞: '電影', 說故事: '親子', 行動書車: '其他', 其他活動: undefined };

export const library = {
  id: 'typl',
  name: '桃園市立圖書館',
  async fetch() {
    const html = await fetchText('https://www.typl.gov.tw/zh-tw/Activity');
    const out = [];
    for (const it of parseLibraryList(html)) {
      if (!it.date || !it.title) continue;
      // 內頁有活動期間（很多是系列活動，跨好幾週）
      const page = await fetchText(it.url).catch(() => '');
      const text = page ? cheerio.load(page)('main, .content, body').first().text().replace(/\s+/g, ' ') : '';
      const range = text.match(/活動(?:日期|期間|時間)\s*[:：]?\s*(\d{4})[./-](\d{1,2})[./-](\d{1,2})[^~～至\d]{0,20}[~～至-]\s*(?:(\d{4})[./-])?(\d{1,2})[./-](\d{1,2})/);
      const end = range ? makeTime(range[4] ?? range[1], range[5], range[6]) : null;
      out.push(
        makeEvent(this, it.id, {
          title: it.title.replace(/^[【〔\[][^】〕\]]*[】〕\]]\s*/, ''),
          start: it.date,
          end: end && end >= it.date ? end : null,
          venue: it.branch ? `桃園市立圖書館${it.branch === '總館' ? '總館' : `${it.branch.replace(/區$/, '')}分館`}` : '桃園市立圖書館',
          district: it.branch && it.branch !== '總館' ? findDistrict(it.branch) : '桃園區',
          category: LIB_TYPE[it.type],
          free: true,
          url: it.url,
          image: it.image,
          summary: text ? cleanText(text.slice(text.indexOf(it.title.slice(0, 8)) + 0, 1500), 1200) : null,
          extra: { organizer: '桃園市立圖書館', libType: it.type },
        }),
      );
    }
    return out;
  },
};

/** 市府 RSS 來源：feeds 是 [單位, RSS 網址, 預設行政區, 這個單位的縣市（沒寫就用 city）]；city 是這組來源的縣市。 */
function makeFeedSource({ id, name, feeds, city, homeRe, otherRe, inferCity = true }) {
  return {
  id,
  name,
  city,
  async fetch() {
    const out = [];
    const errors = [];
    const today = todayTaipei();
    await Promise.all(
      feeds.map(async ([office, url, district, feedCity = city]) => {
        try {
          const xml = await fetchText(url, {}, { timeoutMs: 90000, retries: 2 });
          for (const it of parseFeedItems(xml)) {
            const title = it.title.replace(/^(轉知|轉知-|【轉知】|\[轉知\])\s*[-－:：]?\s*/, '');
            if (!EVENT_RE.test(title) || SKIP_RE.test(title)) continue;
            const pub = Date.parse(it.pubDate) || Date.now();
            const dates = extractEventDates(`${title} ${it.text}`, pub);
            if (!dates) continue;
            const endDay = (dates.end ?? dates.start).slice(0, 10);
            if (endDay < today) continue; // 已結束
            const venue = extractVenue(it.text);
            // 轉知外縣市的活動不收（地點寫了別的縣市、又沒提到桃園）
            const where = `${venue ?? ''} ${title}`;
            if ((otherRe.test(where) || /[鄉鎮]公所/.test(where)) && !homeRe.test(where)) continue;
            // 很多單位會轉貼同一則，標題和日期相同只留一則
            // 有「」框住的名稱就用它當比對依據（各單位轉貼時前後文字常不同）
            const core = title.match(/[「『《]([^」』》]{4,})[」』》]/)?.[1] ?? title;
            const dupKey = `${core.replace(/[\s\p{P}\p{S}]/gu, '').slice(0, 40)}|${dates.start.slice(0, 10)}`;
            // 名稱互相包含（例如「2026桃園藝術巡演」和「2026桃園藝術巡演12月演出活動」）也算同一則
            const [kc, kd] = dupKey.split('|');
            const dup = out.find((e) => {
              const [ec, ed] = e._k.split('|');
              return ed === kd && (ec === kc || (Math.min(ec.length, kc.length) >= 6 && (ec.includes(kc) || kc.includes(ec))));
            });
            if (dup) { dup.alsoIn = [...new Set([...(dup.alsoIn ?? []), office])]; continue; }
            const key = new URL(it.link).searchParams.get('s') ?? it.link;
            // 台北的單位也常轉貼新北的活動，地點寫了哪個縣市就算哪個
            // inferCity=false（基隆）：區名和台北重複，只認文字裡明寫的縣市
            const named = findCity(venue, title);
            const evCity = named && SUPPORTED_CITIES.includes(named) ? named : inferCity ? supportedCity(venue, title) ?? feedCity : feedCity;
            out.push(
              makeEvent({ id: this.id, name: office }, `${new URL(url).host.split('.')[0]}:${key}`, {
                title,
                start: dates.start,
                end: dates.end,
                venue,
                district: findDistrict({ city: evCity }, venue, title, it.text) ?? (evCity === feedCity ? district : null) ?? null,
                city: evCity,
                url: it.link,
                summary: it.text,
                extra: { organizer: office, postedAt: new Date(pub).toISOString().slice(0, 10) },
              }),
            );
            out.at(-1)._k = dupKey;
          }
        } catch (err) {
          errors.push(`${office}: ${err.message}`);
        }
      }),
    );
    for (const e of out) delete e._k;
    if (errors.length && !out.length) throw new Error(errors.join('; '));
    if (errors.length) out.warnings = errors;
    return out;
  },
};
}

// 基隆市政府「活動訊息」、各區公所「區政活動／最新消息」、海科館「活動訊息」
export const KEELUNG_FEEDS = [
  ['基隆市政府', 'https://www.klcg.gov.tw/tw/klcg1/3169-RSS.html'],
  ['中正區公所', 'https://www.klzz.klcg.gov.tw/tw/klzz/956-RSS.html', '中正區'],
  ['信義區公所', 'https://www.klsy.klcg.gov.tw/tw/klsy/1220-RSS.html', '信義區'],
  ['仁愛區公所', 'https://www.klra.klcg.gov.tw/tw/klra/902-RSS.html', '仁愛區'],
  ['中山區公所', 'https://www.kljs.klcg.gov.tw/tw/kljs/737-RSS.html', '中山區'],
  ['中山區公所', 'https://www.kljs.klcg.gov.tw/tw/kljs/733-RSS.html', '中山區'],
  ['安樂區公所', 'https://www.klal.klcg.gov.tw/tw/klal/1016-RSS.html', '安樂區'],
  ['安樂區公所', 'https://www.klal.klcg.gov.tw/tw/klal/1012-RSS.html', '安樂區'],
  ['暖暖區公所', 'https://www.klnn.klcg.gov.tw/tw/klnn/852-RSS.html', '暖暖區'],
  ['暖暖區公所', 'https://www.klnn.klcg.gov.tw/tw/klnn/849-RSS.html', '暖暖區'],
  ['七堵區公所', 'https://www.klct.klcg.gov.tw/tw/klct/794-RSS.html', '七堵區'],
  ['國立海洋科技博物館', 'https://www.nmmst.gov.tw/chhtml/rss2', '中正區'],
];
const NOT_KEELUNG_RE = /臺北|台北|新北|桃園|新竹|苗栗|臺中|台中|彰化|南投|雲林|嘉義|臺南|台南|高雄|屏東|宜蘭|花蓮|臺東|台東|澎湖|金門|連江|馬祖/;

// 新竹縣政府「活動訊息」、新竹市政府新聞
export const HSINCHU_FEEDS = [
  ['新竹縣政府', 'https://www.hsinchu.gov.tw/OpenData.aspx?SN=3E00E932A813B364', '竹北市', '新竹縣'],
  ['新竹市政府', 'https://www.hccg.gov.tw/hccg/app/rss/News', '東區', '新竹市'],
];
const NOT_HSINCHU_RE = /臺北|台北|新北|桃園|基隆|苗栗|臺中|台中|彰化|南投|雲林|嘉義|臺南|台南|高雄|屏東|宜蘭|花蓮|臺東|台東|澎湖|金門|連江|馬祖/;

export const tycgNews = makeFeedSource({ id: 'tycgnews', name: '桃園市府局處與區公所', feeds: TYCG_FEEDS, city: '桃園市', homeRe: /桃園/, otherRe: OTHER_CITY_RE });
export const taipeiNews = makeFeedSource({ id: 'tpenews', name: '臺北市府局處與區公所', feeds: TAIPEI_FEEDS, city: '臺北市', homeRe: /臺北|台北|新北/, otherRe: NOT_TAIPEI_RE });
export const hsinchuNews = makeFeedSource({ id: 'hcnews', name: '新竹縣市政府', feeds: HSINCHU_FEEDS, city: '新竹市', homeRe: /新竹|竹北|竹東/, otherRe: NOT_HSINCHU_RE });
export const keelungNews = makeFeedSource({ id: 'klnews', name: '基隆市府與區公所', feeds: KEELUNG_FEEDS, city: '基隆市', homeRe: /基隆/, otherRe: NOT_KEELUNG_RE, inferCity: false });
