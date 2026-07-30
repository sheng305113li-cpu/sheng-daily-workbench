import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
const CONFIG_PATH = new URL('../config/news-config.json', import.meta.url);
const OUTPUT_PATH = new URL('../news-data.json', import.meta.url);

if (!API_KEY) {
  throw new Error('缺少 OPENAI_API_KEY。请在 GitHub 仓库的 Actions secrets 中添加该密钥。');
}

const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
const sectorNames = config.sectors.map((sector) => sector.name);
const now = new Date();
const reportDate = new Intl.DateTimeFormat('zh-CN', {
  timeZone: config.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(now);

const schema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    keySignals: {
      type: 'array',
      items: { type: 'string' }
    },
    recommendedActions: {
      type: 'array',
      items: { type: 'string' }
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sector: { type: 'string', enum: sectorNames },
          title: { type: 'string' },
          source: { type: 'string' },
          date: { type: 'string' },
          url: { type: 'string' },
          summary: { type: 'string' },
          relevance: { type: 'string' },
          importance: { type: 'string', enum: ['高', '中'] }
        },
        required: ['sector', 'title', 'source', 'date', 'url', 'summary', 'relevance', 'importance'],
        additionalProperties: false
      }
    }
  },
  required: ['summary', 'keySignals', 'recommendedActions', 'items'],
  additionalProperties: false
};

const sectorPrompt = config.sectors
  .map((sector, index) => `${index + 1}. ${sector.name}：${sector.focus}`)
  .join('\n');
const priorityPrompt = config.analysisPriorities.map((item) => `- ${item}`).join('\n');

const prompt = `
今天是 ${reportDate}，时区为 ${config.timezone}。
请使用网页搜索，为个人工作台生成一份“每日行业情报”。

覆盖赛道：
${sectorPrompt}

筛选要求：
- 重点搜索最近 ${config.lookbackHours} 小时内的实质性动态。
- 每个赛道选择 ${config.itemsPerSector} 条最值得关注的事件，总量应尽量为 ${config.itemsPerSector * config.sectors.length} 条。
- 若某赛道最近 ${config.lookbackHours} 小时没有足够重要的内容，可放宽到最近 7 天，但必须使用真实发布日期。
- 每条必须提供能够直接打开的真实原文 URL；不要编造链接。
- 同一事件不要重复收录，宣传软文和缺乏事实支撑的内容应降权或排除。

分析偏好：
${priorityPrompt}

输出要求：
- summary：150—250字，综合说明今天最重要的变化及其共同方向。
- keySignals：3—5条趋势信号，每条一句话。
- recommendedActions：3—5条与你的求职、学习、Campaign分析或数据分析相关的可执行建议。
- items：每条新闻的 summary 用2—3句话概括事实；relevance 说明它对 Brand、E-commerce、Digital Marketing、Overseas Marketing 或秋招准备有什么意义。
`;

const response = await fetch('https://api.openai.com/v1/responses', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: MODEL,
    store: false,
    tools: [{ type: 'web_search' }],
    input: [
      {
        role: 'system',
        content: '你是一名严谨的行业研究员。你必须核对日期、来源和链接，并将事实与分析分开。'
      },
      { role: 'user', content: prompt }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'daily_industry_intelligence',
        strict: true,
        schema
      }
    },
    max_output_tokens: 6500
  })
});

if (!response.ok) {
  const body = await response.text();
  throw new Error(`OpenAI API 请求失败：HTTP ${response.status}\n${body}`);
}

const payload = await response.json();
const outputText = extractOutputText(payload);
const result = JSON.parse(outputText);

const normalizedItems = result.items
  .filter((item) => sectorNames.includes(item.sector))
  .map((item, index) => ({
    id: `auto-${now.toISOString().slice(0, 10)}-${index + 1}`,
    ...item,
    url: normalizeUrl(item.url)
  }))
  .filter((item) => item.url);

const output = {
  version: 1,
  generatedAt: now.toISOString(),
  date: reportDate,
  timezone: config.timezone,
  model: MODEL,
  summary: result.summary,
  keySignals: result.keySignals,
  recommendedActions: result.recommendedActions,
  items: normalizedItems
};

await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`已生成 ${normalizedItems.length} 条行业情报：${OUTPUT_PATH.pathname}`);

function extractOutputText(data) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text;
  }
  for (const item of data.output || []) {
    if (item.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content.type === 'output_text' && typeof content.text === 'string') {
        return content.text;
      }
    }
  }
  throw new Error('API 返回中没有可解析的 output_text。');
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}
