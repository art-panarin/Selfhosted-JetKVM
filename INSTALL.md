# JetKVM Cloud — Установка на VPS с нуля

Пошаговая инструкция по развёртыванию JetKVM Cloud на чистом VPS сервере с публичным IP.

---

## 1. Требования к серверу

### Минимальные характеристики
- **OS**: Ubuntu 22.04+ / Debian 12+ (или любой Linux с Docker)
- **CPU**: 1 vCPU
- **RAM**: 1 GB
- **Диск**: 10 GB
- **Публичный IP**: обязателен (белый IP)

### Необходимое ПО
- Docker Engine 24+
- Docker Compose v2 (встроен в Docker Engine)
- openssl (для генерации секретов)
- git (для клонирования репозитория)

### DNS
- Доменное имя с A-записью, указывающей на публичный IP сервера
- Пример: `kvm.example.com → 203.0.113.10`

### Открытые порты (firewall)

| Порт | Протокол | Назначение |
|------|----------|-----------|
| 22 | TCP | SSH (администрирование) |
| 80 | TCP | HTTP (Caddy, Let's Encrypt challenge) |
| 443 | TCP + UDP | HTTPS (Caddy), HTTP/3 (QUIC) |
| 3478 | TCP + UDP | TURN signaling (coturn) |
| 49152-65535 | UDP | TURN media relay (coturn) |

---

## 2. Подготовка сервера

### 2.1 Установка Docker (Ubuntu/Debian)

```bash
# Обновление пакетов
sudo apt update && sudo apt upgrade -y

# Установка Docker
curl -fsSL https://get.docker.com | sh

# Добавить текущего пользователя в группу docker
sudo usermod -aG docker $USER

# Перелогиниться (или выполнить newgrp docker)
newgrp docker

# Проверка
docker --version
docker compose version
```

### 2.2 Установка вспомогательных утилит

```bash
sudo apt install -y git openssl
```

### 2.3 Настройка firewall (UFW)

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 49152:65535/udp
sudo ufw enable
sudo ufw status
```

> **Важно**: Если используется облачный firewall (AWS Security Groups, DigitalOcean Firewall, Hetzner Firewall и т.д.), порты нужно открыть и там тоже.

---

## 3. Клонирование и настройка

### 3.1 Клонирование репозитория

```bash
cd ~
git clone <URL-вашего-репозитория> jetkvm
cd jetkvm/Cloud-API_Dev
```

### 3.2 Автоматическая установка (рекомендуется)

```bash
bash setup.sh
```

Скрипт запросит:
1. **Domain name** — ваш домен (например `kvm.example.com`)
2. **Server public IP** — публичный IP сервера
3. **Admin email** — email для Let's Encrypt (опционально, но рекомендуется)

Скрипт автоматически:
- Сгенерирует все секреты (`openssl rand -hex`)
- Создаст `.env.prod` с заполненными переменными
- Создаст `Caddyfile` с вашим доменом
- Создаст `coturn/turnserver.prod.conf` с вашим IP
- Соберёт Docker-образ
- Запустит все сервисы

**После завершения перейдите к разделу 5 (Проверка).**

### 3.3 Ручная установка

Если автоматическая установка не подходит:

#### Шаг 1: Создать `.env.prod`

```bash
cp .env.prod.example .env.prod
```

#### Шаг 2: Сгенерировать секреты

```bash
# Выполнить в терминале и записать результаты
echo "DB_PASSWORD: $(openssl rand -hex 16)"
echo "COOKIE_SECRET: $(openssl rand -hex 32)"
echo "JWT_SECRET: $(openssl rand -hex 32)"
echo "TURN_SECRET: $(openssl rand -hex 32)"
```

#### Шаг 3: Заполнить `.env.prod`

Откройте файл в редакторе:

```bash
nano .env.prod
```

Заменить:

```env
# Ваш домен
DOMAIN=kvm.example.com

# Полные URL (обязательно https://)
API_HOSTNAME=https://kvm.example.com
APP_HOSTNAME=https://kvm.example.com

# Пароль базы данных (из шага 2)
DB_PASSWORD=<сгенерированный_пароль>
DATABASE_URL=postgresql://jetkvm:<сгенерированный_пароль>@db:5432/jetkvm?schema=public

# Секреты (из шага 2, каждый уникальный)
COOKIE_SECRET=<сгенерированный_секрет>
JWT_SECRET=<сгенерированный_секрет>
TURN_SECRET=<сгенерированный_секрет>

# Публичный IP сервера
TURN_HOST=<ваш_публичный_IP>

# CORS — должен совпадать с доменом
CORS_ORIGINS=https://kvm.example.com
```

> **Важно**: `DB_PASSWORD` в `DATABASE_URL` должен совпадать с `DB_PASSWORD` выше. Это одно и то же значение.

#### Шаг 4: Настроить Caddyfile

```bash
cat > Caddyfile << 'EOF'
kvm.example.com {
    reverse_proxy app:3000
}
EOF
```

Замените `kvm.example.com` на ваш домен. Если указали admin email для Let's Encrypt:

```bash
cat > Caddyfile << 'EOF'
{
    email you@example.com
}

kvm.example.com {
    reverse_proxy app:3000
}
EOF
```

#### Шаг 5: Настроить coturn

```bash
mkdir -p coturn
cat > coturn/turnserver.prod.conf << EOF
listening-port=3478
tls-listening-port=5349
external-ip=<ваш_публичный_IP>
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=<TURN_SECRET из .env.prod>
realm=kvm.example.com
simple-log
min-port=49152
max-port=65535
no-multicast-peers
no-cli
EOF
```

> **Важно**: `static-auth-secret` должен точно совпадать с `TURN_SECRET` из `.env.prod`. `external-ip` — публичный IP сервера. `realm` — ваш домен.

#### Шаг 6: Собрать и запустить

```bash
docker compose -f docker-compose.prod.yaml build
docker compose -f docker-compose.prod.yaml up -d
```

---

## 4. Проверка DNS

Перед проверкой сервисов убедитесь, что DNS уже указывает на сервер:

```bash
# На любом компьютере
dig +short kvm.example.com
# Должен вернуть ваш публичный IP

# Или
nslookup kvm.example.com
```

> DNS-пропагация занимает от 5 минут до 48 часов. Caddy не получит SSL-сертификат, пока DNS не укажет на сервер.

---

## 5. Проверка работоспособности

### 5.1 Статус контейнеров

```bash
docker compose -f docker-compose.prod.yaml ps
```

Ожидаемый результат:
```
NAME                    STATUS
jetkvm-cloud-db-1       Up (healthy)
jetkvm-cloud-app-1      Up
jetkvm-cloud-caddy-1    Up
jetkvm-cloud-turn-1     Up
```

`app-migrate` будет в статусе `Exited (0)` — это нормально, он одноразовый.

### 5.2 Health check API

```bash
# Изнутри сервера (HTTP, напрямую к app)
curl http://localhost:3000/healthz

# Снаружи (HTTPS, через Caddy)
curl https://kvm.example.com/healthz
```

Ожидаемый ответ:
```json
{"ready":true,"time":"2026-04-16T..."}
```

### 5.3 Проверка SSL

```bash
curl -vI https://kvm.example.com 2>&1 | grep "SSL certificate"
```

### 5.4 Проверка UI

Откройте в браузере: `https://kvm.example.com/login`

Должна отобразиться форма входа с полями Email и Password.

### 5.5 Проверка TURN

```bash
# Проверка доступности порта
nc -zvu <публичный_IP> 3478

# Логи coturn
docker compose -f docker-compose.prod.yaml logs turn
```

---

## 6. Создание аккаунта и подключение устройства

### 6.1 Регистрация

Откройте `https://kvm.example.com/signup` и создайте аккаунт.

Или через curl:
```bash
curl -X POST https://kvm.example.com/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"your-secure-password"}'
```

### 6.2 Ограничение регистрации (опционально)

Чтобы запретить регистрацию посторонним, добавьте в `.env.prod`:

```env
ALLOWED_IDENTITIES=admin@example.com,colleague@example.com
```

Перезапустите:
```bash
docker compose -f docker-compose.prod.yaml restart app
```

### 6.3 Adoption устройства

Устройство должно быть на прошивке `KVM_Dev` (не оригинальной).

```bash
# 1. Логин
curl -c cookies.txt -X POST https://kvm.example.com/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"your-secure-password"}'

# 2. Adoption
curl -b cookies.txt -X POST https://kvm.example.com/devices/adopt \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"DEVICE_HW_ID","deviceUrl":"http://DEVICE_LOCAL_IP"}'
```

Откройте `redirectUrl` из ответа **в браузере в той же локальной сети**, что и устройство. Время жизни ссылки — 120 секунд.

После adoption устройство подключится к облаку по WebSocket и будет доступно из любой сети.

---

## 7. Обновление

```bash
cd ~/jetkvm/Cloud-API_Dev

# Получить обновления
git pull

# Пересобрать и перезапустить
docker compose -f docker-compose.prod.yaml build
docker compose -f docker-compose.prod.yaml up -d
```

Миграции базы данных применяются автоматически при каждом запуске (сервис `app-migrate`).

---

## 8. Управление и логи

```bash
# Логи всех сервисов
docker compose -f docker-compose.prod.yaml logs -f

# Логи конкретного сервиса
docker compose -f docker-compose.prod.yaml logs -f app
docker compose -f docker-compose.prod.yaml logs -f caddy
docker compose -f docker-compose.prod.yaml logs -f turn
docker compose -f docker-compose.prod.yaml logs -f db

# Перезапуск конкретного сервиса
docker compose -f docker-compose.prod.yaml restart app

# Остановка всего
docker compose -f docker-compose.prod.yaml down

# Остановка с удалением данных (ОСТОРОЖНО — удалит БД)
docker compose -f docker-compose.prod.yaml down -v
```

---

## 9. Возможные ошибки и решения

### Сборка Docker-образа

| Ошибка | Причина | Решение |
|--------|---------|---------|
| `COPY failed: file not found` | Build context неправильный | Убедитесь, что `docker compose build` запускается из `Cloud-API_Dev/`, а `context: ..` указывает на корень JetKVM-All |
| `npm ci` падает с ошибкой сети | Нет доступа к npm registry | Проверьте DNS и интернет на сервере: `ping registry.npmjs.org` |
| `prisma generate` ошибка openssl | Несовместимость бинарников | Prisma generate должен выполняться в финальном stage (не в builder) |
| Сборка зависает на `vite build` | Мало RAM | Минимум 1 GB RAM; для сборки может понадобиться swap |

### Запуск сервисов

| Ошибка | Причина | Решение |
|--------|---------|---------|
| `app-migrate` в restart loop | БД ещё не готова | Проверьте healthcheck: `docker compose logs db`. Обычно решается само через 10-15 секунд |
| `ECONNREFUSED` при подключении к БД | Неправильный `DATABASE_URL` | Проверьте, что `DB_PASSWORD` в `DATABASE_URL` совпадает с `DB_PASSWORD` переменной |
| `TURN_SECRET is required` / подобное | Не все переменные в `.env.prod` | Проверьте, что все `GENERATE_ME` заменены на реальные значения |

### SSL / HTTPS

| Ошибка | Причина | Решение |
|--------|---------|---------|
| Caddy не получает сертификат | DNS ещё не пропагировался | Проверьте: `dig +short kvm.example.com` должен вернуть IP сервера |
| `ERR_SSL_PROTOCOL_ERROR` | Порт 80 закрыт (Let's Encrypt HTTP challenge) | Откройте порт 80 TCP в firewall |
| `ERR_CONNECTION_REFUSED` на 443 | Caddy не запустился | `docker compose logs caddy` — проверьте ошибки в Caddyfile |
| Сертификат не обновляется | Rate limit Let's Encrypt | Подождите час; не пересоздавайте контейнер слишком часто при отладке |

### WebRTC / TURN

| Ошибка | Причина | Решение |
|--------|---------|---------|
| WebRTC не подключается | TURN не доступен | Проверьте: `nc -zvu PUBLIC_IP 3478`, порты 49152-65535/UDP открыты |
| `401 Unauthorized` от coturn | `TURN_SECRET` не совпадает | `static-auth-secret` в `turnserver.prod.conf` должен быть идентичен `TURN_SECRET` в `.env.prod` |
| Видео не идёт (чёрный экран) | UDP порты закрыты | Откройте `49152-65535/UDP` в firewall |
| `external-ip` неправильный | coturn не знает публичный IP | Исправьте `external-ip` в `turnserver.prod.conf` |

### UI / Аутентификация

| Ошибка | Причина | Решение |
|--------|---------|---------|
| Белая страница | JS assets не загружаются | `docker compose logs app` — проверьте, что `UI_DIST_PATH` корректен |
| `Cannot GET /login` | UI не собран в образе | Пересоберите: `docker compose build` |
| Cookie не устанавливается | `COOKIE_SECRET` пуст или `secure: true` без HTTPS | Убедитесь, что доступ через HTTPS (Caddy) |
| `401` при запросах после логина | JWT_SECRET изменён после выдачи токенов | Пользователи должны перелогиниться |
| CORS ошибки в консоли | `CORS_ORIGINS` не совпадает с доменом | Должен быть `https://kvm.example.com` (с `https://`) |

### Устройство не подключается

| Ошибка | Причина | Решение |
|--------|---------|---------|
| Device offline после adoption | WebSocket не может подключиться | На устройстве: `CloudURL` должен быть `wss://kvm.example.com/` |
| `Failed to register device` | Оригинальная прошивка | Нужна прошивка `KVM_Dev`, не оригинальная |
| Adoption ссылка не работает | Истёк 120-секундный таймаут | Повторите `POST /devices/adopt` и откройте новую ссылку быстрее |

---

## 10. Бэкап и восстановление

### Бэкап базы данных

```bash
docker compose -f docker-compose.prod.yaml exec db \
  pg_dump -U jetkvm jetkvm > backup_$(date +%Y%m%d).sql
```

### Восстановление

```bash
docker compose -f docker-compose.prod.yaml exec -T db \
  psql -U jetkvm jetkvm < backup_20260416.sql
```

### Бэкап конфигурации

Сохраните эти файлы:
- `.env.prod` — все секреты и настройки
- `Caddyfile` — конфигурация reverse proxy
- `coturn/turnserver.prod.conf` — конфигурация TURN

---

## 11. Справка по файлам

```
Cloud-API_Dev/
├── Dockerfile.prod              # Multi-stage сборка: UI + API
├── docker-compose.prod.yaml     # Production compose (5 сервисов)
├── Caddyfile                    # Reverse proxy с автоматическим HTTPS
├── setup.sh                     # Автоматический установщик
├── .env.prod                    # Переменные окружения (создаётся при установке)
├── .env.prod.example            # Шаблон переменных
├── DEPLOY.md                    # Dev vs Prod отличия
├── INSTALL.md                   # Эта инструкция
├── coturn/
│   └── turnserver.prod.conf     # TURN-сервер конфигурация
├── prisma/
│   └── schema.prisma            # Схема БД
└── src/                         # Исходный код API
```
