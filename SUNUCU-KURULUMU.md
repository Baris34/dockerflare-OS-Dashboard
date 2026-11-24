# Linux sunucusunda dört servisi kur

Bu rehber bir Linux sunucusu, Bash, çalışan Docker Engine ve BuildKit, `curl`, `openssl` ve SSH erişimi varsayar. Sunucuda normal Docker yetkili hesabını kullan. Portlar sunucunun loopback adresinde dinler. Bilgisayardaki tünel portlarını mevcut yerel Seyir ve Dockerflare kurulumuyla çakışmayacak şekilde seçtik.

## 1. Kaynağı Windows'tan gönder

PowerShell'de `SUNUCU_IP` ve SSH kullanıcı adını kendine göre değiştir.

```powershell
$hedef = 'baris@SUNUCU_IP'
scp "C:\Github\Seyir\data\kurulum\seyir-sunucu.tar.gz" "${hedef}:"
ssh $hedef
```

## 2. Sunucuda kaynakları aç ve dört imajı derle

Bu adımdan 7. adımın sonuna kadar komutlar sunucudaki Bash oturumunda çalışır. Arşivi yeni bir kurulum klasörüne aç.

```bash
mkdir -p "$HOME/seyir-kurulum"
cd "$HOME/seyir-kurulum"
tar -xzf "$HOME/seyir-sunucu.tar.gz"
docker version
docker buildx version

cd "$HOME/seyir-kurulum/Seyir"
docker build --target panel   -t seyir/panel:local .
docker build --target gateway -t seyir/gateway:local .

cd "$HOME/seyir-kurulum/dockerflare-os"
docker build --target workshop -t dockerflare/workshop:local .
docker build --target web      -t dockerflare/web:local .
```

## 3. Ağları, kalıcı veriyi ve log dosyasını hazırla

Yeni sunucuda bir kez çalıştır. Panel ve gateway ayarlarla kararları `seyir-data` içinde paylaşır. Workshop kendi verisini `seyir-workshop-data` içinde tutar.

```bash
cd "$HOME/seyir-kurulum/Seyir"
docker network create seyir-panel-net
docker network create seyir-dockerflare
docker volume create seyir-data
docker volume create seyir-workshop-data
docker volume create seyir-workshop-audit

mkdir -p data/cloudflare-os data/logs
chmod 2750 data/logs
docker run --rm --network none --user "$(id -u):$(id -g)" \
  -v "$PWD/examples:/app/examples:ro" \
  -v "$PWD/data:/app/data" \
  -v "$PWD/../dockerflare-os/docker/web.conf:/base.conf:ro" \
  seyir/gateway:local node /app/examples/cloudflare-os/prepare.mjs /base.conf
chmod 660 data/logs/cloudflare-os-web.jsonl
chmod 644 data/cloudflare-os/web.conf

install -d -m 700 "$HOME/.config/seyir"
KEY="$HOME/.config/seyir/gateway-token"
if [ ! -e "$KEY" ]; then
  (umask 077; set -C; openssl rand -hex 32 > "$KEY")
fi
test -s "$KEY" && chmod 640 "$KEY"
```

Hazırlık konteyneri bir kez çalışıp çıkar. Ürettiği nginx yapılandırması `GET /api/version` isteklerini dosyaya yazar. Sonraki komutlardaki grup izinleri, Linux kullanıcı numaran 1000'den farklı olduğunda da servislerin kendi dosyalarına erişmesini sağlar.

## 4. Seyir Panel'i ve AI Gateway'i ayrı ayrı başlat

**Çalışma klasörü** `~/seyir-kurulum/Seyir`. Panelde gösterilen `14322` adresi, 8. adımda bilgisayarında açacağın SSH tünelinin ucudur.

```bash
cd "$HOME/seyir-kurulum/Seyir"
docker run -d --name seyir-panel --restart unless-stopped \
  --network seyir-panel-net -p 127.0.0.1:4321:4320 \
  --group-add "$(stat -c %g data/logs/cloudflare-os-web.jsonl)" \
  -v seyir-data:/data -v "$PWD/data/logs:/logs:ro" \
  -v seyir-workshop-audit:/seyir-audit:ro \
  -e SEYIR_LOG_DIR=/logs \
  -e SEYIR_PUBLIC_GATEWAY_URL=http://127.0.0.1:14322/v1 \
  seyir/panel:local

KEY="$HOME/.config/seyir/gateway-token"
docker run -d --name seyir-gateway --restart unless-stopped \
  --network seyir-dockerflare -p 127.0.0.1:4322:4322 \
  --group-add "$(stat -c %g "$KEY")" \
  -v seyir-data:/data -v "$KEY:/run/secrets/seyir-client:ro" \
  -e SEYIR_CLIENT_TOKEN_FILE=/run/secrets/seyir-client \
  seyir/gateway:local
```

## 5. Dockerflare Workshop'ı başlat

**Çalışma klasörü** `~/seyir-kurulum/dockerflare-os`. Yönetici hesabı için `baris` yerine istersen kendi kullanıcı adını yaz. `PUBLIC_BASE_URL` tarayıcıda kullanacağın adresle eşleşir.

```bash
cd "$HOME/seyir-kurulum/dockerflare-os"
docker run -d --name seyir-dockerflare-workshop --restart unless-stopped \
  --network seyir-dockerflare --network-alias workshop \
  -v seyir-workshop-data:/data \
  -v seyir-workshop-data:/seyir-source:ro \
  -v seyir-workshop-audit:/seyir-audit \
  -e SEYIR_WORKSHOP_OBJECTS=/seyir-source/objects \
  -e SEYIR_WORKSHOP_AUDIT_FILE=/seyir-audit/workshop.sqlite \
  -e SEYIR_GATEWAY_ROOT=http://seyir-gateway:4322/v1 \
  -e PUBLIC_BASE_URL=http://127.0.0.1:28080 \
  -e 'ADMINS=["baris"]' \
  -e 'SELF_HOSTED_MODEL_BASE_URLS=["http://seyir-gateway:4322/v1"]' \
  dockerflare/workshop:local
```

## 6. Dockerflare Web'i başlat

**Çalışma klasörü** `~/seyir-kurulum/Seyir`. Web imajını Dockerflare klasöründe derledin. Bu komutta Seyir klasörüne dönüyorsun çünkü nginx yapılandırması ve erişim logu burada.

```bash
cd "$HOME/seyir-kurulum/Seyir"
docker run -d --name seyir-dockerflare-web --restart unless-stopped \
  --network seyir-dockerflare -p 127.0.0.1:18080:8080 \
  --group-add "$(stat -c %g data/logs/cloudflare-os-web.jsonl)" \
  -v "$PWD/data/cloudflare-os/web.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$PWD/data/logs/cloudflare-os-web.jsonl:/var/log/nginx/seyir-web.jsonl" \
  dockerflare/web:local
```

## 7. Sağlığı kontrol et ve bir isteği panele kadar izle

```bash
docker ps --filter name=seyir- --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
curl -fsS http://127.0.0.1:4321/api/health
curl -s -o /dev/null -w 'Gateway: %{http_code}\n' http://127.0.0.1:4322/v1/models
curl --retry 8 --retry-connrefused --retry-delay 1 -fsS -D - -o /dev/null \
  http://127.0.0.1:18080/api/version
```

Dört konteyner `Up`, panel `{"ok":true}`, kimliksiz gateway çağrısı `401`, Web isteği `200` döndürmeli. Son yanıtın `X-Seyir-Trace` değerini al. Birkaç saniye sonra aynı kaydı sorgula.

```bash
curl -fsS "http://127.0.0.1:4321/api/events?trace_id=BURAYA_IZ_KIMLIGI"
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

- [Seyir AI Gateway](http://127.0.0.1:14321/#gateway)
- [Workshop sohbetleri, onaylar ve maliyet](http://127.0.0.1:14321/#workshop)
- [Dockerflare erişim logları](http://127.0.0.1:14321/#logs)
- [Dockerflare Web ve Workshop](http://127.0.0.1:28080/)

Dockerflare'da ilk hesabını `ADMINS` için seçtiğin adla oluştur. Workshop'ın gateway adresi Docker ağı içinde `http://seyir-gateway:4322/v1`. Modelini bağlama zamanı geldiğinde **AI providers → OpenAI-compatible endpoint** alanına bu adresi, Seyir istemci anahtarını ve gerçek model kimliğini gir. Seyir'in **Koruma ayarları** bölümünden gerçek Qwen3Guard adresini ayrıca bağlayabilirsin.

Bu kurulumda panele aktarılan Web erişim logu `GET /api/version` yolunu kapsar. Gateway, üzerinden geçen model çağrılarının kararlarını ayrıca kaydeder.

**Workshop sohbetleri** bölümünden bir sohbeti aç. Workshop yaklaşık beş saniyede bir kimlikleri, araç adlarını ve onay kararlarını ayrı veri birimine aktarır. Panel yalnızca bu özeti okur. Yeni model isteklerinde Workshop gateway'in verdiği istek kimliğini saklar. Seyir, ana model ve etkin guard çağrılarının tokenlarını o andaki tarifeyle fiyatlar. Eksik model tarifesi veya kullanım varsa bilinen tutarı ve kaç çağrının fiyatlanamadığını gösterir. Eski sohbetlerde kaydedilmeyen onaylayan kişi ve yardımcı model çağrıları bilinmiyor olarak kalabilir. Dört servisi bu arşivden derlemek Workshop tarafındaki kayıt desteğini de kurar.

Sohbetin maliyet kayıtları `seyir-data` biriminde saklanır. Genel gateway loglarının yedi günlük süresi dolunca da sohbet ekranında tutarı görebilirsin. Kendi sağlayıcını bağlamadan iki kullanıcıyla örneği tekrarlamak için [Workshop sohbet denetimi](examples/cloudflare-os/workshop-audit/README.md) adımlarını izle.
