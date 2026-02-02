# Design: Smart Notifications & Configurable Auto-Switch

## Context

Antigravity Manager saat ini menjalankan auto-switch secara silent. User tidak mendapat feedback ketika:
- Akun aktif diganti ke akun lain
- Quota mendekati batas
- Semua akun kehabisan quota

Threshold untuk auto-switch juga hardcoded di 5%, tidak mempertimbangkan preferensi user yang berbeda.

## Goals / Non-Goals

### Goals
- Memberikan feedback real-time kepada user tentang status akun
- Memungkinkan user mengkonfigurasi threshold sesuai kebutuhan
- Notifikasi native yang tidak mengganggu workflow

### Non-Goals
- External notification channels (email, Telegram) - akan di-handle di change terpisah
- Sound notifications - akan di-handle di change terpisah
- Notification history/log - akan di-handle di change terpisah

## Decisions

### 1. Notification API

**Decision**: Menggunakan Electron's native `Notification` API

**Rationale**:
- Built-in, tidak perlu dependency tambahan
- Mengikuti OS native notification style
- Respects user's system notification preferences

**Alternatives Considered**:
- `node-notifier`: Extra dependency, less control
- In-app toast: Tidak terlihat jika app minimized

### 2. Threshold Configuration Storage

**Decision**: Menyimpan di SQLite melalui `CloudAccountRepo.getSetting/setSetting`

**Rationale**:
- Konsisten dengan settings lainnya (auto_switch_enabled)
- Persists across restarts
- Already has type-safe getter pattern

### 3. Notification Types

```typescript
enum NotificationType {
  AUTO_SWITCH_SUCCESS = 'auto_switch_success',
  QUOTA_WARNING = 'quota_warning',
  ALL_DEPLETED = 'all_depleted'
}
```

### 4. Default Values

| Setting | Default | Range | Rationale |
|---------|---------|-------|-----------|
| `notifications_enabled` | `true` | boolean | Opt-out model |
| `quota_warning_threshold` | `20` | 5-50% | Warning sebelum switch |
| `quota_switch_threshold` | `5` | 1-20% | Existing behavior |

## Risks / Trade-offs

### Risk: Notification Spam
**Mitigation**:
- Debounce notifications (max 1 per type per 5 minutes)
- Only notify on state change, not on every poll

### Risk: Threshold Misconfiguration
**Mitigation**:
- Validate: warning > switch threshold
- UI shows warning if switch threshold > 15%

### Trade-off: Simplicity vs Flexibility
**Choice**: Start simple (3 settings), add more granularity later based on user feedback

## Migration Plan

1. New settings will use defaults if not present in DB
2. No breaking changes to existing behavior
3. Existing `THRESHOLD = 5` constant becomes fallback

## Open Questions

- [ ] Should we show notification count badge on app icon?
- [ ] Should warning notification be dismissible or auto-dismiss?
