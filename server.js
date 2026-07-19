require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors()); // разрешаем сайту делать fetch() с браузера (GET-статус публичный)

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const USERNAME = process.env.STATUS_USERNAME || 'sky';
// Через сколько секунд без heartbeat считаем телефон офлайн, даже если
// последний присланный статус был "online" (сработает, если телефон
// потерял связь и не смог прислать "offline" при выключении экрана и т.п.)
const OFFLINE_AFTER_SECONDS = parseInt(process.env.OFFLINE_AFTER_SECONDS || '180', 10);

if (!API_KEY) {
  console.error('ОШИБКА: не задан API_KEY в переменных окружения');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('ОШИБКА: не задан DATABASE_URL в переменных окружения');
  process.exit(1);
}

// Railway (и большинство облачных Postgres) требуют SSL, но с
// самоподписанным сертификатом — поэтому rejectUnauthorized: false
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- Вспомогательная функция проверки ключа ---
function isAuthorized(req) {
  const headerKey = req.get('x-api-key');
  const bodyKey = req.body && req.body.api_key;
  const key = headerKey || bodyKey;
  return key === API_KEY;
}

// --- POST /api/status : приём heartbeat от Android (MacroDroid) ---
app.post('/api/status', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized: неверный или отсутствующий API-ключ' });
  }

  const status = req.body.status;
  if (status !== 'online' && status !== 'offline') {
    return res.status(400).json({ ok: false, error: 'Параметр status должен быть "online" или "offline"' });
  }

  try {
    const updateResult = await pool.query(
      'UPDATE users SET status = $1, last_seen = NOW() WHERE username = $2',
      [status, USERNAME]
    );

    // Если пользователя ещё нет в таблице — создаём его при первом запросе
    if (updateResult.rowCount === 0) {
      await pool.query(
        'INSERT INTO users (username, status, last_seen) VALUES ($1, $2, NOW())',
        [USERNAME, status]
      );
    }

    return res.status(200).json({
      ok: true,
      message: `Статус обновлён на "${status}"`,
      status,
      last_seen: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Ошибка при обновлении БД:', err);
    return res.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера' });
  }
});

// --- GET /api/status : публичный эндпоинт для сайта (без ключа) ---
// Отдаёт текущий статус с учётом heartbeat-таймаута.
app.get('/api/status', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT status, last_seen FROM users WHERE username = $1 LIMIT 1',
      [USERNAME]
    );

    if (result.rows.length === 0) {
      return res.status(200).json({ status: 'offline', last_seen: null });
    }

    const row = result.rows[0];
    const lastSeenDate = new Date(row.last_seen);
    const secondsSinceLastSeen = (Date.now() - lastSeenDate.getTime()) / 1000;

    // Если давно не было heartbeat — принудительно считаем офлайн,
    // независимо от того, что было записано последним.
    const effectiveStatus =
      secondsSinceLastSeen > OFFLINE_AFTER_SECONDS ? 'offline' : row.status;

    return res.status(200).json({
      status: effectiveStatus,
      last_seen: lastSeenDate.toISOString(),
    });
  } catch (err) {
    console.error('Ошибка при чтении БД:', err);
    return res.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера' });
  }
});

// Простой healthcheck — полезно для Railway, чтобы видеть, что сервис жив
app.get('/', (req, res) => {
  res.status(200).send('Status server работает.');
});

app.listen(PORT, () => {
  console.log(`Status server запущен на порту ${PORT}`);
});
