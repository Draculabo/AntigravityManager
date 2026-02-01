# Notifications Capability

## ADDED Requirements

### Requirement: Desktop Notification on Auto-Switch

The system SHALL display a native desktop notification when an automatic account switch is performed.

#### Scenario: Successful auto-switch notification
- **WHEN** the AutoSwitchService successfully switches from one account to another
- **THEN** a desktop notification is displayed with:
  - Title: "Account Switched"
  - Body: "Switched from {old_email} to {new_email}"
  - Icon: Success icon

#### Scenario: Notifications disabled
- **WHEN** the `notifications_enabled` setting is `false`
- **AND** an auto-switch occurs
- **THEN** no desktop notification is displayed

### Requirement: Quota Warning Notification

The system SHALL display a warning notification when an account's quota drops below the configured warning threshold.

#### Scenario: Quota warning triggered
- **WHEN** an account's quota percentage drops below `quota_warning_threshold`
- **AND** `notifications_enabled` is `true`
- **THEN** a desktop notification is displayed with:
  - Title: "Low Quota Warning"
  - Body: "{email} has {percentage}% quota remaining"
  - Icon: Warning icon

#### Scenario: Warning notification debounce
- **WHEN** a quota warning notification was sent for an account within the last 5 minutes
- **AND** the same account's quota is still below threshold
- **THEN** no duplicate notification is sent

### Requirement: All Accounts Depleted Notification

The system SHALL display a critical notification when all accounts are depleted or rate-limited.

#### Scenario: All accounts depleted
- **WHEN** the AutoSwitchService cannot find any healthy account to switch to
- **AND** `notifications_enabled` is `true`
- **THEN** a desktop notification is displayed with:
  - Title: "All Accounts Depleted"
  - Body: "No healthy accounts available. Please add more accounts."
  - Icon: Error icon

### Requirement: Configurable Quota Thresholds

The system SHALL allow users to configure quota thresholds through the Settings UI.

#### Scenario: Configure warning threshold
- **WHEN** the user adjusts the warning threshold slider in Settings
- **THEN** the `quota_warning_threshold` setting is updated
- **AND** the new value is used for subsequent quota checks

#### Scenario: Configure switch threshold
- **WHEN** the user adjusts the switch threshold slider in Settings
- **THEN** the `quota_switch_threshold` setting is updated
- **AND** the AutoSwitchService uses the new value

#### Scenario: Threshold validation
- **WHEN** the user attempts to set `quota_switch_threshold` >= `quota_warning_threshold`
- **THEN** the system displays a validation error
- **AND** the setting is not saved

### Requirement: Notification Settings Toggle

The system SHALL allow users to enable or disable all notifications.

#### Scenario: Disable notifications
- **WHEN** the user toggles notifications off in Settings
- **THEN** `notifications_enabled` is set to `false`
- **AND** no desktop notifications are displayed for any event

#### Scenario: Enable notifications
- **WHEN** the user toggles notifications on in Settings
- **THEN** `notifications_enabled` is set to `true`
- **AND** notifications resume for configured events
