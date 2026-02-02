# Change: Add Smart Notifications & Configurable Auto-Switch

## Why

Saat ini, Auto-Switch Service berjalan secara diam-diam tanpa memberi tahu pengguna ketika akun diganti. Threshold depleted juga hardcoded di 5%, tidak memberikan fleksibilitas kepada pengguna yang memiliki preferensi berbeda. Ini menyebabkan:

1. **Kurangnya transparansi** - User tidak tahu kapan dan mengapa akun di-switch
2. **Tidak fleksibel** - User dengan banyak akun mungkin ingin threshold lebih rendah, user dengan sedikit akun ingin lebih tinggi
3. **Pengalaman pasif** - Tidak ada feedback visual ketika event penting terjadi

## What Changes

### Fitur Baru

- **Desktop Notifications**: Notifikasi native saat:
  - Auto-switch berhasil dilakukan
  - Quota mendekati batas (warning)
  - Semua akun depleted (critical)

- **Configurable Threshold**: Setting untuk:
  - `quota_warning_threshold` (default: 20%) - Warning notification
  - `quota_switch_threshold` (default: 5%) - Trigger auto-switch
  - `notifications_enabled` (default: true) - Toggle notifikasi

### Integrasi

- Menambahkan Electron `Notification` API di Main Process
- Menambahkan UI Settings untuk konfigurasi threshold
- Memperbarui `AutoSwitchService` untuk membaca threshold dari config
- Memperbarui `CloudMonitorService` untuk trigger notifications

## Impact

- **Affected specs**: Menambah capability `notifications` baru
- **Affected code**:
  - `src/services/AutoSwitchService.ts` - Baca threshold dari config
  - `src/services/CloudMonitorService.ts` - Trigger notifications
  - `src/ipc/config/handler.ts` - Tambah setting baru
  - `src/routes/settings.tsx` - UI untuk konfigurasi
  - `src/main.ts` - Setup notification handler
