/* Pelyr — İKİNCİ AIS kaynağı. SUNUCU tarafı.

   Neden ikinci kaynak: aisstream topluluk beslemeli, gönüllü alıcıların olduğu yerde
   kalın, olmadığı yerde ince. 18 Kasım 2026 ölçümünde 504 geminin 300'ü Egeydi,
   Marmara'da yalnız 8 gemi vardı — İstanbul Boğazı için gerçek dışı. Süzgeç değil
   kapsama sorunu: kaynakta olmayan veriyi toplayıcı üretemez. Pelyr bağımsız bir
   besleme olduğu için aynı boşluklara düşmesi gerekmez; iki liste MMSI'ye göre
   birleşince eksikler kapanır.

   Anahtar: pelyr.com'da ücretsiz hesapla alınır, Free planı ticari olmayan kullanım
   için. Pelyr'in kendi belgesi anahtarın sunucuda kalmasını, tarayıcı koduna ve URL'e
   girmemesini şart koşuyor — bu yüzden aisstream ile aynı yol: anahtar yalnız
   ortam değişkeni, uygulamaya hiç girmez.

   Çalıştırma: PELYR_ANAHTAR tanımlıysa ais_topla.mjs bunu kendiliğinden çağırır.
   Anahtar yoksa sessizce atlanır — aisstream tek başına çalışmaya devam eder. */

const TEMEL = "https://api.pelyr.com/v1/vessels";
/* Free planı max'i 1000'de sınırlıyor; daha büyük istek sessizce kırpılıyor. */
export const EN_COK_ISTEK = 1000;
/* `low` = mevki gemiye uymuyor (sıçrama ya da geçersiz MMSI). Onu almıyoruz;
   unknown/medium/high kalıyor, çünkü "unknown" yalnız kıyaslanacak önceki mevki
   olmadığı anlamına geliyor — yeni görülen gemilerin tamamı öyle. */
const ELE = new Set(["low"]);

/* bbox'ın dört sayısının sırası belgede örneklenmemiş. İki yaygın sıra var:
   GeoJSON (batı,güney,doğu,kuzey) ve enlem-önce (güney,batı,kuzey,doğu). Yanlış sıra
   hata vermez — Türkiye kutusu ters çevrildiğinde de geçerli bir kutu çıkıyor, ama
   karada kalıyor ve boş dönüyor. Bu yüzden ikisini de deneyip çok gemi getireni
   seçiyoruz; bir turda iki istek, sonucu loga yazılıyor. */
export const SIRALAR = [
  { ad: "GeoJSON (batı,güney,doğu,kuzey)", yap: k => [k.bati, k.guney, k.dogu, k.kuzey] },
  { ad: "enlem önce (güney,batı,kuzey,doğu)", yap: k => [k.guney, k.bati, k.kuzey, k.dogu] },
];

/* Denizlere oturan kutular. Tek kutu (23-42 D, 31-43,6 K) Anadolu'nun tamamini,
   Suriye-Irak'i ve Bulgaristan'i iceriyordu: hem istek hem de 1000'lik gemi
   siniri karaya harcaniyordu. Bu bes kutunun BIRLESIMI aynı denizleri kapsiyor,
   karalari atliyor. Ustuste binen kenarlar zararsiz: harmanlama MMSI anahtarli.

   Limanlar ve bogazlar bilerek iceride -- Istanbul ve Canakkale bogazlari, Izmit
   ve Saros korfezleri, Iskenderun ve Mersin limanlari kiyi kutularinin icinde. */
export const KUTULAR = [
  /* Bogazlar ve Marmara: en yogun yer, kendi kutusunu hak ediyor. Istanbul ve
     Canakkale bogazlari, Izmit korfezi, Gelibolu iceride. */
  { ad: "Marmara ve Boğazlar", guney: 40.0, kuzey: 41.4, bati: 26.0, dogu: 30.2 },
  { ad: "Karadeniz", guney: 40.9, kuzey: 43.6, bati: 27.3, dogu: 42.0 },
  /* Ege tek kutuyken 928 gemi dondu ve `truncated` isaretliydi: 1000'lik sinira
     dayaniyordu. 38,3 enleminde ikiye bolundu. Ustuste binen serit zararsiz --
     harmanlama MMSI anahtarli. */
  { ad: "Kuzey Ege", guney: 38.0, kuzey: 41.0, bati: 23.0, dogu: 28.0 },
  { ad: "Güney Ege", guney: 34.8, kuzey: 38.3, bati: 23.0, dogu: 28.6 },
  /* Turkiye guney kiyisi ve Kibris: Fethiye'den Iskenderun'a. */
  { ad: "Doğu Akdeniz", guney: 31.0, kuzey: 37.0, bati: 27.0, dogu: 36.6 },
  /* Girit guneyi: eski kutunun geri kalan acik denizi. Olculdu: 2 gemi. Tam bir
     istek ve ~57 saniye bekleme harciyor, bu yuzden `son: true` ile sıranin
     sonuna sabit -- bekleme butcesi biterse kaybedilecek en ucuz kutu bu. Kutu
     yine duruyor: uygulamanin batimetri kutusunda o deniz de var. */
  { ad: "Güneybatı Akdeniz", guney: 31.0, kuzey: 34.8, bati: 23.0, dogu: 27.0, son: true },
];

export function kutuMetni(kutu, sira) {
  return SIRALAR[sira].yap(kutu).map(n => Number(n).toFixed(4)).join(",");
}

/* Pelyr kaydını ais_topla.mjs'in kayıt biçimine çevirir: {m,t,la,lo,cog,sog,hdg,a,tp,boy,vr}.
   Böylece birlestir() iki kaynağı hiç ayırt etmeden harmanlıyor. Ağdan bağımsız —
   sınamalar bunu doğrudan çağırır. */
export function pelyrAyikla(veri, alim) {
  const al = Number.isFinite(alim) ? alim : Date.now();
  const liste = Array.isArray(veri && veri.vessels) ? veri.vessels : [];
  const cikti = [];
  for (const g of liste) {
    if (!g || typeof g !== "object") continue;
    const m = Number(g.mmsi);
    if (!Number.isFinite(m) || m <= 0) continue;
    const p = g.position;
    if (!p || typeof p !== "object") continue;                 /* mevkisiz kayıt gemi üretmez */
    if (ELE.has(String(p.plausibility || ""))) continue;
    const la = Number(p.lat), lo = Number(p.lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    if (la < -90 || la > 90 || lo < -180 || lo > 180) continue;
    /* Saat MEVKİNİN saati: statik mesajın saati kaydı tazeleştirmemeli, yoksa
       uygulama hayaleti olduğundan yeni sanıp ileri taşımayı kısa hesaplar. */
    const t = Date.parse(p.ts);
    const k = { m, t: Number.isFinite(t) ? t : al, la, lo };
    const cog = Number(p.cog), sog = Number(p.sog), hdg = Number(p.heading);
    if (Number.isFinite(cog) && cog >= 0 && cog < 360) k.cog = Math.round(cog * 10) / 10;
    if (Number.isFinite(sog) && sog >= 0) k.sog = Math.round(sog * 10) / 10;
    /* 511 = "pruva yok" demek, geçerli bir açı değil. */
    if (Number.isFinite(hdg) && hdg >= 0 && hdg < 360) k.hdg = Math.round(hdg);
    /* Seyir durumu: demirli / yol alıyor / balıkçılıkla meşgul… 15 "tanımsız" demek. */
    const ns = Number(p.nav_status);
    if (Number.isFinite(ns) && ns >= 0 && ns <= 14) k.ns = Math.round(ns);
    const s = g.static;
    if (s && typeof s === "object") {
      const ad = String(s.name == null ? "" : s.name).trim().replace(/@+$/, "").trim();
      if (ad) k.a = ad.slice(0, 20);
      const tp = Number(s.type);
      if (Number.isFinite(tp) && tp > 0) k.tp = tp;
      const boy = Number(s.length);
      if (Number.isFinite(boy) && boy > 0) k.boy = Math.round(boy);
      const vr = String(s.dest == null ? "" : s.dest).trim().replace(/@+$/, "").trim();
      if (vr) k.vr = vr.slice(0, 20);
      const en = Number(s.beam);
      if (Number.isFinite(en) && en > 0) k.en = Math.round(en);
      /* Çağrı adı VHF'te işe yarar; IMO gövdeye ait ve MMSI gibi değişmez. */
      const cs = String(s.callsign == null ? "" : s.callsign).trim().replace(/@+$/, "").trim();
      if (cs) k.cs = cs.slice(0, 10);
      const imo = Number(s.imo);
      if (Number.isFinite(imo) && imo > 0) k.imo = Math.round(imo);
      const dr = Number(s.draught);
      if (Number.isFinite(dr) && dr > 0 && dr <= 25.5) k.dr = Math.round(dr * 10) / 10;
    }
    cikti.push(k);
  }
  return cikti.sort((a, b) => (b.t || 0) - (a.t || 0));
}

/* Tek istek. 304 gelmez (If-None-Match göndermiyoruz); 429 istek bütçesinin
   bittiğini söyler ve bu bir arıza değil, o turda Pelyr atlanır. */
export async function pelyrIstek(anahtar, kutu, sira, enCok = EN_COK_ISTEK, getir = fetch) {
  const adres = `${TEMEL}?bbox=${encodeURIComponent(kutuMetni(kutu, sira))}&max=${enCok}`;
  const y = await getir(adres, {
    headers: { Authorization: `Bearer ${anahtar}`, Accept: "application/json" },
  });
  if (y.status === 429) {
    /* Hangi sınıra çarptığımızı loga yazabilmek için başlıkları taşıyoruz:
       bütçenin gerçek büyüklüğünü ancak buradan öğreniyoruz. */
    const bas = [];
    for (const ad of ["retry-after", "ratelimit-limit", "ratelimit-remaining",
                      "ratelimit-reset", "x-ratelimit-limit", "x-ratelimit-remaining"]) {
      const v = y.headers && y.headers.get ? y.headers.get(ad) : null;
      if (v != null) bas.push(`${ad}=${v}`);
    }
    const h = new Error("Pelyr istek bütçesi doldu (429)"
      + (bas.length ? " · " + bas.join(" ") : ""));
    h.butce = true;
    /* Sunucunun söylediği bekleme. Ölçülen değer 53 saniyeydi: bu bir günlük
       kota değil, kısa pencereli bir hız sınırı — beklemeye değer. */
    const ra = Number(y.headers && y.headers.get ? y.headers.get("retry-after") : NaN);
    if (Number.isFinite(ra) && ra > 0) h.bekleSn = ra;
    throw h;
  }
  if (!y.ok) throw new Error(`Pelyr ${y.status}`);
  return await y.json();
}

/* Tek kutu: kayitlar ve kirpilma bayragi. `truncated` gelirse o kutuda daha fazla
   gemi var ve secim alana dagitilmis -- cozum kutuyu bolmek, max'i buyutmek degil. */
export async function pelyrKutu(anahtar, kutu, sira, enCok = EN_COK_ISTEK, getir = fetch) {
  const veri = await pelyrIstek(anahtar, kutu, sira, enCok, getir);
  return { gemiler: pelyrAyikla(veri), kirpik: !!(veri && veri.truncated) };
}

/* Butun kutular. bbox sirasi YALNIZ ilk kutuda aranir, bulunan sira otekilerde
   dogrudan kullanilir: her kutuda iki kez denemek istek butcesini bosa harcar.
   Harmanlama burada MMSI anahtarli yapiliyor -- ais_topla.mjs'in birlestir()'ini
   cagirmak dairesel ice alma olurdu. */
/* 429'da en fazla bu kadar saniye beklenir (toplam, butun kutular icin). Alti
   kutu bes bekleme demek ve olculen pencere ~57 saniye: 240 saniye hepsine
   yetiyor. Is akisinin 15 dakika siniri var, dinleme 5 dakika suruyor; en kotu
   durumda toplam ~10 dakika. */
export const EN_COK_BEKLEME = 240;

/* Butce tur basina butun kutulara yetmiyor (olculdu: ucuncu istekte 429).
   Istegi kismak yerine kutulari donduruyoruz: anlik goruntu birlestir() ile
   6 saat boyunca birikiyor, yani bir turda alinmayan kutu bir sonraki turda
   gelir ve liste tam kalir. Marmara her turda ILK: kullanicinin asil boslugu
   orasiydi (aisstream'de 9 gemi gorunuyordu). Kalan kutular 20 dakikalik
   dilimlere gore sirayla basa geciyor, yani hicbiri ac kalmiyor. */
export function kutuSirasi(kutular = KUTULAR, an = Date.now()) {
  const l = (kutular || []).slice();
  if (l.length <= 2) return l;
  /* `son` isaretli kutular dönmeye hiç girmez, en sonda kalir: olculen gemi
     sayilari cok dusuk, bekleme butcesi biterse once onlar kaybedilsin. */
  const ilk = l[0];
  const orta = l.slice(1).filter(k => !k.son);
  const son = l.slice(1).filter(k => k.son);
  if (!orta.length) return [ilk, ...son];
  const k = Math.floor(an / 1200000) % orta.length;   /* 20 dakika = bir tur */
  return [ilk, ...orta.slice(k), ...orta.slice(0, k), ...son];
}

export async function pelyrCekHepsi(anahtar, kutular = KUTULAR,
                                    enCok = EN_COK_ISTEK, getir = fetch, ilerle,
                                    an, uyu) {
  const harita = new Map();
  const dokum = [];
  const bekleyici = uyu || (sn => new Promise(r => setTimeout(r, sn * 1000)));
  let sira = -1, butce = null, beklenen = 0;
  /* 429 kısa pencereli bir hız sınırı: sunucunun söylediği kadar bekleyip aynı
     kutuyu bir daha denemek, o kutuyu sonraki tura bırakmaktan iyidir. Bekleme
     toplamı EN_COK_BEKLEME'yi aşarsa vazgeçip dönmeye bırakıyoruz. */
  const butceBekle = async (e, ad) => {
    const sn = Number.isFinite(e.bekleSn) ? e.bekleSn + 2 : 0;
    if (!sn || beklenen + sn > EN_COK_BEKLEME) return false;
    beklenen += sn;
    if (ilerle) ilerle(`  Pelyr ${ad}: bütçe doldu, ${sn} sn bekleniyor ` +
                       `(toplam ${beklenen}/${EN_COK_BEKLEME} sn)`);
    await bekleyici(sn);
    return true;
  };
  for (const kutu of kutuSirasi(kutular, an)) {
    let sonuc = null;
    if (sira < 0) {
      /* Ilk kutu: hangi bbox sirasinin dogru oldugunu bul. Yanlis sira hata
         vermiyor, bos donuyor -- bu yuzden sonuca bakmak zorundayiz. */
      for (let s = 0; s < SIRALAR.length; s++) {
        try {
          const o = await pelyrKutu(anahtar, kutu, s, enCok, getir);
          if (o.gemiler.length) { sonuc = o; sira = s; break; }
          sonuc = o;
        } catch (e) {
          if (e.butce) { butce = e; break; }
          if (ilerle) ilerle(`  Pelyr ${kutu.ad} [${SIRALAR[s].ad}]: ${e.message}`);
        }
      }
      if (butce) break;
      if (sira < 0) sira = 0;                 /* hicbiri gemi vermedi: sirayi sabitle */
    } else {
      for (let deneme = 0; deneme < 2 && !sonuc; deneme++) {
        try {
          sonuc = await pelyrKutu(anahtar, kutu, sira, enCok, getir);
        } catch (e) {
          /* Bütçe bitmesi arıza değil, sınır. Önce beklemeyi deniyoruz; bekleme
             bütçesi de bittiyse elde olanı TUTUP duruyoruz. Eskiden burada hata
             atılıyordu ve dışarıdaki catch zaten alınmış bin gemiyi çöpe atıyordu. */
          if (e.butce) {
            if (deneme === 0 && await butceBekle(e, kutu.ad)) continue;
            butce = e; break;
          }
          if (ilerle) ilerle(`  Pelyr ${kutu.ad}: ${e.message}`);
          break;
        }
      }
      if (butce) break;
    }
    const g = (sonuc && sonuc.gemiler) || [];
    for (const k of g) {
      const v = harita.get(k.m);
      /* Kutular ustuste biniyor: ayni gemi iki kutudan gelebilir, yenisi kazanir
         ve eksik alanlar otekinden tamamlanir. */
      if (!v) harita.set(k.m, k);
      else harita.set(k.m, (k.t || 0) >= (v.t || 0)
                           ? Object.assign({}, v, k) : Object.assign({}, k, v));
    }
    dokum.push({ ad: kutu.ad, say: g.length, kirpik: !!(sonuc && sonuc.kirpik) });
    if (ilerle) ilerle(`  Pelyr ${kutu.ad}: ${g.length} gemi` +
                       (sonuc && sonuc.kirpik ? " (KIRPIK — kutu bölünmeli)" : ""));
  }
  const gemiler = [...harita.values()].sort((a, b) => (b.t || 0) - (a.t || 0));
  return { gemiler, sira, dokum, butce: butce ? butce.message : null };
}

/* İki bbox sırasını dener, çok gemi getireni döndürür. Dönen: {gemiler, sira, sayilar}. */
export async function pelyrCek(anahtar, kutu, enCok = EN_COK_ISTEK, getir = fetch, ilerle) {
  const sayilar = [];
  let enIyi = { gemiler: [], sira: 0 };
  for (let s = 0; s < SIRALAR.length; s++) {
    let gemiler = [];
    try {
      gemiler = pelyrAyikla(await pelyrIstek(anahtar, kutu, s, enCok, getir));
    } catch (e) {
      if (e.butce) throw e;                       /* bütçe bittiyse ikinciyi denemek anlamsız */
      if (ilerle) ilerle(`  Pelyr ${SIRALAR[s].ad}: ${e.message}`);
      sayilar.push(0);
      continue;
    }
    sayilar.push(gemiler.length);
    if (ilerle) ilerle(`  Pelyr ${SIRALAR[s].ad}: ${gemiler.length} gemi`);
    if (gemiler.length > enIyi.gemiler.length) enIyi = { gemiler, sira: s };
    /* İlk sıra doluysa ikinciyi denemeye gerek yok: istek bütçesi boşa gitmesin. */
    if (gemiler.length > 0 && s === 0) break;
  }
  return { gemiler: enIyi.gemiler, sira: enIyi.sira, sayilar };
}
