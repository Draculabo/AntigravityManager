# Desktop interface

This reference describes the shared desktop presentation, accounts, Traffic Monitor, proxy
configuration and settings.

## Visual system

`src/styles/global.css` owns semantic light and dark colors, system font fallbacks and reduced-motion
behavior. Use semantic Tailwind tokens for surfaces, text, borders and primary actions. Keep account
quota and request-result colors tied to their existing domain status. Native form controls and
scrollbars follow the selected color scheme.

Use quiet, distinct sidebar, workspace and card surfaces. Reserve primary fills for the main action;
use borders and neutral backgrounds for secondary controls. Navigation and card hover states do not
move content. Sidebar collapse is immediate and retains its existing local preference.

The light theme uses white content surfaces on a neutral gray workspace with near-black primary
actions. The dark theme uses charcoal surfaces and light primary actions. Soft blue, mint and pale
yellow add restrained accents to page icons, account statistics and selected card headers. Sidebar
selection uses one consistent blue tint across features; tool-card headers share the same soft blue.
Card bodies remain neutral, and borders, spacing and typography provide the main hierarchy.

Supporting colors convey information, success, warnings and destructive actions. Each supporting
family has text, soft surface and border tokens with separate light and dark values. Soft accents
are accents rather than full-page fills, with darker equivalents in dark mode. Pair status
colors with labels or icons; color does not convey status alone. Account quota indicators use solid
status colors without gradients or glow. Charts retain distinct series colors, including a neutral
series. Text contrast is checked against both content surfaces and status backgrounds in Electron.

## Account interactions

The account summary labels counts directly. The toolbar separates account operations from selection,
filters and display preferences. All operations remain available when controls wrap in smaller
windows. Selection and card management controls are visible without hover and reachable by keyboard.

The network proxy button opens the existing per-account editor. The URL stays private to that editor;
replacement, removal, validation and save-on-blur behavior remain unchanged. Escape closes the dialog
and returns focus to its trigger.

The account toolbar has one local-account entry, "Import from this computer". It discovers supported
Antigravity and Antigravity IDE databases, the system credential store and supported Agent data.
The dialog validates and deduplicates discovered accounts, then shows a preview before confirmation.
The separate IDE-sync shortcut is not shown. Importing updates matching accounts through the existing
import service while retaining saved account settings and device information.

The sign-in dialog emphasizes browser sign-in and keeps manual code entry in a disclosure. That
disclosure opens automatically while browser sign-in is pending. Closing the dialog clears the
entered code. Import and export retain their existing file operations and cancellation handling.

The batch toolbar stays within the account workspace. Destructive actions require an application
dialog with the selected count and cancellation focused by default. Deletion uses the visible
account selection captured when the dialog opens. Pending actions disable the toolbar and cannot
be submitted twice; cancelling confirmation preserves the selection and restores trigger focus.

## Request details

The request detail dialog summarizes status, duration and input/output tokens before the metadata,
attempt history and full content. Labels and request outcomes use the selected language; additional
diagnostic fields remain available in a disclosure. Wide windows show three panes, while narrow
windows use keyboard-accessible tabs. Loading, unavailable records and failed reads have explicit
feedback, including retry for failed reads.

The body editor uses the installed CodeMirror light/dark themes to match the selected application
appearance and keep JSON text legible in both modes.

The traffic list handles Enter once when opening details. Closing details restores focus to the
request row. Request and attempt cURL actions keep their existing credential policy.

## Proxy configuration and settings

The proxy page keeps service status, start/stop, connection settings and automatic startup together.
Additional service options are available in a keyboard-accessible disclosure. Tool connections are
the default panel; model settings, request records and examples have separate tabs. Panels stay
mounted while hidden so changing tabs preserves their local input and disclosure state. Protocol
choices in examples are buttons with an explicit pressed state.

Settings retain their General, Models and Proxy categories. Client executable paths and launch
options sit in a disclosure with a description of when to change them. Opening or closing it does
not reset field drafts. File selection and clearing controls have accessible names. Existing
save-on-blur, service availability, secret-reveal and confirmation behavior remains in its owning
components. The proxy start confirmation returns keyboard focus to the service control on dismissal.

## Loading, empty states and notifications

`FeedbackState` is the shared presentation for loading, empty and failed reads. Loading states name
the work in progress and expose a busy status. Empty account and traffic views describe what appears
there and how to proceed; an account filter with no matches keeps its reset action. Failed account
reads retain retry, diagnostic details and bug-report actions.

An initial traffic read failure displays an error and retry instead of an empty list. If a background
refresh fails after records have loaded, those records stay visible with a warning and retry action.
These states use the existing query lifecycle and do not change storage or provider behavior.

Notifications use an icon, accent border and neutral content surface. Callers select `success`,
`warning` or `destructive` from the operation result; the default variant conveys information.
Batch account actions distinguish partial success from complete failure. The localized close button
is always visible and keyboard accessible, and notification actions retain their Radix behavior.
The existing notification limit, duration and lifecycle remain in `use-toast` and Radix.

## Device, import and tool dialogs

Device information, local account import, tool setup and configuration previews use a fixed
header and footer with a scrollable content area. Dialog headings reserve space for the close
button. Footer actions wrap with consistent spacing in narrow windows. Controlled dialogs
return focus to the element that opened them; feature-specific focus handlers take precedence.

Tool address fields explain the expected address and connect validation messages to the input.
OpenCode model setup explains when a model selection is required. Pending setup, device updates,
cache cleanup and account import disable their close button and retain their existing dismissal
guards. Tool restoration and removal confirmations focus cancellation first.

Failed configuration previews and device reads provide retry without exposing raw file errors.
Device refresh failures keep previously loaded information visible and disable writes until a
successful retry. Cache-location read failures are distinct from missing cache and prevent cleanup
until locations can be read. A partial cache cleanup is reported as a warning. These changes leave
the underlying configuration, device and cache operations in their existing modules.

## Scope and verification

These presentation conventions apply to the shared shell, the four views above and the account,
request, device, import and tool dialogs described here. Additional feature flows still require
their own behavior review. This is not
a claim of complete native platform integration.
See [desktop renderer checks](testing.md#desktop-workspace-checks) for the isolated Electron checks
and screenshots.
