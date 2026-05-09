# AutoClick SatuSehat - SIMPUS Validator

Chrome Extension untuk otomatisasi validasi data pasien di SIMPUS Badung Sehat / SatuSehat.

Workflow yang diotomatisasi:
1. Buka halaman **List Data Patient**.
2. Klik tombol **mata** (action) pada baris pasien pertama.
3. Di halaman detail, klik tombol **Validasi** (atau **Kirim Data** sesuai mode).
4. Pada modal konfirmasi, klik **Yakin**.
5. Tunggu redirect kembali ke list, lalu ulangi pasien berikutnya.
6. Jika muncul notifikasi *Warning*, pasien di-skip dan lanjut ke pasien berikutnya.

**Dual mode**:
- **Validasi**: klik tombol "Validasi" + auto set Total data ke 1000 (anti paginasi).
- **Kirim Data**: klik tombol "Kirim Data" (icon `mdi-send-check-outline`). Tidak perlu set Total data karena di halaman ini semua data sudah muncul.

**Multi-client support**: Bisa handle banyak client SIMPUS di tab berbeda secara paralel (selama beda domain). State, blocklist, dan stats diisolasi per-hostname **dan per-mode**.

---

## Cara Install (Mode Developer)

1. Download / clone folder ini ke komputer lo.
2. Buka Chrome, ketik di address bar: `chrome://extensions`
3. Aktifkan toggle **Developer mode** di pojok kanan atas.
4. Klik **Load unpacked**.
5. Pilih folder `autoclickSatuSehat` (folder yang berisi `manifest.json`).
6. Extension siap dipakai. Icon teal dengan tanda + akan muncul di toolbar Chrome.

> Tips: pin extension biar gampang diakses (klik puzzle icon -> pin).

---

## Cara Pakai

1. Buka tab Chrome ke halaman SIMPUS lo, login seperti biasa.
2. Navigasi ke menu yang sesuai:
   - Mode **Validasi** -> menu **List Data Patient** (atau apapun yang tampilkan list pasien dengan tombol Validasi di detail).
   - Mode **Kirim Data** -> menu **Data Tervalidasi** (atau yang tampilkan list pasien dengan tombol Kirim Data di detail).
3. Klik icon extension di toolbar untuk membuka popup.
4. Pilih **mode** di tab atas popup: **Validasi** atau **Kirim Data**.
5. Atur konfigurasi:
   - **Dari tanggal** & **Sampai tanggal**: periode pasien yang mau diproses.
   - **Total data per halaman** *(hanya mode Validasi)*: 20 / 50 / 100 / 500 / **1000** (default). Anti paginasi.
   - **Delay antar aksi (ms)**: jeda tiap aksi (default 1500 ms = 1.5 detik). Naikkan kalau koneksi lambat.
   - **Timeout tunggu elemen (ms)**: berapa lama maksimal nunggu tombol/modal muncul (default 15 detik).
   - **Skip pasien jika error / warning**: jika dicentang (default), pasien yang gagal akan di-skip dan lanjut ke berikutnya.
6. Klik **Mulai Validasi** / **Mulai Kirim Data**. Badge extension berubah jadi `ON` (hijau).
7. Biarkan tab Chrome aktif (jangan minimize ke background terlalu lama supaya timer tetap jalan optimal).
8. Pantau progress di section **Statistik** dan **Log Aktivitas** di popup.
9. Klik **Stop** kapan saja untuk menghentikan proses.

> **Catatan**: Hanya satu mode yang boleh aktif per domain. Kalau lo mau pindah dari Validasi ke Kirim Data, stop dulu mode aktif via popup.

---

## Tips & Troubleshooting

- **Extension tidak jalan?** Pastikan tab aktif sudah di halaman SIMPUS dan refresh halaman setelah install.
- **Tombol mata tidak ter-klik?** Coba naikkan **Delay** ke 2500-3000 ms (mungkin tabel butuh waktu lebih lama untuk render).
- **Modal Yakin tidak muncul?** Coba naikkan **Timeout** ke 20000-30000 ms.
- **Sering muncul Warning?** Cek log aktivitas, biasanya isi notifikasinya muncul di sana. Bisa jadi data pasien memang ada masalah.
- **Mau lihat log lengkap?** Buka DevTools (F12) -> tab Console. Semua aksi diberi prefix `[AutoClick:level]`.
- **Mau restart dari awal?** Klik **Stop** -> **Reset Stats** -> **Mulai** lagi.

---

## Struktur File

```
autoclickSatuSehat/
├── manifest.json          # Konfigurasi extension (MV3)
├── background.js          # Service worker - badge & message routing
├── content.js             # State machine - injected ke halaman SIMPUS
├── popup.html             # UI popup
├── popup.css              # Styling popup
├── popup.js               # Logic popup (read/write storage, kirim trigger)
├── icons/                 # Icon extension (16, 48, 128 px)
└── README.md              # Dokumen ini
```

---

## Cara Kerja (Teknis)

- State (running/stopped, config, stats, blocklist) disimpan di `chrome.storage.local`, jadi tetap nyambung walaupun terjadi navigasi antar halaman (list -> detail -> list).
- Content script otomatis re-eksekusi pada setiap halaman load dan baca state untuk lanjut workflow.
- Klik dilakukan via dispatch `MouseEvent` (mousedown/mouseup/click) supaya kompatibel dengan handler React/Vue.
- Set value pada input date pakai native value setter prototype agar React mendeteksi perubahan.
- Notifikasi/toast dideteksi via class umum (`Toastify__toast`, `[class*='toast']`, `[role='alert']`) lalu cek text untuk menentukan success/warning.

### Multi-Client Parallel + Dual-Mode (anti polusi state antar domain & antar mode)

Storage key di-namespace berdasar **hostname** dan **mode**:

```
chrome.storage.local
├── autoclick_state:client-a.kab.go.id:validasi  -> state validasi client A
├── autoclick_state:client-a.kab.go.id:kirim     -> state kirim client A
├── autoclick_logs:client-a.kab.go.id:validasi
├── autoclick_logs:client-a.kab.go.id:kirim
├── autoclick_state:client-b.kab.go.id:validasi
├── autoclick_state:client-b.kab.go.id:kirim
└── ...
```

Behavior:
- Buka tab di **client A** -> popup nampilin state client A. Pilih tab **Validasi** atau **Kirim Data** di atas.
- Switch tab ke **client B** -> popup nampilin state client B (mode aktifnya menyesuaikan, default Validasi).
- Mode Validasi & Kirim punya stats, blocklist, dan log **terpisah** -> pasien yang gagal validasi belum tentu gagal kirim.
- **Badge "ON" di icon ekstensi per-tab** -> menyala kalau MINIMAL satu mode (validasi atau kirim) sedang aktif di domain itu.
- **Reset** cuma reset state untuk mode + domain tab aktif, ga ngaruh ke mode/domain lain.

Catatan:
- 2 tab di **domain yang sama** akan share state -> JANGAN buka 2 tab di client yang sama saat extension running, akan race condition / double click.
- **1 mode per domain pada satu waktu**: kalau mode Validasi sedang jalan, tombol Mulai Kirim Data akan kasih warning. Stop dulu untuk pindah mode.
- Jumlah client paralel: secara teknis tidak ada batasan, tapi disarankan max 3-5 sekaligus supaya browser tidak overload (tiap tab punya MutationObserver + interval).

### Flagging Pasien (anti loop pasien gagal)

Untuk mencegah pasien yang gagal (NIK salah, NIK dokter salah, dll) dipanggil berulang-ulang:

1. **Sebelum klik tombol mata**, ekstensi membaca identitas unik pasien dari row tabel:
   - Prioritas: NoReg (`260509REG-014114`) -> NIK (16 digit) -> NRM (`05.26.38`) -> gabungan kolom awal
2. ID tersebut langsung dimasukkan ke `attemptedIds` di storage.
3. Pada iterasi berikutnya di halaman list, ekstensi cari **row pertama yang ID-nya BELUM ada di `attemptedIds`** (bukan blindly row [0]).
4. Kalau hasil validasi memunculkan toast warning / error / timeout, ID pasien juga ditambahkan ke `failedIds` + detail (id, label, alasan, waktu) ke `failedDetails` untuk ditampilkan di popup.
5. Saat semua row yang terlihat sudah ada di blocklist, ekstensi otomatis stop dengan log `"Semua pasien (X) di halaman ini sudah pernah diproses"`.

**Reset blocklist** terjadi otomatis saat klik **Mulai** (sesi baru = mulai dari awal). Tombol **Reset** di popup juga membersihkan blocklist + counter sekaligus (dengan konfirmasi).

Pasien yang sudah masuk failed list bisa dilihat di section **"Pasien Gagal / Skip"** di popup, lengkap dengan alasannya. Lo bisa fix manual lalu klik Mulai lagi untuk retry.

---

## Catatan Keamanan

Extension ini hanya berjalan di tab dimana user secara eksplisit klik **Mulai**. Tidak mengirim data ke server eksternal. Semua aksi dilakukan client-side memakai DOM API standar Chrome.

Pastikan lo punya hak akses dan izin untuk melakukan validasi otomatis pada sistem SIMPUS lo.
