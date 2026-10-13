import { Redis } from '@upstash/redis';

// Hàm khởi tạo Upstash Redis từ biến môi trường Cloudflare Secrets
function getRedis(env) {
  return new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });
}

function getRandomFloat(min, max) {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return min + (array[0] / (0xFFFFFFFF + 1)) * (max - min);
}

function getRandomInt(min, max) {
  const minInt = Math.ceil(min);
  const maxInt = Math.floor(max);
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return Math.floor(minInt + (array[0] / (0xFFFFFFFF + 1)) * (maxInt - minInt + 1));
}

function applyBoosting(gain, rate) {
  if (rate <= 0) rate = 1;
  return gain >= 0 ? gain * rate : gain / rate;
}

// Hàm tính toán và cập nhật dồn (Lazy Update) dựa trên khoảng thời gian thực tế đã trôi qua
async function calculateAndUpdateItem(item) {
  const now = Date.now();
  let rate = item.boostingrate !== undefined ? Number(item.boostingrate) : 1;
  let slowRate = item.slowingrate !== undefined ? Number(item.slowingrate) : 5;
  if (slowRate <= 0) slowRate = 5;

  let lastUpdate = item.lastBoostUpdate || now;
  const elapsedMs = now - lastUpdate;

  if (elapsedMs > 0) {
    // 1. Cập nhật giảm boostingrate nếu rate > 1.00
    if (rate > 1.00) {
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

    // 2. Tính toán lượng tăng/giảm của count và views dựa trên số khoảng thời gian 15s đã qua
    // Giả sử cứ mỗi 15 giây là 1 nhịp tăng
    const stepSeconds = 15;
    const steps = Math.floor(elapsedMs / (stepSeconds * 1000));

    if (steps > 0) {
      // Cập nhật count
      if (item.min !== undefined && item.max !== undefined) {
        let totalGain = 0;
        for (let i = 0; i < steps; i++) {
          const rawGain = getRandomFloat(item.min, item.max);
          totalGain += applyBoosting(rawGain, rate);
        }
        item.count = Number(item.count) + totalGain;
        item.roundcount = Math.floor(item.count);
      }

      // Cập nhật views
      if (item.minv !== undefined && item.maxv !== undefined && (item.minv !== 0 || item.maxv !== 0)) {
        let totalViewsGain = 0;
        for (let i = 0; i < steps; i++) {
          const rawViewsGain = getRandomInt(item.minv, item.maxv);
          totalViewsGain += applyBoosting(rawViewsGain, rate);
        }
        item.views = Math.floor(Number(item.views || 0)) + Math.round(totalViewsGain);
      }

      // Cập nhật lại mốc thời gian cuối cùng đã cộng dồn
      item.lastBoostUpdate = lastUpdate + (steps * stepSeconds * 1000);
    }
  }
  return item;
}

export default {
  async fetch(request, env, ctx) {
    const redis = getRedis(env);
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

    // Route GET /api -> Liệt kê danh sách ID từ Redis
    if (pathname === '/api' || pathname === '/api/') {
      const keys = await redis.keys('item:*');
      const ids = keys.map((k) => k.replace(/^item:/, ''));
      return Response.json(ids, { headers: corsHeaders });
    }

    // Route GET /api/all -> Lấy toàn bộ items (có cập nhật tự động khi có request)
    if (pathname === '/api/all') {
      const keys = await redis.keys('item:*');
      if (!keys || keys.length === 0) {
        return Response.json([], { headers: corsHeaders });
      }

      const items = await redis.mget(...keys);
      const cleanedItems = [];

      for (let i = 0; i < items.length; i++) {
        let data = items[i];
        if (!data) continue;
        if (typeof data === 'string') data = JSON.parse(data);

        // Chạy cập nhật bù thời gian (Lazy Update)
        data = await calculateAndUpdateItem(data);
        await redis.set(keys[i], data); // Lưu lại giá trị mới vào Redis

        const { count, min, max, minv, maxv, slowingrate, lastBoostUpdate, ...rest } = data;
        cleanedItems.push({
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

      return Response.json(cleanedItems, { headers: corsHeaders });
    }

    // Route POST /api/[id].json hoặc GET /api/[id].json
    const match = pathname.match(/^\/api\/([^/]+)\.json$/);
    if (match) {
      const itemId = match[1];
      const redisKey = `item:${itemId}`;

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

          await redis.set(redisKey, newItem);
          return Response.json({ message: 'Saved successfully', data: newItem }, { status: 201, headers: corsHeaders });
        } catch (err) {
          return Response.json({ error: 'Invalid JSON payload' }, { status: 400, headers: corsHeaders });
        }
      }

      // GET: Lấy thông tin 1 item cụ thể
      if (request.method === 'GET') {
        let data = await redis.get(redisKey);
        if (!data) {
          return Response.json({ error: `Item ${itemId}.json not found` }, { status: 404, headers: corsHeaders });
        }
        if (typeof data === 'string') data = JSON.parse(data);

        // Lazy update cho riêng item này
        data = await calculateAndUpdateItem(data);
        await redis.set(redisKey, data);

        return Response.json(data, { headers: corsHeaders });
      }
    }

    return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders });
  }
};
