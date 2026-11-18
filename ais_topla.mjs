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

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/* Türkiye denizleri: uygulamanın batimetri kutusuyla aynı (23–42° D, 31–43,6° K) */
export const KUTU = { guney: 31.0, kuzey: 43.6, bati: 23.0, dogu: 42.0 };
export const SURE = 90;            /* saniye dinlenir */
export const EN_COK = 6000;        /* dosya şişmesin */

/* aisstream mesajlarını kayda çevirir. Ağdan bağımsız — sınamalar bunu doğrudan çağırır.

   Kaydın saati MEVKİNİN saatidir: statik mesaj (ad, tip, varış) mevki taşımadığı için
   saati ileri ÇEKMEZ. Çekseydi uygulama hayaleti olduğundan taze sanır ve ileri taşımayı
   olduğundan kısa hesaplardı. */
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
    const p = govde.PositionReport || govde.positionReport;
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
    }
    const s = govde.ShipStaticData || govde.shipStaticData;
    if (s) {
      if (s.Name) k.a = String(s.Name).trim().replace(/@+$/, "").slice(0, 24);
      if (Number.isFinite(+s.Type)) k.tp = +s.Type;
      if (s.Destination) k.vr = String(s.Destination).trim().replace(/@+$/, "").slice(0, 20);
      const dim = s.Dimension || {};
      const boy = (+dim.A || 0) + (+dim.B || 0);        /* baş + kıç: gemi boyu */
      if (boy > 0) k.boy = Math.round(boy);
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
      FilterMessageTypes: ["PositionReport", "ShipStaticData"]
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

/* Uygulamanın indirdiği dosyanın biçimi. Sürüm alanı: biçim değişirse eski uygulama
   sessizce yanlış okumasın. */
export function goruntu(gemiler, kutu = KUTU, simdi) {
  return { surum: 1, t: Number.isFinite(simdi) ? simdi : Date.now(), kutu,
           kaynak: "aisstream.io", gemiler };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
    process.argv[1]?.endsWith("ais_topla.mjs")) {
  const cikti = process.argv[2] || "cikti/ais.json";
  const anahtar = process.env.AIS_ANAHTAR;
  if (!anahtar) { console.error("AIS_ANAHTAR ortam değişkeni yok"); process.exit(1); }
  try {
    const ham = await topla(anahtar, KUTU, SURE, n => console.log(`  ${n} mesaj…`));
    const gemiler = ayikla(ham);
    mkdirSync(dirname(cikti), { recursive: true });
    writeFileSync(cikti, JSON.stringify(goruntu(gemiler)), "utf8");
    console.log(`${ham.length} mesaj → ${gemiler.length} gemi → ${cikti}`);
    if (!gemiler.length) process.exit(2);          /* boş görüntü yayınlanmasın */
  } catch (e) {
    console.error("olmadı:", e.message);
    if (e.tani) console.error("  teşhis:", JSON.stringify(e.tani));
    process.exit(1);
  }
}
