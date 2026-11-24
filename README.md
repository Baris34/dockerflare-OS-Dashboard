# OS Dashboard

OS Dashboard, bir sunucunun kaynak kullanımını, uygulama günlüklerini ve OpenAI uyumlu model trafiğini tek ekranda toplar. Docker kurulumunda panel ile toplayıcı bir konteynerde, AI Gateway ikinci bir konteynerde çalışır. İki servis aynı yerel SQLite veritabanını kullanır. [Docker panelini aç](http://127.0.0.1:4321/#ai-gateway) · [Ayrı imajları derle ve çalıştır](#paneli-ve-ai-gatewayi-ayrı-konteynerlerde-çalıştır)

Docker veri birimleri, `OS_DASHBOARD_*` ortam değişkenleri ve `X-OS-Dashboard-*` HTTP başlıkları OS Dashboard adını kullanır.

Dockerflare OS ile kurulduğunda Workshop’ın **Admin → OS Dashboard** bağlantısı sohbet denetimini açar. Panelden **Dockerflare OS’u aç** ile Workshop’a dönebilirsin. Yerel kurulumda [OS Dashboard](http://127.0.0.1:4321/#workshop) ve [Dockerflare OS](http://127.0.0.1:18080/) ayrı adreslerden çalışır. [Birlikte kurulum](SUNUCU-KURULUMU.md)

## Windows veya Linux üzerinde tek süreçte başlat

Node.js 24 veya daha yeni bir sürümle proje klasöründe çalıştır.

```sh
node server.mjs
```

[Paneli aç](http://127.0.0.1:4320/). Ek paket kurulumu gerekmez. Bu bilgisayarda uygulama doğrudan Windows üzerinde çalıştığında Windows olay kanallarını okuyabilir. Başka bir sunucuyu izlemek için OS Dashboard'u o makinede başlat. Uzaktaki paneli kendi bilgisayarından açmak için SSH yerel port yönlendirmesi kullanabilirsin.

```sh
ssh -N -L 4321:127.0.0.1:4320 kullanici@sunucu
```

Bu örnekte uzak sunucunun paneli kendi bilgisayarında `http://127.0.0.1:4321` adresinde açılır. Yerel servis varsayılan olarak loopback üzerinde dinler. Aynı bilgisayardaki istemciler ayarları değiştirebilir.

## İki PowerShell penceresinde Dockerflare OS loglarını izle

Bu örnekte yerel klonlar `C:\Github\OS-Dashboard` ve `C:\Github\dockerflare-os` altında. Dashboard klasörün `dockerflare-OS-Dashboard` adındaysa ilk `cd` komutlarında o yolu kullan. Her iki süreç de aynı makinede çalışır.

**1. Panel penceresi** — OS Dashboard'u güncelle ve başlat.

```powershell
cd C:\Github\OS-Dashboard
git pull --ff-only
$env:DOCKERFLARE_WORKSHOP_URL = "http://localhost:8787"
pnpm start
```

**2. OS penceresi** — Daha önce açtığın `pnpm run-local` sürecini Ctrl+C ile kapat. OS'i aynı portta, Wrangler erişim kayıtlarını okuyacak köprüyle başlat.

```powershell
cd C:\Github\OS-Dashboard
$kopru = (Resolve-Path .\scripts\local-os.mjs).Path
cd ..\dockerflare-os
pnpm run-local 2>&1 | node $kopru
```

**3. Kontrol** — OS hazır olduğunda [OS sürüm adresini](http://127.0.0.1:8787/api/version) aç. Birkaç saniye içinde [Log akışında](http://127.0.0.1:4320/#logs) `dockerflare-local.jsonl` kaynağından `GET /api/version | HTTP 200` görünür. Otomatik kontrol için Dashboard klasöründeki boş bir terminalden `pnpm run check:local` çalıştır. Özel port kullanıyorsan kontrolün ilk argümanı panel adresi, ikincisi OS adresidir.

Köprü, ana sayfa, API, gatekeeper, sağlık ve blueprint ekran görüntüsü isteklerinin yöntemini, rota grubunu ve HTTP durumunu kaydeder. Workshop içindeki işlemler WebSocket üzerinden geçer. [Workshop ekranı](http://127.0.0.1:4320/#workshop) sohbet denetimini Dockerflare OS deposundaki `docker/os-dashboard-export` aracılığıyla yerel Wrangler verisinden okur. Özel bir veri dizini kullanıyorsan OS terminalinde `OS_DASHBOARD_WORKSHOP_OBJECTS` değerini `v3/do` dizinine ayarla. Özelleştirdiğin `OS_DASHBOARD_DATA_DIR` ve `OS_DASHBOARD_LOG_DIR` değerlerini iki terminalde de aynı mutlak yollara ayarla. OpenAI veya guard anahtarı gerekmez.

## Panelde bir işi baştan sona izle

**Workshop** ekranı, Dockerflare sohbetlerini çalışma alanına göre ayırır. Bir sohbeti açtığında başlatan hesabı, model ve araç çağrılarını, onaylayan veya reddeden hesabı ve tahmini toplamı görürsün. Eski kayıtlarda kişi veya fiyat eksikse panel bunu belirtir. [Dört servisin tüm kurulum komutları](SUNUCU-KURULUMU.md) · [Yerel Workshop ekranı](http://127.0.0.1:4321/#workshop)

1. **Genel bakış** ekranında CPU ve RAM eğrilerini, hata sayısını ve bağlı kaynakları gör. Sağ üstten zaman aralığını değiştirebilir veya görünümü duraklatabilirsin. Toplayıcı arka planda çalışmayı sürdürür.
2. **Veri kaynakları** ekranında sistem günlüğünü, izlenen klasörü ve Docker bağlantısını kontrol et. Windows'ta Application ve System, Linux'ta erişilebilen systemd journal kayıtları okunur. Docker için çalışan motora erişebilen bir Docker CLI gerekir.
3. **Log akışı** ekranında zaman, kaynak ve seviye filtrelerini kullan. Ctrl+K metin aramasını açar. Bir satıra tıkladığında sağlayıcı, olay türü ve varsa istek kimliği görünür.
4. Uygulamanın bir işlem başlatırken ürettiği kimliği uygulama olaylarına `trace_id`, model çağrılarına `X-OS-Dashboard-Trace` olarak ekle. İlgili çağrıları `X-OS-Dashboard-Source: chat` veya `X-OS-Dashboard-Source: thread-title` gibi etiketlerle ayırabilirsin. Olay ayrıntısında aynı kimliğin zaman çizgisini, çağrı sayısını ve hesaplanabilen maliyet toplamını görürsün.

### Uygulama olayını gönder

Cloudflare OS üzerinde çalışan bir HTTP isteğini Docker'dan panele kadar takip etmek için [Cloudflare OS Docker örneğini](examples/cloudflare-os/README.md) kullanabilirsin.

PowerShell örneği, çalışan panele bir olay ekler.

```powershell
$event = @{ service = "siparis-api"; level = "info"; message = "Sipariş işlendi"; trace_id = "siparis-42" }
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4320/api/events -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes(($event | ConvertTo-Json)))
```

Dosya kullanan bir servis için `data/logs` altına `.log`, `.jsonl` veya `.ndjson` yazabilirsin. Her olayı yeni satırla bitir. JSON satırlarında `message` veya `msg`, `level` ve isteğe bağlı `trace_id` okunur. Başka bir mevcut klasörü izlemek için başlatmadan önce `OS_DASHBOARD_LOG_DIR` ayarla. Tarama seçilen klasörün doğrudan altındaki dosyaları kapsar.

### AI Gateway ve koruma kararları

[AI Gateway](http://127.0.0.1:4320/#ai-gateway) model çağrılarının giriş ve çıkışındaki denetimleri gösterir. Bir kararı açarak aynı istek kimliğine bağlı denetimleri ve çağrının sonucunu inceleyebilirsin. Bir DLP eşleşmesi hassas veri biçimini, bir guard kararı modelin verdiği güvenlik sınıfını gösterir. İşaretlenen bir çağrı devam eder. Engellenen bir girdi ana modele iletilmez. Bir çıktı engellendiyse ana model zaten yanıt üretmiştir.

**Örnek çalıştırma.** Proje kökünde `node examples/cloudflare-os/ai-gateway/run.mjs --import` dört gerçek Workshop sohbeti başlatır. Varsayılan hedef tek süreçli panelin veritabanıdır. Docker panelinde görmek için PowerShell'de önce `$env:OS_DASHBOARD_IMPORT_VOLUME='os-dashboard-data'` ayarla. DLP gerçek OS Dashboard kurallarıyla çalışır. Guard ve ana model, Docker ağına özel iki test servisidir. [İmajlar, doğrulamalar ve tekrar çalıştırma](examples/cloudflare-os/ai-gateway/README.md)

**Qwen3Guard'ı bağlamak için** AI Gateway'deki koruma ayarlarına OpenAI uyumlu API kökünü ve sunucunda yayınlanan model kimliğini gir. Örneğin özel ağda sunucu ismi `guard` ise kök `http://guard:8000/v1`, kimlik `Qwen/Qwen3Guard-Gen-4B` olabilir. Bunlar örnek değerlerdir. OS Dashboard model adını indirmez. Sağlayıcının Qwen3Guard-Gen sohbet şablonuyla girdi ve asistan yanıtı sınıflandırabilmesi gerekir. İşletmeciye ait ayrı bir guard anahtarı gerekiyorsa OS Dashboard sürecine `OS_DASHBOARD_GUARD_KEY` ve tam origin olarak `OS_DASHBOARD_GUARD_KEY_ORIGIN` ver. Anahtarlar panel ayarlarına yazılmaz. [Qwen'in model kartı ve sunucu sözleşmesi](https://huggingface.co/Qwen/Qwen3Guard-Gen-4B)

Gerçek guard bağlantısı boşken Qwen denetimi kapalıdır. DLP bağımsız çalışır. Qwen açıksa `Unsafe` için engelleme veya işaretleme seçilebilir. `Controversial` işaretlenir. Denetim tamamlanamazsa geçit çağrıyı durdurur. Çıkış koruması açıkken akışlı yanıtın metni ve desteklenen araç çağrıları incelendikten sonra istemciye gönderilir. İlk parçanın kullanıcıya ulaşması bu yüzden gecikir.

Koruma açıkken metin ve işlev çağrıları desteklenir. Görsel, ses, dosya, uzaktaki sohbet geçmişine referans veya tanınmayan yanıt biçimi geldiğinde geçit denetim hatası döndürür. Model çıktısı için tampon sınırı 4 MiB, guard'a gönderilen istek gövdesi için 192 KiB, guard yanıtı için 16 KiB'dır. Her guard denetiminin zaman sınırı 30 saniyedir. Hata ve atlanan adımlar panelden izlenebilir.

**Dockerflare ile kendi modelini kullanmak için** OS Dashboard'u Docker host'unda çalıştırabilir, paneli `127.0.0.1:4320` üzerinde tutabilirsin. Workshop'ın erişeceği özel arayüzün IP adresini `OS_DASHBOARD_INFERENCE_BIND`, isteğe bağlı portu `OS_DASHBOARD_INFERENCE_PORT` (varsayılan 4322), istemci için ürettiğin özel anahtarı `OS_DASHBOARD_CLIENT_TOKEN` olarak OS Dashboard sürecine ver. Bu ikinci port yalnızca kimlik doğrulamalı `/v1` yollarını sunar. Dockerflare'da bu adresin `/v1` kökünü `SELF_HOSTED_MODEL_BASE_URLS` listesine ekle. Workshop **AI providers → OpenAI-compatible endpoint** alanında aynı kökü, OS Dashboard istemci anahtarını ve ana modelin adını gir. Bu servisler arasında güvenilen özel ağ veya TLS kullan. Docker içindeki `127.0.0.1` ilgili konteynerin kendisidir. Ana sağlayıcının adresiyle guard adresi OS Dashboard'da ayrı ayarlanır.

### Ana modeli hazır olduğunda bağla

1. **AI Gateway → Model trafiği** bölümünde sağlayıcının API kökünü girip kaydet. OpenAI kullanacaksan kök `https://api.openai.com/v1` olur. Kendi model sunucunun OpenAI uyumlu kökünü de kullanabilirsin.
2. OpenAI API anahtarını OS Dashboard'u çalıştıran sürece `OS_DASHBOARD_UPSTREAM_KEY` ortam değişkeni olarak ver. Çalışan servisin yeni anahtarı alması için o ortamda yeniden başlat. Özel bir sağlayıcıya anahtar gönderilecekse `OS_DASHBOARD_KEY_ORIGIN` değerini o sağlayıcının tam origin'i olarak ayarla. Varsayılan `https://api.openai.com`.
3. Tek süreçli yerel kurulumda istemcinin API kökü `http://127.0.0.1:4320/v1`. Bu modda SDK bir anahtar istiyorsa temsili bir değer kullanabilirsin. Aşağıdaki Docker kurulumunda ise istemci bağımsız AI Gateway'in `4322` portunu ve gerçek OS Dashboard istemci anahtarını kullanır. Her iki kurulumda da ana sağlayıcı kimliğini OS Dashboard yönetir.
4. İstemcinden bir istek gönder ve **Model trafiği** ekranında aç. `POST /v1/responses`, `POST /v1/chat/completions` ve `GET /v1/models` desteklenir. JSON ve akışlı yanıtlar iletilir. Chat Completions akışında kullanım bilgisini almak için istemci isteğine `"stream_options":{"include_usage":true}` ekle. Bu görünüm OS Dashboard üzerinden geçen API çağrılarını kapsar. ChatGPT web sohbetlerinin geçmişi ayrı kalır.
5. **Tarifeler** ekranında sağlayıcının döndürdüğü model kimliği için bir milyon token başına USD cinsinden giriş, önbellekten okunan giriş ve çıkış fiyatlarını gir. OS Dashboard kullanım ve tarife mevcut olduğunda çağrının tahmini maliyetini saklar. Tarife değişikliği geçmiş kayıtları yeniden fiyatlandırmaz. Sağlayıcı kullanım döndürmezse eksik alanlar çizgiyle gösterilir.

Bağlantı ayarlarındaki isteğe bağlı dakikalık sınır istemciler arasında paylaşılır. DLP, kontrol toplamı eşleşen kart numaraları ve desteklenen anahtar biçimleri için yerel kuralları uygular.

## Paneli ve AI Gateway'i ayrı konteynerlerde çalıştır

`os-dashboard/panel:local` arayüzü, ayarları ve telemetriyi sunar. `os-dashboard/ai-gateway:local` model çağrılarını, DLP'yi ve guard denetimini yürütür. İki süreç aynı Docker host'undaki `os-dashboard-data` birimini kullanır. Panelde kaydedilen ayarlar AI Gateway'in bir sonraki isteğinde geçerli olur, AI Gateway'in yazdığı kararlar panelde görünür.

Komutları Linux veya WSL Ubuntu kabuğunda OS Dashboard klasöründen çalıştır. Her komut yalnızca ilgili imajı derler.

```sh
docker build --target panel   --tag os-dashboard/panel:local .
docker build --target ai-gateway --tag os-dashboard/ai-gateway:local .
```

Bu Windows makinesinde Docker motoru WSL Ubuntu içinde çalışıyor. Son WSL oturumu kapanınca Ubuntu da duruyor. Windows yeniden başladıktan sonra paneli kullanacağın oturumda aşağıdaki PowerShell komutu Ubuntu'yu arka planda açık tutar. Docker, `unless-stopped` ile başlatılan servisleri tekrar açar.

```powershell
Start-Process wsl.exe -ArgumentList '-d','Ubuntu','--exec','sleep','infinity' -WindowStyle Hidden
```

### Ağı, birimi ve istemci anahtarını bir kez hazırla

```sh
docker network inspect os-dashboard-panel-net >/dev/null 2>&1 || docker network create os-dashboard-panel-net
docker network inspect os-dashboard-dockerflare >/dev/null 2>&1 || docker network create os-dashboard-dockerflare
docker volume create os-dashboard-data
docker volume create os-dashboard-workshop-audit

install -d -m 700 "$HOME/.config/os-dashboard"
if [ ! -e "$HOME/.config/os-dashboard/ai-gateway-token" ]; then
  (umask 077; set -C; openssl rand -hex 32 > "$HOME/.config/os-dashboard/ai-gateway-token")
fi
```

AI Gateway imajı UID 1000 ile çalışır. Bu bilgisayarda WSL kullanıcısının UID'si de 1000. Başka bir Linux kurulumunda anahtar dosyası için bu UID'ye okuma izni ver. Anahtarı kendi istemcinin parola veya API token alanında kullan.

### Paneli çalıştır

```sh
mkdir -p data/logs
docker run -d --name os-dashboard-panel --restart unless-stopped \
  --network os-dashboard-panel-net -p 127.0.0.1:4321:4320 \
  --mount type=volume,source=os-dashboard-data,target=/data \
  --mount type=volume,source=os-dashboard-workshop-audit,target=/os-dashboard-audit,readonly \
  --mount "type=bind,source=$PWD/data/logs,target=/logs,readonly" \
  -e DOCKERFLARE_WORKSHOP_URL=http://127.0.0.1:18080 \
  -e OS_DASHBOARD_LOG_DIR=/logs os-dashboard/panel:local
```

[Docker panelini aç](http://127.0.0.1:4321/#ai-gateway). Panelin konteyner portu `4320`. Yukarıdaki komut bunu host'ta `4321` olarak yayınlar. Windows'ta doğrudan çalışan panel `4320` adresini kullanmaya devam edebilir. İki kurulumun veritabanları ayrıdır. Konteynerin canlı donanım ölçümleri gördüğü Linux ortamına aittir. Salt okunur bağlanan klasör, Windows ve Docker panellerinin aynı yeni dosya loglarını izlemesini sağlar.

### AI Gateway'i çalıştır

```sh
docker run -d --name os-dashboard-ai-gateway --restart unless-stopped \
  --network os-dashboard-dockerflare -p 127.0.0.1:4322:4322 \
  --mount type=volume,source=os-dashboard-data,target=/data \
  --mount "type=bind,source=$HOME/.config/os-dashboard/ai-gateway-token,target=/run/secrets/os-dashboard-client,readonly" \
  -e OS_DASHBOARD_CLIENT_TOKEN_FILE=/run/secrets/os-dashboard-client \
  -e OS_DASHBOARD_UPSTREAM_KEY -e OS_DASHBOARD_KEY_ORIGIN \
  -e OS_DASHBOARD_GUARD_KEY -e OS_DASHBOARD_GUARD_KEY_ORIGIN os-dashboard/ai-gateway:local
```

Host istemcisinin API kökü `http://127.0.0.1:4322/v1`, aynı Docker ağındaki Workshop'ın API kökü `http://os-dashboard-ai-gateway:4322/v1`. OpenAI ve Qwen3Guard adreslerini hazır olana kadar boş bırakabilirsin. İhtiyaç duyulan sağlayıcı anahtarlarını yalnız AI Gateway sürecinin ortamına ver. Panel veya AI Gateway'i ayrı ayrı durdurup başlatabilirsin, örneğin `docker restart os-dashboard-ai-gateway`. Kalıcı kayıtlar `os-dashboard-data` birimindedir.

### Dockerflare Web, Workshop ve test servisleri

- Gerçek Web ve Workshop imajlarının ayrı derleme ve çalıştırma komutları [Dockerflare HTTP log örneğinde](examples/cloudflare-os/README.md) bulunur.
- Dört sohbetlik deneyin test modeli, guard test servisi, örnek AI Gateway ve RPC istemcisi de ayrı imajlardan başlar. [Servis başına komutlar ve deneyi tekrarlama](examples/cloudflare-os/ai-gateway/README.md)

## Veri akışı ve saklama

| Kaynak | Kaydedilen veri ve kapsam |
|---|---|
| Sunucu | Yaklaşık 2,5 saniyede bir CPU ve RAM kullanımı ile veri dizininin bulunduğu diskin doluluk oranı |
| Sistem günlüğü | Windows'ta kanal, sağlayıcı, olay numarası, zaman, seviye ve mesajın ilk satırı. Başlangıçta kanal başına son altı saatten en çok 80 kayıt, devamında kayıt numarasıyla artımlı okuma. Linux'ta başlangıçta en çok 150 journal kaydı ve ardından journal imleci |
| Log dosyaları | Kaynak dosya, mesaj ve varsa iz kimliği. Mevcut büyük bir dosyanın son 256 KiB'ından başlanır. Dosya konumu yeniden başlatmalar arasında saklanır |
| Docker | Çalışan konteynerin adı, imajı ve durumu. Erişilebilen stdout ve stderr, tarama başına konteyner başına son 250 satır. Yoğun trafikte bu sınırın üzerindeki satırlar atlanabilir |
| Model geçidi | İstek ve iz kimlikleri, işlem etiketi, istenen ve dönen model, süre, durum, bildirilen tokenlar ve hesaplanabilen tahmini maliyet |
| Uygulama olayları | Uygulamanın gönderdiği servis, seviye, olay türü, mesaj ve iz kimliği |

Varsayılan veritabanı `data/current/os-dashboard.sqlite`. Olaylar ve ölçümler yedi gün tutulur. Temizlik başlangıçta ve saat başı çalışır. Ayarlar ve son okuma konumları kalıcıdır. Modelin soru ve yanıt gövdeleri kaydedilmez. Uygulama ve sistem loglarının mesajları ise saklanır. Yaygın anahtar ve parola biçimleri maskelenir. Serbest metinde hassas veri üreten bir uygulamada log içeriğini kaynağında da sınırla.

Toplayıcılar [lib/sources.mjs](lib/sources.mjs), model geçidi [lib/ai-gateway.mjs](lib/ai-gateway.mjs), SQLite şeması ve sorgular [lib/store.mjs](lib/store.mjs), yerel API [server.mjs](server.mjs) içindedir. Tarayıcı arayüzünün kaynakları [public](public) klasöründedir.

## Doğrulama

```sh
node --test
```

Testler geçici bir SQLite veritabanı ve yerel HTTP sağlayıcısı kullanır. Gerçek bir sağlayıcı hesabına veya API anahtarına ihtiyaç duymaz.
