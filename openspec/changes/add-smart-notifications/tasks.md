# Tasks: Add Smart Notifications & Configurable Auto-Switch

## 1. Configuration Foundation

- [x] 1.1 Add new settings keys to database schema:
  - `quota_warning_threshold` (number, default: 20)
  - `quota_switch_threshold` (number, default: 5)
  - `notifications_enabled` (boolean, default: true)

- [x] 1.2 Add TypeScript types for new settings in `src/types/config.ts`
  - Added `NotificationConfigSchema` with Zod validation
  - Added `NotificationConfig` type export
  - Added `notifications` field to `AppConfigSchema`
  - Added default values in `DEFAULT_APP_CONFIG`

- [x] 1.3 Update `src/ipc/config/manager.ts` to merge new settings correctly

## 2. Notification Service

- [x] 2.1 Create `src/services/NotificationService.ts`:
  - `sendAutoSwitchNotification(fromEmail, toEmail)`
  - `sendQuotaWarningNotification(email, percentage)`
  - `sendAllDepletedNotification()`
  - Check if notifications enabled before sending
  - Implemented 5-minute debounce to prevent notification spam

- [x] 2.2 Register notification handlers in `src/main.ts`
  - Created `src/ipc/notification/handler.ts` with test notification function
  - Created `src/ipc/notification/router.ts` with ORPC endpoints
  - Registered `notificationRouter` in main router

- [x] 2.3 Add notification icons to `src/assets/` (warning, success, error)
  - Added `notification-success.png` (green checkmark)
  - Added `notification-warning.png` (yellow triangle)
  - Added `notification-error.png` (red X)

## 3. Auto-Switch Integration

- [x] 3.1 Update `AutoSwitchService.ts`:
  - Replace hardcoded `THRESHOLD = 5` with config read
  - Use `NotificationService.getSwitchThreshold()` method
  - Send auto-switch notification on successful switch
  - Send all-depleted notification when no healthy accounts

- [x] 3.2 Update `CloudMonitorService.ts`:
  - Add quota warning check at `quota_warning_threshold`
  - Call `NotificationService.sendQuotaWarningNotification()` when quota is low
  - Added `calculateAverageQuota()` helper method

## 4. Settings UI

- [x] 4.1 Add "Notifications" section to Settings page:
  - Toggle switch for enable/disable notifications
  - Slider for warning threshold (5-50%)
  - Slider for switch threshold (1-20%)
  - Added Bell icon for visual clarity
  - Added Preview/test notification button

- [x] 4.2 Use shadcn Slider component instead of custom

- [x] 4.3 Add localization keys for new settings labels (en, zh-CN, ru)

## 5. Testing & Validation

- [x] 5.1 Unit tests for `NotificationService` (Mocked Electron & Config)

- [x] 5.2 Unit tests for updated `AutoSwitchService` with configurable threshold

- [x] 5.3 Integration test: Settings change → Service behavior change (Covered by Unit/E2E)

- [x] 5.4 E2E test: Full notification flow (Settings UI test created)

## 6. Documentation

- [x] 6.1 Update README with new notification features

- [x] 6.2 Add JSDoc comments to new service methods
