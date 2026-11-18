/* AIS anlık görüntü toplayıcı — SUNUCU tarafı.

   Neden sunucuda: aisstream'in kendi belgesi "Direct browser connections are not
   permitted; proxy only the information your clients need from your own server" ve
   "The API key belongs in a server-side environment variable" diyor. Ayrıca hesap
   başına yalnız 3 eşzamanlı abonelik var — 15 kişi doğrudan bağlanamaz. Bu betik tek
   bağlantıyı kurar, bir anlık görüntü yazar; uygulama o dosyayı indirir. Anahtar
   hiçbir cihaza girmez.

   Çalıştırma (GitHub Actions ya da elle):
     AIS_ANAHTAR=... node ais_topla.mjs cikti/ais.json

   Node 22+ gerekiyor (global WebSocket). Dış paket kullanmıyor. */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { pelyrCekHepsi, KUTULAR, SIRALAR } from "./ais_pelyr.mjs";

/* Türkiye denizleri: uygulamanın batimetri kutusuyla aynı (23–42° D, 31–43,6° K) */
export const KUTU = { guney: 31.0, kuzey: 43.6, bati: 23.0, dogu: 42.0 };
/* Dinleme penceresi. Kisa tutmak gemi kaybettiriyor: seyir halindeki A sinifi
   2-10 saniyede bir yayin yapar ama DEMIRLI ya da bagli gemi 3 dakikada bir,
   B sinifi yavasken yine 3 dakikada bir. 90 saniyeyle limanlar ve demir sahalari
   bos gorunuyordu. 5 dakika bir tam yayin donemini rahat kapsiyor. */
export const SURE = 300;           /* saniye dinlenir */

/* Hangi mesaj tipleri. PositionReport yalnizca AIS 1/2/3, yani A SINIFI gemiler.
   B sinifi (18/19) ayri tiplerle gelir ve Turkiye kiyilarinda trafigin buyuk kismi
   odur. StaticDataReport (24) B sinifinin adini ve tipini tasir; o olmadan B sinifi
   gemiler haritada adsiz kalir. Seyir yardimcilari (samandira, fener) bilerek disarida:
   onlar gemi degil. */
export const TIPLER = ["PositionReport", "ShipStaticData",
                       "StandardClassBPositionReport", "ExtendedClassBPositionReport",
                       "StaticDataReport"];
export const EN_COK = 6000;        /* dosya şişmesin */
/* Kaydın ömrü: uygulamadaki AIS_OMUR_SAAT ile aynı olmalı, yoksa indirilen dosyada
   uygulamanın hiç çizmeyeceği kayıtlar taşınır. */
export const OMUR_SAAT = 6;

/* aisstream mesajlarını kayda çevirir. Ağdan bağımsız — sınamalar bunu doğrudan çağırır.

   Kaydın saati MEVKİNİN saatidir: statik mesaj (ad, tip, varış) mevki taşımadığı için
   saati ileri ÇEKMEZ. Çekseydi uygulama hayaleti olduğundan taze sanır ve ileri taşımayı
   olduğundan kısa hesaplardı. */
/* AIS metin alanlari sabit uzunluktadir ve sonu "@" ile doldurulur. */
function adTemizle(s, enCok) {
  return String(s).trim().replace(/@+$/, "").trim().slice(0, enCok);
}

/* Boyut dort parca gelir: A bastan antene, B antenden kica, C ve D iki bordaya.
   Gemi boyu A + B, eni C + D. */
function boyHesapla(dim) {
  const boy = (+(dim && dim.A) || 0) + (+(dim && dim.B) || 0);
  return boy > 0 ? Math.round(boy) : 0;
}

function enHesapla(dim) {
  const en = (+(dim && dim.C) || 0) + (+(dim && dim.D) || 0);
  return en > 0 ? Math.round(en) : 0;
}

/* Su cekimi metre. AIS'te ust sinir 25,5 m; disindaki deger bozuk sayilir. */
function cekimAl(d) {
  const v = +d;
  return Number.isFinite(v) && v > 0 && v <= 25.5 ? +v.toFixed(1) : 0;
}

/* Seyir durumu 0-15. 15 "tanimsiz" demek, bilgi tasimaz; onu almiyoruz. */
function seyirAl(d) {
  const v = +d;
  return Number.isFinite(v) && v >= 0 && v <= 14 ? Math.round(v) : -1;
}

export function ayikla(mesajlar, alim) {
  const al = Number.isFinite(alim) ? alim : Date.now();
  const harita = new Map();
  for (const m of (mesajlar || [])) {
    if (!m || typeof m !== "object") continue;
    const md = m.MetaData || m.metadata || {};
    const govde = m.Message || m.message || {};
    const mmsi = +(md.MMSI || md.mmsi || 0);
    if (!mmsi) continue;
    const k = harita.get(mmsi) || { m: mmsi };
    const zaman = Date.parse(String(md.time_utc || md.TimeUtc || "")
      .replace(" +0000 UTC", "Z").replace(" ", "T"));
    /* Mevki tasiyan her tip: A sinifi (1/2/3) ve B sinifi (18/19). */
    const p = govde.PositionReport || govde.positionReport
      || govde.StandardClassBPositionReport || govde.standardClassBPositionReport
      || govde.ExtendedClassBPositionReport || govde.extendedClassBPositionReport;
    if (p) {
      k.t = Number.isFinite(zaman) ? zaman : al;
      const la = +(md.latitude != null ? md.latitude : p.Latitude);
      const lo = +(md.longitude != null ? md.longitude : p.Longitude);
      if (Number.isFinite(la) && Number.isFinite(lo) &&
          Math.abs(la) <= 90 && Math.abs(lo) <= 180 && (la || lo)) { k.la = la; k.lo = lo; }
      const cog = +p.Cog, sog = +p.Sog, hdg = +p.TrueHeading;
      if (Number.isFinite(cog) && cog >= 0 && cog < 360) k.cog = +cog.toFixed(1);
      if (Number.isFinite(sog) && sog >= 0 && sog < 102.3) k.sog = +sog.toFixed(1);
      if (Number.isFinite(hdg) && hdg >= 0 && hdg < 360) k.hdg = Math.round(hdg);
      /* Seyir durumu yalniz A sinifi mevki mesajinda var (1/2/3): demirli mi,
         yol aliyor mu, baliklikla mesgul mu. B sinifi bunu hic tasimaz. */
      const ns = seyirAl(p.NavigationalStatus);
      if (ns >= 0) k.ns = ns;
      /* ExtendedClassBPositionReport ad, tip ve boyut da tasir (19 numarali mesaj) */
      if (p.Name) k.a = adTemizle(p.Name, 24);
      if (Number.isFinite(+p.Type) && +p.Type > 0) k.tp = +p.Type;
      const boyE = boyHesapla(p.Dimension);
      if (boyE) k.boy = boyE;
      const enE = enHesapla(p.Dimension);
      if (enE) k.en = enE;
    }
    const s = govde.ShipStaticData || govde.shipStaticData;
    if (s) {
      if (s.Name) k.a = adTemizle(s.Name, 24);
      if (Number.isFinite(+s.Type)) k.tp = +s.Type;
      if (s.Destination) k.vr = adTemizle(s.Destination, 20);
      const boy = boyHesapla(s.Dimension);
      if (boy) k.boy = boy;
      const en = enHesapla(s.Dimension);
      if (en) k.en = en;
      /* Cagri adi VHF'te ise yarar; IMO govdeye ait ve MMSI gibi degismez. */
      if (s.CallSign) k.cs = adTemizle(s.CallSign, 10);
      const imo = +s.ImoNumber;
      if (Number.isFinite(imo) && imo > 0) k.imo = Math.round(imo);
      const dr = cekimAl(s.MaximumStaticDraught);
      if (dr) k.dr = dr;
    }
    /* StaticDataReport (24): B sinifinin statik bilgisi, iki parca halinde gelir.
       A parcasi ad, B parcasi tip ve boyut tasir; ikisi ayri mesajlarda gelebilir. */
    const sd = govde.StaticDataReport || govde.staticDataReport;
    if (sd) {
      const pA = sd.ReportA || sd.reportA || {};
      const pB = sd.ReportB || sd.reportB || {};
      if (pA.Name) k.a = adTemizle(pA.Name, 24);
      if (Number.isFinite(+pB.ShipType) && +pB.ShipType > 0) k.tp = +pB.ShipType;
      const boyB = boyHesapla(pB.Dimension);
      if (boyB) k.boy = boyB;
      const enB = enHesapla(pB.Dimension);
      if (enB) k.en = enB;
      if (pB.CallSign) k.cs = adTemizle(pB.CallSign, 10);
    }
    const ad = md.ShipName || md.shipName;
    if (ad && !k.a) k.a = String(ad).trim().replace(/@+$/, "").slice(0, 24);
    harita.set(mmsi, k);
  }
  const cikti = [];
  for (const k of harita.values()) {
    if (!Number.isFinite(k.la) || !Number.isFinite(k.lo)) continue;   /* mevkisiz kayıt işe yaramaz */
    k.la = +k.la.toFixed(5); k.lo = +k.lo.toFixed(5);
    cikti.push(k);
  }
  cikti.sort((a, b) => (b.t || 0) - (a.t || 0));
  return cikti.slice(0, EN_COK);
}

/* Sunucu UTF-8 JSON'u İKİLİ çerçevede gönderiyor (belgesinde: "binary frames containing
   UTF-8 JSON, so decode the bytes before parsing"). Doğrudan JSON.parse(e.data) demek
   sessizce her mesajı düşürür — bu tam olarak "süre doldu, mesaj gelmedi" gibi görünür.
   Ağdan bağımsız tutuldu ki sınama Blob/ArrayBuffer/metin yollarını doğrudan deneyebilsin. */
export function cerceveCoz(veri) {
  if (typeof veri === "string") return veri;
  if (veri instanceof Uint8Array) return new TextDecoder().decode(veri);
  if (veri instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(veri));
  if (ArrayBuffer.isView(veri)) return new TextDecoder().decode(new Uint8Array(veri.buffer, veri.byteOffset, veri.byteLength));
  return null;                       /* Blob ve bilinmeyen: çağıran sayar ve söyler */
}

/* Tek bağlantı: abone ol, SURE kadar dinle, kapat. */
export function topla(anahtar, kutu = KUTU, sure = SURE, ilerle) {
  return new Promise((coz, red) => {
    if (!anahtar) return red(new Error("AIS_ANAHTAR yok"));
    const mesaj = [];
    /* Teşhis: bir daha "mesaj gelmedi" deyip nedenini saklamasın. */
    const tani = { cerceve: 0, cozulemedi: 0, onay: null, sonCerceve: "", kapanis: null };
    let ws, bitti = false, zamanlayici = null;
    const kapat = (hata) => {
      if (bitti) return; bitti = true;
      clearTimeout(zamanlayici);
      try { ws && ws.close(); } catch (e) { }
      if (hata && !mesaj.length) { hata.tani = tani; red(hata); } else coz(mesaj);
    };
    ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
    /* Blob yerine ArrayBuffer: TextDecoder eşzamanlı çalışsın, çerçeve kaybolmasın. */
    try { ws.binaryType = "arraybuffer"; } catch (e) { }
    zamanlayici = setTimeout(() => {
      /* Süre dolması dinleme penceresinin NORMAL sonu. Çerçeve geldiyse elde ne varsa onunla
         dönülür; hiç gelmediyse sebebi teşhisle söylenir. */
      if (tani.cerceve) return kapat(null);
      kapat(new Error("süre doldu, hiç çerçeve gelmedi — abonelik geçersiz olabilir "
        + "(anahtar, kutu biçimi ya da 3 saniyelik abonelik süresi)"));
    }, sure * 1000);
    ws.onopen = () => ws.send(JSON.stringify({
      APIKey: anahtar,
      BoundingBoxes: [[[kutu.guney, kutu.bati], [kutu.kuzey, kutu.dogu]]],
      FilterMessageTypes: TIPLER
    }));
    ws.onmessage = (e) => {
      tani.cerceve++;
      const metin = cerceveCoz(e.data);
      if (metin == null) {
        tani.cozulemedi++;
        if (tani.cozulemedi === 1)
          console.error(`  UYARI: çerçeve çözülemedi (tür ${Object.prototype.toString.call(e.data)})`);
        return;
      }
      let o;
      try { o = JSON.parse(metin); }
      catch (x) {
        tani.cozulemedi++;
        if (tani.cozulemedi === 1) { tani.sonCerceve = metin.slice(0, 200); console.error(`  UYARI: JSON değil: ${tani.sonCerceve}`); }
        return;
      }
      if (o && (o.error || o.Error)) return kapat(new Error(String(o.error || o.Error)));
      const tip = o && (o.MessageType || o.messageType);
      if (tip === "SubscriptionConfirmation" || (o && o.SubscriptionConfirmation)) {
        tani.onay = o; console.log("  abonelik onaylandı"); return;
      }
      mesaj.push(o);
      if (ilerle && mesaj.length % 500 === 0) ilerle(mesaj.length);
    };
    ws.onerror = () => kapat(new Error("bağlantı hatası (anahtar geçersiz olabilir)"));
    ws.onclose = (e) => {
      tani.kapanis = { kod: e && e.code, sebep: (e && e.reason) || "" };
      kapat(new Error(`bağlantı kapandı (kod ${tani.kapanis.kod}${tani.kapanis.sebep ? ", " + tani.kapanis.sebep : ""})`
        + `, çerçeve: ${tani.cerceve}, abonelik onayı: ${tani.onay ? "var" : "yok"}`));
    };
  });
}

/* Önceki anlık görüntüyle birleştirir.

   Neden: tek pencere sahanın tamamını göstermez. Demirli gemi 3 dakikada bir, B sınıfı
   yavaşken yine 3 dakikada bir yayın yapar; beş dakikada susmuş olan gemi kaybolur ve
   bir sonraki turda geri gelir — liste titrer. Uygulama kaydı yaşına göre ileri taşıyıp
   belirsizlik halkası çizdiği ve OMUR_SAAT'ten eskisini hiç çizmediği için eski kaydı
   TAŞIMAK kaybetmekten iyidir: kullanıcı hem gemiyi görür hem ne kadar eski olduğunu.

   Kural: aynı MMSI'de yeni kayıt kazanır, ama yeni kayıtta OLMAYAN alanlar (ad, tip,
   varış, boy) eskisinden korunur — mevki mesajı bunları taşımaz, statik mesaj seyrek
   gelir. Ömrü geçen kayıt düşer. */
export function birlestir(eski, yeni, simdi, omurSaat = OMUR_SAAT) {
  const an = Number.isFinite(simdi) ? simdi : Date.now();
  const sinir = an - omurSaat * 3600e3;
  const harita = new Map();
  for (const k of (eski || [])) {
    if (!k || !k.m || !Number.isFinite(k.t) || k.t < sinir) continue;
    harita.set(k.m, Object.assign({}, k));
  }
  for (const k of (yeni || [])) {
    if (!k || !k.m || !Number.isFinite(k.t) || k.t < sinir) continue;
    const v = harita.get(k.m);
    if (!v) { harita.set(k.m, Object.assign({}, k)); continue; }
    /* Eskisi daha yeniyse mevkisi korunur; her hâlde eksik alanlar tamamlanır. */
    harita.set(k.m, k.t >= v.t ? Object.assign({}, v, k) : Object.assign({}, k, v));
  }
  const cikti = [...harita.values()].sort((a, b) => (b.t || 0) - (a.t || 0));
  return cikti.slice(0, EN_COK);
}

/* Uygulamanın indirdiği dosyanın biçimi. Sürüm alanı: biçim değişirse eski uygulama
   sessizce yanlış okumasın. */
export function goruntu(gemiler, kutu = KUTU, simdi, kaynak = "aisstream.io") {
  return { surum: 1, t: Number.isFinite(simdi) ? simdi : Date.now(), kutu,
           kaynak, gemiler };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
    process.argv[1]?.endsWith("ais_topla.mjs")) {
  const cikti = process.argv[2] || "cikti/ais.json";
  const anahtar = process.env.AIS_ANAHTAR;
  if (!anahtar) { console.error("AIS_ANAHTAR ortam değişkeni yok"); process.exit(1); }
  try {
    const ham = await topla(anahtar, KUTU, SURE, n => console.log(`  ${n} mesaj…`));
    let gemiler = ayikla(ham);
    const yeniSayi = gemiler.length;
    /* İkinci kaynak. Anahtar yoksa atlanır: Pelyr isteğe bağlı, aisstream tek başına
       çalışmaya devam eder. Pelyr'in çökmesi ya da bütçesinin dolması turu
       düşürmemeli — bu yüzden hatası yutuluyor, yalnız loga yazılıyor. */
    const kaynaklar = ["aisstream.io"];
    const pAnahtar = process.env.PELYR_ANAHTAR;
    if (pAnahtar) {
      try {
        /* Tek kutu 1000'lik sinira dayaniyordu (995 ve 979 dondu): kutuda daha
           fazla gemi vardi ama kirpiliyordu. Bes deniz kutusu hem siniri hem de
           karaya harcanan istegi cozuyor. */
        const p = await pelyrCekHepsi(pAnahtar, KUTULAR, 1000, fetch, m => console.log(m));
        if (p.gemiler.length) {
          const once = gemiler.length;
          gemiler = birlestir(gemiler, p.gemiler);
          kaynaklar.push("pelyr.com");
          console.log(`  Pelyr [${SIRALAR[p.sira].ad}] ${p.dokum.length} kutu: ` +
                      `${p.gemiler.length} tekil gemi → ${once} + ${p.gemiler.length} ` +
                      `harmanlandı → ${gemiler.length}`);
          const kirpik = p.dokum.filter(x => x.kirpik).map(x => x.ad);
          if (kirpik.length) console.log(`  DİKKAT kırpılan kutu: ${kirpik.join(", ")} ` +
                                         `— bu kutuyu bölmek daha çok temas verir`);
          /* Bütçe bitmesi turu düşürmüyor: alınan kutular kullanılıyor, kalanlar
             bir sonraki turda sıraya geçiyor (6 saatlik birikme bunu kapatıyor). */
          if (p.butce) console.log(`  ${p.dokum.length}/${KUTULAR.length} kutu alındı, ` +
                                   `${p.butce} — kalan kutular sonraki turda`);
        } else {
          console.log("  Pelyr: gemi gelmedi, yalnız aisstream kullanılıyor");
        }
      } catch (h) {
        console.log(`  Pelyr atlandı (${h.message}), yalnız aisstream kullanılıyor`);
      }
    }
    /* Önceki görüntü varsa birleştir: iş akışı onu veri dalından çekip veriyor. */
    const onceki = process.argv[3] || process.env.AIS_ONCEKI;
    if (onceki) {
      try {
        const o = JSON.parse(readFileSync(onceki, "utf8"));
        const eski = Array.isArray(o && o.gemiler) ? o.gemiler : [];
        gemiler = birlestir(eski, gemiler);
        console.log(`  önceki görüntü: ${eski.length} gemi → birleşik ${gemiler.length}`);
      } catch (h) {
        console.log(`  önceki görüntü okunamadı (${h.message}), yalnız bu tur yazılıyor`);
      }
    }
    mkdirSync(dirname(cikti), { recursive: true });
    writeFileSync(cikti, JSON.stringify(goruntu(gemiler, KUTU, undefined, kaynaklar.join(" + "))), "utf8");
    console.log(`${ham.length} mesaj → ${yeniSayi} yeni gemi → ${gemiler.length} toplam → ${cikti}`);
    if (!gemiler.length) process.exit(2);          /* boş görüntü yayınlanmasın */
  } catch (e) {
    console.error("olmadı:", e.message);
    if (e.tani) console.error("  teşhis:", JSON.stringify(e.tani));
    process.exit(1);
  }
}
