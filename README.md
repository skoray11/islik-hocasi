# Islık Hocası 〰

Islıkla doğru notayı çalıp çalmadığını gerçek zamanlı gösteren, şarkı öğrenmeye yardım eden bir web uygulaması. Kurulum gerektirmez, internete ihtiyaç duymaz; ses yalnızca tarayıcında analiz edilir.

## Çalıştırma

```bash
python3 -m http.server 8123
```

Sonra tarayıcıda **http://localhost:8123** adresini aç ve “Mikrofonu başlat”a bas. (Mikrofon izni için sayfanın `localhost` ya da `https` üzerinden açılması gerekir.)

## Modlar

**Akort** — Islık çal; hangi notada olduğunu, kaç cent saptığını (ibre) ve zaman içindeki perdeni (alttaki rulo) görürsün. Yeşil = doğru, sarı = yakın, kırmızı = uzak. Notayı sabit tutunca halka dolar. En pes ve en tiz notanı birer saniye tutarsan **ses aralığın** kaydedilir.

**Şarkı Çalış**
- **Adım adım:** Sıradaki notayı doğru tutana kadar bekler. Melodiyi öğrenmek için.
- **Ritimli:** 4 vuruşluk girişten sonra notalar zamanla akar; her notada ne kadar süre doğru perdede kaldığın puanlanır.
- **Ton:** Şarkıyı yarım ton kaydırabilir, “İlk notamdan” ile ıslıkladığın notaya göre ya da “Aralığıma uydur” ile ses aralığına göre otomatik ayarlayabilirsin.
- **🔊 Melodiyi dinle / 🎵 Notayı dinle:** Referans sesi çalar (hoparlörden çalarken dinleme kısa süre durur; kulaklık takıyorsan ayarlardan belirt).
- **+ Kendi şarkını ekle:** `Do5 Re5 Mi5:2 Sol#5:0.5 - Sib4` gibi yazarak şarkı ekle (`:2` = iki vuruş, `-` = es).

Kısayollar: **Boşluk** başla/durdur, **N** notayı dinle.

## Ayarlar

Tolerans (kaç cent sapma doğru sayılır), tutma süresi, mikrofon eşiği, “oktav fark etmesin”, nota isimleri (Do Re Mi / C D E) ve A4 referansı ayarlanabilir. Ayarlar, kendi şarkıların ve en iyi puanların tarayıcıda saklanır.

## Geliştirme

- `js/pitch.js` — perde algılama (FFT tepe + parabolik interpolasyon, ıslık “netliği” ile gürültü/konuşma ayıklama)
- `js/music.js` — nota isimleri, nota metni ayrıştırıcı, hazır şarkılar
- `js/audio.js` — mikrofon ve referans sesler
- `js/app.js` — arayüz, modlar, çizim

Testler: `node tests/pitch.test.js`

Mikrofonsuz deneme için `http://localhost:8123/?test` aç; tarayıcı konsolunda `testTone(784)` (Hz) ile sahte ıslık, `testTone(null)` ile sessizlik üretebilirsin.
