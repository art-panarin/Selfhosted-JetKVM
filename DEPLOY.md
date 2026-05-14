# JetKVM Cloud — Deploy Guide

## Dev vs Production: ключевые отличия

| Аспект | Dev (`compose.yaml`) | Production (`docker-compose.prod.yaml`) |
|--------|----------------------|------------------------------------------|
| Docker image | Локальная сборка из `Dockerfile` (только API) | Multi-stage `Dockerfile.prod` (UI + API в одном образе) |
| UI раздача | Volume mount `./ui-dist:/ui-dist:ro` (ручная сборка) | UI собирается внутри Docker, копируется в `/usr/src/app/ui-dist` |
| API код | Volume mount `./dist:/usr/src/app/dist:ro` (hot-reload) | Компилируется внутри Docker, копируется в `/usr/src/app/dist` |
| Build context | `Cloud-API_Dev/` | `..` (корень JetKVM-All — нужен доступ к `KVM_Dev/ui/`) |
| HTTPS | Нет (HTTP :3000 напрямую) | Caddy reverse proxy с автоматическим Let's Encrypt |
| Порты наружу | `3000:3000` | `80`, `443` (через Caddy) |
| Env файл | `.env` | `.env.prod` |
| Cookie secure | `false` | `true` (HTTPS обязателен) |
| DB пароль | По умолчанию `jetkvm` | Генерируется (`openssl rand -hex 16`) |
| TURN конфиг | `coturn/turnserver.conf` | `coturn/turnserver.prod.conf` |
| Caddy | Нет | `caddy:2-alpine` с `Caddyfile` |

## Фиксированные параметры (не требуют изменения)

Эти значения зашиты в конфигурации и не должны меняться:

| Параметр | Значение | Где задан |
|----------|----------|-----------|
| `NODE_ENV` | `production` | `.env.prod`, `Dockerfile.prod` |
| `PORT` | `3000` | `Dockerfile.prod`, `docker-compose.prod.yaml` |
| `UI_DIST_PATH` | `/usr/src/app/ui-dist` | `Dockerfile.prod` |
| POSTGRES_USER | `jetkvm` | `docker-compose.prod.yaml` |
| POSTGRES_DB | `jetkvm` | `docker-compose.prod.yaml` |
| Caddy ports | `80:80`, `443:443` | `docker-compose.prod.yaml` |
| TURN listening-port | `3478` | `turnserver.prod.conf` |
| TURN min/max port | `49152-65535` | `turnserver.prod.conf` |
| JWT algorithm | `HS256` | `src/email-auth.ts` |
| JWT TTL | `24h` | `src/email-auth.ts` |
| bcrypt cost | `12` | `src/email-auth.ts` |
| Cookie `sameSite` | `strict` | `src/index.ts` |
| Cookie `httpOnly` | `true` | `src/index.ts` |
| Cookie `maxAge` | `24h` | `src/index.ts` |

## Параметры, которые ОБЯЗАТЕЛЬНО настроить

| Параметр | Описание | Пример |
|----------|----------|--------|
| `DOMAIN` | Доменное имя с DNS A-записью на IP сервера | `kvm.example.com` |
| `PUBLIC_IP` | Белый IP сервера (для coturn `external-ip`) | `203.0.113.10` |
| `DB_PASSWORD` | Пароль PostgreSQL | `openssl rand -hex 16` |
| `COOKIE_SECRET` | Секрет шифрования cookie-session | `openssl rand -hex 32` |
| `JWT_SECRET` | Секрет подписи JWT токенов | `openssl rand -hex 32` |
| `TURN_SECRET` | Shared secret для coturn | `openssl rand -hex 32` |

Все секреты должны быть уникальными и сгенерированы криптографически.

## Архитектура Docker-сборки

### Dockerfile.prod — три стадии

```
Stage 1: ui-builder (node:22-alpine)
  ├── Копирует KVM_Dev/ui/
  ├── npm ci
  ├── Создаёт placeholder для sse.html (symlink в Go-код, не нужен в cloud)
  ├── npm run i18n:compile
  └── vite build --mode=cloud-selfhosted → /ui/dist/

Stage 2: api-builder (node:22-alpine)
  ├── Копирует Cloud-API_Dev/package*.json
  ├── npm ci
  ├── Копирует Cloud-API_Dev/
  └── npm run build (TypeScript → JavaScript) → /usr/src/app/dist/

Stage 3: production (node:22-alpine)
  ├── apk add openssl (для Prisma)
  ├── npm ci --omit=dev (только production зависимости)
  ├── Копирует prisma/ из api-builder
  ├── npx prisma generate (генерирует клиент для runtime)
  ├── Копирует dist/ из api-builder
  ├── Копирует ui-dist/ из ui-builder
  └── CMD ["node", "./dist/index.js"]
```

### docker-compose.prod.yaml — пять сервисов

```
db (postgres:16-alpine)
  └── Данные в volume `postgresql`

app-migrate (одноразовый)
  └── npx prisma migrate deploy → создаёт таблицы

app (Cloud API + UI)
  └── node ./dist/index.js на порту 3000 (внутренний)

turn (coturn)
  └── network_mode: host (нужен для UDP media relay)

caddy (caddy:2-alpine)
  └── Reverse proxy → app:3000, автоматический HTTPS
```

## Сетевая схема (production)

```
Интернет
    │
    ├── TCP 80/443 ──→ Caddy ──→ app:3000 (HTTP/WebSocket)
    │                   (HTTPS termination, Let's Encrypt)
    │
    ├── TCP+UDP 3478 ──→ coturn (TURN signaling)
    │
    └── UDP 49152-65535 ──→ coturn (media relay)
```

**Важно**: coturn работает в `network_mode: host` — он слушает напрямую на интерфейсах хоста, минуя Docker networking. Это необходимо для корректной работы UDP media relay.

## Что раздаёт Cloud API

```
GET /healthz                    → JSON health check
GET /auth/*, /me, /logout       → API endpoints (JSON)
GET /devices, /devices/:id      → API endpoints (JSON, если Accept: application/json)
GET /webrtc/*                   → API endpoints (JSON)
POST /auth/register, /auth/login → API endpoints
WS  /                           → WebSocket: device registration
WS  /webrtc/signaling/client    → WebSocket: client signaling

GET /* (Accept: text/html)      → SPA fallback → ui-dist/index.html
GET /assets/*                   → Static files из ui-dist/
```

SPA fallback работает по заголовку `Accept: text/html` — браузерная навигация получает React SPA, а fetch/XHR запросы (Accept: application/json) проходят к API.

## Безопасность

- **Cookie**: `httpOnly`, `sameSite: strict`, `secure: true` в production
- **Пароли**: bcrypt cost 12
- **JWT**: HS256, 24h TTL, issuer/audience проверяются
- **Identity tokens**: HMAC-SHA256 с 120-секундным окном для WebRTC session setup
- **TURN credentials**: HMAC-SHA1 временные (TTL 24h), генерируются per-session
- **Caddy**: автоматический HTTPS с Let's Encrypt, HTTP→HTTPS redirect
- **Trust proxy**: Express доверяет `X-Forwarded-For` от Caddy для определения реального IP
