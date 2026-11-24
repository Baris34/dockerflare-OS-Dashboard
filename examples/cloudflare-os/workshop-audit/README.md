# Workshop sohbeti, araçlar ve onayların denetimi

Bu örnek yeni bir Docker ağında gerçek Workshop’u başlatır. `auditdemo` kullanıcısı Cap’n Web oturumu açıp bir sohbet başlatır. Dört model isteğini deterministik bir yerel HTTP servisi yanıtlar.

1. Model `executeCode` aracına yerel bir hesap yaptırır. Sonucun ikinci model isteğine ulaştığını HTTP servisi kontrol eder.
2. Model `requestConnection` ile bir agent-spawner bağlantısı ister. Sohbeti başlatan kullanıcı, `auditreview` hesabını çalışma alanına davet eder. Örnek istemci bu ikinci hesabın ayrı RPC oturumunda yerel bağlantıyı oluşturup kartı kabul eder.
3. Model `createExternalResource` ile Google Docs belgesi oluşturmayı önerir. Workshop bağlayıcısı yerel bir taslak ve bekleyen eylem üretir. Örnek istemci `rejectAction` çağırır ve Workshop’un eylem kaydında `resolvedBy.id = auditdemo` değerini kontrol eder. Bu akışta Google hesabı açılmaz ve Google’a istek gönderilmez.
4. AI Gateway, dört yanıtın kullanım verisini yerel örneğin tarifesiyle hesaplar. Her yanıt 120 girdi ve 20 çıktı tokenı bildirir. Milyon token başına girdi için 2 USD, çıktı için 5 USD örnek tarifesiyle toplam 0,00136 USD hesaplanır. Model ücretsiz test servisidir.

İstemci, bağlantı kartını kabul eden `auditreview` kullanıcısını kartın `decidedBy` alanında, belge önerisini reddeden `auditdemo` kullanıcısını eylemin `resolvedBy` alanında doğrular. İki hesap da yalnız bu koşunun Workshop’unda bulunur.

## İmajlar

WSL Ubuntu veya Linux kabuğunda OS Dashboard deposunun kökünden çalıştır. İki Dockerflare imajı (`dockerflare/web:local` ve `dockerflare/checks:local`) ile denetim dışa aktarıcısını içeren `os-dashboard/workshop:local` önceden hazırlanmış olmalı. `checks` tabanı Dockerflare deposunun `source` derleme hedefidir.

```sh
df=examples/cloudflare-os/workshop-audit/Dockerfile
docker buildx build --builder default --load -f "$df" --target model -t os-dashboard/workshop-audit-model:local .
docker buildx build --builder default --load -f "$df" --target ai-gateway -t os-dashboard/workshop-audit-ai-gateway:local .
docker buildx build --builder default --load -f "$df" --target checks -t os-dashboard/workshop-audit-checks:local .
bash examples/cloudflare-os/workshop-audit/run.sh
```

Sunucu kurulum rehberini izlediysen Workshop imajının etiketi `dockerflare/workshop:local` olur. Bu durumda yukarıdaki üç örnek imajdan önce OS Dashboard klasöründe `docker build --target source -t dockerflare/checks:local ../dockerflare-os` çalıştır. Son satırda `OS_DASHBOARD_AUDIT_WORKSHOP_IMAGE=dockerflare/workshop:local bash examples/cloudflare-os/workshop-audit/run.sh` kullan.

Betik her servisi ayrı `docker run` komutuyla başlatır. İç Docker ağında bir host portu yayımlanmaz. Workshop’un model adresi, izin listesindeki adres ve `OS_DASHBOARD_AI_GATEWAY_ROOT` birebir `http://ai-gateway:4322/v1` olur. AI Gateway istemci anahtarını geçici bir birimde üretir.

## Kanıt ve saklama

Çalıştırıcı önce Workshop RPC yanıtından sohbet sahibini, araç adlarını, bağlantı kartını ve reddeden kullanıcıyı doğrular. Sonra Workshop içinde `node /os-dashboard-export/export.mjs --once` çalıştırır. Ayrı bir denetim dört model turunu dört gerçek AI Gateway isteği ve kalıcı maliyet kaydıyla istek kimlikleri üzerinden eşleştirir. Herhangi bir adım başarısızsa çıkış kodu sıfırdan farklı olur.

Başarılı koşunun son satırındaki `Metadata volume` iki dosya içerir.

| Dosya | İçerik |
| --- | --- |
| `workshop.sqlite` | Sohbet başlangıcı, aktör, araç ve onay olayları, model istek kimlikleri |
| `ai-gateway.sqlite` | Aynı dört istek için model adı, HTTP durumu, süre, token sayıları, örnek tarife ve hesaplanan tutar |

Bu birimi OS Dashboard panelinin örnek veri kaynağına salt okunur bağlayabilirsin. Betik her iki dosyanın da salt okunur mount üzerinden UID 1000 ile açıldığını kontrol eder. Ham Workshop deposu, auth birimi, geçici AI Gateway ve bütün örnek konteynerleri koşu sonunda kaldırılır. Sonuç birimi, silmek istediğinde `docker volume rm <Metadata-volume-adı>` çalıştırana kadar kalır.
