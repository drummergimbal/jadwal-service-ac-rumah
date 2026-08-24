# Manajemen Servis AC Rumah — Panduan Setup

PWA untuk melacak, menjadwalkan, dan mencatat servis berkala 4 unit AC rumah (interval otomatis 2 bulan), dengan backend Google Sheets via Google Apps Script.

## Struktur Folder

```
manajemen-servis-ac/
├── index.html          # Halaman utama (UI dashboard, form, riwayat)
├── style.css            # Styling tambahan (safe-area, kartu, modal, dsb)
├── app.js                # Logika aplikasi (fetch API, render, PDF, kalender)
├── manifest.json        # Manifest PWA (nama app, ikon, warna tema)
├── service-worker.js    # Caching offline dasar
├── icons/                # Ikon PWA (192, 512, maskable, apple-touch-icon)
└── Code.gs               # Backend Google Apps Script (dipasang di Apps Script, BUKAN di folder PWA)
```

`Code.gs` **tidak** ikut di-hosting bersama file PWA — file ini ditempel langsung ke editor Google Apps Script (langkah di bawah).

---

## 1. Siapkan Google Sheets

1. Buka [Google Drive](https://drive.google.com) Anda, buat **Google Spreadsheet baru**, beri nama misalnya `Database Servis AC`.
2. Anda **tidak perlu** membuat sheet atau kolom secara manual — `Code.gs` akan otomatis membuat sheet bernama **`Riwayat_Servis`** beserta header kolomnya saat pertama kali dijalankan. Tapi untuk referensi, berikut strukturnya:

   | Kolom | Nama Kolom      | Keterangan                                   |
   |-------|------------------|-----------------------------------------------|
   | A     | `ID`             | ID unik otomatis (format `SRV-<timestamp>`)   |
   | B     | `Timestamp`      | Waktu data disimpan ke server (otomatis)      |
   | C     | `UnitAC`         | Nama unit AC (mis. "AC Kamar Utama")          |
   | D     | `TanggalServis`  | Tanggal servis dilakukan (`YYYY-MM-DD`)       |
   | E     | `NamaTeknisi`    | Nama teknisi                                   |
   | F     | `Catatan`        | Catatan tambahan                               |

## 2. Pasang & Deploy Google Apps Script

1. Di Spreadsheet yang baru dibuat, buka menu **Extensions > Apps Script**.
2. Hapus semua isi default pada `Code.gs`, lalu **copy-paste seluruh isi file `Code.gs`** (dari paket ini) ke sana.
3. Klik ikon **Save** (💾).
4. Klik **Deploy > New deployment**.
5. Pada "Select type", klik ikon gear ⚙️ lalu pilih **Web app**.
6. Isi konfigurasi:
   - **Execute as**: `Me (email Anda)`
   - **Who has access**: `Anyone`  
     *(Wajib "Anyone" — jika dipilih "Anyone with Google account" maka permintaan dari PWA akan gagal karena butuh login Google.)*
7. Klik **Deploy**. Google mungkin akan meminta Anda mengizinkan akses (Authorize access) — ikuti prosesnya, klik **Advanced > Go to (nama project) (unsafe)** jika muncul peringatan (ini normal untuk script buatan sendiri).
8. Setelah berhasil, Anda akan mendapatkan **Web App URL**, contohnya:
   ```
   https://script.google.com/macros/s/AKfycbxxxxxxxxxxxxxxxxxxxxxxxxxxxx/exec
   ```
   **Salin URL ini** — akan dipakai di langkah berikutnya.

> **Update script di kemudian hari?** Jika Anda mengubah isi `Code.gs`, Anda harus membuat **New deployment** lagi (atau *Manage deployments > Edit > New version*) agar perubahan berlaku pada URL Web App yang sama.

## 3. Masukkan Web App URL ke PWA

Buka file **`app.js`**, cari baris berikut di bagian paling atas (`CONFIG`):

```js
const CONFIG = {
  WEB_APP_URL: "PASTE_URL_GOOGLE_APPS_SCRIPT_DI_SINI",
  ...
};
```

Ganti nilainya dengan URL Web App yang Anda salin di langkah 2, misalnya:

```js
const CONFIG = {
  WEB_APP_URL: "https://script.google.com/macros/s/AKfycbxxxxxxxxxxxxxxxxxxxxxxxxxxxx/exec",
  ...
};
```

Simpan file. Aplikasi sekarang siap terhubung ke Google Sheets Anda.

*(Opsional)* Anda juga bisa mengganti daftar `UNITS` di file yang sama jika nama/​jumlah unit AC di rumah berbeda dari contoh default (AC Kamar Utama, AC Kamar Anak, AC Ruang Tamu, AC Ruang Keluarga).

## 4. Hosting PWA (agar bisa diinstall ke HP)

PWA membutuhkan **HTTPS** untuk berfungsi penuh (service worker, Add to Home Screen). Beberapa opsi hosting gratis yang mudah:

- **GitHub Pages** — push folder ini ke repo GitHub, aktifkan Pages di Settings.
- **Netlify / Vercel** — drag-and-drop folder ini ke dashboard mereka.
- **Firebase Hosting** — `firebase init hosting` lalu `firebase deploy`.

Pastikan seluruh isi folder `manajemen-servis-ac/` (kecuali `Code.gs`) diupload ke root hosting, sehingga `index.html` bisa diakses langsung dari domain (mis. `https://nama-anda.netlify.app/`).

## 5. Install ke Home Screen (iPhone & Android)

**iPhone (Safari):**
1. Buka URL PWA di Safari.
2. Tap ikon **Share** (kotak dengan panah ke atas).
3. Pilih **"Add to Home Screen"**.

**Android (Chrome):**
1. Buka URL PWA di Chrome.
2. Tap menu **⋮** (titik tiga) di kanan atas.
3. Pilih **"Add to Home screen"** / **"Install app"**.

Setelah diinstall, aplikasi akan tampil dengan ikon sendiri dan berjalan dalam mode standalone (tanpa address bar), lengkap dengan padding aman untuk Dynamic Island (iPhone 16 Pro Max) dan notch Android.

---

## Cara Kerja Fitur Utama

- **Dashboard**: Setiap kartu unit AC menghitung status berdasarkan `TanggalServis` terakhir + 2 bulan (`CONFIG.SERVICE_INTERVAL_MONTHS`). Hijau = Aman, Kuning = Segera Servis (≤14 hari, bisa diatur via `CONFIG.WARNING_DAYS_BEFORE`), Merah = Waktunya Servis / belum pernah servis.
- **Catat Servis**: Form mengirim `POST` ke Web App URL dengan `Content-Type: text/plain` (trik untuk menghindari CORS preflight yang tidak didukung baik oleh Apps Script). `Code.gs` mem-parsing body sebagai JSON dan menambah baris baru ke sheet `Riwayat_Servis`.
- **Export PDF**: Menggunakan library `html2pdf.js` (bundel jsPDF + html2canvas) yang di-load via CDN, merender tabel riwayat (sesuai filter aktif) menjadi file PDF yang otomatis terunduh ke HP.
- **Pengingat Kalender**: Tombol 🔔 pada kartu AC membuka pilihan (a) buka link Google Calendar (`calendar/render?action=TEMPLATE...`) di tab baru, atau (b) unduh file `.ics` yang bisa langsung dibuka oleh aplikasi Kalender bawaan iPhone/Android.
- **Mode Offline**: `service-worker.js` meng-cache app shell (HTML/CSS/JS/ikon) agar aplikasi tetap bisa dibuka tanpa koneksi. Data riwayat servis terakhir juga disimpan di `localStorage` sebagai fallback saat offline.

## Troubleshooting

- **"Failed to fetch" / data tidak muncul**: Pastikan `WEB_APP_URL` sudah benar dan deployment Web App diatur ke "Anyone" pada "Who has access".
- **Data tidak masuk ke Sheets setelah Simpan**: Buka `Code.gs` di Apps Script, jalankan menu **Executions** (ikon jam di sidebar kiri) untuk melihat log error dari `doPost`.
- **Perubahan `Code.gs` tidak berefek**: Anda perlu membuat *New deployment* / versi baru setelah mengedit script (lihat catatan di langkah 2).
- **Ikon aplikasi tidak muncul saat Add to Home Screen**: Pastikan folder `icons/` ikut ter-upload ke hosting dan path di `manifest.json` sesuai struktur folder.
