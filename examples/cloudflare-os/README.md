# Cloudflare OS isteğini OS Dashboard'da izle

Web konteynerindeki nginx, `GET /api/version` isteğini Workshop'a gönderir. Yanıtta gelen `X-OS-Dashboard-Trace` başlığı, aynı isteğin Docker günlüğündeki ve OS Dashboard'daki kaydını bulur. Bu örnek model hesabı gerektirmez.

## Çalışan örneği dene

Windows'ta OS Dashboard, WSL Ubuntu'da Docker çalışıyorsa PowerShell'den bir istek gönder.

```powershell
$response = Invoke-WebRequest http://127.0.0.1:18080/api/version
$trace = [string]($response.Headers['X-OS-Dashboard-Trace'] -join '')
$response.StatusCode
$trace
wsl -d Ubuntu -- docker logs --since 2m os-dashboard-dockerflare-web 2>$null | Select-String -SimpleMatch $trace
```

Web, erişim kaydını doğrudan [paylaşılan dosyaya](../../data/logs/cloudflare-os-web.jsonl) ekler. OS Dashboard'un dosya toplayıcısı yaklaşık dört saniyede bir yeni satırları okur. [Docker panelinin log akışında](http://127.0.0.1:4321/#logs) kaynak olarak **Dosya** seç, `GET /api/version` ara ve satırı aç. **İz kimliği** yanıt başlığındaki değerle eşleşir. PowerShell'de aynı olayı `(Invoke-RestMethod "http://127.0.0.1:4321/api/events?trace_id=$trace").items` ile de görebilirsin.

## Web ve Workshop imajlarını ayrı derle

OS Dashboard ve `dockerflare-os` depoları aynı üst dizindeyken WSL veya Linux kabuğunda **OS Dashboard kökünden** çalıştır. Her komut Dockerflare'ın Dockerfile dosyasındaki ayrı bir hedefi derler.

```sh
docker build --target workshop --tag dockerflare/workshop:local ../dockerflare-os
```

```sh
docker build --target web --build-arg OS_DASHBOARD_PORT=4321 --tag dockerflare/web:local ../dockerflare-os
```

## Ağı, veriyi ve erişim kaydını hazırla

Aşağıdaki adımları aynı kabukta çalıştır. İki servis `os-dashboard-dockerflare` adlı bridge ağında haberleşir. Workshop verisi, sunucu kurulumundaki `os-dashboard-workshop-data` biriminde tutulur.

```sh
docker network inspect os-dashboard-dockerflare >/dev/null 2>&1 || docker network create --driver bridge os-dashboard-dockerflare
workshop_volume=os-dashboard-workshop-data
docker volume create "$workshop_volume"
docker volume create os-dashboard-workshop-audit
mkdir -p data/cloudflare-os data/logs
docker run --rm --network none --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$PWD/examples/cloudflare-os/prepare.mjs,target=/app/examples/cloudflare-os/prepare.mjs,readonly" \
  --mount "type=bind,source=$(realpath ../dockerflare-os/docker/web.conf),target=/tmp/source.conf,readonly" \
  --mount "type=bind,source=$PWD/data/cloudflare-os,target=/app/data/cloudflare-os" \
  --mount "type=bind,source=$PWD/data/logs,target=/app/data/logs" \
  node:24-bookworm-slim node /app/examples/cloudflare-os/prepare.mjs /tmp/source.conf
chmod g+rw data/logs/cloudflare-os-web.jsonl
```


## Önce Workshop'u, ardından Web'i çalıştır

Workshop `/data` altında kalıcı birimi kullanır. Ağdaki `workshop` adı Web yapılandırmasının beklediği adrestir. Workshop için izin verilen model API kökü, aynı ağdaki bağımsız OS Dashboard AI Gateway servisidir. Bu ayarla örneğin `GET /api/version` isteği model çağırmadan çalışır. Bir model bağlamak istediğinde sağlayıcı adresini OS Dashboard panelinde yapılandırabilirsin.

```sh
docker run --detach --name os-dashboard-dockerflare-workshop \
  --restart unless-stopped \
  --network os-dashboard-dockerflare --network-alias workshop \
  --env PUBLIC_BASE_URL=http://127.0.0.1:18080 \
  --env OS_DASHBOARD_AI_GATEWAY_ROOT=http://os-dashboard-ai-gateway:4322/v1 \
  --env OS_DASHBOARD_WORKSHOP_OBJECTS=/os-dashboard-source/objects \
  --env OS_DASHBOARD_WORKSHOP_AUDIT_FILE=/os-dashboard-audit/workshop.sqlite \
  --mount "type=volume,source=$workshop_volume,target=/os-dashboard-source,readonly" \
  --mount type=volume,source=os-dashboard-workshop-audit,target=/os-dashboard-audit \
  --env 'SELF_HOSTED_MODEL_BASE_URLS=["http://os-dashboard-ai-gateway:4322/v1"]' \
  --mount "type=volume,source=$workshop_volume,target=/data" \
  dockerflare/workshop:local
```

Web, üretilen erişim kaydı yapılandırmasını salt okunur olarak kullanır. Yalnız Web'in `18080` portu yerel makineye yayımlanır.

```sh
docker run --detach --name os-dashboard-dockerflare-web \
  --restart unless-stopped \
  --network os-dashboard-dockerflare \
  --publish 127.0.0.1:18080:8080 \
  --group-add "$(stat -c %g data/logs/cloudflare-os-web.jsonl)" \
  --mount "type=bind,source=$PWD/data/logs/cloudflare-os-web.jsonl,target=/var/log/nginx/os-dashboard-web.jsonl" \
  --mount "type=bind,source=$PWD/data/cloudflare-os/web.conf,target=/etc/nginx/conf.d/default.conf,readonly" \
  dockerflare/web:local
```

## Logların nasıl aktığını kontrol et

Her `GET /api/version` çağrısı sırasında nginx hem Docker günlüğüne hem de kendisine yazma izniyle bağlanan dosyaya bir satır yazar. OS Dashboard bu dosyanın bulunduğu klasörü salt okunur açar. İki taraftaki iz kimliğini karşılaştırmak için şu komutları çalıştır.

```sh
curl -si http://127.0.0.1:18080/api/version
tail -n 1 data/logs/cloudflare-os-web.jsonl
```

Hazırlık betiği nginx yapılandırmasında bu yol için istek kimliği, zaman, HTTP durumu, Workshop yanıt durumu ve toplam istek süresini kaydeder. Log biçimi alanları sabittir. İsteğin sorgu parametreleri, çerezler ve gövdeler kayıt dışında kalır.

Servisleri bağımsız olarak yönetebilirsin. Örneğin `docker restart os-dashboard-dockerflare-web` sonrasında Web, yeni erişim kayıtlarını aynı dosyaya yazmayı sürdürür.
