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
  if (y.status === 429) { const h = new Error("Pelyr istek bütçesi doldu (429)"); h.butce = true; throw h; }
  if (!y.ok) throw new Error(`Pelyr ${y.status}`);
  return await y.json();
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
