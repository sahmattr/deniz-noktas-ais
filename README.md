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

Bu klasör ana projedeki `ais_depo.py` ile üretilir, elle değiştirme.
