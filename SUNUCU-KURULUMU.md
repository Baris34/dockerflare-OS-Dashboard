# Linux sunucusunda dört servisi kur

Bu rehber bir Linux sunucusu, Bash, çalışan Docker Engine ve BuildKit, `curl`, `openssl` ve SSH erişimi varsayar. Sunucuda normal Docker yetkili hesabını kullan. Portlar sunucunun loopback adresinde dinler. Bilgisayardaki tünel portlarını mevcut yerel OS Dashboard ve Dockerflare kurulumuyla çakışmayacak şekilde seçtik.

Önceki bir kurulumu güncelliyorsan çalışan paneli ve AI Gateway’i durdur, mevcut veriyi ve erişim anahtarını yeni adlandırılmış birimlere taşı. Panel eski SQLite dosyasından yeni dosyayı ilk başlangıçta oluşturur. Workshop sağlayıcısında kayıtlı özel API kökünü `http://os-dashboard-ai-gateway:4322/v1` olarak güncelle.

## 1. Kaynağı Windows'tan gönder

PowerShell'de `SUNUCU_IP` ve SSH kullanıcı adını kendine göre değiştir.

```powershell
$hedef = 'baris@SUNUCU_IP'
scp "C:\Github\OS-Dashboard\data\kurulum\os-dashboard-sunucu.tar.gz" "${hedef}:"
ssh $hedef
```

## 2. Sunucuda kaynakları aç ve dört imajı derle

Bu adımdan 7. adımın sonuna kadar komutlar sunucudaki Bash oturumunda çalışır. Arşivi yeni bir kurulum klasörüne aç.

```bash
mkdir -p "$HOME/os-dashboard-kurulum"
cd "$HOME/os-dashboard-kurulum"
tar -xzf "$HOME/os-dashboard-sunucu.tar.gz"
docker version
docker buildx version

cd "$HOME/os-dashboard-kurulum/OS-Dashboard"
docker build --target panel   -t os-dashboard/panel:local .
docker build --target ai-gateway -t os-dashboard/ai-gateway:local .

cd "$HOME/os-dashboard-kurulum/dockerflare-os"
docker build --target workshop -t dockerflare/workshop:local .
docker build --target web --build-arg OS_DASHBOARD_PORT=14321 -t dockerflare/web:local .
```

## 3. Ağları, kalıcı veriyi ve log dosyasını hazırla

Yeni sunucuda bir kez çalıştır. Panel ve AI Gateway ayarlarla kararları `os-dashboard-data` içinde paylaşır. Workshop kendi verisini `os-dashboard-workshop-data` içinde tutar.

```bash
cd "$HOME/os-dashboard-kurulum/OS-Dashboard"
docker network create os-dashboard-panel-net
docker network create os-dashboard-dockerflare
docker volume create os-dashboard-data
docker volume create os-dashboard-workshop-data
docker volume create os-dashboard-workshop-audit

mkdir -p data/cloudflare-os data/logs
chmod 2750 data/logs
docker run --rm --network none --user "$(id -u):$(id -g)" \
  -v "$PWD/examples:/app/examples:ro" \
  -v "$PWD/data:/app/data" \
  -v "$PWD/../dockerflare-os/docker/web.conf:/base.conf:ro" \
  os-dashboard/ai-gateway:local node /app/examples/cloudflare-os/prepare.mjs /base.conf
chmod 660 data/logs/cloudflare-os-web.jsonl
chmod 644 data/cloudflare-os/web.conf

install -d -m 700 "$HOME/.config/os-dashboard"
KEY="$HOME/.config/os-dashboard/ai-gateway-token"
if [ ! -e "$KEY" ]; then
  (umask 077; set -C; openssl rand -hex 32 > "$KEY")
fi
test -s "$KEY" && chmod 640 "$KEY"
```

Hazırlık konteyneri bir kez çalışıp çıkar. Ürettiği nginx yapılandırması `GET /api/version` isteklerini dosyaya yazar. Sonraki komutlardaki grup izinleri, Linux kullanıcı numaran 1000'den farklı olduğunda da servislerin kendi dosyalarına erişmesini sağlar.

## 4. OS Dashboard Panel'i ve AI Gateway'i ayrı ayrı başlat

**Çalışma klasörü** `~/os-dashboard-kurulum/OS-Dashboard`. Panelde gösterilen `14322` adresi, 8. adımda bilgisayarında açacağın SSH tünelinin ucudur.

```bash
cd "$HOME/os-dashboard-kurulum/OS-Dashboard"
docker run -d --name os-dashboard-panel --restart unless-stopped \
  --network os-dashboard-panel-net -p 127.0.0.1:4321:4320 \
  --group-add "$(stat -c %g data/logs/cloudflare-os-web.jsonl)" \
  -v os-dashboard-data:/data -v "$PWD/data/logs:/logs:ro" \
  -v os-dashboard-workshop-audit:/os-dashboard-audit:ro \
  -e OS_DASHBOARD_LOG_DIR=/logs \
  -e DOCKERFLARE_WORKSHOP_URL=http://127.0.0.1:28080 \
  -e OS_DASHBOARD_PUBLIC_AI_GATEWAY_URL=http://127.0.0.1:14322/v1 \
  os-dashboard/panel:local

KEY="$HOME/.config/os-dashboard/ai-gateway-token"
docker run -d --name os-dashboard-ai-gateway --restart unless-stopped \
  --network os-dashboard-dockerflare -p 127.0.0.1:4322:4322 \
  --group-add "$(stat -c %g "$KEY")" \
  -v os-dashboard-data:/data -v "$KEY:/run/secrets/os-dashboard-client:ro" \
  -e OS_DASHBOARD_CLIENT_TOKEN_FILE=/run/secrets/os-dashboard-client \
  os-dashboard/ai-gateway:local
```

## 5. Dockerflare Workshop'ı başlat

**Çalışma klasörü** `~/os-dashboard-kurulum/dockerflare-os`. Yönetici hesabı için `baris` yerine istersen kendi kullanıcı adını yaz. `PUBLIC_BASE_URL` tarayıcıda kullanacağın adresle eşleşir.

```bash
cd "$HOME/os-dashboard-kurulum/dockerflare-os"
docker run -d --name os-dashboard-dockerflare-workshop --restart unless-stopped \
  --network os-dashboard-dockerflare --network-alias workshop \
  -v os-dashboard-workshop-data:/data \
  -v os-dashboard-workshop-data:/os-dashboard-source:ro \
  -v os-dashboard-workshop-audit:/os-dashboard-audit \
  -e OS_DASHBOARD_WORKSHOP_OBJECTS=/os-dashboard-source/objects \
  -e OS_DASHBOARD_WORKSHOP_AUDIT_FILE=/os-dashboard-audit/workshop.sqlite \
  -e OS_DASHBOARD_AI_GATEWAY_ROOT=http://os-dashboard-ai-gateway:4322/v1 \
  -e PUBLIC_BASE_URL=http://127.0.0.1:28080 \
  -e 'ADMINS=["baris"]' \
  -e 'SELF_HOSTED_MODEL_BASE_URLS=["http://os-dashboard-ai-gateway:4322/v1"]' \
  dockerflare/workshop:local
```

## 6. Dockerflare Web'i başlat

**Çalışma klasörü** `~/os-dashboard-kurulum/OS-Dashboard`. Web imajını Dockerflare klasöründe derledin. Bu komutta OS Dashboard klasörüne dönüyorsun çünkü nginx yapılandırması ve erişim logu burada.

```bash
cd "$HOME/os-dashboard-kurulum/OS-Dashboard"
docker run -d --name os-dashboard-dockerflare-web --restart unless-stopped \
  --network os-dashboard-dockerflare -p 127.0.0.1:18080:8080 \
  --group-add "$(stat -c %g data/logs/cloudflare-os-web.jsonl)" \
  -v "$PWD/data/cloudflare-os/web.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$PWD/data/logs/cloudflare-os-web.jsonl:/var/log/nginx/os-dashboard-web.jsonl" \
  dockerflare/web:local
```

## 7. Sağlığı kontrol et ve bir isteği panele kadar izle

```bash
docker ps --filter name=os-dashboard- --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
curl -fsS http://127.0.0.1:4321/api/health
curl -s -o /dev/null -w 'AI Gateway: %{http_code}\n' http://127.0.0.1:4322/v1/models
curl --retry 8 --retry-connrefused --retry-delay 1 -fsS -D - -o /dev/null \
  http://127.0.0.1:18080/api/version
```

Dört konteyner `Up`, panel `{"ok":true}`, kimliksiz AI Gateway çağrısı `401`, Web isteği `200` döndürmeli. Son yanıtın `X-OS-Dashboard-Trace` değerini al. Birkaç saniye sonra aynı kaydı sorgula.

```bash
curl -fsS "http://127.0.0.1:4321/api/events?trace_id=BURAYA_IZ_KIMLIGI"
```

Aynı denetimi Linux sunucusunda tek komutla tekrarlayabilirsin. Denetim, gerçek bir Web isteğinin panelde aynı iz kimliğiyle göründüğünü ve Workshop sohbet kaynağının bağlı olduğunu kontrol eder.

```bash
cd "$HOME/os-dashboard-kurulum/OS-Dashboard"
docker run --rm --network host -v "$PWD/examples:/app/examples:ro" \
  os-dashboard/ai-gateway:local node /app/examples/cloudflare-os/check-integration.mjs
```

Yeni veritabanında DLP varsayılan olarak kapalıdır. Model ve guard bağlantılarını boş bırakarak DLP'yi açabilirsin.

```bash
curl -fsS -X POST http://127.0.0.1:4321/api/settings \
  -H 'Content-Type: application/json' -d '{"dlp":true}'
```

## 8. Bilgisayarından tarayıcıya bağlan

Bilgisayarında ikinci bir PowerShell penceresi aç. Tüneli kullandığın sürece bu pencereyi açık tut.

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 14321:127.0.0.1:4321 -L 14322:127.0.0.1:4322 -L 28080:127.0.0.1:18080 baris@SUNUCU_IP
```

- [OS Dashboard AI Gateway](http://127.0.0.1:14321/#ai-gateway)
- [Workshop sohbetleri, onaylar ve maliyet](http://127.0.0.1:14321/#workshop)
- [Dockerflare erişim logları](http://127.0.0.1:14321/#logs)
- [Dockerflare Web ve Workshop](http://127.0.0.1:28080/)

Dockerflare'da ilk hesabını `ADMINS` için seçtiğin adla oluştur. Workshop'ın AI Gateway adresi Docker ağı içinde `http://os-dashboard-ai-gateway:4322/v1`. Modelini bağlama zamanı geldiğinde **AI providers → OpenAI-compatible endpoint** alanına bu adresi, OS Dashboard istemci anahtarını ve gerçek model kimliğini gir. OS Dashboard'un **Koruma ayarları** bölümünden gerçek Qwen3Guard adresini ayrıca bağlayabilirsin.

Dockerflare’da profil menüsünden **Admin** sayfasına gir. **OS Dashboard** bağlantısı sohbet denetimini açar. Panelde **Dockerflare OS’u aç** bağlantısı Workshop’a döner. SSH tüneli için seçtiğin portları değiştirirsen Web derlemesindeki `OS_DASHBOARD_PORT` ve panelin `DOCKERFLARE_WORKSHOP_URL` değerlerini de güncelle.

Web erişim kaydı isteğin yöntemini, durum kodunu, süresini ve iz kimliğini içerir. `/api/version` ve `/healthz` kendi adıyla görünür. Diğer API, gatekeeper ve şablon görüntüsü istekleri yol grubuyla kaydedilir. Sorgu parametreleri ve çağrı içerikleri bu günlüğe yazılmaz. WebSocket kaydı bağlantı kapandığında oluşur.

**Workshop sohbetleri** bölümünden bir sohbeti aç. Workshop yaklaşık beş saniyede bir kimlikleri, araç adlarını ve onay kararlarını ayrı veri birimine aktarır. Panel yalnızca bu özeti okur. Yeni model isteklerinde Workshop AI Gateway'in verdiği istek kimliğini saklar. OS Dashboard, ana model ve etkin guard çağrılarının tokenlarını o andaki tarifeyle fiyatlar. Eksik model tarifesi veya kullanım varsa bilinen tutarı ve kaç çağrının fiyatlanamadığını gösterir. Eski sohbetlerde kaydedilmeyen onaylayan kişi ve yardımcı model çağrıları bilinmiyor olarak kalabilir. Dört servisi bu arşivden derlemek Workshop tarafındaki kayıt desteğini de kurar.

Sohbetin maliyet kayıtları `os-dashboard-data` biriminde saklanır. Genel AI Gateway loglarının yedi günlük süresi dolunca da sohbet ekranında tutarı görebilirsin. Kendi sağlayıcını bağlamadan iki kullanıcıyla örneği tekrarlamak için [Workshop sohbet denetimi](examples/cloudflare-os/workshop-audit/README.md) adımlarını izle.
