# Deniz Noktası — AIS anlık görüntüsü

Türkiye denizleri için her 20 dakikada bir alınan AIS anlık görüntüsü.
`ais-veri` dalındaki `ais.json` tek dosyadır ve her turda baştan yazılır.

    https://raw.githubusercontent.com/sahmattr/deniz-noktas-ais/ais-veri/ais.json

Veri kaynağı [aisstream.io](https://aisstream.io). Burada yalnız halka açık AIS
yayını ve onu toplayan betik var; uygulamanın kendisi ayrı bir depoda.
Kişisel kullanım için; resmî seyir kaynağı değildir.

## Kurulum

1. aisstream.io → Create API key
2. Settings → Secrets and variables → Actions → `AIS_ANAHTAR`
3. Actions → "AIS anlık görüntü" → Run workflow

## İkinci kaynak (isteğe bağlı)

aisstream topluluk beslemeli: gönüllü alıcının olduğu yerde kalın, olmadığı
yerde ince. 18 Kasım 2026 ölçümünde 504 geminin 300'ü Egeydi, Marmara'da 8
gemi vardı. Bağımsız bir beslemenin aynı boşluklara düşmesi gerekmez, bu
yüzden ikinci kaynak eklenebilir:

1. pelyr.com → ücretsiz hesap → API anahtarı (Free planı ticari olmayan
   kullanım için; açık kaynak ve araştırma için başvuruyla Community planı var)
2. Settings → Secrets and variables → Actions → `PELYR_ANAHTAR`

Secret tanımlı değilse Pelyr sessizce atlanır, tur aisstream ile tamamlanır.
İki liste MMSI'ye göre harmanlanır: aynı gemide yeni mevki kazanır, bir
kaynakta olmayan alan (ad, tip, varış, boy) diğerinden korunur.

Pelyr beş deniz kutusuyla sorgulanır (Marmara ve Boğazlar, Karadeniz, Ege,
Doğu Akdeniz, Güneybatı Akdeniz). Sebep ölçülmüş: tek kutu Free planın
1000 gemi sınırına dayanıyordu ve kutunun büyük kısmı karaydı. Limanlar ve
boğazlar kutuların içinde, Anadolu içi değil. Bir kutu `truncated` dönerse
log onu KIRPIK diye yazar: o kutuyu bölmek daha çok temas verir.

Bu klasör ana projedeki `ais_depo.py` ile üretilir, elle değiştirme.
