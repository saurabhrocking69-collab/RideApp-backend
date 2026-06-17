const { createClient } = require('redis');
const { Redis: IORedis } = require('ioredis');

const redis = createClient({
  url: process.env.REDIS_URL,
  socket: { tls: process.env.REDIS_URL?.includes('rediss') },
});

redis.connect();
redis.on('ready', () => console.log('✅ Redis connected!'));
redis.on('error', (err) => console.log('❌ Redis error:', err.message));

const makeBmqConn = () => new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  ...(process.env.REDIS_URL?.startsWith('rediss://') ? { tls: {} } : {}),
});

module.exports = { redis, makeBmqConn };
