# Cloudflare OS isteğini Halkness'de izle

Web konteynerindeki nginx, `GET /api/version` isteğini Workshop'a gönderir. Yanıtta gelen `X-Seyir-Trace` başlığı, aynı isteğin Docker günlüğündeki ve Halkness'deki kaydını bulur. Bu örnek model hesabı gerektirmez.

## Çalışan örneği dene

Windows'ta Halkness, WSL Ubuntu'da Docker çalışıyorsa PowerShell'den bir istek gönder.

```powershell
$response = Invoke-WebRequest http://127.0.0.1:18080/api/version
$trace = [string]($response.Headers['X-Seyir-Trace'] -join '')
$response.StatusCode
$trace
wsl -d Ubuntu -- docker logs --since 2m seyir-dockerflare-web 2>$null | Select-String -SimpleMatch $trace
```

Web, erişim kaydını doğrudan [paylaşılan dosyaya](../../data/logs/cloudflare-os-web.jsonl) ekler. Halkness'in dosya toplayıcısı yaklaşık dört saniyede bir yeni satırları okur. [Docker panelinin log akışında](http://127.0.0.1:4321/#logs) kaynak olarak **Dosya** seç, `GET /api/version` ara ve satırı aç. **İz kimliği** yanıt başlığındaki değerle eşleşir. PowerShell'de aynı olayı `(Invoke-RestMethod "http://127.0.0.1:4321/api/events?trace_id=$trace").items` ile de görebilirsin.

## Web ve Workshop imajlarını ayrı derle

Halkness ve `dockerflare-os` depoları aynı üst dizindeyken WSL veya Linux kabuğunda **Halkness kökünden** çalıştır. Her komut Dockerflare'ın Dockerfile dosyasındaki ayrı bir hedefi derler.

```sh
docker build --target workshop --tag dockerflare/workshop:local ../dockerflare-os
```

```sh
docker build --target web --tag dockerflare/web:local ../dockerflare-os
```

## Ağı, veriyi ve erişim kaydını hazırla

Aşağıdaki adımları aynı kabukta çalıştır. İki servis `seyir-dockerflare` adlı bridge ağında haberleşir. Yeni kurulumda Workshop verisi `seyir-dockerflare-workshop-data` birimine yazılır. Önceki örneğin birimi varsa aşağıdaki komut onu seçer.

```sh
docker network inspect seyir-dockerflare >/dev/null 2>&1 || docker network create --driver bridge seyir-dockerflare
workshop_volume=seyir-dockerflare-workshop-data
if docker volume inspect seyir-cloudflare-demo_workshop-data >/dev/null 2>&1; then
  workshop_volume=seyir-cloudflare-demo_workshop-data
fi
docker volume create "$workshop_volume"
docker volume create seyir-workshop-audit
mkdir -p data/cloudflare-os data/logs
docker run --rm --network none --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$PWD/examples/cloudflare-os/prepare.mjs,target=/app/examples/cloudflare-os/prepare.mjs,readonly" \
  --mount "type=bind,source=$(realpath ../dockerflare-os/docker/web.conf),target=/tmp/source.conf,readonly" \
  --mount "type=bind,source=$PWD/data/cloudflare-os,target=/app/data/cloudflare-os" \
  --mount "type=bind,source=$PWD/data/logs,target=/app/data/logs" \
  node:24-bookworm-slim node /app/examples/cloudflare-os/prepare.mjs /tmp/source.conf
chmod g+rw data/logs/cloudflare-os-web.jsonl
```

Önceki örnek hâlâ çalışıyorsa `docker stop seyir-cloudflare-demo-web-1 seyir-cloudflare-demo-workshop-1` ile kapat ve eski takipçiyi durdur. Böylece yeni Web aynı portu kullanabilir ve Workshop veri birimi tek bir süreçte açık kalır.

## Önce Workshop'u, ardından Web'i çalıştır

Workshop `/data` altında kalıcı birimi kullanır. Ağdaki `workshop` adı Web yapılandırmasının beklediği adrestir. Workshop için izin verilen model API kökü, aynı ağdaki bağımsız Halkness Gateway servisidir. Bu ayarla örneğin `GET /api/version` isteği model çağırmadan çalışır. Bir model bağlamak istediğinde sağlayıcı adresini Halkness panelinde yapılandırabilirsin.

```sh
docker run --detach --name seyir-dockerflare-workshop \
  --restart unless-stopped \
  --network seyir-dockerflare --network-alias workshop \
  --env PUBLIC_BASE_URL=http://127.0.0.1:18080 \
  --env SEYIR_GATEWAY_ROOT=http://seyir-gateway:4322/v1 \
  --env SEYIR_WORKSHOP_OBJECTS=/seyir-source/objects \
  --env SEYIR_WORKSHOP_AUDIT_FILE=/seyir-audit/workshop.sqlite \
  --mount "type=volume,source=$workshop_volume,target=/seyir-source,readonly" \
  --mount type=volume,source=seyir-workshop-audit,target=/seyir-audit \
  --env 'SELF_HOSTED_MODEL_BASE_URLS=["http://seyir-gateway:4322/v1"]' \
  --mount "type=volume,source=$workshop_volume,target=/data" \
  dockerflare/workshop:local
```

Web, üretilen erişim kaydı yapılandırmasını salt okunur olarak kullanır. Yalnız Web'in `18080` portu yerel makineye yayımlanır.

```sh
docker run --detach --name seyir-dockerflare-web \
  --restart unless-stopped \
  --network seyir-dockerflare \
  --publish 127.0.0.1:18080:8080 \
  --group-add "$(stat -c %g data/logs/cloudflare-os-web.jsonl)" \
  --mount "type=bind,source=$PWD/data/logs/cloudflare-os-web.jsonl,target=/var/log/nginx/seyir-web.jsonl" \
  --mount "type=bind,source=$PWD/data/cloudflare-os/web.conf,target=/etc/nginx/conf.d/default.conf,readonly" \
  dockerflare/web:local
```

## Logların nasıl aktığını kontrol et

Her `GET /api/version` çağrısı sırasında nginx hem Docker günlüğüne hem de kendisine yazma izniyle bağlanan dosyaya bir satır yazar. Halkness bu dosyanın bulunduğu klasörü salt okunur açar. İki taraftaki iz kimliğini karşılaştırmak için şu komutları çalıştır.

```sh
curl -si http://127.0.0.1:18080/api/version
tail -n 1 data/logs/cloudflare-os-web.jsonl
```

Hazırlık betiği nginx yapılandırmasında bu yol için istek kimliği, zaman, HTTP durumu, Workshop yanıt durumu ve toplam istek süresini kaydeder. Log biçimi alanları sabittir. İsteğin sorgu parametreleri, çerezler ve gövdeler kayıt dışında kalır.

Servisleri bağımsız olarak yönetebilirsin. Örneğin `docker restart seyir-dockerflare-web` sonrasında Web, yeni erişim kayıtlarını aynı dosyaya yazmayı sürdürür.
