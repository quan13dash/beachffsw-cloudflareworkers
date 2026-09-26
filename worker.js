// Helper: Random float cho count
function getRandomFloat(min, max) {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return min + (array[0] / (0xFFFFFFFF + 1)) * (max - min);
}

// Helper: Random int cho views
function getRandomInt(min, max) {
  const minInt = Math.ceil(min);
  const maxInt = Math.floor(max);
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return Math.floor(minInt + (array[0] / (0xFFFFFFFF + 1)) * (maxInt - minInt + 1));
}

// Helper: Áp dụng boostingrate
function applyBoosting(gain, rate) {
  if (rate <= 0) rate = 1;
  return gain >= 0 ? gain * rate : gain / rate;
}

// Core Logic: Cập nhật dữ liệu
async function updateAllItems(env) {
  const list = await env.ITEMS_KV.list({ prefix: 'item:' });
  const now = Date.now();

  for (const keyObj of list.keys) {
    const rawData = await env.ITEMS_KV.get(keyObj.name);
    if (!rawData) continue;

    const item = JSON.parse(rawData);
    let rate = item.boostingrate !== undefined ? Number(item.boostingrate) : 1;
    let slowRate = item.slowingrate !== undefined ? Number(item.slowingrate) : 5;
    if (slowRate <= 0) slowRate = 5;

    let lastUpdate = item.lastBoostUpdate || now;

    // Giảm boostingrate 0.01 mỗi slowingrate phút
    if (rate > 1.00) {
      const elapsedMs = now - lastUpdate;
      const intervalMs = slowRate * 60 * 1000;
      const timeBlocks = Math.floor(elapsedMs / intervalMs);

      if (timeBlocks > 0) {
        rate = rate - (timeBlocks * 0.01);
        if (rate < 1.00) rate = 1.00;
        lastUpdate = lastUpdate + (timeBlocks * intervalMs);
      }
    }

    rate = Math.round(rate * 100) / 100;
    item.boostingrate = rate;
    item.slowingrate = slowRate;
    item.lastBoostUpdate = lastUpdate;

    // Cập nhật count
    if (item.min !== undefined && item.max !== undefined) {
      const rawGain = getRandomFloat(item.min, item.max);
      const boostedGain = applyBoosting(rawGain, rate);
      item.count = Number(item.count) + boostedGain;
      item.roundcount = Math.floor(item.count);
    }

    // Cập nhật views
    if (item.minv !== undefined && item.maxv !== undefined && (item.minv !== 0 || item.maxv !== 0)) {
      const rawViewsGain = getRandomInt(item.minv, item.maxv);
      const boostedViewsGain = applyBoosting(rawViewsGain, rate);
      item.views = Math.floor(Number(item.views || 0)) + Math.round(boostedViewsGain);
    }

    await env.ITEMS_KV.put(keyObj.name, JSON.stringify(item));
  }
}

// Delay helper
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default {
  // 1. TỰ ĐỘNG CHẠY 15s MỖI LẦN (CRON TRIGGER 1 PHÚT LÀM MỒI)
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      for (let i = 0; i < 4; i++) {
        await updateAllItems(env);
        if (i < 3) await sleep(15000); // Chờ đúng 15 giây cho đợt tiếp theo
      }
    })());
  },

  // 2. HTTP HANDLER (CORS & ROUTING)
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    // Trigger update thủ công qua HTTP (không bắt buộc Cron)
    if (pathname === '/api/cron' || pathname === '/api/cron/') {
      await updateAllItems(env);
      return Response.json({ success: true, message: 'Updated manually' }, { headers: corsHeaders });
    }

    // Route GET /api -> Liệt kê danh sách ID
    if (pathname === '/api' || pathname === '/api/') {
      const list = await env.ITEMS_KV.list({ prefix: 'item:' });
      const ids = list.keys.map((k) => k.name.replace(/^item:/, ''));
      return Response.json(ids, { headers: corsHeaders });
    }

    // Route GET /api/all -> Lấy toàn bộ items cho Public Frontend
    if (pathname === '/api/all') {
      const list = await env.ITEMS_KV.list({ prefix: 'item:' });
      const items = [];

      for (const keyObj of list.keys) {
        const raw = await env.ITEMS_KV.get(keyObj.name);
        if (raw) {
          const data = JSON.parse(raw);
          const { count, min, max, minv, maxv, slowingrate, lastBoostUpdate, ...rest } = data;
          items.push({
            ...rest,
            username: data.username || '',
            description: data.description || '',
            country: data.country || '',
            contenttype: data.contenttype || '',
            count: data.roundcount ?? 0,
            views: Math.floor(data.views ?? 0),
            videos: Math.floor(data.videos ?? 0),
            boostingrate: data.boostingrate ?? 1
          });
        }
      }
      return Response.json(items, { headers: corsHeaders });
    }

    // Route POST /api/[id].json hoặc GET /api/[id].json
    const match = pathname.match(/^\/api\/([^/]+)\.json$/);
    if (match) {
      const itemId = match[1];
      const kvKey = `item:${itemId}`;

      // POST: Tạo hoặc sửa Item
      if (request.method === 'POST') {
        try {
          const body = await request.json();
          const count = Number(body.count) || 0;
          const views = Math.floor(Number(body.views) || 0);
          const videos = Math.floor(Number(body.videos) || 0);
          const boostingrate = body.boostingrate !== undefined ? Number(body.boostingrate) : 1;
          const slowingrate = body.slowingrate !== undefined ? Number(body.slowingrate) : 5;

          const newItem = {
            id: itemId,
            name: body.name || '',
            username: body.username || '',
            description: body.description || '',
            country: body.country || '',
            contenttype: body.contenttype || '',
            image: body.image || '',
            banner: body.banner || '',
            count: count,
            min: Number(body.min),
            max: Number(body.max),
            roundcount: Math.floor(count),
            views: views,
            minv: body.minv !== undefined ? Math.floor(Number(body.minv)) : 0,
            maxv: body.maxv !== undefined ? Math.floor(Number(body.maxv)) : 0,
            videos: videos,
            boostingrate: boostingrate > 0 ? boostingrate : 1,
            slowingrate: slowingrate > 0 ? slowingrate : 5,
            lastBoostUpdate: Date.now()
          };

          await env.ITEMS_KV.put(kvKey, JSON.stringify(newItem));
          return Response.json({ message: 'Saved successfully', data: newItem }, { status: 201, headers: corsHeaders });
        } catch (err) {
          return Response.json({ error: 'Invalid JSON payload' }, { status: 400, headers: corsHeaders });
        }
      }

      // GET: Lấy thông tin 1 item
      if (request.method === 'GET') {
        const raw = await env.ITEMS_KV.get(kvKey);
        if (!raw) {
          return Response.json({ error: `Item ${itemId}.json not found` }, { status: 404, headers: corsHeaders });
        }
        return Response.json(JSON.parse(raw), { headers: corsHeaders });
      }
    }

    return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders });
  }
};
