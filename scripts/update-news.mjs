import { readFile, writeFile } from 'node:fs/promises';

const CONFIG_PATH = new URL('../config/news-config.json', import.meta.url);
const OUTPUT_PATH = new URL('../news-data.json', import.meta.url);

const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
const now = new Date();
const reportDate = formatDate(now, config.timezone);
const warnings = [];
const allItems = [];

for (const sector of config.sectors) {
  const candidates = [];

  for (const query of sector.searchQueries) {
    const feedUrl = buildGoogleNewsRssUrl(query, config);
    try {
      const xml = await fetchText(feedUrl);
      candidates.push(...parseRss(xml, sector.name, query));
    } catch (error) {
      warnings.push(`${sector.name}｜${query}：${error.message}`);
    }
  }

  const selected = selectItems(candidates, sector, config, now);
  allItems.push(...selected);
}

if (!allItems.length) {
  throw new Error(`没有抓取到可用新闻。${warnings.length ? `\n${warnings.join('\n')}` : ''}`);
}

const signals = buildSignals(allItems, config);
const output = {
  version: 2,
  generatedAt: now.toISOString(),
  date: reportDate,
  timezone: config.timezone,
  model: 'free-rss-rule-engine-v1',
  summary: buildOverallSummary(allItems, signals, config),
  keySignals: signals,
  recommendedActions: buildActions(allItems, signals),
  items: allItems.map((item, index) => ({
    id: `rss-${now.toISOString().slice(0, 10)}-${index + 1}`,
    sector: item.sector,
    title: item.title,
    source: item.source,
    date: formatDate(item.publishedAt, config.timezone),
    url: item.url,
    summary: buildItemSummary(item),
    relevance: buildRelevance(item.sector),
    importance: item.score >= config.highImportanceScore ? '高' : '中'
  })),
  meta: {
    engine: 'Google News RSS + keyword scoring',
    warningCount: warnings.length,
    warnings: warnings.slice(0, 10)
  }
};

await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`已生成 ${allItems.length} 条免费 RSS 行业情报。`);
if (warnings.length) console.warn(`部分 RSS 请求失败：${warnings.length} 条。`);

function buildGoogleNewsRssUrl(query, cfg) {
  const q = `${query} when:${cfg.googleNewsLookbackDays}d`;
  const params = new URLSearchParams({
    q,
    hl: cfg.googleNews.hl,
    gl: cfg.googleNews.gl,
    ceid: cfg.googleNews.ceid
  });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ShengDailyWorkbench/1.0; +https://github.com/)'
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseRss(xml, sector, query) {
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  return blocks.map((block) => {
    const rawTitle = readTag(block, 'title');
    const source = readSource(block) || inferSourceFromTitle(rawTitle) || 'Google News';
    const title = cleanTitle(rawTitle, source);
    const url = decodeXml(readTag(block, 'link')).trim();
    const pubDate = decodeXml(readTag(block, 'pubDate')).trim();
    const publishedAt = new Date(pubDate);
    return {
      sector,
      query,
      title,
      source,
      url,
      publishedAt: Number.isNaN(publishedAt.getTime()) ? new Date(0) : publishedAt
    };
  }).filter((item) => item.title && /^https?:\/\//.test(item.url));
}

function readTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXml(stripCdata(match[1])).trim() : '';
}

function readSource(block) {
  const match = block.match(/<source(?:\s[^>]*)?>([\s\S]*?)<\/source>/i);
  return match ? decodeXml(stripCdata(match[1])).trim() : '';
}

function stripCdata(value) {
  return value.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/<[^>]+>/g, '')
    .trim();
}

function inferSourceFromTitle(title) {
  const parts = decodeXml(title).split(' - ');
  return parts.length > 1 ? parts.at(-1).trim() : '';
}

function cleanTitle(title, source) {
  let cleaned = decodeXml(title).replace(/\s+/g, ' ').trim();
  if (source && cleaned.endsWith(` - ${source}`)) {
    cleaned = cleaned.slice(0, -(` - ${source}`.length)).trim();
  }
  return cleaned;
}

function selectItems(candidates, sector, cfg, referenceTime) {
  const cutoff = referenceTime.getTime() - cfg.maxAgeHours * 60 * 60 * 1000;
  const deduped = new Map();

  for (const item of candidates) {
    if (item.publishedAt.getTime() < cutoff) continue;
    const normalized = normalizeTitle(item.title);
    if (!normalized) continue;

    const score = calculateScore(item, sector, cfg, referenceTime);
    const current = deduped.get(normalized);
    if (!current || score > current.score) deduped.set(normalized, { ...item, score });
  }

  const sorted = [...deduped.values()].sort((a, b) => b.score - a.score || b.publishedAt - a.publishedAt);
  const selected = [];
  for (const item of sorted) {
    const tooSimilar = selected.some((chosen) => similarity(normalizeTitle(chosen.title), normalizeTitle(item.title)) >= 0.72);
    if (!tooSimilar) selected.push(item);
    if (selected.length >= cfg.itemsPerSector) break;
  }
  return selected;
}

function calculateScore(item, sector, cfg, referenceTime) {
  const ageHours = Math.max(0, (referenceTime - item.publishedAt) / 36e5);
  let score = Math.max(0, cfg.recencyWeight - ageHours / 12);
  const haystack = `${item.title} ${item.source}`.toLowerCase();

  for (const keyword of sector.keywords) {
    if (includesKeyword(haystack, keyword)) score += 3;
  }
  for (const keyword of cfg.priorityKeywords) {
    if (includesKeyword(haystack, keyword)) score += 2;
  }
  for (const source of cfg.preferredSources) {
    if (item.source.toLowerCase().includes(source.toLowerCase())) score += 2;
  }
  return Number(score.toFixed(2));
}

function includesKeyword(haystack, keyword) {
  const needle = keyword.toLowerCase().trim();
  if (!needle) return false;
  if (/^[a-z0-9]+$/i.test(needle) && needle.length <= 3) {
    return new RegExp(`\\b${escapeRegExp(needle)}\\b`, 'i').test(haystack);
  }
  return haystack.includes(needle);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .replace(/(最新|消息|报道|宣布|发布)/g, '')
    .slice(0, 120);
}

function similarity(a, b) {
  const aSet = new Set(toBigrams(a));
  const bSet = new Set(toBigrams(b));
  if (!aSet.size || !bSet.size) return 0;
  let intersection = 0;
  for (const token of aSet) if (bSet.has(token)) intersection += 1;
  return intersection / Math.max(aSet.size, bSet.size);
}

function toBigrams(text) {
  const result = [];
  for (let i = 0; i < text.length - 1; i += 1) result.push(text.slice(i, i + 2));
  return result;
}

function buildOverallSummary(items, signals, cfg) {
  const counts = countBy(items, (item) => item.sector);
  const ordered = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const distribution = ordered.map(([sector, count]) => `${sector}${count}条`).join('、');
  const topSignal = signals[0] || '行业动态主要集中在品牌、渠道和市场扩张';
  return `今日自动收录${items.length}条行业动态，分布为${distribution}。规则引擎基于发布时间、关键词匹配和来源优先级完成筛选与去重。${topSignal}。建议把本页作为每日5分钟信息入口，涉及重大求职或营销判断时，再将原文复制给 ChatGPT 做深度分析。`;
}

function buildSignals(items, cfg) {
  const text = items.map((item) => item.title).join(' ').toLowerCase();
  const rankedThemes = cfg.themeRules
    .map((theme) => ({
      name: theme.name,
      count: theme.keywords.reduce((sum, keyword) => sum + countOccurrences(text, keyword.toLowerCase()), 0)
    }))
    .filter((theme) => theme.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  const sectorCounts = countBy(items, (item) => item.sector);
  const strongestSector = Object.entries(sectorCounts).sort((a, b) => b[1] - a[1])[0];
  const signals = rankedThemes.map((theme) => `今日高频主题为“${theme.name}”，在已收录标题中出现${theme.count}次。`);
  if (strongestSector) signals.push(`${strongestSector[0]}今日收录${strongestSector[1]}条，是本次更新中动态最集中的赛道。`);
  signals.push(`本次内容来自公开 RSS 聚合，重要决策前应打开原文核对完整背景、数据口径与发布日期。`);
  return signals.slice(0, 5);
}

function buildActions(items, signals) {
  const actions = [
    '从“高”重要度内容中选1条，记录其对品牌、渠道、内容或转化的影响，积累面试可用行业观点。',
    '打开与你目标公司或平台相关的原文，提炼“发生了什么—为什么重要—我会怎么做”三段式笔记。',
    '将今日新闻标题和链接复制到 ChatGPT，要求结合你的 Brand、E-commerce、Digital Marketing 与 Overseas Marketing 求职方向做深度小结。'
  ];
  if (items.some((item) => /财报|营收|利润|业绩|季度/i.test(item.title))) {
    actions.unshift('优先阅读财报或业绩类新闻，记录增长来源、渠道变化与管理层措辞，训练商业分析能力。');
  }
  if (signals.some((signal) => signal.includes('出海'))) {
    actions.push('检查出海动态中的市场、渠道和本地化做法，补充到 Overseas Marketing 案例库。');
  }
  return [...new Set(actions)].slice(0, 5);
}

function buildItemSummary(item) {
  return `${item.source}发布了与“${item.title}”相关的动态。该条目由 RSS 规则引擎依据发布时间、关键词和来源进行筛选；请打开原文确认具体数据、背景及企业表述。`;
}

function buildRelevance(sector) {
  const map = {
    '个护美妆快消': '可用于跟踪 Beauty/FMCG 品牌策略、新品、消费者趋势和渠道动作，为 Brand Marketing 与秋招面试积累案例。',
    '电商': '可用于观察平台规则、流量、转化、零售媒体和内容电商变化，为 E-commerce 与 Digital Marketing 判断提供线索。',
    '运动服饰': '可用于跟踪运动户外品牌的产品、会员、渠道和 Campaign 动作，与你已有运动品牌经历形成连接。',
    '品牌出海': '可用于观察跨境渠道、海外本地化、DTC 与全球营销方法，为 Overseas Marketing 求职和案例分析积累素材。'
  };
  return map[sector] || '可作为行业观察与求职准备材料，建议结合原文进一步分析。';
}

function countBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function countOccurrences(text, keyword) {
  if (!keyword) return 0;
  return text.split(keyword).length - 1;
}

function formatDate(date, timeZone) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}
