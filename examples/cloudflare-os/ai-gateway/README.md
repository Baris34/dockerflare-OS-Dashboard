# Dockerflare Workshop sohbetini OS Dashboard’da izle

Bu örnek gerçek Dockerflare web ve Workshop imajlarını başlatır. İstemci, web servisi üzerinden bir Cap’n Web oturumu açar, geçici bir çalışma alanı oluşturur ve dört sohbet gönderir. Workshop bu sohbetleri OS Dashboard’un kimlik doğrulamalı çıkarım portuna yollar. DLP’yi ve istek kaydını OS Dashboard’un kendi gateway kodu çalıştırır. Model ve Qwen3Guard uyumlu sınıflandırıcı, kapalı bir Docker ağında çalışan iki HTTP test servisidir. Sınıflandırıcı zararsız bir işarete göre sabit bir yanıt verir. Bu çalışma politika zincirini ve Workshop’un aldığı sonucu doğrular.

## İmajları ayrı derle

Aşağıdaki örnekler WSL Ubuntu veya Linux kabuğu içindir. Web, Workshop ve RPC istemcisinin taban imajı Dockerflare deposundan derlenir. Bu makinede üçü de hazır.

```sh
cd /mnt/c/Github/dockerflare-os
docker buildx build --builder default --load --target web -t dockerflare/web:local .
docker buildx build --builder default --load --target workshop -t dockerflare/workshop:local .
docker buildx build --builder default --load --target source -t dockerflare/checks:local .
```

OS Dashboard deposunda her örnek servisini kendi etiketiyle derle. `default` builder yerel Docker motorundaki taban imajlarına erişir. Model ve Guard imajları aynı küçük HTTP sunucusunu farklı rollerle başlatır. Gateway imajı OS Dashboard’un politika, SQLite ve çıkarım portu kodunu içerir. İstemci imajında dört Workshop sohbetini çalıştıran RPC programı bulunur.

```sh
cd /mnt/c/Github/OS-Dashboard
df=examples/cloudflare-os/ai-gateway/Dockerfile
docker buildx build --builder default --load -f "$df" --target model   -t seyir/demo-model:local .
docker buildx build --builder default --load -f "$df" --target guard   -t seyir/demo-guard:local .
docker buildx build --builder default --load -f "$df" --target gateway -t seyir/demo-gateway:local .
docker buildx build --builder default --load -f "$df" --target checks  -t seyir/demo-checks:local .
```

## Servisleri ayrı çalıştır

Aşağıdaki komutları aynı kabukta çalıştır. Rastgele ön ek bu koşudaki ağları, konteynerleri ve veri birimlerini adlandırır. İki ağ da iç ağdır. Web, Workshop ve istemci ön ağı paylaşır. İki test servisine ikinci ağ üzerinden yalnızca gateway bağlanır.

```sh
lab="seyir-manual-$(cat /proc/sys/kernel/random/uuid)"
docker network create --internal "$lab-front"
docker network create --internal "$lab-fixtures"
docker volume create "$lab-worker-data"
docker volume create "$lab-gateway-data"
docker volume create "$lab-auth"
```

**Model test servisi**

```sh
docker run -d --pull=never --name "$lab-model" --network "$lab-fixtures" --network-alias model seyir/demo-model:local
```

**Guard test servisi**

```sh
docker run -d --pull=never --name "$lab-guard" --network "$lab-fixtures" --network-alias guard seyir/demo-guard:local
```

**Örnek OS Dashboard gateway’i** rastgele bir istemci anahtarı üretir ve denetim kararlarını kendi SQLite birimine yazar.

```sh
docker run -d --pull=never --name "$lab-gateway" --network "$lab-front" --network-alias gateway \
  -v "$lab-gateway-data:/data" -v "$lab-auth:/auth" seyir/demo-gateway:local
docker network connect "$lab-fixtures" "$lab-gateway"
```

**Workshop** yalnızca örnek gateway’i model kökü olarak kullanır.

```sh
docker run -d --pull=never --name "$lab-workshop" --network "$lab-front" --network-alias workshop \
  -v "$lab-worker-data:/data" -e PUBLIC_BASE_URL=http://web:8080 \
  -e 'ADMINS=["seyirdemo"]' -e 'SELF_HOSTED_MODEL_BASE_URLS=["http://gateway:8000/v1"]' dockerflare/workshop:local
```

**Web** aynı ağda Workshop’a ters vekil olarak bağlanır.

```sh
docker run -d --pull=never --name "$lab-web" --network "$lab-front" --network-alias web dockerflare/web:local
```

**RPC istemcisi** hazır olana kadar Workshop’u bekler, dört sohbeti açıp bitiş durumlarını kontrol eder. Ardından gateway’in kendi veritabanından gerçek olayları ve iki HTTP servisinden çağrı sayaçlarını okuyabilirsin.

```sh
docker run --rm --pull=never --name "$lab-checks" --network "$lab-front" \
  -v "$lab-auth:/auth:ro" seyir/demo-checks:local
docker exec "$lab-gateway" node /demo/capture.mjs
```

Manuel koşuyu bitirirken aynı kabukta yalnızca bu örneğin kaynaklarını kaldır.

```sh
docker rm -f "$lab-web" "$lab-workshop" "$lab-gateway" "$lab-guard" "$lab-model"
docker network rm "$lab-front" "$lab-fixtures"
docker volume rm "$lab-worker-data" "$lab-gateway-data" "$lab-auth"
```

## İsteğe bağlı uçtan uca kontrol ve panele aktarma

İmajları derledikten sonra aynı altı servisi ve iz doğrulamasını tek komutla da çalıştırabilirsin. Betik her koşuda kendi ağ ve veri birimlerini oluşturup sonunda temizler. PowerShell’de OS Dashboard kökünden çalıştır.

```powershell
node examples/cloudflare-os/ai-gateway/run.mjs
```

Doğrulanan izleri yerel panelde görmek için komuta `--import` ekle. Seçenek, o çalıştırmada üretilen olayları panelin SQLite veritabanına ekler. Ayarladıysan panelle aynı `SEYIR_DATA_DIR` değerini kullan. Node.js 24 veya üzeri gerekir. Windows’ta betik WSL Ubuntu’daki Docker motorunu, Linux’ta yerel Docker CLI’ını kullanır.

Windows’taki varsayılan hedef `data/current/seyir.sqlite`, panel adresi `http://127.0.0.1:4320`. Bağımsız Docker panelini kullanıyorsan `SEYIR_IMPORT_VOLUME` ile onun mevcut veri birimini seç. Bu makinede adı `seyir-data` ve panel adresi `http://127.0.0.1:4321`. Örneği derleyip Docker panelini en az bir kez başlattıktan sonra PowerShell’de çalıştır.

```powershell
$env:SEYIR_IMPORT_VOLUME = 'seyir-data'
try { node examples/cloudflare-os/ai-gateway/run.mjs --import }
finally { Remove-Item Env:SEYIR_IMPORT_VOLUME }
```

Linux kabuğundaki karşılığı `SEYIR_IMPORT_VOLUME=seyir-data node examples/cloudflare-os/ai-gateway/run.mjs --import`. Betik önce volume’un ve içinde hazırlanmış `/data/seyir.sqlite` dosyasının varlığını doğrular. Ardından doğrulanmış olayları standart girdiden, yalnız o volume’a bağlı ağsız ve geçici bir içe aktarma işlemine gönderir. Dosya ve volume hedeflerinde aynı işlem yinelenen kayıtları kontrol eder.

## Sonuçları okuma

| Workshop modeli | Denenen durum | Workshop sonucu | Gateway HTTP | Ana modele gitti mi? |
| --- | --- | --- | ---: | --- |
| `demo-pass` | Giriş ve çıkış güvenli | Beklenen sohbet yanıtı | 200 | Evet |
| `demo-dlp` | Girişte sentetik test kartı | Hata | 424 | Hayır |
| `demo-guard-in` | Girişte sınıflandırıcı işareti | Hata | 424 | Hayır |
| `demo-guard-out` | Model yanıtında sınıflandırıcı işareti | Hata | 424 | Evet |

Terminalde sohbet numarası ve iz kimliği görünür. İçe aktardığın panelde **AI Gateway → Model trafiği** görünümünü aç, ilgili `demo-…` modelinin isteğini seç ve **İstek izini aç** bağlantısını kullan. Doğrudan bağlantı için panel adresinin sonuna `/#gateway?trace=<iz-kimliği>` ekle. Her izde bir gateway isteği ve dört politika olayı bulunur. **Atlandı** kararı, daha erken bir adımda durdurulan isteklerde sonraki denetimi gösterir.

24 Kasım 2026’daki yerel çalıştırmada dört sohbet dört model isteği üretti. Bağımsız HTTP sayaçları ana modelin iki istek, guard’ın üç giriş ve iki çıkış aldığını gösterdi. Windows’taki panel aynı dört iz altında toplam 20 olayı döndürdü. İçe aktarıcı aynı kayıtlar ikinci kez sunulduğunda sıfır yeni olay ekledi.

Workshop’un kullanıcı oturumu, sohbet geçmişi ve çıkarım portunun rastgele anahtarı geçici veri birimleriyle birlikte temizlenir. Panelin aldığı alanlar istek ve iz kimliği, model adı, karar, durum, süre, kullanım ve sabit kural açıklamasıdır. İçe aktarma, politika kayıtları ile iki HTTP servisinin bağımsız sayaçları eşleştiğinde yapılır. Örneğin gateway ayarları yalnızca örnek sürecinin belleğinde tutulur.
